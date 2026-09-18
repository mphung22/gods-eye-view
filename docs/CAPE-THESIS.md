# The Cape of Good Hope thesis

*Why the primary series moved to a place that is not a chokepoint.*

Written September 2026, at rules version `r3`. This document is the argument
the data is being gathered to test, written down in advance so that it can be
shown wrong rather than quietly revised afterwards.

**Status: the pipeline is validated and the rate is usable. The signal is
still unproven.**

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
| `outbound` / `inbound` | Cape gate crossings per hour, both directions | The raw reroute volume |
| `outbound / vessels` | Transits over distinct vessels received | **The robust series.** Reception varies; a raw count cannot tell a quiet sea from a quiet receiver |
| `outbound_laden` / `outbound_ballast` | Draught-to-length ratio, ≥0.055 laden | Laden westbound is cargo actually moving, not repositioning |
| `outbound_kdwt` | Approximate deadweight crossing | Tonnes beat hulls; one VLCC is twenty coasters |
| `queue_depth` | Vessels stopped in Table Bay | Ships at anchor off Cape Town, the only anchorage this feed reaches |
| `dark` / `spoofed` | AIS silences, classified | Sanctioned and evasive tonnage takes this route too |
| `observed` | Whether the collector was running | Without it every number above is uninterpretable |

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

### ⚠️ The tanker filter is a Hormuz assumption, carried to the wrong ocean

`outbound_laden`, `outbound_ballast` and `outbound_kdwt` are all computed
`FILTER (WHERE ... AND is_tanker)`. That was right when the gate was at Hormuz,
where laden crude tankers *are* the entire story.

At the Cape it is not right. The Red Sea reroute moved container ships and dry
bulk at least as much as it moved tankers, and the first crossing this
collector ever recorded — a 289 m, 17.3 m-draught hull of AIS type 70, almost
certainly a Capesize bulker — is excluded from every tonnage series by that
filter. The headline counts (`outbound` / `inbound`) do include it.

So the tonnage series is not *corrupted*, it is *narrow*: it measures the
tanker slice of a reroute that is mostly not tankers. Widening it is a view
change, which reclassifies all history and needs no backfill — but it should be
a deliberate decision recorded here, not a silent edit.

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

- **The gate never validates.** Zero crossings so far, everywhere. r2's gate
  read `COVERAGE OFF-GATE` and was moved; if r3's does too, the thesis dies
  with the instrument and no amount of reasoning above rescues it.
- **Inshore bias.** Even a working r3 gate samples the coastal edge of the
  rounding lane, not the lane. A consistent sample of a biased slice can still
  be a usable relative index — but only if the bias is stable, and weather
  routing means it is not.
- **No baseline.** "Cape traffic is rising" is meaningless without knowing
  normal. That needs 30+ days before any reading is interpretable, and the data
  cannot be backfilled — it only accrues forward.
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
   confirmed against a published figure for the same route and window.
2. **Thirty days of baseline**, with `observed` coverage above 95%.
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
