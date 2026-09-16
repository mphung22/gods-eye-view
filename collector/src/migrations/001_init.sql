-- Chokepoint collector schema.
--
-- ONE RULE ORGANISES EVERYTHING HERE: tables hold what was OBSERVED, views
-- hold what it MEANS. Every gate position and every threshold in this project
-- is an approximation that will be revised, and a revision must reclassify all
-- history rather than only apply going forward. Storing an interpretation is
-- how you end up with a dataset that quietly means two different things.
--
-- So `crossings` stores the reported draught and length; `v_transit_hours`
-- decides what counts as laden. Change the view, and every hour ever recorded
-- re-reads correctly.
--
-- `rules_version` on the raw tables marks the DETECTION rules — gate geometry,
-- gap thresholds — which cannot be re-derived after the fact because they
-- decide whether a row exists at all.

CREATE TABLE IF NOT EXISTS crossings (
  id            BIGSERIAL PRIMARY KEY,
  chokepoint    TEXT             NOT NULL,
  direction     TEXT             NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  mmsi          TEXT             NOT NULL,
  -- When the VESSEL said it was there, not when we stored it. Transit counts
  -- must be a property of the water, not of our uptime.
  observed_at   TIMESTAMPTZ      NOT NULL,
  ingested_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
  lat           DOUBLE PRECISION NOT NULL,
  lon           DOUBLE PRECISION NOT NULL,
  -- Self-reported by the crew: stale, sometimes wrong, occasionally a lie.
  -- Safe distributionally, never for judging one vessel.
  ship_type     TEXT,
  draught_m     REAL,
  length_m      REAL,
  rules_version TEXT             NOT NULL
);

CREATE INDEX IF NOT EXISTS crossings_chokepoint_time ON crossings (chokepoint, observed_at DESC);
CREATE INDEX IF NOT EXISTS crossings_time ON crossings (observed_at DESC);

CREATE TABLE IF NOT EXISTS gaps (
  id                BIGSERIAL PRIMARY KEY,
  chokepoint        TEXT             NULL,
  mmsi              TEXT             NOT NULL,
  started_at        TIMESTAMPTZ      NOT NULL,
  ended_at          TIMESTAMPTZ      NOT NULL,
  duration_s        INTEGER          NOT NULL,
  start_lat         DOUBLE PRECISION NOT NULL,
  start_lon         DOUBLE PRECISION NOT NULL,
  end_lat           DOUBLE PRECISION NOT NULL,
  end_lon           DOUBLE PRECISION NOT NULL,
  distance_km       REAL             NOT NULL,
  implied_speed_kts REAL             NOT NULL,
  -- Share of the silence during which the feed was provably delivering. A gap
  -- we could not have observed is not the vessel's doing.
  feed_coverage     REAL             NOT NULL,
  ingested_at       TIMESTAMPTZ      NOT NULL DEFAULT now(),
  rules_version     TEXT             NOT NULL
);

CREATE INDEX IF NOT EXISTS gaps_chokepoint_time ON gaps (chokepoint, ended_at DESC);

-- The denominator. A transit count falls either because fewer ships sailed or
-- because fewer were received, and only the ratio separates them. Reception
-- degrades hardest under the jamming that makes the count interesting.
CREATE TABLE IF NOT EXISTS region_hours (
  chokepoint    TEXT        NOT NULL,
  hour          TIMESTAMPTZ NOT NULL,
  messages      BIGINT      NOT NULL DEFAULT 0,
  vessels       INTEGER     NOT NULL DEFAULT 0,
  -- NULL is "never sampled", 0 is "sampled, nothing waiting". Collapsing them
  -- would make an unobserved hour look like an empty anchorage.
  queue_depth   REAL        NULL,
  queue_samples INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (chokepoint, hour)
);

-- Which hours the collector was actually alive. Without this a quiet server is
-- indistinguishable from a quiet strait, and every restart silently becomes a
-- fall in traffic.
CREATE TABLE IF NOT EXISTS service_hours (
  hour       TIMESTAMPTZ PRIMARY KEY,
  messages   BIGINT      NOT NULL DEFAULT 0,
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen  TIMESTAMPTZ NOT NULL
);

-- Market series, so the divergence this project exists to find is one query
-- rather than a join across two systems with different clocks.
CREATE TABLE IF NOT EXISTS market_hours (
  series TEXT        NOT NULL,
  hour   TIMESTAMPTZ NOT NULL,
  value  DOUBLE PRECISION NOT NULL,
  source TEXT        NOT NULL,
  PRIMARY KEY (series, hour)
);

-- ---------------------------------------------------------------------------
-- Interpretation. Everything below is re-derivable: change it and history
-- re-reads, because none of it was ever written down.
-- ---------------------------------------------------------------------------

-- AIS ship types 80-89 are tankers, 70-79 general cargo. The field is
-- self-declared and sometimes text rather than a code.
CREATE OR REPLACE VIEW v_crossings AS
SELECT
  c.*,
  CASE
    WHEN c.ship_type ~ '^[0-9]+$' AND c.ship_type::INT BETWEEN 80 AND 89 THEN TRUE
    WHEN c.ship_type ILIKE '%tanker%' THEN TRUE
    ELSE FALSE
  END AS is_tanker,
  CASE
    WHEN c.length_m IS NULL OR c.length_m <= 0 THEN NULL
    WHEN c.length_m >= 300 THEN 'vlcc'
    WHEN c.length_m >= 265 THEN 'suezmax'
    WHEN c.length_m >= 230 THEN 'aframax'
    WHEN c.length_m >= 200 THEN 'panamax'
    WHEN c.length_m >= 150 THEN 'handy'
    ELSE 'small'
  END AS size_class,
  -- Laden and ballast draughts both scale with hull length, so the ratio
  -- separates them without a per-class table: a VLCC runs ~0.067 laden and
  -- ~0.027 in ballast, an MR ~0.061 and ~0.033. The gap between the
  -- thresholds is deliberate — a part-loaded vessel is a real state.
  CASE
    WHEN c.draught_m IS NULL OR c.length_m IS NULL THEN NULL
    WHEN c.draught_m <= 0 OR c.length_m <= 0 THEN NULL
    WHEN c.draught_m / c.length_m > 0.2 THEN NULL
    WHEN c.draught_m / c.length_m >= 0.055 THEN 'laden'
    WHEN c.draught_m / c.length_m <= 0.040 THEN 'ballast'
    ELSE 'partial'
  END AS laden_state,
  CASE
    WHEN c.length_m IS NULL OR c.length_m <= 0 THEN 0
    WHEN c.length_m >= 300 THEN 300
    WHEN c.length_m >= 265 THEN 150
    WHEN c.length_m >= 230 THEN 110
    WHEN c.length_m >= 200 THEN 75
    WHEN c.length_m >= 150 THEN 45
    ELSE 20
  END AS approx_kdwt
FROM crossings c;

-- The straight line between two fixes is the SHORTEST path a vessel could have
-- taken, so implied speed is a LOWER bound on its real speed. Exceeding what a
-- hull can do is therefore positive evidence a position is fabricated — not
-- merely that the ship was quick.
CREATE OR REPLACE VIEW v_gaps AS
SELECT
  g.*,
  CASE WHEN g.implied_speed_kts > 30 THEN 'spoofed' ELSE 'dark' END AS classification
FROM gaps g;

CREATE OR REPLACE VIEW v_transit_hours AS
SELECT
  chokepoint,
  date_trunc('hour', observed_at) AS hour,
  count(*) FILTER (WHERE direction = 'outbound')                          AS outbound,
  count(*) FILTER (WHERE direction = 'inbound')                           AS inbound,
  count(*) FILTER (WHERE direction = 'outbound' AND is_tanker)            AS outbound_tanker,
  count(*) FILTER (WHERE direction = 'inbound' AND is_tanker)             AS inbound_tanker,
  count(*) FILTER (WHERE direction = 'outbound' AND is_tanker AND laden_state = 'laden')   AS outbound_laden,
  count(*) FILTER (WHERE direction = 'outbound' AND is_tanker AND laden_state = 'ballast') AS outbound_ballast,
  coalesce(sum(approx_kdwt) FILTER (WHERE direction = 'outbound' AND is_tanker), 0)        AS outbound_kdwt
FROM v_crossings
GROUP BY chokepoint, date_trunc('hour', observed_at);

-- The read most questions start from: counts, denominator and whether we were
-- even watching, in one row. Coverage travels with the counts by construction
-- so the two cannot be separated by accident.
CREATE OR REPLACE VIEW v_chokepoint_hours AS
SELECT
  r.chokepoint,
  r.hour,
  coalesce(t.outbound, 0)         AS outbound,
  coalesce(t.inbound, 0)          AS inbound,
  coalesce(t.outbound_tanker, 0)  AS outbound_tanker,
  coalesce(t.inbound_tanker, 0)   AS inbound_tanker,
  coalesce(t.outbound_laden, 0)   AS outbound_laden,
  coalesce(t.outbound_ballast, 0) AS outbound_ballast,
  coalesce(t.outbound_kdwt, 0)    AS outbound_kdwt,
  r.messages,
  r.vessels,
  r.queue_depth,
  (SELECT count(*) FROM v_gaps g
    WHERE g.chokepoint = r.chokepoint
      AND date_trunc('hour', g.ended_at) = r.hour
      AND g.classification = 'dark')    AS dark,
  (SELECT count(*) FROM v_gaps g
    WHERE g.chokepoint = r.chokepoint
      AND date_trunc('hour', g.ended_at) = r.hour
      AND g.classification = 'spoofed') AS spoofed,
  (s.hour IS NOT NULL)            AS observed
FROM region_hours r
LEFT JOIN v_transit_hours t ON t.chokepoint = r.chokepoint AND t.hour = r.hour
LEFT JOIN service_hours s ON s.hour = r.hour;
