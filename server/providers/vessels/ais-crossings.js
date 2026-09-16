// Append-only log of individual gate crossings.
//
// The hourly counters in ais-timeseries.js are lossy by design: once an hour
// is `{outbound: 14}` there is no way back to which fourteen, or where exactly
// they crossed. That matters because every gate in chokepoints.js is an
// APPROXIMATION of a traffic separation scheme. If a gate turns out to be
// misplaced, or the laden/ballast thresholds turn out to be wrong, this log is
// what makes the history re-derivable instead of lost.
//
// So rows here hold the RAW reported values — draught and length as the vessel
// transmitted them — and never the interpretation. Interpretation lives in
// vessel-class.js and is applied on read.
//
// Volume is modest: a few hundred crossings a day across all chokepoints, at
// roughly 150 bytes each. The on-disk file is the archive and grows slowly;
// memory keeps a bounded recent window.

/** Rows held in memory. The file on disk keeps more. */
export const MAX_CROSSINGS = 100_000;

/** @type {object[]} Crossings, oldest first. */
let _crossings = [];
/** How many rows have already been written to disk. */
let _flushed = 0;

/**
 * Record one gate crossing.
 *
 * @param {object} crossing
 * @param {string} crossing.chokepoint Chokepoint id.
 * @param {'inbound'|'outbound'} crossing.direction Direction of travel.
 * @param {string} crossing.mmsi Vessel identity.
 * @param {number} crossing.epochSec AIS report time of the closing fix.
 * @param {number} crossing.lat Latitude at the crossing fix.
 * @param {number} crossing.lon Longitude at the crossing fix.
 * @param {unknown} [crossing.type] Raw AIS ship type.
 * @param {unknown} [crossing.draught] Reported draught, metres.
 * @param {unknown} [crossing.length] Overall length, metres.
 * @returns {object} The stored row.
 */
export function recordCrossing(crossing) {
  const row = {
    chokepoint: crossing.chokepoint,
    direction: crossing.direction,
    mmsi: String(crossing.mmsi ?? ''),
    epochSec: Number(crossing.epochSec) || 0,
    lat: Number(crossing.lat),
    lon: Number(crossing.lon),
  };
  // Optional fields are omitted rather than nulled: most rows will not carry
  // static data, and an absent key costs nothing in JSONL.
  if (crossing.type !== undefined && crossing.type !== null) {
    row.type = crossing.type;
  }
  if (Number.isFinite(Number(crossing.draught))) {
    row.draught = Number(crossing.draught);
  }
  if (Number.isFinite(Number(crossing.length))) {
    row.length = Number(crossing.length);
  }

  _crossings.push(row);
  if (_crossings.length > MAX_CROSSINGS) {
    const dropped = _crossings.length - MAX_CROSSINGS;
    _crossings = _crossings.slice(dropped);
    // Rows already on disk stay there; the counter tracks the in-memory tail.
    _flushed = Math.max(0, _flushed - dropped);
  }
  return row;
}

/**
 * Read crossings, newest first.
 * @param {object} [query]
 * @param {string} [query.chokepoint] Restrict to one chokepoint.
 * @param {string} [query.direction] `inbound` or `outbound`.
 * @param {number} [query.sinceSec] Inclusive epoch-second lower bound.
 * @param {number} [query.limit] Maximum rows returned.
 * @returns {object[]} Matching crossings.
 */
export function listCrossings(query = {}) {
  const { chokepoint, direction, sinceSec, limit } = query;
  let rows = _crossings;
  if (chokepoint) rows = rows.filter((row) => row.chokepoint === chokepoint);
  if (direction) rows = rows.filter((row) => row.direction === direction);
  if (Number.isFinite(sinceSec)) {
    rows = rows.filter((row) => row.epochSec >= sinceSec);
  }
  rows = [...rows].sort((a, b) => b.epochSec - a.epochSec);
  return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
}

/** @returns {number} Rows currently held in memory. */
export function crossingCount() {
  return _crossings.length;
}

/**
 * Rows not yet written to disk, for the append-only writer.
 * @returns {object[]} Pending rows, oldest first.
 */
export function pendingCrossings() {
  return _crossings.slice(_flushed);
}

/**
 * Mark pending rows as written.
 * @param {number} count How many rows were appended.
 */
export function markCrossingsFlushed(count) {
  _flushed = Math.min(_crossings.length, _flushed + Math.max(0, count));
}

/**
 * Adopt rows loaded from disk at startup.
 *
 * They are already on disk by definition, so the flush pointer starts at the
 * end — re-appending them would duplicate the archive.
 *
 * @param {object[]} rows Parsed rows, oldest first.
 * @returns {number} Count adopted.
 */
export function adoptCrossings(rows) {
  if (!Array.isArray(rows)) return 0;
  const usable = rows.filter(
    (row) =>
      row &&
      typeof row === 'object' &&
      typeof row.chokepoint === 'string' &&
      Number.isFinite(Number(row.lat)) &&
      Number.isFinite(Number(row.lon)),
  );
  _crossings = usable.slice(-MAX_CROSSINGS);
  _flushed = _crossings.length;
  return _crossings.length;
}

/** Drop all crossing state. Tests only. */
export function resetCrossings() {
  _crossings = [];
  _flushed = 0;
}
