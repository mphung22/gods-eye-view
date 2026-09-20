-- Military air activity, recorded the same way ship transits are.
--
-- The reason this exists: refuelling aircraft have to launch before a strike
-- package can fly any distance, and they broadcast position like anything
-- else. That makes an unusual tanker presence one of the few genuinely
-- FORWARD-looking signals available from public data.
--
-- The reason to be careful with it: the same signal appears before every
-- routine exercise. This table records what was seen. It does not claim the
-- seeing means anything, and §9 of the thesis lists what would show it does
-- not.

CREATE TABLE IF NOT EXISTS air_contacts (
  id               BIGSERIAL PRIMARY KEY,
  airspace         TEXT             NOT NULL,
  icao24           TEXT             NOT NULL,
  callsign         TEXT,
  -- When the aircraft reported, not when we stored it.
  observed_at      TIMESTAMPTZ      NOT NULL,
  ingested_at      TIMESTAMPTZ      NOT NULL DEFAULT now(),
  lat              DOUBLE PRECISION NOT NULL,
  lon              DOUBLE PRECISION NOT NULL,
  altitude_m       REAL,
  velocity_ms      REAL,
  vertical_rate_ms REAL,
  true_track       REAL,
  origin_country   TEXT,
  squawk           TEXT,
  rules_version    TEXT             NOT NULL
);

CREATE INDEX IF NOT EXISTS air_contacts_airspace_time
  ON air_contacts (airspace, observed_at DESC);
CREATE INDEX IF NOT EXISTS air_contacts_icao24
  ON air_contacts (icao24, observed_at DESC);

-- The denominator, and the thing that makes a zero readable.
--
-- polls_attempted vs polls_ok is the whole point. Three attempts and zero
-- successes means the hour is unobserved; three attempts and three successes
-- with no aircraft means the sky really was empty. Those lead to opposite
-- conclusions and are indistinguishable from the contact rows alone.
CREATE TABLE IF NOT EXISTS airspace_hours (
  airspace        TEXT        NOT NULL,
  hour            TIMESTAMPTZ NOT NULL,
  polls_attempted INT         NOT NULL DEFAULT 0,
  polls_ok        INT         NOT NULL DEFAULT 0,
  aircraft        INT         NOT NULL DEFAULT 0,
  watchworthy     INT         NOT NULL DEFAULT 0,
  contacts        BIGINT      NOT NULL DEFAULT 0,
  PRIMARY KEY (airspace, hour)
);

DROP VIEW IF EXISTS v_airspace_hours;
DROP VIEW IF EXISTS v_air_contacts;

CREATE VIEW v_air_contacts AS
SELECT
  c.*,
  -- ⚠️ Every classification below is a HEURISTIC over a broadcast callsign
  -- that a crew typed in. It lives in a view precisely because it is going to
  -- be wrong: changing it reclassifies all history with no backfill, which is
  -- the only reason it is safe to guess at all.
  CASE
    WHEN upper(coalesce(c.callsign, '')) ~ '^(ESSO|QID|TOPCAT|PEARL|BLUE|GOLD)' THEN 'tanker'
    WHEN upper(coalesce(c.callsign, '')) ~ '^(FORTE|HOMER|MAGIC|NATO)' THEN 'isr'
    WHEN upper(coalesce(c.callsign, '')) ~ '^RCH' THEN 'airlift'
    ELSE 'unclassified'
  END AS role,
  -- An orbit, not a transit. A tanker holding station for a strike package
  -- flies a racetrack: high, slow for its altitude, and not going anywhere.
  -- A transport crossing the same airspace is fast and straight.
  --
  -- 150 m/s is roughly 290 knots — well below cruise for these airframes, and
  -- what a holding pattern looks like averaged over a turn.
  (
    c.altitude_m IS NOT NULL AND c.altitude_m > 5000
    AND c.velocity_ms IS NOT NULL AND c.velocity_ms < 150
  ) AS loitering
FROM air_contacts c;

-- Counts joined to the coverage that makes them readable, by construction.
-- `observed` is false the moment an hour has no successful poll, and every
-- count in that row should be discarded rather than plotted.
CREATE VIEW v_airspace_hours AS
SELECT
  h.airspace,
  h.hour,
  h.polls_attempted,
  h.polls_ok,
  (h.polls_ok > 0)                       AS observed,
  h.aircraft,
  h.watchworthy,
  -- Rows written this hour, as opposed to distinct airframes. A single tanker
  -- holding an orbit for six hours is one airframe and many contacts, and the
  -- two answer different questions.
  h.contacts,
  coalesce(c.tanker, 0)                  AS tanker_contacts,
  coalesce(c.isr, 0)                     AS isr_contacts,
  coalesce(c.airlift, 0)                 AS airlift_contacts,
  coalesce(c.loitering, 0)               AS loitering_contacts,
  coalesce(c.distinct_watch, 0)          AS distinct_watch
FROM airspace_hours h
LEFT JOIN (
  SELECT
    airspace,
    date_trunc('hour', observed_at) AS hour,
    count(*) FILTER (WHERE role = 'tanker')  AS tanker,
    count(*) FILTER (WHERE role = 'isr')     AS isr,
    count(*) FILTER (WHERE role = 'airlift') AS airlift,
    count(*) FILTER (WHERE loitering)        AS loitering,
    count(DISTINCT icao24)                   AS distinct_watch
  FROM v_air_contacts
  GROUP BY airspace, date_trunc('hour', observed_at)
) c ON c.airspace = h.airspace AND c.hour = h.hour;
