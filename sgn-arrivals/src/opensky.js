// OpenSky's REST API now exclusively supports the OAuth2 client-credentials
// flow (basic auth with a username/password is no longer accepted). A token
// lasts 30 minutes; this module caches one and refreshes a little early
// rather than reacting to a 401, so a slow request never straddles expiry.

const TOKEN_REFRESH_SKEW_MS = 60_000;

/**
 * Create a token-caching OAuth2 client for the OpenSky auth server.
 * @param {object} config From loadConfig.
 * @returns {{getToken: () => Promise<string>}}
 */
export function createAuth(config) {
  let cached = null; // { token, expiresAtMs }

  async function fetchToken() {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: config.openskyClientId,
      client_secret: config.openskyClientSecret,
    });
    const res = await fetch(config.openskyTokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`OpenSky token request failed: ${res.status} ${await res.text()}`);
    }
    const json = await res.json();
    const expiresInMs = (Number(json.expires_in) || 1800) * 1000;
    cached = {
      token: json.access_token,
      expiresAtMs: Date.now() + expiresInMs - TOKEN_REFRESH_SKEW_MS,
    };
    return cached.token;
  }

  return {
    async getToken() {
      if (cached && Date.now() < cached.expiresAtMs) return cached.token;
      return fetchToken();
    },
  };
}

/**
 * One flight as OpenSky's /flights/arrival returns it, narrowed to the
 * fields this service keeps.
 * @typedef {object} RawArrival
 * @property {string} icao24
 * @property {string|null} callsign
 * @property {number} firstSeen Unix seconds.
 * @property {string|null} estDepartureAirport
 * @property {number|null} departureAirportCandidatesCount
 * @property {number} lastSeen Unix seconds.
 * @property {string|null} estArrivalAirport
 * @property {number|null} estArrivalAirportHorizDistance
 */

/**
 * Fetch arrivals at one airport in one window.
 *
 * @param {object} config From loadConfig.
 * @param {{getToken: () => Promise<string>}} auth From createAuth.
 * @param {number} beginSec Unix seconds.
 * @param {number} endSec Unix seconds. `endSec - beginSec` must be <= 2 days;
 *   OpenSky rejects a wider window outright.
 * @returns {Promise<RawArrival[]>}
 */
export async function fetchArrivals(config, auth, beginSec, endSec) {
  const token = await auth.getToken();
  const url = new URL(`${config.openskyApiUrl}/flights/arrival`);
  url.searchParams.set('airport', config.airportIcao);
  url.searchParams.set('begin', String(beginSec));
  url.searchParams.set('end', String(endSec));

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) {
    // OpenSky returns 404 rather than [] when nothing landed in the window.
    // A quiet window at a major international airport is unusual enough to
    // treat the same as any other empty result rather than as an error.
    return [];
  }
  if (!res.ok) {
    throw new Error(`OpenSky arrivals request failed: ${res.status} ${await res.text()}`);
  }
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}
