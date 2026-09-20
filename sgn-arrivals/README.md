# SGN arrivals

A standalone service that polls OpenSky for landings at Tan Son Nhat (VVTS)
and writes origin airport + local hour to Postgres. No globe, no rendering —
built to answer one question from the SEREN arrivals playbook: *which language
and which hours of the day is foot traffic actually arriving in.*

Separate from the globe app and from `chokepoint-collector` on purpose, same
reasoning as the collector's own README: a data collector wants to run
untouched for months, a visualisation you iterate on wants the opposite, and
sharing a deploy lifecycle means every unrelated push is a gap in a record
that cannot be backfilled.

It shares `chokepoint-db` with the collector rather than provisioning its own
database — this is a few dozen rows every 15 minutes, not a reason to pay for
a second managed Postgres. All of its tables are prefixed `sgn_` so the two
services can never collide on a name even though nothing enforces a schema
boundary between them.

## Why a poller, not a stream

The chokepoint collector subscribes to AISStream and reacts to messages as
they arrive. There is no equivalent live feed of *flight arrivals by origin*
— OpenSky's `/flights/arrival` is a REST endpoint you ask, not a stream that
tells you. So this service asks it on a timer instead: every `POLL_INTERVAL_MS`
it requests everyone who landed at VVTS in the last `LOOKBACK_HOURS`, and
inserts whatever it has not already recorded.

The lookback window is deliberately wider than the poll interval. OpenSky's
own arrival data trails real time — sometimes by minutes, sometimes by a
couple of hours depending on ADS-B receiver coverage over the South China
Sea approach — and a landing reported late must still land inside the window
that asks for it. The `(icao24, first_seen)` unique key on `sgn_arrivals`
makes the overlap free: re-polling the same hour twice inserts nothing the
second time.

## What it records

**`sgn_arrivals`** — one row per landing: `icao24`, `callsign`, estimated
departure airport, how many candidate departure airports OpenSky considered,
how far off the arrival-airport estimate was (a quality signal — a large
`arrival_horiz_dist_m` means OpenSky is guessing), `first_seen` /`last_seen`
(departure / landing instants), and `local_date` / `local_hour` — the landing
time split into Saigon's calendar date and hour of day, which is the column
every "which hours to weight" query groups by.

**`sgn_polls`** — one row per poll attempt, success or failure, with the
window it asked for and how many rows it returned vs. actually inserted. This
is the coverage record: a quiet hour in `sgn_arrivals` means either no
landings or a collector that was not running, and only this table tells those
two apart — same reasoning as the chokepoint collector's `service_hours`.

## Origin → language hints

`src/airports.js` is a small, hand-picked ICAO → country/city/language table
covering the hubs relevant to SEREN's language plan (English, French, German)
plus the other major sources worth naming (Korea, Japan, China, Taiwan).
Russian airports are in the table but flagged, not weighted — per the
arrivals playbook, Russian tourist traffic into Vietnam is a national,
beach-resort story (Cam Ranh / Phu Quoc charters) rather than an SGN one, so a
Moscow flight landing at VVTS is a data point, not a language decision on its
own.

An origin airport missing from the table still gets a row, just with
`country`/`city`/`language` all `null` in the API response — nothing is
dropped for being outside this table, and it is deliberately small so it is
cheap to extend once real data shows which origins actually matter.

## Running it

```bash
npm install
DATABASE_URL=postgres://... npm run migrate   # optional; start does it too
DATABASE_URL=postgres://... OPENSKY_CLIENT_ID=... OPENSKY_CLIENT_SECRET=... npm start
```

### Getting OpenSky credentials

OpenSky's REST API now exclusively supports the OAuth2 client-credentials
flow — the old username/password basic auth is no longer accepted, and this
service does not try to fall back to it. Register a free account at
[opensky-network.org](https://opensky-network.org), open **Account → API
Client**, and create a client to get `OPENSKY_CLIENT_ID` /
`OPENSKY_CLIENT_SECRET`. Tokens last 30 minutes; `src/opensky.js` caches one
and refreshes it a little early rather than reacting to a 401.

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Managed Postgres connection string (chokepoint-db) |
| `OPENSKY_CLIENT_ID` | no | Absent, it starts and serves reads but polls nothing |
| `OPENSKY_CLIENT_SECRET` | no | Same as above |
| `AIRPORT_ICAO` | no | Default `VVTS` (Tan Son Nhat) |
| `POLL_INTERVAL_MS` | no | Default `900000` (15 min) |
| `LOOKBACK_HOURS` | no | Default `6`. Must stay well under OpenSky's 2-day max window |
| `LOCAL_TIME_ZONE` | no | Default `Asia/Ho_Chi_Minh` |
| `PORT` | no | Default `8080` |
| `RULES_VERSION` | no | Default `r1`. Bump when parsing rules change |
| `PGSSL` | no | `disable` for a local Postgres without TLS |

### Deploying on Render

Same split as the collector: a **new Web Service** pointing at this repo with
**root directory `sgn-arrivals`**, build `npm install`, start `npm start`,
health check `/health`, and a **build filter on `sgn-arrivals/**`** so
neither the globe nor the collector redeploying takes this down, and vice
versa. Point `DATABASE_URL` at the existing `chokepoint-db` — do not
provision a second database. See `render-snippet.yaml` in this folder for the
exact block to add to the repo's root `render.yaml`; it is additive, so
paste it in rather than replacing anything.

## API

All read-only.

```
GET /health                  config, whether OpenSky creds are set, last poll result
GET /arrivals?hours=&limit=  raw rows, most recent first, with origin hints attached
GET /by-hour?days=           landing counts grouped by local hour (0-23)
GET /by-origin?days=         landing counts grouped by origin airport, with hints
GET /polls?limit=            poll history — tell a quiet airport from a dead collector
```

## Things that will bite you

**This is an estimate, not a manifest.** `estDepartureAirport` is OpenSky's
best guess from trajectory data, not a filed flight plan. `departureCandidates`
and `arrivalHorizDistM` are the two fields that say how confident that guess
was — a high candidate count or a large horizontal distance means treat the
origin as noisy for that row.

**Flight data answers seasonality and language mix, not "who is outside my
door right now."** The arrivals playbook says this explicitly: SGN serves a
city of ten million, so a landing here is a weak day-to-day predictor
compared to the cruise-turnaround calendar, which needed no code at all. Four
weeks of `/by-hour` and `/by-origin` is the playbook's own stated threshold
for having enough signal to be worth reading.

**A paused service loses that window forever.** There is no backfill: OpenSky
only answers for the window you ask about at the time you ask, so a Render
free-tier spin-down or a crashed poller is a permanent gap, not a delay.
Watch `/polls` for `ok: false` runs and for gaps in `polled_at` — a coverage
hole here looks exactly like a quiet airport unless you check.

**OpenSky's own rate limits are shared across every client on the account.**
The free tier's daily credit budget is not generous; if the account also
watches ship traffic or is used for anything else, `LOOKBACK_HOURS` and
`POLL_INTERVAL_MS` may need loosening rather than tightening.
