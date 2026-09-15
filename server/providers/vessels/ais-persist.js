import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { exportAisStreamState, importAisStreamState } from './ais-store.js';

// Render's persistent disk (mounted at this path in production) is what lets
// accumulated vessel history survive a restart/redeploy instead of resetting
// to empty every time — see AIS_PERSIST_PATH to point elsewhere (e.g. local
// dev, or a differently-mounted disk).
const DEFAULT_PERSIST_PATH = '/var/data/ais-vessels.json';
const SAVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/** @type {number|null} */
let _saveTimer = null;
/** @type {string|null} */
let _persistPath = null;
let _shutdownHooksArmed = false;

function persistPath() {
  if (_persistPath) return _persistPath;
  _persistPath = process.env.AIS_PERSIST_PATH || DEFAULT_PERSIST_PATH;
  return _persistPath;
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
    if (restored > 0) {
      console.log(
        `[AIS Persistence] Restored ${restored} vessel(s) from ${path}`,
      );
    }
  } catch (error) {
    console.warn(
      '[AIS Persistence] Could not load saved state:',
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
    const state = exportAisStreamState();
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(state));
    renameSync(tmpPath, path);
  } catch (error) {
    console.warn(
      '[AIS Persistence] Could not save state:',
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
