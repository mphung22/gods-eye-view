#!/usr/bin/env node
/**
 * Convert a real-estate CSV export into the bundled `.geojsonl` the
 * `local-realestate` layer loads.
 *
 * The layer reads one GeoJSON Feature per line, the same shape the datacenter
 * and dam datasets use. This script owns the CSV -> Feature mapping so the
 * runtime never parses CSV and never guesses at column names.
 *
 * Usage:
 *   node scripts/build-real-estate-dataset.mjs <input.csv> [output.geojsonl]
 *
 * Required columns: lat, lon (or latitude/longitude).
 * Everything else is optional and passed through when present:
 *   address, city, state, zip, status, days_on_market, list_price,
 *   rent_estimate, beds, baths, sqft, as_of, source
 *
 * Rows without a usable coordinate are skipped and counted, never silently
 * dropped — a geocoder that failed on half your rows is something you need to
 * see before the layer ships.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_OUTPUT = 'src/data/local_data/real_estate/listings.geojsonl';

/** Column aliases, lowercased. First match wins. */
const COLUMNS = {
  lat: ['lat', 'latitude', 'y'],
  lon: ['lon', 'lng', 'long', 'longitude', 'x'],
  address: ['address', 'street_address', 'addr', 'property_address'],
  city: ['city', 'locality'],
  state: ['state', 'state_code', 'region'],
  zip: ['zip', 'zipcode', 'zip_code', 'postal_code'],
  status: ['status', 'listing_status', 'sale_status'],
  days_on_market: ['days_on_market', 'dom', 'days_on_zillow', 'daysonmarket'],
  list_price: ['list_price', 'price', 'listing_price', 'asking_price'],
  rent_estimate: ['rent_estimate', 'rent', 'rental_estimate', 'rent_zestimate'],
  beds: ['beds', 'bedrooms', 'bed'],
  baths: ['baths', 'bathrooms', 'bath'],
  sqft: ['sqft', 'square_feet', 'living_area', 'area'],
  as_of: ['as_of', 'date', 'observed_at', 'snapshot_date'],
  source: ['source', 'provider', 'feed'],
};

/**
 * Parse RFC 4180-ish CSV: quoted fields, doubled quotes, embedded newlines.
 * Small and dependency-free on purpose — this runs offline over an export the
 * user already produced, not over untrusted input at runtime.
 * @param {string} text Raw CSV file contents.
 * @returns {string[][]} Rows of raw cell strings.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

/**
 * Map header cells to canonical field names.
 * @param {string[]} header Raw header cells.
 * @returns {Record<string, number>} Canonical field -> column index.
 */
export function resolveColumns(header) {
  const normalized = header.map((name) =>
    String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_'),
  );
  const resolved = {};
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    const index = normalized.findIndex((name) => aliases.includes(name));
    if (index >= 0) resolved[field] = index;
  }
  return resolved;
}

function cleanText(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function cleanNumber(value) {
  const text = String(value ?? '')
    .trim()
    .replace(/[$,]/g, '');
  if (text === '') return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Build one GeoJSON Feature from a CSV row.
 * @param {string[]} cells Raw row cells.
 * @param {Record<string, number>} columns Canonical field -> column index.
 * @param {number} ordinal Stable fallback id.
 * @returns {object|null} Feature, or null when the row has no usable point.
 */
export function rowToFeature(cells, columns, ordinal) {
  const at = (field) =>
    columns[field] === undefined ? null : cells[columns[field]];

  const lat = cleanNumber(at('lat'));
  const lon = cleanNumber(at('lon'));
  if (lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const address = cleanText(at('address'));
  const city = cleanText(at('city'));
  const state = cleanText(at('state'));
  const zip = cleanText(at('zip'));

  // The layer's label resolver reads `properties.tags.name` first, the same
  // contract the OSM-derived datasets use.
  const name = address || [city, state].filter(Boolean).join(', ') || 'Parcel';

  const properties = {
    id: ordinal,
    tags: { name },
    type: 'real_estate',
  };

  const optional = {
    address,
    city,
    state,
    zip,
    status: cleanText(at('status'))?.toLowerCase() ?? null,
    days_on_market: cleanNumber(at('days_on_market')),
    list_price: cleanNumber(at('list_price')),
    rent_estimate: cleanNumber(at('rent_estimate')),
    beds: cleanNumber(at('beds')),
    baths: cleanNumber(at('baths')),
    sqft: cleanNumber(at('sqft')),
    as_of: cleanText(at('as_of')),
    source: cleanText(at('source')),
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== null) properties[key] = value;
  }

  return {
    id: ordinal,
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [Number(lon.toFixed(6)), Number(lat.toFixed(6))],
    },
    properties,
  };
}

/**
 * Convert CSV text into newline-delimited GeoJSON.
 * @param {string} text Raw CSV contents.
 * @returns {{lines:string[], skipped:number, total:number}}
 */
export function convert(text) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('CSV is empty');
  const columns = resolveColumns(rows[0]);
  if (columns.lat === undefined || columns.lon === undefined) {
    throw new Error(
      'CSV needs latitude and longitude columns (lat/lon, latitude/longitude, or x/y)',
    );
  }

  const lines = [];
  let skipped = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const feature = rowToFeature(rows[i], columns, lines.length + 1);
    if (!feature) {
      skipped += 1;
      continue;
    }
    lines.push(JSON.stringify(feature));
  }
  return { lines, skipped, total: rows.length - 1 };
}

async function main() {
  const [input, output = DEFAULT_OUTPUT] = process.argv.slice(2);
  if (!input) {
    console.error(
      'Usage: node scripts/build-real-estate-dataset.mjs <input.csv> [output.geojsonl]',
    );
    process.exitCode = 1;
    return;
  }

  const text = await readFile(path.resolve(input), 'utf8');
  const { lines, skipped, total } = convert(text);
  await writeFile(path.resolve(output), `${lines.join('\n')}\n`, 'utf8');

  console.log(`Wrote ${lines.length} feature(s) to ${output}`);
  if (skipped > 0) {
    console.warn(
      `Skipped ${skipped} of ${total} row(s) with no usable coordinate — check the geocoding step.`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
