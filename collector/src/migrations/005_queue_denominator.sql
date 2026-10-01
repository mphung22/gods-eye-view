-- Give the queue its denominator.
--
-- Two weeks of Cape Town readings showed `queue_depth` is not a measure of the
-- anchorage. It is a measure of the receiver.
--
--   2026-09-18  depth 102      2026-09-30 00:00  depth 191   msgs/h 3,248
--   2026-09-30  depth 184      2026-10-01 01:00  depth  95   msgs/h 2,107
--
-- Nothing left Table Bay at one in the morning. The collector restarted, the
-- feed came back at half its previous message rate, and the depth halved with
-- it — 0.51 against 0.52, to two decimals the same ratio. Across all 311 hours
-- with a reading, depth correlates +0.75 with message volume and +0.60 with
-- messages per vessel, which is reception quality with the vessel count
-- divided out.
--
-- This is exactly the failure the transit counts were built to avoid, arriving
-- one table along: a count shipped without the thing it has to be read
-- against. The crossing series survived the same restart unmoved (+0.06
-- against messages per vessel) because `messages` and `vessels` sit beside it.
-- The queue had nothing beside it at all.
--
-- So two columns, both of them observations rather than interpretations:
--
--   queue_seen    every vessel inside the same box, moving or not
--   queue_tracked the size of the whole fix table at sweep time
--
-- `queue_seen` is the denominator that matters. Halve the reception and both
-- it and `queue_depth` halve, so the SHARE holds — which is the question
-- actually being asked: of the ships off Cape Town, what fraction are sitting
-- still? `queue_tracked` separates the two ways the denominator itself can be
-- small: a cold cache after a restart, or a receiver having a bad night.
--
-- Both are NULL for every hour recorded before this migration. That is
-- correct and must stay correct: those hours were not measured this way, and
-- back-filling a plausible number is how a dataset comes to mean two things.
-- `queue_share` is therefore NULL for all of them too, and the fourteen days
-- of depth already collected stay exactly as readable — or as unreadable — as
-- they always were.

ALTER TABLE region_hours ADD COLUMN IF NOT EXISTS queue_seen    REAL NULL;
ALTER TABLE region_hours ADD COLUMN IF NOT EXISTS queue_tracked REAL NULL;

DROP VIEW IF EXISTS v_chokepoint_hours;

CREATE VIEW v_chokepoint_hours AS
SELECT
  r.chokepoint,
  r.hour,
  coalesce(t.outbound, 0)          AS outbound,
  coalesce(t.inbound, 0)           AS inbound,
  coalesce(t.outbound_tanker, 0)   AS outbound_tanker,
  coalesce(t.inbound_tanker, 0)    AS inbound_tanker,
  coalesce(t.outbound_laden, 0)    AS outbound_laden,
  coalesce(t.outbound_ballast, 0)  AS outbound_ballast,
  coalesce(t.outbound_kdwt, 0)     AS outbound_kdwt,
  coalesce(t.unidentified, 0)      AS unidentified,
  coalesce(t.outbound_hull_m, 0)   AS outbound_hull_m,
  coalesce(t.inbound_hull_m, 0)    AS inbound_hull_m,
  coalesce(t.outbound_measured, 0) AS outbound_measured,
  coalesce(t.inbound_measured, 0)  AS inbound_measured,
  coalesce(t.cargo, 0)             AS cargo,
  coalesce(t.passenger, 0)         AS passenger,
  r.messages,
  r.vessels,
  r.queue_depth,
  r.queue_seen,
  r.queue_tracked,
  -- The reading to trend. NULL rather than zero when the box was empty: no
  -- ships off Cape Town is not the same observation as none of them waiting,
  -- and a zero here would be averaged into a fortnight as though it were.
  CASE
    WHEN r.queue_seen IS NULL OR r.queue_seen <= 0 THEN NULL
    ELSE round((r.queue_depth / r.queue_seen)::NUMERIC, 3)
  END AS queue_share,
  (SELECT count(*) FROM v_gaps g
    WHERE g.chokepoint = r.chokepoint
      AND date_trunc('hour', g.ended_at) = r.hour
      AND g.classification = 'dark')    AS dark,
  (SELECT count(*) FROM v_gaps g
    WHERE g.chokepoint = r.chokepoint
      AND date_trunc('hour', g.ended_at) = r.hour
      AND g.classification = 'spoofed') AS spoofed,
  (s.hour IS NOT NULL)             AS observed
FROM region_hours r
LEFT JOIN v_transit_hours t ON t.chokepoint = r.chokepoint AND t.hour = r.hour
LEFT JOIN service_hours s ON s.hour = r.hour;
