# @pond-ts/financial — indicator corpus assessment (ChartIQ studies × pond)

> _Prepared 2026-07-07 by the Pond technical consultant agent (Claude)._
>
> **Corpus:** ChartIQ "Using and Customizing Studies — Definitions"
> (documentation.chartiq.com), fetched 2026-07-07 — **124 built-in studies**,
> the de-facto coverage benchmark for a commercial financial-charting stack.
>
> **Substrate:** pond-ts v0.41.0 (`main` @ `3695093`), verified against
> `packages/core/src/batch/time-series.ts` — not against docs alone.
>
> **Status:** pre-RFC groundwork for the `@pond-ts/financial` package
> (PLAN.md § Active experiments / Tidal). Per the RFC→PLAN discipline this
> is forward-looking context, not a commitment. The charts-side sibling is
> `docs/rfcs/financial-charts.md` (candlestick — Phase 1 shipped, PR #357).

---

## 1. Executive summary

**Verdict: the ChartIQ study set is almost entirely expressible on pond
today.** Of 124 studies:

| Disposition                                                 | Count | Notes                                                                 |
| ----------------------------------------------------------- | ----: | --------------------------------------------------------------------- |
| Implementable on current pond primitives                    |  ~110 | via the ~11 kernels of §4                                             |
| Implementable but **gated on calendar/session support**     |     4 | Pivot Points, PAV, PVAT, session-reset VWAP (see G4)                  |
| **Chart-display studies**, not analytics (charts pkg scope) |     3 | Volume Chart, Volume Underlay, Valuation Lines                        |
| **Skip — proprietary formula** (legal)                      |     1 | GoNoGo Trend                                                          |
| **Skip/defer — requires non-OHLCV data shapes**             |     2 | Option Sentiment by Strike (options chain), Depth of Market (L2 book) |

The deeper finding is structural: **the 124 studies compile down to about
eleven kernels** (§4), most of which pond core already ships (rolling
reducers incl. `stdev`/`p<Q>`/`median`, `smooth('ema')`, `scan`,
`cumulative`, `diff`/`shift`/`pctChange`, `join`/`joinMany`, `byColumn`
histograms, `partitionBy`). `@pond-ts/financial` is therefore mostly a
**vocabulary package** — named, parameterized, composable wrappers with a
shared moving-average engine — not a new computational layer.

Two pond gaps are load-bearing and should be flagged upstream (full list §5):

1. **G1 — no count-based (N-bar) rolling windows.** `rolling()` windows are
   `DurationInput` only. Every ChartIQ period is a **bar count**. On a
   gapless regular grid `14 bars ≡ 14×barSize` and the duration form works;
   across session gaps (overnight, weekends) duration windows are simply
   wrong. This is the single most important core ask.
2. **G2 — `scan` is single-column.** The path-dependent studies (Parabolic
   SAR, SuperTrend, ATR Trailing Stop, ZigZag, Darvas, Klinger, NVI/PVI)
   need a stateful fold reading **several columns per row** (high, low,
   close…). The sanctioned workaround is a stateful closure in `map()`
   (PLAN § LiveSmooth notes); the library wants a first-class row-wise fold.

Everything else is either already there, assemblable from moments
(correlation/beta/regression), or a small reducer addition (rolling
argmax for Aroon).

---

## 2. Ground rules — sourcing and legal

- **Implement from published formulas, never from ChartIQ source.** The
  ChartIQ library is proprietary commercial code. This corpus is used
  strictly as a **coverage checklist** (names, parameters, data
  requirements — facts not protectable as expression). Each indicator gets
  implemented from its public literature definition (Wilder 1978, Appel,
  Lambert, Chande, Ehlers, Pring, Williams, …), cited in its doc comment.
- **Bar-for-bar ChartIQ parity is a non-goal.** Several studies have
  multiple published variants (flagged `AMBIG` in §6); we pin _a_ documented
  definition and state it, rather than reverse-engineering ChartIQ's choice.
- **Trademarks.** "Bollinger Bands®" is a registered trademark of John
  Bollinger — nominative use of the name for the standard formula is normal
  industry practice (every OSS TA library ships it) but the docs should use
  the ® on first mention and cite Bollinger. "GoNoGo Trend" is different in
  kind: the _formula itself_ is proprietary/licensed (ChartIQ licenses it
  from GoNoGo Charts) — **skip entirely** (§5 F-LEGAL).
- **No ChartIQ vocabulary leakage.** Study _names_ are generic industry
  names; ChartIQ-specific coinages (e.g. "Valuation Lines", "Projected
  Volume at Time") get either a generic rename or an explicit "ChartIQ
  calls this X" note.

---

## 3. The pond substrate (verified, v0.41.0)

What `@pond-ts/financial` gets to build on — verified in
`packages/core/src/batch/time-series.ts` this session:

| Primitive                                 | Signature sketch                                                                                                              | Indicator relevance                                                                                                               |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `rolling(window, mapping, opts?)`         | duration window; `alignment: trailing/leading/centered`; `minSamples` gate; sequence-driven overload                          | SMA, rolling stdev/min/max/sum, %R, stochastics, Donchian, CMF… **Duration-only — see G1**                                        |
| Reducers                                  | `sum avg min max count first last median stdev p<Q> difference top<N> unique keep samples` + custom `(values) => value`       | covers every windowed stat needed except MAD (CCI) and argmax (Aroon) — both expressible as custom reducers                       |
| `smooth(col, 'ema', {alpha, warmup})`     | causal EMA, gap-carrying                                                                                                      | EMA family; `alpha = 2/(n+1)` for standard EMA, `1/n` for Wilder                                                                  |
| `scan(source, step, init, {output?})`     | typed-accumulator mapAccumL, **single numeric source column**                                                                 | recursive smoothers on a prepared column (TRIX chain, Fisher recursion, KAMA/VIDYA) — **multi-column machines need G2**           |
| `cumulative({col: reducer\|fn})`          | running accumulators                                                                                                          | OBV, A/D line, PVT, VWAP numerator/denominator                                                                                    |
| `diff / pctChange / rate (cols, {drop?})` | previous-row deltas                                                                                                           | momentum, ROC(1), force index, true-range components                                                                              |
| `shift(cols, n)`                          | lag (`n>0`) / lead (`n<0`) by rows, vacated = `undefined`                                                                     | N-bar ROC/momentum, DPO displacement, Ichimoku Chikou; **forward plot past series end is G5**                                     |
| `map(schema, fn)` / `mapColumns(spec)`    | row-wise (sees full event) / per-cell numeric                                                                                 | all bar arithmetic (typical price, CLV, BOP…); the stateful-closure escape hatch for G2                                           |
| `baseline(col, {window, sigma, …})`       | rolling avg + stdev + upper/lower                                                                                             | **is already Bollinger Bands** modulo the count-window caveat                                                                     |
| `join / joinMany / merge`                 | inner/left/right/outer exact-key; `onConflict: prefix`                                                                        | two-symbol studies (Beta, correlation, Price Relative) after `align()`                                                            |
| `align(seq) + fill(strategy)`             | grid resample; hold/bfill/linear/zero, `limit`/`maxGap`                                                                       | aligning a comparison symbol; broadcasting higher-timeframe values (pivots) onto bars                                             |
| `aggregate(seq, mapping)`                 | calendar-grid bucketing                                                                                                       | bar building (tick→1m→1d roll-ups), prior-period H/L/C for pivots                                                                 |
| `byColumn(col, {width\|edges}, mapping)`  | value-bin histogram; **explicitly supports non-monotonic sources** (doc: "a non-monotonic source (power) yields a histogram") | **Volume Profile works today**: `byColumn('close', {width}, {vol: {from:'volume', using:'sum'}})`                                 |
| `partitionBy(col)`                        | scoped stateful ops per entity                                                                                                | multi-symbol batches; per-strike partitioning if options data ever lands                                                          |
| Column model                              | number / string / boolean / array; missing = `undefined`; non-finite treated as missing (reducer NaN policy)                  | OHLCV = plain numeric columns by convention; string columns carry categorical outputs (Elder Impulse color, SuperTrend direction) |
| Live layer                                | `LiveAggregation`, `LiveRollingAggregation`, add/remove/snapshot reducer protocol                                             | the eventual incremental-indicator story (out of scope for batch-first v1)                                                        |

OHLC is **naming convention, not a type** — core has no bar semantics. That
is fine; `@pond-ts/financial` supplies the column contract (§8.1).

---

## 4. Kernel decomposition — what 124 studies actually reduce to

Every study in §6 is expressed as a composition of these kernels. This is
the implementation plan in miniature: build the kernels once, then each
named study is a short, testable assembly.

| #       | Kernel                                                                                   | Pond mapping                                                                                                                                           | Consumed by (examples)                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| **K1**  | Rolling window reducer over N bars (sum/avg/stdev/min/max/median/p\<Q\>/custom)          | `rolling()` — **needs G1 count windows for correctness on gapped data**                                                                                | SMA, Donchian, stochastics, %R, HHV/LLV, CMF, Ulcer, CCI (custom MAD), UO, VHF, Choppiness (~45 studies)                            |
| **K2**  | Moving-average engine — one implementation per MA type, shared as a parameter vocabulary | `smooth('ema')`, `rolling` avg, `scan` for recursive types (Wilder/SMMA, Hull, VIDYA, KAMA, triangular, weighted, time-series/regression MA, zero-lag) | the ~25 studies exposing ChartIQ's "MA Type" input, plus MACD, TRIX, GMMA, Alligator, Rainbow…                                      |
| **K3**  | Per-bar arithmetic (multi-column, same row)                                              | `map()` / `mapColumns()`                                                                                                                               | typical/median/weighted price, high−low, CLV, BOP, EOM, MFI(BW), SI (~30 studies)                                                   |
| **K4**  | Previous-bar / N-bar-back reference                                                      | `diff`, `pctChange`, `shift(n)` + arithmetic                                                                                                           | true range, momentum, all ROC variants, +DM/−DM, Vortex, ASI, Coppock, KST                                                          |
| **K5**  | Cumulative-from-anchor                                                                   | `cumulative()`, or `slice(anchor)` + `cumulative`                                                                                                      | OBV, A/D, PVT, VWAP, Anchored VWAP, ASI, TVI                                                                                        |
| **K6**  | Path-dependent state machine (regime flips, pivot confirmation)                          | `scan` when single-input; **stateful `map()` closure until G2**                                                                                        | PSAR, SuperTrend, ATR Trailing Stop, ZigZag, Darvas, Klinger trend state, NVI/PVI, Fractals, Ehler Fisher recursion                 |
| **K7**  | Rolling linear regression (slope / intercept / R² / forecast)                            | assembled from rolling moments: Σy, Σiy with deterministic Σi, Σi² per window — two K1 sums + closed-form                                              | LR Slope/Intercept/R²/Forecast, Time Series Forecast, TSF-MA, Chande Forecast Osc, Center of Gravity (weighted-moment cousin)       |
| **K8**  | Two-series combinator (align + join + rolling bivariate moments)                         | `align` → `joinMany` → derive product columns via `map` → K1 sums → closed-form corr/β                                                                 | Beta, Correlation Coefficient, Price Relative / Relative Strength, Performance Index                                                |
| **K9**  | Value-domain histogram (price bins)                                                      | `byColumn('close' \| 'typicalPrice', {width\|edges}, {vol:{from:'volume',using:'sum'}})` — non-monotonic OK                                            | Volume Profile (compute side)                                                                                                       |
| **K10** | Band combinator: `center ± multiplier × width`, or `center × (1 ± pct)`                  | pure assembly of K1/K2 outputs (`baseline()` is the shipped special case)                                                                              | Bollinger (+ %B, Bandwidth), Keltner, STARC, ATR Bands, MA Envelope, High-Low Bands, Prime Number Bands, Donchian (min/max variant) |
| **K11** | Session/calendar-anchored windows (trading day, time-of-day-across-days)                 | **not available — G4**; partial workaround via `aggregate` on wall-clock days + `align`/hold broadcast                                                 | Pivot Points, PAV, PVAT, session-reset VWAP                                                                                         |

Supporting observation: ChartIQ's ubiquitous **"Field" input** (run any
study over any column, including another study's output) is exactly pond's
`column`/`output` option pattern — compositionality falls out for free, and
it is a hard API requirement (§8.2): **no kernel may hardcode `'close'`**.

---

## 5. Flags — pond gaps and non-pond blockers

The explicit flag registry requested. `G*` = pond requirement, `F-*` =
non-pond blocker.

### G1 — count-based rolling windows _(core ask; highest priority)_

`rolling()` accepts `DurationInput` only (verified,
`time-series.ts:3418`). All TA periods are bar counts. Workaround —
duration = `n × barSize` — is exact **only on a gapless regular grid** and
silently wrong across overnight/weekend gaps (a "14-day RSI" window
spanning a weekend contains 12 bars; `minSamples` can mask but not fix the
misalignment). Proposal: a count-window spec (`rolling({count: 14}, …)` or
similar) that keys membership on row index, not time. Cheap in the columnar
engine (index arithmetic instead of a time bisect) and it makes the whole
K1 family calendar-independent — largely _decoupling_ the indicator library
from G4.

### G2 — multi-column stateful fold

`scan(source, step, init)` reads **one** numeric column (verified,
`time-series.ts:3016`). PSAR's step reads `high`, `low` and carries
`{sar, ep, af, dir}`; SuperTrend reads `high, low, close` plus its band
state. Sanctioned workaround: stateful closure inside `map()` (PLAN already
blesses "EMA is a closure in `map()`"), at the cost of event
materialization and purity. Proposal: either a core `scanRows`/`foldEvents`
(typed acc, row view in, partial row out) or, initially, a private kernel
inside `@pond-ts/financial` — upstream once the shape is proven. Also
subsumes the multi-column-window awkwardness in Random Walk Index.

### G3 — rolling argmax / bars-since-extreme _(small)_

Aroon needs "bars since highest high in window", not the max itself. No
argmax reducer. Workarounds: custom reducer over `samples` (O(window) per
row) or a deque-based kernel in the library. Fine to keep library-side;
promote to a core reducer only if others want it.

### G4 — trading calendar / sessions _(known, already parked)_

Already named in `docs/rfcs/financial-charts.md` §7 and PLAN (trading-
calendar axis). Blocks correct: Pivot Point anchor rules (ChartIQ:
intraday→daily/weekly pivots, session starts midnight ET equities / 5pm
forex / 6pm metals), Projected Aggregate Volume + Projected Volume at Time
(time-of-day profiles across the last M trading days), and session-reset
VWAP. **Recommendation: gate these four studies on the calendar work rather
than half-building sessions inside the indicator library** — with G1
landed, nothing else in the corpus needs the calendar for _computation_.

### G5 — forward displacement past the series end

Ichimoku Senkou spans plot 26 bars **into the future**; Alligator lines are
offset forward. `shift(cols, -n)` moves values across existing rows only —
there are no rows past the last bar to land on. Options: (a) emit the
displaced series re-keyed to future bar times (bar times are calendar-
dependent intraday → touches G4; trivial for daily), or (b) leave the data
undisplaced and give the chart layer a per-series x-offset-in-bars. (b) is
where ChartIQ itself does it and matches pond's data/marks separation —
recommend (b), flag to the charts roadmap.

### G6 — repainting studies vs the live layer

ZigZag (last leg is provisional until reversal confirms), Fractals (need 2
future bars), Darvas (box completes retroactively). Batch: no issue.
Live: an append-only stream cannot revise history — these need either a
"provisional tail" convention or recompute-on-window semantics. Not a v1
problem (batch first) but must be on the record before the live phase.

### G7 — bivariate rolling moments _(note only, no core change)_

Rolling correlation/covariance/beta need Σxy across two columns; rolling
reducers are single-source. Standard assembly: derive `xy`, `x²`, `y²`
columns via `map`, then K1 sums, then closed-form. Works today; just
watch numerical stability (catastrophic cancellation on
`Σxy − ΣxΣy/n`) — use compensated/two-pass forms in the kernel.

### F-LEGAL — GoNoGo Trend → **skip**

Proprietary licensed methodology (GoNoGo Charts); no published formula.
Cannot implement without reverse-engineering a licensed product. Skip;
document the omission.

### F-DATA — Option Sentiment by Strike, Depth of Market → **defer**

Not OHLCV time-series studies: per-strike options volume/OI
(cross-sectional chain snapshots) and L2 order-book depth. Pond _could_
model both (partitioned series per strike / per level) but the blocker is
the data contract, not the math — and both are as much chart types as
studies. Defer until Tidal has the feed; note the Tidal wire-format /
columnar-ingress track (PLAN) is where per-strike data would arrive.

### F-CHART — display studies → charts-package scope

Volume Chart and Volume Underlay are render modes of raw volume (BarChart
under the price panel — largely shipped charts capability). Valuation
Lines (ChartIQ coinage) = average ± n·σ of the **visible viewport** —
viewport-dependent, so it's a charts feature fed by a trivial `reduce`;
also Volume Profile's _rendering_ (horizontal histogram overlay) and
ZigZag/Darvas overlays are charts-roadmap items distinct from their
(implementable) computations.

### F-AMBIG — definition-variant studies

Multiple incompatible published definitions exist; we pin one and document
it (ChartIQ parity not guaranteed): Trend Intensity Index, Relative
Volatility, Twiggs Money Flow (Twiggs' own TR variant), RAVI, Shinohara
Intensity Ratio (two ratio conventions), Pretty Good Oscillator, Projected
Aggregate Volume / Volume at Time (ChartIQ-specific projections), Ulcer
Index smoothing choices, Klinger (several signal conventions).

---

## 6. Study-by-study mapping (all 124)

Legend: kernels from §4; flags from §5. "MA-type" = takes the shared K2
engine as a parameter. Data column only notes requirements beyond OHLCV.

### 6.1 Moving averages & smoothing (K2 family)

| Study                      | Kernels      | Notes                                                                                                                                                                                                                              |
| -------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Moving Average (≈11 types) | K2           | the engine itself: simple, exponential, weighted, Welles Wilder (SMMA), triangular, time-series (LR forecast, K7), variable/VIDYA (CMO-adaptive, K6 recursion), Hull, zero-lag variants — pin the exact menu during implementation |
| MACD                       | K2           | fast/slow EMA + signal EMA + histogram; 3 output columns                                                                                                                                                                           |
| Moving Average Cross       | K2 + K4      | 2–3 MAs + sign-change cross events; marker rendering chart-side                                                                                                                                                                    |
| Moving Average Deviation   | K2 + K3      | price − MA, points or percent                                                                                                                                                                                                      |
| Moving Average Envelope    | K2 + K10     | MA × (1 ± shift%)                                                                                                                                                                                                                  |
| Guppy GMMA                 | K2           | 12 fixed EMAs                                                                                                                                                                                                                      |
| Rainbow Moving Average     | K2           | 10 recursive SMAs (SMA of SMA…)                                                                                                                                                                                                    |
| Rainbow Oscillator         | K2 + K1      | rainbow stack + rolling HH/LL of price                                                                                                                                                                                             |
| Alligator                  | K2 + K3      | SMMAs of median price, forward-offset → **G5**                                                                                                                                                                                     |
| Gator Oscillator           | K2 + K3      | abs(jaw−teeth), abs(teeth−lips) histograms → **G5**                                                                                                                                                                                |
| TRIX                       | K2 + K4      | triple EMA, 1-bar log ROC, signal                                                                                                                                                                                                  |
| Schaff Trend Cycle         | K2 + K1 + K6 | MACD → double stochastic recursion                                                                                                                                                                                                 |
| Detrended Price Oscillator | K2 + `shift` | price vs MA displaced (n/2+1) bars back                                                                                                                                                                                            |
| Disparity Index            | K2 + K3      | 100·(C−MA)/MA; MA-type                                                                                                                                                                                                             |
| Coppock Curve              | K4 + K2      | WMA of (ROC₁₄+ROC₁₁); monthly convention                                                                                                                                                                                           |
| Pring's KST                | K4 + K2      | 4 smoothed ROCs, weighted sum + signal                                                                                                                                                                                             |
| Pring's Special K          | K4 + K2      | extended KST (more terms)                                                                                                                                                                                                          |
| Price Oscillator           | K2           | fast−slow MA (abs or %)                                                                                                                                                                                                            |
| Price Momentum Oscillator  | K4 + K2      | DecisionPoint double custom smoothing (2/n) ×10 + signal                                                                                                                                                                           |

### 6.2 Bands, channels, envelopes (K10 family)

| Study                    | Kernels             | Notes                                                                                       |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------------- |
| Bollinger Bands®         | K1 + K10            | core `baseline()` is exactly this today (duration window, G1 caveat); MA-type on the center |
| Bollinger Bandwidth / %B | K10 derived         | pure arithmetic on band columns                                                             |
| Keltner Channel          | K2 + K10            | MA(TP) ± mult·avg TR (classic) — pin variant                                                |
| STARC Bands              | K2 + K10            | MA ± mult·ATR                                                                               |
| ATR Bands                | K2(wilder TR) + K10 | field ± mult·ATR                                                                            |
| Donchian Channel / Width | K1                  | rolling max(H) / min(L); separate high/low periods                                          |
| High Low Bands           | K2 + K10            | MA of median price × (1 ± shift%)                                                           |
| Prime Number Bands       | K3                  | nearest prime ≤/≥ high/low per bar — quirky but deterministic                               |
| Fractal Chaos Bands      | K6                  | stepwise bands from confirmed fractals → **G6** repaint                                     |
| Moving Average Envelope  | (listed §6.1)       |                                                                                             |

### 6.3 Momentum oscillators (K1/K2/K4)

| Study                      | Kernels         | Notes                                                                           |
| -------------------------- | --------------- | ------------------------------------------------------------------------------- |
| RSI                        | K4 + K2(wilder) | up/down averages, Wilder smoothing                                              |
| Stochastics                | K1 + K3 + K2    | %K = (C−LL)/(HH−LL); fast/slow smoothing                                        |
| Stochastic Momentum (SMI)  | K1 + K2         | double-EMA of distance from HH/LL midpoint                                      |
| Williams %R                | K1 + K3         | (HH−C)/(HH−LL)                                                                  |
| CMO (Chande)               | K4 + K1         | unsmoothed up/down sums                                                         |
| Momentum                   | `shift` + K3    | C − C[n]                                                                        |
| Price Rate of Change       | `shift` + K3    | any Field                                                                       |
| Intraday Momentum Index    | K3 + K2(wilder) | RSI form on (C−O)                                                               |
| Awesome Oscillator         | K3 + K1         | SMA5−SMA34 of (H+L)/2                                                           |
| Ultimate Oscillator        | K3 + K4 + K1    | BP/TR sums over 3 horizons, weighted                                            |
| CCI                        | K3 + K1(custom) | needs mean-absolute-deviation reducer — custom reducer over `samples`           |
| Ehler Fisher Transform     | K1 + K6         | rolling HH/LL normalize + recursive Fisher — `scan` on prepared column suffices |
| Psychological Line         | K4 + K1         | % up-closes in window                                                           |
| Pretty Good Oscillator     | K2 + K3         | (C−SMA)/EMA(TR) — **F-AMBIG**                                                   |
| Prime Number Oscillator    | K3              | distance to nearest prime                                                       |
| QStick                     | K3 + K2         | MA of (C−O); MA-type                                                            |
| Relative Vigor Index       | K3 + K1         | SWMA-weighted (C−O)/(H−L) sums + signal                                         |
| Center of Gravity          | K1(custom)/K7   | position-weighted rolling sum — weighted-moment kernel                          |
| Chande Forecast Oscillator | K7 + K3         | 100·(C−TSF)/C                                                                   |

### 6.4 Trend / directional (K2/K4/K6)

| Study                      | Kernels                   | Notes                                                                                             |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------- |
| ADX/DMS                    | K4 + K2(wilder)           | +DM/−DM, TR, three Wilder smooths, DX→ADX                                                         |
| Aroon / Aroon Oscillator   | K1(argmax)                | bars-since-HH/LL → **G3**                                                                         |
| Vortex Indicator           | K4 + K1                   | Σ abs(H−L₁), Σ abs(L−H₁), each / ΣTR                                                              |
| Vertical Horizontal Filter | K1 + K4                   | (HH−LL) / Σ abs(ΔC)                                                                               |
| Random Walk Index          | K1(multi-col custom) + K4 | max over horizons of range/(ATR·√i) — awkward multi-column window, see **G2** note                |
| Supertrend                 | K2(wilder TR) + K6        | band + flip state machine → **G2**                                                                |
| Parabolic SAR              | K6                        | the canonical multi-column state machine → **G2**                                                 |
| ATR Trailing Stop          | K2 + K6                   | long/short flip → **G2**                                                                          |
| ZigZag                     | K6                        | reversal-threshold pivots → **G6** repaint; rendering chart-side                                  |
| Darvas Box                 | K6                        | ATH lookback + box construction → **G6**; ghost boxes chart-side                                  |
| Ichimoku Cloud             | K1 + K3 + `shift`         | Tenkan/Kijun/Spans; ±26-bar displacement → **G5**                                                 |
| Elder Impulse System       | K2 + K4                   | EMA13 slope × MACD-hist slope → categorical color column (string col OK); bar coloring chart-side |
| Elder Ray Index            | K2 + K3                   | H−EMA13, L−EMA13                                                                                  |
| GoNoGo Trend               | —                         | **F-LEGAL: skip**                                                                                 |
| Trend Intensity Index      | K2 + K1                   | fraction of deviations above MA — **F-AMBIG**                                                     |
| RAVI                       | K2 + K3                   | 100·abs(SMA7−SMA65)/SMA65 — **F-AMBIG** (period variants)                                         |
| Swing Index                | K3 + K4                   | Wilder per-bar SI formula (limit-move param)                                                      |
| Accumulative Swing Index   | (SI) + K5                 | cumulative SI                                                                                     |
| Fractal Chaos Oscillator   | K6                        | ±1 from fractal state → **G6**                                                                    |

### 6.5 Volatility (K1/K2)

| Study                           | Kernels                 | Notes                                                                                                                                                                                                        |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| True Range                      | K4 + K3                 | max(H,C₁) − min(L,C₁)                                                                                                                                                                                        |
| Average True Range              | K4 + K2(wilder)         |                                                                                                                                                                                                              |
| Historical Volatility           | K4(log ret) + K1(stdev) | ×√(daysPerYear); Tidal-relevant (realized vol)                                                                                                                                                               |
| Chaikin Volatility              | K3 + K2 + `shift`       | ROC of EMA(H−L)                                                                                                                                                                                              |
| Mass Index                      | K2 + K3 + K1            | Σ EMA9(H−L)/EMA9(EMA9(H−L)) over 25                                                                                                                                                                          |
| Choppiness Index                | K1 + K4                 | 100·log₁₀(ΣTR/(HH−LL))/log₁₀(n)                                                                                                                                                                              |
| Gopalakrishnan Range Index      | K1                      | log(HH−LL)/log(n)                                                                                                                                                                                            |
| Ulcer Index                     | K1 + K3                 | √mean(squared %drawdown from rolling max) — **F-AMBIG** smoothing variants                                                                                                                                   |
| Relative Volatility             | K1(stdev) + K2(wilder)  | RSI form on stdev direction — **F-AMBIG**                                                                                                                                                                    |
| Standard Deviation              | K1                      | MA-type on the mean                                                                                                                                                                                          |
| Volatility Cone                 | K1 + `p<Q>` reduce      | realized-vol percentiles per horizon; **output is a term structure (x = horizon), not a TimeSeries** — records/ValueSeries output shape; overlay rendering charts-side. Tidal-relevant (IV vs realized cone) |
| High Minus Low                  | K3                      |                                                                                                                                                                                                              |
| Highest High / Lowest Low Value | K1                      | rolling max/min of any Field                                                                                                                                                                                 |

### 6.6 Volume & money flow (K1/K3/K5)

| Study                            | Kernels      | Data | Notes                                                                                                                                                          |
| -------------------------------- | ------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On Balance Volume                | K4 + K5      | V    | sign(ΔC)·vol cumulative                                                                                                                                        |
| Accumulation/Distribution        | K3 + K5      | V    | CLV·vol cumulative                                                                                                                                             |
| Price Volume Trend               | K4 + K5      | V    | pctChange·vol cumulative                                                                                                                                       |
| Chaikin Money Flow               | K3 + K1      | V    | Σ(CLV·vol)/Σvol over n                                                                                                                                         |
| Money Flow Index                 | K3 + K4 + K1 | V    | TP·vol up/down ratio                                                                                                                                           |
| Twiggs Money Flow                | K3 + K2      | V    | Twiggs TR variant + Wilder-style smoothing — **F-AMBIG**                                                                                                       |
| Elder Force Index                | K4 + K2      | V    | EMA of ΔC·vol                                                                                                                                                  |
| Ease of Movement                 | K3 + K4 + K2 | V    | midpoint move / box ratio, MA-type                                                                                                                             |
| Klinger Volume Oscillator        | K4 + K6 + K2 | V    | trend-state volume force + EMA pair + signal → **G2**; **F-AMBIG**                                                                                             |
| Volume Oscillator                | K2           | V    | fast−slow MA of volume                                                                                                                                         |
| Volume Rate of Change            | `shift` + K3 | V    |                                                                                                                                                                |
| Trade Volume Index               | K4 + K6 + K5 | V    | tick-direction accumulation (min-tick param; direction persists on unchanged)                                                                                  |
| Negative / Positive Volume Index | K4 + K6 + K2 | V    | conditional cumulative (vol vs prev vol) → **G2**; + MA overlay                                                                                                |
| Market Facilitation Index (BW)   | K3           | V    | (H−L)/vol × scale                                                                                                                                              |
| Shinohara Intensity Ratio        | K3 + K4 + K1 | V    | strong/weak ratios — **F-AMBIG** (A/B conventions)                                                                                                             |
| VWAP                             | K5           | V    | continuous form fine; **session-reset form → G4**                                                                                                              |
| Anchored VWAP                    | K5           | V    | slice(anchor) + cumulative — anchor is a user param, no calendar needed                                                                                        |
| Volume Profile                   | K9           | V    | `byColumn` histogram works today; true intra-bar price distribution needs finer data (**data-granularity note**); horizontal-histogram rendering → **F-CHART** |
| Projected Aggregate Volume       | K11          | V    | time-of-day cumulative profile over last M days → **G4**; **F-AMBIG** (ChartIQ-specific)                                                                       |
| Projected Volume at Time         | K11          | V    | same family → **G4**; **F-AMBIG**                                                                                                                              |
| Volume Chart / Volume Underlay   | —            | V    | **F-CHART** render modes, not analytics                                                                                                                        |

### 6.7 Regression & statistical (K7/K8)

| Study                                               | Kernels | Data              | Notes                                                |
| --------------------------------------------------- | ------- | ----------------- | ---------------------------------------------------- |
| Linear Regression Slope / Intercept / R² / Forecast | K7      |                   | one rolling-regression kernel, four projections      |
| Time Series Forecast                                | K7      |                   | endpoint of rolling regression                       |
| Beta                                                | K8      | comparison series | rolling cov(ret, retᵦ)/var(retᵦ)                     |
| Correlation Coefficient                             | K8      | comparison series | compensated moments (G7 note)                        |
| Price Relative / Relative Strength                  | K8      | comparison series | ratio; ChartIQ lists both names — one implementation |
| Performance Index                                   | K8      | comparison series | normalized relative performance                      |

### 6.8 Price transforms (K3)

| Study                                                                      | Kernels |
| -------------------------------------------------------------------------- | ------- |
| Typical Price (HLC/3), Median Price ((H+L)/2), Weighted Close ((H+L+2C)/4) | K3      |
| Balance of Power ((C−O)/(H−L), MA-type smooth)                             | K3 + K2 |

### 6.9 Session/calendar-dependent (K11 — gated on G4)

| Study                                                 | Notes                                                                                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pivot Points (Standard/Fibonacci)                     | prior-period H/L/C via `aggregate` + hold-broadcast is easy; the **anchor rules** (periodicity→pivot frame; session starts midnight ET / 5pm forex / 6pm metals) are the G4 gap |
| Projected Aggregate Volume / Projected Volume at Time | §6.6 — G4                                                                                                                                                                       |
| VWAP (session-reset)                                  | §6.6 — G4                                                                                                                                                                       |

### 6.10 Non-OHLCV data / display-only / skip

| Study                          | Disposition                                                                 |
| ------------------------------ | --------------------------------------------------------------------------- |
| Depth of Market                | **F-DATA** — L2 order book; chart type + feed, defer                        |
| Option Sentiment by Strike     | **F-DATA** — options chain per-strike vol/OI; defer until Tidal feed exists |
| Valuation Lines                | **F-CHART** — viewport avg ± σ lines; trivial compute, chart feature        |
| Volume Chart / Volume Underlay | **F-CHART**                                                                 |
| GoNoGo Trend                   | **F-LEGAL — skip**                                                          |

---

## 7. What `@pond-ts/financial` looks like

### 7.1 Package shape and column contract

- Depends **only on `pond-ts` core** (browser+Node invariant holds — pure
  computation, no data fetching, no rendering). Charts consume its output
  columns; it never imports charts.
- **Bar contract:** a plain interface, not a type —
  `{ open, high, low, close, volume }` default column names, every function
  accepting a `columns?: Partial<OhlcvColumns>` remap. Core stays
  OHLC-ignorant (correct per the layering); the contract lives here.
- Batch first (`TimeSeries → TimeSeries`); live later on the
  add/remove/snapshot + scan-closure machinery (each kernel here has a
  known O(1)-per-bar incremental form — G6 repainters excepted).

### 7.2 API style

Pure named functions appending columns — the "toolkit of analytics
operators" shape PLAN already assigns this package (deliberately not
`@pond-ts/fit`'s façade):

```ts
import { rsi, macd, bollinger, atr, vwap } from '@pond-ts/financial';

let s = fromOhlcvBars(bars); // or any TimeSeries with the columns
s = rsi(s, { period: 14 }); // + rsi
s = macd(s, { fast: 12, slow: 26, signal: 9 }); // + macd, macdSignal, macdHist
s = bollinger(s, { period: 20, stdDev: 2, maType: 'sma' }); // + bbMiddle/Upper/Lower
s = rsi(s, { period: 14, column: 'macdHist', output: 'rsiOfMacd' }); // composition
```

Design rules, distilled from the corpus:

1. **Every function takes `column` (source) and `output` (name/prefix)** —
   ChartIQ's "Field" compositionality. No hardcoded `'close'` anywhere.
2. **`maType` is a shared first-class vocabulary** (K2). ~25 studies expose
   it; one engine, one union type, one test matrix.
3. **Multi-output studies append a documented column family** with a
   configurable prefix (`macd`/`macdSignal`/`macdHist`;
   `aroonUp`/`aroonDown`; `bbUpper`/…).
4. **Warmup policy = pond missing-value policy**: first `period−1` bars emit
   `undefined` (align with `minSamples` + the reducer non-finite policy;
   no zero-backfilling — charts already skip missing).
5. **Periods are bar counts** in the public API from day one, even while
   G1 forces the internal duration translation (`period × barSize` +
   `minSamples: period`) on regular grids — so the API doesn't break when
   count windows land. Document the gapped-grid caveat until then.
6. Non-TimeSeries outputs (Volume Profile bins, Volatility Cone term
   structure) return the `byColumn`-style records / `ValueSeries`, not a
   fake time axis.

### 7.3 Internal layering

```
kernels/   maEngine (K2), rollingRegression (K7), bivariateMoments (K8),
           trueRange, foldBars (K6 shim over map-closure until core G2),
           rollingExtreme+argmax (K3-deque), bandCombinator (K10)
studies/   one small file per named study, assembled from kernels,
           literature citation + formula in the doc comment
contract/  OhlcvColumns, MaType, common option types
```

Perf discipline per CLAUDE.md applies to the **kernels**, not each study:
`scripts/perf-<kernel>.mjs` with the standard scenarios (100k bars typical;
the deque extremes and fold kernels are the ones worth watching). Studies
are thin assemblies and inherit kernel numbers.

### 7.4 Phasing (proposal)

- **Phase 1 — kernels + the top-20 studies** Tidal actually renders first:
  MA engine, RSI, MACD, Bollinger, ATR (+bands), stochastics, %R, Donchian,
  OBV, VWAP/Anchored VWAP, Historical Volatility, momentum/ROC. (Tidal's
  vol focus — ATM IV vs realized — makes HV and the Volatility Cone
  unusually high-value for a v1.)
- **Phase 2 — breadth**: the K1/K2/K3/K4 long tail (§6.3–6.6, ~60 studies,
  mechanical once kernels exist).
- **Phase 3 — state machines** (PSAR, SuperTrend, ZigZag, Darvas, Klinger,
  NVI/PVI) — after the G2 fold shape is settled.
- **Phase 4 — calendar-gated** (§6.9) — after core trading-calendar work.
- **Phase 5 — live** — incremental forms; resolve G6 repaint semantics.
- **Deferred indefinitely**: F-DATA pair; F-LEGAL skip is permanent.

### 7.5 Core asks to carry upstream (summary)

| Ask                              | Priority                   | Blocks                                       |
| -------------------------------- | -------------------------- | -------------------------------------------- |
| G1 count-based `rolling` windows | **high**                   | correctness of all K1 studies on gapped data |
| G2 multi-column `scan`/fold      | medium (lib shim exists)   | ergonomics/perf of K6                        |
| G3 argmax reducer                | low (lib-side fine)        | Aroon                                        |
| G4 trading calendar/sessions     | already parked in PLAN/RFC | §6.9 only                                    |
| G5 forward displacement          | chart-side lever preferred | Ichimoku/Alligator plots                     |

---

## 8. Open questions (for the eventual RFC red-team)

1. Should G1 land in core **before** Phase 1, or does Phase 1 ship on the
   duration-translation workaround (regular grids only) to get Tidal
   feedback sooner? (Recommend: workaround first, G1 in the same wave.)
2. `foldBars` (G2): private kernel forever, or core `scanRows` once proven?
   The purity/columnar cost of the map-closure shim is real but unmeasured
   — perf script before deciding.
3. Multi-output naming: flat prefixed columns (above) vs. a naming helper?
   Flat matches charts' column-per-series model; revisit only if consumers
   drown in columns.
4. Does the Volatility Cone / Volume Profile records-output shape want the
   `ValueSeries` treatment (value-axis RFC) for chart interop, or are plain
   records enough for Tidal's overlay?
5. Indicator metadata (display name, panel-vs-overlay, default style hints)
   — in this package, in charts, or in a Tidal-side registry? (Lean: a
   minimal `meta` export here, styling stays consumer-side per the
   no-consumer-themes rule.)

---

## 9. Charts-side capabilities the corpus demands (follow-up, 2026-07-07)

Same corpus, opposite lens: what does _rendering_ these studies require of
`@pond-ts/charts`? Verified against charts `main` (v0.41.0 source, not
memory): `step` curve ✓, gap modes incl. `none`(bridge)/`dashed`/`step` ✓,
zero-baseline signed bars ✓, named multi-axes (`<YAxis id side>` +
`axis="id"`) ✓, `MultiPanelLayout` with synced x ✓, annotation primitives
(`Baseline`/`Region`/`Marker`, programmatically drivable) ✓, `ScatterChart`
(PSAR dots) ✓, value-axis x (Volatility Cone term structure) ✓,
`Candlestick` with a `'direction'` color mode ✓.

### Already covered — needs recipes, not code

- **Oscillator panel furniture** — RSI 30/70 thresholds, overbought/oversold
  shading, zero lines: `Baseline` + `Region` do this today. Ship as
  documented recipes / stories per the feature-axis story discipline.
- **ZigZag polyline** — sparse pivots + `gapMode: 'none'` bridge. Covered.
- **Stepwise levels** (Donchian, ATR trailing stop, Fractal bands, pivot
  levels) — `curve: 'step'`. Covered.
- **Darvas boxes / data-driven rectangles** — programmatic `Region`
  annotations. Covered (verify annotation volume scales to hundreds).

### C1 — column-driven color channel (`colorBy`) — _the_ gap, highest value

`bars.ts` draws **one flat fill per series**; only `Candlestick` has a
data-driven color mode (`'direction'`). But the corpus's canonical
renderings are full of per-mark color driven by a _data_ column:

- MACD / Volume Oscillator / Gator histograms — sign (± around zero);
- Awesome Oscillator — rising/falling vs previous bar;
- volume bars — up/down day;
- Elder Impulse — categorical 3-color bar coding (a string column);
- SuperTrend / ATR trailing stop / PSAR — direction-colored segments/dots.

Ask: generalize the candle `'direction'` idea into an encoding channel —
`colorBy: column` (categorical string column or sign of a numeric column)
on `BarChart`, `LineChart` (per-segment), `ScatterChart`. Two-value +
categorical cases only; no continuous ramps needed by the corpus. This
unblocks the standard look of ~15–20 studies including two Phase-1 ones
(MACD, volume). Theme note: reuse the shipped `candle` up/down slot
vocabulary rather than inventing a second up/down pair.

### C2 — forward projection space + per-layer bar offset (G5 partner)

Ichimoku plots two spans 26 bars past the last close; Alligator/Gator are
forward-offset. Needs (a) x-domain padding measured in **bars** beyond the
last datum, and (b) per-layer `xOffsetBars`. Trivial for daily bars;
intraday-correct offsets are calendar arithmetic → lands with C6. The
assessment (§5 G5) already recommends this chart-side lever over faking
future-keyed data.

### C3 — crossing-band fill

`BandChart` fills a lo≤hi envelope. The Ichimoku cloud is a band between
two _crossing_ series whose fill color flips by which is on top. Ask: band
between two arbitrary columns with a two-color `fillBy: 'order'` mode.
Generally useful beyond Ichimoku (price-vs-MA shading, spread charts).

### C4 — underlay preset (volume under price)

Named dual axes exist; a volume underlay is just a second axis whose domain
is inflated so bars occupy the bottom ~20–25% of the panel. `<YAxis>`
`headroom` reads as symmetric ("each side") — an asymmetric headroom (or an
`underlay` preset encapsulating it) is the small missing piece. Replaces
ChartIQ's Volume Underlay study (§6.10 F-CHART) and is table-stakes for
every candlestick chart.

### C5 — y-binned horizontal histogram (Volume Profile mark)

A genuinely new mark: horizontal bars keyed to **y-value bins** (the
`byColumn` records of §6.6), overlaid on the price panel with a hidden
length scale. Nothing in the current mark set approximates it. Medium
cost; gate on Tidal actually asking (profile studies are common in order-
flow workflows, less so in vol analytics).

### C6 — trading-calendar x-axis (reaffirm, already parked)

Already parked in `docs/rfcs/financial-charts.md` §7 / PLAN. The corpus
adds weight from a second direction: G4 blocks four _studies_, and C2's
intraday correctness needs the same bar-time arithmetic. When it's picked
up, it serves both the axis and the indicator library.

### Deliberately not asked for

- **Multi-line families** (GMMA's 12 lines, Rainbow's 10) — N `<LineChart>`
  children work today; verbosity is consumer-side sugar, not a primitive.
- **Continuous color ramps, heatmap marks** — nothing in the corpus needs
  them.
- **Navigator/brush, log y-scale** — real financial-charts asks (ChartTool
  prior art) but _not_ driven by this corpus; keep on the Tidal friction
  track, don't smuggle in here.

### Suggested order

C1 (blocks Phase-1 studies' canonical look) → C4 (cheap, ubiquitous) →
C2 (Ichimoku family) → C3 (Ichimoku cloud completes) → C5 (on demand) →
C6 (its own planned track).
