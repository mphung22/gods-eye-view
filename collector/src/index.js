import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createIngest } from './ingest.js';
import { writeBatch } from './store.js';
import { startAisStream } from './ais.js';
import { createApi } from './api.js';
import { createAirwatch } from './airwatch.js';
import { createOpenSky } from './opensky.js';
import { AIRSPACES } from './domain/airspaces.js';

const config = loadConfig();
const pool = createPool(config);

// Views carry every interpretation, so re-running migrations on each boot is
// how a revised threshold reaches the whole history.
await migrate(pool);
console.log(`[collector] schema ready, rules ${config.rulesVersion}`);
if (config.rulesVersionOverridden) {
  // Loud on purpose. Rows written now will claim to come from a ruleset that
  // is not the one running, and nothing downstream can detect that later.
  console.warn(
    `[collector] ⚠️  RULES_VERSION is set to "${config.rulesVersion}" but this ` +
      `code implements "${config.rulesVersionOverridden}". Rows are being ` +
      `stamped with the wrong ruleset. Unset RULES_VERSION, or set it to ` +
      `"${config.rulesVersionOverridden}".`,
  );
}

const ingest = createIngest({ rulesVersion: config.rulesVersion });
const airwatch = createAirwatch({ rulesVersion: config.rulesVersion });
const openSky = createOpenSky(config);
const stream = startAisStream(config, (envelope) => ingest.handle(envelope));

let flushing = false;
async function flush() {
  // Skip rather than queue: a slow database must not build a backlog of
  // overlapping transactions on top of an already slow database.
  if (flushing) return;
  flushing = true;
  try {
    const written = await writeBatch(pool, {
      ...ingest.drain(),
      ...airwatch.drain(),
    });
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

/**
 * Poll every airspace, one after another rather than at once.
 *
 * Sequential on purpose: three simultaneous requests against a credit budget
 * make a rate-limit response arrive for all three at the same moment, and the
 * cooldown then applies to a poll that never happened.
 */
let polling = false;
async function pollAirspaces() {
  if (polling) return;
  if (!config.openSkyClientId || !config.openSkyClientSecret) return;
  polling = true;
  try {
    for (const airspace of Object.values(AIRSPACES)) {
      const result = await openSky.poll(airspace);
      // Recorded whether or not it worked: a failed poll is the difference
      // between an empty sky and a blind one, and only this line knows.
      airwatch.record(airspace, result);
    }
  } catch (error) {
    console.error('[airwatch] poll failed:', error?.message || error);
  } finally {
    polling = false;
  }
}

if (config.openSkyClientId && config.openSkyClientSecret) {
  console.log(
    `[airwatch] polling ${Object.keys(AIRSPACES).length} airspaces every ${Math.round(config.airPollIntervalMs / 60000)} min`,
  );
  pollAirspaces();
} else {
  console.warn('[airwatch] OPENSKY_CLIENT_ID/SECRET not set; air side will record nothing');
}
const airTimer = setInterval(pollAirspaces, config.airPollIntervalMs);

const timer = setInterval(flush, config.flushIntervalMs);
const server = createApi({ pool, ingest, stream, config, airwatch, openSky });
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
  clearInterval(airTimer);
  stream.stop();
  server.close();
  await flush();
  await pool.end().catch(() => {});
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
