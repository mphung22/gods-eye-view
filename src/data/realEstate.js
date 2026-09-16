import { createLocalGeoJsonLayer } from './localGeojsonCore.js';

// Resolved by Vite in builds and relative to this module in other consumers.
const listingsUrl = new URL(
  './local_data/real_estate/listings.geojsonl',
  import.meta.url,
).href;

/**
 * Create the bundled real-estate parcel layer without starting or loading it.
 *
 * The dataset is generated offline by `scripts/build-real-estate-dataset.mjs`
 * from a CSV export, so the runtime only ever reads the same newline-delimited
 * GeoJSON the other bundled datasets use. Replacing the file is the whole
 * refresh path — no runtime fetch, no provider key.
 *
 * @param {object} services Caller-owned context, overlay and render operations.
 * @returns {object} One layer with a stable standalone identity.
 */
export function createRealEstateLayer(services) {
  return createLocalGeoJsonLayer(
    {
      id: 'local-realestate',
      url: listingsUrl,
      name: 'Real Estate',
      color: '#ff4fa3', // Magenta — distinct from the cyan/blue infrastructure pair
      icon: '⌂',
      source: 'Local',
      labels: true,
      labelMax: 600,
      labelGridPx: 140,
    },
    services,
  );
}
