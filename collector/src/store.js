// Writing drained batches to Postgres.
//
// Hour rows are drained INCREMENTALLY — each flush carries only what happened
// since the last one — so every upsert here must ADD to what is already
// stored, never replace it. Getting that backwards would make an hour report
// whatever its final thirty seconds happened to contain.

/**
 * Apply one drained batch.
 *
 * Everything lands in a single transaction: a flush that half-succeeded would
 * leave transits recorded against an hour whose denominator was lost, which is
 * worse than losing the flush entirely.
 *
 * @param {object} pool Postgres pool or client.
 * @param {object} batch Output of the ingest pipeline's `drain()`.
 * @returns {Promise<{crossings:number, gaps:number, hours:number}>} Counts written.
 */
export async function writeBatch(pool, batch) {
  const { crossings = [], gaps = [], regionHours = [], serviceHours = [] } = batch;
  if (!crossings.length && !gaps.length && !regionHours.length && !serviceHours.length) {
    return { crossings: 0, gaps: 0, hours: 0 };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const row of crossings) {
      await client.query(
        `INSERT INTO crossings
           (chokepoint, direction, mmsi, observed_at, lat, lon,
            ship_type, draught_m, length_m, rules_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          row.chokepoint,
          row.direction,
          row.mmsi,
          row.observedAt,
          row.lat,
          row.lon,
          row.shipType,
          row.draughtM,
          row.lengthM,
          row.rulesVersion,
        ],
      );
    }

    for (const row of gaps) {
      await client.query(
        `INSERT INTO gaps
           (chokepoint, mmsi, started_at, ended_at, duration_s,
            start_lat, start_lon, end_lat, end_lon,
            distance_km, implied_speed_kts, feed_coverage, rules_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          row.chokepoint,
          row.mmsi,
          row.startedAt,
          row.endedAt,
          row.durationSec,
          row.startLat,
          row.startLon,
          row.endLat,
          row.endLon,
          row.distanceKm,
          row.impliedSpeedKts,
          row.feedCoverage,
          row.rulesVersion,
        ],
      );
    }

    for (const row of regionHours) {
      await client.query(
        `INSERT INTO region_hours
           (chokepoint, hour, messages, vessels, queue_depth, queue_samples)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (chokepoint, hour) DO UPDATE SET
           messages = region_hours.messages + EXCLUDED.messages,
           -- Distinct vessels cannot be summed across flushes; the roster only
           -- grows within an hour, so the larger count is the current one.
           vessels = GREATEST(region_hours.vessels, EXCLUDED.vessels),
           -- The queue is sampled once an hour, so exactly one flush carries a
           -- value. Keep it rather than letting the next flush null it out.
           queue_depth = COALESCE(EXCLUDED.queue_depth, region_hours.queue_depth),
           queue_samples = region_hours.queue_samples + EXCLUDED.queue_samples`,
        [row.chokepoint, row.hour, row.messages, row.vessels, row.queueDepth, row.queueSamples],
      );
    }

    for (const row of serviceHours) {
      await client.query(
        `INSERT INTO service_hours (hour, messages, first_seen, last_seen)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (hour) DO UPDATE SET
           messages = service_hours.messages + EXCLUDED.messages,
           first_seen = LEAST(service_hours.first_seen, EXCLUDED.first_seen),
           last_seen = GREATEST(service_hours.last_seen, EXCLUDED.last_seen)`,
        [row.hour, row.messages, row.firstSeen, row.lastSeen],
      );
    }

    await client.query('COMMIT');
    return {
      crossings: crossings.length,
      gaps: gaps.length,
      hours: regionHours.length,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Hourly rows for reading, newest last.
 * @param {object} pool Postgres pool.
 * @param {object} [query]
 * @param {string} [query.chokepoint] Restrict to one chokepoint.
 * @param {number} [query.hours] Window length, default 720.
 * @returns {Promise<object[]>} Rows.
 */
export async function readHours(pool, query = {}) {
  const { chokepoint, hours = 720 } = query;
  const result = await pool.query(
    `SELECT * FROM v_chokepoint_hours
      WHERE hour >= now() - ($1 || ' hours')::INTERVAL
        AND ($2::TEXT IS NULL OR chokepoint = $2)
      ORDER BY hour, chokepoint`,
    [String(hours), chokepoint ?? null],
  );
  return result.rows;
}

/**
 * Daily rollup. Distinct vessels are a maximum rather than a sum, for the same
 * reason they are within an hour: the same hull recurs.
 * @param {object} pool Postgres pool.
 * @param {object} [query] Same shape as {@link readHours}.
 * @returns {Promise<object[]>} Rows.
 */
export async function readDays(pool, query = {}) {
  const { chokepoint, hours = 24 * 90 } = query;
  const result = await pool.query(
    `SELECT chokepoint,
            date_trunc('day', hour) AS day,
            sum(outbound)         AS outbound,
            sum(inbound)          AS inbound,
            sum(outbound_tanker)  AS outbound_tanker,
            sum(outbound_laden)   AS outbound_laden,
            sum(outbound_ballast) AS outbound_ballast,
            sum(outbound_kdwt)    AS outbound_kdwt,
            sum(dark)             AS dark,
            sum(spoofed)          AS spoofed,
            sum(messages)         AS messages,
            max(vessels)          AS vessels,
            avg(queue_depth)      AS queue_depth,
            count(*) FILTER (WHERE observed) AS hours_observed
       FROM v_chokepoint_hours
      WHERE hour >= now() - ($1 || ' hours')::INTERVAL
        AND ($2::TEXT IS NULL OR chokepoint = $2)
      GROUP BY chokepoint, date_trunc('day', hour)
      ORDER BY day, chokepoint`,
    [String(hours), chokepoint ?? null],
  );
  return result.rows;
}

/**
 * How many of the last N hours the collector was actually running.
 *
 * Read this next to any count. A quiet server and a quiet strait produce the
 * same transit number and mean opposite things.
 *
 * @param {object} pool Postgres pool.
 * @param {number} [hours] Window length.
 * @returns {Promise<{observedHours:number, windowHours:number, ratio:number}>} Coverage.
 */
export async function readCoverage(pool, hours = 720) {
  const result = await pool.query(
    `SELECT count(*)::INT AS observed
       FROM service_hours
      WHERE hour >= now() - ($1 || ' hours')::INTERVAL`,
    [String(hours)],
  );
  const observed = result.rows[0]?.observed ?? 0;
  return {
    observedHours: observed,
    windowHours: hours,
    ratio: hours > 0 ? Number((observed / hours).toFixed(3)) : 0,
  };
}

/**
 * Raw crossings with their interpretation attached on read.
 * @param {object} pool Postgres pool.
 * @param {object} [query]
 * @returns {Promise<object[]>} Rows, newest first.
 */
export async function readCrossings(pool, query = {}) {
  const { chokepoint, hours = 24, limit = 500 } = query;
  const result = await pool.query(
    `SELECT * FROM v_crossings
      WHERE observed_at >= now() - ($1 || ' hours')::INTERVAL
        AND ($2::TEXT IS NULL OR chokepoint = $2)
      ORDER BY observed_at DESC
      LIMIT $3`,
    [String(hours), chokepoint ?? null, limit],
  );
  return result.rows;
}

/**
 * Recorded silences, classified on read.
 * @param {object} pool Postgres pool.
 * @param {object} [query]
 * @returns {Promise<object[]>} Rows, newest first.
 */
export async function readGaps(pool, query = {}) {
  const { chokepoint, classification, hours = 24, limit = 200 } = query;
  const result = await pool.query(
    `SELECT * FROM v_gaps
      WHERE ended_at >= now() - ($1 || ' hours')::INTERVAL
        AND ($2::TEXT IS NULL OR chokepoint = $2)
        AND ($3::TEXT IS NULL OR classification = $3)
      ORDER BY ended_at DESC
      LIMIT $4`,
    [String(hours), chokepoint ?? null, classification ?? null, limit],
  );
  return result.rows;
}
