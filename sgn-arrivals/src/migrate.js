import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';

const config = loadConfig();
const pool = createPool(config);
const applied = await migrate(pool);
console.log(`[sgn-arrivals] applied ${applied.length} migration(s): ${applied.join(', ')}`);
await pool.end();
