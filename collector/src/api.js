import { createServer } from 'node:http';
import {
  CHOKEPOINT_IDS,
  PRIMARY_CHOKEPOINT,
  chokepointById,
} from './domain/chokepoints.js';
import {
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

function intParam(params, name, min, max, fallback) {
  const raw = Number(params.get(name));
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

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
export function createApi({ pool, ingest, stream, config }) {
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
          stream: stream?.status?.() ?? null,
          ingest: ingest?.stats?.() ?? null,
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
        routes: ['/health', '/diagnostics', '/hours', '/days', '/crossings', '/gaps'],
      });
    } catch (error) {
      console.error('[api]', error?.message || error);
      // Never leak a driver message or a connection string to a caller.
      send(res, 500, { error: 'query failed' });
    }
  });
}
