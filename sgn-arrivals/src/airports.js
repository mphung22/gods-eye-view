/**
 * ICAO -> a rough country / language hint, for turning "which airport did
 * this flight come from" into "which language is worth weighting" without
 * a full airport database. Deliberately small: it covers the hubs relevant
 * to SEREN's language plan (EN / FR / DE, with RU flagged separately per the
 * arrivals playbook's note that Russian traffic is a national, beach-resort
 * story rather than an SGN one) and nothing else. Extend it as the data
 * shows up — an unmapped ICAO still gets a row, just with country/language
 * null, so nothing is silently dropped by being outside this table.
 */
export const AIRPORT_HINTS = {
  // Vietnam domestic — not a language signal, but common enough to be worth
  // naming rather than leaving as a bare code.
  VVNB: { country: 'Vietnam', city: 'Hanoi', language: null },
  VVDN: { country: 'Vietnam', city: 'Da Nang', language: null },
  VVCR: { country: 'Vietnam', city: 'Cam Ranh', language: null },
  VVPQ: { country: 'Vietnam', city: 'Phu Quoc', language: null },

  // English
  KJFK: { country: 'United States', city: 'New York JFK', language: 'en' },
  KLAX: { country: 'United States', city: 'Los Angeles', language: 'en' },
  KSFO: { country: 'United States', city: 'San Francisco', language: 'en' },
  CYYZ: { country: 'Canada', city: 'Toronto', language: 'en' },
  CYVR: { country: 'Canada', city: 'Vancouver', language: 'en' },
  EGLL: { country: 'United Kingdom', city: 'London Heathrow', language: 'en' },
  YSSY: { country: 'Australia', city: 'Sydney', language: 'en' },
  YMML: { country: 'Australia', city: 'Melbourne', language: 'en' },
  WSSS: { country: 'Singapore', city: 'Singapore', language: 'en' },

  // French
  LFPG: { country: 'France', city: 'Paris CDG', language: 'fr' },
  LFPO: { country: 'France', city: 'Paris Orly', language: 'fr' },

  // German
  EDDF: { country: 'Germany', city: 'Frankfurt', language: 'de' },
  EDDM: { country: 'Germany', city: 'Munich', language: 'de' },
  LOWW: { country: 'Austria', city: 'Vienna', language: 'de' },

  // Russian — flagged, not weighted for this airport per the playbook.
  UUEE: { country: 'Russia', city: 'Moscow Sheremetyevo', language: 'ru' },
  UUDD: { country: 'Russia', city: 'Moscow Domodedovo', language: 'ru' },

  // Other major sources worth a name even without a language action yet.
  RKSI: { country: 'South Korea', city: 'Seoul Incheon', language: 'ko' },
  RJAA: { country: 'Japan', city: 'Tokyo Narita', language: 'ja' },
  RJTT: { country: 'Japan', city: 'Tokyo Haneda', language: 'ja' },
  ZBAA: { country: 'China', city: 'Beijing Capital', language: 'zh' },
  ZSPD: { country: 'China', city: 'Shanghai Pudong', language: 'zh' },
  RCTP: { country: 'Taiwan', city: 'Taipei Taoyuan', language: 'zh' },
  VTBS: { country: 'Thailand', city: 'Bangkok Suvarnabhumi', language: null },
};

/**
 * @param {string|null} icao
 * @returns {{country: string|null, city: string|null, language: string|null}}
 */
export function hintFor(icao) {
  if (!icao) return { country: null, city: null, language: null };
  return AIRPORT_HINTS[icao] || { country: null, city: null, language: null };
}
