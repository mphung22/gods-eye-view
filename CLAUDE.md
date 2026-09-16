# CLAUDE.md

Project context for Claude Code (or any AI assistant) working on this repo.

## What this is

Fork of bilawalsidhu/gods-eye-view (a live-data 3D globe: aircraft, ships, satellites,
earthquakes, wildfires, CCTV, and more), deployed by Michael Phung (GitHub: mphung22)
to Render as the service `gods-eye-view-1`.

## Hosting

- Render, Starter plan ($7/mo, 0.5 CPU / 512MB RAM).
- Persistent disk mounted at `/var/data` (added specifically so data survives
  restarts/redeploys instead of resetting to empty).
- Deliberately staying on the Starter plan for now — see "Known issue" below.

## AIS vessel persistence (added September 2026)

Vessel/AIS data used to live only in memory and was lost on every restart. Disk
persistence was added across three files:

- `server/providers/vessels/ais-store.js` — added `exportAisStreamState()` and
  `importAisStreamState()`. Persists the `_aisStreamVessels` and `_aisStreamStatic`
  Maps. Deliberately does NOT persist `_aisStreamTracks` (the recent-path ring
  buffers) — see the JSDoc there for why.
- `server/providers/vessels/ais-persist.js` (new file) — loads saved state once at
  startup, saves to disk on a 5-minute timer, and flushes once more on
  SIGTERM/SIGINT (Render sends SIGTERM before stopping or restarting an instance).
  Saves go through a temp file + rename so a crash mid-write never leaves a
  corrupt file. Save path defaults to `/var/data/ais-vessels.json`, overridable via
  the `AIS_PERSIST_PATH` env var.
- `server/providers/vessels/ais-live.js` — wires the above into `configureServer` /
  `configurePreviewServer` via a new `ensureAisPersistence()` call, guarded by an
  `_aisPersistenceStarted` flag so a Vite dev-server reload never double-starts
  the timers or re-imports stale disk state.

## AIS gap / dark-vessel detection (added September 2026)

`server/providers/vessels/ais-gaps.js` records the silences: when a vessel stops
broadcasting and later comes back, the gap is stored with both endpoints, the
distance covered while dark, and the speed that implies. Exposed at
`GET /api/ais-live/gaps` — `?region=` for a chokepoint's water (see the table
below), plus `hours`, `minSec`, `class` and `limit`.

Two clocks are used and they are NOT interchangeable:

- **AIS report epochs** (`last_position_epoch`) measure the silence as the
  vessel reported it, so the duration is a property of the vessel rather than of
  our polling or restart schedule.
- **Wall-clock ingest activity** proves the feed was delivering across that
  window. Without it, every restart would republish the whole restored cache as
  "dark vessels", since each restored row's next fix is hours newer than the one
  persisted before the restart. A silence we could not have observed is not
  reported at all.

Feed liveness is a 6KB ring of per-minute ingest marks (25h). It is deliberately
NOT persisted: it describes this process's uptime, and restoring it would let a
restart vouch for a window when nothing was running. Gap events themselves ARE
persisted, alongside the vessel rows in the same `/var/data` snapshot under a
`gaps` key; snapshots written before this feature simply restore zero.

Memory: capped at 2,000 events, pruned to the same 24h window as the vessel
cache — roughly 500KB worst case, which is immaterial against the limit below.
Tuning: `AIS_GAP_MIN_SEC` (default 3600).

Each gap carries a `classification`. The straight line between two fixes is the
SHORTEST path a vessel could have taken, so `impliedSpeedKts` is a LOWER bound
on its real speed — exceeding `AIS_MAX_PLAUSIBLE_KTS` (30) is therefore positive
evidence that an endpoint is fabricated, not just that the ship was quick. Those
are `spoofed`; the rest are `dark`. The Gulf is under heavy GNSS spoofing, so
pooling the two would measure neither. Filter with `?class=dark|spoofed`.

## Chokepoint time series (added September 2026)

`server/providers/vessels/ais-timeseries.js` keeps hourly counters that outlive
the 24h vessel cache: gate crossings in and out, dark and spoofed gaps, and
queue depth. `GET /api/ais-live/timeseries` (`?hours=`, `?by=day`,
`?chokepoint=`).

Three chokepoints, defined once in `chokepoints.js` and shared by both the gap
regions and the gate counting so the two can never describe different water:

| id | Gate | Watch |
| --- | --- | --- |
| `hormuz` | meridian 56.5E, 25.8-26.9N | `outbound` — laden Gulf exports |
| `babelmandeb` | parallel 12.6N, 43.1-43.5E | `both` — a through-route, not a terminal |
| `bosphorus` | parallel 41.15N, 28.95-29.25E | `outbound` — Russian/Kazakh crude, Ukrainian grain |

`enclosedDirection` names the way across the line that heads toward the
enclosed sea; crossings that way are `inbound`. Every gate approximates a
traffic separation scheme that really runs at an angle, so counts are a
consistent relative measure, not an authoritative tally.

- **A transit is a line crossing**, not a presence count, requiring BOTH fixes
  inside the gate's band. Counting vessels inside a box would conflate one ship
  loitering all day with twenty passing through.
- **Queue depth** is vessels stopped (≤0.5 kts) in each chokepoint's approaches
  — Gulf of Oman, Gulf of Aden, and the Black Sea anchorage north of the
  Bosphorus. One walk of the cache tests every chokepoint per row.
  `isQueued` rejects a null speed BEFORE `Number()` — the store writes
  `speed: null` whenever the AIS message carried no SOG, and `Number(null)` is
  `0`, which would have counted most of the cache as "waiting".
- **Coverage ships with every response.** A restart leaves a hole, and a quiet
  server reads exactly like a quiet strait; the counts must never travel alone.
- Stored in its OWN file (`/var/data/hormuz-timeseries.json`,
  `AIS_TIMESERIES_PATH`) because the vessel snapshot is a self-pruning 24h cache
  and this is a two-year record that cannot be rebuilt. One retention rule must
  not be able to delete the other's data.

Hourly row: `outbound`/`inbound`, `outboundTanker`/`inboundTanker`,
`outboundLaden`/`outboundBallast`, `outboundKdwt`, `dark`/`spoofed`,
`messages`/`vessels`, `queueDepth`.

**The denominator matters most.** Transits can fall because fewer ships sailed
OR because fewer were received, and those lead to opposite conclusions.
Reception degrades hardest under the same jamming that makes the count
interesting, so `transits / vessels` is the robust series and raw transits is
not safe to trade on alone.

## Crossing archive (added September 2026)

`server/providers/vessels/ais-crossings.js` keeps every individual gate
crossing — MMSI, time, position, direction, and the raw reported `type`,
`draught` and `length`. `GET /api/ais-live/crossings`.

The hourly counters are lossy by design, and every gate is an approximation. If
a gate turns out to be misplaced or a laden threshold wrong, this archive is
what makes the history **re-derivable** rather than lost. So rows store only
raw reported values; interpretation lives in `vessel-class.js` and is applied
on read, never baked in.

Append-only JSONL at `/var/data/chokepoint-crossings.jsonl`
(`AIS_CROSSINGS_PATH`): rewriting tens of megabytes every five minutes would be
real I/O and CPU on a 0.5-CPU instance. Memory holds a bounded recent window
(100k rows); startup reads only the last 8 MB of the file, discarding the
partial first record.

## Laden vs ballast (vessel-class.js)

`MaximumStaticDraught` and `Dimension` arrive in the `ShipStaticData` message
the store already parses and were previously discarded. Length is `A + B`.

Laden and ballast draughts both scale with hull length, so the **ratio**
separates them without a per-class table: a VLCC runs ~22 m on ~330 m (0.067)
laden and ~9 m (0.027) in ballast; an MR ~11 m on ~180 m (0.061) and ~6 m
(0.033). Thresholds are 0.055 laden / 0.040 ballast, with a deliberate gap so a
part-loaded vessel is not forced into a bucket.

⚠️ Draught, dimensions and ship type are all **self-reported by the crew**.
They go stale, get typed wrong, and a vessel with something to hide can simply
lie. Use them distributionally across many hulls, never to judge one ship.

This record cannot be backfilled, which changes the cost of the memory-limit
restarts below: each one now punches a hole in an unrecoverable dataset.

## Known issue: memory-limit restarts

`AISSTREAM_STALE_MS` was earlier extended from 30 minutes to 24 hours (keeps
vessels in the in-memory cache much longer), which grew the cache enough to trip
Render's 512MB Starter-plan memory limit and trigger an auto-restart (first seen
September 2026). Decision at the time: leave it as-is rather than upgrade the plan
or shrink the cache, since Render auto-recovers in under a minute and the
persistence feature above means only a few minutes of vessel history are ever lost
on a restart. Revisit if these restarts start happening often:

- Upgrade to the $25/mo tier (1 CPU / 2GB), or
- Shrink `AISSTREAM_CACHE_MAX` and/or `AISSTREAM_STALE_MS` back down in
  `server/providers/vessels/ais-store.js`.

## How work gets done on this project (read first)

The owner works from a phone, over Chrome Remote Desktop into a Windows
machine. Anything involving a browser — Render dashboard, AISStream console,
GitHub UI, the live globe — happens in a Claude with computer access running
on that machine, not in this session.

**So: whenever a task needs a browser or a dashboard, output a single
copy-pasteable block addressed to that browser-side Claude.** Not a
description of the steps, not a numbered list for a human to interpret — a
block that can be selected and pasted in one go. Assume it starts with no
context from this conversation.

A good handoff block:
- states the exact target (service name, URL, which tab)
- names what must NOT be touched, since it shares a dashboard with live services
- says precisely what to report back, and asks for raw output rather than a
  summary when the numbers are the point
- includes screenshots as a deliverable where a visual check is faster than a
  described one

**The browser-side Claude will not type or paste credentials**, even when
explicitly authorized. That is a hard rule, not a one-off caution. Write
handoff blocks so a human pastes any key or token directly into the field,
and never route a secret through either assistant.

## Working on this repo

- Repo: https://github.com/mphung22/gods-eye-view — a fork of
  bilawalsidhu/gods-eye-view, kept roughly in sync but with the AIS persistence
  work above layered on top.
- The linked dev machine used for past sessions has no `gh` CLI and no stored git
  credentials, so edits were made directly through the GitHub web UI as the repo
  owner (mphung22) rather than via `git push` with an embedded token. A local
  clone + normal `git push` works fine if you have your own GitHub auth set up.

