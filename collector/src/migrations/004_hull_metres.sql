-- Measure the whole reroute, not just the tanker slice of it.
--
-- A day of real crossings settled a question the thesis had left open. Of 52
-- transits, SEVEN were tankers — 13%. Of those seven, four had a usable
-- draught. So `outbound_kdwt`, `outbound_laden` and `outbound_ballast`, the
-- series the whole argument rests on, were running on about four observations
-- a day while 87% of the traffic went unmeasured.
--
-- That filter was correct at Hormuz, where laden crude tankers ARE the story.
-- At the Cape it is not: the Red Sea reroute moved container ships and dry
-- bulk at least as much as it moved tankers.
--
-- The tanker series are left exactly as they were. They mean what they have
-- always meant and their history stays comparable. What is added beside them
-- is a type-agnostic measure of how much hull crossed.

DROP VIEW IF EXISTS v_chokepoint_hours;
DROP VIEW IF EXISTS v_transit_hours;

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
  count(*) FILTER (WHERE ship_type IS NULL)                               AS unidentified,

  -- Hull metres: the sum of reported overall length across every crossing
  -- that reported one, in each direction.
  --
  -- Deliberately crude, and crude is the point. Deadweight needs a
  -- length-to-tonnage curve, and that curve differs between a tanker, a
  -- container ship and a bulker — inventing one for hulls whose type AIS
  -- cannot even distinguish would be a guess dressed as a measurement.
  -- Length is a single number a hull actually reported. It scales with
  -- capacity, it is comparable against itself over time, and that is all a
  -- relative index needs.
  coalesce(sum(length_m) FILTER (WHERE direction = 'outbound'), 0)        AS outbound_hull_m,
  coalesce(sum(length_m) FILTER (WHERE direction = 'inbound'), 0)         AS inbound_hull_m,
  -- How many hulls the metres were summed over. Without it a fall in hull
  -- metres cannot be told apart from a fall in how many vessels reported a
  -- length — the identity problem again, one level along.
  count(*) FILTER (WHERE direction = 'outbound' AND length_m IS NOT NULL) AS outbound_measured,
  count(*) FILTER (WHERE direction = 'inbound' AND length_m IS NOT NULL)  AS inbound_measured,

  -- Broad families, from the AIS type code's tens digit.
  --
  -- ⚠️ AIS cannot tell a container ship from a bulk carrier: both report
  -- 70–79, "cargo". So this splits tanker / cargo / passenger / other and
  -- goes no further, because the data does not support going further.
  count(*) FILTER (WHERE ship_type ~ '^[0-9]+$' AND ship_type::INT BETWEEN 70 AND 79) AS cargo,
  count(*) FILTER (WHERE ship_type ~ '^[0-9]+$' AND ship_type::INT BETWEEN 60 AND 69) AS passenger
FROM v_crossings
GROUP BY chokepoint, date_trunc('hour', observed_at);

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
