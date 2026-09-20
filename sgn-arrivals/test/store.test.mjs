import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { toLocal, normalise, insertArrivals, recordPoll } from '../src/store.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'migrations');

/**
 * pglite's query result uses `affectedRows`; node-postgres uses `rowCount`.
 * store.js is written against the real `pg` driver, so tests get a thin
 * adapter rather than a second code path in the module under test.
 */
function poolFromPglite(db) {
  return {
    query: async (sql, params) => {
      // pglite's parameterised query() only accepts one statement; migration
      // files are multiple. exec() runs a whole script and has no params, so
      // it is only used for the no-params, migration-file case.
      if (!params || params.length === 0) {
        const results = await db.exec(sql);
        const last = results[results.length - 1] || { rows: [], affectedRows: 0 };
        return { rows: last.rows, rowCount: last.affectedRows ?? last.rows.length };
      }
      const r = await db.query(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  };
}

async function freshPool() {
  const db = new PGlite();
  const pool = poolFromPglite(db);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return pool;
}

test('toLocal splits a UTC instant into Asia/Ho_Chi_Minh date and hour', () => {
  // 21:30 UTC on Sep 18 is 04:30 the next day in Saigon (UTC+7).
  const { localDate, localHour } = toLocal(new Date('2026-09-18T21:30:00Z'), 'Asia/Ho_Chi_Minh');
  assert.equal(localDate, '2026-09-19');
  assert.equal(localHour, 4);
});

test('normalise drops a record with no icao24', () => {
  assert.equal(
    normalise({ firstSeen: 1, lastSeen: 2 }, { airportIcao: 'VVTS', rulesVersion: 'r1', localTimeZone: 'Asia/Ho_Chi_Minh' }),
    null,
  );
});

test('normalise carries through origin and distance fields', () => {
  const row = normalise(
    {
      icao24: 'abc123',
      callsign: ' VN123  ',
      firstSeen: 1758200000,
      lastSeen: 1758210000,
      estDepartureAirport: 'RKSI',
      departureAirportCandidatesCount: 2,
      estArrivalAirportHorizDistance: 1234.9,
    },
    { airportIcao: 'VVTS', rulesVersion: 'r1', localTimeZone: 'Asia/Ho_Chi_Minh' },
  );
  assert.equal(row.icao24, 'abc123');
  assert.equal(row.callsign, 'VN123');
  assert.equal(row.estDepartureAirport, 'RKSI');
  assert.equal(row.departureCandidates, 2);
  assert.equal(row.arrivalHorizDistM, 1235);
  assert.equal(row.rulesVersion, 'r1');
});

test('insertArrivals is idempotent under the (icao24, first_seen) key', async () => {
  const pool = await freshPool();
  const row = normalise(
    { icao24: 'xyz789', firstSeen: 1758200000, lastSeen: 1758210000, estDepartureAirport: 'LFPG' },
    { airportIcao: 'VVTS', rulesVersion: 'r1', localTimeZone: 'Asia/Ho_Chi_Minh' },
  );

  const first = await insertArrivals(pool, [row]);
  const second = await insertArrivals(pool, [row]); // simulates an overlapping re-poll
  assert.equal(first, 1);
  assert.equal(second, 0);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM sgn_arrivals');
  assert.equal(rows[0].n, 1);
});

test('recordPoll writes both successful and failed attempts', async () => {
  const pool = await freshPool();
  await recordPoll(pool, {
    windowBegin: new Date('2026-09-18T00:00:00Z'),
    windowEnd: new Date('2026-09-18T06:00:00Z'),
    returned: 5,
    inserted: 3,
    ok: true,
  });
  await recordPoll(pool, {
    windowBegin: new Date('2026-09-18T06:00:00Z'),
    windowEnd: new Date('2026-09-18T12:00:00Z'),
    returned: 0,
    inserted: 0,
    ok: false,
    error: 'token request failed',
  });
  const { rows } = await pool.query('SELECT ok, error FROM sgn_polls ORDER BY polled_at');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[1].error, 'token request failed');
});
