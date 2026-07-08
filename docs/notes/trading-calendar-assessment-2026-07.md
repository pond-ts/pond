# Trading calendars & the disjoint time axis — industry survey × pond assessment

> _Prepared 2026-07-08 by the Pond technical consultant agent (Claude)._
>
> **Question:** how should pond (core + `@pond-ts/charts`) support disjointed
> time-axis data — market off-hours, weekends, holidays, half-days, and
> special closures — and what are the financial industry's established
> practices?
>
> **Substrate:** pond-ts v0.41.0 (`main` @ `3695093`), verified against
> source this session (core time model + the charts x-scale surface), not
> against docs alone. Industry claims verified against live vendor docs
> 2026-07-08; URLs inline.
>
> **Status:** pre-RFC groundwork — the "trading-calendar axis" RFC that
> `docs/rfcs/financial-charts.md` §7 parked and PLAN (Tidal §) names as the
> second charts gap. Per the RFC→PLAN discipline this is forward-looking
> context, not a commitment. Sibling notes: the indicator-corpus assessment
> (`financial-indicators-assessment-2026-07.md`, whose **G1/G4** gaps this
> note picks up) and the value-axis RFC (`docs/rfcs/value-axis.md`, whose
> "time is a tag on a monotonic ordering" recognition this note leans on.)

---

## 1. Executive summary

**The industry has bifurcated into two axis models** — ordinal (bar-index
spacing; TradingView, Highstock default, ChartIQ) and discontinuous
true-time (calendar gaps surgically excised, time proportional within
sessions; d3fc, SciChart, Highcharts `breaks`). The consensus among
trader-facing products is a **hybrid: ordinal rendering driven by a
session calendar** — the calendar isn't used to make spacing proportional,
it's used for bar placement, multi-series alignment, closed-vs-missing
discrimination, future projection, and extended-hours shading.

**Recommendation in one paragraph.** Build one **session-calendar object**
— separate from both the data ops and the axis, consumed by both (every
serious system does this; SciChart states it most baldly by _requiring_
axis and data filter to share one calendar instance). Put the engine in
`@pond-ts/financial` with **pluggable calendar data** (never own exhaustive
holiday data — it's where every JS attempt died). On the core side,
**calendar-correct bucketing needs zero core edits today**: a
`calendar.sessions(range) → BoundedSequence` adapter flows unchanged
through `aggregate`/`materialize`/`align`/`rolling`, because
`BoundedSequence` already permits gapped interval lists (verified). On the
charts side, the continuous-time assumption is **already centralized behind
the `xScale` object** — a discontinuous "trading-time" scale implementing
the d3fc five-method provider surface is close to a drop-in, with exactly
four raw-ms arithmetic sites to fix. A key unification: on a regular
intra-session bar grid (5m bars), skip-closed-time discontinuous rendering
**is** uniform bar spacing — one scale mechanism delivers the ordinal look
without a second axis model.

What this unblocks beyond the axis: the four **G4-gated** studies from the
indicator assessment (session-reset VWAP, pivot anchors, PAV/PVAT), correct
session-aligned bar building (daily bars keyed to the trading day, futures
17:00-CT day rollover), and the C2 forward-projection arithmetic.

---

## 2. Industry survey — the two axis models

| Model                   | Who                                                                                         | Mechanism                           |
| ----------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------- |
| Ordinal / index         | TradingView (both products), Highstock default, ECharts-category, amCharts Gapless, ChartIQ | spacing = bar count                 |
| Discontinuous true-time | d3fc `scaleDiscontinuous`, SciChart `DiscontinuousDateTimeAxis`, Highcharts `breaks`        | spacing = time minus excised ranges |

### 2.1 Ordinal — and why the pros still carry a calendar

TradingView's **lightweight-charts** is pure ordinal: bars occupy sequential
logical indices; spacing is `barSpacing` px/bar; weekends cost nothing
([time-scale docs](https://tradingview.github.io/lightweight-charts/docs/time-scale)).
It has **no timezone support** (workaround: shift timestamps, with
documented DST caveats —
[time-zones](https://tradingview.github.io/lightweight-charts/docs/time-zones))
and multi-series alignment is **manual**, via `WhitespaceData` padding so
every series covers the union of timestamps
([whitespace demo](https://tradingview.github.io/lightweight-charts/tutorials/demos/whitespace)).
Fine for a rendering widget; not viable for a data library doing session math.

TradingView's **full charting library** keeps ordinal rendering but adds the
most complete declarative session model surveyed
([Trading Sessions](https://www.tradingview.com/charting-library-docs/latest/connecting_data/Trading-Sessions/),
[Symbology](https://www.tradingview.com/charting-library-docs/latest/connecting_data/Symbology/)):
exchange IANA `timezone`; session strings `"0930-1600"` (end non-inclusive)
with lunch-break sub-ranges (`"0930-1400,1430-1700"`), day-of-week suffixes,
**overnight sessions** (`"1700-1700"` = CME's 24h day starting 17:00 the
prior evening), and dated schedule-change history; `session_holidays` +
per-date `corrections` (half-days override holidays); typed `subsessions`
(`regular | premarket | postmarket | extended`) rendered as shaded
background areas. **ChartIQ** is the same philosophy made explicit: a
`CIQ.Market` definition plus **market iterators** that step in market time,
skipping closures — used for gap detection, future x-axis projection, and
drawing stability. Their premise: "the x-axis of a stock chart does not
generally follow calendar time"
([Market Hours tutorial](https://legacydocs.chartiq.com/tutorial-Market%20Hours%20and%20the%20Charts.html)).

**Where ordinal wins:** uniform candle spacing (candle _patterns_ are
shape-based; variable widths distort them); no calendar needed for the
naive case; gaps of any size cost nothing. **Where it breaks down** (all
observed in real issue trackers): (1) **multi-series alignment** — two
symbols with different holidays have different index↔time mappings
(lightweight-charts pushes whitespace-padding onto the user); (2) **time is
no longer proportional** — a 3-day gap and a 1-minute gap render
identically; (3) **missing data becomes invisible** — an outage compresses
away; only a calendar-backed axis can tell "closed" from "missing"; (4)
**future projection** needs a calendar anyway (ChartIQ cites this as a core
reason its iterators exist).

### 2.2 Discontinuous true-time — the d3fc provider is the right abstraction

d3fc wraps a real d3 time scale so specified ranges are excised and the
remainder stays proportional. The **discontinuity-provider interface** is
five methods
([README](https://github.com/d3fc/d3fc/blob/master/packages/d3fc-discontinuous-scale/README.md)):

```
provider.clampUp(value)      // value in a gap → gap end
provider.clampDown(value)    // value in a gap → gap start
provider.distance(v1, v2)    // domain distance EXCLUDING gaps
provider.offset(value, off)  // advance, skipping gaps
provider.copy()
```

`scaleDiscontinuous(baseScale)` adapts `scale()`, `invert`, `domain`
(clamped out of gaps), `nice()`, and `ticks()` (filters ticks inside gaps).
Known weaknesses, useful as design intel: **no built-in holiday/session
provider** — users hand-compose `discontinuityRange`, or infer gaps from
their own data ([issue #1141](https://github.com/d3fc/d3fc/issues/1141));
**tick generation degenerates** on heavily-broken domains (zero ticks in
some ranges — [issue #1167](https://github.com/d3fc/d3fc/issues/1167));
marks that synthesize their own x-offsets mis-render near gaps
([issue #1140](https://github.com/d3fc/d3fc/issues/1140)) — the exact
`neighbourSpans` failure mode found in charts (§6).

**SciChart** is calendar-driven discontinuous (built-in `NYSECalendar`,
`LSECalendar`) with the sharpest architectural rule in the survey: data
must be pre-filtered with a `DiscontinuousFilter` **constructed with the
same calendar the axis uses**
([docs](https://www.scichart.com/documentation/win/current/Discontinuous%20DateTime%20Axis%20and%20Double-Scale%20Axis.html)).
**Highcharts** ships both modes — `ordinal` (default, data-driven) and
`breaks` (calendar-driven, with `repeat` for "every night/weekend") — and
documents the squeeze between them
([xAxis.ordinal](https://api.highcharts.com/highstock/xAxis.ordinal),
[xAxis.breaks](https://api.highcharts.com/highcharts/xAxis.breaks)).
Structural insight: **ordinal is data-driven, breaks are calendar-driven**;
neither subsumes the other, which is why the hybrid (calendar-driven
rendering) is where the trader-facing products converged.

**Trading halts:** no charting library surveyed handles unscheduled halts
natively; `pandas_market_calendars`' `interruptions_df` is the only
structured representation found.

---

## 3. The calendar object — the industry's session model

### 3.1 The reference data model (Python `exchange_calendars`)

The de-facto standard
([GitHub](https://github.com/gerrymanoim/exchange_calendars)):

- **Session = one trading day, keyed by a tz-naive date** (`2022-01-03`) —
  regular hours only, by definition.
- **Schedule** = per-session UTC instants: `open`, `close`, `break_start`,
  `break_end`. Half-days are sessions with adjusted closes; **holidays are
  simply absent sessions**.
- Query surface: `is_session`, `next_session`/`previous_session`,
  `date_to_session`, `is_trading_minute`, `sessions_in_range`, and —
  crucially — **`trading_index(period, closed, force)`**: generate the
  session-aligned bar grid as a first-class calendar operation.
- A **"side"** convention: minutes closed on the left — the open minute
  belongs to the session, the close minute doesn't (pond's `[begin, end)`
  half-open buckets match this exactly).
- 50+ exchanges by MIC code; holiday data maintained by **community PRs**.

`pandas_market_calendars`
([GitHub](https://github.com/rsheftel/pandas_market_calendars)) adds
`date_range(schedule, freq, closed, force_close)` — session-aligned bar
timestamps with open-vs-close labeling and final-bar truncation — plus the
`interruptions_df` halt framework. pandas core contributes the
rule-based-holiday pattern: `Holiday` rules with **observance functions**
(`nearest_workday`, `sunday_to_monday`, …) rather than exhaustive date
lists, and `weekmask` for non-Sat/Sun weekends
([pandas timeseries](https://pandas.pydata.org/docs/user_guide/timeseries.html)).

### 3.2 The JS/TS ecosystem is a graveyard — and that's a design input

No maintained `exchange_calendars` equivalent exists on npm:
[`nyse-holidays`](https://www.npmjs.com/package/nyse-holidays) (one market,
holidays only), `trading-calendar` (hardcoded 2021–22, dead), `fincal`
(best data model of the lot — tz + regular/extended hours +
partial-days + holidays as JSON locales — but data ends ~2020, moment.js,
unmaintained). TradingHours.com **sells** maintained data. The lesson:
**ship the engine and the interface, never the exhaustive data.** Bundle a
couple of reference calendars (NYSE, CME) as rule-based generators +
recent-years special dates, document their coverage window, and make the
data pluggable — Tidal supplies its own calendar from its feed.

### 3.3 Timezone practice

- **Rules local, instants UTC** — sessions are _defined_ in exchange-local
  wall time against an IANA zone; storage/interchange is UTC ms. Both
  Python libraries and TradingView do exactly this.
- Session math **must run in the exchange zone, not fixed offsets**: NYSE
  opens 14:30 UTC in winter, 13:30 in summer; CME anchors 17:00 US Central
  year-round ([CME hours](https://www.cmegroup.com/trading-hours.html)).
  The US/EU **DST divergence weeks** (offsets shift asymmetrically for
  2–3 weeks, twice a year) are the standing test — IANA-zone math passes
  for free, fixed offsets fail twice a year.
- **Overnight sessions need an explicit trading-day-assignment rule**: the
  CME trading day begins 17:00 CT the _prior evening_ — Sunday 17:00's
  trade belongs to Monday's session. "Day = midnight-to-midnight" breaks
  here; the rule lives in the calendar, not the renderer.
- Pond's Temporal-based `calendar.ts` (tz-correct day/week/month via
  `ZonedDateTime`) is the right substrate — the session engine extends the
  same approach to intra-day wall-time rules.

### 3.4 Bar-labeling conventions (data layer)

- **Vendors open-stamp intraday bars; backtest engines re-stamp to close**
  for lookahead safety (Databento `ts_event` = open
  ([schema](https://databento.com/docs/schemas-and-data-formats/ohlcv));
  NautilusTrader re-stamps to close by default
  ([docs](https://nautilustrader.io/docs/latest/integrations/databento/))).
  A library serving both needs labeling **explicit and convertible**, not
  an implicit convention. **Pond's interval keys dissolve this ambiguity**:
  an interval-keyed bar carries `[begin, end)` — both stamps at once.
  Point-keyed ingress must declare its convention (a
  `stamped: 'open' | 'close'` knob on the OHLC ingress path).
- **Daily bars are keyed to the session/trading date, not wall-clock
  midnight**: TradingView requires D/W/M bars at 00:00 UTC _of the trading
  day_ ([time-and-sessions](https://www.tradingview.com/charting-library-docs/latest/connecting_data/time-and-sessions/));
  CME dailies key to the settlement date. In pond terms: a daily bar's
  interval is the actual session `[open, close)` — which also makes the
  candle span render correctly.
- **RTH vs all-hours is a second labeling axis**: Polygon's dailies include
  extended-hours trades per SIP rules
  ([kb](https://polygon.io/knowledge-base/article/how-does-polygon-create-the-open-high-low-close-volume-aggregate-bars))
  — an aggregation over a calendar must declare which subsessions it spans.
- **Session-aware resampling semantics** (from `trading_index` /
  `date_range`): bars never span a session boundary; the final partial bar
  truncates at the close (`force_close` — a 90-min grid on a 6.5h session
  ends short); breaks are internal boundaries; weekly bars anchor to the
  last trading day (`W-FRI`).

---

## 4. Pond core today — verified assumptions and seams

What core assumes (all verified in source this session):

1. **One continuous epoch-ms line.** Every timestamp is finite ms through
   `normalizeTimestamp` (`core/temporal.ts:35`); no tz on the key itself.
2. **Contiguous bucket grids.** `Sequence` is a closed two-kind union
   `'fixed' | 'calendar'` (`sequence/sequence.ts:46`): fixed =
   `anchor + i·step` pure arithmetic; calendar = tz/DST-correct
   day/week/month via Temporal (`core/calendar.ts`) but emits _every_
   day including weekends. `CalendarUnit = 'day' | 'week' | 'month'` only.
3. **Durations are flat ms multipliers** (`core/duration.ts` — a parser,
   not a type; units stop at `d` = 86.4M ms). "1 trading day" / "30 trading
   minutes" is unrepresentable.
4. **Sorted non-decreasing keys** — hard invariant, enforced at ingress
   (`fromColumns`, `time-series.ts:991`), relied on by every cursor/bisect.
   Uniqueness NOT assumed; **even spacing NOT assumed** — non-uniform
   ascending ms is already the native columnar storage model, so the
   storage layer needs **nothing** for disjoint-session data.
5. **Empty buckets always emitted** (`aggregate` fills with reducer
   identity; `materialize` with `undefined`); no skip/prune vocabulary.
6. **Zero session/market/holiday vocabulary anywhere** (full-package grep).

The seams, in priority order:

- **`BoundedSequence` is the golden seam.** Its validation
  (`sequence/bounded-sequence.ts:4-29`) forbids overlap and disorder but
  **permits gaps between intervals**. Every windowing operator
  (`aggregate`, `materialize`, `align`, sequence-driven `rolling`) accepts
  a `SequenceLike` and iterates its intervals. Therefore
  `calendar.sessions(range)` or `calendar.bars('5m', range)` returning a
  `BoundedSequence` gives **calendar-correct bucketing with zero core
  edits** — no weekend buckets, bars that never span a session, final-bar
  truncation at the close (the `trading_index` semantics fall out of how
  the adapter constructs the intervals).
- **A third `Sequence` kind** (`'session'`) is the eventual ergonomic
  home (`Sequence.trading(calendar, '5m')`) — more invasive, gives an
  unbounded grid definition; not needed for v1.
- **`fill`'s `maxGap`** (`batch/operators/fill.ts:174-187`) counts raw ms
  — closed-market time reads as gap. Hook: a pluggable span function
  ("trading-ms between a and b" — exactly `provider.distance`).
- **`rolling`'s duration window** (`time-series.ts:3434`) reaches back
  across overnight gaps in wall-clock ms. Two mitigations, both already
  on file: **G1 count-based windows** (indicator assessment — reaffirmed
  here as the highest-priority core ask precisely because it decouples the
  whole K1 indicator family from the calendar), and
  `partitionBy('session')` on a derived session-id column as the
  zero-core-change stopgap that stops fill/rolling bridging sessions.
- **`Duration` vocabulary** — leave alone for now. Session-relative
  durations only matter once someone asks for "last 30 trading minutes"
  as a _duration_ rather than a count; G1 serves the actual demand.

---

## 5. Pond charts today — the continuity assumption is centralized

Verified: there is **one x-scale factory site**
(`ChartContainer.tsx:508-521`, d3 `scaleTime`/`scaleLinear`, range
`[0, plotWidth]`) published on context as
`ContainerFrame.xScale: ScaleTime | ScaleLinear` (`context.ts:132`), and
the design already anticipates swapping kinds — the doc comment frames
consumers as using only the shared `invert`/`ticks`/`tickFormat` surface.
**Every mark draws through the callable-only
`Scale = (value: number) => number` contract** (`line.ts:16`); no mark
reimplements the linear mapping. All inversions (cursor, crosshair snap,
annotations, axis pills, readout) go through `xScale.invert`; all ticks
(axis, gridlines) through `xScale.ticks()`.

The **complete list** of sites assuming continuous linear time:

1. **Scale construction** — `ChartContainer.tsx:508` (the swap point).
2. **Pan/zoom domain arithmetic** — `viewport.ts:14-37` (raw-ms
   shift/interpolation, `minDuration` ms floor) and the pan gesture's
   `dt = -dx · span/plotWidth` (`Layers.tsx:358`), which assumes uniform
   px-per-ms. Fix: run pan/zoom through `provider.offset`/`distance`
   (trading-ms space).
3. **Point-key slot synthesis** — `neighbourSpans` (`data.ts:413-429`)
   sizes candle/bar slots from **raw-ms neighbour gaps**: the candles
   flanking a weekend get a ~2.5-day-wide slot. (The same failure d3fc
   documents as [issue #1140](https://github.com/d3fc/d3fc/issues/1140).)
   Fix: compute spans in trading-time (or scaled-pixel) space.
   Interval-keyed series are immune — the key carries the real session
   `[begin, end)`.
4. **Tick generation** — `XAxis.tsx:164`, `Layers.tsx:102` already
   delegate to `scale.ticks()`, so they're free **if** the trading scale
   implements its own tick generator. It must — d3's would place ticks
   inside removed gaps, and d3fc's filter-the-ticks approach is its known
   weak spot (§2.2). Calendar-aware ticks are a feature, not a patch:
   session opens, day boundaries at session starts, month boundaries at
   first-trading-days.

Also relevant: charts' `gap`/`GapMode` vocabulary is about **NaN runs in
data**, not axis time — no collision, but the calendar creates the missing
distinction ("closed" vs "missing"): a data gap _during_ market hours is
real missingness; a gap spanning closed time is not. Gap modes can consult
the calendar later.

The `xKind: 'time' | 'value'` union and the value-axis work are the
precedent: "time is a tag on a monotonic ordering" (value-axis RFC §4). A
trading-time scale is a third flavor — wall-clock domain, monotonic
trading-time transform behind the same object surface.

---

## 6. Proposed architecture

### 6.1 One calendar, three consumers (the SciChart rule)

```
            ┌────────────────────────────┐
            │  TradingCalendar           │   engine in @pond-ts/financial;
            │  (rules → sessions)        │   data pluggable, reference
            └────────────┬───────────────┘   calendars bundled (NYSE, CME)
                         │
      ┌──────────────────┼──────────────────────┐
      ▼                  ▼                      ▼
 data ops           bar building           charts x-scale
 (sessions →        (calendar.bars(…) →    (discontinuity provider →
 BoundedSequence;   session-aligned        scaleTradingTime; ticks;
 session VWAP,      aggregate; daily =     shading; pan/zoom in
 pivots — G4)       session [open,close))  trading-time)
```

- **Interface, structurally typed.** Charts must not depend on
  `@pond-ts/financial`. Charts declares the minimal structural type it
  needs (the five-method discontinuity provider + a sessions iterator for
  ticks/shading); the financial package's `TradingCalendar` satisfies it.
  Same pattern as `ChartTheme` — the consumer (Tidal) passes the **same
  calendar object** to data ops and the chart, satisfying the shared-
  calendar rule without package coupling.
- **Session model** (union of §3 findings): session keyed by trading date;
  open/close as exchange-local wall time + IANA zone (computed to UTC ms
  via the Temporal machinery core already uses); optional intraday breaks;
  holidays = absent sessions; half-days = per-date overrides; overnight
  sessions with an explicit trading-day rule; typed subsessions
  (`regular | premarket | postmarket`); per-date corrections. Rule-based
  generation (weekmask + observance rules) + explicit special dates, per
  the pandas pattern.
- **Core takes no calendar dependency.** v1 attaches at `BoundedSequence`
  (zero core edits). Candidate core asks stay narrow and demand-driven:
  G1 count windows (already the top ask), later a pluggable gap-span
  function for `fill.maxGap`, later a `Sequence` `'session'` kind.

### 6.2 The scale: trading-time discontinuous, which subsumes ordinal

Implement `scaleTradingTime(calendar)` in charts: domain is wall-clock ms,
but the pixel mapping runs through cumulative _trading_ ms
(`provider.distance` from the domain start). Full object surface
`{ (v), invert, ticks, tickFormat, domain, range, copy }` so it drops into
the existing context union; `invert` clamps pixels in removed regions to
the nearest session edge (`clampUp`/`clampDown`).

**The unification worth stating explicitly:** for a regular intra-session
bar grid (5m bars — the Tidal sweet spot), removing closed time makes bar
spacing uniform — the **ordinal look falls out of the discontinuous scale**.
Within sessions time stays proportional (which ordinal axes lose), a
3-day gap costs nothing (which continuous axes lose), and daily bars come
out near-uniform (sessions vary only by half-days). A separate pure-ordinal
(index-space) mode is only needed for irregular cadence — tick data,
mixed-interval overlays — and should be deferred until someone asks;
revisit against the value-axis `ValueSeries` machinery if it comes (an
index axis is a value axis).

**What the hybrid keeps from the ordinal camp:** because the scale is
calendar-driven (not data-driven like amCharts/lightweight-charts), two
symbols on one NYSE calendar align by construction; "closed" is
distinguishable from "missing"; future projection (C2's forward offsets,
`provider.offset(lastBar, +26 bars)`) is well-defined. Multi-_calendar_
containers (NYSE symbol + CME symbol on one x) are explicitly out of
scope — even SciChart requires one shared calendar; that's the industry
floor too.

### 6.3 Phasing (proposal)

- **Phase 0 — recipe, today.** Hand-built gapped `BoundedSequence` +
  `partitionBy(sessionId)` document what works with zero library changes;
  doubles as the API-discovery spike for the adapter.
- **Phase 1 — calendar engine** in `@pond-ts/financial`: session model,
  rules → schedule, NYSE + CME reference calendars (documented coverage
  window), `sessions(range)`/`bars(period, range)` → `BoundedSequence`,
  session slicing for the G4 studies (session VWAP, pivot anchors), the
  `stamped: 'open' | 'close'` ingress knob. Pure data — testable against
  `exchange_calendars` fixtures.
- **Phase 2 — charts `scaleTradingTime`**: the provider interface
  (structural), scale + calendar-aware tick generator, the four §5 fixes
  (construction swap, viewport math, `neighbourSpans`, ticks). Feature-axis
  stories per the story discipline (weekend skip, holiday, half-day,
  overnight session, DST week, cursor-snap at session edges).
- **Phase 3 — polish, demand-driven**: extended-hours shading (typed
  subsessions → background regions; the annotation `Region` machinery is
  prior art), closed-vs-missing gap semantics, `fill.maxGap` span hook,
  `Sequence.trading(...)` sugar, halts/interruptions if Tidal's feed
  surfaces them.

G1 (count windows) proceeds independently — it's the indicator track's top
ask and _reduces_ what the calendar must carry.

---

## 7. Open questions (for the RFC red-team)

1. **Package placement.** Engine in `@pond-ts/financial` (recommended —
   Tidal-driven, financial-domain) vs a standalone `@pond-ts/calendar`.
   Business-hours dashboards (network-traffic, ops) could want the same
   engine eventually; extraction is cheap later if the interface is
   structural from day one.
2. **Charts prop surface.** `calendar` on `ChartContainer` (implies
   trading-time scale + tick behavior + shading in one move) vs a
   lower-level `discontinuities` prop (d3fc-style, calendar-agnostic)?
   Lean: the low-level prop is the primitive, `calendar` the sugar.
3. **Daily/weekly rendering on the trading scale.** Daily bars: session
   spans give near-uniform widths (half-days ~3.5/6.5 wide) — acceptable
   or does daily want per-bar uniform (ordinal) rendering? TradingView
   renders daily uniformly; pin with Tidal against real charts.
4. **DST-week within-session proportionality** — sessions are constant in
   local wall time, so trading-ms per session is stable; verify the tick
   generator across the US/EU divergence weeks (the standing test, §3.3).
5. **Reference-calendar maintenance contract.** How many years of special
   dates do bundled calendars carry, and what's the update story —
   community PRs (the `exchange_calendars` model), or explicitly "Tidal
   supplies its own data" with bundled calendars as demo-grade?
6. **Where does the derived session-id column live** (the
   `partitionBy('session')` stopgap and the halts story both want it) —
   a `calendar.tagSessions(series)` helper in financial?

---

## Amendment 1 — §7 open questions resolved (pjm17971, 2026-07-08)

> _Responses from pjm17971 in session; recorded by the Pond technical
> consultant agent (Claude). These are design positions to carry into the
> RFC, not yet PLAN commitments._

1. **Package placement — `@pond-ts/financial`, with a boundary rule.**
   Confirmed, with a sharpening: the financial package has so far contained
   **no React code, and that stays true**. Primitives built on pond-ts
   (the calendar engine, session math, `sessions → BoundedSequence`) live
   in `@pond-ts/financial`; anything React (the scale integration, the
   `calendar` container prop, shading components) lives in
   `@pond-ts/charts`. The structural-interface split (§6.1) is what makes
   this clean — charts types the provider surface it consumes, financial
   ships an object satisfying it, neither imports the other.
2. **Charts prop surface — `calendar` on `ChartContainer`, as a
   counterpart to `range`.** The lean stands: the low-level
   discontinuity-provider prop is the primitive, `calendar` the sugar; the
   container-level `calendar` is the shape consumers see, sitting
   alongside `range` in the container vocabulary.
3. **Daily/weekly rendering — uniform per bar; TradingView is the lead.**
   Confirmed that TradingView renders a half-day daily bar at the same
   width as a full session, and that's the look to follow. Resolution
   mechanism: the provider's **distance metric** is the knob — intraday
   charts measure trading-ms (proportional within sessions); daily+ charts
   measure **session count** (each session = 1 unit → uniform daily bars,
   half-days included). Same five-method interface, two metrics; no
   second axis model.
4. **DST-week verification — accepted as stated** (feature-axis story +
   tick-generator test across the US/EU divergence weeks).
5. **Calendar data — bring-your-own, full stop.** pond bundles only a
   **weekend-skip reference calendar** as a demo/spike aid — explicitly
   "not in the game" of maintaining exchange holiday data. No NYSE/CME
   calendars in the package (revising §6.3 Phase 1, which proposed
   bundling them); the Tidal context sources its own calendar data for its
   own use. This is stronger than the exchange_calendars community-PR
   model and fully avoids the data-rot graveyard (§3.2).
6. **Session-id column placement — unresolved**; carries to the RFC
   red-team as an open question.

Net effect on phasing: Phase 1 drops the NYSE/CME reference calendars in
favor of the weekend-skip reference + the calendar-definition interface
(rules → schedule) that consumers feed their own data into. Everything
else stands.

---

## 8. Sources (primary)

- TradingView [time-scale](https://tradingview.github.io/lightweight-charts/docs/time-scale) · [time-zones](https://tradingview.github.io/lightweight-charts/docs/time-zones) · [Trading Sessions](https://www.tradingview.com/charting-library-docs/latest/connecting_data/Trading-Sessions/) · [Extended Sessions](https://www.tradingview.com/charting-library-docs/latest/connecting_data/Extended-Sessions/) · [Time & sessions](https://www.tradingview.com/charting-library-docs/latest/connecting_data/time-and-sessions/)
- d3fc [discontinuous-scale README](https://github.com/d3fc/d3fc/blob/master/packages/d3fc-discontinuous-scale/README.md) · issues [#1141](https://github.com/d3fc/d3fc/issues/1141), [#1167](https://github.com/d3fc/d3fc/issues/1167), [#1140](https://github.com/d3fc/d3fc/issues/1140) · [Scott Logic worked example](https://blog.scottlogic.com/2018/09/21/d3-financial-chart.html)
- Highcharts [xAxis.ordinal](https://api.highcharts.com/highstock/xAxis.ordinal) · [xAxis.breaks](https://api.highcharts.com/highcharts/xAxis.breaks)
- ChartIQ [Market Hours tutorial](https://legacydocs.chartiq.com/tutorial-Market%20Hours%20and%20the%20Charts.html) · [CIQ.Market](https://documentation.chartiq.com/CIQ.Market.html)
- SciChart [DiscontinuousDateTimeAxis](https://www.scichart.com/documentation/win/current/Discontinuous%20DateTime%20Axis%20and%20Double-Scale%20Axis.html)
- [exchange_calendars](https://github.com/gerrymanoim/exchange_calendars) · [pandas_market_calendars](https://github.com/rsheftel/pandas_market_calendars) · [pandas timeseries guide](https://pandas.pydata.org/docs/user_guide/timeseries.html)
- Databento [OHLCV schema](https://databento.com/docs/schemas-and-data-formats/ohlcv) · NautilusTrader [Databento integration](https://nautilustrader.io/docs/latest/integrations/databento/) · Polygon [aggregates kb](https://polygon.io/knowledge-base/article/how-does-polygon-create-the-open-high-low-close-volume-aggregate-bars)
- CME [trading hours](https://www.cmegroup.com/trading-hours.html)
