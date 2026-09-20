// Airspaces watched for military activity, and the coarse test for what is
// worth keeping a row about.
//
// This is the mirror of chokepoints.js, and it exists for the same reason: the
// boxes to poll, the classification heuristics and the reason each box is
// there must live in one place so they cannot drift apart.
//
// ⚠️ EVERY BOX HERE IS A GUESS. The Cape gate was placed by reasoning and sat
// 125 km outside anything the feed could hear; it took a measurement to find
// that out. These boxes have not been measured either. Treat their positions
// as provisional until `/diagnostics` says what is actually being received in
// them, then move them.

/**
 * Watch boxes, as OpenSky bounding boxes.
 *
 * Sizing matters for cost as well as coverage: OpenSky charges more credits
 * for a larger area, and the globe app's own notes record a day of unbounded
 * polling exhausting the entire daily budget in about eight hours. These are
 * kept moderate on purpose.
 */
export const AIRSPACES = Object.freeze({
  levant: Object.freeze({
    id: 'levant',
    name: 'Israel / Lebanon / eastern Mediterranean',
    // Tanker and ISR orbits supporting operations over the Levant sit off the
    // coast, so the box reaches west of the shoreline rather than stopping at
    // it.
    box: Object.freeze({ minLat: 30.5, maxLat: 37.0, minLon: 31.0, maxLon: 37.0 }),
    why: 'Strike aircraft, tanker orbits and ISR tracks for the Israel theatre.',
  }),

  gulf: Object.freeze({
    id: 'gulf',
    name: 'Persian Gulf and Gulf of Oman',
    box: Object.freeze({ minLat: 22.5, maxLat: 31.0, minLon: 48.0, maxLon: 60.0 }),
    why: 'Carrier air, Gulf basing, and the airspace over the Hormuz approaches.',
  }),

  iranborder: Object.freeze({
    id: 'iranborder',
    name: 'Iraq / western Iran',
    box: Object.freeze({ minLat: 30.0, maxLat: 38.0, minLon: 40.0, maxLon: 50.0 }),
    why: 'The ingress corridor, and where border-tracing ISR orbits sit.',
  }),
});

export const AIRSPACE_IDS = Object.freeze(Object.keys(AIRSPACES));

/**
 * ICAO 24-bit address ranges allocated to military operators.
 *
 * ⚠️ HEURISTIC, AND KNOWN TO BE INCOMPLETE. Real aircraft change hex codes,
 * many military aircraft do not broadcast at all, and some broadcast civil
 * addresses deliberately. This list is a WIDE net used only to decide whether
 * a row is worth storing — the precise classification happens in SQL, where
 * getting it wrong costs a view change rather than lost history.
 *
 * Widening a filter later cannot recover rows that were never written, so it
 * is deliberately generous. Narrowing later is free.
 */
export const MILITARY_HEX_RANGES = Object.freeze([
  // United States military block. The one that matters most here: US tankers
  // are what surge before a strike package flies.
  Object.freeze({ from: 0xadf7c8, to: 0xafffff, note: 'US military' }),
  // United Kingdom military.
  Object.freeze({ from: 0x43c000, to: 0x43cfff, note: 'UK military' }),
  // NATO common-fleet aircraft (AWACS and similar) register in Luxembourg.
  Object.freeze({ from: 0x4ca1f0, to: 0x4ca20f, note: 'NATO' }),
]);

/**
 * Callsign prefixes worth keeping a row about.
 *
 * ⚠️ ALSO A HEURISTIC, and a noisier one than the hex ranges. Callsigns are
 * typed in and reused; some of these appear on civilian flights. Same rule
 * applies: wide at ingest, precise in the view.
 */
export const WATCH_CALLSIGN_PREFIXES = Object.freeze([
  'RCH', // Reach — US airlift, C-17 and C-5
  'FORTE', // RQ-4 Global Hawk ISR
  'HOMER', // RC-135 signals intelligence
  'NATO', // NATO common fleet
  'MAGIC', // NATO E-3 AWACS
  'ESSO', // KC-135 tanker
  'QID', // KC-135 tanker
  'TOPCAT', // Tanker
  'PEARL', // Tanker
  'BLUE', // Tanker
  'GOLD', // Tanker
]);

/**
 * Whether a point falls inside an airspace box.
 * @param {number} lat Latitude.
 * @param {number} lon Longitude.
 * @param {object} box `{minLat, maxLat, minLon, maxLon}`.
 * @returns {boolean} True when inside.
 */
export function insideAirspace(lat, lon, box) {
  if (!box) return false;
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= box.minLat &&
    lat <= box.maxLat &&
    lon >= box.minLon &&
    lon <= box.maxLon
  );
}

/**
 * The coarse keep-or-drop test applied at ingest.
 *
 * Deliberately wide. A false positive costs one row; a false negative costs a
 * contact that can never be recovered, because the sky does not keep history.
 *
 * @param {string} icao24 24-bit address, lowercase hex.
 * @param {string|null} callsign Broadcast callsign, may be blank.
 * @returns {boolean} True when the contact is worth a row.
 */
export function isWatchworthy(icao24, callsign) {
  const hex = Number.parseInt(String(icao24 || '').trim(), 16);
  if (Number.isFinite(hex)) {
    for (const range of MILITARY_HEX_RANGES) {
      if (hex >= range.from && hex <= range.to) return true;
    }
  }
  const sign = String(callsign || '')
    .trim()
    .toUpperCase();
  if (!sign) return false;
  return WATCH_CALLSIGN_PREFIXES.some((prefix) => sign.startsWith(prefix));
}

/**
 * OpenSky query string for an airspace box.
 * @param {object} airspace Registry entry.
 * @returns {string} Query parameters, without the leading '?'.
 */
export function openSkyQuery(airspace) {
  const { minLat, maxLat, minLon, maxLon } = airspace.box;
  return `lamin=${minLat}&lomin=${minLon}&lamax=${maxLat}&lomax=${maxLon}`;
}
