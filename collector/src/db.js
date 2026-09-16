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
    // A collector is one writer with light bursts; a large pool only buys
    // more ways to exhaust the database's connection limit.
    max: 4,
    idleTimeoutMillis: 30_000,
  });
}

/**
 * Apply every migration, in filename order, inside one transaction each.
 *
 * Migrations are idempotent by construction (CREATE ... IF NOT EXISTS,
 * CREATE OR REPLACE VIEW), so re-running is safe and a deploy does not need
 * to know what shipped before. Views in particular MUST re-run on every boot:
 * changing an interpretation is how history gets reclassified.
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
