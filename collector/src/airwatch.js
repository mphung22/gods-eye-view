// Turning airspace polls into rows.
//
// Structurally the same as ingest.js, and deliberately so: the failure mode is
// identical. A quiet sky and a dead API call both produce zero aircraft, so
// every hour records how many polls were ATTEMPTED alongside how many
// succeeded. A count without that denominator is not evidence of anything.
//
// Two levels of detail, for the same reason the ship side has two:
//
//   - Every aircraft contributes to the hourly totals, which is the
//     denominator — how much was in the sky at all.
//   - Only WATCHWORTHY contacts get individual rows. Storing every airliner
//     over the Gulf would be millions of rows a year on a small database to
//     no purpose.
//
// The keep-or-drop test is deliberately wide and deliberately crude, because
// narrowing it later is a view change and widening it later cannot recover
// contacts that were never written down.

import { AIRSPACES, isWatchworthy } from './domain/airspaces.js';

/** Contacts not seen for this long are forgotten from the roster. */
const ROSTER_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Create the airwatch pipeline.
 *
 * @param {object} [options]
 * @param {string} [options.rulesVersion] Stamped onto every raw row.
 * @returns {object} Pipeline with `record`, `drain`, `stats` and `diagnostics`.
 */
export function createAirwatch(options = {}) {
  const { rulesVersion = 'r1' } = options;

  let pendingContacts = [];
  /** @type {Map<string, object>} `${airspace}|${hourIso}` -> counters. */
  let airspaceHours = new Map();
  /** @type {Map<string, Set<string>>} `${airspace}|${hourIso}` -> icao24s. */
  const rosters = new Map();
  /** @type {Map<string, object>} airspace -> newest poll outcome, for /diagnostics. */
  const lastPoll = new Map();

  function hourIso(nowMs) {
    return new Date(Math.floor(nowMs / 3_600_000) * 3_600_000).toISOString();
  }

  function bucket(airspaceId, nowMs) {
    const key = `${airspaceId}|${hourIso(nowMs)}`;
    let row = airspaceHours.get(key);
    if (!row) {
      row = {
        airspace: airspaceId,
        hour: hourIso(nowMs),
        pollsAttempted: 0,
        pollsOk: 0,
        aircraft: 0,
        watchworthy: 0,
        contacts: 0,
      };
      airspaceHours.set(key, row);
    }
    return row;
  }

  function roster(airspaceId, nowMs) {
    const key = `${airspaceId}|${hourIso(nowMs)}`;
    let seen = rosters.get(key);
    if (!seen) {
      seen = { at: nowMs, ids: new Set(), watch: new Set() };
      rosters.set(key, seen);
      for (const [existing, value] of rosters) {
        if (nowMs - value.at > ROSTER_TTL_MS) rosters.delete(existing);
      }
    }
    seen.at = nowMs;
    return seen;
  }

  return {
    /**
     * Record the outcome of one airspace poll.
     *
     * The poll's `ok` flag is recorded whether or not any aircraft came back,
     * because that is the only thing separating "nothing was flying" from
     * "we could not look".
     *
     * @param {object} airspace Registry entry.
     * @param {{ok:boolean, contacts:object[], reason:string|null}} result
     * @param {number} [nowMs] Wall clock.
     */
    record(airspace, result, nowMs = Date.now()) {
      const row = bucket(airspace.id, nowMs);
      row.pollsAttempted += 1;
      lastPoll.set(airspace.id, {
        at: nowMs,
        ok: Boolean(result?.ok),
        reason: result?.reason ?? null,
        aircraft: result?.contacts?.length ?? 0,
      });
      if (!result?.ok) return;
      row.pollsOk += 1;

      const seen = roster(airspace.id, nowMs);
      for (const contact of result.contacts || []) {
        seen.ids.add(contact.icao24);
        if (!isWatchworthy(contact.icao24, contact.callsign)) continue;
        seen.watch.add(contact.icao24);
        // Airborne only: a military transport parked on an apron is not a
        // signal, and aprons are where most of them sit most of the time.
        if (contact.onGround) continue;
        if (contact.lat === null || contact.lon === null) continue;
        pendingContacts.push({
          airspace: airspace.id,
          icao24: contact.icao24,
          callsign: contact.callsign,
          observedAt: new Date(
            contact.observedAt ? contact.observedAt * 1000 : nowMs,
          ),
          lat: contact.lat,
          lon: contact.lon,
          altitudeM: contact.altitudeM,
          velocityMs: contact.velocityMs,
          verticalRateMs: contact.verticalRateMs,
          trueTrack: contact.trueTrack,
          originCountry: contact.originCountry,
          squawk: contact.squawk,
          rulesVersion,
        });
        row.contacts += 1;
      }
      row.aircraft = seen.ids.size;
      row.watchworthy = seen.watch.size;
    },

    /**
     * Take everything accumulated since the last drain.
     * @returns {{airContacts:object[], airspaceHours:object[]}}
     */
    drain() {
      const out = {
        airContacts: pendingContacts,
        airspaceHours: [...airspaceHours.values()],
      };
      pendingContacts = [];
      airspaceHours = new Map();
      return out;
    },

    /** @returns {object} Sizes of every bounded structure, for /health. */
    stats() {
      return {
        pendingAirContacts: pendingContacts.length,
        airRosters: rosters.size,
      };
    },

    /**
     * Per-airspace poll health.
     *
     * Reports whether the last look SUCCEEDED, not just what it saw. An
     * airspace that has never polled successfully reports zero aircraft
     * forever and reads exactly like peacetime.
     *
     * @param {number} [nowMs] Wall clock.
     * @returns {object[]} One entry per airspace.
     */
    diagnostics(nowMs = Date.now()) {
      return Object.values(AIRSPACES).map((airspace) => {
        const last = lastPoll.get(airspace.id) || null;
        const row = airspaceHours.get(`${airspace.id}|${hourIso(nowMs)}`);
        return {
          id: airspace.id,
          name: airspace.name,
          lastPollAt: last ? new Date(last.at).toISOString() : null,
          lastPollOk: last ? last.ok : null,
          lastPollReason: last ? last.reason : null,
          aircraftLastPoll: last ? last.aircraft : null,
          pollsThisHour: row?.pollsAttempted ?? 0,
          pollsOkThisHour: row?.pollsOk ?? 0,
          verdict: !last
            ? 'NEVER POLLED — no look has been attempted yet'
            : !last.ok
              ? `POLL FAILED (${last.reason}) — counts for this hour are not evidence`
              : last.aircraft === 0
                ? 'POLL OK but nothing received — genuinely empty, or no coverage here'
                : `POLL OK — ${last.aircraft} aircraft, ${row?.watchworthy ?? 0} watchworthy this hour`,
        };
      });
    },
  };
}
