-- Keep vessel static data, and use it to fill gaps in past crossings.
--
-- Two of the first five crossings recorded had no ship type, draught or
-- length at all. A crossing is enriched from whatever static report happened
-- to arrive before the vessel reached the gate, and static reports are far
-- rarer than position reports — so a hull first heard near the line crosses it
-- anonymously, and stays anonymous forever.
--
-- Worse, that table lived only in memory. Every restart threw away everything
-- known about every vessel, so the miss rate reset to maximum on each deploy.

CREATE TABLE IF NOT EXISTS vessel_static (
  mmsi        TEXT PRIMARY KEY,
  ship_type   TEXT,
  draught_m   REAL,
  length_m    REAL,
  reported_at TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Views are rebuilt rather than replaced: CREATE OR REPLACE cannot change a
-- view's column list, and v_crossings gains columns here. Dropping in
-- dependency order keeps this re-runnable on every boot.
DROP VIEW IF EXISTS v_chokepoint_hours;
DROP VIEW IF EXISTS v_transit_hours;
DROP VIEW IF EXISTS v_crossings;

CREATE VIEW v_crossings AS
WITH filled AS (
  SELECT
    c.id,
    c.chokepoint,
    c.direction,
    c.mmsi,
    c.observed_at,
    c.ingested_at,
    c.lat,
    c.lon,
    c.rules_version,
    -- Ship type and length are vessel IDENTITY. A hull does not change its
    -- type or grow between voyages, so a report that arrives later describes
    -- the ship that crossed just as well as one that arrived earlier. Filling
    -- these in is recovering an observation, not guessing.
    coalesce(c.ship_type, s.ship_type) AS ship_type,
    coalesce(c.length_m, s.length_m)   AS length_m,
    -- Draught is voyage STATE, and it is deliberately NOT filled in.
    --
    -- A vessel rides deep laden and high in ballast, so a draught reported
    -- after the crossing may describe the opposite condition to the one it
    -- crossed in. Backfilling it would silently relabel laden as ballast and
    -- corrupt the one series the thesis actually rests on. A null draught is
    -- the honest answer: we did not observe the vessel's load state in time.
    c.draught_m,
    (c.ship_type IS NULL AND s.ship_type IS NOT NULL)
      OR (c.length_m IS NULL AND s.length_m IS NOT NULL) AS identity_backfilled
  FROM crossings c
  LEFT JOIN vessel_static s ON s.mmsi = c.mmsi
)
SELECT
  f.*,
  CASE
    WHEN f.ship_type ~ '^[0-9]+$' AND f.ship_type::INT BETWEEN 80 AND 89 THEN TRUE
    WHEN f.ship_type ILIKE '%tanker%' THEN TRUE
    ELSE FALSE
  END AS is_tanker,
  -- Size class and deadweight are TANKER nomenclature and a tanker
  -- length-to-deadweight curve. Applied to a container ship they produce
  -- confident nonsense — a 366 m boxship came back "vlcc", "ballast", 300k
  -- dwt, when a ULCV of that length carries well under half that and 14.5 m
  -- is a normal working draught rather than an empty one.
  --
  -- The hourly views already filter on is_tanker, so the aggregates were never
  -- wrong. The per-row labels were, and anyone reading raw rows saw them. They
  -- are now null for anything that is not a tanker.
  CASE
    WHEN NOT (
      (f.ship_type ~ '^[0-9]+$' AND f.ship_type::INT BETWEEN 80 AND 89)
      OR f.ship_type ILIKE '%tanker%'
    ) THEN NULL
    WHEN f.length_m IS NULL OR f.length_m <= 0 THEN NULL
    WHEN f.length_m >= 300 THEN 'vlcc'
    WHEN f.length_m >= 265 THEN 'suezmax'
    WHEN f.length_m >= 230 THEN 'aframax'
    WHEN f.length_m >= 200 THEN 'panamax'
    WHEN f.length_m >= 150 THEN 'handy'
    ELSE 'small'
  END AS size_class,
  -- Laden and ballast draughts both scale with hull length, so the ratio
  -- separates them without a per-class table: a VLCC runs ~0.067 laden and
  -- ~0.027 in ballast, an MR ~0.061 and ~0.033. The gap between the
  -- thresholds is deliberate — a part-loaded vessel is a real state.
  --
  -- Tankers only, for the same reason. Container ships are volume-limited
  -- rather than weight-limited and sit far shallower for their length, so the
  -- tanker ratios read a normally-loaded boxship as empty.
  CASE
    WHEN NOT (
      (f.ship_type ~ '^[0-9]+$' AND f.ship_type::INT BETWEEN 80 AND 89)
      OR f.ship_type ILIKE '%tanker%'
    ) THEN NULL
    WHEN f.draught_m IS NULL OR f.length_m IS NULL THEN NULL
    WHEN f.draught_m <= 0 OR f.length_m <= 0 THEN NULL
    WHEN f.draught_m / f.length_m > 0.2 THEN NULL
    WHEN f.draught_m / f.length_m >= 0.055 THEN 'laden'
    WHEN f.draught_m / f.length_m <= 0.040 THEN 'ballast'
    ELSE 'partial'
  END AS laden_state,
  CASE
    WHEN NOT (
      (f.ship_type ~ '^[0-9]+$' AND f.ship_type::INT BETWEEN 80 AND 89)
      OR f.ship_type ILIKE '%tanker%'
    ) THEN 0
    WHEN f.length_m IS NULL OR f.length_m <= 0 THEN 0
    WHEN f.length_m >= 300 THEN 300
    WHEN f.length_m >= 265 THEN 150
    WHEN f.length_m >= 230 THEN 110
    WHEN f.length_m >= 200 THEN 75
    WHEN f.length_m >= 150 THEN 45
    ELSE 20
  END AS approx_kdwt
FROM filled f;

CREATE VIEW v_transit_hours AS
SELECT
  chokepoint,
  date_trunc('hour', observed_at) AS hour,
  count(*) FILTER (WHERE direction = 'outbound')                          AS outbound,
  count(*) FILTER (WHERE direction = 'inbound')                           AS inbound,
  count(*) FILTER (WHERE direction = 'outbound' AND is_tanker)            AS outbound_tanker,
  count(*) FILTER (WHERE direction = 'inbound' AND is_tanker)             AS inbound_tanker,
  count(*) FILTER (WHERE direction = 'outbound' AND is_tanker AND laden_state = 'laden')   AS outbound_laden,
  count(*) FILTER (WHERE direction = 'outbound' AND is_tanker AND laden_state = 'ballast') AS outbound_ballast,
  coalesce(sum(approx_kdwt) FILTER (WHERE direction = 'outbound' AND is_tanker), 0)        AS outbound_kdwt,
  -- How much of the hour's traffic could be described at all. Without it a
  -- drop in outbound_tanker cannot be told apart from a drop in how many
  -- hulls happened to have sent a static report — the same denominator
  -- problem as coverage, one level down.
  count(*) FILTER (WHERE ship_type IS NULL)                               AS unidentified
FROM v_crossings
GROUP BY chokepoint, date_trunc('hour', observed_at);

CREATE VIEW v_chokepoint_hours AS
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
  coalesce(t.unidentified, 0)     AS unidentified,
  r.messages,
  r.vessels,
  r.queue_depth,
  -- Unchanged from 001, including bucketing gaps by ended_at: a silence is
  -- attributed to the hour it was RESOLVED, because that is the hour we
  -- learned of it. Only `unidentified` is new here.
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
