import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createAuth } from './opensky.js';
import { runPoll } from './poll.js';
import { createApi } from './api.js';

const config = loadConfig();
const pool = createPool(config);

// Idempotent, so re-running on every boot is how a revised parsing rule
// reaches production without a manual migration step.
await migrate(pool);
console.log(`[sgn-arrivals] schema ready, watching ${config.airportIcao}, rules ${config.rulesVersion}`);
if (config.rulesVersionOverridden) {
  console.warn(
    `[sgn-arrivals] ⚠️  RULES_VERSION is set to "${config.rulesVersion}" but this ` +
      `code implements "${config.rulesVersionOverridden}". Unset RULES_VERSION, or ` +
      `set it to "${config.rulesVersionOverridden}".`,
  );
}
if (!config.openskyClientId || !config.openskyClientSecret) {
  console.warn(
    '[sgn-arrivals] OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET not set — ' +
      'serving reads, polling nothing.',
  );
}

const auth = createAuth(config);
let last = null;

async function tick() {
  try {
    last = await runPoll({ pool, config, auth });
    if (last.ok && (last.returned || last.inserted)) {
      console.log(
        `[sgn-arrivals] polled ${last.returned} arrival(s), inserted ${last.inserted} new`,
      );
    } else if (!last.ok) {
      console.error(`[sgn-arrivals] poll failed: ${last.error}`);
    }
  } catch (error) {
    // runPoll already swallows its own errors into the record; this catch
    // is only for something breaking outside that, e.g. the pool itself.
    console.error('[sgn-arrivals] tick failed unexpectedly:', error?.message || error);
  }
}

await tick();
const timer = setInterval(tick, config.pollIntervalMs);

const server = createApi({ pool, config, poller: { lastPoll: () => last } });
server.listen(config.port, () => {
  console.log(`[sgn-arrivals] listening on ${config.port}`);
});

async function shutdown(signal) {
  console.log(`[sgn-arrivals] ${signal}: shutting down`);
  clearInterval(timer);
  server.close();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
