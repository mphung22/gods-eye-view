import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';

const config = loadConfig();
const pool = createPool(config);
try {
  const applied = await migrate(pool);
  console.log(`[migrate] applied ${applied.length} file(s): ${applied.join(', ')}`);
} finally {
  await pool.end();
}
