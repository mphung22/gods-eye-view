import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HORMUZ_GATE,
  TIMESERIES_MAX_HOURS,
  exportTimeseriesState,
  gateCrossing,
  importTimeseriesState,
  isQueued,
  listDays,
  listHours,
  observedCoverage,
  recordGapForHour,
  recordQueueDepth,
  recordTransit,
  resetTimeseriesState,
} from '../../server/providers/vessels/ais-timeseries.js';
import {
  AIS_GAP_CLASSES,
  AIS_MAX_PLAUSIBLE_KTS,
  aisGapCounts,
  evaluateAisGap,
  importAisGapState,
  listAisGaps,
  recordAisFeedActivity,
  recordAisGap,
  resetAisGapState,
} from '../../server/providers/vessels/ais-gaps.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

function vessel(lat, lon, speed) {
  return { lat, lon, speed };
}

test('gate crossing counts direction, and only inside the lane band', () => {
  const west = HORMUZ_GATE.lon - 0.1;
  const east = HORMUZ_GATE.lon + 0.1;

  assert.equal(gateCrossing(vessel(26.4, east), vessel(26.4, west)), 'inbound');
  assert.equal(
    gateCrossing(vessel(26.4, west), vessel(26.4, east)),
    'outbound',
  );

  // Same meridian, but far south of the shipping lanes — not a Hormuz transit.
  assert.equal(gateCrossing(vessel(20.0, east), vessel(20.0, west)), null);
  // One end outside the band is not enough either.
  assert.equal(gateCrossing(vessel(26.4, east), vessel(24.0, west)), null);
  // Movement that never reaches the meridian.
  assert.equal(
    gateCrossing(vessel(26.4, west), vessel(26.4, west - 0.2)),
    null,
  );
  assert.equal(gateCrossing(null, vessel(26.4, west)), null);
});

test('queued means inside the approaches AND stopped, never unknown', () => {
  assert.equal(isQueued({ lat: 25.2, lon: 57.5, speed: 0.1 }), true);
  // Under way through the same water is not waiting.
  assert.equal(isQueued({ lat: 25.2, lon: 57.5, speed: 11 }), false);
  // Stopped, but in the Persian Gulf rather than the approaches.
  assert.equal(isQueued({ lat: 26.4, lon: 54.0, speed: 0 }), false);
  // A missing speed must not be read as stopped — that would inflate the
  // queue exactly when the feed is degraded.
  assert.equal(isQueued({ lat: 25.2, lon: 57.5 }), false);
  assert.equal(isQueued({ lat: 25.2, lon: 57.5, speed: null }), false);
});

test('hours accumulate counters and average the queue across samples', () => {
  resetTimeseriesState();
  recordTransit('outbound', NOW);
  recordTransit('outbound', NOW);
  recordTransit('inbound', NOW);
  recordGapForHour('dark', NOW);
  recordGapForHour('spoofed', NOW);
  recordQueueDepth(10, NOW);
  recordQueueDepth(20, NOW);

  const [row] = listHours();
  assert.equal(row.outbound, 2);
  assert.equal(row.inbound, 1);
  assert.equal(row.dark, 1);
  assert.equal(row.spoofed, 1);
  assert.equal(row.queueDepth, 15);
  assert.equal(row.queueSamples, 2);

  // An hour that was observed but had nothing waiting is not the same fact as
  // an hour nobody sampled.
  recordTransit('outbound', NOW + HOUR);
  assert.equal(listHours()[1].queueDepth, null);
});

test('coverage reports the holes a restart leaves', () => {
  resetTimeseriesState();
  for (let i = 1; i <= 6; i += 1) recordTransit('outbound', NOW - i * HOUR);

  const full = observedCoverage(6, NOW);
  assert.deepEqual(full, { observedHours: 6, windowHours: 6, ratio: 1 });

  // Twelve hours requested, six recorded: the counts are half a story.
  const partial = observedCoverage(12, NOW);
  assert.equal(partial.observedHours, 6);
  assert.equal(partial.ratio, 0.5);
});

test('days roll up hours and keep a queue average over observed hours only', () => {
  resetTimeseriesState();
  const dayStart = Date.UTC(2026, 8, 16, 0, 0, 0);
  recordTransit('outbound', dayStart);
  recordQueueDepth(12, dayStart);
  recordTransit('outbound', dayStart + HOUR);
  recordTransit('inbound', dayStart + HOUR);
  // An hour with traffic but no queue sample must not drag the average to zero.
  recordTransit('outbound', dayStart + 2 * HOUR);

  const [day] = listDays();
  assert.equal(day.date, '2026-09-16');
  assert.equal(day.outbound, 3);
  assert.equal(day.inbound, 1);
  assert.equal(day.hoursObserved, 3);
  assert.equal(day.queueDepth, 12);
  assert.equal(day.queueHours, 1);
});

test('time series round-trips and stays bounded', () => {
  resetTimeseriesState();
  recordTransit('outbound', NOW);
  recordQueueDepth(7, NOW);

  const snapshot = JSON.parse(JSON.stringify(exportTimeseriesState()));
  resetTimeseriesState();
  assert.equal(importTimeseriesState(snapshot), 1);
  assert.equal(listHours()[0].outbound, 1);
  assert.equal(listHours()[0].queueDepth, 7);

  assert.equal(importTimeseriesState(null), 0);
  assert.equal(importTimeseriesState({ hours: [{ nope: true }] }), 0);

  // Older hours fall off the end rather than growing without bound.
  resetTimeseriesState();
  const hours = [];
  for (let i = 0; i < TIMESERIES_MAX_HOURS + 10; i += 1) {
    hours.push({ hour: i, outbound: 1, inbound: 0, dark: 0, spoofed: 0 });
  }
  importTimeseriesState({ hours });
  assert.equal(listHours().length, TIMESERIES_MAX_HOURS);
});

test('an impossible implied speed is a spoof, not a dark transit', () => {
  resetAisGapState();
  const startSec = Math.floor((NOW - 2 * HOUR) / 1000);
  for (let at = NOW - 2 * HOUR; at < NOW; at += 60_000) {
    recordAisFeedActivity(at);
  }

  // Two hours of silence, then the vessel reappears 1,500 km away: ~405 kts.
  const spoof = evaluateAisGap(
    {
      mmsi: '1',
      lat: 26.5,
      lon: 56.3,
      last_position_epoch: startSec,
      _updatedAt: NOW - 2 * HOUR,
    },
    {
      mmsi: '1',
      lat: 26.5,
      lon: 41.3,
      last_position_epoch: Math.floor(NOW / 1000),
      _updatedAt: NOW,
    },
    { nowMs: NOW },
  );
  assert.equal(spoof.classification, AIS_GAP_CLASSES.spoofed);
  assert.ok(spoof.impliedSpeedKts > AIS_MAX_PLAUSIBLE_KTS);

  // The same silence with a plausible 15 kt run stays a dark transit.
  const dark = evaluateAisGap(
    {
      mmsi: '2',
      lat: 26.5,
      lon: 56.3,
      last_position_epoch: startSec,
      _updatedAt: NOW - 2 * HOUR,
    },
    {
      mmsi: '2',
      lat: 26.5,
      lon: 56.85,
      last_position_epoch: Math.floor(NOW / 1000),
      _updatedAt: NOW,
    },
    { nowMs: NOW },
  );
  assert.equal(dark.classification, AIS_GAP_CLASSES.dark);
  assert.ok(dark.impliedSpeedKts < AIS_MAX_PLAUSIBLE_KTS);

  recordAisGap(spoof, NOW);
  recordAisGap(dark, NOW);
  assert.deepEqual(aisGapCounts(), { dark: 1, spoofed: 1, total: 2 });
  assert.deepEqual(
    listAisGaps({ classification: 'spoofed' }).map((e) => e.mmsi),
    ['1'],
  );
});

test('legacy gap rows are classified on import, not left blank', () => {
  resetAisGapState();
  const nowSec = Math.floor(NOW / 1000);
  const base = {
    startLat: 26.5,
    startLon: 56.3,
    endLat: 26.9,
    endLon: 57.1,
    startEpochSec: nowSec - 7200,
    endEpochSec: nowSec,
    durationSec: 7200,
    distanceKm: 87,
    feedCoverage: 1,
  };

  // Rows written before the classifier existed carry no `classification`.
  const restored = JSON.parse(
    JSON.stringify({
      gaps: [
        { ...base, mmsi: 'slow', impliedSpeedKts: 16 },
        { ...base, mmsi: 'impossible', impliedSpeedKts: 400 },
      ],
    }),
  );

  assert.equal(importAisGapState(restored, NOW), 2);
  assert.deepEqual(aisGapCounts(), { dark: 1, spoofed: 1, total: 2 });
});
