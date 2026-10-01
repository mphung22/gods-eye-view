# The Cape of Good Hope thesis

*Why the primary series moved to a place that is not a chokepoint.*

Written September 2026, at rules version `r4`. This document is the argument
the data is being gathered to test, written down in advance so that it can be
shown wrong rather than quietly revised afterwards.

**Status: the baseline held when the sample doubled.**

Twelve full days, 19–30 September 2026, 673 crossings in the fortnight.

```
19 Sep   55      23 Sep   42      27 Sep   50
20 Sep   46      24 Sep   56      28 Sep   50
21 Sep   59      25 Sep   60      29 Sep   48
22 Sep   55      26 Sep   54      30 Sep   64
```

**Twelve full days: mean 53.2 per day, sd 6.3.** The six-day baseline was 54.3
with sd 5.9. Doubling the sample moved the mean by one crossing and the spread
by less than half of one — which is the single most useful thing that could
have happened, because a baseline that moves when you add data was never a
baseline. The alarm band is **below 41 or above 66**, essentially where six
days put it.

Direction stays even: **306 outbound to 333 inbound** over the twelve days
(321/352 across the whole fortnight), against 186/188 in the first week. That
tilt is 1.1 standard deviations on a coin flip over 639 events, so it is noise,
and reading a reroute into it would be the same mistake as reading one into the
first day's 32/20.

### The restart was an experiment nobody designed

At 01:00 UTC on 1 October the collector restarted and came back with **half the
message rate** — 3,100 an hour before, 1,430 after, with the same ~115 vessels
in view, so each vessel was heard half as often. That is a 48% cut in
reception, applied instantly, to a live series. Across the next seven hours the
count ran at **2.0 crossings an hour against a baseline of 2.22** — inside
normal daily variation.

So the thing this project was built to get right, it got right. Over all 311
hours with a reading, crossings correlate **+0.06** with messages per vessel
and **+0.11** with message volume. The count measures ships, not reception.

Two readings in the same table failed the same test, and both are now handled:

- **`queue_depth` was a reception meter.** Cape Town depth rose 102 → 184 over
  twelve days and then halved, 191 → 95, across that one restart — a ratio of
  0.51 against the message ratio of 0.52. It correlates **+0.75** with message
  volume. It was counting the ships we *heard* stop. Fixed in `r4` by shipping
  its denominator: `queue_seen` counts every vessel in the same box whatever
  its speed, so reception moves both and `queue_share` holds. The fourteen days
  of bare depth already collected stay unreadable as a level, and are not
  backfilled.
- **The Bosphorus count is not a traffic series.** 47 crossings in fourteen
  days against roughly 110 transits a day of real traffic — 3% — and it
  correlates **+0.93** with how many vessels were received. On 21 September,
  when reception roughly doubled across the whole feed, it returned 24
  crossings against a fortnight median of 1.5. The registry now carries
  `transitSeries: false` for it and every counts response repeats the flag.

Twelve days still has no weekly pattern in it, no seasonal weather, no
month-end cycle. Treat ±13 as provisional.

The r3 gate produced five crossings between 10:09 and 13:06 UTC on 18
September 2026 — **1.7 per hour, about 41 per day.** That is enough events to
build a daily series on, which the r2 gate at 20.0°E never came close to.

Three were outbound and two inbound, which is the balance a through-route
should show.

Two things those five rows exposed, both now fixed and both worth recording
because they were invisible in the aggregates:

- **Two of the five carried no ship type, draught or length at all.** A
  crossing was enriched only from static reports that happened to arrive
  before the vessel reached the gate, and that table lived in memory, so every
  restart reset the miss rate to maximum. Static reports are now persisted and
  joined on read (`vessel_static`), which recovers vessel IDENTITY — type and
  length — for past crossings as well as future ones. Draught is deliberately
  NOT backfilled: it is voyage state, and a report arriving after the crossing
  may describe the opposite load condition.
- **Tanker nomenclature was being applied to ships that are not tankers.** A
  366 m container ship came back `size_class: vlcc`, `laden_state: ballast`,
  `approx_kdwt: 300`. Container ships are volume-limited rather than
  weight-limited and sit far shallower for their length, so the tanker ratio
  reads a normally-loaded boxship as empty. The hourly views already filtered
  on `is_tanker`, so the aggregates were never wrong — but anyone reading raw
  rows saw confident nonsense. Those labels are now null for non-tankers.

Everything in §10 still applies before any of this is worth money.

---

## 1. What happened to the original plan

The project started pointed at the Strait of Hormuz: a fifth of the world's
seaborne oil through a 21-mile gap, and the premise that ships change behaviour
before the news reports why.

Three hours of clean collection killed it.

| Region | Messages/hour | Distinct vessels/hour |
| --- | --- | --- |
| Cape of Good Hope | 1,931 / 2,050 / 1,870 | 113 / 113 / 111 |
| Bosphorus | 1,488 / 1,603 / 1,581 | 123 / 126 / 133 |
| **Strait of Hormuz** | **0 / 0 / 0** | **0 / 0 / 0** |
| **Bab el-Mandeb** | **0 / 0 / 0** | **0 / 0 / 0** |

Not zero transits — zero *messages*, on a socket that delivered 10,500 from the
other two regions in the same window, with `observed: true` on every row. The
feed has no receiver coverage in the Gulf or the Red Sea approaches.

That is not a bug to fix. It is a fact about the instrument.

## 2. The reason the Cape wins is about the feed, not about shipping

**So the gate should be placed where the feed can hear, and then asked what it
can tell us — rather than placed where the story is and asked to perform.**
That inversion is the substance of this document. It is also, as it turned out,
a rule this document broke on its first attempt.

### What r2 argued, and why it was wrong

r2 claimed the Cape won because it is open ocean, where satellite AIS is strong
— hulls far apart under clear sky, rather than the message collisions that ruin
reception in a 750-metre urban waterway like the Bosphorus. The message volume
seemed to confirm it: the Cape out-delivered every other region watched.

The volume was real. The explanation was not.

`/diagnostics` measured the footprint directly. Over two hours the Cape's
`observedBox` pushed **south** past Cape Point but barely moved **east**:

```
-34.79 … -33.70 °N,  17.66 … 18.64 °E
```

A box that tight, centred on a city, is one **terrestrial receiver near Cape
Town** with about 60–70 km of reach. It is not satellite coverage of a shipping
lane. 132 vessels never came within 50 km of r2's gate at 20.0°E, and no amount
of further waiting was going to change that.

### What r3 measures instead

The gate moved to **18.15°E**, the measured centre of that footprint, with a
band from just south of Table Bay to the southern edge of observed reach — about
25 nautical miles below Cape Point.

That is the **inshore portion** of the rounding lane, and the limit deserves to
be stated plainly rather than buried:

> Deep-draught traffic rounds well south of this gate, and ALL traffic routes
> further south in heavy weather. So the count under-reads exactly when the
> Southern Ocean is roughest. That is a seasonal confound baked into the
> geometry, and the denominator does not correct it.

The tonne-mile mechanism in §3 is unaffected. What changed is the claim about
what this feed can *see*, which was an assumption presented as a finding.

## 3. The mechanism

Cargo moving between Asia or the Gulf and Europe or the US East Coast has two
routes: through Suez (via Bab el-Mandeb and the Red Sea), or the long way round
Africa past the Cape.

When the Red Sea becomes dangerous, cargo does not stop. It goes around.

Asia–Europe via the Cape is roughly 3,500 nautical miles longer than via Suez —
about ten to fourteen extra days at service speed. And here is the part that
matters:

> The world fleet is a fixed stock of hulls in the short run. Longer voyages
> mean the same cargo consumes more ship-days. **Effective supply shrinks
> without a single ship leaving the fleet.**

That is the tonne-mile mechanism. Freight rates are set by tonne-mile demand
against available capacity, and tanker supply is almost perfectly inelastic on
a quarterly horizon — you cannot build a VLCC in response to a news cycle. So a
sustained rerouting event compresses effective supply into a market that cannot
answer, and rates move violently.

Rising Cape traffic is the physical signature of that compression.

## 4. Why this is a better trade than the original

The Hormuz idea expressed itself in oil price. That was always the weak link:
crude is the most-watched, most-arbitraged, most macro-contaminated price on
earth. OPEC spare capacity, strategic reserves, demand expectations and rate
policy all sit between a tanker and the Brent print. A disruption can be real
and crude can go nowhere.

Tonne-miles are different. They are close to a pure function of *where ships
have to go*, and the instruments that track them — tanker equities, freight
derivatives — respond to that far more directly than crude does.

There is also a structural asymmetry worth naming. **A Red Sea closure is
bearish for crude demand and bullish for tanker rates at the same time.** The
same event, two opposite signs. If you only watch oil, you are trading the
noisier leg.

## 5. Why the signal is worth having at all

Be precise about what edge this is, because it is easy to overclaim.

The Cape transit count does **not** beat the news to the *event*. A missile
strike is on a wire service within minutes; ships take days to arrive at the
Cape afterwards. The sequence is:

```
reroute decision  →  Cape transit (days later)  →  fixture rates  →  equities
```

The count sits in the middle. So the edge is not speed to the headline. It is:

1. **Magnitude.** The headline says "ships are avoiding the Red Sea." It does
   not say how many. A transit count does.
2. **Persistence.** Markets overreact to the first headline and underreact to a
   shift that quietly holds for four months. A daily count distinguishes a
   scare that reversed from a rerouting that stuck — which is the difference
   between a fade and a trend.
3. **Falsification.** When the story says rerouting and the water says
   otherwise, that is the most valuable reading the instrument produces, and it
   is unavailable to anyone trading the narrative.

Point 3 is the real asset. See §8.

## 6. What gets measured

All of it is already implemented; none of it is validated.

| Series | What it is | Why |
| --- | --- | --- |
| `outbound` / `inbound` | Cape gate crossings per hour, both directions | **The series to trade.** Measured independent of reception — see below |
| `outbound / vessels` | Transits over distinct vessels received | The cross-check, not the headline. Equivalent to the raw count in practice |
| `outbound_laden` / `outbound_ballast` | Draught-to-length ratio, ≥0.055 laden | Laden westbound is cargo actually moving, not repositioning |
| `outbound_kdwt` | Approximate deadweight crossing | Tonnes beat hulls; one VLCC is twenty coasters |
| `queue_share` | Stopped vessels over all vessels in Table Bay | Ships at anchor off Cape Town, as a fraction so reception divides out |
| `queue_depth` | Vessels stopped in Table Bay | Kept as the raw observation. **Not readable as a level** — see below |
| `dark` / `spoofed` | AIS silences, classified | Sanctioned and evasive tonnage takes this route too |
| `observed` | Whether the collector was running | Without it every number above is uninterpretable |

### Which of these survived two weeks of measurement

The denominator rule in `001_init.sql` says a count must never travel without
the thing it has to be read against. Two weeks showed the rule was being
applied in the wrong place in two of these rows.

**The raw crossing count needs no normalising.** It correlates +0.11 with
message volume and +0.06 with messages per vessel, and it did not move when a
restart halved reception. Dividing it by messages makes it *worse*: the
coefficient of variation across twelve days is **0.118 raw, 0.122 per vessel,
0.271 per ten thousand messages.** Message volume measures how often a vessel
is heard, not how many vessels there are, so dividing by it injects the
receiver's noise into a series that did not have any. The denominator's job
here is to say whether a zero is real — not to be divided by.

**`queue_depth` needed exactly the normalising the count did not.** It is a
count with no denominator at all, and it behaves like one: +0.75 against
message volume, and a clean halving across the restart. `queue_seen` and
`queue_share` (migration `005`) fix it. Until there are enough post-`r4` hours
to trend, the anchorage contributes nothing to the argument.

**The anchorage is a weaker cross-check than r2 claimed.** Algoa Bay, off
Gqeberha, is the real bunkering stop for Cape traffic: ships stopped there are
refuelling *because* they chose the long route, which made it a demand proxy
independent of the gate count. It is also 400 km outside anything this receiver
has ever delivered, so r3 watches Table Bay instead. Table Bay mixes bunkering
with berth-waiting and port calls, so it is a noisier proxy — and since roughly
90% of all Cape reception is vessels sitting in it, the `vessels` denominator is
mostly stationary harbour traffic rather than lane traffic. It still detects a
receiver going down, which is its main job. It does not track lane-specific
reception, and §6 previously implied it did.

### The tanker filter was a Hormuz assumption — measured, then widened

`outbound_laden`, `outbound_ballast` and `outbound_kdwt` are all computed
`FILTER (WHERE ... AND is_tanker)`. That was right when the gate was at Hormuz,
where laden crude tankers *are* the entire story.

At the Cape it is not right. The Red Sea reroute moved container ships and dry
bulk at least as much as it moved tankers, and the first crossing this
collector ever recorded — a 289 m, 17.3 m-draught hull of AIS type 70, almost
certainly a Capesize bulker — is excluded from every tonnage series by that
filter. The headline counts (`outbound` / `inbound`) do include it.

So the tonnage series is not *corrupted*, it is *narrow*: it measures the
tanker slice of a reroute that is mostly not tankers.

**A full week then settled how narrow.** Of 374 transits, **30 were tankers —
8%**, and only 26 carried a usable draught. The one-day sample suggested 13%;
a week says it is thinner than that. The series the argument rests on was running on roughly four
observations a day while 87% of the traffic went unmeasured.

**A fortnight confirmed it and showed the load split is worse still.** Of 673
transits, **57 were tankers — 8.5%**, and of those only **7 read laden and 4
ballast** in fourteen days. That is 0.8 classified tanker loadings a day. No
threshold change rescues a series with eleven observations in two weeks; the
reason to keep it is that it costs nothing and would become readable at
Hormuz, where the fleet reports draught and the filter was correct to begin
with. Hull metres — roughly **10 km of hull a day** across the Cape gate — is
the series with enough events behind it to trend.

`004_hull_metres.sql` adds a type-agnostic measure beside it. The tanker
series are untouched, so their history stays comparable; what is new is
`outbound_hull_m` / `inbound_hull_m`, the summed reported length of every
hull that crossed, with `outbound_measured` alongside so a fall in metres can
be told apart from a fall in how many vessels reported a length.

Length rather than tonnage on purpose. Deadweight needs a length-to-tonnage
curve, that curve differs between tankers, box ships and bulkers, and **AIS
cannot distinguish a container ship from a bulk carrier at all** — both report
type 70–79, "cargo". Inventing a curve for hulls whose type is unknowable
would be a guess dressed as a measurement. Length is one number the hull
actually reported, it scales with capacity, and a relative index needs nothing
more.

## 7. The instruments

Not recommendations. The mapping from thesis to expression, so the thesis can be
argued with on its own terms.

**Crude tankers** — Frontline (FRO), DHT, International Seaways (INSW), Teekay
Tankers (TNK), Tsakos (TNP). Most direct exposure to VLCC and Suezmax rates.

**Product tankers** — Scorpio (STNG), Ardmore (ASC). Refined products were the
most-rerouted Red Sea cargo class; often the sharper move.

**Dry bulk** — Golden Ocean (GOGL), Star Bulk (SBLK), and BDRY, which holds
freight futures directly rather than equities. Bulk reroutes too, and BDRY
tracks rates rather than corporate results.

**Shipping broad** — BOAT, SEA. Diluted, but liquid.

On structure, since the stated interest is options: this thesis is
directional-with-persistence, not a spike bet. Its natural expressions are
ones that pay for the move continuing rather than for it happening — and these
names carry elevated implied volatility precisely when the shipping headlines
are loudest, which is the worst moment to buy premium outright. Spreads finance
that. The "sideways" case is real too: if rerouting is established and priced,
the thesis becomes *persistence without further escalation*, which is a
short-premium posture, not a long one.

**The signal tells you which of those three states you are in. It does not size
the position, and it does not know what is already priced.**

## 8. The falsification test, and why it is the point

The honest framing of this whole project:

> A 692,000-view video watched the Strait of Hormuz "go dark" on this exact
> data feed and concluded Iran had closed the strait. Our collector, on the
> same feed, sees the same zero — and cannot yet rule out that the receivers
> simply are not there.

Both readings fit the observation. Neither the video nor we can separate them
from the feed alone. That ambiguity is the single most important fact in this
repository, and everything defensive in the design — the `messages` and
`vessels` denominators, `service_hours`, the `observed` flag, `/diagnostics`
and its distance-to-gate — exists to break it.

So the deliverable is not a ship counter. **It is an instrument that knows when
it cannot see.** If the widely-followed version of this analysis cannot tell a
closed strait from a dead antenna, then knowing the difference is worth more
than the counts are.

## 9. What would make this wrong

Listed in advance, so they cannot be explained away later.

- ~~**The gate never validates.**~~ **Settled: it validates.** r2's gate read
  `COVERAGE OFF-GATE` and was moved. The r3/r4 gate has produced 673 crossings
  over fourteen days at a stable 53 a day, and held that rate through a
  restart that halved reception. This one is answered.
- **Inshore bias.** Even a working r4 gate samples the coastal edge of the
  rounding lane, not the lane. A consistent sample of a biased slice can still
  be a usable relative index — but only if the bias is stable, and weather
  routing means it is not. **Still open, and now the largest live risk:** the
  twelve-day sd of 6.3 was measured in one weather regime, so the band will
  widen the first time the Southern Ocean turns, and a widening band looks
  exactly like a signal.
- **No baseline.** Twelve days: 53.2 ± 6.3, unchanged from six days. This is
  no longer missing, but it is not yet 30 days and carries no weekly or
  seasonal structure. The data cannot be backfilled — it only accrues forward.
- **Confounds.** Cape traffic also rises for Panama Canal restrictions, Chinese
  import swings, and seasonal weather routing. A rise is not automatically a
  Red Sea reroute.
- **Half a ratio.** The clean signal is Cape *versus* Suez. Bab el-Mandeb is
  dark, so only one leg is measurable. Cape traffic rising while Suez traffic
  also rises means growth, not rerouting — and that is currently indistinguishable.
- **It is not a secret.** Tanker equities already repriced on rerouting in
  2024. This is a known mechanism on a watched route. The edge claimed in §5 is
  about magnitude and persistence, not discovery, and that is a thinner edge.
- **Satellite revisit gaps.** Even good open-ocean coverage samples on a
  cadence. A fast transit between passes is invisible, which biases counts down
  in a way the denominator only partly corrects.

## 10. Before any money

1. **One validated transit count.** Not a dashboard, not a model. One number,
   confirmed against a published figure for the same route and window. **Still
   the blocker.** 53 a day is internally stable, but it has never been checked
   against anyone else's count of the same water in the same week, and a
   stable number can be stably wrong — a gate 45 km inshore of the lane would
   produce exactly this.
2. **Thirty days of baseline**, with `observed` coverage above 95%. Twelve
   full days as of 1 October; `observed` coverage over the collector's own
   lifetime is good, and the 0.494 ratio on a 30-day window is simply the half
   of it that predates the service.
3. **Backtest against published freight rates.** If Cape transits do not lead
   or coincide with Baltic tanker assessments over the sample, there is nothing
   here and the honest move is to stop.
4. **Paper trade one full cycle**, logging each forecast *before* the outcome.
   The forecast log is the only thing that distinguishes a signal from a story
   told afterwards.

Do not buy a commercial data feed before step 1. A paid feed poured into a
pipeline that has never produced its central number buys an expensive copy of
the same silence.

---

*This is analysis of a measurement system, not investment advice. The signal
described here is unvalidated and has never been tested against an outcome.*
