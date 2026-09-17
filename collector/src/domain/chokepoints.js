// Maritime chokepoints: where a disproportionate share of seaborne trade has
// to cross water narrow enough that closing it matters.
//
// One registry, because every consumer needs the same facts and they must not
// drift apart: the water to analyse silences over, the line to count transits
// across, and where vessels wait when they are not transiting.
//
// A gate is one line of constant latitude or longitude, bounded on the other
// axis so it spans the shipping lanes and nothing else. Every gate here
// approximates a traffic separation scheme that really runs at an angle, so
// counts are a consistent RELATIVE measure, not an authoritative tally.
//
// `enclosedDirection` names the way across the line heading toward the
// enclosed sea; crossings that way are `inbound`.

export const CHOKEPOINTS = Object.freeze({
  hormuz: Object.freeze({
    id: 'hormuz',
    name: 'Strait of Hormuz',
    // Laden tankers leaving the Persian Gulf are the fifth of world oil.
    watch: 'outbound',
    region: Object.freeze({ minLat: 24.0, maxLat: 27.6, minLon: 53.8, maxLon: 58.8 }),
    gate: Object.freeze({
      axis: 'lon',
      line: 56.5,
      bandMin: 25.8,
      bandMax: 26.9,
      enclosedDirection: 'decreasing',
    }),
    queueBox: Object.freeze({ minLat: 24.2, maxLat: 26.4, minLon: 56.6, maxLon: 58.8 }),
  }),

  babelmandeb: Object.freeze({
    id: 'babelmandeb',
    name: 'Bab el-Mandeb',
    // A through-route rather than an export terminal: both directions carry
    // cargo, so the total is what reads as reopening or closure.
    watch: 'both',
    region: Object.freeze({ minLat: 10.5, maxLat: 16.5, minLon: 41.5, maxLon: 45.5 }),
    // 12deg35'N 43deg20'E, 26 km wide. Perim Island splits it; commercial
    // traffic favours the wider western channel and the band spans both.
    gate: Object.freeze({
      axis: 'lat',
      line: 12.6,
      bandMin: 43.1,
      bandMax: 43.5,
      enclosedDirection: 'increasing',
    }),
    queueBox: Object.freeze({ minLat: 11.6, maxLat: 12.55, minLon: 43.0, maxLon: 44.8 }),
  }),

  bosphorus: Object.freeze({
    id: 'bosphorus',
    name: 'Bosphorus',
    // Almost everything leaving the Black Sea crosses this line: Russian and
    // Kazakh crude, Ukrainian grain.
    watch: 'outbound',
    region: Object.freeze({ minLat: 40.4, maxLat: 47.4, minLon: 27.4, maxLon: 41.8 }),
    // 41.12N 29.07E, 750 m at its narrowest; land bounds the band naturally.
    gate: Object.freeze({
      axis: 'lat',
      line: 41.15,
      bandMin: 28.95,
      bandMax: 29.25,
      enclosedDirection: 'increasing',
    }),
    queueBox: Object.freeze({ minLat: 41.25, maxLat: 41.9, minLon: 28.5, maxLon: 29.7 }),
  }),

  goodhope: Object.freeze({
    id: 'goodhope',
    name: 'Cape of Good Hope',
    // Not a chokepoint — a REROUTE DETECTOR. When Bab el-Mandeb closes,
    // cargo goes around Africa. Rising traffic here against falling traffic
    // there means rerouting: longer voyages, more tonne-miles, firmer tanker
    // rates. Both falling together means cargo is not moving at all, which is
    // the opposite trade.
    watch: 'both',
    region: Object.freeze({ minLat: -40.0, maxLat: -30.0, minLon: 14.0, maxLon: 24.0 }),
    // A meridian south of the Cape, spanning the deep-water routing well
    // offshore of coastal traffic.
    gate: Object.freeze({
      axis: 'lon',
      line: 20.0,
      bandMin: -38.0,
      bandMax: -34.0,
      enclosedDirection: 'decreasing',
    }),
    queueBox: null,
  }),
});

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
 * @param {object|null} box `{minLat, maxLat, minLon, maxLon}`.
 * @returns {boolean} True when inside.
 */
export function insideBox(lat, lon, box) {
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
 * Distance from a point to the nearest part of a gate.
 *
 * A gate is a line SEGMENT — constant along one axis, bounded on the other —
 * so the distance has two independent components: how far past the line the
 * point sits, and how far outside the lane band it sits. Collapsing them into
 * one number is what makes this readable. "The nearest vessel we received is
 * 180 km from the Bosphorus gate" answers, in a single figure, a question that
 * otherwise needs a map.
 *
 * Degrees are converted flat-earth, which is accurate to well under a percent
 * at the scale a chokepoint spans and does not need to be better: this is a
 * coverage diagnostic and never an input to a count.
 *
 * @param {object} gate Gate definition.
 * @param {number} lat Latitude, degrees.
 * @param {number} lon Longitude, degrees.
 * @returns {number|null} Kilometres, or null when the point is unusable.
 */
export function distanceToGateKm(gate, lat, lon) {
  if (!gate || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const along = gate.axis === 'lat' ? lat : lon;
  const across = gate.axis === 'lat' ? lon : lat;

  const alongOffset = Math.abs(along - gate.line);
  const acrossOffset =
    across < gate.bandMin
      ? gate.bandMin - across
      : across > gate.bandMax
        ? across - gate.bandMax
        : 0;

  const KM_PER_DEG = 111.32;
  // Longitude degrees shrink toward the poles; latitude degrees do not.
  const lonScale = KM_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const alongKm = alongOffset * (gate.axis === 'lat' ? KM_PER_DEG : lonScale);
  const acrossKm = acrossOffset * (gate.axis === 'lat' ? lonScale : KM_PER_DEG);
  return Math.hypot(alongKm, acrossKm);
}

/**
 * AISStream subscription boxes covering every chokepoint region.
 *
 * Subscribing worldwide costs memory and message budget on water nobody here
 * asks about, and under a per-connection rate limit it actively starves the
 * regions that matter.
 *
 * @returns {number[][][]} Boxes as AISStream expects them: [[[lat,lon],[lat,lon]]].
 */
export function subscriptionBoxes() {
  return Object.values(CHOKEPOINTS).map((c) => [
    [c.region.minLat, c.region.minLon],
    [c.region.maxLat, c.region.maxLon],
  ]);
}
