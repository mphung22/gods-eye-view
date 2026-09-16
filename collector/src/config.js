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
     * data. Bump it whenever those rules change.
     */
    rulesVersion: env.RULES_VERSION || 'r1',
    flushIntervalMs: Number(env.FLUSH_INTERVAL_MS) || 30_000,
    ssl: env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  };
}
