import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Connect to Postgres.
 * @param {object} config From loadConfig.
 * @returns {pg.Pool} Connection pool.
 */
export function createPool(config) {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    // A poller writing a few dozen rows every 15 minutes has no use for a
    // large pool — it only buys more ways to exhaust the shared database's
    // connection limit. chokepoint-collector uses the same conservative cap.
    max: 2,
    idleTimeoutMillis: 30_000,
  });
}

/**
 * Apply every migration, in filename order.
 *
 * Idempotent by construction (CREATE ... IF NOT EXISTS), so re-running on
 * every boot is safe and a deploy does not need to know what shipped before.
 *
 * @param {object} client Anything with `query`; a pool or a test harness.
 * @returns {Promise<string[]>} Applied filenames.
 */
export async function migrate(client) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    await client.query(sql);
  }
  return files;
}
