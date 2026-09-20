-- sgn_arrivals shares chokepoint-db with the collector but owns its own
-- tables. Everything here is prefixed sgn_ so the two services can never
-- collide on a name even though nothing enforces a schema boundary between
-- them.

CREATE TABLE IF NOT EXISTS sgn_arrivals (
  id                    BIGSERIAL PRIMARY KEY,
  airport_icao          TEXT NOT NULL,
  icao24                TEXT NOT NULL,
  callsign              TEXT,
  est_departure_airport TEXT,
  departure_candidates  INTEGER,
  arrival_horiz_dist_m  INTEGER,
  first_seen            TIMESTAMPTZ NOT NULL,
  last_seen             TIMESTAMPTZ NOT NULL,
  -- Denormalised on write rather than computed on read: it is cheap here and
  -- it is the one column every "which hours to weight" query groups by, so
  -- it is worth being an ordinary indexed integer instead of a timezone
  -- conversion repeated in every query.
  local_hour            SMALLINT NOT NULL,
  local_date            DATE NOT NULL,
  rules_version         TEXT NOT NULL,
  inserted_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- OpenSky's own identity for one flight. Re-polling an overlapping window
  -- (the whole point of a lookback wider than the poll interval) must not
  -- duplicate a row it already has.
  UNIQUE (icao24, first_seen)
);

CREATE INDEX IF NOT EXISTS sgn_arrivals_local_date_idx ON sgn_arrivals (local_date);
CREATE INDEX IF NOT EXISTS sgn_arrivals_origin_idx ON sgn_arrivals (est_departure_airport);
CREATE INDEX IF NOT EXISTS sgn_arrivals_last_seen_idx ON sgn_arrivals (last_seen);

-- One row per poll attempt, success or failure. This is the coverage record:
-- a quiet hour in sgn_arrivals means either no landings or a collector that
-- was not running, and only this table can tell those apart — the same
-- reasoning as the chokepoint collector's service_hours.
CREATE TABLE IF NOT EXISTS sgn_polls (
  id            BIGSERIAL PRIMARY KEY,
  polled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_begin  TIMESTAMPTZ NOT NULL,
  window_end    TIMESTAMPTZ NOT NULL,
  returned      INTEGER NOT NULL,
  inserted      INTEGER NOT NULL,
  ok            BOOLEAN NOT NULL,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS sgn_polls_polled_at_idx ON sgn_polls (polled_at);
