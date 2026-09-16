// Deriving cargo-relevant facts from what AIS actually carries.
//
// Everything here is an ESTIMATE from self-reported data, and the estimates
// are kept separate from the raw values on purpose: the crossing log stores
// the reported draught and length, and these functions interpret them. When a
// threshold here turns out to be wrong, the history can be re-derived. Bake
// the interpretation into the stored row and it cannot.
//
// Two warnings that belong on every number this file produces:
//   * Draught and dimensions are entered by the crew, not measured. They go
//     stale, they get typed wrong, and a vessel with something to hide can
//     simply lie. Use these distributionally across many hulls, never to
//     judge one ship.
//   * ShipType is likewise self-declared.

/** AIS ShipType codes 80-89 are tankers. */
const TANKER_MIN = 80;
const TANKER_MAX = 89;
/** 70-79 are general cargo, which includes the bulkers and boxships. */
const CARGO_MIN = 70;
const CARGO_MAX = 79;

/**
 * Laden and ballast draughts scale with hull length, so the RATIO separates
 * them without needing a per-class table of typical draughts.
 *
 * Checked across the tanker classes: a VLCC runs ~22 m on ~330 m (0.067) laden
 * and ~9 m (0.027) in ballast; an MR ~11 m on ~180 m (0.061) and ~6 m (0.033).
 * The two populations sit far enough apart that one pair of thresholds covers
 * every size, with a deliberate gap in between rather than a hard boundary —
 * a part-loaded vessel is a real thing and forcing it into one bucket would
 * invent precision.
 */
const LADEN_RATIO = 0.055;
const BALLAST_RATIO = 0.04;

/**
 * Whether an AIS ship type is a tanker.
 * @param {unknown} type Raw AIS ShipType, numeric code or descriptive string.
 * @returns {boolean} True for tanker types.
 */
export function isTanker(type) {
  const code = Number(type);
  if (Number.isFinite(code)) return code >= TANKER_MIN && code <= TANKER_MAX;
  return /tanker/i.test(String(type || ''));
}

/**
 * Coarse vessel category, for splitting a transit count into things that
 * answer different questions.
 * @param {unknown} type Raw AIS ShipType.
 * @returns {'tanker'|'cargo'|'other'} Category.
 */
export function vesselCategory(type) {
  if (isTanker(type)) return 'tanker';
  const code = Number(type);
  if (Number.isFinite(code) && code >= CARGO_MIN && code <= CARGO_MAX) {
    return 'cargo';
  }
  if (/cargo|bulk|container/i.test(String(type || ''))) return 'cargo';
  return 'other';
}

/**
 * Tanker size class from overall length.
 *
 * Boundaries follow the usual commercial classes. They are approximate, and a
 * hull near a boundary can be labelled either way — which is why capacity is
 * only ever used as a weight, never as a quantity.
 *
 * @param {unknown} lengthM Overall length in metres.
 * @returns {string|null} Class name, or null when length is unusable.
 */
export function sizeClassFromLength(lengthM) {
  const length = Number(lengthM);
  if (!Number.isFinite(length) || length <= 0) return null;
  if (length >= 300) return 'vlcc';
  if (length >= 265) return 'suezmax';
  if (length >= 230) return 'aframax';
  if (length >= 200) return 'panamax';
  if (length >= 150) return 'handy';
  return 'small';
}

/**
 * Very coarse deadweight for a size class, in thousands of tonnes.
 *
 * Used to weight a transit count so ten VLCCs do not read the same as ten
 * product tankers. It is a weight, not a cargo measurement — actual load
 * varies with the voyage and half these hulls are in ballast anyway.
 */
const APPROX_KDWT = Object.freeze({
  vlcc: 300,
  suezmax: 150,
  aframax: 110,
  panamax: 75,
  handy: 45,
  small: 20,
});

/**
 * Approximate deadweight for a size class.
 * @param {string|null} sizeClass Result of {@link sizeClassFromLength}.
 * @returns {number} Thousands of tonnes, or 0 when unknown.
 */
export function approxKdwt(sizeClass) {
  return APPROX_KDWT[sizeClass] || 0;
}

/**
 * Whether a vessel appears loaded, from reported draught against hull length.
 *
 * @param {unknown} draughtM Reported draught in metres.
 * @param {unknown} lengthM Overall length in metres.
 * @returns {'laden'|'ballast'|'partial'|null} Estimate, or null when unusable.
 */
export function ladenState(draughtM, lengthM) {
  const draught = Number(draughtM);
  const length = Number(lengthM);
  if (!Number.isFinite(draught) || draught <= 0) return null;
  if (!Number.isFinite(length) || length <= 0) return null;
  // A draught deeper than the hull is long, or a hull shorter than its
  // draught, is a typo rather than a vessel.
  const ratio = draught / length;
  if (ratio > 0.2) return null;
  if (ratio >= LADEN_RATIO) return 'laden';
  if (ratio <= BALLAST_RATIO) return 'ballast';
  return 'partial';
}

/**
 * Overall length from the AIS dimension quartet.
 *
 * AIS reports distances from the transponder to bow, stern, port and
 * starboard, so length is A + B — not a field of its own.
 *
 * @param {object} dimension `{A, B, C, D}` as AISStream delivers it.
 * @returns {number|null} Length in metres, or null when unusable.
 */
export function lengthFromDimension(dimension) {
  if (!dimension || typeof dimension !== 'object') return null;
  const bow = Number(dimension.A);
  const stern = Number(dimension.B);
  if (!Number.isFinite(bow) || !Number.isFinite(stern)) return null;
  const length = bow + stern;
  // A zero-length hull means the fields were never filled in; 500 m is longer
  // than any vessel afloat.
  if (length <= 0 || length > 500) return null;
  return length;
}
