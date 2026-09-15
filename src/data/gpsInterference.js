import * as Cesium from 'cesium';

const SEVERITY_COLOR = {
  red: Cesium.Color.fromCssColorString('#ff3b30'),
  yellow: Cesium.Color.fromCssColorString('#ffcc00'),
  green: Cesium.Color.fromCssColorString('#34c759'),
};

const UPDATE_INTERVAL_MS = 45000;
// Skip a refetch while the camera has barely moved — the server cache
// already dedupes this by rounded lat/lon, but this avoids the round trip
// entirely while parked over the same region.
const CAMERA_MOVE_REFETCH_DEGREES = 1.5;

function anchorFromViewer(viewer) {
  const cartographic = viewer?.camera?.positionCartographic;
  if (!cartographic) return null;
  return {
    latitude: Cesium.Math.toDegrees(cartographic.latitude),
    longitude: Cesium.Math.toDegrees(cartographic.longitude),
  };
}

/**
 * A live, best-effort GPS-jamming/spoofing overlay derived from ADS-B
 * position-integrity fields (NIC / NAC_p) near the camera, via the
 * /api/gps-interference proxy. This is NOT GPSJam.org data (it has no
 * public API) — it is a snapshot-based approximation of GPSJam's published
 * red/yellow/green methodology. See server/providers/gps.js for the exact
 * math and its limitations (no 24h aggregation, coarse lat/lon grid).
 */
export function createGpsInterferenceLayer({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _request = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _lastAnchor = null;
  let _totalAircraft = 0;
  let _consideredAircraft = 0;

  const layer = {
    id: 'local-gps-interference',
    name: 'GPS Interference (Est.)',
    icon: '📡',
    source: 'ADS-B (derived, snapshot)',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      if (_viewer) throw new Error('GPS interference layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('gps-interference');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _lastAnchor = null;
      _enabled = false;
      console.log('[Data:GpsInterference] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      const anchor = anchorFromViewer(viewer || _viewer);
      if (!anchor) return false;
      if (
        _lastAnchor &&
        _lastUpdate &&
        Date.now() - _lastUpdate < UPDATE_INTERVAL_MS &&
        Math.abs(_lastAnchor.latitude - anchor.latitude) < CAMERA_MOVE_REFETCH_DEGREES &&
        Math.abs(_lastAnchor.longitude - anchor.longitude) < CAMERA_MOVE_REFETCH_DEGREES
      ) {
        return true;
      }
      _request?.abort();
      const controller = new AbortController();
      _request = controller;
      try {
        const params = new URLSearchParams({
          lat: anchor.latitude.toFixed(4),
          lon: anchor.longitude.toFixed(4),
        });
        const response = await fetchImpl(`/api/gps-interference?${params}`, {
          signal: controller.signal,
        });
        if (_request !== controller || !_enabled) return false;
        if (!response.ok) {
          const payload = await response.json().catch(() => null);
          throw new Error(
            payload?.error || `GPS interference feed HTTP ${response.status}`,
          );
        }
        const payload = await response.json();
        if (_request !== controller || !_enabled) return false;

        const nextEntities = [];
        for (const cell of Array.isArray(payload?.cells) ? payload.cells : []) {
          if (cell.severity === 'insufficient') continue; // nothing meaningful to draw
          const color = SEVERITY_COLOR[cell.severity] || SEVERITY_COLOR.green;
          nextEntities.push(
            new Cesium.Entity({
              id: `gps-interference:${cell.latMin},${cell.lonMin}`,
              rectangle: {
                coordinates: Cesium.Rectangle.fromDegrees(
                  cell.lonMin,
                  cell.latMin,
                  cell.lonMax,
                  cell.latMax,
                ),
                material: color.withAlpha(cell.severity === 'red' ? 0.45 : 0.3),
                outline: true,
                outlineColor: color.withAlpha(0.9),
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                severity: cell.severity,
                sampleCount: cell.sampleCount,
                degradedCount: cell.degradedCount,
                degradedPct: cell.degradedPct,
              },
            }),
          );
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);

        _count = nextEntities.length;
        _lastUpdate = Date.now();
        _lastError = null;
        _lastAnchor = anchor;
        _totalAircraft = payload?.totalAircraft || 0;
        _consideredAircraft = payload?.consideredAircraft || 0;
        console.log(
          `[Data:GpsInterference] Updated: ${_count} cells (${_consideredAircraft} reports considered)`,
        );
        return true;
      } catch (e) {
        if (controller.signal.aborted || _request !== controller || !_enabled)
          return false;
        console.warn('[Data:GpsInterference] Fetch error:', e);
        _lastError = e?.message || 'GPS interference feed unavailable';
        return false;
      } finally {
        if (_request === controller) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource && viewer) {
        viewer.dataSources.remove(_dataSource, true);
      }
      _dataSource = null;
      _viewer = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _lastAnchor = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        totalAircraft: _totalAircraft,
        consideredAircraft: _consideredAircraft,
      };
    },
  };
  return layer;
}

export default createGpsInterferenceLayer();
