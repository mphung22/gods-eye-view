import { coalesceProxyRequest, readResponseJsonCapped } from './common/http.js';
import { clampInt } from './common/query.js';
import { adsbLolFallbackAnchor } from './aircraft/opensky.js';

/**
 * Vite plugin: derives a coarse GPS-interference (jamming/spoofing) overlay
 * from live ADS-B integrity fields. GPSJam.org itself has no public API, so
 * this is NOT GPSJam data — it is this app's own snapshot-based
 * approximation of GPSJam's published methodology, computed from whatever
 * aircraft adsb.lol currently reports near the requested point.
 *
 * For each aircraft in range, a position report is flagged "degraded" when
 * its Navigation Integrity Category (NIC) or Navigation Accuracy Category —
 * Position (NAC_p) falls at or below GPS_DEGRADED_THRESHOLD. Both fields
 * collapse toward 0 when an aircraft's GPS receiver loses confidence in its
 * fix — the signature GPSJam looks for. Reports are bucketed into a coarse
 * lat/lon grid, and each cell with enough samples is colored:
 *   green  — < 2% of reports degraded  (GPSJam's own "good" cutoff)
 *   yellow — 2-10% degraded            (GPSJam's own "low accuracy" band)
 *   red    — > 10% degraded            (GPSJam's own "likely jamming" band)
 *
 * Differences from the real GPSJam.org worth knowing:
 *   - GPSJam aggregates a rolling 24h of ADS-B history per hex cell; this
 *     proxy has no persistent storage, so it only reports THIS INSTANT's
 *     aircraft mix near the requested point. A quiet cell with few aircraft
 *     right now reads "insufficient data" even inside a real jamming zone.
 *   - GPSJam uses H3 hexagons; this uses plain lat/lon squares.
 *   - Coverage is bounded to the adsb.lol regional radius around the
 *     requested point (see GPS_RADIUS_NM), not global.
 *
 * @returns {import('vite').Plugin}
 */
export function gpsInterferenceProxy() {
  const GPS_RADIUS_NM = 250; // adsb.lol regional endpoint's practical max
  const GRID_DEG = 0.5; // ~55km cells at the equator
  const MIN_SAMPLES = 3; // cells with fewer reports read "insufficient data"
  const GPS_DEGRADED_THRESHOLD = 4; // NIC/NAC_p at-or-below this = degraded
  const CACHE_MS = 45000;
  const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
  const RATE_LIMIT_COOLDOWN_MS = 30000;
  const SERVER_ERROR_COOLDOWN_MS = 15000;
  const COOLDOWN_MIN_MS = 5000;
  const COOLDOWN_MAX_MS = 120000;
  const CACHE_MAX_ENTRIES = 64;

  /** @type {Map<string,{body:string, cachedAt:number}>} */
  const _cache = new Map();
  const _inFlight = new Map();
  let _cooldownUntil = 0;
  let _cooldownStatus = 0;

  const clampCooldown = (ms) =>
    Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, ms));

  const cooldownFor = (status) =>
    clampCooldown(
      status === 429 ? RATE_LIMIT_COOLDOWN_MS : SERVER_ERROR_COOLDOWN_MS,
    );

  function severityFor(sampleCount, degradedCount) {
    if (sampleCount < MIN_SAMPLES) return 'insufficient';
    const pct = degradedCount / sampleCount;
    if (pct > 0.1) return 'red';
    if (pct >= 0.02) return 'yellow';
    return 'green';
  }

  function buildCells(aircraft) {
    const cellMap = new Map();
    for (const ac of aircraft) {
      const lat = Number(ac?.lat);
      const lon = Number(ac?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const nic = Number(ac?.nic);
      const nacP = Number(ac?.nac_p);
      const hasIntegrity = Number.isFinite(nic) || Number.isFinite(nacP);
      // No integrity fields reported at all — skip rather than silently
      // counting it as a clean report.
      if (!hasIntegrity) continue;
      const degraded =
        (Number.isFinite(nic) && nic <= GPS_DEGRADED_THRESHOLD) ||
        (Number.isFinite(nacP) && nacP <= GPS_DEGRADED_THRESHOLD);
      const cellLat = Math.floor(lat / GRID_DEG) * GRID_DEG;
      const cellLon = Math.floor(lon / GRID_DEG) * GRID_DEG;
      const key = `${cellLat.toFixed(2)},${cellLon.toFixed(2)}`;
      let cell = cellMap.get(key);
      if (!cell) {
        cell = { latMin: cellLat, lonMin: cellLon, sampleCount: 0, degradedCount: 0 };
        cellMap.set(key, cell);
      }
      cell.sampleCount += 1;
      if (degraded) cell.degradedCount += 1;
    }
    return [...cellMap.values()].map((cell) => {
      const degradedPct = cell.sampleCount
        ? Math.round((cell.degradedCount / cell.sampleCount) * 1000) / 10
        : 0;
      return {
        lat: cell.latMin + GRID_DEG / 2,
        lon: cell.lonMin + GRID_DEG / 2,
        latMin: cell.latMin,
        latMax: cell.latMin + GRID_DEG,
        lonMin: cell.lonMin,
        lonMax: cell.lonMin + GRID_DEG,
        sampleCount: cell.sampleCount,
        degradedCount: cell.degradedCount,
        degradedPct,
        severity: severityFor(cell.sampleCount, cell.degradedCount),
      };
    });
  }

  function serve(res, status, body, cacheStatus, extra = {}) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-GPS-Interference-Cache': cacheStatus,
      ...extra,
    });
    res.end(body);
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/gps-interference', async (req, res) => {
      try {
        const anchor = adsbLolFallbackAnchor(req);
        if (!anchor) {
          serve(
            res,
            400,
            JSON.stringify({ error: 'lat and lon query params are required' }),
            'NONE',
          );
          return;
        }
        const incoming = new URL(req.url || '', 'http://localhost');
        const radiusNm = clampInt(
          incoming.searchParams.get('radius'),
          25,
          GPS_RADIUS_NM,
          GPS_RADIUS_NM,
        );
        const roundedLat = Math.round(anchor.latitude * 4) / 4;
        const roundedLon = Math.round(anchor.longitude * 4) / 4;
        const cacheKey = `${roundedLat.toFixed(2)},${roundedLon.toFixed(2)},${radiusNm}`;
        const now = Date.now();
        const cached = _cache.get(cacheKey);
        if (cached && now - cached.cachedAt < CACHE_MS) {
          serve(res, 200, cached.body, 'HIT');
          return;
        }
        if (now < _cooldownUntil) {
          if (cached) {
            serve(res, 200, cached.body, 'STALE', {
              'X-GPS-Interference-Upstream-Status': String(_cooldownStatus),
            });
            return;
          }
          serve(
            res,
            _cooldownStatus || 503,
            JSON.stringify({ error: 'adsb.lol upstream cooling down' }),
            'NONE',
            { 'Retry-After': String(Math.ceil((_cooldownUntil - now) / 1000)) },
          );
          return;
        }

        const { promise, shared } = coalesceProxyRequest(
          _inFlight,
          cacheKey,
          async () => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            try {
              const upstream = await fetch(
                `https://api.adsb.lol/v2/lat/${roundedLat}/lon/${roundedLon}/dist/${radiusNm}`,
                {
                  headers: {
                    Accept: 'application/json',
                    'User-Agent': 'gods-eye-view-gps-interference-proxy/1.0',
                  },
                  signal: controller.signal,
                },
              );
              if (!upstream.ok) {
                const error = new Error(`upstream HTTP ${upstream.status}`);
                error.status = upstream.status;
                throw error;
              }
              const payload = await readResponseJsonCapped(
                upstream,
                MAX_RESPONSE_BYTES,
              );
              const aircraft = Array.isArray(payload?.ac) ? payload.ac : [];
              const cells = buildCells(aircraft);
              const body = JSON.stringify({
                generatedAt: Date.now(),
                anchor: { lat: roundedLat, lon: roundedLon },
                radiusNm,
                gridDeg: GRID_DEG,
                minSamples: MIN_SAMPLES,
                degradedThreshold: GPS_DEGRADED_THRESHOLD,
                totalAircraft: aircraft.length,
                consideredAircraft: cells.reduce(
                  (sum, c) => sum + c.sampleCount,
                  0,
                ),
                cells,
                methodologyNote:
                  "Snapshot-based approximation of GPSJam.org's method, derived from live ADS-B NIC/NAC_p fields — not GPSJam data, no 24h aggregation.",
              });
              _cooldownUntil = 0;
              _cooldownStatus = 0;
              const record = { body, cachedAt: Date.now() };
              _cache.delete(cacheKey);
              _cache.set(cacheKey, record);
              while (_cache.size > CACHE_MAX_ENTRIES) {
                _cache.delete(_cache.keys().next().value);
              }
              return record;
            } finally {
              clearTimeout(timeoutId);
            }
          },
        );

        try {
          const record = await promise;
          serve(res, 200, record.body, shared ? 'INFLIGHT' : 'MISS');
        } catch (error) {
          const status = error?.status;
          if (status === 429 || status >= 500) {
            _cooldownUntil = Date.now() + cooldownFor(status);
            _cooldownStatus = status;
          }
          console.warn('[GPS Interference Proxy]', error?.message || error);
          if (cached) {
            serve(res, 200, cached.body, 'STALE', {
              'X-GPS-Interference-Upstream-Status': String(status || 0),
            });
            return;
          }
          serve(
            res,
            502,
            JSON.stringify({ error: 'GPS interference proxy error' }),
            'NONE',
          );
        }
      } catch (error) {
        console.error('[GPS Interference Proxy]', error?.message || error);
        serve(
          res,
          502,
          JSON.stringify({ error: 'GPS interference proxy error' }),
          'NONE',
        );
      }
    });
  };

  return {
    name: 'gps-interference-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
