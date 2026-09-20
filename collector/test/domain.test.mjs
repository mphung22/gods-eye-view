import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHOKEPOINTS,
  distanceToGateKm,
  PRIMARY_CHOKEPOINT,
  subscriptionBoxes,
} from '../src/domain/chokepoints.js';
import {
  DEFAULT_HYSTERESIS_DEG,
  createTransitDetector,
  gateSide,
} from '../src/domain/transits.js';
import { createFeedActivity, evaluateGap, haversineKm } from '../src/domain/gaps.js';
import { createIngest, lengthFromDimension, parseEnvelope } from '../src/ingest.js';
import { CODE_RULES_VERSION, loadConfig } from '../src/config.js';
import { __testing as apiTesting } from '../src/api.js';
import { AIRSPACES, isWatchworthy, openSkyQuery } from '../src/domain/airspaces.js';
import { createAirwatch } from '../src/airwatch.js';
import { parseState } from '../src/opensky.js';

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
  // Eastbound past Cape Point, then back. The gate sits at 18.15E now, so
  // these are positions the Cape Town receiver has actually been observed to
  // reach rather than the open-ocean ones r2 assumed.
  detector.observe('cape', -34.5, 18.45, NOW);
  const crossings = detector.observe('cape', -34.5, 17.85, NOW);
  assert.equal(crossings.length, 1);
  assert.equal(crossings[0].chokepoint, 'goodhope');
  assert.equal(crossings[0].direction, 'inbound');
});

test('the Cape gate sits inside the coverage that was measured', () => {
  // The observed footprint after two hours of collection. A gate outside it
  // cannot produce a crossing however sound the reasoning behind its
  // placement — which is how r2's gate failed.
  const OBSERVED = { minLat: -34.79, maxLat: -33.7, minLon: 17.66, maxLon: 18.64 };
  const { gate } = CHOKEPOINTS.goodhope;

  assert.ok(gate.line > OBSERVED.minLon && gate.line < OBSERVED.maxLon);
  // And with room either side: a crossing needs vessels settled on both.
  assert.ok(gate.line - OBSERVED.minLon > 0.3, 'too little reception west of the line');
  assert.ok(OBSERVED.maxLon - gate.line > 0.3, 'too little reception east of the line');
  assert.ok(gate.bandMin >= OBSERVED.minLat, 'band reaches south of any reception');

  // The queue box has to be reachable too, for the same reason.
  const q = CHOKEPOINTS.goodhope.queueBox;
  assert.ok(q.minLon > OBSERVED.minLon && q.maxLon < OBSERVED.maxLon);
  assert.ok(q.minLat > OBSERVED.minLat && q.maxLat < OBSERVED.maxLat);
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

test('distance to a gate measures past the line and outside the band', () => {
  const gate = CHOKEPOINTS.bosphorus.gate;
  // On the line, inside the lane band: zero by construction.
  assert.equal(distanceToGateKm(gate, gate.line, 29.1), 0);

  // A tenth of a degree north of a latitude gate is ~11 km, whichever
  // longitude inside the band it sits at.
  const north = distanceToGateKm(gate, gate.line + 0.1, 29.1);
  assert.ok(north > 10 && north < 12, `expected ~11 km, got ${north}`);

  // Outside the band the across-axis offset counts too, so a vessel level
  // with the line but far along the coast is not "at the gate".
  const aside = distanceToGateKm(gate, gate.line, 34.0);
  assert.ok(aside > 350, `expected a few hundred km, got ${aside}`);

  // Longitude degrees are narrower at 41N than at the equator; a gate on a
  // meridian must not over-report distance because of it.
  const capeGate = CHOKEPOINTS.goodhope.gate;
  const east = distanceToGateKm(capeGate, -34.5, capeGate.line + 1);
  assert.ok(east > 85 && east < 95, `expected ~90 km, got ${east}`);
});

/** Feed one position fix through a fresh ingest. */
function fix(ingest, mmsi, lat, lon, atMs = NOW) {
  ingest.handle(
    {
      MessageType: 'PositionReport',
      MetaData: { MMSI: mmsi, latitude: lat, longitude: lon, time_utc: new Date(atMs).toISOString() },
      Message: { PositionReport: { Sog: 12 } },
    },
    atMs,
  );
}

const verdictFor = (ingest, id) =>
  ingest.diagnostics(NOW).chokepoints.find((c) => c.id === id);

test('diagnostics separates no coverage from coverage that misses the gate', () => {
  const ingest = createIngest();
  // Vessels scattered across the open Black Sea, hundreds of km from the
  // strait — exactly the shape a satellite-only feed produces.
  fix(ingest, 'openwater-1', 44.0, 34.0);
  fix(ingest, 'openwater-2', 43.2, 31.5);

  const bosphorus = verdictFor(ingest, 'bosphorus');
  assert.equal(bosphorus.received, 2);
  assert.equal(bosphorus.nearGate, 0);
  assert.ok(bosphorus.nearestGateKm > 200);
  assert.match(bosphorus.verdict, /^COVERAGE OFF-GATE/);

  // A region with nothing received at all is a different failure and must
  // not be reported with the same words.
  assert.equal(verdictFor(ingest, 'hormuz').received, 0);
  assert.match(verdictFor(ingest, 'hormuz').verdict, /^NO COVERAGE/);
});

test('diagnostics distinguishes at-the-gate, one-sided and healthy', () => {
  const margin = createIngest();
  // Inside the hysteresis margin: at the gate, but no side is settled, so no
  // crossing can ever be credited from this alone.
  fix(margin, 'drifting', CHOKEPOINTS.bosphorus.gate.line, 29.08);
  const undecided = verdictFor(margin, 'bosphorus');
  assert.equal(undecided.nearGate, 1);
  assert.equal(undecided.settledLow + undecided.settledHigh, 0);
  assert.match(undecided.verdict, /^AT GATE/);

  const oneSided = createIngest();
  fix(oneSided, 'south', 41.10, 29.08);
  const south = verdictFor(oneSided, 'bosphorus');
  assert.equal(south.settledLow, 1);
  assert.equal(south.settledHigh, 0);
  assert.match(south.verdict, /^ONE-SIDED/);

  const both = createIngest();
  fix(both, 'south', 41.10, 29.08);
  fix(both, 'north', 41.20, 29.08);
  const healthy = verdictFor(both, 'bosphorus');
  assert.equal(healthy.settledLow, 1);
  assert.equal(healthy.settledHigh, 1);
  assert.match(healthy.verdict, /^HEALTHY/);
});

test('diagnostics reports the box coverage was actually observed in', () => {
  const ingest = createIngest();
  fix(ingest, 'a', 44.0, 34.0);
  fix(ingest, 'b', 42.5, 30.0);

  const { observedBox } = verdictFor(ingest, 'bosphorus');
  // Not the subscribed region — the corner of the water that actually
  // delivered. The gap between the two is the whole point.
  assert.deepEqual(observedBox, { minLat: 42.5, maxLat: 44, minLon: 30, maxLon: 34 });
  assert.notEqual(observedBox.minLat, CHOKEPOINTS.bosphorus.region.minLat);
});

test('the Cape is the primary series and its gate spans both routings', () => {
  assert.equal(PRIMARY_CHOKEPOINT, 'goodhope');
  assert.equal(
    Object.values(CHOKEPOINTS).filter((c) => c.primary).length,
    1,
    'exactly one chokepoint may be primary',
  );

  const gate = CHOKEPOINTS.goodhope.gate;
  // Westbound ships ride the Agulhas Current close inshore; eastbound stand
  // well south to escape it. Both have to be inside the band or the count
  // measures one direction and calls it a trend.
  assert.equal(gateSide(gate, -34.5, gate.line + 0.4, BAND), 'high');
  assert.equal(gateSide(gate, -34.7, gate.line - 0.4, BAND), 'low');
  // And the band must stay inside the subscribed region, or the gate watches
  // water the feed was never asked for.
  const { region } = CHOKEPOINTS.goodhope;
  assert.ok(gate.bandMin >= region.minLat && gate.bandMax <= region.maxLat);
});

test('Algoa Bay bunkering is counted as a queue', () => {
  const ingest = createIngest();
  const stopped = (mmsi, lat, lon) =>
    ingest.handle(
      {
        MessageType: 'PositionReport',
        MetaData: { MMSI: mmsi, latitude: lat, longitude: lon, time_utc: new Date(NOW).toISOString() },
        Message: { PositionReport: { Sog: 0.1 } },
      },
      NOW,
    );

  stopped('bunker-1', -33.85, 18.40);
  stopped('bunker-2', -33.90, 18.45);
  // Nothing is recorded yet: the fix table is still cold, and a sweep now
  // would report an anchorage that had not finished being observed.
  assert.equal(ingest.drain().regionHours.find((r) => r.chokepoint === 'goodhope')
    ?.queueDepth ?? null, null);
  // A ship under way past the cape is not bunkering. This one also arrives
  // past the warm-up, so it is the envelope that triggers the first sweep.
  const warm = NOW + 31 * MINUTE;
  ingest.handle(
    {
      MessageType: 'PositionReport',
      MetaData: { MMSI: 'transiting', latitude: -35.4, longitude: 20.5, time_utc: new Date(warm).toISOString() },
      Message: { PositionReport: { Sog: 13 } },
    },
    warm,
  );

  const cape = ingest.diagnostics(warm).chokepoints.find((c) => c.id === 'goodhope');
  assert.equal(cape.inQueueBox, 2);
  assert.equal(cape.received, 3);

  const row = ingest.drain().regionHours.find((r) => r.chokepoint === 'goodhope');
  assert.equal(row.queueDepth, 2);
  assert.equal(row.queueSamples, 1);
});

test('a stale RULES_VERSION is reported, never silently obeyed', () => {
  const base = { DATABASE_URL: 'postgres://x' };

  // Unset: the code's own version, and nothing to warn about.
  const fresh = loadConfig(base);
  assert.equal(fresh.rulesVersion, CODE_RULES_VERSION);
  assert.equal(fresh.rulesVersionOverridden, null);

  // Matching: still nothing to warn about.
  assert.equal(
    loadConfig({ ...base, RULES_VERSION: CODE_RULES_VERSION }).rulesVersionOverridden,
    null,
  );

  // Stale: the deployment stamps rows with a ruleset this code does not
  // implement. Honoured, because an override has legitimate uses — but the
  // disagreement travels with the config so boot and /health can say so.
  const stale = loadConfig({ ...base, RULES_VERSION: 'r1' });
  assert.equal(stale.rulesVersion, 'r1');
  assert.equal(stale.rulesVersionOverridden, CODE_RULES_VERSION);
});

test('an absent query parameter falls through to its default', () => {
  const { intParam } = apiTesting;
  const none = new URLSearchParams('chokepoint=goodhope');

  // The regression: Number(null) is 0 and 0 is finite, so every default was
  // clamped to min. /crossings served one row to every caller who did not
  // name a limit, which reads exactly like a collector with one crossing.
  assert.equal(intParam(none, 'limit', 1, 5000, 500), 500);
  assert.equal(intParam(none, 'hours', 24, 17520, 2160), 2160);
  assert.equal(intParam(none, 'hours', 1, 2160, 24), 24);

  // Blank and unparseable are absent too, not zero.
  assert.equal(intParam(new URLSearchParams('limit='), 'limit', 1, 5000, 500), 500);
  assert.equal(intParam(new URLSearchParams('limit=%20'), 'limit', 1, 5000, 500), 500);
  assert.equal(intParam(new URLSearchParams('limit=abc'), 'limit', 1, 5000, 500), 500);

  // An explicit value is still honoured, still clamped, still truncated.
  assert.equal(intParam(new URLSearchParams('limit=42'), 'limit', 1, 5000, 500), 42);
  assert.equal(intParam(new URLSearchParams('limit=99999'), 'limit', 1, 5000, 500), 5000);
  assert.equal(intParam(new URLSearchParams('limit=0'), 'limit', 1, 5000, 500), 1);
  assert.equal(intParam(new URLSearchParams('limit=7.9'), 'limit', 1, 5000, 500), 7);
  // And an explicit zero is a real request to clamp, unlike an absent one.
  assert.equal(intParam(new URLSearchParams('hours=0'), 'hours', 24, 17520, 2160), 24);
});

test('the watchworthy net is wide, and blank callsigns do not qualify', () => {
  // US military hex block — the one that matters, because US tankers are what
  // surge before a strike package flies.
  assert.equal(isWatchworthy('ae1234', null), true);
  assert.equal(isWatchworthy('AE1234', ''), true, 'hex is case-insensitive');
  // A civil airliner with no interesting callsign is dropped.
  assert.equal(isWatchworthy('4ca7b1', 'RYR1234'), false);
  // Callsign alone is enough, because many military aircraft broadcast civil
  // addresses. The net is deliberately wide: a false positive costs one row,
  // a false negative costs a contact the sky will never repeat.
  assert.equal(isWatchworthy('c01234', 'RCH512'), true);
  assert.equal(isWatchworthy('c01234', 'FORTE11'), true);
  // Blank identity is not a match on the callsign path.
  assert.equal(isWatchworthy('c01234', '   '), false);
  assert.equal(isWatchworthy('', null), false);
  assert.equal(isWatchworthy('zzzzzz', null), false, 'unparseable hex');
});

test('every airspace box is a usable OpenSky query', () => {
  for (const airspace of Object.values(AIRSPACES)) {
    const { minLat, maxLat, minLon, maxLon } = airspace.box;
    assert.ok(maxLat > minLat && maxLon > minLon, airspace.id);
    assert.ok(minLat >= -90 && maxLat <= 90, airspace.id);
    const q = openSkyQuery(airspace);
    assert.match(q, /lamin=.*&lomin=.*&lamax=.*&lomax=/);
    assert.ok(q.includes(`lamin=${minLat}`));
  }
});

test('a failed poll is recorded as a failure, not as an empty sky', () => {
  const air = createAirwatch({ rulesVersion: 'test' });
  const levant = AIRSPACES.levant;

  // A rate-limited poll returns zero aircraft, exactly like a quiet sky.
  air.record(levant, { ok: false, contacts: [], reason: 'rate-limited' }, NOW);
  let row = air.drain().airspaceHours.find((r) => r.airspace === 'levant');
  assert.equal(row.pollsAttempted, 1);
  assert.equal(row.pollsOk, 0, 'a failure must not count as a look');
  assert.equal(row.aircraft, 0);

  // A successful poll that genuinely saw nothing is a different fact.
  air.record(levant, { ok: true, contacts: [], reason: null }, NOW);
  row = air.drain().airspaceHours.find((r) => r.airspace === 'levant');
  assert.equal(row.pollsAttempted, 1);
  assert.equal(row.pollsOk, 1);
  assert.equal(row.aircraft, 0);

  // And the verdict says which is which in words, not just numbers.
  air.record(levant, { ok: false, contacts: [], reason: 'http-503' }, NOW);
  const verdict = air.diagnostics(NOW).find((a) => a.id === 'levant').verdict;
  assert.match(verdict, /^POLL FAILED/);
});

test('airwatch keeps rows only for watchworthy airborne contacts', () => {
  const air = createAirwatch({ rulesVersion: 'test' });
  const contact = (over) => ({
    icao24: 'ae0001', callsign: 'ESSO51', lat: 33.5, lon: 34.5,
    altitudeM: 9000, velocityMs: 140, verticalRateMs: 0, trueTrack: 90,
    originCountry: 'United States', squawk: '1200', onGround: false,
    observedAt: Math.floor(NOW / 1000), ...over,
  });

  air.record(AIRSPACES.levant, {
    ok: true,
    contacts: [
      contact(),
      // Same tanker, on the ground. An airframe parked on an apron is not a
      // signal, and that is where most of them are most of the time.
      contact({ icao24: 'ae0002', onGround: true }),
      // A civil airliner: counted in the denominator, no row of its own.
      contact({ icao24: '4ca7b1', callsign: 'RYR1234' }),
      // Watchworthy but with no position to record.
      contact({ icao24: 'ae0003', lat: null, lon: null }),
    ],
  }, NOW);

  const batch = air.drain();
  assert.equal(batch.airContacts.length, 1);
  assert.equal(batch.airContacts[0].icao24, 'ae0001');
  assert.equal(batch.airContacts[0].rulesVersion, 'test');

  const row = batch.airspaceHours.find((r) => r.airspace === 'levant');
  // All four count toward "how much was in the sky" — that is the
  // denominator, and dropping the airliner from it would make the watchworthy
  // share meaningless.
  assert.equal(row.aircraft, 4);
  assert.equal(row.watchworthy, 3);
  assert.equal(row.contacts, 1);
});

test('OpenSky state vectors parse by name, not by position', () => {
  // The API returns bare arrays. One shifted index silently swaps latitude
  // and longitude, which would put every contact in the wrong hemisphere.
  const parsed = parseState([
    'ae1234', 'ESSO51  ', 'United States', 1789000000, 1789000005,
    34.5, 33.5, 9000, false, 140, 90, 0, null, null, '1200',
  ]);
  assert.equal(parsed.icao24, 'ae1234');
  assert.equal(parsed.callsign, 'ESSO51');
  assert.equal(parsed.lon, 34.5);
  assert.equal(parsed.lat, 33.5);
  assert.equal(parsed.altitudeM, 9000);
  assert.equal(parsed.velocityMs, 140);
  assert.equal(parsed.onGround, false);
  assert.equal(parsed.squawk, '1200');

  assert.equal(parseState(null), null);
  assert.equal(parseState(['']), null);
  // A null position is null, not zero — 0,0 is a real place in the Atlantic.
  assert.equal(parseState(['ae1', '', '', null, null, null, null])?.lat, null);
});
