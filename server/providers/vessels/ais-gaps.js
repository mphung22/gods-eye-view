// AIS gap ("dark vessel") detection.
//
// A vessel that stops broadcasting is the signal, not the absence of one. This
// module turns each silence into a recorded event: where it began, where the
// vessel came back, how far it moved while dark, and what speed that implies.
//
// The hard part is not finding silences — it is refusing to report the ones
// that are OUR fault. Two clocks are used deliberately, and they are not
// interchangeable:
//
//   AIS report epochs   measure the silence as the VESSEL reported it, so the
//                       duration is a property of the vessel, not of our
//                       polling, buffering or restart schedule.
//
//   Wall-clock ingest   proves the FEED was delivering during that window. If
//                       AISStream was down, or this process was restarted, we
//                       have no evidence the vessel went dark at all.
//
// Without that second clock every restart would republish the entire cache as
// "dark vessels", because each restored row's next fix is hours newer than the
// one persisted before the restart. A silence we could not have observed is
// not a finding, and this module will not report it.
//
// Everything here is bounded on purpose. The service runs on a 512MB Render
// Starter instance that already trips its memory limit (see CLAUDE.md), so the
// activity ring is 6KB flat and the event log is capped and age-pruned.

/** Silence, in AIS report time, before a vessel is considered to have gone dark. */
export const AIS_GAP_MIN_SEC = 3600;
/**
 * Straight-line speed above which a gap cannot describe a real voyage.
 *
 * The straight line between two fixes is the SHORTEST path the vessel could
 * have taken, so the implied speed is a LOWER bound on how fast it actually
 * moved. That asymmetry is what makes this test strong: exceeding the bound is
 * positive evidence that at least one endpoint is fabricated, not merely that
 * the vessel was quick. A laden VLCC runs 12-16 kts and the fastest commercial
 * traffic is in the mid-20s, so 30 leaves real headroom above every legitimate
 * hull before anything is called a spoof.
 *
 * Note the other reading of the same evidence: two vessels transmitting the
 * same MMSI produce identical arithmetic. Both are identity falsification, and
 * neither is a dark transit, which is why one classification covers them.
 */
export const AIS_MAX_PLAUSIBLE_KTS = 30;

/** How a recorded gap is classified. */
export const AIS_GAP_CLASSES = Object.freeze({
  /** A plausible silence: the vessel could physically have made the trip. */
  dark: 'dark',
  /** Physically impossible: a fabricated position, jamming artefact or shared MMSI. */
  spoofed: 'spoofed',
});
/**
 * Share of the wall-clock window that must show feed activity before a silence
 * is attributed to the vessel. Below this it is our outage, not their silence.
 */
export const AIS_GAP_MIN_FEED_COVERAGE = 0.8;
/** Hard cap on retained events. Oldest are dropped first. */
export const AIS_GAP_MAX_EVENTS = 2000;
/** Age at which an event is pruned; matches the vessel cache's staleness window. */
export const AIS_GAP_RETENTION_SEC = 24 * 60 * 60;
/** Minute buckets in the feed-activity ring. Longer than retention on purpose. */
const ACTIVITY_MINUTES = 25 * 60;

/** Named regions, so a caller can ask for a chokepoint by name. */
export const AIS_GAP_REGIONS = Object.freeze({
  // The strait plus its approaches: Gulf of Oman through to the lower Persian
  // Gulf. Wide enough to catch a vessel that goes dark before the transit and
  // reappears after it, which is the behaviour of interest.
  hormuz: Object.freeze({
    name: 'Strait of Hormuz',
    minLat: 24.0,
    maxLat: 27.6,
    minLon: 53.8,
    maxLon: 58.8,
  }),
});

/** @type {Uint32Array} Minute bucket -> epoch minute it last recorded. */
let _activityRing = new Uint32Array(ACTIVITY_MINUTES);
/** @type {object[]} Recorded gap events, oldest first. */
let _gapEvents = [];

/**
 * Note that the feed delivered a message. Called on every recognised envelope,
 * so it must stay O(1) and allocation-free.
 * @param {number} [nowMs] Wall-clock milliseconds.
 */
export function recordAisFeedActivity(nowMs = Date.now()) {
  const minute = Math.floor(nowMs / 60_000);
  _activityRing[minute % ACTIVITY_MINUTES] = minute;
}

/**
 * How much of a wall-clock window the feed was demonstrably alive for.
 *
 * A minute counts when the ring still holds that exact epoch minute; a bucket
 * overwritten by a later minute proves nothing about the older one.
 *
 * @param {number} startMs Window start, wall-clock milliseconds.
 * @param {number} endMs Window end, wall-clock milliseconds.
 * @returns {{covered:number, total:number, ratio:number}} Ratio is 0 for an
 *   empty or inverted window — absence of evidence, never evidence of absence.
 */
export function aisFeedCoverage(startMs, endMs) {
  const startMinute = Math.floor(startMs / 60_000);
  const endMinute = Math.floor(endMs / 60_000);
  const total = endMinute - startMinute;
  if (!Number.isFinite(total) || total <= 0) {
    return { covered: 0, total: 0, ratio: 0 };
  }

  // Only the most recent ACTIVITY_MINUTES are knowable. A window older than
  // the ring cannot be judged, so it scores zero rather than guessing.
  let covered = 0;
  const oldestKnowable = endMinute - ACTIVITY_MINUTES;
  for (let minute = startMinute; minute < endMinute; minute += 1) {
    if (minute <= oldestKnowable) continue;
    if (
      _activityRing[
        ((minute % ACTIVITY_MINUTES) + ACTIVITY_MINUTES) % ACTIVITY_MINUTES
      ] === minute
    ) {
      covered += 1;
    }
  }
  return { covered, total, ratio: covered / total };
}

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance in kilometres.
 * @param {number} lat1 Start latitude, degrees.
 * @param {number} lon1 Start longitude, degrees.
 * @param {number} lat2 End latitude, degrees.
 * @param {number} lon2 End longitude, degrees.
 * @returns {number} Distance in kilometres.
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Decide whether a vessel's new fix closes a gap worth recording.
 *
 * @param {object} previous The row this fix replaces, as stored by the cache.
 * @param {object} next Incoming fix: `{lat, lon, last_position_epoch}`.
 * @param {object} [options]
 * @param {number} [options.nowMs] Wall-clock milliseconds.
 * @param {number} [options.minSec] Minimum silence to qualify.
 * @param {number} [options.minCoverage] Minimum proven feed coverage.
 * @returns {object|null} A gap event, or null when this is not a reportable gap.
 */
export function evaluateAisGap(previous, next, options = {}) {
  const {
    nowMs = Date.now(),
    minSec = gapMinSeconds(),
    minCoverage = AIS_GAP_MIN_FEED_COVERAGE,
  } = options;

  if (!previous || !next) return null;

  const startEpoch = Number(previous.last_position_epoch);
  const endEpoch = Number(next.last_position_epoch);
  if (!Number.isFinite(startEpoch) || !Number.isFinite(endEpoch)) return null;

  // Out-of-order and duplicate frames are normal on a multiplexed feed. Only a
  // strictly forward jump can be a silence.
  const durationSec = endEpoch - startEpoch;
  if (durationSec < minSec) return null;

  const startLat = Number(previous.lat);
  const startLon = Number(previous.lon);
  const endLat = Number(next.lat);
  const endLon = Number(next.lon);
  if (
    !Number.isFinite(startLat) ||
    !Number.isFinite(startLon) ||
    !Number.isFinite(endLat) ||
    !Number.isFinite(endLon)
  ) {
    return null;
  }

  // The feed-liveness window is wall clock, because that is the only clock
  // that describes OUR uptime. `_updatedAt` is when we last stored this
  // vessel; a restart leaves it far in the past with no ring coverage behind
  // it, which is exactly the case this test exists to reject.
  const observedFromMs = Number(previous._updatedAt);
  const coverage = Number.isFinite(observedFromMs)
    ? aisFeedCoverage(observedFromMs, nowMs)
    : { covered: 0, total: 0, ratio: 0 };
  if (coverage.ratio < minCoverage) return null;

  const distanceKm = haversineKm(startLat, startLon, endLat, endLon);
  const hours = durationSec / 3600;
  const impliedSpeedKts =
    hours > 0 ? Number((distanceKm / 1.852 / hours).toFixed(2)) : 0;

  return {
    mmsi: String(previous.mmsi ?? next.mmsi ?? ''),
    name: String(next.name || previous.name || ''),
    type: String(next.type || previous.type || ''),
    startEpochSec: startEpoch,
    endEpochSec: endEpoch,
    durationSec,
    startLat,
    startLon,
    endLat,
    endLon,
    distanceKm: Number(distanceKm.toFixed(2)),
    // Nautical miles per hour over the straight line between the two fixes.
    // A vessel that reappears implausibly far away spent the silence moving;
    // one that reappears where it vanished was loitering or at anchor.
    impliedSpeedKts,
    // Separating these matters for reading the data: dark transits count
    // vessels choosing not to be seen, spoofs count the electronic warfare
    // around them. Summing the two would measure neither.
    classification:
      impliedSpeedKts > AIS_MAX_PLAUSIBLE_KTS
        ? AIS_GAP_CLASSES.spoofed
        : AIS_GAP_CLASSES.dark,
    feedCoverage: Number(coverage.ratio.toFixed(3)),
  };
}

/**
 * Store a gap event, pruning by age and then by cap.
 * @param {object} event Event from {@link evaluateAisGap}.
 * @param {number} [nowMs] Wall-clock milliseconds.
 * @returns {object} The stored event.
 */
export function recordAisGap(event, nowMs = Date.now()) {
  _gapEvents.push(event);

  const cutoff = Math.floor(nowMs / 1000) - AIS_GAP_RETENTION_SEC;
  if (
    _gapEvents.length > AIS_GAP_MAX_EVENTS ||
    _gapEvents[0].endEpochSec < cutoff
  ) {
    _gapEvents = _gapEvents.filter((entry) => entry.endEpochSec >= cutoff);
    if (_gapEvents.length > AIS_GAP_MAX_EVENTS) {
      _gapEvents = _gapEvents.slice(_gapEvents.length - AIS_GAP_MAX_EVENTS);
    }
  }
  return event;
}

/**
 * Whether either end of a gap falls inside a bounding box. A vessel that goes
 * dark outside the box and reappears inside it is the interesting case, so one
 * endpoint is enough.
 * @param {object} event Gap event.
 * @param {object} box `{minLat, maxLat, minLon, maxLon}`.
 * @returns {boolean} True when the gap touches the box.
 */
export function gapTouchesBox(event, box) {
  const inside = (lat, lon) =>
    lat >= box.minLat &&
    lat <= box.maxLat &&
    lon >= box.minLon &&
    lon <= box.maxLon;
  return (
    inside(event.startLat, event.startLon) || inside(event.endLat, event.endLon)
  );
}

/**
 * Read recorded gaps, newest first.
 * @param {object} [query]
 * @param {string} [query.region] Key from {@link AIS_GAP_REGIONS}.
 * @param {object} [query.bbox] Explicit `{minLat, maxLat, minLon, maxLon}`.
 * @param {number} [query.sinceSec] Only gaps that ended at or after this epoch.
 * @param {number} [query.minDurationSec] Only gaps at least this long.
 * @param {number} [query.limit] Maximum rows returned.
 * @param {string} [query.classification] `dark` or `spoofed`.
 * @returns {object[]} Matching events, newest first.
 */
export function listAisGaps(query = {}) {
  const { region, bbox, sinceSec, minDurationSec, limit, classification } =
    query;
  const box = bbox || (region ? AIS_GAP_REGIONS[region] : null);

  let rows = _gapEvents;
  if (box) rows = rows.filter((event) => gapTouchesBox(event, box));
  if (Number.isFinite(sinceSec)) {
    rows = rows.filter((event) => event.endEpochSec >= sinceSec);
  }
  if (Number.isFinite(minDurationSec)) {
    rows = rows.filter((event) => event.durationSec >= minDurationSec);
  }
  if (classification) {
    rows = rows.filter((event) => event.classification === classification);
  }

  rows = [...rows].sort((a, b) => b.endEpochSec - a.endEpochSec);
  return Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;
}

/** @returns {number} Count of retained gap events. */
export function aisGapCount() {
  return _gapEvents.length;
}

/**
 * Retained events split by classification.
 * @param {object} [query] Same filters as {@link listAisGaps}.
 * @returns {{dark:number, spoofed:number, total:number}} Counts.
 */
export function aisGapCounts(query = {}) {
  const rows = listAisGaps({ ...query, classification: undefined });
  let dark = 0;
  let spoofed = 0;
  for (const event of rows) {
    if (event.classification === AIS_GAP_CLASSES.spoofed) spoofed += 1;
    else dark += 1;
  }
  return { dark, spoofed, total: rows.length };
}

/**
 * The configured minimum silence, honouring `AIS_GAP_MIN_SEC` when it is a
 * sane positive number and falling back to the default otherwise.
 * @returns {number} Minimum silence in seconds.
 */
export function gapMinSeconds() {
  const raw = Number(process.env.AIS_GAP_MIN_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : AIS_GAP_MIN_SEC;
}

/**
 * Serialize gap events for disk persistence. The activity ring is deliberately
 * excluded: it describes THIS process's uptime, and restoring it would let a
 * restart vouch for a window during which nothing was running.
 * @returns {{gaps: object[]}} Snapshot.
 */
export function exportAisGapState() {
  return { gaps: _gapEvents };
}

/**
 * Restore a snapshot from {@link exportAisGapState}. Malformed entries are
 * skipped rather than throwing, since a corrupt save must never block startup.
 * @param {unknown} state Parsed snapshot.
 * @param {number} [nowMs] Wall-clock milliseconds.
 * @returns {number} Count of events restored.
 */
export function importAisGapState(state, nowMs = Date.now()) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.gaps)) {
    return 0;
  }
  const cutoff = Math.floor(nowMs / 1000) - AIS_GAP_RETENTION_SEC;
  const restored = state.gaps.filter(
    (event) =>
      event &&
      typeof event === 'object' &&
      Number.isFinite(event.endEpochSec) &&
      Number.isFinite(event.durationSec) &&
      Number.isFinite(event.startLat) &&
      Number.isFinite(event.startLon) &&
      Number.isFinite(event.endLat) &&
      Number.isFinite(event.endLon) &&
      event.endEpochSec >= cutoff,
  );
  // Events persisted before classification existed carry none. Deriving it on
  // read keeps one rule in one place, so a threshold change reclassifies the
  // whole history instead of leaving two eras that disagree.
  _gapEvents = restored.slice(-AIS_GAP_MAX_EVENTS).map((event) => ({
    ...event,
    classification:
      Number(event.impliedSpeedKts) > AIS_MAX_PLAUSIBLE_KTS
        ? AIS_GAP_CLASSES.spoofed
        : AIS_GAP_CLASSES.dark,
  }));
  return _gapEvents.length;
}

/** Drop all gap state. Tests only. */
export function resetAisGapState() {
  _activityRing = new Uint32Array(ACTIVITY_MINUTES);
  _gapEvents = [];
}
