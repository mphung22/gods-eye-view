import WebSocket from 'ws';
import { subscriptionBoxes } from './domain/chokepoints.js';

const MESSAGE_TYPES = [
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'ShipStaticData',
  'StaticDataReport',
];
/** Silence after which the socket is assumed wedged and destroyed. */
const SILENCE_TIMEOUT_MS = 300_000;
/** Reconnect ladder. Steady-state failure must cost few attempts per hour. */
const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000];

/**
 * Connect to AISStream and feed envelopes to a handler.
 *
 * Liveness is judged by DATA, not socket state: AISStream can complete the
 * handshake and then deliver nothing, so an OPEN socket proves only that a
 * handshake once succeeded. Teardown is always `terminate()`, never `close()` —
 * close() on a black-holed socket parks it in CLOSING indefinitely and the
 * connection slot is never released.
 *
 * @param {object} config From loadConfig.
 * @param {function(object):void} onEnvelope Called per parsed envelope.
 * @returns {object} Controller with `stop` and `status`.
 */
export function startAisStream(config, onEnvelope) {
  let socket = null;
  let attempt = 0;
  let stopped = false;
  let lastMessageAt = 0;
  let watchdog = null;
  let retryTimer = null;

  function teardown() {
    if (watchdog) clearInterval(watchdog);
    watchdog = null;
    if (socket) {
      try {
        socket.terminate();
      } catch {
        // Already gone; nothing to release.
      }
    }
    socket = null;
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt += 1;
    console.warn(`[ais] reconnecting in ${delay / 1000}s (attempt ${attempt})`);
    retryTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (stopped) return;
    if (!config.aisKey) {
      console.warn('[ais] AISSTREAM_API_KEY not set; collector will record nothing');
      return;
    }

    socket = new WebSocket(config.aisUrl);

    socket.on('open', () => {
      lastMessageAt = Date.now();
      socket.send(
        JSON.stringify({
          APIKey: config.aisKey,
          // Only the chokepoint regions. A worldwide subscription spends
          // memory and, under a per-connection rate limit, message budget on
          // water nobody here asks about.
          BoundingBoxes: subscriptionBoxes(),
          FilterMessageTypes: MESSAGE_TYPES,
        }),
      );
      console.log(`[ais] subscribed to ${subscriptionBoxes().length} regions`);
    });

    socket.on('message', (raw) => {
      lastMessageAt = Date.now();
      // A delivered message is what proves the stream works, so the backoff
      // resets here rather than on 'open'.
      attempt = 0;
      let envelope;
      try {
        envelope = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (envelope?.error) {
        console.error('[ais] stream error:', envelope.error);
        return;
      }
      try {
        onEnvelope(envelope);
      } catch (error) {
        console.error('[ais] handler failed:', error?.message || error);
      }
    });

    socket.on('close', () => {
      teardown();
      scheduleReconnect();
    });

    socket.on('error', (error) => {
      console.error('[ais] socket error:', error?.message || error);
      teardown();
      scheduleReconnect();
    });

    watchdog = setInterval(() => {
      if (Date.now() - lastMessageAt < SILENCE_TIMEOUT_MS) return;
      console.warn('[ais] silent past the timeout; recycling socket');
      teardown();
      scheduleReconnect();
    }, 30_000);
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      teardown();
    },
    status() {
      return {
        connected: socket?.readyState === WebSocket.OPEN,
        lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toISOString() : null,
        silentForMs: lastMessageAt ? Date.now() - lastMessageAt : null,
        reconnectAttempt: attempt,
      };
    },
  };
}
