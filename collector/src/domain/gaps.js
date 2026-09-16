// AIS gap ("dark vessel") detection.
//
// A vessel that stops broadcasting is the signal, not the absence of one. The
// hard part is refusing to report the silences that are OURS. Two clocks, not
// interchangeable:
//
//   AIS report time   measures the silence as the VESSEL reported it, so the
//                     duration is a property of the vessel rather than of our
//                     polling, buffering or restart schedule.
//
//   Wall-clock ingest proves the FEED was delivering across that window. If
//                     the stream was down, or this process restarted, there is
//                     no evidence the vessel went dark at all.
//
// Without the second clock every restart republishes the whole fleet as dark
// vessels. A silence we could not have observed is not a finding.
//
// Classification is deliberately NOT decided here — it is a view in the
// database, so revising the threshold reclassifies all history instead of only
// applying going forward.

/** Silence, in AIS report time, before a vessel counts as having gone dark. */
export const GAP_MIN_SEC = 3600;
/** Share of the window that must show feed activity to blame the vessel. */
export const GAP_MIN_FEED_COVERAGE = 0.8;
/** Minute buckets in the activity ring: 25 hours, 6 KB flat. */
const ACTIVITY_MINUTES = 25 * 60;

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance in kilometres.
 * @param {number} lat1 Start latitude.
 * @param {number} lon1 Start longitude.
 * @param {number} lat2 End latitude.
 * @param {number} lon2 End longitude.
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
 * Create a feed-liveness recorder.
 *
 * The ring is never persisted: it describes THIS process's uptime, and
 * restoring it would let a restart vouch for a window when nothing was running.
 *
 * @returns {object} Recorder with `mark` and `coverage`.
 */
export function createFeedActivity() {
  const ring = new Uint32Array(ACTIVITY_MINUTES);

  return {
    /**
     * Note that the feed delivered a message.
     * @param {number} [nowMs] Wall-clock milliseconds.
     */
    mark(nowMs = Date.now()) {
      const minute = Math.floor(nowMs / 60_000);
      ring[minute % ACTIVITY_MINUTES] = minute;
    },

    /**
     * How much of a wall-clock window the feed was demonstrably alive for.
     *
     * A minute counts only when the ring still holds that exact epoch minute;
     * a bucket overwritten by a later minute proves nothing about the older
     * one. An unknowable window scores zero — absence of evidence, never
     * evidence of absence.
     *
     * @param {number} startMs Window start.
     * @param {number} endMs Window end.
     * @returns {{covered:number, total:number, ratio:number}} Coverage.
     */
    coverage(startMs, endMs) {
      const startMinute = Math.floor(startMs / 60_000);
      const endMinute = Math.floor(endMs / 60_000);
      const total = endMinute - startMinute;
      if (!Number.isFinite(total) || total <= 0) {
        return { covered: 0, total: 0, ratio: 0 };
      }
      const oldestKnowable = endMinute - ACTIVITY_MINUTES;
      let covered = 0;
      for (let minute = startMinute; minute < endMinute; minute += 1) {
        if (minute <= oldestKnowable) continue;
        const slot = ((minute % ACTIVITY_MINUTES) + ACTIVITY_MINUTES) % ACTIVITY_MINUTES;
        if (ring[slot] === minute) covered += 1;
      }
      return { covered, total, ratio: covered / total };
    },
  };
}

/**
 * Decide whether a new fix closes a gap worth recording.
 *
 * @param {object} previous Last stored fix: `{mmsi, lat, lon, epochSec, seenAtMs}`.
 * @param {object} next Incoming fix, same shape.
 * @param {object} activity Recorder from {@link createFeedActivity}.
 * @param {object} [options]
 * @param {number} [options.nowMs] Wall-clock milliseconds.
 * @param {number} [options.minSec] Minimum silence to qualify.
 * @param {number} [options.minCoverage] Minimum proven feed coverage.
 * @returns {object|null} Raw gap record, or null when not reportable.
 */
export function evaluateGap(previous, next, activity, options = {}) {
  const {
    nowMs = Date.now(),
    minSec = GAP_MIN_SEC,
    minCoverage = GAP_MIN_FEED_COVERAGE,
  } = options;
  if (!previous || !next) return null;

  const startEpoch = Number(previous.epochSec);
  const endEpoch = Number(next.epochSec);
  if (!Number.isFinite(startEpoch) || !Number.isFinite(endEpoch)) return null;

  // Out-of-order and duplicate frames are normal on a multiplexed feed; only a
  // strictly forward jump can be a silence.
  const durationSec = endEpoch - startEpoch;
  if (durationSec < minSec) return null;

  const startLat = Number(previous.lat);
  const startLon = Number(previous.lon);
  const endLat = Number(next.lat);
  const endLon = Number(next.lon);
  if (![startLat, startLon, endLat, endLon].every(Number.isFinite)) return null;

  // Wall clock here, because only that describes OUR uptime. A restart leaves
  // the previous fix far in the past with no ring coverage behind it, which is
  // exactly the case this rejects.
  const observedFromMs = Number(previous.seenAtMs);
  const coverage = Number.isFinite(observedFromMs)
    ? activity.coverage(observedFromMs, nowMs)
    : { covered: 0, total: 0, ratio: 0 };
  if (coverage.ratio < minCoverage) return null;

  const distanceKm = haversineKm(startLat, startLon, endLat, endLon);
  const hours = durationSec / 3600;

  return {
    mmsi: String(next.mmsi ?? previous.mmsi ?? ''),
    startedAt: new Date(startEpoch * 1000),
    endedAt: new Date(endEpoch * 1000),
    durationSec,
    startLat,
    startLon,
    endLat,
    endLon,
    distanceKm: Number(distanceKm.toFixed(2)),
    // Nautical miles per hour over the straight line — the shortest path the
    // vessel could have taken, so a LOWER bound on its real speed.
    impliedSpeedKts:
      hours > 0 ? Number((distanceKm / 1.852 / hours).toFixed(2)) : 0,
    feedCoverage: Number(coverage.ratio.toFixed(3)),
  };
}
