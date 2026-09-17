// Turning an AIS stream into rows.
//
// Everything stateful about collection lives here, and all of it is bounded:
// a collector is supposed to run for months, so any map that can grow with the
// world's shipping needs an eviction rule at the moment it is introduced, not
// after the first out-of-memory restart.
//
// Writes are accumulated and drained on a timer rather than issued per
// message. A busy feed delivers thousands of messages a minute and almost none
// of them are a transit; one INSERT per message would spend the database on
// nothing.

import {
  CHOKEPOINTS,
  distanceToGateKm,
  insideBox,
} from './domain/chokepoints.js';
import { createTransitDetector } from './domain/transits.js';
import { createFeedActivity, evaluateGap } from './domain/gaps.js';

/** Vessels not seen for this long are forgotten. */
const FIX_TTL_MS = 26 * 60 * 60 * 1000;
/** Hard cap on remembered last-fixes. */
const MAX_FIXES = 60_000;
/**
 * Static reports (type, draught, dimensions) are far rarer than position
 * reports, so this table is what lets a crossing be enriched at all. It is
 * also the unbounded-growth trap: keep it too long and it becomes the largest
 * thing in the process. Bounded by both age and size.
 */
const STATIC_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_STATIC = 60_000;
/**
 * How close a received vessel must be to a gate to count as covering it.
 * Generous on purpose: this is asking whether the feed reaches the strait at
 * all, not whether a particular hull was about to transit.
 */
const NEAR_GATE_KM = 50;

function pruneMap(map, ttlMs, maxSize, nowMs, stamp) {
  const cutoff = nowMs - ttlMs;
  for (const [key, value] of map) {
    if (stamp(value) < cutoff) map.delete(key);
  }
  if (map.size <= maxSize) return;
  const excess = map.size - maxSize;
  let dropped = 0;
  for (const key of map.keys()) {
    if (dropped++ >= excess) break;
    map.delete(key);
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Overall length from the AIS dimension quartet: distances to bow and stern.
 * @param {object} dimension `{A, B, C, D}`.
 * @returns {number|null} Metres, or null when unusable.
 */
export function lengthFromDimension(dimension) {
  if (!dimension || typeof dimension !== 'object') return null;
  const bow = Number(dimension.A);
  const stern = Number(dimension.B);
  if (!Number.isFinite(bow) || !Number.isFinite(stern)) return null;
  const length = bow + stern;
  // Zero means the field was never filled in; 500 m is longer than any hull.
  if (length <= 0 || length > 500) return null;
  return length;
}

/**
 * Parse an AISStream envelope into the few fields collection needs.
 * @param {object} envelope Raw envelope.
 * @returns {object|null} Normalised record, or null when unusable.
 */
export function parseEnvelope(envelope) {
  const messageType = envelope?.MessageType;
  if (!messageType) return null;
  const message = envelope?.Message?.[messageType] || {};
  const metadata = envelope?.MetaData || envelope?.Metadata || {};

  const mmsi = String(
    metadata.MMSI ?? message.UserID ?? message.UserId ?? message.Mmsi ?? '',
  ).trim();
  if (!mmsi) return null;

  const isStatic =
    messageType === 'ShipStaticData' || messageType === 'StaticDataReport';

  const lat = numberOrNull(metadata.latitude ?? metadata.Latitude ?? message.Latitude);
  const lon = numberOrNull(metadata.longitude ?? metadata.Longitude ?? message.Longitude);

  const rawTime = metadata.time_utc ?? metadata.TimeUtc;
  const parsed = rawTime
    ? new Date(String(rawTime).replace(' +0000 UTC', 'Z').replace(' UTC', 'Z'))
    : null;
  const epochSec =
    parsed && !Number.isNaN(parsed.getTime())
      ? Math.floor(parsed.getTime() / 1000)
      : null;

  return {
    mmsi,
    isStatic,
    lat,
    lon,
    epochSec,
    speed: numberOrNull(message.Sog ?? message.SOG),
    shipType:
      message.Type ?? message.ShipType ?? message.ReportB?.ShipType ?? null,
    draught: numberOrNull(
      message.MaximumStaticDraught ?? message.Draught ?? message.draught,
    ),
    length: lengthFromDimension(message.Dimension),
  };
}

/**
 * Create the ingest pipeline.
 *
 * @param {object} [options]
 * @param {string} [options.rulesVersion] Stamped onto every raw row.
 * @param {number} [options.queueMaxSpeedKts] Speed below which a vessel waits.
 * @returns {object} Pipeline with `handle`, `drain` and `stats`.
 */
export function createIngest(options = {}) {
  const { rulesVersion = 'r1', queueMaxSpeedKts = 0.5 } = options;

  const detector = createTransitDetector();
  const activity = createFeedActivity();
  /** @type {Map<string, object>} mmsi -> last position fix. */
  const fixes = new Map();
  /** @type {Map<string, object>} mmsi -> last static report. */
  const statics = new Map();

  let pendingCrossings = [];
  let pendingGaps = [];
  /** @type {Map<string, object>} `${chokepoint}|${hourIso}` -> counters. */
  let regionHours = new Map();
  /** @type {Map<string, object>} hourIso -> service liveness. */
  let serviceHours = new Map();
  /** @type {Map<string, Set<string>>} `${chokepoint}|${hourIso}` -> MMSIs. */
  const regionSeen = new Map();
  let queueSampledHour = -1;

  function hourIso(nowMs) {
    return new Date(Math.floor(nowMs / 3_600_000) * 3_600_000).toISOString();
  }

  function noteService(nowMs) {
    const hour = hourIso(nowMs);
    let row = serviceHours.get(hour);
    if (!row) {
      row = { hour, messages: 0, firstSeen: new Date(nowMs), lastSeen: new Date(nowMs) };
      serviceHours.set(hour, row);
    }
    row.messages += 1;
    row.lastSeen = new Date(nowMs);
  }

  function regionBucket(chokepointId, nowMs) {
    const key = `${chokepointId}|${hourIso(nowMs)}`;
    let row = regionHours.get(key);
    if (!row) {
      row = {
        chokepoint: chokepointId,
        hour: hourIso(nowMs),
        messages: 0,
        vessels: 0,
        queueDepth: null,
        queueSamples: 0,
      };
      regionHours.set(key, row);
    }
    return row;
  }

  /**
   * Sweep for waiting vessels, at most once an hour.
   *
   * Sampling from the ingest path rather than a timer means the sweep only
   * happens while the feed is delivering, so an hour with no data records no
   * queue reading — which is the honest result rather than a zero.
   */
  function sampleQueues(nowMs) {
    const hour = Math.floor(nowMs / 3_600_000);
    if (hour === queueSampledHour) return;
    queueSampledHour = hour;

    const counts = new Map();
    for (const chokepoint of Object.values(CHOKEPOINTS)) counts.set(chokepoint, 0);
    for (const fix of fixes.values()) {
      // A missing speed is not a stopped vessel. Counting unknowns as waiting
      // would inflate the queue hardest when the feed is degraded, which is
      // exactly when the number gets over-read.
      if (fix.speed === null || fix.speed === undefined) continue;
      if (fix.speed > queueMaxSpeedKts) continue;
      for (const chokepoint of counts.keys()) {
        if (insideBox(fix.lat, fix.lon, chokepoint.queueBox)) {
          counts.set(chokepoint, counts.get(chokepoint) + 1);
        }
      }
    }
    for (const [chokepoint, count] of counts) {
      if (!chokepoint.queueBox) continue;
      const row = regionBucket(chokepoint.id, nowMs);
      const total = (row.queueDepth ?? 0) * row.queueSamples + count;
      row.queueSamples += 1;
      row.queueDepth = Number((total / row.queueSamples).toFixed(2));
    }
  }

  return {
    /**
     * Feed one raw envelope.
     * @param {object} envelope AISStream envelope.
     * @param {number} [nowMs] Wall-clock milliseconds.
     * @returns {boolean} True when the envelope carried a usable AIS record.
     */
    handle(envelope, nowMs = Date.now()) {
      const record = parseEnvelope(envelope);
      if (!record) return false;

      activity.mark(nowMs);
      noteService(nowMs);

      if (record.isStatic) {
        statics.set(record.mmsi, {
          shipType: record.shipType,
          // Draught changes between voyages, so a fresher report always wins.
          draught: record.draught,
          length: record.length ?? statics.get(record.mmsi)?.length ?? null,
          at: nowMs,
        });
        pruneMap(statics, STATIC_TTL_MS, MAX_STATIC, nowMs, (v) => v.at);
        // Static reports carry no position, but they are still the feed
        // delivering, which is what gap attribution depends on.
        return true;
      }

      if (record.lat === null || record.lon === null) return true;

      const previous = fixes.get(record.mmsi);
      const next = {
        mmsi: record.mmsi,
        lat: record.lat,
        lon: record.lon,
        epochSec: record.epochSec ?? Math.floor(nowMs / 1000),
        speed: record.speed,
        seenAtMs: nowMs,
      };

      const gap = evaluateGap(previous, next, activity, { nowMs });
      if (gap) {
        pendingGaps.push({
          ...gap,
          chokepoint: chokepointForPoint(gap.endLat, gap.endLon)
            ?? chokepointForPoint(gap.startLat, gap.startLon),
          rulesVersion,
        });
      }

      const staticData = statics.get(record.mmsi) || {};
      for (const crossing of detector.observe(record.mmsi, record.lat, record.lon, nowMs)) {
        pendingCrossings.push({
          chokepoint: crossing.chokepoint,
          direction: crossing.direction,
          mmsi: record.mmsi,
          observedAt: new Date(next.epochSec * 1000),
          lat: record.lat,
          lon: record.lon,
          shipType:
            staticData.shipType === null || staticData.shipType === undefined
              ? null
              : String(staticData.shipType),
          draughtM: staticData.draught ?? null,
          lengthM: staticData.length ?? null,
          rulesVersion,
        });
      }

      for (const chokepoint of Object.values(CHOKEPOINTS)) {
        if (!insideBox(record.lat, record.lon, chokepoint.region)) continue;
        const key = `${chokepoint.id}|${hourIso(nowMs)}`;
        let seen = regionSeen.get(key);
        if (!seen) {
          seen = new Set();
          regionSeen.set(key, seen);
          // Only the current hour's rosters are useful; older ones have
          // already been drained into a row.
          for (const existing of regionSeen.keys()) {
            if (!existing.endsWith(hourIso(nowMs))) regionSeen.delete(existing);
          }
        }
        seen.add(record.mmsi);
        const row = regionBucket(chokepoint.id, nowMs);
        row.messages += 1;
        row.vessels = seen.size;
      }

      fixes.set(record.mmsi, next);
      if (fixes.size > MAX_FIXES || fixes.size % 5000 === 0) {
        pruneMap(fixes, FIX_TTL_MS, MAX_FIXES, nowMs, (v) => v.seenAtMs);
      }
      sampleQueues(nowMs);
      return true;
    },

    /**
     * Take everything accumulated since the last drain.
     * @returns {{crossings:object[], gaps:object[], regionHours:object[], serviceHours:object[]}}
     */
    drain() {
      const out = {
        crossings: pendingCrossings,
        gaps: pendingGaps,
        regionHours: [...regionHours.values()],
        serviceHours: [...serviceHours.values()],
      };
      pendingCrossings = [];
      pendingGaps = [];
      // Hour rows are upserted cumulatively, so they are rebuilt from the
      // live rosters rather than carried forward with stale totals.
      regionHours = new Map();
      serviceHours = new Map();
      return out;
    },

    /**
     * Where the feed is actually delivering, per chokepoint.
     *
     * The hourly counts answer "how many", and a zero there has two completely
     * different causes that lead to opposite trades: no ships, or no reception.
     * `messages` and `vessels` separate those at the REGION level, but a region
     * is large and a gate is a line across one strait. A healthy vessel count
     * for the whole Black Sea says nothing about whether anything was received
     * near Istanbul.
     *
     * So this reports the distance from the nearest received vessel to each
     * gate, and how many vessels the detector has settled on each side of it.
     * Those two numbers distinguish every way a gate can read zero, and none of
     * them can be told apart from the counts alone.
     *
     * Read from live memory rather than the database: it describes what is
     * arriving now, which is the question being asked when a count looks wrong.
     *
     * @param {number} [nowMs] Wall clock, for reporting only.
     * @returns {object} Per-chokepoint coverage picture plus a verdict each.
     */
    diagnostics(nowMs = Date.now()) {
      const sides = detector.sideCounts();
      const slots = Object.values(CHOKEPOINTS).map((chokepoint) => ({
        chokepoint,
        received: 0,
        nearestGateKm: null,
        nearGate: 0,
        inQueueBox: 0,
        box: null,
      }));

      // One walk of the fix table testing every chokepoint per row, rather
      // than one walk per chokepoint.
      for (const fix of fixes.values()) {
        for (const slot of slots) {
          const { region, gate, queueBox } = slot.chokepoint;
          if (!insideBox(fix.lat, fix.lon, region)) continue;
          slot.received += 1;
          slot.box = slot.box
            ? {
                minLat: Math.min(slot.box.minLat, fix.lat),
                maxLat: Math.max(slot.box.maxLat, fix.lat),
                minLon: Math.min(slot.box.minLon, fix.lon),
                maxLon: Math.max(slot.box.maxLon, fix.lon),
              }
            : { minLat: fix.lat, maxLat: fix.lat, minLon: fix.lon, maxLon: fix.lon };

          const km = distanceToGateKm(gate, fix.lat, fix.lon);
          if (km !== null) {
            if (slot.nearestGateKm === null || km < slot.nearestGateKm) {
              slot.nearestGateKm = km;
            }
            if (km <= NEAR_GATE_KM) slot.nearGate += 1;
          }
          if (insideBox(fix.lat, fix.lon, queueBox)) slot.inQueueBox += 1;
        }
      }

      const round = (value, places) =>
        value === null ? null : Number(value.toFixed(places));

      return {
        at: new Date(nowMs).toISOString(),
        nearGateKm: NEAR_GATE_KM,
        rememberedFixes: fixes.size,
        chokepoints: slots.map((slot) => {
          const { id, name } = slot.chokepoint;
          const side = sides[id] || { low: 0, high: 0 };
          const settled = side.low + side.high;
          return {
            id,
            name,
            received: slot.received,
            nearestGateKm: round(slot.nearestGateKm, 1),
            nearGate: slot.nearGate,
            settledLow: side.low,
            settledHigh: side.high,
            inQueueBox: slot.inQueueBox,
            observedBox: slot.box
              ? {
                  minLat: round(slot.box.minLat, 2),
                  maxLat: round(slot.box.maxLat, 2),
                  minLon: round(slot.box.minLon, 2),
                  maxLon: round(slot.box.maxLon, 2),
                }
              : null,
            verdict:
              slot.received === 0
                ? 'NO COVERAGE — nothing received anywhere in this region'
                : slot.nearGate === 0
                  ? `COVERAGE OFF-GATE — ${slot.received} vessel(s) in the region, nearest ${round(slot.nearestGateKm, 0)} km from the gate`
                  : settled === 0
                    ? `AT GATE — ${slot.nearGate} vessel(s) within ${NEAR_GATE_KM} km, none yet past the hysteresis margin`
                    : side.low === 0 || side.high === 0
                      ? `ONE-SIDED — vessels settle only ${side.low ? 'low' : 'high'} of the gate; a crossing needs both`
                      : `HEALTHY — ${side.low} low / ${side.high} high; crossings should accrue`,
          };
        }),
      };
    },

    /** @returns {object} Sizes of every bounded structure, for /health. */
    stats() {
      return {
        trackedVessels: detector.size(),
        rememberedFixes: fixes.size,
        staticRecords: statics.size,
        pendingCrossings: pendingCrossings.length,
        pendingGaps: pendingGaps.length,
      };
    },
  };
}

/**
 * Which chokepoint's water a point falls in.
 * @param {number} lat Latitude.
 * @param {number} lon Longitude.
 * @returns {string|null} Chokepoint id, or null when outside all of them.
 */
export function chokepointForPoint(lat, lon) {
  for (const chokepoint of Object.values(CHOKEPOINTS)) {
    if (insideBox(lat, lon, chokepoint.region)) return chokepoint.id;
  }
  return null;
}
