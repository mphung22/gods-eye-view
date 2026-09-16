// Durable hourly record of Strait of Hormuz activity.
//
// The vessel cache forgets everything older than 24 hours, which is right for
// rendering a globe and useless for asking whether today is busier than last
// Tuesday. This module keeps the small aggregate numbers instead of the large
// positional ones: a few counters per hour, kept for years.
//
// It cannot be backfilled. Whatever was not recorded as it happened is gone,
// so the retention here is deliberately generous and the row is deliberately
// tiny — two years of hours is about 17,500 rows and a couple of megabytes,
// which costs nothing next to keeping one extra hour of vessel positions.
//
// A transit is a LINE CROSSING, not a presence count. Counting vessels inside
// a box conflates one ship loitering for a day with twenty ships passing
// through, and those mean opposite things.

/**
 * The counting gate: a meridian across the strait, bounded north and south so
 * it spans the shipping lanes without catching coastal traffic elsewhere.
 *
 * This is an approximation of a traffic separation scheme that actually runs
 * diagonally, so it is a consistent relative measure rather than an
 * authoritative transit count. Consistency is what a time series needs; the
 * absolute level can be calibrated against a published count later.
 */
export const HORMUZ_GATE = Object.freeze({
  lon: 56.5,
  minLat: 25.8,
  maxLat: 26.9,
});

/**
 * Where vessels wait when they are not transiting: the Gulf of Oman side of
 * the strait. A queue building here is the physical form of "ships are
 * choosing not to go through".
 */
export const HORMUZ_QUEUE_BOX = Object.freeze({
  minLat: 24.2,
  maxLat: 26.4,
  minLon: 56.6,
  maxLon: 58.8,
});

/** Speed below which a vessel counts as waiting rather than under way. */
export const QUEUE_MAX_SPEED_KTS = 0.5;
/** Hours retained. Two years; see the note above about backfilling. */
export const TIMESERIES_MAX_HOURS = 24 * 365 * 2;

/** @type {Map<number, object>} Epoch hour -> counters. */
let _hours = new Map();

function hourOf(ms) {
  return Math.floor(ms / 3_600_000);
}

function bucket(atMs) {
  const hour = hourOf(atMs);
  let row = _hours.get(hour);
  if (!row) {
    row = {
      hour,
      outbound: 0,
      inbound: 0,
      dark: 0,
      spoofed: 0,
      // null, not 0: "never sampled" and "sampled, found nothing waiting" are
      // different facts, and a chart that renders them the same lies.
      queueDepth: null,
      queueSamples: 0,
    };
    _hours.set(hour, row);
    pruneHours();
  }
  return row;
}

function pruneHours() {
  if (_hours.size <= TIMESERIES_MAX_HOURS) return;
  const ordered = [..._hours.keys()].sort((a, b) => a - b);
  for (const hour of ordered.slice(0, _hours.size - TIMESERIES_MAX_HOURS)) {
    _hours.delete(hour);
  }
}

/**
 * Whether a vessel's move crossed the counting gate, and which way.
 *
 * @param {object} previous Prior stored row with `lat`/`lon`.
 * @param {object} next Incoming fix with `lat`/`lon`.
 * @returns {'inbound'|'outbound'|null} Direction, or null for no crossing.
 */
export function gateCrossing(previous, next) {
  if (!previous || !next) return null;
  const fromLon = Number(previous.lon);
  const toLon = Number(next.lon);
  const fromLat = Number(previous.lat);
  const toLat = Number(next.lat);
  if (![fromLon, toLon, fromLat, toLat].every(Number.isFinite)) return null;

  // Both fixes must sit in the gate's latitude band. Requiring both ends keeps
  // a vessel that merely passed the meridian far to the south out of the count.
  const inBand = (lat) =>
    lat >= HORMUZ_GATE.minLat && lat <= HORMUZ_GATE.maxLat;
  if (!inBand(fromLat) || !inBand(toLat)) return null;

  const { lon } = HORMUZ_GATE;
  if (fromLon >= lon && toLon < lon) return 'inbound';
  if (fromLon < lon && toLon >= lon) return 'outbound';
  return null;
}

/**
 * Whether a vessel is waiting in the approaches rather than under way.
 * @param {object} row Stored vessel row.
 * @returns {boolean} True when inside the queue box and effectively stopped.
 */
export function isQueued(row) {
  const lat = Number(row?.lat);
  const lon = Number(row?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < HORMUZ_QUEUE_BOX.minLat || lat > HORMUZ_QUEUE_BOX.maxLat)
    return false;
  if (lon < HORMUZ_QUEUE_BOX.minLon || lon > HORMUZ_QUEUE_BOX.maxLon)
    return false;
  // A missing speed is not a stopped vessel. This has to reject null and
  // undefined BEFORE Number(), because Number(null) is 0 — and the store
  // writes speed: null on every row whose AIS message carried no SOG, which
  // is common. Coercing first would count most of the cache as "waiting", and
  // would do it hardest when the feed is degraded and the number is most
  // likely to be read as meaningful.
  const raw = row?.speed;
  if (raw === null || raw === undefined || raw === '') return false;
  const speed = Number(raw);
  return Number.isFinite(speed) && speed <= QUEUE_MAX_SPEED_KTS;
}

/**
 * Count one gate crossing.
 * @param {'inbound'|'outbound'} direction Crossing direction.
 * @param {number} [atMs] Wall-clock milliseconds.
 */
export function recordTransit(direction, atMs = Date.now()) {
  if (direction !== 'inbound' && direction !== 'outbound') return;
  bucket(atMs)[direction] += 1;
}

/**
 * Count one classified gap event.
 * @param {string} classification `dark` or `spoofed`.
 * @param {number} [atMs] Wall-clock milliseconds.
 */
export function recordGapForHour(classification, atMs = Date.now()) {
  const row = bucket(atMs);
  if (classification === 'spoofed') row.spoofed += 1;
  else row.dark += 1;
}

/**
 * Record a queue-depth observation. Averaged across samples within the hour so
 * a sampling-rate change does not look like a change in the water.
 * @param {number} depth Vessels counted waiting.
 * @param {number} [atMs] Wall-clock milliseconds.
 */
export function recordQueueDepth(depth, atMs = Date.now()) {
  if (!Number.isFinite(depth)) return;
  const row = bucket(atMs);
  const total = (row.queueDepth ?? 0) * row.queueSamples + depth;
  row.queueSamples += 1;
  row.queueDepth = Number((total / row.queueSamples).toFixed(2));
}

/**
 * Read hourly rows, oldest first.
 * @param {object} [query]
 * @param {number} [query.sinceHour] Inclusive epoch-hour lower bound.
 * @param {number} [query.limit] Most recent N rows.
 * @returns {object[]} Hourly counter rows.
 */
export function listHours(query = {}) {
  const { sinceHour, limit } = query;
  let rows = [..._hours.values()].sort((a, b) => a.hour - b.hour);
  if (Number.isFinite(sinceHour)) {
    rows = rows.filter((row) => row.hour >= sinceHour);
  }
  if (Number.isFinite(limit) && limit > 0 && rows.length > limit) {
    rows = rows.slice(rows.length - limit);
  }
  return rows;
}

/**
 * Roll hourly rows into days, for the slower view a trend is read from.
 * @param {object} [query] Same shape as {@link listHours}.
 * @returns {object[]} Daily rows, oldest first.
 */
export function listDays(query = {}) {
  const days = new Map();
  for (const row of listHours(query)) {
    const day = Math.floor(row.hour / 24);
    let entry = days.get(day);
    if (!entry) {
      entry = {
        day,
        date: new Date(day * 86_400_000).toISOString().slice(0, 10),
        outbound: 0,
        inbound: 0,
        dark: 0,
        spoofed: 0,
        queueDepth: null,
        hoursObserved: 0,
        queueHours: 0,
      };
      days.set(day, entry);
    }
    entry.outbound += row.outbound;
    entry.inbound += row.inbound;
    entry.dark += row.dark;
    entry.spoofed += row.spoofed;
    entry.hoursObserved += 1;
    if (row.queueDepth !== null) {
      const total = (entry.queueDepth ?? 0) * entry.queueHours + row.queueDepth;
      entry.queueHours += 1;
      entry.queueDepth = Number((total / entry.queueHours).toFixed(2));
    }
  }
  return [...days.values()].sort((a, b) => a.day - b.day);
}

/**
 * How much of a window was actually observed.
 *
 * Every restart leaves a hole, and a transit count read without knowing the
 * hole is there reads a quiet server as a quiet strait. Callers get this
 * alongside the counts so the two can never be separated.
 *
 * @param {number} hours Window length in hours.
 * @param {number} [nowMs] Wall-clock milliseconds.
 * @returns {{observedHours:number, windowHours:number, ratio:number}} Coverage.
 */
export function observedCoverage(hours, nowMs = Date.now()) {
  const endHour = hourOf(nowMs);
  const startHour = endHour - hours;
  let observed = 0;
  for (let hour = startHour; hour < endHour; hour += 1) {
    if (_hours.has(hour)) observed += 1;
  }
  return {
    observedHours: observed,
    windowHours: hours,
    ratio: hours > 0 ? Number((observed / hours).toFixed(3)) : 0,
  };
}

/** @returns {{hours: object[]}} Snapshot for disk persistence. */
export function exportTimeseriesState() {
  return { hours: [..._hours.values()] };
}

/**
 * Restore a snapshot from {@link exportTimeseriesState}.
 * @param {unknown} state Parsed snapshot.
 * @returns {number} Count of hourly rows restored.
 */
export function importTimeseriesState(state) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.hours)) {
    return 0;
  }
  const restored = new Map();
  for (const row of state.hours) {
    if (!row || typeof row !== 'object' || !Number.isFinite(row.hour)) continue;
    restored.set(row.hour, {
      hour: row.hour,
      outbound: Number(row.outbound) || 0,
      inbound: Number(row.inbound) || 0,
      dark: Number(row.dark) || 0,
      spoofed: Number(row.spoofed) || 0,
      queueDepth: Number.isFinite(row.queueDepth) ? row.queueDepth : null,
      queueSamples: Number(row.queueSamples) || 0,
    });
  }
  _hours = restored;
  pruneHours();
  return _hours.size;
}

/** Drop all time-series state. Tests only. */
export function resetTimeseriesState() {
  _hours = new Map();
}
