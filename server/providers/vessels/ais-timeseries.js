// Durable hourly record of chokepoint activity.
//
// The vessel cache forgets everything older than 24 hours, which is right for
// rendering a globe and useless for asking whether today is busier than last
// Tuesday. This module keeps the small aggregate numbers instead of the large
// positional ones: a few counters per chokepoint per hour, kept for years.
//
// It cannot be backfilled. Whatever was not recorded as it happened is gone,
// so the retention here is deliberately generous and the row is deliberately
// tiny — two years of hours for three chokepoints is about 52,500 rows and a
// few megabytes, which costs nothing next to one extra hour of positions.
//
// A transit is a LINE CROSSING, not a presence count. Counting vessels inside
// a box conflates one ship loitering for a day with twenty ships passing
// through, and those mean opposite things. Gate geometry lives in
// chokepoints.js.

import { CHOKEPOINTS, chokepointById, insideBox } from './chokepoints.js';

/** Speed below which a vessel counts as waiting rather than under way. */
export const QUEUE_MAX_SPEED_KTS = 0.5;
/** Hours retained per chokepoint. Two years; see the note about backfilling. */
export const TIMESERIES_MAX_HOURS = 24 * 365 * 2;

/** @type {Map<string, object>} `${chokepointId}|${hour}` -> counters. */
let _rows = new Map();

function hourOf(ms) {
  return Math.floor(ms / 3_600_000);
}

function keyOf(chokepoint, hour) {
  return `${chokepoint}|${hour}`;
}

function bucket(chokepoint, atMs) {
  const hour = hourOf(atMs);
  const key = keyOf(chokepoint, hour);
  let row = _rows.get(key);
  if (!row) {
    row = {
      chokepoint,
      hour,
      outbound: 0,
      inbound: 0,
      // Tankers separated from everything else: a count mixing them with
      // bulkers, boxships and tugs is mostly noise for an oil question.
      outboundTanker: 0,
      inboundTanker: 0,
      // Laden vs ballast is the difference between oil leaving and a hull
      // repositioning. Tankers only; the concept is meaningless elsewhere.
      outboundLaden: 0,
      outboundBallast: 0,
      // Capacity-weighted outbound tankers, thousands of DWT. Ten VLCCs and
      // ten product tankers are not the same quantity of oil.
      outboundKdwt: 0,
      dark: 0,
      spoofed: 0,
      // The denominator. Transits can fall because fewer ships sailed OR
      // because we saw fewer ships, and those lead to opposite conclusions.
      // Jamming degrades reception in exactly the places that matter most.
      messages: 0,
      vessels: 0,
      // null, not 0: "never sampled" and "sampled, found nothing waiting" are
      // different facts, and a chart that renders them the same lies.
      queueDepth: null,
      queueSamples: 0,
    };
    _rows.set(key, row);
    pruneRows(chokepoint);
  }
  return row;
}

/** Prune one chokepoint's history without touching the others'. */
function pruneRows(chokepoint) {
  const mine = [..._rows.values()]
    .filter((row) => row.chokepoint === chokepoint)
    .sort((a, b) => a.hour - b.hour);
  if (mine.length <= TIMESERIES_MAX_HOURS) return;
  for (const row of mine.slice(0, mine.length - TIMESERIES_MAX_HOURS)) {
    _rows.delete(keyOf(row.chokepoint, row.hour));
  }
}

/**
 * Whether a vessel's move crossed a chokepoint's gate, and which way.
 *
 * @param {object} previous Prior stored row with `lat`/`lon`.
 * @param {object} next Incoming fix with `lat`/`lon`.
 * @param {object} chokepoint Entry from the chokepoint registry.
 * @returns {'inbound'|'outbound'|null} Direction, or null for no crossing.
 */
export function gateCrossing(previous, next, chokepoint) {
  if (!previous || !next || !chokepoint?.gate) return null;
  const { axis, line, bandMin, bandMax, enclosedDirection } = chokepoint.gate;

  const fromLat = Number(previous.lat);
  const fromLon = Number(previous.lon);
  const toLat = Number(next.lat);
  const toLon = Number(next.lon);
  if (![fromLat, fromLon, toLat, toLon].every(Number.isFinite)) return null;

  const from = axis === 'lat' ? fromLat : fromLon;
  const to = axis === 'lat' ? toLat : toLon;
  // The band is measured on the OTHER axis from the gate line.
  const fromBand = axis === 'lat' ? fromLon : fromLat;
  const toBand = axis === 'lat' ? toLon : toLat;

  // Both ends must sit in the band. Requiring both keeps a vessel that merely
  // passed the same meridian far away from being counted as a transit.
  if (fromBand < bandMin || fromBand > bandMax) return null;
  if (toBand < bandMin || toBand > bandMax) return null;

  let direction = null;
  if (from >= line && to < line) direction = 'decreasing';
  else if (from < line && to >= line) direction = 'increasing';
  if (!direction) return null;

  return direction === enclosedDirection ? 'inbound' : 'outbound';
}

/**
 * The chokepoint whose gate this move crossed, if any.
 * @param {object} previous Prior stored row.
 * @param {object} next Incoming fix.
 * @returns {{chokepoint:string, direction:string}|null} Crossing, or null.
 */
export function findGateCrossing(previous, next) {
  for (const chokepoint of Object.values(CHOKEPOINTS)) {
    const direction = gateCrossing(previous, next, chokepoint);
    if (direction) return { chokepoint: chokepoint.id, direction };
  }
  return null;
}

/**
 * Whether a vessel is waiting in a chokepoint's approaches.
 * @param {object} row Stored vessel row.
 * @param {object} chokepoint Entry from the chokepoint registry.
 * @returns {boolean} True when inside the queue box and effectively stopped.
 */
export function isQueued(row, chokepoint) {
  if (!chokepoint?.queueBox) return false;
  if (!insideBox(Number(row?.lat), Number(row?.lon), chokepoint.queueBox)) {
    return false;
  }
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
 * @param {string} chokepoint Chokepoint id.
 * @param {'inbound'|'outbound'} direction Crossing direction.
 * @param {number} [atMs] Wall-clock milliseconds.
 */
export function recordTransit(
  chokepoint,
  direction,
  atMs = Date.now(),
  detail = {},
) {
  if (direction !== 'inbound' && direction !== 'outbound') return;
  if (!chokepointById(chokepoint)) return;
  const row = bucket(chokepoint, atMs);
  row[direction] += 1;

  if (!detail.tanker) return;
  row[direction === 'outbound' ? 'outboundTanker' : 'inboundTanker'] += 1;
  if (direction !== 'outbound') return;
  if (detail.laden === 'laden') row.outboundLaden += 1;
  else if (detail.laden === 'ballast') row.outboundBallast += 1;
  if (Number.isFinite(detail.kdwt)) row.outboundKdwt += detail.kdwt;
}

/**
 * Record that the feed delivered a positioned message inside a chokepoint's
 * region, and how many distinct vessels have been seen there this hour.
 *
 * @param {string} chokepoint Chokepoint id.
 * @param {number} distinctVessels Distinct MMSIs seen in region this hour.
 * @param {number} [atMs] Wall-clock milliseconds.
 */
export function recordRegionObservation(
  chokepoint,
  distinctVessels,
  atMs = Date.now(),
) {
  if (!chokepointById(chokepoint)) return;
  const row = bucket(chokepoint, atMs);
  row.messages += 1;
  if (Number.isFinite(distinctVessels)) row.vessels = distinctVessels;
}

/**
 * Count one classified gap event against the chokepoint it happened in.
 * @param {string} chokepoint Chokepoint id.
 * @param {string} classification `dark` or `spoofed`.
 * @param {number} [atMs] Wall-clock milliseconds.
 */
export function recordGapForHour(
  chokepoint,
  classification,
  atMs = Date.now(),
) {
  if (!chokepointById(chokepoint)) return;
  const row = bucket(chokepoint, atMs);
  if (classification === 'spoofed') row.spoofed += 1;
  else row.dark += 1;
}

/**
 * Record a queue-depth observation. Averaged across samples within the hour so
 * a sampling-rate change does not look like a change in the water.
 * @param {string} chokepoint Chokepoint id.
 * @param {number} depth Vessels counted waiting.
 * @param {number} [atMs] Wall-clock milliseconds.
 */
export function recordQueueDepth(chokepoint, depth, atMs = Date.now()) {
  if (!Number.isFinite(depth) || !chokepointById(chokepoint)) return;
  const row = bucket(chokepoint, atMs);
  const total = (row.queueDepth ?? 0) * row.queueSamples + depth;
  row.queueSamples += 1;
  row.queueDepth = Number((total / row.queueSamples).toFixed(2));
}

/**
 * Read hourly rows, oldest first.
 * @param {object} [query]
 * @param {string} [query.chokepoint] Restrict to one chokepoint.
 * @param {number} [query.sinceHour] Inclusive epoch-hour lower bound.
 * @param {number} [query.limit] Most recent N rows.
 * @returns {object[]} Hourly counter rows.
 */
export function listHours(query = {}) {
  const { chokepoint, sinceHour, limit } = query;
  let rows = [..._rows.values()];
  if (chokepoint) rows = rows.filter((row) => row.chokepoint === chokepoint);
  if (Number.isFinite(sinceHour)) {
    rows = rows.filter((row) => row.hour >= sinceHour);
  }
  rows.sort((a, b) =>
    a.hour === b.hour
      ? a.chokepoint.localeCompare(b.chokepoint)
      : a.hour - b.hour,
  );
  if (Number.isFinite(limit) && limit > 0 && rows.length > limit) {
    rows = rows.slice(rows.length - limit);
  }
  return rows;
}

/**
 * Roll hourly rows into days, per chokepoint, for the slower view a trend is
 * read from.
 * @param {object} [query] Same shape as {@link listHours}.
 * @returns {object[]} Daily rows, oldest first.
 */
export function listDays(query = {}) {
  const days = new Map();
  for (const row of listHours(query)) {
    const day = Math.floor(row.hour / 24);
    const key = `${row.chokepoint}|${day}`;
    let entry = days.get(key);
    if (!entry) {
      entry = {
        chokepoint: row.chokepoint,
        day,
        date: new Date(day * 86_400_000).toISOString().slice(0, 10),
        outbound: 0,
        inbound: 0,
        outboundTanker: 0,
        inboundTanker: 0,
        outboundLaden: 0,
        outboundBallast: 0,
        outboundKdwt: 0,
        dark: 0,
        spoofed: 0,
        messages: 0,
        vessels: 0,
        queueDepth: null,
        hoursObserved: 0,
        queueHours: 0,
      };
      days.set(key, entry);
    }
    for (const field of [
      'outbound',
      'inbound',
      'outboundTanker',
      'inboundTanker',
      'outboundLaden',
      'outboundBallast',
      'outboundKdwt',
      'dark',
      'spoofed',
      'messages',
    ]) {
      entry[field] += row[field] || 0;
    }
    // Distinct vessels do not sum across hours — the same ship recurs. The
    // busiest hour is the honest floor for the day.
    entry.vessels = Math.max(entry.vessels, row.vessels || 0);
    entry.hoursObserved += 1;
    if (row.queueDepth !== null) {
      const total = (entry.queueDepth ?? 0) * entry.queueHours + row.queueDepth;
      entry.queueHours += 1;
      entry.queueDepth = Number((total / entry.queueHours).toFixed(2));
    }
  }
  return [...days.values()].sort((a, b) =>
    a.day === b.day ? a.chokepoint.localeCompare(b.chokepoint) : a.day - b.day,
  );
}

/**
 * How much of a window was actually observed.
 *
 * Every restart leaves a hole, and a transit count read without knowing the
 * hole is there reads a quiet server as a quiet strait. Callers get this
 * alongside the counts so the two can never be separated.
 *
 * @param {number} hours Window length in hours.
 * @param {object} [options]
 * @param {string} [options.chokepoint] Restrict to one chokepoint.
 * @param {number} [options.nowMs] Wall-clock milliseconds.
 * @returns {{observedHours:number, windowHours:number, ratio:number}} Coverage.
 */
export function observedCoverage(hours, options = {}) {
  const { chokepoint, nowMs = Date.now() } = options;
  // Any chokepoint recording proves the server was up; without a specific one
  // asked for, presence anywhere counts as an observed hour.
  const ids = chokepoint ? [chokepoint] : Object.keys(CHOKEPOINTS);
  const endHour = hourOf(nowMs);
  const startHour = endHour - hours;
  let observed = 0;
  for (let hour = startHour; hour < endHour; hour += 1) {
    if (ids.some((id) => _rows.has(keyOf(id, hour)))) observed += 1;
  }
  return {
    observedHours: observed,
    windowHours: hours,
    ratio: hours > 0 ? Number((observed / hours).toFixed(3)) : 0,
  };
}

/** @returns {{hours: object[]}} Snapshot for disk persistence. */
export function exportTimeseriesState() {
  return { hours: [..._rows.values()] };
}

/**
 * Restore a snapshot from {@link exportTimeseriesState}.
 *
 * Rows written before this record covered more than one chokepoint carry no
 * `chokepoint` and are Hormuz by construction, so they are adopted rather than
 * discarded — the whole point of this file is that history cannot be rebuilt.
 *
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
    const chokepoint = row.chokepoint || 'hormuz';
    if (!chokepointById(chokepoint)) continue;
    restored.set(keyOf(chokepoint, row.hour), {
      chokepoint,
      hour: row.hour,
      outbound: Number(row.outbound) || 0,
      inbound: Number(row.inbound) || 0,
      outboundTanker: Number(row.outboundTanker) || 0,
      inboundTanker: Number(row.inboundTanker) || 0,
      outboundLaden: Number(row.outboundLaden) || 0,
      outboundBallast: Number(row.outboundBallast) || 0,
      outboundKdwt: Number(row.outboundKdwt) || 0,
      dark: Number(row.dark) || 0,
      spoofed: Number(row.spoofed) || 0,
      messages: Number(row.messages) || 0,
      vessels: Number(row.vessels) || 0,
      queueDepth: Number.isFinite(row.queueDepth) ? row.queueDepth : null,
      queueSamples: Number(row.queueSamples) || 0,
    });
  }
  _rows = restored;
  for (const id of Object.keys(CHOKEPOINTS)) pruneRows(id);
  return _rows.size;
}

/** Drop all time-series state. Tests only. */
export function resetTimeseriesState() {
  _rows = new Map();
}
