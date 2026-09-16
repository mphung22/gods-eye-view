// Maritime chokepoints: where a disproportionate share of seaborne trade has
// to pass through water narrow enough that closing it matters.
//
// One registry, because every consumer needs the same three facts about a
// chokepoint and they must not drift apart: the wider water body to analyse
// silences over, the gate to count transits across, and where vessels wait
// when they are not transiting.
//
// GATE GEOMETRY. A gate is a single line of constant latitude or longitude,
// bounded on the other axis so it spans the shipping lanes and nothing else.
// A vessel transits when two consecutive fixes fall on opposite sides of the
// line with BOTH inside the band. Every gate here approximates a traffic
// separation scheme that really runs at an angle, so the counts are a
// consistent relative measure rather than an authoritative transit tally.
// Consistency is what a time series needs; absolute level can be calibrated
// against a published count later.
//
// DIRECTION. `enclosedDirection` names the way across the line that heads
// TOWARD the enclosed sea. Crossings that way are `inbound`, the other way
// `outbound`. Which one carries the cargo that moves a price differs per
// chokepoint and is noted on each.

/**
 * @typedef {object} Gate
 * @property {'lat'|'lon'} axis Coordinate the gate line is drawn on.
 * @property {number} line Value of that coordinate.
 * @property {number} bandMin Lower bound on the OTHER axis.
 * @property {number} bandMax Upper bound on the other axis.
 * @property {'increasing'|'decreasing'} enclosedDirection Way toward the enclosed sea.
 */

export const CHOKEPOINTS = Object.freeze({
  hormuz: Object.freeze({
    id: 'hormuz',
    name: 'Strait of Hormuz',
    // Outbound is the number to watch: laden tankers leaving the Persian Gulf
    // are the fifth of world oil that transits here.
    watch: 'outbound',
    // Strait plus approaches: Gulf of Oman through to the lower Persian Gulf.
    // Wide enough to catch a vessel that goes dark before a transit and
    // reappears after it, which is the behaviour of interest.
    region: Object.freeze({
      minLat: 24.0,
      maxLat: 27.6,
      minLon: 53.8,
      maxLon: 58.8,
    }),
    // Narrowest point ~26.5N 56.3E; a meridian cuts the lanes cleanly.
    gate: Object.freeze({
      axis: 'lon',
      line: 56.5,
      bandMin: 25.8,
      bandMax: 26.9,
      enclosedDirection: 'decreasing',
    }),
    // Gulf of Oman side. A queue building here is the physical form of
    // "ships are choosing not to go through".
    queueBox: Object.freeze({
      minLat: 24.2,
      maxLat: 26.4,
      minLon: 56.6,
      maxLon: 58.8,
    }),
  }),

  babelmandeb: Object.freeze({
    id: 'babelmandeb',
    name: 'Bab el-Mandeb',
    // A through-route rather than an export terminal, so both directions
    // carry cargo and the total is what reads as reopening or closure.
    watch: 'both',
    // Southern Red Sea through the Gulf of Aden.
    region: Object.freeze({
      minLat: 10.5,
      maxLat: 16.5,
      minLon: 41.5,
      maxLon: 45.5,
    }),
    // 12°35′N 43°20′E, 26 km wide. Perim Island splits it; commercial traffic
    // predominantly uses the wider western channel, and the band spans both.
    // Transit here runs north-south, so the gate is a PARALLEL.
    gate: Object.freeze({
      axis: 'lat',
      line: 12.6,
      bandMin: 43.1,
      bandMax: 43.5,
      enclosedDirection: 'increasing',
    }),
    // Gulf of Aden approaches, where southbound traffic waits.
    queueBox: Object.freeze({
      minLat: 11.6,
      maxLat: 12.55,
      minLon: 43.0,
      maxLon: 44.8,
    }),
  }),

  bosphorus: Object.freeze({
    id: 'bosphorus',
    name: 'Bosphorus',
    // Outbound carries Russian and Kazakh crude and Ukrainian grain out of the
    // Black Sea. Arguably the cleanest of the three: almost everything that
    // leaves has to cross this line.
    watch: 'outbound',
    // The Black Sea and the Marmara approaches.
    region: Object.freeze({
      minLat: 40.4,
      maxLat: 47.4,
      minLon: 27.4,
      maxLon: 41.8,
    }),
    // 41.12N 29.07E, 750 m at its narrowest. North-south transit, so a
    // parallel again; land on both sides bounds the band naturally.
    gate: Object.freeze({
      axis: 'lat',
      line: 41.15,
      bandMin: 28.95,
      bandMax: 29.25,
      enclosedDirection: 'increasing',
    }),
    // The Black Sea anchorage north of the strait, where the well-publicised
    // tanker queues form.
    queueBox: Object.freeze({
      minLat: 41.25,
      maxLat: 41.9,
      minLon: 28.5,
      maxLon: 29.7,
    }),
  }),
});

/** @type {string[]} Registry keys, for validating a caller's request. */
export const CHOKEPOINT_IDS = Object.freeze(Object.keys(CHOKEPOINTS));

/**
 * Look up a chokepoint by id.
 * @param {string} id Registry key.
 * @returns {object|null} The chokepoint, or null when unknown.
 */
export function chokepointById(id) {
  return Object.hasOwn(CHOKEPOINTS, id) ? CHOKEPOINTS[id] : null;
}

/**
 * Whether a point falls inside a bounding box.
 * @param {number} lat Latitude, degrees.
 * @param {number} lon Longitude, degrees.
 * @param {object} box `{minLat, maxLat, minLon, maxLon}`.
 * @returns {boolean} True when inside.
 */
export function insideBox(lat, lon, box) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= box.minLat &&
    lat <= box.maxLat &&
    lon >= box.minLon &&
    lon <= box.maxLon
  );
}
