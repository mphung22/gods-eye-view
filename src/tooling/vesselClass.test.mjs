import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approxKdwt,
  isTanker,
  ladenState,
  lengthFromDimension,
  sizeClassFromLength,
  vesselCategory,
} from '../../server/providers/vessels/vessel-class.js';
import {
  MAX_CROSSINGS,
  adoptCrossings,
  crossingCount,
  listCrossings,
  markCrossingsFlushed,
  pendingCrossings,
  recordCrossing,
  resetCrossings,
} from '../../server/providers/vessels/ais-crossings.js';
import {
  listHours,
  recordRegionObservation,
  recordTransit,
  resetTimeseriesState,
} from '../../server/providers/vessels/ais-timeseries.js';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);

test('tankers are recognised from numeric codes and from text', () => {
  assert.equal(isTanker(80), true);
  assert.equal(isTanker(89), true);
  assert.equal(isTanker(79), false);
  assert.equal(isTanker(70), false);
  assert.equal(isTanker('Crude Oil Tanker'), true);
  assert.equal(isTanker('Container Ship'), false);
  assert.equal(isTanker(null), false);

  assert.equal(vesselCategory(82), 'tanker');
  assert.equal(vesselCategory(70), 'cargo');
  assert.equal(vesselCategory('Bulk Carrier'), 'cargo');
  assert.equal(vesselCategory(52), 'other');
});

test('size classes follow hull length, and reject impossible lengths', () => {
  assert.equal(sizeClassFromLength(333), 'vlcc');
  assert.equal(sizeClassFromLength(275), 'suezmax');
  assert.equal(sizeClassFromLength(245), 'aframax');
  assert.equal(sizeClassFromLength(210), 'panamax');
  assert.equal(sizeClassFromLength(180), 'handy');
  assert.equal(sizeClassFromLength(90), 'small');
  assert.equal(sizeClassFromLength(0), null);
  assert.equal(sizeClassFromLength(null), null);

  // Weighting exists so ten VLCCs do not read as ten product tankers.
  assert.ok(approxKdwt('vlcc') > approxKdwt('handy') * 5);
  assert.equal(approxKdwt(null), 0);
});

test('laden and ballast separate by draught-to-length ratio at every size', () => {
  // VLCC: ~22 m laden on 330 m, ~9 m in ballast.
  assert.equal(ladenState(22, 330), 'laden');
  assert.equal(ladenState(9, 330), 'ballast');
  // MR product tanker: ~11 m laden on 180 m, ~6 m in ballast. One pair of
  // thresholds has to cover both ends of the fleet.
  assert.equal(ladenState(11, 180), 'laden');
  assert.equal(ladenState(6, 180), 'ballast');
  // Part-loaded is a real state and is not forced into either bucket.
  assert.equal(ladenState(8.5, 180), 'partial');

  assert.equal(ladenState(0, 330), null);
  assert.equal(ladenState(22, 0), null);
  assert.equal(ladenState(null, 330), null);
  // A draught deeper than a fifth of the hull length is a typo, not a vessel.
  assert.equal(ladenState(90, 180), null);
});

test('length comes from the AIS dimension quartet, bounds checked', () => {
  assert.equal(lengthFromDimension({ A: 200, B: 130, C: 30, D: 30 }), 330);
  // Unset dimensions report zero, which is absence rather than a hull.
  assert.equal(lengthFromDimension({ A: 0, B: 0, C: 0, D: 0 }), null);
  // Longer than any vessel afloat.
  assert.equal(lengthFromDimension({ A: 400, B: 400 }), null);
  assert.equal(lengthFromDimension(null), null);
  assert.equal(lengthFromDimension({ A: 'x', B: 10 }), null);
});

test('crossings keep raw reported values and never the interpretation', () => {
  resetCrossings();
  const row = recordCrossing({
    chokepoint: 'hormuz',
    direction: 'outbound',
    mmsi: '636019825',
    epochSec: 1_789_000_000,
    lat: 26.5,
    lon: 56.6,
    type: 80,
    draught: 21.5,
    length: 330,
  });

  assert.equal(row.draught, 21.5);
  assert.equal(row.length, 330);
  // The derived reading must not be baked in — that is what makes a revised
  // threshold replayable over the archive.
  assert.ok(!('laden' in row));
  assert.ok(!('sizeClass' in row));

  // Absent static data is omitted rather than nulled.
  const bare = recordCrossing({
    chokepoint: 'bosphorus',
    direction: 'inbound',
    mmsi: '1',
    epochSec: 1_789_000_100,
    lat: 41.2,
    lon: 29.07,
  });
  assert.ok(!('draught' in bare));
  assert.ok(!('type' in bare));

  assert.equal(crossingCount(), 2);
  assert.deepEqual(
    listCrossings({ chokepoint: 'hormuz' }).map((r) => r.mmsi),
    ['636019825'],
  );
  assert.deepEqual(
    listCrossings({ direction: 'inbound' }).map((r) => r.mmsi),
    ['1'],
  );
  // Newest first.
  assert.equal(listCrossings()[0].mmsi, '1');
});

test('the crossing archive flushes incrementally and survives adoption', () => {
  resetCrossings();
  for (let i = 0; i < 3; i += 1) {
    recordCrossing({
      chokepoint: 'hormuz',
      direction: 'outbound',
      mmsi: String(i),
      epochSec: 1_789_000_000 + i,
      lat: 26.5,
      lon: 56.6,
    });
  }
  assert.equal(pendingCrossings().length, 3);
  markCrossingsFlushed(3);
  assert.equal(pendingCrossings().length, 0);

  // Only the new row is pending; the writer appends rather than rewriting.
  recordCrossing({
    chokepoint: 'hormuz',
    direction: 'inbound',
    mmsi: 'new',
    epochSec: 1_789_000_500,
    lat: 26.5,
    lon: 56.4,
  });
  assert.equal(pendingCrossings().length, 1);

  // Rows loaded from disk are already archived, so nothing re-appends them.
  resetCrossings();
  assert.equal(
    adoptCrossings([{ chokepoint: 'hormuz', lat: 26.5, lon: 56.6 }]),
    1,
  );
  assert.equal(pendingCrossings().length, 0);
  assert.equal(adoptCrossings([{ junk: true }]), 0);
  assert.equal(adoptCrossings(null), 0);
});

test('memory stays bounded while the archive keeps growing', () => {
  resetCrossings();
  for (let i = 0; i < MAX_CROSSINGS + 50; i += 1) {
    recordCrossing({
      chokepoint: 'hormuz',
      direction: 'outbound',
      mmsi: String(i),
      epochSec: 1_789_000_000 + i,
      lat: 26.5,
      lon: 56.6,
    });
  }
  assert.equal(crossingCount(), MAX_CROSSINGS);
});

test('transit detail splits tankers, laden state and capacity', () => {
  resetTimeseriesState();
  recordTransit('hormuz', 'outbound', NOW, {
    tanker: true,
    laden: 'laden',
    kdwt: 300,
  });
  recordTransit('hormuz', 'outbound', NOW, {
    tanker: true,
    laden: 'ballast',
    kdwt: 300,
  });
  // A boxship still counts as a transit but must not touch the tanker series.
  recordTransit('hormuz', 'outbound', NOW, { tanker: false });
  recordTransit('hormuz', 'inbound', NOW, { tanker: true, laden: 'ballast' });

  const [row] = listHours();
  assert.equal(row.outbound, 3);
  assert.equal(row.outboundTanker, 2);
  assert.equal(row.outboundLaden, 1);
  assert.equal(row.outboundBallast, 1);
  assert.equal(row.outboundKdwt, 600);
  assert.equal(row.inbound, 1);
  assert.equal(row.inboundTanker, 1);
  // Laden state is only tracked outbound, where it means cargo leaving.
  assert.equal(row.outboundLaden + row.outboundBallast, 2);
});

test('the denominator counts messages and distinct vessels', () => {
  resetTimeseriesState();
  recordRegionObservation('hormuz', 1, NOW);
  recordRegionObservation('hormuz', 1, NOW);
  recordRegionObservation('hormuz', 2, NOW);

  const [row] = listHours();
  // Three messages, two distinct hulls: a count of transits divided by this
  // is what stays meaningful when reception degrades.
  assert.equal(row.messages, 3);
  assert.equal(row.vessels, 2);

  recordRegionObservation('nowhere', 5, NOW);
  assert.equal(listHours().length, 1);
});
