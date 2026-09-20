/**
 * The rules version this CODE implements.
 *
 * It lives here rather than only in the environment because it describes the
 * detection rules in this repository — gate geometry, gap thresholds — and a
 * deployment's env var is set once and then forgotten. Moving a gate and
 * bumping this happen in the same commit, so they cannot drift.
 *
 * `RULES_VERSION` still overrides it, for re-running a historical ruleset
 * deliberately. When the two disagree the collector says so at boot and on
 * /health, because a row stamped with the wrong rules is worse than no row:
 * it claims to be comparable with history it was not produced the same way as.
 */
export const CODE_RULES_VERSION = 'r3';

/** Configuration, read once. Missing required values fail loudly at boot. */
export function loadConfig(env = process.env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (managed Postgres connection string)');
  }
  return {
    databaseUrl,
    // Absent, the collector still starts and serves reads — it simply records
    // nothing. That is a better failure than a crash loop on a missing key.
    aisKey: env.AISSTREAM_API_KEY || '',
    aisUrl: env.AISSTREAM_URL || 'wss://stream.aisstream.io/v0/stream',
    port: Number(env.PORT) || 8080,
    /**
     * Stamped onto every raw row. Detection rules — gate geometry, gap
     * thresholds — decide whether a row exists at all and cannot be
     * re-derived later, so a change here must be a visible boundary in the
     * data. Bump CODE_RULES_VERSION whenever those rules change.
     */
    rulesVersion: env.RULES_VERSION || CODE_RULES_VERSION,
    /** The code's own version, when the environment overrides it; else null. */
    rulesVersionOverridden:
      env.RULES_VERSION && env.RULES_VERSION !== CODE_RULES_VERSION
        ? CODE_RULES_VERSION
        : null,
    flushIntervalMs: Number(env.FLUSH_INTERVAL_MS) || 30_000,
    // Airwatch. Absent credentials mean the air side simply never polls —
    // the ship collector keeps running, which is the point of keeping the
    // two failure domains separate.
    openSkyClientId: env.OPENSKY_CLIENT_ID || '',
    openSkyClientSecret: env.OPENSKY_CLIENT_SECRET || '',
    /**
     * Ten minutes across three boxes is 144 rounds a day.
     *
     * Rounds are not credits. OpenSky charges by AREA, not per call, so the
     * three boxes cost different amounts and a round costs the sum of them —
     * an estimated ~7 credits, or roughly 1000 a day against a Standard
     * allowance of 4000. Comfortable, but a quarter of the budget rather than
     * the tenth "432 polls" implied before this was actually computed.
     *
     * ⚠️ That allowance is per ACCOUNT. The globe app polls OpenSky too, and
     * its provider carries a note about unbounded global polling exhausting a
     * whole day's budget in eight hours. Sharing one account between the two
     * means they eat the same 4000.
     *
     * Do not trust the estimate: /diagnostics reports the live
     * X-Rate-Limit-Remaining header, which is the real number.
     */
    airPollIntervalMs: Number(env.AIR_POLL_INTERVAL_MS) || 600_000,
    ssl: env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  };
}
