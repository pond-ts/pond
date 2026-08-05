# Charts gallery — 8 cards → a real shop window

_pond-ts docs agent (Claude), 2026-08-02 · status: **PROPOSED, not adopted**._
_Target: [`website/docs/charts/gallery.mdx`](../../website/docs/charts/gallery.mdx)._

---

## 0. The thesis

The gallery is the page an evaluator hits when they want to know **"can this
library draw my thing?"** Eight cards answers "maybe." The prior art all answers
it at a different scale — the [d3 graph gallery](https://d3-graph-gallery.com/),
[SciChart's demos](https://www.scichart.com/demo/javascript),
[ag-charts](https://www.ag-grid.com/charts/gallery/),
[Google Charts](https://developers.google.com/chart/interactive/docs/gallery),
and our own predecessor
[react-timeseries-charts](https://software.es.net/react-timeseries-charts/#/) —
by being **broad enough that you find your shape**, then **deep enough that the
click-through teaches you to build it.**

Three things get us there: **more of them**, **data that looks real**, and
**colour that never leaves the theme**.

## 1. What's wrong today (audited, not assumed)

| #   | Problem                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Evidence                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| G1  | **Eight cards.** Whole families are missing: no stacked area, no horizontal bars, no categorical axis, no live/streaming card, no large-data card, no negative-values card, no dual-axis card.                                                                                                                                                                                                                                                                                             | `website/docs/charts/gallery.mdx`                                                |
| G2  | **The data is visibly synthetic.** Sine-and-noise generators read as fake at a glance; the one card built on real data (the ride) is conspicuously better. Real texture — dropouts, coasting, spikes, weekends — is what makes a chart look load-bearing.                                                                                                                                                                                                                                  | `website/src/examples/lib/gallery-fixtures.ts` vs `ride-samples.ts`              |
| G3  | **Hardcoded palettes passed as props.** `colors={…}` / `binColors={…}` carry literal hues that never flip for dark mode and aren't the brand ramp: `#15B3A6`, `#45CDBE`, `#E0B36A`, `#C98A5B`, `#7FE2D2`, `#3FB984`, `#E0A24A`, `#D9534F`. Sandy browns and a second teal next to `--pond-viz-1` (`#0e8f86`) is exactly the jarring effect. **Not** the `?? '#0e8f86'` fallbacks in `src/examples/core-*.tsx` — those are defensive defaults that already match the palette, and are fine. | `docs/how-to-guides/histograms.mdx`, `docs/how-to-guides/categorical-charts.mdx` |
| G4  | **Cards are static.** They're live/touchable but nothing moves until you hover, so a scan down the page reads as screenshots.                                                                                                                                                                                                                                                                                                                                                              | `GalleryCard`                                                                    |
| G5  | **The click-through goes to Storybook**, which is a prop reference, not a "how do I build this." There's no per-chart page.                                                                                                                                                                                                                                                                                                                                                                | `GalleryCard.storybookHref`                                                      |

## 2. Design decisions

### 2a. The card: a mini, self-playing preview — rendered with the real charts

Each card renders **the actual `@pond-ts/charts` components** (never an image),
at reduced height, with **autoplay motion**: a window scrolling across the data,
a live push, or a slow parameter sweep, depending on the chart. Motion is what
turns a page of thumbnails into a shop window.

Three non-negotiables, because 28 animating canvases on one page is a real cost:

- **Only animate what's on screen** — `IntersectionObserver`; cards outside the
  viewport hold a static frame.
- **Respect `prefers-reduced-motion`** — no autoplay, render the most
  interesting static frame instead.
- **One shared driver**, not 28 rAF loops. The core-docs `ConceptViz` already
  has an autoplay streaming driver; the gallery's is the same idea, extracted so
  both use it.

### 2b. The click-through: a page per chart, not a Storybook link

`website/docs/charts/gallery/<slug>.mdx`, each with the same spine:

1. **The finished thing** — full-size, interactive, `<ChartExample>` with the
   source folded behind the expander (the `collapsed` prop shipped this session).
2. **The data** — where it came from, its shape, its quirks.
3. **Build it** — the minimal version in 10–20 lines, then the two or three
   additions that get you to the finished chart. This is the mini-tutorial.
4. **Options to try** — the knobs that matter for _this_ shape (cursor mode,
   gaps, stacking, axis kind), each a one-liner with a sentence on when to reach
   for it.
5. **Links out** — the reference page for each component used.

Storybook links stay, demoted to "every prop" at the foot of the page.

### 2c. Data policy — real where we can, honest where we can't

Ranked preference:

1. **Public-domain real data**, committed as a fixture with provenance in the
   file header (the `ride-samples.ts` pattern: what it is, when, what was kept,
   what was dropped and why). Best sources are US-government: NOAA/NWS climate
   and CO-OPS tides, USGS earthquakes, EIA energy.
2. **Permissively-licensed open data** (Open-Meteo, OpenAQ, Our World in Data —
   CC-BY), attributed in the fixture header and on the page.
3. **Modelled synthetic** where no clean source exists (web analytics, most
   finance) — but modelled on the _real process_, with weekday/weekend shape,
   diurnal cycles, bursts, outages and missing samples. Never a bare sine wave.

**Licensing is a real constraint, not a formality.** Market price data is the
sharp case: most feeds forbid redistribution, so finance cards default to
tier 3 (realistic synthetic OHLC) unless someone confirms a redistributable
source. Every fixture records its origin; anything we can't source cleanly gets
generated and _says so_.

Fixtures are generated **once, offline, and committed** — the docs site fetches
nothing at build time.

#### Real data in hand: CERN router traffic (Track A1)

pjm supplied `packages/charts/test-data/cern-network-traffic.json` — genuine
router telemetry, and the strongest data in the set. Profiled:

- **24 SAPs** (service access points) on `cern773-cr6`, **718 points each**
  (17,232 total), **30-second cadence**, a **6-hour span**
  (2026-08-02 05:51 → 11:49 UTC). Values are **bits/second**, in and out.
- **Wildly uneven scale, which is the realism**: the top SAP peaks at
  **191 Gbps out**, another at **182 Gbps in**, while **11 of 24 sit under
  1 Mbps** — near-idle. Top 5 by peak: `111-lag-3-522` (191 G out),
  `7061-lag-3-3525` (182 G in), `111-lag-3-521` (95 G out),
  `7041-lag-3-3507` (24 G in), `7150-lag-3-3504` (18 G out).
- **It's already pond's wire shape.** Each SAP is
  `{ name, columns: ['time','in','out'], points: [[ms, in, out], …] }` —
  row tuples that `TimeSeries.fromJSON({ schema, rows: points })` reads with no
  transformation (verified). That's the pondjs format, which is a nice
  resonance: ESnet built pondjs and react-timeseries-charts, and this is the
  shape their tooling still emits.

Guidance for Track A:

- **Don't import the raw 1 MB JSON into the site bundle.** Derive a trimmed
  fixture into `website/src/examples/lib/` offline, per §2c. The raw file stays
  put — `packages/charts/package.json` has `files: ["dist", …]`, so `test-data/`
  never ships to npm. It is currently **untracked**; commit it as the source of
  record.
- **Take the top 6–8 SAPs by volume**, which conveniently matches the tonal
  ramp's step count. The 11 near-idle ones would be invisible slivers in a
  stack; mention them on the page rather than plotting them.
- **Format as Gbps**, not raw bits.

##### The reference visualization, and what it implies

pjm shared the production dashboard this data actually drives. Two panels:

1. **Total site traffic** — a **mirrored area chart**: "to site" filling
   upward from zero, "from site" filling downward, on a symmetric ±350 G axis.
   Two tones per direction (an aggregate wash behind a darker highlighted
   series). Bursty: a flat-ish morning, then 250–300 G spikes after 11:00.
2. **Traffic by interface** — a table, one row per SAP, each with **inline
   in/out bullet bars** (a light extent track, a darker segment, a value tick)
   and a category (`LHCONE` / `OTHER`). Rows are **selectable**, and selection
   drives the chart above ("Clear Selection").

**The mirrored form is already first-class.** `AreaChart`'s own docs name this
exact look: _"For the esnet two-colour traffic look, compose two `<AreaChart>`s
(an 'in' column and an 'out' column, distinct `as` roles)"_ — `baseline={0}`,
values above filling up and below filling down, and the site theme already ships
the `area.in` / `area.out` roles. So A1's canonical shape is a composition the
library was designed for and the gallery has simply never shown. Negate the
`out` column so it draws below the line.

**The table panel is the page's "complex example."** It's the interactivity half
of §2b — `selected`/`onSelect` linking a row list to the chart — and it answers
pjm's original ask for "a network traffic page dashboard" rather than a single
chart. Whether the bullet bars are `BarChart horizontal` or plain DOM is a call
for the track; the linking is the teachable part.

##### The same data, used more than once

pjm: _"we might use it in different ways too."_ This one file can honestly carry
several cards, and re-use is a feature — the reader sees one dataset asked
different questions:

| Card                    | Question it answers                            |
| ----------------------- | ---------------------------------------------- |
| A1 mirrored traffic     | In vs out over time, one site                  |
| A1b interface dashboard | Which interface, and linked selection          |
| Stacked by interface    | Composition of the total (top 6–8, tonal ramp) |
| Large-data / decimation | All 24 × 718 points at once, pan/zoom          |
| Small multiples         | 24 sparklines — scanning for the odd one out   |

Track A owns A1 and A1b; the others are candidates the track can hand on rather
than build, and should be logged in the roster if they earn a card.

### 2d. Colour policy — the theme is the only channel

- **No hex literals in example sources.** If a chart needs a colour it doesn't
  have, the fix is a **theme role**, not a constant.
- **More series ⇒ tonal, not chromatic.** Today: `--pond-viz-1..5` plus
  `mark` / `up` / `down`. That's the categorical set and it stays the categorical
  set — see §8.2. A stack needing 8 slots gets a **sequential ramp within a brand
  hue** (one family, stepping lighter), not eight competing colours. Phase 0 adds
  the ramp generator and the roles that consume it.
- **Verify, don't eyeball.** Two roles this session (`bar.muted`,
  `area.context`) silently fell back because roles resolve per-primitive.
  Sample the rendered canvas when adding a role — see §7.

## 3. Phase 0 — foundations (blocks the fan-out)

Nothing parallel starts until these land, because every track depends on them:

| Item                    | What                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Autoplay card**       | `GalleryCard` gains a preview driver + `IntersectionObserver` + reduced-motion; one shared rAF loop.       |
| **Sequential ramp**     | A tonal ramp inside the brand hues for >4-series stacks (§8.2), light + dark, + the roles consuming it.    |
| **Colour audit**        | Replace the literal `colors`/`binColors` palettes (G3) with ramp-derived values; leave the `??` fallbacks. |
| **Page template**       | The §2b spine as a skeleton MDX + the sidebar group, so 28 pages don't drift into 28 shapes.               |
| **Fixture conventions** | Header format (source, licence, date, what was kept/dropped), size budget, and the offline generator dir.  |
| **Gallery IA**          | Grid grouped by domain with in-page nav; the roster file the tracks append to.                             |

## 4. The roster — 28 charts, 7 tracks

Each is: **card** (mini + autoplay) → **page** (tutorial + interactive version).
`†` marks charts using data we already have.

**Track A — Ops & infrastructure** (the evaluator's home turf)

| #   | Chart                 | Shape                             | Features shown                          |
| --- | --------------------- | --------------------------------- | --------------------------------------- |
| A1  | **Network traffic**   | Stacked area, in/out by iface     | Stacked area, dual direction, legend    |
| A2  | Multi-host CPU †      | Line ×N from `partitionBy`        | Legend, per-series roles, gaps          |
| A3  | Latency percentiles † | Band + median line                | `BandChart`, two-tone envelope          |
| A4  | SLA & incidents †     | Line + region/baseline/marker     | All three annotations, editing          |
| A5  | **Live tail**         | Streaming line + `YAxisIndicator` | `LiveSeries`, live value pill, autoplay |

**Track B — Finance**

| #   | Chart           | Shape                              | Features shown                          |
| --- | --------------- | ---------------------------------- | --------------------------------------- |
| B1  | Candlestick †   | OHLC + trading calendar            | `Candlestick`, discontinuous time scale |
| B2  | Price + volume  | Two rows, shared axis              | Multi-row, dual scale                   |
| B3  | Bollinger bands | Band + line (`@pond-ts/financial`) | Studies → chart seam                    |
| B4  | Drawdown        | Area below zero                    | Negative baseline, fill direction       |

**Track C — Weather & climate**

| #   | Chart                 | Shape                        | Features shown                                                     |
| --- | --------------------- | ---------------------------- | ------------------------------------------------------------------ |
| C1  | Temperature range     | Band (daily min/max) + mean  | Real NOAA data, band                                               |
| C2  | Rainfall + cumulative | Bars + line, dual y-axis     | Dual axis, mixed layers                                            |
| C3  | Climate stripes       | Dense categorical bars       | Large-N bars, sequential ramp                                      |
| C4  | Wind direction        | Category axis                | `CategoryAxis`, ordinal slots                                      |
| C5  | **River stage** †     | Line + flood-stage baselines | Real USGS data, 34.7k points, `Region` for provisional-vs-approved |

**C1–C4 shipped 2026-08-04** (`feat/gallery-track-c`). C5 deliberately not
built — its fixture isn't committed and the call is pjm's.

What landed, and the decisions worth keeping:

- **All four run on measured, public-domain data**, generated by
  `website/scripts/fixtures/weather.mjs` and committed as
  `src/examples/lib/weather-samples.ts`: NOAA NCEI **GHCN-Daily** (station
  `USW00024233`, Seattle-Tacoma, 2024 — TMAX/TMIN/PRCP) for C1 and C2, NOAA
  NCEI **Local Climatological Data** (WBAN `72793024233`, 8,735 hourly METAR
  wind reports, binned offline to 16 sectors × 12 months) for C4, and NASA
  **GISTEMP v4** annual land-ocean anomalies 1880–2025 for C3. The generator
  was re-run against the live sources at the end of the wave and every numeric
  array came back **byte-identical** to the committed fixture — the fixture is
  verified real, not asserted real.
- **Station gaps are kept, not interpolated** (TMIN missing 2024-04-25; PRCP
  2024-04-24/25). They're the reason C1's band has a one-day notch and C2's
  cumulative line has a two-day plateau, and both are called out on the pages.
  `scan` holding its accumulator across a missing cell is what makes the
  plateau read as "we don't know" rather than as a dry spell.
- **C2 is the interactive one**: full page width via `ResizeObserver`,
  controlled range, `cursor="region"` + `onRegionSelect` for drag-to-zoom,
  `panZoom="panZoom"` for the wheel, `bounds` pinned to 2024 and an explicit
  reset. The gesture conflict was resolved **towards drag-to-zoom** — an
  unmodified region-drag preempts pan — and the page documents both that
  choice and `regionSelectModifier="shift"` as the way to reverse it. The
  region buckets come from the bar layer's own bins, so the selection is
  day-aligned with no `cursorSequence`.
- **C3's readout is off-chart on purpose.** The bars draw a constant `stripe`
  column (colour is the value), so a crosshair pill would read `1.0` on all 146
  bars; the year + anomaly come out of `onTrackerChanged` instead. Logged as
  `[PND-CHFRIC]` 17. Not iterated further — pjm's reaction is that the real
  answer is a heat-map primitive with a day/month/year toggle, which is a
  library feature and is being filed separately.
- **C4 confirmed how the cursor behaves on an ordinal axis**: `crosshair`
  degrades to a vertical line plus the hovered sector's name. `line` shows
  neither. `[PND-CHFRIC]` 16 and 18. (The parenthetical this bullet originally
  carried — "the axis only prints 8 labels" — is **not** a stable property;
  see the C4 rebuild below.)
- **Every interaction sentence on the four pages was verified in a browser**
  by dispatching real pointer events and reading the overlay SVG / pill DOM
  back — the harness's synthetic mouse move does not drive these charts.

**C4 rebuilt 2026-08-04 as a scrubbable series + live histogram** (pjm's
design). The static annual rose said the right thing and demonstrated nothing:
a distribution is normally where the data stops being a time series, and the
point of putting it in pond's Gallery is that here it doesn't. The card is now
**two linked views of one series** — a strip of all 8,735 hourly observations
on a compass axis, and a histogram of whatever is inside a window that sweeps
the year.

- **The raw hourly record is now in the fixture**, alongside the pre-binned
  matrix, which was kept: `SEA_WIND_CODES` (one small int per observation:
  0–15 sector, 16 calm, 17 variable), `SEA_WIND_T0_MS`, and
  `SEA_WIND_OFF_GRID` — **28 `[index, minutes]` pairs** for the places the
  :53-past-the-hour cadence breaks (50 clock hours of 2024 have no `FM-15`
  report; one was filed off-cycle inside an hour already covered). A delta per
  observation would have been ~35 KB; the pairs are a few hundred bytes and put
  the irregularity _in_ the fixture. **+33 KB committed** (12.2 → 45.2 KB).
  Positional-per-hour was considered and rejected: 2024 has 8,784 clock hours
  against 8,735 reports, so it would have had to _drop_ the off-cycle one, and
  then the whole-year histogram would no longer equal `SEA_WIND_HOURS` — which
  is the one thing this card must not do, since its claim is that the two views
  are the same data.
- **The generator asserts the two forms agree**: it rebuilds every timestamp
  from the pairs and checks it against the source, then re-bins the emitted
  codes by UTC month and checks the result equals `SEA_WIND_HOURS` cell for
  cell. Re-run live against NOAA: all five pre-existing arrays came back
  **byte-identical**, and the new arrays are stable across runs.
- **LST-read-as-UTC is load-bearing, not a shrug.** LCD stamps `DATE` in local
  standard time with no zone. Reading it as UTC (the same convention the daily
  series already used) is what makes a calendar-month slice of the hourly
  series hold exactly the observations the monthly matrix bins into that month.
- **The compass is cut between ENE and E.** Any linear axis over a circular
  variable puts two neighbours at opposite edges; that cut is the quietest of
  the four that keep the north–south axis (52% of the year) off the plot edges
  — ENE + E carry 5.0% between them — and it leaves north above south.
- **The window is a `<Region onChange>`, not a custom overlay.** Drag the body
  to move it, an edge to resize; `editAnnotations` is what makes it grabbable
  and it **suppresses the data cursor** for that container, which is the trade.
  A slider and a Play button write the same `[from, to]` state, so there is one
  source of truth. Verified by dispatching real pointer down/move/up (and
  simulating capture by re-dispatching moves at the press target, since
  `setPointerCapture` no-ops for a synthetic `pointerId`).
- **The histogram's ceiling is pinned at 30% and computed, not guessed** — a
  sliding scan over every day-aligned window of every allowed length finds
  29.6% (S, the 28 days from 18 October). That guarantee is why the window
  snaps to whole days and why its length is clamped to 21–45: a 7-day window
  reaches 42.3% and would run off the plot. Auto-fitting instead would make the
  sweep say nothing — the shape would change while the scale moved with it.
- **New friction:** `PartitionedTimeSeries` has no `reduce`
  (`[PND-CHFRIC]` 19 — a core gap logged in the charts list), and
  `<CategoryAxis>`'s label thinning is an estimate that lands on the wrong side
  at card width, printing all 16 names into a smear (`[PND-CHFRIC]` 20). The
  card blanks alternate `CategoryDatum.label`s itself as the workaround.

**C5 detail (added 2026-08-04, pjm supplied the data).**
`packages/charts/test-data/water/` is a **real USGS gage record** — Wabash
River at Lafayette, Indiana (`USGS-03335500`), gage height in feet. Profiled:
**34,746 rows, 15-minute cadence, exactly one year** (2025-08-04 → 2026-08-04),
**no missing values**, 1.06 → 15.59 ft, mean 3.40. Public domain.

Why it earns a card rather than being another line chart:

- **The thresholds are in the data's own metadata.** `time-series-metadata.csv`
  carries the site's flood stages — minor 11 ft, moderate 18 ft, major 26 ft,
  plus operational limits — as structured `thresholds` JSON. The record peaks
  at **15.59 ft**, so it crosses minor flood stage and not moderate: a
  `<Baseline indicator>` per stage that is genuinely sourced, not invented.
- **`approval_status` is a real lineage column** — 13,256 rows `Approved`,
  21,490 `Provisional`, split at a single boundary as the recent tail hasn't
  been reviewed yet. That's a `<Region>` over the provisional span, and a
  data-quality story no synthetic fixture can tell.
- **34.7k points is 12× the landing chart** — a genuine decimation/canvas
  exercise, and the page can show raw vs a rolling daily max.

Needs a fixture generator under `website/scripts/fixtures/` emitting a
compact JSON (the 6.1 MB CSV must not reach the site bundle) — follow
`cern-traffic.mjs`, and keep the native 15-minute grid unless measurement
says otherwise.

**Track D — Energy**

| #   | Chart           | Shape                  | Features shown                          |
| --- | --------------- | ---------------------- | --------------------------------------- |
| D1  | Grid mix        | Stacked area by source | 8-series stack — the ramp's stress test |
| D2  | Solar vs load   | Two areas, crossover   | Overlapping areas, opacity              |
| D3  | Negative prices | Bars above/below zero  | Zero baseline, diverging bars           |

**Track E — Fitness & health** (reuses the ride fixture)

| #   | Chart                | Shape                       | Features shown                        |
| --- | -------------------- | --------------------------- | ------------------------------------- |
| E1  | Ride profile †       | Line + area, duration axis  | `origin="data"`, gaps, pan/zoom       |
| E2  | Power distribution † | Histogram (`byColumn`)      | Value axis, `bins`                    |
| E3  | Training zones †     | Horizontal ordinal bars     | `orientation`, `ordinal`, `openEnded` |
| E4  | Sleep stages         | Categorical bands over time | Interval keys, category colour        |

**Track F — Science & measurement**

| #   | Chart       | Shape                   | Features shown                  |
| --- | ----------- | ----------------------- | ------------------------------- |
| F1  | Spectrum    | Line on a `ValueSeries` | Value axis end-to-end           |
| F2  | Seismograph | Very dense line         | Large-data decimation, pan/zoom |
| F3  | Tides       | Smooth line + markers   | Real NOAA CO-OPS data           |
| F4  | Air quality | Line + threshold bands  | Multiple baselines, gaps        |

**Track G — Product, transport & statistical**

| #   | Chart               | Shape                          | Features shown                      |
| --- | ------------------- | ------------------------------ | ----------------------------------- |
| G1  | Traffic by hour     | Heat-style bars                | Time-of-day binning                 |
| G2  | Funnel              | Horizontal bars                | `horizontal`, categories            |
| G3  | Flight profile      | Area, duration axis            | Duration axis on a second domain    |
| G4  | Group distributions | Box plots ×N †                 | `BoxPlot`, quantile columns         |
| G5  | Bubble scatter      | Scatter, size + colour encoded | `ScatterChart` encodings, selection |

**28 charts.** Every draw layer appears at least twice; every axis kind
(time, value, category, trading-time, duration) at least twice; every annotation
type at least once; live, large-data, negative-values and 8-series stacking each
get a dedicated card.

## 5. Fan-out

**Phase 0 is one agent, serial.** It touches shared infrastructure (theme,
`GalleryCard`, page template) — parallelising it guarantees conflicts.

**Phase 1 is seven agents, one per track**, each owning its charts end to end:
fixture → card → page. Tracks are the parallel unit because a track shares one
fixture family, and they touch disjoint files (`gallery-<track><n>.tsx`,
`docs/charts/gallery/<slug>.mdx`). The only shared file is the gallery roster —
each track appends one block, so conflicts are trivial.

**Phase 2 is one agent, serial**: a pass over the whole page for consistency —
card heights, blurb voice, dark-mode check, motion budget, and a build/link
verification.

## 6. Guardrails for every track

1. **Real data or honestly-modelled data.** Provenance in the fixture header.
2. **No hex literals.** Theme roles only; if a role is missing, add it in Phase 0
   rather than inline.
3. **Verify the role resolves** — sample the canvas, don't trust the prop.
4. **Card motion is cheap and pauses off-screen.**
5. **Every page follows the §2b spine.** Same five sections, same order.
6. **Every number on a page is computed, not estimated.**
7. **Dark mode is checked**, not assumed.
8. **In a worktree, check which `dist` you are actually previewing.**
   `website/node_modules` is a **symlink into the main checkout**, so
   `@pond-ts/charts` resolves to `/Users/peter/Code/pond-ts/packages/charts` —
   whatever branch main happens to be on — not to your worktree's build.
   Track A lost real time to this: the stacked-area card rendered as
   unfilled spaghetti because main's `dist` predated `flatFill`, and the
   symptom is indistinguishable from "the theme role silently fell back"
   (guardrail 3). Confirm with
   `grep -c <the-feature> /Users/peter/Code/pond-ts/packages/charts/dist/*.js`
   before believing a rendering bug. To preview against your own build, add a
   temporary `configureWebpack` alias plugin in the worktree's
   `docusaurus.config.ts` pointing `@pond-ts/*` and `pond-ts` at
   `../packages/*`, and **revert it before committing**.

## 7. Risks

- **Performance.** 28 live canvases is the biggest risk. Mitigated by
  intersection-gating and one shared driver; Phase 2 measures it.
- **Palette headroom.** 5 hues won't carry an 8-series stack. Phase 0 either
  extends the ramp or the stacking cards get a sequential ramp instead of
  categorical — a design call, flagged below.
- **Data licensing.** See §2c. The finance track is most exposed.
- **Fixture weight.** The ride is ~66 KB; 28 charts of that size is ~2 MB in the
  repo. Budget per fixture and downsample where the shape survives it.
- **Silent theme fallbacks.** Roles resolve per-primitive with no warning — this
  bit twice this session. Worth a dev-mode warning in charts as a side quest.

## 8. Decisions (resolved by pjm, 2026-08-02)

1. **Keep all 28.** Over-scoped on purpose; cuts stay cheap.
2. **Colour: stay tasteful and within the page's existing look — no new
   categorical explosion.** This is the load-bearing one, and it overrides the
   "extend to 10 hues" option in §2d. The rule for a stack that needs more slots
   than the brand has hues is **tonal, not chromatic**: step tints/shades within
   one or two brand hues (a sequential ramp) rather than introducing new
   competing colours. A grid-mix with 8 sources reads as one family getting
   lighter, not a pie chart. The existing `--pond-viz-1..5` stay the categorical
   set for small-N; anything above ~4 series goes tonal.

   **Refinement (2026-08-05, after D1 shipped).** The tonal rule holds
   unchanged — what needed sharpening is _how many_ families the tonal steps
   are grouped into. The decision above predicted "reads as one family getting
   lighter" as a feature; on the built chart it reads as **ordered magnitude**,
   because that is what a single sequential ramp _means_. Eight generation
   sources are nominal, not ranked, so a lone ramp mis-encodes them however
   tasteful the hues.

   The fix stays inside this decision's own wording — "one **or two** brand
   hues". D1 now splits its eight bands 4+4 along the real grouping (thermal on
   the desaturated `--pond-viz-5`, renewable on the brand `--pond-viz-1`), four
   tonal steps in each, as the `tonalA1…4` / `tonalB1…4` area roles. Steps are
   **derived** (mix the base hue toward `--pond-surface`, opaque — `flatFill`
   slabs overlap, so alpha would compound), not sixteen new custom properties.
   Measured, it also beats the single ramp it replaced: closest of all 28 pairs
   ΔE₇₆ 10.1 light / 11.9 dark, against 9.2 / 9.0 before, and the one
   cross-family edge is ~41 — about 4× the within-family step, which is what
   makes it read as two groups rather than one ladder.

   So the rule to carry forward: **a single ramp is for genuinely ordered
   quantities; a nominal set gets its tonal steps grouped into families that
   mean something.** Climate stripes is the worked example of the former —
   annual temperature anomaly _is_ a magnitude, so its ramp is correct and was
   deliberately left untouched.

3. **Group by domain**, with in-page nav. Shape-based search is what the
   per-component reference pages already do.
4. **Pages live at `charts/gallery/<slug>`** — a sibling group under the charts
   section, distinct from the `charts/types/*` prop references they link to.
5. **Finance: use what's committed now, and plan for the section to grow.** The
   existing fixture is a **synthetic 6-week OHLC on a stub NYSE-like calendar**
   (`website/src/examples/lib/financial-fixtures.ts`, ~69 lines) — fine for the
   four Track-B cards as scoped. pjm works for a market data provider and can
   supply real sets, at which point finance earns a **fuller section of its own**
   rather than one track of four. Track B is therefore built to be _extended_:
   fixtures behind a named module, no card assuming a particular instrument.
   Whatever real data arrives keeps the §2c provenance-header rule.
