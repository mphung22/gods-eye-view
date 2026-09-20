import { fetchArrivals } from './opensky.js';
import { normalise, insertArrivals, recordPoll } from './store.js';

/**
 * Run one poll: fetch the lookback window, insert whatever is new, and
 * record the attempt either way. Never throws — a failed poll is recorded
 * as one, not lost, so /health and /polls can show it.
 *
 * @param {object} deps
 * @param {import('pg').Pool} deps.pool
 * @param {object} deps.config
 * @param {{getToken: () => Promise<string>}} deps.auth
 * @param {(nowMs: number) => void} [deps.now] Injectable clock, for tests.
 * @returns {Promise<object>} The poll record that was written.
 */
export async function runPoll({ pool, config, auth }, now = Date.now) {
  const nowMs = now();
  const windowEnd = new Date(nowMs);
  const windowBegin = new Date(nowMs - config.lookbackHours * 3_600_000);
  const beginSec = Math.floor(windowBegin.getTime() / 1000);
  const endSec = Math.floor(windowEnd.getTime() / 1000);

  const record = { windowBegin, windowEnd, returned: 0, inserted: 0, ok: true, error: null };

  if (!config.openskyClientId || !config.openskyClientSecret) {
    // Same shape as chokepoint-collector without an AISSTREAM_API_KEY: start,
    // serve reads, record nothing, rather than crash-loop on a missing
    // secret Render has no value for yet.
    record.ok = false;
    record.error = 'OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET not set';
    await recordPoll(pool, record);
    return record;
  }

  try {
    const raw = await fetchArrivals(config, auth, beginSec, endSec);
    record.returned = raw.length;
    const rows = raw
      .filter((r) => r.estArrivalAirport === config.airportIcao || !r.estArrivalAirport)
      .map((r) =>
        normalise(r, {
          airportIcao: config.airportIcao,
          rulesVersion: config.rulesVersion,
          localTimeZone: config.localTimeZone,
        }),
      )
      .filter(Boolean);
    record.inserted = await insertArrivals(pool, rows);
  } catch (error) {
    record.ok = false;
    record.error = error?.message || String(error);
  }

  await recordPoll(pool, record);
  return record;
}
