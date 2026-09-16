import test from 'node:test';
import assert from 'node:assert/strict';
import { CHOKEPOINTS, subscriptionBoxes } from '../src/domain/chokepoints.js';
import {
  DEFAULT_HYSTERESIS_DEG,
  createTransitDetector,
  gateSide,
} from '../src/domain/transits.js';
import { createFeedActivity, evaluateGap, haversineKm } from '../src/domain/gaps.js';
import { createIngest, lengthFromDimension, parseEnvelope } from '../src/ingest.js';

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const BAND = DEFAULT_HYSTERESIS_DEG;

test('a side is only settled once the vessel clears the margin', () => {
  const gate = CHOKEPOINTS.hormuz.gate;
  assert.equal(gateSide(gate, 26.4, gate.line + 0.5, BAND), 'high');
  assert.equal(gateSide(gate, 26.4, gate.line - 0.5, BAND), 'low');
  // Inside the hysteresis margin the side is undecided, which is what stops
  // jitter at the line from manufacturing transits.
  assert.equal(gateSide(gate, 26.4, gate.line + BAND / 2, BAND), null);
  // Outside the lane band the vessel is not at this gate at all.
  assert.equal(gateSide(gate, 20.0, gate.line + 0.5, BAND), null);
});

test('a transit is counted once, with direction', () => {
  const detector = createTransitDetector();
  const east = 57.0;
  const west = 56.0;

  assert.deepEqual(detector.observe('a', 26.4, east, NOW), []);
  assert.deepEqual(detector.observe('a', 26.4, west, NOW), [
    { chokepoint: 'hormuz', direction: 'inbound' },
  ]);
  // Staying put does not re-trigger.
  assert.deepEqual(detector.observe('a', 26.4, west, NOW), []);
  assert.deepEqual(detector.observe('a', 26.4, east, NOW), [
    { chokepoint: 'hormuz', direction: 'outbound' },
  ]);
});

test('jitter at the line does not manufacture transits', () => {
  const detector = createTransitDetector();
  const gate = CHOKEPOINTS.hormuz.gate;

  // Settle definitively on one side.
  detector.observe('anchored', 26.4, gate.line + 0.5, NOW);
  // Now wobble across the line, but never clearing the margin. This is the
  // exact pattern GNSS spoofing and anchor swing produce, and the naive
  // opposite-sides test would score every one of these as a transit.
  let crossings = 0;
  for (let i = 0; i < 20; i += 1) {
    const offset = i % 2 === 0 ? BAND / 3 : -BAND / 3;
    crossings += detector.observe('anchored', 26.4, gate.line + offset, NOW).length;
  }
  assert.equal(crossings, 0);

  // A real transit still registers afterwards.
  assert.equal(detector.observe('anchored', 26.4, gate.line - 0.5, NOW).length, 1);
});

test('north-south gates work the same way', () => {
  const detector = createTransitDetector();
  // Bab el-Mandeb: northbound is into the Red Sea.
  detector.observe('bab', 12.3, 43.3, NOW);
  assert.deepEqual(detector.observe('bab', 12.9, 43.3, NOW), [
    { chokepoint: 'babelmandeb', direction: 'inbound' },
  ]);

  // Bosphorus: southbound carries the crude and grain out.
  detector.observe('bos', 41.4, 29.07, NOW);
  assert.deepEqual(detector.observe('bos', 40.9, 29.07, NOW), [
    { chokepoint: 'bosphorus', direction: 'outbound' },
  ]);
});

test('the Cape gate catches rerouting around Africa', () => {
  const detector = createTransitDetector();
  detector.observe('cape', -36.0, 21.0, NOW);
  const crossings = detector.observe('cape', -36.0, 19.0, NOW);
  assert.equal(crossings.length, 1);
  assert.equal(crossings[0].chokepoint, 'goodhope');
});

test('the subscription covers every region and nothing else', () => {
  const boxes = subscriptionBoxes();
  assert.equal(boxes.length, Object.keys(CHOKEPOINTS).length);
  for (const [[minLat, minLon], [maxLat, maxLon]] of boxes) {
    assert.ok(maxLat > minLat && maxLon > minLon);
    assert.ok(minLat >= -90 && maxLat <= 90);
  }
});

test('a silence with a live feed behind it is a gap; a restart is not', () => {
  const activity = createFeedActivity();
  const previous = {
    mmsi: '1',
    lat: 26.5,
    lon: 56.3,
    epochSec: Math.floor((NOW - 180 * MINUTE) / 1000),
    seenAtMs: NOW - 180 * MINUTE,
  };
  const next = {
    mmsi: '1',
    lat: 26.9,
    lon: 57.1,
    epochSec: Math.floor(NOW / 1000),
    seenAtMs: NOW,
  };

  // Nothing ingested across the window: the silence is ours, not the ship's.
  assert.equal(evaluateGap(previous, next, activity, { nowMs: NOW }), null);

  for (let at = NOW - 180 * MINUTE; at < NOW; at += MINUTE) activity.mark(at);
  const gap = evaluateGap(previous, next, activity, { nowMs: NOW });
  assert.ok(gap);
  assert.equal(gap.durationSec, 180 * 60);
  assert.equal(gap.feedCoverage, 1);
  assert.ok(gap.impliedSpeedKts > 14 && gap.impliedSpeedKts < 18);

  // Out-of-order frames carry an older epoch and are never a silence.
  assert.equal(
    evaluateGap(next, previous, activity, { nowMs: NOW }),
    null,
  );
});

test('haversine matches a known separation', () => {
  const km = haversineKm(27.1833, 56.2667, 26.1833, 56.2461);
  assert.ok(km > 105 && km < 115, String(km));
});

test('envelopes parse to the few fields collection needs', () => {
  const parsed = parseEnvelope({
    MessageType: 'PositionReport',
    MetaData: { MMSI: 636019825, latitude: 26.5, longitude: 56.6, time_utc: '2026-09-16 12:00:00 +0000 UTC' },
    Message: { PositionReport: { Sog: 12.4 } },
  });
  assert.equal(parsed.mmsi, '636019825');
  assert.equal(parsed.lat, 26.5);
  assert.equal(parsed.speed, 12.4);
  assert.equal(parsed.isStatic, false);
  assert.equal(parsed.epochSec, Math.floor(Date.UTC(2026, 8, 16, 12, 0, 0) / 1000));

  const staticReport = parseEnvelope({
    MessageType: 'ShipStaticData',
    MetaData: { MMSI: 1 },
    Message: { ShipStaticData: { MaximumStaticDraught: 21.5, Dimension: { A: 200, B: 130 }, Type: 80 } },
  });
  assert.equal(staticReport.isStatic, true);
  assert.equal(staticReport.draught, 21.5);
  assert.equal(staticReport.length, 330);

  assert.equal(parseEnvelope({}), null);
  assert.equal(parseEnvelope({ MessageType: 'PositionReport', MetaData: {} }), null);
});

test('dimensions are bounds checked', () => {
  assert.equal(lengthFromDimension({ A: 200, B: 130 }), 330);
  assert.equal(lengthFromDimension({ A: 0, B: 0 }), null);
  assert.equal(lengthFromDimension({ A: 400, B: 400 }), null);
  assert.equal(lengthFromDimension(null), null);
});

test('ingest enriches a crossing from the vessel static report', () => {
  const ingest = createIngest({ rulesVersion: 'test' });
  const at = NOW;

  ingest.handle(
    {
      MessageType: 'ShipStaticData',
      MetaData: { MMSI: 7 },
      Message: { ShipStaticData: { MaximumStaticDraught: 22, Dimension: { A: 200, B: 130 }, Type: 80 } },
    },
    at,
  );
  const position = (lon, t) => ({
    MessageType: 'PositionReport',
    MetaData: { MMSI: 7, latitude: 26.4, longitude: lon, time_utc: new Date(t).toISOString() },
    Message: { PositionReport: { Sog: 12 } },
  });
  ingest.handle(position(56.0, at), at);
  ingest.handle(position(57.0, at + MINUTE), at + MINUTE);

  const batch = ingest.drain();
  assert.equal(batch.crossings.length, 1);
  const crossing = batch.crossings[0];
  assert.equal(crossing.chokepoint, 'hormuz');
  assert.equal(crossing.direction, 'outbound');
  // The static report arrived first, so the crossing carries cargo state.
  assert.equal(crossing.draughtM, 22);
  assert.equal(crossing.lengthM, 330);
  assert.equal(crossing.shipType, '80');
  assert.equal(crossing.rulesVersion, 'test');

  // The denominator saw both position reports.
  const hormuzHour = batch.regionHours.find((r) => r.chokepoint === 'hormuz');
  assert.equal(hormuzHour.messages, 2);
  assert.equal(hormuzHour.vessels, 1);
  assert.ok(batch.serviceHours.length >= 1);

  // Draining twice must not replay the same rows.
  assert.equal(ingest.drain().crossings.length, 0);
});

test('ingest reports the size of every bounded structure', () => {
  const ingest = createIngest();
  ingest.handle(
    {
      MessageType: 'PositionReport',
      MetaData: { MMSI: 9, latitude: 26.4, longitude: 56.0, time_utc: new Date(NOW).toISOString() },
      Message: { PositionReport: { Sog: 1 } },
    },
    NOW,
  );
  const stats = ingest.stats();
  assert.equal(stats.rememberedFixes, 1);
  assert.equal(stats.trackedVessels, 1);
  assert.equal(typeof stats.staticRecords, 'number');
});
