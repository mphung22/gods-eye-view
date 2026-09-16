import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { exportAisStreamState, importAisStreamState } from './ais-store.js';
import { exportAisGapState, importAisGapState } from './ais-gaps.js';
import {
  exportTimeseriesState,
  importTimeseriesState,
} from './ais-timeseries.js';

// Render's persistent disk (mounted at this path in production) is what lets
// accumulated vessel history survive a restart/redeploy instead of resetting
// to empty every time — see AIS_PERSIST_PATH to point elsewhere (e.g. local
// dev, or a differently-mounted disk).
const DEFAULT_PERSIST_PATH = '/var/data/ais-vessels.json';
// The hourly counters live in their OWN file, deliberately. The vessel
// snapshot is a 24h cache that prunes itself; this one is a years-long record
// that can never be rebuilt. Sharing a file would eventually mean one
// retention rule quietly deleting the other's data.
const DEFAULT_TIMESERIES_PATH = '/var/data/hormuz-timeseries.json';
const SAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** @type {number|null} */
let _saveTimer = null;
/** @type {string|null} */
let _persistPath = null;
/** @type {string|null} */
let _timeseriesPath = null;
let _shutdownHooksArmed = false;

function persistPath() {
  if (_persistPath) return _persistPath;
  _persistPath = process.env.AIS_PERSIST_PATH || DEFAULT_PERSIST_PATH;
  return _persistPath;
}

function timeseriesPath() {
  if (_timeseriesPath) return _timeseriesPath;
  _timeseriesPath =
    process.env.AIS_TIMESERIES_PATH || DEFAULT_TIMESERIES_PATH;
  return _timeseriesPath;
}

/**
 * Loads a previously-saved vessel snapshot from disk, meant to run once at
 * server startup before the live feed reconnects. A missing disk, missing
 * file, or corrupt JSON is a silent no-op — persistence is a bonus on top of
 * the live feed, never something that can block the app from starting.
 */
export function loadAisStreamStateFromDisk() {
  const path = persistPath();
  try {
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf8');
    const state = JSON.parse(raw);
    const restored = importAisStreamState(state);
    // Snapshots written before gap detection existed simply carry no `gaps`
    // key, and restore zero — the reader must stay backward compatible.
    const gaps = importAisGapState(state);
    if (restored > 0) {
      console.log(
        `[AIS Persistence] Restored ${restored} vessel(s) from ${path}`,
      );
    }
    if (gaps > 0) {
      console.log(`[AIS Persistence] Restored ${gaps} AIS gap event(s)`);
    }
  } catch (error) {
    console.warn(
      '[AIS Persistence] Could not load saved state:',
      error?.message || error,
    );
  }

  // Loaded separately so a corrupt vessel snapshot cannot take the
  // unrebuildable hourly record down with it.
  const tsPath = timeseriesPath();
  try {
    if (existsSync(tsPath)) {
      const hours = importTimeseriesState(
        JSON.parse(readFileSync(tsPath, 'utf8')),
      );
      if (hours > 0) {
        console.log(
          `[AIS Persistence] Restored ${hours} hour(s) of Hormuz counters`,
        );
      }
    }
  } catch (error) {
    console.warn(
      '[AIS Persistence] Could not load Hormuz time series:',
      error?.message || error,
    );
  }
}

/**
 * Writes the current vessel cache to disk. Saves through a temp file + swap
 * so a crash mid-write can never leave a truncated file that fails to parse
 * on the next restart.
 */
function saveAisStreamStateToDisk() {
  const path = persistPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const state = { ...exportAisStreamState(), ...exportAisGapState() };
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state));
    renameSync(tmpPath, path);
  } catch (error) {
    console.warn(
      '[AIS Persistence] Could not save state:',
      error?.message || error,
    );
  }

  const tsPath = timeseriesPath();
  try {
    mkdirSync(dirname(tsPath), { recursive: true });
    const tmpPath = `${tsPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(exportTimeseriesState()));
    renameSync(tmpPath, tsPath);
  } catch (error) {
    console.warn(
      '[AIS Persistence] Could not save Hormuz time series:',
      error?.message || error,
    );
  }
}

/**
 * Starts the periodic disk-save timer (idempotent, unref'd — same pattern as
 * the AISStream watchdog tick in ais-live.js, so it never holds the process
 * open on its own). Also flushes once on SIGTERM/SIGINT, since Render sends
 * SIGTERM before stopping or restarting an instance — without this, up to
 * SAVE_INTERVAL_MS of the freshest history would be lost on every restart.
 */
export function startAisPersistence() {
  if (_saveTimer) return;
  _saveTimer = setInterval(saveAisStreamStateToDisk, SAVE_INTERVAL_MS);
  _saveTimer.unref?.();
  if (!_shutdownHooksArmed) {
    _shutdownHooksArmed = true;
    process.once('SIGTERM', saveAisStreamStateToDisk);
    process.once('SIGINT', saveAisStreamStateToDisk);
  }
}
