import { createServer } from 'node:http';
import {
  CHOKEPOINT_IDS,
  PRIMARY_CHOKEPOINT,
  chokepointById,
} from './domain/chokepoints.js';
import { AIRSPACE_IDS } from './domain/airspaces.js';
import {
  readAirContacts,
  readAirspaceHours,
  readCoverage,
  readCrossings,
  readDays,
  readGaps,
  readHours,
} from './store.js';

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Read a bounded integer query parameter, or its default.
 *
 * The absent case has to be tested BEFORE conversion. `Number(null)` is `0`
 * and `Number('')` is `0`, both finite, so a missing parameter passed the
 * `isFinite` guard and was clamped to `min` instead of falling through to the
 * default. Every endpoint served its narrowest possible window, and
 * `/crossings` — whose `limit` has a floor of 1 — returned exactly one row to
 * every caller who did not ask for more.
 *
 * Nothing about that looked like a failure from the outside: a one-row answer
 * to "show me the crossings" reads as a collector that has recorded one
 * crossing.
 *
 * @param {URLSearchParams} params Query string.
 * @param {string} name Parameter name.
 * @param {number} min Lower clamp.
 * @param {number} max Upper clamp.
 * @param {number} fallback Value when absent, blank or unparseable.
 * @returns {number} The clamped integer.
 */
function intParam(params, name, min, max, fallback) {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export const __testing = { intParam };

/**
 * Read-only HTTP API over the collected data.
 *
 * Every counts response carries `coverage` alongside, by construction. A
 * client that forgets to ask how much of the window was observed would read a
 * restart as a fall in traffic, so the two are never served apart.
 *
 * @param {object} deps
 * @param {object} deps.pool Postgres pool.
 * @param {object} deps.ingest Ingest pipeline, for stats.
 * @param {object} deps.stream AIS controller, for status.
 * @param {object} deps.config Loaded config.
 * @returns {import('node:http').Server} Unstarted server.
 */
export function createApi({ pool, ingest, stream, config, airwatch, openSky }) {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const params = url.searchParams;
    const chokepoint = params.get('chokepoint') || null;

    try {
      if (chokepoint && !chokepointById(chokepoint)) {
        send(res, 400, {
          error: `unknown chokepoint; known: ${CHOKEPOINT_IDS.join(', ')}`,
        });
        return;
      }

      if (url.pathname === '/health') {
        // Every bounded structure's current size, so unbounded growth shows up
        // here long before it shows up as an out-of-memory restart.
        send(res, 200, {
          ok: true,
          rulesVersion: config.rulesVersion,
          // Non-null means the environment is stamping rows with a ruleset
          // this code does not implement.
          rulesVersionShouldBe: config.rulesVersionOverridden,
          stream: stream?.status?.() ?? null,
          ingest: ingest?.stats?.() ?? null,
          airwatch: airwatch?.stats?.() ?? null,
          uptimeSec: Math.round(process.uptime()),
          memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        });
        return;
      }

      if (url.pathname === '/diagnostics') {
        // Deliberately answers in one call. Every round trip here costs a
        // person a browser session, so a diagnostic split across three URLs to
        // be compared by hand is one that does not get run.
        send(res, 200, {
          keyConfigured: Boolean(config.aisKey),
          primary: PRIMARY_CHOKEPOINT,
          stream: stream?.status?.() ?? null,
          ...(ingest?.diagnostics?.() ?? {}),
          openSky: openSky?.status?.() ?? null,
          airspaces: airwatch?.diagnostics?.() ?? [],
        });
        return;
      }

      if (url.pathname === '/hours' || url.pathname === '/') {
        const hours = intParam(params, 'hours', 1, 24 * 365 * 2, 720);
        send(res, 200, {
          rows: await readHours(pool, { chokepoint, hours }),
          coverage: await readCoverage(pool, hours),
          chokepoints: CHOKEPOINT_IDS,
          primary: PRIMARY_CHOKEPOINT,
          rulesVersion: config.rulesVersion,
        });
        return;
      }

      if (url.pathname === '/days') {
        const hours = intParam(params, 'hours', 24, 24 * 365 * 2, 24 * 90);
        send(res, 200, {
          rows: await readDays(pool, { chokepoint, hours }),
          coverage: await readCoverage(pool, hours),
        });
        return;
      }

      if (url.pathname === '/crossings') {
        send(res, 200, {
          rows: await readCrossings(pool, {
            chokepoint,
            hours: intParam(params, 'hours', 1, 24 * 90, 24),
            limit: intParam(params, 'limit', 1, 5000, 500),
          }),
          note: 'ship_type, draught_m and length_m are self-reported; size_class and laden_state are derived on read',
        });
        return;
      }

      if (url.pathname === '/air') {
        const airspace = params.get('airspace') || null;
        if (airspace && !AIRSPACE_IDS.includes(airspace)) {
          send(res, 400, {
            error: `unknown airspace; known: ${AIRSPACE_IDS.join(', ')}`,
          });
          return;
        }
        const hours = intParam(params, 'hours', 1, 24 * 365 * 2, 168);
        send(res, 200, {
          rows: await readAirspaceHours(pool, { airspace, hours }),
          contacts: await readAirContacts(pool, {
            airspace,
            hours: intParam(params, 'contactHours', 1, 24 * 90, 24),
            limit: intParam(params, 'limit', 1, 2000, 200),
          }),
          airspaces: AIRSPACE_IDS,
          note: 'polls_attempted vs polls_ok is the denominator — an hour with polls_ok 0 is unobserved, not quiet. role and loitering are heuristics over a crew-typed callsign.',
        });
        return;
      }

      if (url.pathname === '/gaps') {
        const classification = params.get('class');
        if (classification && !['dark', 'spoofed'].includes(classification)) {
          send(res, 400, { error: 'unknown class; known: dark, spoofed' });
          return;
        }
        send(res, 200, {
          rows: await readGaps(pool, {
            chokepoint,
            classification,
            hours: intParam(params, 'hours', 1, 24 * 90, 24),
            limit: intParam(params, 'limit', 1, 2000, 200),
          }),
        });
        return;
      }

      send(res, 404, {
        error: 'not found',
        routes: [
          '/health', '/diagnostics', '/hours', '/days', '/crossings', '/gaps', '/air',
        ],
      });
    } catch (error) {
      console.error('[api]', error?.message || error);
      // Never leak a driver message or a connection string to a caller.
      send(res, 500, { error: 'query failed' });
    }
  });
}
