import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createIngest } from './ingest.js';
import { writeBatch } from './store.js';
import { startAisStream } from './ais.js';
import { createApi } from './api.js';

const config = loadConfig();
const pool = createPool(config);

// Views carry every interpretation, so re-running migrations on each boot is
// how a revised threshold reaches the whole history.
await migrate(pool);
console.log(`[collector] schema ready, rules ${config.rulesVersion}`);

const ingest = createIngest({ rulesVersion: config.rulesVersion });
const stream = startAisStream(config, (envelope) => ingest.handle(envelope));

let flushing = false;
async function flush() {
  // Skip rather than queue: a slow database must not build a backlog of
  // overlapping transactions on top of an already slow database.
  if (flushing) return;
  flushing = true;
  try {
    const written = await writeBatch(pool, ingest.drain());
    if (written.crossings || written.gaps) {
      console.log(
        `[collector] wrote ${written.crossings} crossing(s), ${written.gaps} gap(s)`,
      );
    }
  } catch (error) {
    console.error('[collector] flush failed:', error?.message || error);
  } finally {
    flushing = false;
  }
}

const timer = setInterval(flush, config.flushIntervalMs);
const server = createApi({ pool, ingest, stream, config });
server.listen(config.port, () => {
  console.log(`[collector] listening on ${config.port}`);
});

/**
 * Drain before exiting. The host sends SIGTERM before a restart or redeploy,
 * and whatever is still in memory at that moment is the one thing that cannot
 * be collected again.
 */
async function shutdown(signal) {
  console.log(`[collector] ${signal}: draining`);
  clearInterval(timer);
  stream.stop();
  server.close();
  await flush();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
