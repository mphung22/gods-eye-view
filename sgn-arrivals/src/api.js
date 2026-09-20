import http from 'node:http';
import { hintFor } from './airports.js';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function parseQuery(url) {
  return Object.fromEntries(new URL(url, 'http://localhost').searchParams);
}

/**
 * Create the read-only HTTP API.
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.config From loadConfig.
 * @param {{lastPoll: () => object|null}} deps.poller
 * @returns {http.Server}
 */
export function createApi({ pool, config, poller }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/health') {
        const last = poller.lastPoll();
        return sendJson(res, 200, {
          ok: true,
          airport: config.airportIcao,
          rulesVersion: config.rulesVersion,
          rulesVersionOverridden: config.rulesVersionOverridden,
          openskyConfigured: Boolean(config.openskyClientId && config.openskyClientSecret),
          pollIntervalMs: config.pollIntervalMs,
          lookbackHours: config.lookbackHours,
          lastPoll: last,
        });
      }

      // Raw rows, most recent first. This is the table other tools should
      // read from directly once there is enough history to be worth it —
      // everything else here is a convenience view over the same rows.
      if (url.pathname === '/arrivals') {
        const q = parseQuery(req.url);
        const hours = Math.min(Number(q.hours) || 24 * 7, 24 * 90);
        const limit = Math.min(Number(q.limit) || 200, 1000);
        const { rows } = await pool.query(
          `SELECT icao24, callsign, est_departure_airport, arrival_horiz_dist_m,
                  first_seen, last_seen, local_date, local_hour, rules_version
             FROM sgn_arrivals
            WHERE last_seen >= now() - ($1 || ' hours')::interval
            ORDER BY last_seen DESC
            LIMIT $2`,
          [hours, limit],
        );
        return sendJson(
          res,
          200,
          rows.map((r) => ({ ...r, origin: hintFor(r.est_departure_airport) })),
        );
      }

      // The answer the whole service exists to produce: which hour of the
      // day, in local time, do landings actually cluster in. Four weeks is
      // the playbook's own stated threshold for having enough signal.
      if (url.pathname === '/by-hour') {
        const q = parseQuery(req.url);
        const days = Math.min(Number(q.days) || 28, 180);
        const { rows } = await pool.query(
          `SELECT local_hour, count(*)::int AS landings
             FROM sgn_arrivals
            WHERE last_seen >= now() - ($1 || ' days')::interval
            GROUP BY local_hour
            ORDER BY local_hour`,
          [days],
        );
        return sendJson(res, 200, { days, byHour: rows });
      }

      // The other half of the answer: which origins show up, so a language
      // mix can be read off rather than guessed. `origin` is null for a
      // flight OpenSky could not estimate a departure airport for — common
      // enough at a busy airport that it is reported rather than dropped.
      if (url.pathname === '/by-origin') {
        const q = parseQuery(req.url);
        const days = Math.min(Number(q.days) || 28, 180);
        const { rows } = await pool.query(
          `SELECT est_departure_airport AS icao, count(*)::int AS landings
             FROM sgn_arrivals
            WHERE last_seen >= now() - ($1 || ' days')::interval
            GROUP BY est_departure_airport
            ORDER BY landings DESC
            LIMIT 100`,
          [days],
        );
        return sendJson(
          res,
          200,
          { days, byOrigin: rows.map((r) => ({ ...r, ...hintFor(r.icao) })) },
        );
      }

      // Poll history, so a gap in /arrivals can be told apart from a quiet
      // airport — same purpose as the chokepoint collector's service_hours.
      if (url.pathname === '/polls') {
        const q = parseQuery(req.url);
        const limit = Math.min(Number(q.limit) || 50, 500);
        const { rows } = await pool.query(
          `SELECT polled_at, window_begin, window_end, returned, inserted, ok, error
             FROM sgn_polls
            ORDER BY polled_at DESC
            LIMIT $1`,
          [limit],
        );
        return sendJson(res, 200, rows);
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      console.error('[sgn-arrivals] request failed:', error?.message || error);
      sendJson(res, 500, { error: 'internal error' });
    }
  });
}
