import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localInfrastructureOverlayCopy } from 'gods-eye-view/infrastructure/geojson';
import { createRealEstateLayer } from './realEstate.js';
import {
  convert,
  resolveColumns,
  rowToFeature,
} from '../../scripts/build-real-estate-dataset.mjs';

function services() {
  const records = new Map();
  return {
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    registerEntityContext(entity, metadata) {
      records.set(metadata.id, { entity, ...metadata });
    },
    selectEntityContext() {},
    clearSelectedEntityContextForLayer() {},
    removeEntityContextsForLayer(id) {
      for (const [key, record] of records)
        if (record.layerId === id) records.delete(key);
    },
    governorRequestRender() {},
  };
}

test('factory preserves identity and creates independent state without loading', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('factory must not fetch');
  });
  const first = createRealEstateLayer(services());
  const second = createRealEstateLayer(services());

  assert.equal(first.id, 'local-realestate');
  assert.equal(first.name, 'Real Estate');
  assert.equal(first.source, 'Local');
  assert.notEqual(first, second);
  assert.deepEqual(first.getStats(), {
    count: 0,
    lastUpdate: null,
    error: null,
  });

  first.destroy();
  second.destroy();
});

test('bundled dataset is newline-delimited point features the layer can read', () => {
  const url = new URL(
    './local_data/real_estate/listings.geojsonl',
    import.meta.url,
  );
  const lines = readFileSync(url, 'utf8').trim().split('\n');
  assert.ok(lines.length > 0);

  for (const line of lines) {
    const feature = JSON.parse(line);
    assert.equal(feature.type, 'Feature');
    assert.equal(feature.geometry.type, 'Point');
    const [lon, lat] = feature.geometry.coordinates;
    assert.ok(Number.isFinite(lon) && lon >= -180 && lon <= 180);
    assert.ok(Number.isFinite(lat) && lat >= -90 && lat <= 90);
    // The label resolver reads tags.name first; a nameless parcel renders as
    // the bare layer title, which is useless on a globe full of pins.
    assert.ok(feature.properties.tags.name);
  }
});

test('card copy leads with status, price and days on market', () => {
  const copy = localInfrastructureOverlayCopy(
    {
      tags: { name: '2301 E 7th St' },
      status: 'foreclosure',
      list_price: 398000,
      days_on_market: 186,
      beds: 2,
      baths: 1,
      sqft: 1090,
      rent_estimate: 2350,
    },
    'local-realestate',
  );

  assert.equal(copy.title, '2301 E 7th St');
  assert.deepEqual(copy.details, [
    'Foreclosure · $398K · 186 DOM',
    '2bd · 1ba · 1,090 sqft',
    'Rent/price 0.59%',
  ]);
});

test('card copy omits lines it has no data for', () => {
  const copy = localInfrastructureOverlayCopy(
    { tags: { name: 'Unlisted Parcel' } },
    'local-realestate',
  );
  assert.equal(copy.title, 'Unlisted Parcel');
  assert.deepEqual(copy.details, []);

  const priceOnly = localInfrastructureOverlayCopy(
    { tags: { name: 'Parcel' }, list_price: 1_250_000 },
    'local-realestate',
  );
  // A price with no rent must not invent a ratio.
  assert.deepEqual(priceOnly.details, ['$1.25M']);
});

test('converter maps aliased columns and keeps optional fields sparse', () => {
  const columns = resolveColumns([
    'Street Address',
    'Latitude',
    'LONGITUDE',
    'DOM',
  ]);
  assert.equal(columns.address, 0);
  assert.equal(columns.lat, 1);
  assert.equal(columns.lon, 2);
  assert.equal(columns.days_on_market, 3);

  const feature = rowToFeature(['9 Elm St', '30.2', '-97.7', '12'], columns, 4);
  assert.deepEqual(feature.geometry.coordinates, [-97.7, 30.2]);
  assert.equal(feature.properties.tags.name, '9 Elm St');
  assert.equal(feature.properties.days_on_market, 12);
  assert.ok(!('list_price' in feature.properties));
});

test('converter strips currency formatting and skips uncoordinated rows', () => {
  const csv = [
    'address,lat,lon,list_price',
    '"1 Main St, Unit 2",30.1,-97.8,"$615,000"',
    'No Geocode,,,"$400,000"',
    'Out Of Range,91,-97.8,"$400,000"',
  ].join('\n');

  const { lines, skipped, total } = convert(csv);
  assert.equal(total, 3);
  assert.equal(skipped, 2);
  assert.equal(lines.length, 1);

  const feature = JSON.parse(lines[0]);
  assert.equal(feature.properties.tags.name, '1 Main St, Unit 2');
  assert.equal(feature.properties.list_price, 615000);
});

test('converter refuses a CSV with no coordinate columns', () => {
  assert.throws(
    () => convert('address,price\n1 Main St,100'),
    /latitude and longitude/,
  );
});
