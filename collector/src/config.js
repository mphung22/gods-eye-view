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
export const CODE_RULES_VERSION = 'r2';

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
    ssl: env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  };
}
