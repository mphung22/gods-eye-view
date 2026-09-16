# VIDEO NOTES

Updated: September 16, 2026

Notes on the upstream God's Eye View video series — what each episode
demonstrates, and which parts map onto work in this fork.

Scraped from YouTube metadata (titles, dates, descriptions, chapter lists) plus
the upstream repository docs. **Spoken transcripts are not included**: they
could not be retrieved in the environment these notes were written in. Chapter
titles and descriptions are verbatim from the creator; the commentary under them
is ours.

---

## №3 — Iran's Chokehold on the World's Oil

**Bilawal Sidhu · 3 Apr 2026 · ~16 min · 692K views**
<https://www.youtube.com/watch?v=ccZzOGnT4Cg>

Ship tracking goes on and the Strait of Hormuz goes dark — transits falling from
hundreds a day to a handful, some days none. A ~21-mile chokepoint carrying a
fifth of the world's oil. This is the episode where the globe stops being a toy
and becomes an analysis tool.

### Chapters

| Time | Chapter |
| ---- | ------- |
| [0:00](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=0s) | God's Eye View |
| [1:00](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=60s) | Strait of Hormuz Choke Point |
| [1:54](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=114s) | Impact on Transits & Oil Prices |
| [2:55](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=175s) | Iran's Toll Booth |
| [5:48](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=348s) | Dark Vessel Detection |
| [7:16](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=436s) | The Oil Pipeline Bypasses |
| [8:30](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=510s) | Desalination Plants & The Water Crisis |
| [9:17](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=557s) | The Strikes: Tankers Under Fire |
| [10:22](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=622s) | The Strikes: Refineries & Bases |
| [12:44](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=764s) | Why Satellites Are Now Delayed |
| [13:13](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=793s) | The Global Economic Ripple Effect |
| [15:20](https://www.youtube.com/watch?v=ccZzOGnT4Cg&t=920s) | What's Next |

### Data layers used in that build

Per the creator's own description — effectively the recipe:

- AIS ship tracking
- **Dark vessel detection (AIS gap analysis)**
- Oil pipeline bypass routes (East–West, Habshan–Fujairah)
- Oil futures — Brent crude, WTI, and the spread
- Military strike tracking from OSINT (Israel/US ↔ Iran)
- Before/after satellite imagery
- Critical infrastructure — desalination plants, refineries, airbases
- Country-level reserve and dependency data

### The method, generalized

1. Pick a chokepoint — geography a disproportionate share of some flow must cross.
2. Instrument the flow. Transits per day is the whole story in one number.
3. **Mine the absence.** The signal isn't the ships you see, it's the ones that
   stopped broadcasting.
4. Attach a price. Overlay the market series on the physical series.
5. Map the alternatives — bypass routes bound how much leverage the chokepoint
   actually confers.
6. Find the second-order target (here: desalination plants).
7. Show your latency. The episode explains *why imagery is delayed* rather than
   implying the picture is live.

---

## №9 — God's Eye View Blew Up. Here's What You Can Do With It.

**Bilawal Sidhu · 8 Sep 2026 · ~27 min · 1.95M views**
<https://www.youtube.com/watch?v=o_FJ1NIH9yw>

The walkthrough made after the repo hit #1 on GitHub Trending, answering "how do
I run this if I'm not a coder." Useful here mainly as a feature tour and as a
statement of where coverage honestly breaks down.

### Chapters

| Time | Chapter |
| ---- | ------- |
| [0:00](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=0s) | God's Eye View Blew Up |
| [1:06](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=66s) | Install God's Eye View |
| [2:08](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=128s) | The Interface, Flight Tracking & Radio |
| [5:51](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=351s) | Contacts Mode & Cockpit View |
| [7:47](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=467s) | Control the World With Your Voice |
| [11:25](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=685s) | Area 51 Easter Egg |
| [12:40](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=760s) | Traffic & Public Cameras |
| [15:55](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=955s) | Track Ships & Ride Along With Flights |
| [19:55](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=1195s) | Record Your Own Camera Tours |
| [21:06](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=1266s) | Fires, Earthquakes & the Physical Internet |
| [24:18](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=1458s) | Reconstructing Nepal Floods |
| [25:55](https://www.youtube.com/watch?v=o_FJ1NIH9yw&t=1555s) | Building God's Eye View Together |

### Worth noting for this fork

- The description ships a **coding-agent install prompt** with "keep API keys
  local; don't ask me to paste them into this chat" written into it.
- The episode asks the audience whether they'd use a hosted version they could
  open without installing anything. This fork is already answering that question
  for its own deployment.
- Stated limits, repeated from upstream docs: traffic is simulated along real
  roads; CCTV poses and launch trajectories are coarse estimates; terrestrial
  AIS goes quiet mid-ocean.

---

## What №3 implies for our AIS work

Dark-vessel detection — the sharpest idea in the series — is **gap analysis over
per-vessel history**. That is the same substrate `server/providers/vessels/`
already maintains, so most of the groundwork exists. The constraints, precisely:

| Piece | Current state |
| ----- | ------------- |
| Latest position per MMSI | `_aisStreamVessels`, with `_updatedAt`; 24 h staleness window, 50k cap |
| Recent path | `_aisStreamTracks` — 64-sample ring buffer, ≥30 s apart, ≥25 m moved |
| Survives restart | **Only the vessel rows and static data.** `exportAisStreamState()` deliberately excludes the track ring buffers |

So a gap detector built on the *track* buffers resets on every Render restart or
redeploy, while one built on the *persisted rows* does not.

The cheap version that survives restarts: the snapshot already carries
`_updatedAt` and `last_position_UTC` per MMSI. On reconnect, a vessel whose
first new fix arrives materially later than its restored `_updatedAt` — while
the feed itself was healthy, which `aisWatchdog.js` can attest to — is a gap
candidate. That distinction matters: without the watchdog's liveness evidence, a
feed outage looks identical to every vessel going dark at once.

The expensive version is persisting the ring buffers, and it runs straight into
the known issue in `CLAUDE.md`: extending `AISSTREAM_STALE_MS` from 30 minutes to
24 hours already grew the cache enough to trip Render's 512 MB Starter limit and
trigger auto-restarts. The track buffers are another ~38 MB resident at the 64 ×
50k worst case (`ais-store.js` does that arithmetic itself), before anything is
written to disk. Persisting them would make the restarts more frequent while
making each one cost more to recover from — the wrong direction on both axes.
The `_updatedAt` route above adds no resident memory at all.

---

## The full series

| # | Video | Link |
| - | ----- | ---- |
| 1 | Ex-Google Maps PM Vibe Coded God's Eye View In a Weekend | [rXvU7bPJ8n4](https://www.youtube.com/watch?v=rXvU7bPJ8n4) |
| 2 | Ex-Google PM Builds God's Eye to Monitor Iran in 4D | [0p8o7AeHDzg](https://www.youtube.com/watch?v=0p8o7AeHDzg) |
| 3 | **Iran's Chokehold on the World's Oil** | [ccZzOGnT4Cg](https://www.youtube.com/watch?v=ccZzOGnT4Cg) |
| 4 | Ex-Google PM Uses God's Eye to Expose Reality of US–Iran Ceasefire | [7HEUCLc7aL8](https://www.youtube.com/watch?v=7HEUCLc7aL8) |
| 5 | Palantir's AI Targeting System Running the Iran War | [CHLFl26p7Po](https://www.youtube.com/watch?v=CHLFl26p7Po) |
| 6 | Hollywood Imagined It. The Military Actually Built It. | [cWbBsfwtCIo](https://www.youtube.com/watch?v=cWbBsfwtCIo) |
| 7 | AI Can See Without Cameras. WiFi Was Just the Beginning. | [olaQ3-m271M](https://www.youtube.com/watch?v=olaQ3-m271M) |
| 8 | We Got Open Source God's Eye Before GTA 6 | [GRJaKcXZS94](https://www.youtube.com/watch?v=GRJaKcXZS94) |
| 9 | **God's Eye View Blew Up. Here's What You Can Do With It.** | [o_FJ1NIH9yw](https://www.youtube.com/watch?v=o_FJ1NIH9yw) |

Playlist: <https://youtube.com/playlist?list=PL6qSg2I-7_koPbDnSMo0QeeHX_RknA2uv>
