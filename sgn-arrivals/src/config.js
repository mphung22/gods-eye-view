/**
 * The rules version this CODE implements.
 *
 * Same reasoning as the chokepoint collector: it lives in code rather than
 * only in the environment because it describes the collection rules in this
 * repository (which airport, which lookback window) and an env var set once
 * at deploy time is easy to forget about. `RULES_VERSION` still overrides it,
 * for re-running a historical ruleset deliberately.
 */
export const CODE_RULES_VERSION = 'r1';

/** Configuration, read once. Missing required values fail loudly at boot. */
export function loadConfig(env = process.env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (managed Postgres connection string)');
  }
  return {
    databaseUrl,
    // Absent, the collector still starts and serves reads — it simply polls
    // nothing. Same failure mode as the chokepoint collector's missing
    // AISSTREAM_API_KEY: a crash loop on a missing secret is worse than an
    // idle service.
    openskyClientId: env.OPENSKY_CLIENT_ID || '',
    openskyClientSecret: env.OPENSKY_CLIENT_SECRET || '',
    openskyTokenUrl:
      env.OPENSKY_TOKEN_URL ||
      'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    openskyApiUrl: env.OPENSKY_API_URL || 'https://opensky-network.org/api',
    // Tan Son Nhat International. Change to watch a different airport
    // entirely, or run a second deploy of this same service for a second one
    // (Cam Ranh CXR / VVCR and Phu Quoc PQC / VVPQ are the other two feeding
    // Vietnam's tourist coasts, per the arrivals playbook's Russia note).
    airportIcao: env.AIRPORT_ICAO || 'VVTS',
    port: Number(env.PORT) || 8080,
    /** Stamped onto every row. Bump CODE_RULES_VERSION if the parsing rules change. */
    rulesVersion: env.RULES_VERSION || CODE_RULES_VERSION,
    rulesVersionOverridden:
      env.RULES_VERSION && env.RULES_VERSION !== CODE_RULES_VERSION
        ? CODE_RULES_VERSION
        : null,
    // How often to poll. OpenSky's /flights/arrival accepts at most a 2-day
    // window per call, but there is no reason to run this close to that
    // limit: a poller that only wakes every few hours risks a gap outliving
    // its own lookback if the process was down. Default 15 minutes with a
    // lookback comfortably wider than that (see lookbackHours) buys margin
    // against both.
    pollIntervalMs: Number(env.POLL_INTERVAL_MS) || 15 * 60 * 1000,
    // How far back each poll looks. Wider than the poll interval on purpose —
    // OpenSky's own arrival data trails real time by minutes to hours
    // depending on receiver coverage, and a landing reported late must still
    // fall inside the window that queries for it.
    lookbackHours: Number(env.LOOKBACK_HOURS) || 6,
    // IANA zone for the "local hour" column the whole point of this service
    // is to produce. Change only if the airport moves out of Vietnam.
    localTimeZone: env.LOCAL_TIME_ZONE || 'Asia/Ho_Chi_Minh',
    ssl: env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  };
}
