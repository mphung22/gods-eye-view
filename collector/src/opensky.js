// OpenSky client: OAuth, bounded-box polling, and an honest failure signal.
//
// The globe app's own provider carries a hard-won note about this API — a day
// of unbounded polling burned the entire ~4000-credit daily budget in about
// eight hours, after which the layer simply died. Bounded boxes cost far less
// than the global feed, and the poll interval here is conservative by default.
//
// The part that matters more than the data: every poll reports whether it
// SUCCEEDED. A failed poll and an empty sky produce the same array of zero
// aircraft, and the whole point of this collector is that those two must never
// be confused.

import { openSkyQuery } from './domain/airspaces.js';

/**
 * Token endpoints, tried in order.
 *
 * Keycloak 17 dropped the `/auth` path prefix, and deployments migrated at
 * different times. The globe app uses the older form and works, so it is
 * tried first — but if OpenSky has since moved, the old host or path fails at
 * the network layer and the newer form is the fix. Trying both costs one extra
 * request on the first boot after a migration and nothing afterwards, which is
 * cheaper than a round trip to a human to find out which is live.
 */
const TOKEN_URLS = [
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
  'https://auth.opensky-network.org/realms/opensky-network/protocol/openid-connect/token',
];

/**
 * Unwrap what `fetch failed` is actually hiding.
 *
 * Node's fetch reports every network-layer problem — DNS, refused connection,
 * expired certificate, timeout — as the same three useless words, and puts the
 * real reason in `error.cause`. Reporting only the message turns four distinct
 * faults with four distinct fixes into one indistinguishable blob, which is
 * precisely the failure this whole collector exists to avoid.
 *
 * @param {unknown} error Caught value.
 * @returns {string} Something a person can act on.
 */
export function describeFetchError(error) {
  const message = error?.message || String(error);
  const cause = error?.cause;
  if (!cause) return message;
  const code = cause.code || cause.errno || '';
  const detail = cause.message || '';
  const parts = [message, code, detail].filter(Boolean);
  // Deduplicate: undici often repeats the message inside the cause.
  return [...new Set(parts)].join(': ');
}
const STATES_URL = 'https://opensky-network.org/api/states/all';
/** Refresh the token this long before it actually expires. */
const TOKEN_SKEW_MS = 60_000;

/**
 * Index of the OpenSky state vector array.
 * The API returns positional arrays rather than objects, so these names are
 * the only thing standing between the code and a silent off-by-one.
 */
const STATE = Object.freeze({
  icao24: 0,
  callsign: 1,
  originCountry: 2,
  timePosition: 3,
  lastContact: 4,
  longitude: 5,
  latitude: 6,
  baroAltitude: 7,
  onGround: 8,
  velocity: 9,
  trueTrack: 10,
  verticalRate: 11,
  squawk: 14,
});

/**
 * Turn one OpenSky state vector into a named record.
 * @param {Array} s Positional state vector.
 * @returns {object|null} Normalised contact, or null when unusable.
 */
export function parseState(s) {
  if (!Array.isArray(s)) return null;
  const icao24 = String(s[STATE.icao24] ?? '')
    .trim()
    .toLowerCase();
  if (!icao24) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const callsign = String(s[STATE.callsign] ?? '').trim() || null;
  return {
    icao24,
    callsign,
    originCountry: String(s[STATE.originCountry] ?? '').trim() || null,
    lat: num(s[STATE.latitude]),
    lon: num(s[STATE.longitude]),
    altitudeM: num(s[STATE.baroAltitude]),
    velocityMs: num(s[STATE.velocity]),
    verticalRateMs: num(s[STATE.verticalRate]),
    trueTrack: num(s[STATE.trueTrack]),
    onGround: s[STATE.onGround] === true,
    squawk: String(s[STATE.squawk] ?? '').trim() || null,
    // Seconds since epoch, from the network rather than from our clock.
    observedAt:
      num(s[STATE.timePosition]) ?? num(s[STATE.lastContact]) ?? null,
  };
}

/**
 * Create an OpenSky poller.
 *
 * @param {object} config From loadConfig.
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl] Injected for tests.
 * @returns {object} Poller with `poll` and `status`.
 */
export function createOpenSky(config, deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  let token = null;
  let tokenExpiresAt = 0;
  /** The token URL that last worked, so it is tried first next time. */
  let tokenUrl = null;
  /** Epoch ms before which no request is attempted, after a 429. */
  let cooldownUntil = 0;
  let creditsRemaining = null;
  let lastError = null;
  let lastOkAt = null;

  async function getToken(nowMs) {
    if (!config.openSkyClientId || !config.openSkyClientSecret) return null;
    if (token && nowMs < tokenExpiresAt - TOKEN_SKEW_MS) return token;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.openSkyClientId,
      client_secret: config.openSkyClientSecret,
    });

    const failures = [];
    // A URL that worked before is tried first on every refresh, so the
    // fallback costs nothing once one of them has answered.
    const urls = tokenUrl ? [tokenUrl, ...TOKEN_URLS.filter((u) => u !== tokenUrl)] : TOKEN_URLS;
    for (const url of urls) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
        if (!res.ok) {
          // 401/403 is a credential problem and no other URL will fix it, so
          // it stops here rather than being retried and reported as the
          // second URL's fault.
          if (res.status === 401 || res.status === 403) {
            throw new Error(`token rejected: HTTP ${res.status} — check the client id and secret`);
          }
          failures.push(`${url} -> HTTP ${res.status}`);
          continue;
        }
        const json = await res.json();
        token = json.access_token;
        tokenExpiresAt = nowMs + (Number(json.expires_in) || 1800) * 1000;
        tokenUrl = url;
        return token;
      } catch (error) {
        if (String(error?.message || '').startsWith('token rejected')) throw error;
        failures.push(`${url} -> ${describeFetchError(error)}`);
      }
    }
    throw new Error(`no token endpoint answered — ${failures.join(' | ')}`);
  }

  return {
    /**
     * Poll one airspace.
     *
     * Never throws. Returns `{ok, contacts, reason}` — a caller that only
     * looked at `contacts` would read a rate-limit as an empty sky, so the
     * flag is the return value's first field and the counts are useless
     * without it.
     *
     * @param {object} airspace Registry entry.
     * @param {number} [nowMs] Wall clock.
     * @returns {Promise<{ok:boolean, contacts:object[], reason:string|null}>}
     */
    async poll(airspace, nowMs = Date.now()) {
      if (nowMs < cooldownUntil) {
        return { ok: false, contacts: [], reason: 'cooldown' };
      }
      try {
        const headers = { Accept: 'application/json' };
        const bearer = await getToken(nowMs);
        if (bearer) headers.Authorization = `Bearer ${bearer}`;

        const res = await fetchImpl(`${STATES_URL}?${openSkyQuery(airspace)}`, {
          headers,
        });

        const remaining = res.headers?.get?.('X-Rate-Limit-Remaining');
        if (remaining !== null && remaining !== undefined && remaining !== '') {
          const parsed = Number(remaining);
          if (Number.isFinite(parsed)) creditsRemaining = parsed;
        }

        if (res.status === 429) {
          // Honour the server's own backoff rather than inventing one.
          const retry = Number(
            res.headers?.get?.('X-Rate-Limit-Retry-After-Seconds') || 0,
          );
          const waitMs = Math.min(
            30 * 60_000,
            Math.max(60_000, (Number.isFinite(retry) ? retry : 0) * 1000),
          );
          cooldownUntil = nowMs + waitMs;
          lastError = `429, cooling for ${Math.round(waitMs / 1000)}s`;
          return { ok: false, contacts: [], reason: 'rate-limited' };
        }
        if (!res.ok) {
          lastError = `http ${res.status}`;
          return { ok: false, contacts: [], reason: `http-${res.status}` };
        }

        const json = await res.json();
        const states = Array.isArray(json?.states) ? json.states : [];
        const contacts = states.map(parseState).filter(Boolean);
        lastError = null;
        lastOkAt = nowMs;
        // An empty array from a 200 is a real observation: the sky was quiet.
        // That is why ok is true here even when nothing came back.
        return { ok: true, contacts, reason: null };
      } catch (error) {
        // `fetch failed` on its own names four different faults with four
        // different fixes. Unwrap it, and say which half of the exchange
        // broke, because "auth is unreachable" and "the data host is
        // unreachable" are not the same problem.
        lastError = describeFetchError(error);
        const reason = /token/i.test(lastError) ? 'auth-error' : 'fetch-error';
        return { ok: false, contacts: [], reason };
      }
    },

    /** @returns {object} Auth and budget state, for /diagnostics. */
    status(nowMs = Date.now()) {
      return {
        configured: Boolean(config.openSkyClientId && config.openSkyClientSecret),
        creditsRemaining,
        coolingDownForMs: Math.max(0, cooldownUntil - nowMs),
        tokenUrl,
        lastOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null,
        lastError,
      };
    },
  };
}
