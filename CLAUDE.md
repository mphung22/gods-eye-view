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
`GET /api/ais-live/gaps` — `?region=hormuz` for the Strait of Hormuz and its
approaches, plus `hours`, `minSec` and `limit`.

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

## Hormuz time series (added September 2026)

`server/providers/vessels/ais-timeseries.js` keeps hourly counters that outlive
the 24h vessel cache: gate crossings in and out, dark and spoofed gaps, and
queue depth. `GET /api/ais-live/timeseries` (`?hours=`, `?by=day`).

- **A transit is a line crossing**, not a presence count — a meridian at 56.5°E
  between 25.8°N and 26.9°N, requiring BOTH fixes in the latitude band.
  Counting vessels inside a box would conflate one ship loitering all day with
  twenty passing through. The gate approximates a diagonal traffic separation
  scheme, so it is a consistent relative measure, not an authoritative count.
- **Queue depth** is vessels stopped (≤0.5 kts) in the Gulf of Oman approaches.
  `isQueued` rejects a null speed BEFORE `Number()` — the store writes
  `speed: null` whenever the AIS message carried no SOG, and `Number(null)` is
  `0`, which would have counted most of the cache as "waiting".
- **Coverage ships with every response.** A restart leaves a hole, and a quiet
  server reads exactly like a quiet strait; the counts must never travel alone.
- Stored in its OWN file (`/var/data/hormuz-timeseries.json`,
  `AIS_TIMESERIES_PATH`) because the vessel snapshot is a self-pruning 24h cache
  and this is a two-year record that cannot be rebuilt. One retention rule must
  not be able to delete the other's data.

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

## Working on this repo

- Repo: https://github.com/mphung22/gods-eye-view — a fork of
  bilawalsidhu/gods-eye-view, kept roughly in sync but with the AIS persistence
  work above layered on top.
- The linked dev machine used for past sessions has no `gh` CLI and no stored git
  credentials, so edits were made directly through the GitHub web UI as the repo
  owner (mphung22) rather than via `git push` with an embedded token. A local
  clone + normal `git push` works fine if you have your own GitHub auth set up.

