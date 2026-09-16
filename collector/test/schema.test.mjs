import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../src/db.js';
import { writeBatch } from '../src/store.js';

/**
 * PGlite speaks the pg client surface writeBatch needs, minus pooling.
 *
 * One difference matters: PGlite's `query()` always uses the extended protocol,
 * which rejects multi-statement SQL, while node-postgres falls back to the
 * simple protocol when no parameters are passed. Routing parameterless SQL
 * through `exec()` reproduces the driver's real behaviour, so the migration
 * files under test are the ones that ship.
 */
async function freshDb() {
  const db = await PGlite.create();
  const run = async (text, values) => {
    if (values === undefined) {
      const results = await db.exec(text);
      return results[results.length - 1] ?? { rows: [] };
    }
    return db.query(text, values);
  };
  const client = { query: run, release() {} };
  const pool = { query: run, connect: async () => client };
  await migrate(pool);
  return pool;
}

const HOUR = '2026-09-16T12:00:00.000Z';

function crossing(overrides = {}) {
  return {
    chokepoint: 'hormuz',
    direction: 'outbound',
    mmsi: '636019825',
    observedAt: new Date(HOUR),
    lat: 26.5,
    lon: 56.6,
    shipType: '80',
    draughtM: 22,
    lengthM: 330,
    rulesVersion: 'r1',
    ...overrides,
  };
}

test('migrations are idempotent, so every boot can re-run them', async () => {
  const pool = await freshDb();
  await migrate(pool);
  await migrate(pool);
  const { rows } = await pool.query('SELECT count(*)::INT AS n FROM crossings');
  assert.equal(rows[0].n, 0);
});

test('interpretation lives in the view, not the row', async () => {
  const pool = await freshDb();
  await writeBatch(pool, {
    crossings: [
      crossing({ mmsi: 'vlcc-laden', draughtM: 22, lengthM: 330 }),
      crossing({ mmsi: 'vlcc-ballast', draughtM: 9, lengthM: 330 }),
      crossing({ mmsi: 'mr-laden', draughtM: 11, lengthM: 180 }),
      crossing({ mmsi: 'boxship', shipType: '71', draughtM: 14, lengthM: 300 }),
      crossing({ mmsi: 'unknown', shipType: null, draughtM: null, lengthM: null }),
    ],
  });

  const { rows } = await pool.query(
    'SELECT mmsi, is_tanker, size_class, laden_state, approx_kdwt FROM v_crossings ORDER BY mmsi',
  );
  const byMmsi = Object.fromEntries(rows.map((r) => [r.mmsi, r]));

  // The same ratio rule has to work at both ends of the fleet.
  assert.equal(byMmsi['vlcc-laden'].laden_state, 'laden');
  assert.equal(byMmsi['vlcc-ballast'].laden_state, 'ballast');
  assert.equal(byMmsi['mr-laden'].laden_state, 'laden');
  assert.equal(byMmsi['vlcc-laden'].size_class, 'vlcc');
  assert.equal(byMmsi['mr-laden'].size_class, 'handy');
  assert.equal(byMmsi['vlcc-laden'].approx_kdwt, 300);

  // A container ship is not a tanker even when it is large and deep.
  assert.equal(byMmsi.boxship.is_tanker, false);
  assert.equal(byMmsi['vlcc-laden'].is_tanker, true);

  // Missing static data yields nulls, never a guess.
  assert.equal(byMmsi.unknown.size_class, null);
  assert.equal(byMmsi.unknown.laden_state, null);
  assert.equal(byMmsi.unknown.approx_kdwt, 0);
});

test('a revised threshold reclassifies history, because nothing was written down', async () => {
  const pool = await freshDb();
  await writeBatch(pool, {
    gaps: [
      {
        chokepoint: 'hormuz',
        mmsi: 'slow',
        startedAt: new Date(HOUR),
        endedAt: new Date(HOUR),
        durationSec: 7200,
        startLat: 26.5,
        startLon: 56.3,
        endLat: 26.9,
        endLon: 57.1,
        distanceKm: 87,
        impliedSpeedKts: 16,
        feedCoverage: 1,
        rulesVersion: 'r1',
      },
      {
        chokepoint: 'hormuz',
        mmsi: 'impossible',
        startedAt: new Date(HOUR),
        endedAt: new Date(HOUR),
        durationSec: 7200,
        startLat: 26.5,
        startLon: 56.3,
        endLat: 26.9,
        endLon: 41.0,
        distanceKm: 1500,
        impliedSpeedKts: 405,
        feedCoverage: 1,
        rulesVersion: 'r1',
      },
    ],
  });

  const before = await pool.query(
    'SELECT mmsi, classification FROM v_gaps ORDER BY mmsi',
  );
  assert.deepEqual(
    before.rows.map((r) => [r.mmsi, r.classification]),
    [
      ['impossible', 'spoofed'],
      ['slow', 'dark'],
    ],
  );

  // Redefining the view is the whole migration path for a rule change: no
  // backfill, no dual-era dataset.
  await pool.query(
    `CREATE OR REPLACE VIEW v_gaps AS
     SELECT g.*, CASE WHEN g.implied_speed_kts > 10 THEN 'spoofed' ELSE 'dark' END
       AS classification FROM gaps g`,
  );
  const after = await pool.query('SELECT classification FROM v_gaps ORDER BY mmsi');
  assert.deepEqual(
    after.rows.map((r) => r.classification),
    ['spoofed', 'spoofed'],
  );
});

test('hour rows accumulate across flushes instead of replacing', async () => {
  const pool = await freshDb();
  const base = {
    chokepoint: 'hormuz',
    hour: HOUR,
    messages: 100,
    vessels: 12,
    queueDepth: null,
    queueSamples: 0,
  };

  await writeBatch(pool, { regionHours: [base] });
  // A later flush in the same hour carries only what happened since.
  await writeBatch(pool, {
    regionHours: [{ ...base, messages: 50, vessels: 18, queueDepth: 7, queueSamples: 1 }],
  });
  // And a third with no queue sample must not erase the one recorded.
  await writeBatch(pool, { regionHours: [{ ...base, messages: 25, vessels: 18 }] });

  const { rows } = await pool.query('SELECT * FROM region_hours');
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].messages), 175);
  // Distinct vessels cannot be summed — the same hulls recur every flush.
  assert.equal(rows[0].vessels, 18);
  assert.equal(rows[0].queue_depth, 7);
});

test('service hours record when the collector was alive', async () => {
  const pool = await freshDb();
  await writeBatch(pool, {
    serviceHours: [
      {
        hour: HOUR,
        messages: 10,
        firstSeen: new Date('2026-09-16T12:00:05Z'),
        lastSeen: new Date('2026-09-16T12:10:00Z'),
      },
    ],
  });
  await writeBatch(pool, {
    serviceHours: [
      {
        hour: HOUR,
        messages: 5,
        firstSeen: new Date('2026-09-16T12:00:01Z'),
        lastSeen: new Date('2026-09-16T12:50:00Z'),
      },
    ],
  });

  const { rows } = await pool.query('SELECT * FROM service_hours');
  assert.equal(Number(rows[0].messages), 15);
  assert.equal(rows[0].first_seen.toISOString(), '2026-09-16T12:00:01.000Z');
  assert.equal(rows[0].last_seen.toISOString(), '2026-09-16T12:50:00.000Z');
});

test('the hourly view joins counts to their denominator and to coverage', async () => {
  const pool = await freshDb();
  await writeBatch(pool, {
    crossings: [
      crossing({ mmsi: 'a', draughtM: 22, lengthM: 330 }),
      crossing({ mmsi: 'b', draughtM: 9, lengthM: 330 }),
      crossing({ mmsi: 'c', direction: 'inbound' }),
    ],
    regionHours: [
      {
        chokepoint: 'hormuz',
        hour: HOUR,
        messages: 4200,
        vessels: 63,
        queueDepth: 11,
        queueSamples: 1,
      },
    ],
    serviceHours: [
      { hour: HOUR, messages: 4200, firstSeen: new Date(HOUR), lastSeen: new Date(HOUR) },
    ],
  });

  const { rows } = await pool.query('SELECT * FROM v_chokepoint_hours');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(Number(row.outbound), 2);
  assert.equal(Number(row.inbound), 1);
  assert.equal(Number(row.outbound_tanker), 2);
  assert.equal(Number(row.outbound_laden), 1);
  assert.equal(Number(row.outbound_ballast), 1);
  assert.equal(Number(row.outbound_kdwt), 600);
  // The denominator and the observed flag travel with the counts, so a
  // reader cannot accidentally take the transits alone.
  assert.equal(Number(row.messages), 4200);
  assert.equal(row.vessels, 63);
  assert.equal(row.observed, true);
});

test('a batch is all-or-nothing', async () => {
  const pool = await freshDb();
  await assert.rejects(
    writeBatch(pool, {
      crossings: [crossing(), crossing({ direction: 'sideways' })],
    }),
  );
  // The valid row from the failed batch must not have survived: a transit
  // recorded against an hour whose denominator was lost is worse than a
  // dropped flush.
  const { rows } = await pool.query('SELECT count(*)::INT AS n FROM crossings');
  assert.equal(rows[0].n, 0);
});
