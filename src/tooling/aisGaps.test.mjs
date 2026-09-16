import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIS_GAP_MAX_EVENTS,
  AIS_GAP_REGIONS,
  aisFeedCoverage,
  aisGapCount,
  evaluateAisGap,
  exportAisGapState,
  gapTouchesBox,
  haversineKm,
  importAisGapState,
  listAisGaps,
  recordAisFeedActivity,
  recordAisGap,
  resetAisGapState,
} from '../../server/providers/vessels/ais-gaps.js';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

/** Mark the feed as delivering for every minute in a wall-clock window. */
function feedAliveBetween(startMs, endMs) {
  for (let at = startMs; at < endMs; at += MINUTE) recordAisFeedActivity(at);
}

/** A stored vessel row, as the cache holds it. */
function row({ lat, lon, epochSec, updatedAt, mmsi = '636019825' }) {
  return {
    mmsi,
    lat,
    lon,
    name: 'TEST VESSEL',
    type: 'Tanker',
    last_position_epoch: epochSec,
    _updatedAt: updatedAt,
  };
}

test('feed coverage counts only minutes the ring still vouches for', () => {
  resetAisGapState();
  assert.deepEqual(aisFeedCoverage(NOW, NOW), {
    covered: 0,
    total: 0,
    ratio: 0,
  });
  // An inverted window is a caller bug, not full coverage.
  assert.equal(aisFeedCoverage(NOW, NOW - MINUTE).ratio, 0);

  feedAliveBetween(NOW - 60 * MINUTE, NOW);
  const full = aisFeedCoverage(NOW - 60 * MINUTE, NOW);
  assert.equal(full.total, 60);
  assert.equal(full.covered, 60);
  assert.equal(full.ratio, 1);

  // Half a window with no traffic scores half.
  resetAisGapState();
  feedAliveBetween(NOW - 30 * MINUTE, NOW);
  assert.equal(aisFeedCoverage(NOW - 60 * MINUTE, NOW).ratio, 0.5);
});

test('a silence with a live feed behind it is a gap', () => {
  resetAisGapState();
  const startSec = Math.floor((NOW - 180 * MINUTE) / 1000);
  const endSec = Math.floor(NOW / 1000);
  feedAliveBetween(NOW - 180 * MINUTE, NOW);

  const gap = evaluateAisGap(
    row({
      lat: 26.5,
      lon: 56.3,
      epochSec: startSec,
      updatedAt: NOW - 180 * MINUTE,
    }),
    row({ lat: 26.9, lon: 57.1, epochSec: endSec, updatedAt: NOW }),
    { nowMs: NOW },
  );

  assert.ok(gap);
  assert.equal(gap.durationSec, 180 * 60);
  assert.equal(gap.mmsi, '636019825');
  assert.equal(gap.feedCoverage, 1);
  // ~87 km between those two points; three hours of silence implies ~16 kts.
  assert.ok(gap.distanceKm > 80 && gap.distanceKm < 95, `${gap.distanceKm}`);
  assert.ok(
    gap.impliedSpeedKts > 14 && gap.impliedSpeedKts < 18,
    `${gap.impliedSpeedKts}`,
  );
});

test('a restart is not a dark vessel', () => {
  resetAisGapState();
  // The row was persisted three hours ago; nothing has been ingested since,
  // because the process was not running. The silence is ours, not the ship's.
  const gap = evaluateAisGap(
    row({
      lat: 26.5,
      lon: 56.3,
      epochSec: Math.floor((NOW - 180 * MINUTE) / 1000),
      updatedAt: NOW - 180 * MINUTE,
    }),
    row({
      lat: 26.9,
      lon: 57.1,
      epochSec: Math.floor(NOW / 1000),
      updatedAt: NOW,
    }),
    { nowMs: NOW },
  );
  assert.equal(gap, null);

  // Same silence, but the feed was only delivering for half of it — still
  // below the coverage bar, so still not attributable to the vessel.
  feedAliveBetween(NOW - 90 * MINUTE, NOW);
  assert.equal(
    evaluateAisGap(
      row({
        lat: 26.5,
        lon: 56.3,
        epochSec: Math.floor((NOW - 180 * MINUTE) / 1000),
        updatedAt: NOW - 180 * MINUTE,
      }),
      row({
        lat: 26.9,
        lon: 57.1,
        epochSec: Math.floor(NOW / 1000),
        updatedAt: NOW,
      }),
      { nowMs: NOW },
    ),
    null,
  );
});

test('short silences and out-of-order frames are not gaps', () => {
  resetAisGapState();
  feedAliveBetween(NOW - 180 * MINUTE, NOW);
  const base = {
    lat: 26.5,
    lon: 56.3,
    epochSec: Math.floor((NOW - 20 * MINUTE) / 1000),
    updatedAt: NOW - 20 * MINUTE,
  };

  // Twenty minutes is routine reporting cadence, not a dark transit.
  assert.equal(
    evaluateAisGap(
      row(base),
      row({
        lat: 26.6,
        lon: 56.4,
        epochSec: Math.floor(NOW / 1000),
        updatedAt: NOW,
      }),
      { nowMs: NOW },
    ),
    null,
  );

  // A frame that arrives out of order carries an OLDER epoch; a negative
  // duration must never be read as a silence.
  assert.equal(
    evaluateAisGap(
      row({
        lat: 26.5,
        lon: 56.3,
        epochSec: Math.floor(NOW / 1000),
        updatedAt: NOW - 180 * MINUTE,
      }),
      row({
        lat: 26.6,
        lon: 56.4,
        epochSec: Math.floor((NOW - 300 * MINUTE) / 1000),
        updatedAt: NOW,
      }),
      { nowMs: NOW },
    ),
    null,
  );

  assert.equal(evaluateAisGap(null, row(base)), null);
  assert.equal(
    evaluateAisGap(row({ ...base, epochSec: Number.NaN }), row(base)),
    null,
  );
});

test('the Hormuz region matches gaps at either end of the silence', () => {
  const inStrait = {
    startLat: 26.5,
    startLon: 56.3,
    endLat: 26.9,
    endLon: 57.1,
  };
  const box = AIS_GAP_REGIONS.hormuz;
  assert.equal(gapTouchesBox(inStrait, box), true);

  // Went dark in the Gulf of Oman, reappeared inside the strait: still ours.
  assert.equal(
    gapTouchesBox(
      { startLat: 24.5, startLon: 59.5, endLat: 26.6, endLon: 56.5 },
      box,
    ),
    true,
  );

  // Gulf of Mexico: neither end is in the box.
  assert.equal(
    gapTouchesBox(
      { startLat: 27.5, startLon: -92.0, endLat: 28.1, endLon: -91.2 },
      box,
    ),
    false,
  );
});

test('listing filters by region, age and duration, newest first', () => {
  resetAisGapState();
  const nowSec = Math.floor(NOW / 1000);
  const event = (overrides) =>
    recordAisGap(
      {
        mmsi: '1',
        startLat: 26.5,
        startLon: 56.3,
        endLat: 26.9,
        endLon: 57.1,
        startEpochSec: nowSec - 7200,
        endEpochSec: nowSec,
        durationSec: 7200,
        distanceKm: 87,
        impliedSpeedKts: 16,
        feedCoverage: 1,
        ...overrides,
      },
      NOW,
    );

  event({ mmsi: 'strait-new', endEpochSec: nowSec - 60 });
  event({ mmsi: 'strait-old', endEpochSec: nowSec - 3600 });
  event({
    mmsi: 'gulf-of-mexico',
    startLat: 27.5,
    startLon: -92,
    endLat: 28.1,
    endLon: -91.2,
  });
  event({ mmsi: 'brief', durationSec: 3700, endEpochSec: nowSec - 120 });

  const hormuz = listAisGaps({ region: 'hormuz' });
  assert.deepEqual(
    hormuz.map((entry) => entry.mmsi),
    ['strait-new', 'brief', 'strait-old'],
  );

  assert.deepEqual(
    listAisGaps({ region: 'hormuz', minDurationSec: 7200 }).map((e) => e.mmsi),
    ['strait-new', 'strait-old'],
  );
  assert.deepEqual(
    listAisGaps({ region: 'hormuz', sinceSec: nowSec - 300 }).map(
      (e) => e.mmsi,
    ),
    ['strait-new', 'brief'],
  );
  assert.equal(listAisGaps({ region: 'hormuz', limit: 1 }).length, 1);
  assert.equal(listAisGaps().length, 4);
});

test('retention prunes by age and then by hard cap', () => {
  resetAisGapState();
  const nowSec = Math.floor(NOW / 1000);
  const base = {
    mmsi: 'x',
    startLat: 26.5,
    startLon: 56.3,
    endLat: 26.9,
    endLon: 57.1,
    startEpochSec: nowSec,
    durationSec: 7200,
    distanceKm: 87,
    impliedSpeedKts: 16,
    feedCoverage: 1,
  };

  // Older than the 24h retention window.
  recordAisGap({ ...base, mmsi: 'ancient', endEpochSec: nowSec - 90_000 }, NOW);
  recordAisGap({ ...base, mmsi: 'fresh', endEpochSec: nowSec }, NOW);
  assert.deepEqual(
    listAisGaps().map((entry) => entry.mmsi),
    ['fresh'],
  );

  resetAisGapState();
  for (let i = 0; i < AIS_GAP_MAX_EVENTS + 25; i += 1) {
    recordAisGap({ ...base, mmsi: `v${i}`, endEpochSec: nowSec - i }, NOW);
  }
  assert.equal(aisGapCount(), AIS_GAP_MAX_EVENTS);
});

test('gap state round-trips through a snapshot and drops stale rows', () => {
  resetAisGapState();
  const nowSec = Math.floor(NOW / 1000);
  const event = {
    mmsi: 'keep',
    startLat: 26.5,
    startLon: 56.3,
    endLat: 26.9,
    endLon: 57.1,
    startEpochSec: nowSec - 7200,
    endEpochSec: nowSec,
    durationSec: 7200,
    distanceKm: 87,
    impliedSpeedKts: 16,
    feedCoverage: 1,
  };
  recordAisGap(event, NOW);
  recordAisGap({ ...event, mmsi: 'stale', endEpochSec: nowSec - 90_000 }, NOW);

  const snapshot = JSON.parse(JSON.stringify(exportAisGapState()));
  resetAisGapState();
  assert.equal(importAisGapState(snapshot, NOW), 1);
  assert.deepEqual(
    listAisGaps().map((entry) => entry.mmsi),
    ['keep'],
  );

  // A snapshot written before gap detection existed has no `gaps` key.
  resetAisGapState();
  assert.equal(importAisGapState({ vessels: [], static: [] }, NOW), 0);
  assert.equal(importAisGapState(null, NOW), 0);
  assert.equal(importAisGapState({ gaps: [{ bogus: true }] }, NOW), 0);
});

test('haversine matches a known separation', () => {
  // Bandar Abbas to Khasab across the strait, ~95 km.
  const km = haversineKm(27.1833, 56.2667, 26.1833, 56.2461);
  assert.ok(km > 105 && km < 115, `${km}`);
  assert.equal(haversineKm(26.5, 56.3, 26.5, 56.3), 0);
});
