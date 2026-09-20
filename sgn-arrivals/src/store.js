/**
 * Split a UTC instant into the local calendar date and hour of day the whole
 * point of this service is to produce. Uses Intl rather than a date library
 * because Node ships full ICU by default and this is the only conversion the
 * service needs.
 *
 * @param {Date} date
 * @param {string} timeZone IANA zone, e.g. 'Asia/Ho_Chi_Minh'.
 * @returns {{localDate: string, localHour: number}} localDate as YYYY-MM-DD.
 */
export function toLocal(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  // en-CA gives YYYY-MM-DD directly; hour can come back as "24" for midnight
  // in some ICU versions, which Postgres's smallint column would still
  // accept but which reads wrong, so it is normalised to 0 here.
  const rawHour = Number(get('hour'));
  return {
    localDate: `${get('year')}-${get('month')}-${get('day')}`,
    localHour: rawHour === 24 ? 0 : rawHour,
  };
}

/**
 * Normalise one OpenSky arrival into a row shape, or null when it is missing
 * the fields this table requires.
 *
 * @param {import('./opensky.js').RawArrival} raw
 * @param {object} options
 * @param {string} options.airportIcao
 * @param {string} options.rulesVersion
 * @param {string} options.localTimeZone
 * @returns {object|null}
 */
export function normalise(raw, { airportIcao, rulesVersion, localTimeZone }) {
  if (!raw || !raw.icao24 || !Number.isFinite(raw.firstSeen) || !Number.isFinite(raw.lastSeen)) {
    return null;
  }
  const lastSeenDate = new Date(raw.lastSeen * 1000);
  const { localDate, localHour } = toLocal(lastSeenDate, localTimeZone);
  return {
    airportIcao,
    icao24: raw.icao24,
    callsign: raw.callsign ? raw.callsign.trim() : null,
    estDepartureAirport: raw.estDepartureAirport || null,
    departureCandidates: raw.departureAirportCandidatesCount ?? null,
    arrivalHorizDistM:
      raw.estArrivalAirportHorizDistance != null
        ? Math.round(raw.estArrivalAirportHorizDistance)
        : null,
    firstSeen: new Date(raw.firstSeen * 1000),
    lastSeen: lastSeenDate,
    localHour,
    localDate,
    rulesVersion,
  };
}

/**
 * Insert rows, skipping any that were already recorded by an earlier
 * overlapping poll.
 *
 * @param {import('pg').Pool} pool
 * @param {object[]} rows From normalise().
 * @returns {Promise<number>} Rows actually inserted.
 */
export async function insertArrivals(pool, rows) {
  if (rows.length === 0) return 0;
  let inserted = 0;
  // One row per statement rather than a multi-row INSERT: a poll is at most
  // a few dozen rows every 15 minutes, and the ON CONFLICT target needs to
  // be per-row anyway. Simplicity over throughput this service will never
  // need.
  for (const row of rows) {
    const result = await pool.query(
      `INSERT INTO sgn_arrivals (
         airport_icao, icao24, callsign, est_departure_airport,
         departure_candidates, arrival_horiz_dist_m,
         first_seen, last_seen, local_hour, local_date, rules_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (icao24, first_seen) DO NOTHING`,
      [
        row.airportIcao,
        row.icao24,
        row.callsign,
        row.estDepartureAirport,
        row.departureCandidates,
        row.arrivalHorizDistM,
        row.firstSeen,
        row.lastSeen,
        row.localHour,
        row.localDate,
        row.rulesVersion,
      ],
    );
    inserted += result.rowCount;
  }
  return inserted;
}

/**
 * Record one poll attempt, success or failure. This is the coverage record —
 * see the note in the 001_init migration.
 * @param {import('pg').Pool} pool
 * @param {object} poll
 */
export async function recordPoll(pool, poll) {
  await pool.query(
    `INSERT INTO sgn_polls (window_begin, window_end, returned, inserted, ok, error)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [poll.windowBegin, poll.windowEnd, poll.returned, poll.inserted, poll.ok, poll.error || null],
  );
}
