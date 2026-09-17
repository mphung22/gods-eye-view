# Chokepoint collector

A standalone service that watches four maritime chokepoints and writes what it
sees to Postgres. No globe, no rendering — its only job is to still be
collecting in six months.

Separate from the GEV app on purpose. A data collector and a visualisation you
iterate on want opposite things: one wants to run untouched, the other wants to
be redeployed whenever. Sharing a process meant every globe deploy punched a
hole in the record.

## What it records

| Chokepoint | Gate | Watch |
| --- | --- | --- |
| Strait of Hormuz | meridian 56.5°E, 25.8–26.9°N | `outbound` — laden Gulf exports |
| Bab el-Mandeb | parallel 12.6°N, 43.1–43.5°E | `both` — a through-route |
| Bosphorus | parallel 41.15°N, 28.95–29.25°E | `outbound` — Russian/Kazakh crude, Ukrainian grain |
| Cape of Good Hope | meridian 20.0°E, 38–34°S | `both` — **reroute detector** |

The Cape is not a chokepoint. Rising traffic there against falling traffic at
Bab el-Mandeb means cargo is going around Africa: longer voyages, more
tonne-miles, firmer tanker rates. Both falling together means cargo is not
moving at all, which is the opposite trade.

Per chokepoint it keeps individual **crossings**, AIS **gaps** (silences),
hourly **region counters** (messages received, distinct vessels, queue depth)
and **service hours** proving the collector was alive.

## The two rules the schema is built on

**Tables hold what was observed; views hold what it means.** Every gate
position and every threshold here is an approximation that will be revised.
`crossings` stores the reported draught and length; `v_crossings` decides what
counts as laden. Change the view and all history re-reads correctly — no
backfill, no dataset that quietly means two different things. There is a test
that does exactly this.

**Counts never travel without coverage.** A restart and a closed strait produce
the same transit number and mean opposite things, so `service_hours` records
which hours the collector actually ran, and every counts response carries the
ratio alongside.

`rules_version` is stamped on raw rows because *detection* rules — gate
geometry, gap thresholds — decide whether a row exists at all and cannot be
re-derived later. Bump `RULES_VERSION` whenever you move a gate.

## Running it

```bash
npm install
DATABASE_URL=postgres://... npm run migrate   # optional; start does it too
DATABASE_URL=postgres://... AISSTREAM_API_KEY=... npm start
```

Migrations are idempotent and re-run on every boot, which is how a revised view
reaches production.

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Managed Postgres connection string |
| `AISSTREAM_API_KEY` | no | Absent, it starts and serves reads but records nothing |
| `PORT` | no | Default 8080 |
| `RULES_VERSION` | no | Default `r1`. Bump when detection rules change |
| `FLUSH_INTERVAL_MS` | no | Default 30000 |
| `PGSSL` | no | `disable` for a local Postgres without TLS |

### Deploying on Render

Create a **new Web Service** pointing at this repo with **root directory
`collector`**, build `npm install`, start `npm start`. Add a managed Postgres
and set `DATABASE_URL` from it.

Set the service's build filter to `collector/**` so changes to the globe app
don't redeploy the collector. That filter is the whole point of the split —
without it you are back to one lifecycle.

## API

All read-only.

```
GET /health                      sizes of every bounded structure, stream status, RSS
GET /diagnostics                 why a chokepoint reads zero — see below
GET /hours?chokepoint=&hours=    hourly counts + denominator + coverage
GET /days?chokepoint=&hours=     daily rollup
GET /crossings?chokepoint=&hours=&limit=   raw rows, interpreted on read
GET /gaps?chokepoint=&class=&hours=        dark / spoofed silences
```

## Things that will bite you

**The gates are unvalidated.** They are straight lines approximating traffic
separation schemes that run at an angle. They produce *consistent relative*
counts; the absolute level means nothing until compared against a published
figure. A gate placed wrong returns zero forever and looks exactly like a
closed strait — it does not error. Check `/days` after 24 hours: the Bosphorus
is the canary, since it normally runs 100+ transits a day.

**A zero has four causes and `/hours` cannot tell them apart.** `messages` and
`vessels` separate "no ships" from "no reception" at the level of a *region*,
but a region is a whole sea and a gate is a line across one strait. A healthy
vessel count for the Black Sea says nothing about whether anything was received
near Istanbul. `/diagnostics` closes that gap, reading live memory rather than
the database, and names which case each chokepoint is in:

| Verdict | Meaning |
| --- | --- |
| `NO COVERAGE` | Nothing received in the region at all. The feed does not reach this water. |
| `COVERAGE OFF-GATE` | Vessels received, but the nearest is far from the gate. Reports the distance. |
| `AT GATE` | Vessels within 50 km, none yet past the ±0.02° hysteresis margin. Usually just early. |
| `ONE-SIDED` | Vessels settle on only one side. A crossing needs both — suspect the gate or the band. |
| `HEALTHY` | Both sides populated; crossings should accrue. |

`observedBox` is the corner of the water that actually delivered, as opposed to
the region subscribed to. The gap between those two boxes is the measurement.

**Draught, dimensions and ship type are typed in by crews.** They go stale,
they are wrong sometimes, and a vessel with something to hide can simply lie —
a live concern in exactly these waters. Everything derived from them is only
safe across many hulls, never for judging one ship.

**Transits are jitter-filtered.** A vessel must clear a ~2 km margin either
side of the line before its side is considered settled. Without that, one
anchored ship under GNSS spoofing manufactures dozens of transits a day.

**Watch `/health` memory.** Every map that can grow with the world's shipping
is bounded by age and size, and `/health` reports all of them. If any climbs
steadily, that is the bug to chase before it becomes an out-of-memory restart —
and a restart now costs data that cannot be re-collected.
