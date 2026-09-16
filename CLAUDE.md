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

