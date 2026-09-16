// Gate crossing detection, with hysteresis.
//
// The naive test — two consecutive fixes on opposite sides of a line — has a
// flaw that only shows up in real data: a vessel anchored near the line, or
// one whose position jitters under GNSS interference, flips sides repeatedly
// and manufactures dozens of transits that never happened. In the Gulf, where
// spoofing is routine, that is not a rare edge case.
//
// So a crossing requires the vessel to be DEFINITIVELY on one side and then
// DEFINITIVELY on the other: past the line by a margin, not merely across it.
// Positions inside the margin leave the remembered side untouched.
//
// State is per vessel per chokepoint and bounded — a collector that runs for
// months must not accumulate a row for every hull that ever passed.

import { CHOKEPOINTS } from './chokepoints.js';

/**
 * Margin either side of the gate line, in degrees, that a vessel must clear
 * before its side is considered settled. ~0.02deg is roughly 2 km — wider than
 * GNSS noise and anchor swing, narrower than a transit.
 */
export const DEFAULT_HYSTERESIS_DEG = 0.02;
/** Vessels not seen for this long are forgotten. */
export const STATE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard cap on tracked vessels, oldest evicted first. */
export const MAX_TRACKED = 50_000;

/**
 * Which side of a gate a position sits on, or null inside the margin.
 * @param {object} gate Gate definition.
 * @param {number} lat Latitude.
 * @param {number} lon Longitude.
 * @param {number} band Hysteresis margin in degrees.
 * @returns {'low'|'high'|null} Settled side, or null when undecided.
 */
export function gateSide(gate, lat, lon, band) {
  const along = gate.axis === 'lat' ? lat : lon;
  const across = gate.axis === 'lat' ? lon : lat;
  // Outside the lane band the vessel is not at this gate at all. Returning
  // null here also means a hull that wanders out and back cannot be credited
  // with a transit it was never observed making.
  if (across < gate.bandMin || across > gate.bandMax) return null;
  if (along >= gate.line + band) return 'high';
  if (along <= gate.line - band) return 'low';
  return null;
}

/**
 * Create a stateful transit detector.
 *
 * @param {object} [options]
 * @param {number} [options.band] Hysteresis margin in degrees.
 * @param {object} [options.chokepoints] Registry to use; defaults to all.
 * @returns {object} Detector with `observe`, `size` and `prune`.
 */
export function createTransitDetector(options = {}) {
  const { band = DEFAULT_HYSTERESIS_DEG, chokepoints = CHOKEPOINTS } = options;
  const gates = Object.values(chokepoints);
  /** @type {Map<string, {at:number, sides:Record<string,string>}>} */
  const tracked = new Map();

  function prune(nowMs) {
    const cutoff = nowMs - STATE_TTL_MS;
    for (const [mmsi, entry] of tracked) {
      if (entry.at < cutoff) tracked.delete(mmsi);
    }
    if (tracked.size <= MAX_TRACKED) return;
    // Map iteration is insertion-ordered, and every observation re-inserts,
    // so the front of the map is the least recently seen.
    const excess = tracked.size - MAX_TRACKED;
    let dropped = 0;
    for (const mmsi of tracked.keys()) {
      if (dropped++ >= excess) break;
      tracked.delete(mmsi);
    }
  }

  return {
    /**
     * Feed one position fix.
     *
     * @param {string} mmsi Vessel identity.
     * @param {number} lat Latitude.
     * @param {number} lon Longitude.
     * @param {number} [nowMs] Wall clock, for state ageing only.
     * @returns {Array<{chokepoint:string, direction:'inbound'|'outbound'}>}
     *   Crossings completed by this fix. Usually empty.
     */
    observe(mmsi, lat, lon, nowMs = Date.now()) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];

      let entry = tracked.get(mmsi);
      if (entry) tracked.delete(mmsi);
      else entry = { at: nowMs, sides: {} };
      entry.at = nowMs;
      tracked.set(mmsi, entry);

      const crossings = [];
      for (const chokepoint of gates) {
        const side = gateSide(chokepoint.gate, lat, lon, band);
        if (!side) continue;
        const previous = entry.sides[chokepoint.id];
        entry.sides[chokepoint.id] = side;
        if (!previous || previous === side) continue;

        const movement = previous === 'low' ? 'increasing' : 'decreasing';
        crossings.push({
          chokepoint: chokepoint.id,
          direction:
            movement === chokepoint.gate.enclosedDirection
              ? 'inbound'
              : 'outbound',
        });
      }

      if (tracked.size > MAX_TRACKED || tracked.size % 5000 === 0) {
        prune(nowMs);
      }
      return crossings;
    },

    /** @returns {number} Vessels currently tracked. */
    size() {
      return tracked.size;
    },

    /** @param {number} [nowMs] Wall clock. */
    prune(nowMs = Date.now()) {
      prune(nowMs);
    },
  };
}
