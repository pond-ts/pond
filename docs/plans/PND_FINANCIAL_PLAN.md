# PND_FINANCIAL_PLAN — `@pond-ts/financial` studies + trading time

> Breakout plan for the **Financial** roadmap section in
> [PLAN.md](../../PLAN.md). Corpus analysis:
> [docs/notes/financial-indicators-assessment-2026-07.md](../notes/financial-indicators-assessment-2026-07.md)
> (124 ChartIQ studies → ~11 kernels, ~80% expressible on core primitives).
> RFCs: [trading-calendar.md](../rfcs/trading-calendar.md),
> [financial-charts.md](../rfcs/financial-charts.md). Study-authoring
> checklist: `packages/financial/src/studies/README.md`; oracle conventions:
> `packages/financial/scripts/oracle/README.md`. Shipped history (calendar
> engine, `scaleTradingTime`, tick ladder, first studies batch): the Tidal
> section of
> [docs/archive/experiments-2026.md](../archive/experiments-2026.md).

Shipped substrate: the trading calendar (Phases 1+2, released v0.42.0), core
G1 count-based `rolling({ count })`, `smooth('ema', { span, minSamples })`,
and the #449 first studies batch — sma, ema, bollinger, envelope,
rollingStdev/Min/Max/Percentile, zScore, percentChange — all fluent and
pandas-oracle-verified.

**Shipped 2026-07-23 — market-scale studies perf** (report: hand-rolled
Float64Array SMA/EMA at 1M bars was single-digit ms; the studies were
hundreds). Three behaviour-preserving cuts along one path: a
`smooth('ema')` columnar fast path (typed-buffer recurrence + trusted
construction, 530 → 4.4 ms at 1M), a `rolling({ count })` numeric fast
path (shared incremental reducer states fed straight off packed buffers
into typed result columns, 135 → 32 ms), and the financial kernel reading
study columns off the column API instead of materializing `series.events`
(~400 ms/1M of pure Event-allocation overhead). End-to-end at 1M bars:
`ema()` 603 → 2.5 ms, `sma()` 569 → 56 ms, `bollinger()` 748 → 162 ms.
Durable benches: `packages/core/scripts/perf-smooth-ema.mjs`,
`packages/financial/scripts/perf-studies.mjs`. **Considered and deferred:**
per-reducer fused kernels (running-sum SMA etc.) would close the remaining
~20× gap to the bespoke floor but duplicate reducer arithmetic outside the
shared states — take it up only if a consumer needs single-digit ms at 1M;
the boxed `(number | undefined)[]` hop between kernel and `withColumn`
(~12 ms/1M) is [PND-WCNAN]'s NaN-canonical typed intake, tracked in the
columnar plan.

## Tasks

### [PND-STUDY] — Studies Phase-1 breadth

Assessment §7.4: RSI, MACD, ATR (+bands), stochastics, %R, Donchian, OBV,
VWAP, Historical Volatility, momentum/ROC. These add **TA-Lib** alongside
pandas in the oracle harness (named-indicator convention deltas documented;
bar-for-bar vendor parity is a non-goal). The core substrate is complete —
each study is a vocabulary wrapper following the studies README checklist
(uniform `column`/`output` shape, bar-count periods, length-preserving
warm-up, fluent method, oracle case).

**Status (2026-09-06): Phase-1 breadth landed** — every named study above
except **ATR bands** (open: Keltner-style `close ± k·ATR` on
`trueRangeValues`) and the **anchored / session VWAP** (deferred to the
session-anchored phase; needs a reset). The per-batch write-ups below are
the decision record. Package-wide questions the wave surfaced, none
blocking: `ema()`'s first-sample seed vs TA-Lib's SMA seed (MACD chose
internal consistency); the Wilder-vs-`ema` interior-gap asymmetry (**decided by Peter with the
directional group below — kept**, reasoning recorded); `percentChange.periods` vs `period` naming; the website study
table has no rows for any of the new studies; a monotonic-deque fast path
for core's rolling min/max would lift stochastics/%R/Donchian ~2×.

#### Landed so far: RSI, MACD, ATR (2026-09-01)

Three of the ten, plus a property-test net. The decisions worth keeping,
because none of them are recoverable from the code alone:

**The seed question, answered both ways.** Wilder's recursion _is_ an EMA with
`α = 1/n`, so both RSI and MACD faced the same fork: match TA-Lib's seeding or
use pond's own. They landed on opposite sides, for measured reasons.

|                              | RSI                                      | MACD                    |
| ---------------------------- | ---------------------------------------- | ----------------------- |
| error on the non-TA-Lib seed | **7.03 points** on a bounded 0–100 scale | 3.80% of line magnitude |
| by bar 79                    | 0.15                                     | **0.089%**              |
| crosses a decision threshold | yes (70/30)                              | no                      |
| verdict                      | **dedicated `wilderValues` kernel**      | **pond's own EMA**      |

MACD's error largely cancels (it is a _difference_ of two EMAs) and decays far
faster, so the deciding argument there was **internal consistency**: seeding
TA-Lib's way would make `macd()` disagree with `ema(fast) − ema(slow)` inside
our own package. That property is pinned by a test — if the two drift, the
justification is gone.

**Left open, deliberately: `ema()`'s seed convention.** Making pond's MACD
TA-Lib-identical means changing it everywhere — breaking, oracle-pinned, and
inherited by every EMA-derived indicator after MACD. It is a package-wide
decision, not a per-study one, and was not taken here.

**Kernels added.** `wilderValues` (the seeded recursion; RSI and ATR) and
`trueRangeValues` (ATR, and ADX/NATR/Keltner/SuperTrend when they land).

**Recursive smoothers differ from `ema()` on interior gaps** — `ema()` skips
and recovers, Wilder propagates to the end. Both are defensible; Wilder's is
the conservative answer, since a bar with no close leaves the next bar's true
range unknown too. Documented on both studies; **not** reconciled. Worth a
deliberate decision before ADX adds a third consumer.

**Deliberate deltas from TA-Lib**, each documented on its study: RSI reports
`undefined` on a flat window where TA-Lib reports `0` (which is also its
answer for "every bar fell", so it cannot distinguish the two); MACD warms
each column up when it can, where TA-Lib masks all three back to the slowest.

**The oracle gained TA-Lib** alongside pandas, and the generator now _asserts_
agreement rather than merely computing alongside — including the null **mask**,
not just the values. Two assert-shape mistakes are recorded in the PR trail
and worth not repeating: `nanmax(|a−b|)` is blind to indices where only one
side is NaN (so it could not catch the warm-up off-by-one it existed for), and
"the delta must decay" is vacuous for a seed difference (it holds for every
wrong `α` too — only a tail bound discriminates).

**Property tests, converted from TA-Lib's own suite** (`talib-properties.test.ts`,
BSD 2-Clause). The oracle checks values on a clean, never-flat, gap-free input;
these cover what that input avoids — scale behaviour, composition over another
study's output, all-missing input. The composition one is not hypothetical:
`rsi(sma(...))` returned an entirely empty column in review. Studies README
step 5b makes it part of the checklist.

**Recurring failure mode, mine.** Every Layer-2 review of this wave found an
assertion that read as coverage and tested nothing: a monotonic fixture sending
every RSI value through one branch, a constant-range fixture passing under every
true-range mutation, unfireable `!isNaN` checks (`withColumn` maps NaN to
missing, so they can never fire). Mutation-test a new test before trusting it.

**Landed (returns fan-out): `momentum`, `historicalVolatility`; ROC resolved
as already shipped.** ROC was checked before being built: TA-Lib `ROC` and
`percentChange` agree exactly (`0.0`, identical masks) on the fixture, so the
deliverable was a TA-Lib cross-check in the generator plus doc notes, not a
duplicate study. Momentum matches TA-Lib `MOM` exactly. HV has no TA-Lib
reference, so its four conventions were decided and pinned in the pandas
oracle: population σ (package convention), log returns, `√annualize` with
`252` as an option not a constant, decimal output. Two shapes worth carrying
forward: (1) a study built on **differences** whose σ goes through the
rolling kernel must call `rollingMeanSdInto` on the returns array directly —
a scratch column through `rollingValues` counts _rows_, so the leading
missing return makes it emit one bar early over one return too few; (2) HV
steps over a leading run of missing returns (Wilder-kernel convention) so
the first window covers `period` real returns, matching pandas
`min_periods`, rather than the rolling family's "rows, not contributors"
contract that `sma∘sma` pins. Interior gaps still follow the rolling
contract (σ over the finite returns in the window).

**Landed — stochastics / Williams %R / Donchian (one kernel).** All three
read the trailing highest-high / lowest-low, so they share
`kernels/highest-lowest.ts` (`highestLowestValues`: both extremes in ONE
`rolling` scan; `percentOfRangeValues`: `100·(c−LL)/(HH−LL)`, which _is_ fast
`%K`, with `%R = %K − 100`). Decisions, each measured against TA-Lib in the
oracle: (1) **one `stochastic` with `slowing`**, not `stochastic` +
`stochasticFast` — `slowing: 1` is `STOCHF` and is asserted as such. (2) **`%K`
emits from its own first valid bar** (15 at 14/3/3) where TA-Lib masks it to
`%D`'s (17) — the `macd` per-column precedent; values agree to `5.7e-14` on
every bar TA-Lib emits. (3) **Flat window → `undefined`** where TA-Lib
gives `0` — `0` is also "close at the bottom of a real range" for `%K` and
"at the top" for `%R`, so TA-Lib's convention contradicts itself across the
two studies on the same bar; the `rsi` precedent. (4) **The slow-K smoothing
is a raw-array kernel (`rollingMeanValues`) that waits for `slowing`
_values_**, not a scratch-column `sma`: core's count-window `avg` counts rows
and would have put "3-bar" `%K` on bar 13 with one value in it (TA-Lib and
pandas: bar 15). It reuses `rollingMeanSdInto` plus a NaN mask, so it is the
same SMA `sma()` gives (pinned bit-for-bit). (5) A **misnamed `high`/`low`
reads all-missing** in the kernel rather than throwing from core's `rolling`,
so a multi-input study has one rule for all its inputs (the `atr` precedent;
single-column `rollingMax` still throws — left alone). Considered and
rejected: clamping `%K`/`%R` to their bounds (a redirected `close` outside
its range should read outside, honestly); a Donchian `close`-based breakout
column (a rule, not a study).

**Landed — OBV / VWAP (volume fan-out).** The oracle fixture gains a
`volume` column (spikes of 5–9×, so a dropped weighting sits > 1.2 price
units from the plain mean — asserted). Decisions: (1) **`obv` is TA-Lib's
exactly** (seed `OBV[0] = volume[0]`, flat close adds nothing; mask then
values, delta 0) and is the first study with no `period` — it is read for
its shape, not its level. (2) **A missing cell in a running sum propagates
to the end**, the Wilder asymmetry for the same reason: a window recovers
once a gap leaves it, a cumulative quantity cannot. A leading gap in either
input shifts the seed to the first bar where both are present (what TA-Lib's
wrapper does by stripping leading NaNs). Deliberate delta from TA-Lib, whose
NaN close makes both comparisons false and silently carries on at a level
that is wrong forever (measured on seven bars: 400 out at the gap bar, 100
out thereafter). (3)
**`vwap` is ROLLING** — `Σ tp·v / Σ v` over `period` bars, `tp = (h+l+c)/3`,
`period` required (no conventional length). Anchored / session VWAP is NOT a
special case of it (a count window emits once it spans `period` rows) and
only makes sense with a reset, so it is deferred to the session phase; the
`cumulativeValues` kernel it needs already exists. No `price` option — a
knob with one conventional value; redirect `high`/`low` at `close` for a
close-weighted VWAP. A bar missing ANY input leaves BOTH sums, so the ratio
is never biased by a volume whose price went missing. (4) Four one-loop
kernels — `cumulativeValues` (A/D, PVT next), `signedVolumeValues`,
`typicalPriceValues` (CCI, MFI, Keltner next), `rollingWeightedMeanValues`
(VWMA next; two range-exact mean passes whose divisor cancels — a fused
single pass would be ~10× cheaper at the cost of range exactness, the same
trade already deferred for the fused SMA). Lesson from the mutation matrix:
the `Σw === 0 ? NaN` guard was dead code (non-negative weights make 0/0 NaN
already) and was removed rather than kept with a false "load-bearing" claim.

**Landed — the K2 moving-average engine.** `kernels/moving-average.ts` names
the MA-type menu once — `MaType` = `sma | ema | wma | smma | dema | tema |
trima | hull | kama | zlema` — with `movingAverageValues(values, period,
type)` over a **raw array** (so the derived-input callers can use it: Keltner
on typical price, Coppock's WMA of two ROCs, Disparity, the Price Oscillator)
and `movingAverageColumn` as the series-level door. Surfaced as the
`movingAverage({ period, type, column, output = 'ma' })` study plus fluent;
`envelope.maType` widened from `'sma' | 'ema'` to the whole menu. Decisions:
(1) **`sma` and `ema` are routed back to `rollingValues` / `emaValues`, not
reimplemented** — one definition rather than two that agree "to rounding", and
they keep the parallel accelerator and core's columnar EMA fast path; pinned
bit-for-bit, which is also what makes the envelope widening provably a no-op
on the two types it already had. (2) **The EMA seed question was not
reopened**: `ema`/`dema`/`tema` use pond's first-sample seed, so the engine
cannot disagree with `ema()` inside the package (the MACD precedent). Masks
are identical to TA-Lib's regardless — the seed does not move the lookback —
so the generator asserts the null mask exactly and bounds the values at the
tail; measured at period 21 the transient is 0.210% / 0.529% / 0.059% of scale
at the first shared bar and 0.0008% / 0.0155% / 0.0144% by bar 79. `sma`,
`wma`, `trima` and `kama` match TA-Lib `MA(matype=…)` outright (`kama` to
`0`). (3) **Interior gaps are stated per type rather than reconciled** — the
Wilder asymmetry the plan flagged before ADX, now written down: window types
recover, the `ema` family skips the gap bar and carries on, `smma` and `kama`
propagate to the end. On the **array door** every type, `sma` included,
steps over a leading gap (waits for `period` finite values — the studies
README's rule for derived inputs; the builder had kept `sma()`'s
rows-not-contributors window there and the Layer-2 review held the engine
to the rule). The **column door** routes `'sma'` to `rollingValues`, so
`movingAverage({ type: 'sma' })` over a column and `sma()` stay one SMA; the
doors differ only on a column with missing cells, pinned both ways. (4) **WMA got the O(N) running weighted sum**
(`W(i) = W(i−1) − S(i−1) + period·x(i)`, rebuilt on `i % period === 0` like
`ranged.ts` so the cancellation cannot accumulate): 57.0 → 30.7 ms at period
20 over 1M bars, 262.1 → 29.4 ms at period 100 — the point being that the
shipped form is flat in `period` where the definition's dot product is
linear in it. (5) **Deferred and named**: MAMA/FAMA, T3, VIDYA (wants the
K6 recursion, [PND-SFOLD]) and the time-series/regression forecast MA (that
is kernel **K7**, not a smoothing rate). Two mutation-matrix findings worth
keeping: TRIMA's two SMA lengths **commute**, so swapping them changes no
number (only dropping the even branch's `+ 1` does); and KAMA's `sum === 0 ?
1` flat-window guard is load-bearing for a reason the first comment got wrong
— it is not what propagates a gap (the recursion's own `NaN` does that), it is
what stops an unguarded `0/0` emptying the column when a series flattens while
KAMA is still far below it. Unblocks the §6.1 K2 family (Price Oscillator,
Disparity, DPO, MA Cross/Deviation, GMMA, Rainbow, Alligator/Gator, TRIX,
Coppock, KST) and the §6.2 MA-centred bands (Keltner, STARC, High-Low Bands).

**Landed — the K2 consumers (channels and smoothed rates).** The first five
studies built _on_ the moving-average engine rather than beside it:
`keltner`, `atrBands` (§6.2) and `qstick`, `trix`, `coppock` (§6.1/§6.3).
Nothing here added a smoother — every "MA type" option is `MaType` and every
average is a `movingAverageValues` call on a **derived array**, which is the
door the engine was built for (typical price, the candle body, a sum of two
ROCs). Decisions:

(1) **Two new kernel assemblies, both named to stop a definition forking.**
`atrValues(high, low, close, period)` (`kernels/true-range.ts`) is the
true-range-then-Wilder pair `atr` was doing inline; `atr`, `keltner` and
`atrBands` now all call it, which is what makes "`atrbUpper` is
`close + multiplier × atr()`" **bit-for-bit** rather than a coincidence two
tests keep true (pinned as an exact `toBe` against the shipped `atr` study —
the generator can only get to 7.1e-15 because `(c + w) − c` is not `w` in
IEEE754, so the exact form of the claim lives on the TypeScript side).
`percentChangeValues(values, periods)` (`kernels/rate-of-change.ts`, K4) is
the percent rate of change **and its two edge rules** — no predecessor yet, a
zero base → `undefined`; `percentChange` was refactored onto it and `trix`
(1 bar) and `coppock` (two look-backs) share it, so the zero-base guard is
one rule in one place rather than three.

(2) **Keltner's variant is pinned, and the delta is a doc note not an
option.** The **modern** form ships — EMA(20) of typical price ± 2 × ATR(10),
Chester Keltner via Linda Raschke, and ChartIQ / StockCharts / TradingView's
default — because it is what a caller's chart draws. Keltner's own 1960 form
(SMA(10) of typical price ± 1 × the SMA of the **plain** high−low range) is
reachable except for the half-width: it is always **true** range here. A
`range | trueRange` knob was considered and rejected — plain range is a
quantity the package computes nowhere else, and the knob would have exactly
one useful value. Warm-up is **per column** (`macd`): centre at the MA's own
first bar, bands at `max(centre, ATR)`, so at `{ period: 5, atrPeriod: 14 }`
the centre keeps ten real bars a study masking to the slower input would
discard.

(3) **`atrBands` appends TWO columns.** No `atrbMiddle`: the middle is
`column`, already on the series, and a third column would be a copy of the
caller's own input to keep in step. That is the line between this and
`keltner`/`bollinger`, whose centres are _computed_. It also needed `column`
(what the bands are drawn around) to be **separate from** `close` (what the
ATR is measured from) — bands on an `sma` with volatility off the raw bars is
the usual reason to reach for it.

(4) **TRIX is not TEMA, and the oracle is what proves it.** TRIX wants the
EMA **chain** (`EMA³`); the K2 menu's `tema` is Mulloy's de-lagged
`3·EMA − 3·EMA² + EMA³` built from the same three stages. Reaching for `tema`
would compile, run, and be a different indicator, so `trix` composes three
`movingAverageValues(…, 'ema')` passes and a test pins the two apart. The
generator follows the EMA-family pattern from #695: the **formula** is
asserted bit-exact on **TA-Lib's own SMA seed** (2.2e-14, identical masks),
which is what catches a dropped stage, a `tema` substitution _or_ a
log-vs-percent rate of change; pond's first-sample seed is then bounded as a
transient. That bound is **2% of scale, not the MA family's 0.5%**, and the
looser number is measured rather than fitted: TRIX's scale is a percent rate
of change (0.45 at `period 15`) rather than a price, and only 37 bars are
shared, so the correct rate sits at 0.85% where `2/(n+2)` and `2/n` sit at
8.5% and 9.8% — 2% is ~2.4× clear below and ~4× under the nearest wrong one.
The line is named `trix`, not `trixLine`: the study _is_ the line, and the
signal keeps the family suffix.

(5) **Coppock's monthly convention is stated, not enforced.** The 14/11/10
defaults are Coppock's **months** on a monthly index chart; the study is
bar-count like every other one here, so on daily bars it is a defensible
short-horizon oscillator and not the indicator he defined — said on the
docstring because the defaults look innocuous on any chart. The weighted
average is part of the definition, so no `maType` knob (an EMA-smoothed
variant is a different curve, and a knob would let one name mean two lines).
`longPeriod` / `shortPeriod` are **symmetric** — the two ROCs are added — so
no ordering is enforced, unlike `macd`, which subtracts.

(6) **`open` joined the bar contract's used columns.** `qstick` is the first
study to read it (`DEFAULT_OHLCV` already named it), so the oracle fixture
gained an `opens` column: the **previous close, pulled just inside the bar's
own range** when it does not fit. It has to be pulled in because the
fixture's half-widths are deliberately narrower than its close-to-close moves
(the property that makes true range's gap terms win) — 47 of the 80 opens are
the previous close exactly and 33 are gap bars, with 30 negative bodies and
80 distinct ones, all asserted, so a dropped sign or a constant body cannot
pass.

**Mutation matrix** (26 mutations; failing tests of the five study files
each): 24 killed. The first run had **four** survivors and every one was a
**default value** — `atrBands` period, `qstick` period, `trix` signalPeriod
all changed no test at all; a defaults-equality block was added and they now
kill 1–2 each. The lesson is worth carrying: a study's defaults are part of
its published definition and nothing else in the shape tests them, because
every other test passes explicit options. The two remaining survivors are
**observationally equivalent**, not missing tests: `percentChangeValues`'
`i < periods` early return (an out-of-range typed-array read is `undefined`
and every arithmetic on it is already `NaN`, so removing the branch changes
no output — it stays as a **bounds** guard, so `values[i - periods]!` is not
a lie, and is documented as such rather than claimed load-bearing) and
`atrValues`' `start = 1`, which `atr` already documented as redundant since
`wilderValues` steps over a leading `NaN` anyway.

**Perf** (1M bars, medians, `scripts/perf-studies.mjs`): `keltner` 84 ms
(`maType: 'sma'` 96 ms), `atrBands` 66 ms, `qstick` 46 ms, `trix` 67 ms,
`coppock` 47 ms — against `bollinger` 128 ms and `stochastic` 368 ms on the
same run, so all five sit in the cheap half of the corpus. Every one is
options-validation plus kernel calls, so these are the kernels' numbers: no
new data loop was written, and nothing here rescans a window.

**Landed — the K2 consumers (price-vs-moving-average oscillators).**
`priceOscillator`, `disparityIndex`, `detrendedPriceOscillator`, `elderRay`
and `awesomeOscillator` — the first five studies built _on_ the K2 engine
rather than beside it; all four with an "MA type" in the corpus take `maType`
and call `movingAverageColumn`, so no sixth smoother exists. Decisions:

(1) **`priceOscillator`'s `mode` defaults to `'percent'`, and the default
matters.** TA-Lib ships the two forms as two functions (`APO` absolute, `PPO`
percent), so the name settles nothing. What settled it was step 0 of the
studies README: `priceOscillator({ mode: 'absolute', maType: 'ema',
fastPeriod: 12, slowPeriod: 26 })` **is `macd()`'s line bar-for-bar** — a
test pins that identity — so defaulting to absolute would have made the
headline call of a new study a rename of a shipped column. Percent is also
the scale-invariant, cross-instrument form. Rejected: a `percent: boolean`
(reads worse at the call site, doesn't extend), and two exported functions
`apo`/`ppo` (one study with one knob is the `stochastic({ slowing: 1 })`
precedent). (2) **The EMA seed was not reopened**, per `macd`: on `'ema'`
pond keeps its first-sample seed, so the generator proves the **formula** on
TA-Lib's own SMA seed (`2.8e-14`) and bounds the **seed transient**
separately — 6.61% of scale at the first shared bar, 0.41% worst over the
last 20, where a wrong rate is 5.09% (`2/(n+2)`), 5.99% (`2/n`) or 44.4%
(`1/n`). On a seedless type the parity is outright: `{sma, absolute}` matches
`APO(matype=0)` to `7.1e-14`, masks identical. The generator also rebuilds
`APO`/`PPO` from `talib.MA` first and confirms they _are_ the MA difference
(`8.9e-16`) before using them as a reference. (3) **DPO's alignment is a real
fork and is named.** We ship `price[i] − MA[i − shift]` (TradingView's
non-centered default); StockCharts' `price[i − shift] − MA[i]` is a
**different series**, not a re-plotting of ours, and the reason to reject it
is that a study here appends a column aligned to the source's time axis — a
value on bar `i` that describes a price `shift` bars earlier silently
misaligns with everything else on that row. `shift = ⌊period/2⌋ + 1` **floors**
on odd periods (the only rule that keeps the study a pure re-indexing of the
average; the same call `zlema`'s lag makes), so the warm-up is
`period − 1 + shift` and an odd `period` lands a bar before the even one above
it. (4) **`elderRay` and `awesomeOscillator` deliberately take no `maType`.**
Elder names the 13-bar EMA and Williams names the 5/34 SMA pair; an option
whose other nine settings nobody publishes is a speculative knob, and it would
let `awesomeOscillator` return something nobody calls an Awesome Oscillator.
(5) **The percent forms report `undefined`, not `Infinity`, on a zero
denominator** — reachable only on a column that can be zero or negative (a
return series, another oscillator), and a `±Infinity` in a chart's y-domain is
worse than a gap. Pinned both ways: the absolute form keeps emitting there.
(6) **One new kernel helper: `medianPriceValues(high, low)`**, added beside
`typicalPriceValues` rather than in a file of its own. The alternative was a
`(h + l) / 2` loop inside `awesomeOscillator`, which the "studies contain no
data loop" rule forbids; one consumer ships today and three more are named
(Alligator, Gator, High-Low Bands). Not a public export. Measured 7.6 ms at
1M bars against `typicalPriceValues`' 10.8 ms, and `awesomeOscillator`'s
77.8 ms is exactly its parts (7.6 + 36.9 + 33.4). Perf at 1M bars:
`priceOscillator` 61.0 ms, `elderRay` 55.3 ms, `disparityIndex` 55.3 ms,
`detrendedPriceOscillator` 47.5 ms — all in the two-engine-calls-plus-a-pass
band, none of them near the range studies' 240–310 ms. (7) **Considered and
not built**: "moving average deviation" (`price − MA`, the absolute sibling of
Disparity) — it is arithmetic anyone can write and the comparable form is the
one worth naming; and a `centered` flag on DPO, which would be a second series
behind a boolean rather than a knob on one.

**Landed — the volume & money-flow group (corpus §6.6).**
`accumulationDistribution`, `chaikinOscillator`, `priceVolumeTrend`,
`chaikinMoneyFlow`, `moneyFlowIndex`, `forceIndex`, `easeOfMovement` and
`volumeOscillator`, over **one** new kernel. Decisions:

(1) **The close location value is a kernel, and a flat bar's is exactly
`0`.** `clvValues` / `accumulationDistributionValues`
(`kernels/close-location.ts`) are shared by three studies, which is what
earned the file. `CLV` is the stochastic's "position in a range" at a different
arity — `clv = 2·%K/100 − 1` over the bar's own high and low — and the builder
first carried the stochastic's flat-window rule across (`high === low` →
missing, on the "no answer beats a conventional zero" precedent), documenting
it as a deliberate delta from TA-Lib's `AD`. The Layer-2 review of #699 argued
the algebra and won: on a flat bar the numerator `(c − l) − (h − c)` is
_forced_ to zero — the close is at the high and at the low — so `0` is the
ratio's value in the limit and the only contribution the bar can make, where a
stochastic's flat window has a numerator that is not forced to anything. So a
flat bar contributes `0`: A/D matches TA-Lib bar-for-bar with no delta (measured
on twelve bars with bar 3 flattened, both give `[0, 100, 100, 100, 100, 400, …,
1900]`), the Chaikin oscillator carries on through a halt, and CMF keeps the
bar's volume in its denominator as every conventional CMF does. Only a
_missing_ price is a gap. The lesson is recorded for the next flat-window
decision: ask whether the numerator is forced to zero before reaching for
`undefined`.

(2) **The Chaikin oscillator is the one EMA-family study with no seed delta —
measured, not assumed.** Every other EMA study here carries the `macd`
precedent (pond seeds on the first sample, TA-Lib on the SMA of the first `n`),
and the brief expected the same treatment. It does not apply: TA-Lib's own
`ADOSC` seeds **both** EMAs with the first A/D value, which is pond's
convention, so the oracle asserts **exact** equality (delta `0`, identical
masks) at `{3,10}` and `{4,12}` instead of bounding a transient. The generator
also rebuilds the SMA-seeded version and asserts it is _far_ from `ADOSC`
(423.0 and 350.4 on the fixture), so the case pins which seed ships rather than
being blind to the difference.

(3) **`priceVolumeTrend` composes on the ROC kernel and divides by 100**, and
its **bar 0 is `undefined`, not `0`**. The kernel returns TA-Lib's percent; PVT's
published definition (ChartIQ's) is the fraction, so the constant appears in one
visible place rather than in a re-derived ratio — and the zero-base guard comes
with it. On the seed: unlike `obv`, whose `volume[0]` convention is TA-Lib's and
is matched for exactness, PVT has no vendor function to defer to, and the term
needs a previous close. Every level from bar 1 on is identical either way, so
declining to invent the seed costs nothing (a test pins that).

(4) **CMF is `rollingWeightedMeanValues`, MFI is two `rollingMeanValues`
passes, and `volumeOscillator` is `priceOscillator`.** No new window loops. CMF
is `Σ x·w / Σ w` with the close location for `x` — literally VWAP's kernel — so
it inherits the "a gap in either input leaves both sums" and "`Σ w = 0` →
missing" rules rather than growing a second set. MFI's ratio cancels the
`1/period`, so _means_ serve for its two sums. And `volumeOscillator` **is**
`priceOscillator`'s percent mode over the volume column; it delegates, a test
pins the identity, and what the wrapper adds is the name and the 5/10/sma
defaults (against 12/26/ema) — a thin alias being the honest answer when only
the vocabulary is new. Its `'absolute'` mode is deliberately not re-exposed: a
difference of two volume averages is a share count, which is what the percent
form exists to normalise away.

(5) **Volume Rate of Change is not a study.** `percentChange({ column:
'volume' })` _is_ the corpus definition, and `percentChange` is already
cross-checked against TA-Lib's `ROC`. What shipped is a recipe note in API.md
and a test that pins it — step 0 of the studies README, the `roc` precedent.

(6) **MFI's TA-Lib deltas, measured.** Values agree to `2.8e-14` with identical
masks, and the warm-up is `period` rows (not `period − 1`) on both sides. Two
divergences: a window with **zero total flow** (a flat typical price, or no
volume) is `undefined` here and `0` in TA-Lib — the `rsi` flat-window rule, and
`0` is MFI's most bearish reading for a window that showed no direction. More
sharply, **TA-Lib returns `0` for any window whose total flow is merely below
`1.0`** (a magnitude threshold in its C source, not a definition): measured on a
strictly rising 20-bar series at `1e-9` volume it returns `0` where the answer
is `100`. This study has no threshold.

(7) **`easeOfMovement` exposes `scale`, and is quadratic in price.** `100_000_000`
is StockCharts'/ChartIQ's constant and is a pure linear multiplier, so the knob
cannot change a sign or a crossing — it is exposed because the right constant
depends on the instrument's volume units (a crypto pair quoting fractional
volume reads as zeros at 1e8), and a caller forced to rescale the output column
by hand would be silently incomparable with the chart package beside them. The
alternative (fix it, tell callers to multiply) was considered and rejected on
that ground. Its **scale behaviour is the odd one in the package** and is pinned
because the plausible assumption is wrong: the distance moved _and_ the bar's
range both scale with price, so EOM scales with **k²**, is inversely
proportional to volume, and is linear in `scale`.

(8) **Lesson from the mutation matrix: a "redundant" guard that is
load-bearing on exactly one MA type.** Removing the `volume === 0` guard in
`easeOfMovement` killed **zero** tests — the window MA types mask a non-finite
cell, so the resulting `±Infinity` read back as missing anyway. It is not dead
code, though: `smma` is Wilder's recursion and _carries_ what it is given, so an
unguarded infinity would reach `withColumn`, which rejects an infinity loudly.
The fix was the missing test (`maType: 'smma'` over a zero-volume bar), not the
`rollingWeightedMeanValues` answer of deleting the guard — the difference from
that case is that this one has a reachable failure and that one had none.
Measured on the ten K2 types with an `Infinity` in the input: only `smma`
propagates it to the output.

**Perf at 1M bars** (all in their expected bands; nothing owns a data loop):
`accumulationDistribution` 53.4 ms, `chaikinOscillator` 70.1 ms,
`priceVolumeTrend` 33.0 ms, `chaikinMoneyFlow` 103.7 ms, `moneyFlowIndex`
110.6 ms, `forceIndex` 32.4 ms, `easeOfMovement` 74.8 ms, `volumeOscillator`
84.2 ms — against `obv()` 27.5 ms, `vwap(20)` 99.6 ms (CMF's own kernel) and
`sma(20)` 43.1 ms (volume oscillator is two of them).

**Landed — the momentum tail (§6.3).** `chandeMomentum`,
`ultimateOscillator`, `commodityChannelIndex`, `intradayMomentumIndex`,
`relativeVigorIndex` and `psychologicalLine` — six oscillators that are all
**ratios**, which is the property that shapes the batch: unlike the price-unit
family (`elderRay`, `atrBands`, `awesomeOscillator`) every one is invariant to
**both** a scale factor and a constant shift, and both halves are asserted,
because an implementation that dropped a normalisation keeps the shift
invariance and loses the scale one. Decisions:

(1) **CMO ships Chande's unsmoothed sums, and step 0 is why.** TA-Lib's `CMO`
Wilder-smooths the two legs, which makes it **exactly `2 · rsi − 100`** — the
generator asserts that (`2.8e-14` on the oracle input at both parameterisations)
rather than asserting our agreement with it. Shipping TA-Lib's definition would
have added a study that is an affine restatement of a shipped column, which is
the failure mode the studies README's step 0 exists to catch. The two are a
genuinely different series, not a warm-up transient: identical warm-ups
(both first emit on bar `period`) and **68.28 points apart at `period 14`**,
131.55 at `period 5`, on a scale spanning 200 — asserted as a minimum
separation so the fixture cannot stop telling them apart. Chande's form is also
the one the corpus names and the one VIDYA's adaptive constant is defined on,
so it is the form a future K2 `vidya` type will want. Rejected: a
`smoothing: 'wilder' | 'none'` option — two indicators behind a flag, and the
caller who wants TA-Lib's number already has `2 · rsi(...) − 100` exactly.

(2) **The Ultimate Oscillator takes three named periods, not a tuple.** The
4/2/1 weights are **positional**, so `periods: [28, 14, 7]` is a silently
different indicator while `longPeriod: 7` is obviously wrong at the call site;
the three are validated strictly increasing for the same reason. The weights
themselves are not an option (nobody publishes an alternative). Parity with
`ULTOSC` is exact — **7.1e-15**, identical masks, at both `(7,14,28)` and
`(3,5,9)` — and the generator additionally asserts our `trueRangeValues` is
`talib.TRANGE` **bit-for-bit** (`0.0`), so the ATR family and this study measure
range identically by construction rather than by coincidence. The warm-up is
`longPeriod` rows, not `longPeriod − 1`: both `BP` and `TR` read the previous
close.

(3) **CCI brought the package's first super-linear kernel, and it is stated
rather than hidden.** `rollingMeanAbsDevValues` is **O(N·period)**: mean
absolute deviation is not a moment, so it has no O(1) sliding update — one
removal and one addition can flip the sign of every remaining term. A
sub-linear form does exist (an order-statistic index over the window, prefix
sums either side of the mean, `O(N log period)`), and it is **written down in
the kernel docstring but not built**: measured at 1M bars, `period 20` costs
128 ms and `period 100` costs 229 ms, so the deviation walk is ~1.3 ms per unit
of period per 1M bars — ~25 ms of the 128 at the default, which is the same
band as the linear studies rather than a different one. The tree form is the
answer only if a caller wants CCI at a period in the thousands. The `period 20`
default is ChartIQ's and is **not universal** (TA-Lib's own default is 14),
which the docstring says so a vendor comparison checks the length first.

(4) **A zero-deviation guard was written, and mutation testing deleted it.**
CCI's `mad === 0` case is real (`undefined`, a deliberate delta from TA-Lib's
`0`, on the `rsi` flat-window precedent) but it needs no branch: the window ends
on the bar being reported, so a zero deviation forces a zero numerator and the
case _is_ `0/0`. The explicit guard survived every mutation because no input can
tell it is there — exactly the `rollingWeightedMeanValues` finding repeating,
and now recorded twice. The same reasoning is why `chandeMomentum` and
`intradayMomentumIndex` were written without one (non-negative legs: a zero
denominator forces a zero numerator). It does **not** apply to `ultimateOscillator` and
`relativeVigorIndex`, whose denominators can be zero over a non-zero numerator
on inconsistent bars (a close outside its own range, which a redirected `close`
option produces) — those guards kill mutations, and `±Infinity` reaching
`withColumn` is the alternative.

(5) **IMI is plain sums, not Wilder's.** The corpus maps it as "RSI form on
`(C − O)`", and _RSI form_ is the ambiguity: RSI's averages are smoothed, every
published statement of IMI's are not. The unsmoothed form ships, which is what
gives it the window family's recover-after-a-gap behaviour instead of RSI's
carry-to-the-end. Its warm-up is `period − 1`, one row shorter than `rsi` and
`chandeMomentum`, because a body needs no previous bar. Over identical legs
`imi = (cmo + 100)/2`, and a test pins that on a series whose opens are the
previous close — the two studies checking each other's arithmetic.

(6) **RVI is TradingView's, and the SWMA is a kernel.** The smoother is the
**symmetric `(1,2,2,1)/6`** 4-bar filter, not the K2 engine's linear `wma(4)`;
same width, same normalisation, completely different impulse response, so a
kernel test pins the response to a unit spike (`1, 2, 2, 1`, not `4, 3, 2, 1`).
The width is fixed rather than a `period` because "SWMA" names those weights and
there is no published rule to generalise them. The signal line is a fourth SWMA
of the index (TradingView's), the warm-up is per column (`period + 2` and
`period + 5`), and this is the first study in the package to read all four OHLC
columns.

(7) **Psychological Line pins the two choices it has.** An unchanged close is
**not** an up bar (strict `>`, so a flat window reads `0`, not `50` — some
vendors count it as half, which is a different study), and it is the one ratio
here with no `0/0` case at all because its denominator is `period`. A bar with
no close leaves **two** bars undirected (its own and its successor's), which the
array door then carries.

(8) **One kernel was extracted rather than added.** `upDownLegValues` — the
gain/loss split — was a private loop in `rsi`; `chandeMomentum` and
`intradayMomentumIndex` need the same one, so it moved to `kernels/up-down.ts`
and `rsi` now calls it (oracle unchanged). It earns a kernel because the obvious
one-liners are both wrong in one case each: `Math.max(d, 0)` maps a flat bar
correctly but `d > 0 ? d : 0` maps an **unknown** change to a flat one, and
"flat" and "unknown" are the two answers the whole family's `0/0`-versus-gap
behaviour depends on.

(9) **A fixture finding worth carrying forward.** The oracle's `opens` are the
previous close pulled inside the bar, so over a short window the candle bodies
and the close-to-close changes nearly coincide: IMI and the same form on closes
are **0.0 points apart at `n = 3`** and 0.07 at `n = 4`, reaching ~10 by
`n = 12`. The second IMI oracle case is therefore `period 8` (6.2 points apart),
not a shorter one — a fixture that cannot separate the two inputs would pass a
study that read the wrong one.

Perf at 1M bars (medians of 5, run twice, agreeing within 10%):
`psychologicalLine` 50 ms, `intradayMomentumIndex` 82 ms, `chandeMomentum`
90 ms, `commodityChannelIndex` 128 ms (229 at `period 100`),
`relativeVigorIndex` 149 ms, `ultimateOscillator` 225 ms — against `rsi` 59 ms,
`awesomeOscillator` 85 ms and the range studies' 250–330 ms. The two dearest are
the two that run the most kernel passes (UO computes six rolling means plus a
true range; RVI two SWMAs, two rolling means and a third SWMA), which is what
"a study is options-validation plus kernel calls" is supposed to cost.

**Considered and not built**: a `weights` option on the Ultimate Oscillator
(the definition is the weights); a `maType` on any of the six (none of the
published definitions has a smoother to choose — CMO and IMI sum, CCI averages
by definition, RVI's filter is named in its own definition); the
`O(N log period)` mean-absolute-deviation kernel (documented, gated on a caller
who wants a period in the thousands); and a half-credit rule for an unchanged
close in `psychologicalLine` (a second study behind a boolean).

**Landed — the Wilder directional group (§6.4).** `directionalMovement`,
`aroon` and `vortex`, plus the two kernels they needed —
`directionalMovementValues` (with the vortex's crossing legs beside it) and
`barsSinceExtremeValues`, the corpus's **G3 argmax gap**. The batch's shape is
the split between a _recursion_ and a _window_: two Wilder smooths stacked on
a third for `ADX`, against two studies that recover from a gap. Decisions:

(1) **The DMS ships Wilder's seed, and TA-Lib's own inconsistency is the
argument.** TA-Lib's `ADX` family accumulates `+DM`/`−DM`/`TR` over the first
`period − 1` bars and then takes one decayed step; Wilder's published
worksheet sums the first `period` and decays from there, which is exactly
`period ×` the mean-form recursion `wilderValues` runs — **and is what
TA-Lib's own `ATR` does**. Measured on the oracle input at `period 14`,
TA-Lib's `ATR` first value is `1.515450` while the true range its own `+DI` is
dividing by on the same bar is `1.411787`: a caller plotting TA-Lib's `+DI`
beside TA-Lib's `ATR` is reading two different ranges. Ours cannot diverge
that way — the `DI` denominator is literally the `atrValues` call, and a unit
test pins that a fixture with `+DM = 2`, bar range `2` and true range `3`
reads `+DI = 200/3` rather than `100`. The cost is a **decaying transient**
against TA-Lib rather than a wrong rate (the `macd`/`ema` precedent): `+DI`
0.117 points at the first shared bar, 0.513 at worst, 0.0092 by bar 79;
`ADX` 0.421 → 0.0046; at `period 5` it is larger at the start (2.58) and gone
(1e-6) by bar 79, decaying as `(1 − 1/period)^k`. The oracle splits the proof
the way `moving_average` splits the EMA family: **replay our own pipeline on
TA-Lib's seed and assert the FORMULA exactly** (`≤ 2.9e-14` on all five
columns, masks identical either way), then bound the pond-seed transient and
assert it decays. Rejected: a second Wilder door taking TA-Lib's seeding —
it would make `directionalMovement`'s range disagree with `atr()` inside our
own package, which is the same trade `macd` refused.

(2) **`ADXR` looks back `period − 1` bars.** Wilder's prose says "the `ADX`
`period` days ago" and several vendors read that literally; TA-Lib uses
`i − (period − 1)`, and so does this — it is what keeps the family
mask-identical to TA-Lib, and it is the package's own **bar-count**
convention, since a `period`-bar window spans `i − period + 1 … i` and this
averages its two ends. Measured separation between the two readings on the
oracle input: **2.64 points at `period 14`**, 8.19 at `period 5` — asserted in
the generator so the fixture cannot stop telling them apart. A caller wanting
the literal reading has `dmiAdx` on the series and can shift it.

(3) **One study, five columns, five warm-ups** — the `macd` precedent, taken
further than any study so far. `ADXR` as a knob or a separate study was
rejected: it would re-run the entire pipeline to append one column that is two
reads of a column the study already holds. Warm-ups are `period` /
`2·period − 1` / `3·period − 2`, TA-Lib's own, and identical to its masks on
every column — the seed moves values, never lookback.

(4) **`+DI + −DI = 0` is `DX = 0`; a zero true range is `undefined`.** The
house test (is the numerator _forced_ to zero by the same condition?) splits
these two cleanly for once. Both `DM` legs are non-negative, so a zero sum
means both are zero and `|+DI − −DI|` is exactly zero with it — the
`clvValues` flat-bar case, and a real market state (a run of inside bars: range,
but no directional movement), which TA-Lib also reads as `0`. A zero **true
range** is not: there the `DI` ratio is a genuine `0/0`, and TA-Lib's `0`
would be indistinguishable from a real reading. `vortex` needed the opposite
answer for the same-looking case: `Σ TR = 0` does **not** force `Σ +VM = 0`,
because a flat window can still be preceded by a bar at another level, so its
guard is real (`±Infinity` is the alternative) and a unit test builds exactly
that series.

(5) **The G3 argmax kernel is a monotonic deque, and it is now the measured
case for the core fast path.** `barsSinceExtremeValues` keeps a ring buffer of
candidate indices, so it is O(N) and **flat in `period`**: measured at 1M bars,
26.7 ms at `period 25` and 26.5 ms at `period 200`, against a naive re-scan's
78 ms and 545 ms (both benchmarked, the naive form kept in `perf-studies.mjs`
as the control). The consequence worth carrying forward is the comparison with
the studies on core's reducers: `aroon` costs **102 ms** at 1M bars where
`donchian` costs **247 ms** and `stochastic` 313 ms. That is the first measured
number behind the standing note that a monotonic-deque fast path for core's
rolling min/max would lift the range studies ~2×.

(6) **Two window rules, deliberately different, in the same file.**
`barsSinceExtremeValues` is **strict** — every one of the `period + 1` cells
must be finite — where `highestLowestValues` skips gaps and reports the extreme
over what it has. The distinction is that an extreme over the cells you _do_
have is still an honest extreme, but its **age** is not: the hole could be
hiding the very bar being asked about. TA-Lib's own answer is the argument for
strictness — fed a `NaN` high it silently skips that bar (a comparison
against `NaN` is false) and its output is bit-identical to the clean run
(measured, `period 25`, holes at bars 30/40/60), so the hole leaves no trace
and every age counted across it is confidently wrong.

(7) **The window is `period + 1` bars** — the one place in the package where a
`period` is not its window's bar count. Aroon's `period` counts the oldest
_age_ reportable, and "`period` bars ago" is itself a reading. The rule lives
in the kernel rather than in `aroon` so a second consumer cannot get it wrong,
and the warm-up (`period` rows) is TA-Lib's.

(8) **Ties go to the most recent bar**, measured rather than assumed: on the
window `12, 11, 12, 10.5` at `period 4`, TA-Lib reports `aroonUp = 75` (the
newer bar's age), not `25`. The deque gets this from **non-strict** eviction
(`<=` for a max), and the generator asserts the measurement so the claim stays
reproducible.

(9) **The vortex's legs live in the DM kernel file, unexported.** `+VM` and
`−VM` are the same shape as Wilder's split — a two-legged per-bar derivation
off the previous bar's extremes — and the _contrast_ is the point: Wilder
compares each extreme with the previous bar's same extreme (at most one leg
non-zero, an inside bar reports nothing), the vortex crosses them (both legs
always positive). Keeping them together is what makes that a comment rather
than a coincidence. Only `directionalMovementValues` and
`barsSinceExtremeValues` are public, on the `movingAverageValues` precedent;
`vortexMovementValues` is module-scoped like `trueRangeValues`.

Perf at 1M bars (medians of 5, run twice, agreeing within 8%):
`aroon` 102 ms (110 at `period 200` — flat), `directionalMovement` 145 ms,
`vortex` 143 ms — against `rsi` 55 ms, `atrBands` 66 ms, `donchian` 247 ms and
`stochastic` 313 ms. The two Wilder-family studies cost what their kernel
passes cost (`directionalMovement` runs a DM split, a true range and four
Wilder smooths; `vortex` a movement split, a true range and three rolling
means).

Mutation matrix (failing tests per mutation, over the seven affected test
files): DM sign guard removed 1 / 1, `Math.max(up, 0)` 4, non-strict leg
comparison 1 / 1, NaN guard dropped 1, bar 0 zero-not-missing 1 / 1, `+VM`
absolute value dropped 1, `+VM` reads its own low 8; argmax tie rule 3, warm-up
one bar early 8, window one bar short 7, gap rule dropped 7, min mode 8, window
`period` not `period + 1` 7; DMS `DX` guard inverted 1, `DX` absolute value 3,
ADXR look-back `period` 6, ADXR without the look-back 5, ADX smoothed at the
wrong rate 7, DI denominator unsmoothed 23; aroon age not inverted 4, down leg
on the high column 5; vortex guard removed 1, legs swapped 4, plain-range
denominator 4. **One real survivor, now fixed:** dropping the `up > 0` sign
guard from the `+DM` leg killed nothing — the mirror case on `−DM` was covered
and this one was not (the shape is an inside bar whose high fell _less_ than
its low rose, where an unguarded leg reports a negative `+DM`); a kernel case
was added and it now kills a test. **One mutation survives by construction and
is left alone:** relaxing `up > 0` to `up >= 0` is semantically a no-op (at
`up === 0` both branches assign `0`), the third instance of the
`rollingWeightedMeanValues` / `commodityChannelIndex` finding — a branch no
input can distinguish. The `wilderValues(…, start = 1)` calls are the same kind
of documented no-op `atrValues` already carries.

**Considered and not built**: an `adxr` boolean or a second study for it (see
(3)); a `maType` on any of the three (Wilder's smoothing is the definition,
and the vortex's sums are not an average of anything); clamping `+DI`/`−DI`
into `0..100` (the bound is a property of consistent bars, not something to
enforce — an inconsistent redirected `close` should read honestly); and
promoting `barsSinceExtremeValues` to a core reducer, which is the right
follow-up but belongs with the rolling min/max fast path it shares a structure
with, not with a study batch.

**Decision record — the Wilder-vs-`ema` interior-gap asymmetry.** Deferred
since the Phase-1 write-up as "decide before ADX"; ADX is the study that makes
it compound, so here is the measured statement and a recommendation. **Nothing
was changed** — both kernels ship as they were.

_The two behaviours._ `wilderValues` propagates an interior `NaN` to the end
of the series: its recursion carries state forward, and there is no state to
carry across a hole. `emaValues` **skips** the gap bar and carries on from the
value before it, which is what lets `macd` and the K2 `ema` family run over
another study's output without emptying. Both kernels already step over a
_leading_ run of gaps, so the asymmetry is purely about interior ones.

_What the new studies do, measured_ (an 80-bar series, one missing cell at bar
40, `period 14`): a gap in **`high`** or **`low`** blanks `dmiPlusDi`, `dmiMinusDi`,
`dmiDx`, `dmiAdx` and `dmiAdxr` from bar **40** to the end — the `DM` split needs
both bars, and the Wilder smooth then carries it. A gap in **`close`** blanks
the same five from bar **41**: the true range reads only the _previous_ close,
so it is the next bar that has no denominator (`dmiAdxr` emits at bar 40, its
first possible bar, and nothing after). `aroon` and `vortex`, being windows,
lose a bounded run and recover — `aroon` `period + 1` bars, `vortex` up to
`period + 1`, with the two legs losing _different_ rows.

_What TA-Lib does with a `NaN`, measured._ Its behaviour is not a policy at
all; it is an artifact of C comparison semantics, and it goes both ways. A
`NaN` **high** or **low** propagates to the end of `ADX` exactly as ours does
(40 of the 40 remaining bars missing). A `NaN` **close** produces **no missing
value whatsoever**: every `max` comparison against `NaN` is false, so the true
range silently falls back to the bar's own range and the study carries on with
a wrong number. `AROON` fed a `NaN` high does the same — it skips the bar
silently and its output is bit-identical to the clean run (measured; the
builder's earlier "`aroonUp = 100` forever" claim was false and is corrected
in PR #702), so a hole leaves no trace at all.
So on this axis pond is already strictly better defined than the vendor, in
both directions.

_The options._

- **(a) Keep the asymmetry, document it per study** — the status quo.
  Blast radius: none. The two kernels differ because their _seeds_ differ in
  kind: `emaValues` is defined over a stream of samples (its seed is the first
  sample, so "skip" is just "do not consume that one"), while Wilder's is
  defined over a fixed _count_ of bars whose mean seeds it — skipping a hole
  silently redefines the time base, making a "14-bar RMA" span 20 calendar
  bars without saying so. It is also the conservative answer: a bar with no
  close leaves the _next_ bar's true range unknown too, so there is no honest
  value to resume from.
- **(b) A `gaps: 'propagate' | 'skip'` option on `wilderValues`.** Blast
  radius: none by default, but the option has to surface on every study that
  smooths — `rsi`, `atr`, `keltner`, `atrBands`, `directionalMovement`, and
  the K2 `smma` type wherever a `maType` is exposed (ten studies) — or it is a
  kernel knob no caller can reach. That is the `smoothing: 'wilder' | 'none'`
  shape the CMO write-up rejected: two indicators behind a flag.
- **(c) Make `wilderValues` skip, like `ema`.** Blast radius: every Wilder
  consumer changes on gapped input — `rsi`, `atr` and everything on
  `atrValues` (`keltner`, `atrBands`, the new `directionalMovement`), plus
  `movingAverage({ type: 'smma' })` and the ten `maType` studies that can
  select it. No **oracle** case moves (the fixture is gap-free), which is
  precisely why this would be a silent behaviour change: nothing in the value
  suite would flag it, only the missing-cell tests.

_Recommendation: **(a)**._ The asymmetry is not an inconsistency to reconcile
but a difference in what the two recursions are defined over, and every study
that hits it now says so in its docstring. Revisit only on a real friction
signal — an experiment whose bars genuinely have interior holes (a halted
session) and whose Wilder studies therefore read empty from the halt onward.
The answer today is "fill before smoothing", and if that turns out to be
unreasonable in practice, **(c)** is the honest fix rather than **(b)** — one
behaviour, not a flag — and it should land as a deliberate, changelogged
behaviour change with missing-cell tests updated in the same pass.

_Decision (Peter, 2026-09-06): **keep** — option (a)._ The asymmetry stands
and is documented per study; (b) is rejected as a flag in front of two
indicators, and (c) is reserved for a real consumer with gapped bars in hand,
to land as a changelogged behaviour change, never silently.

**Landed — the volatility tail (§6.5).** `chaikinVolatility`, `massIndex`,
`choppinessIndex`, `ulcerIndex`, `verticalHorizontalFilter`,
`gopalakrishnanRangeIndex` and `relativeVolatilityIndex` — seven studies of
**range and drawdown**, and the batch's defining property is that **TA-Lib
implements none of them**. Every previous batch had at least one vendor anchor
to hang the others off (`ULTOSC`, `CCI`, `MFI`, `ADOSC`); this one has none, so
the oracle discipline had to carry the whole load: each of the fourteen cases
asserts the **analytic first-valid bar** and a **measured separation from the
plausible wrong turn** — the substitution a reader of the formula could make
that leaves the curve's shape intact and changes every value. Without the
second half a fixture pins a wrong indicator perfectly. Decisions:

(1) **Plain range and true range are two families, and the split is by
author.** `chaikinVolatility` and `massIndex` smooth `high − low`; `atr`,
`keltner` and now `choppinessIndex` smooth _true_ range. Neither side gets a
`range | trueRange` knob — that is two indicators behind a flag (the `keltner`
precedent) — and the oracle measures the gap so the choice is visible rather
than assumed: **35.6 points** for Chaikin Volatility at `(10, 10)` and **7.7
points** of Choppiness at `period 14`. The shared `high − low` derivation
became **`barRangeValues`** in `kernels/typical-price.ts`, beside
`typicalPriceValues` and `medianPriceValues`, on the two-consumer rule.

(2) **The log base cancels in both log studies, and the first draft got that
wrong.** Choppiness is `log_b(ΣTR/(HH−LL))/log_b(n)` and GAPO is
`log_b(HH−LL)/log_b(n)`; both are `log_n(x)`, so `ln` and `log10` give the
_same number_ and neither study takes a base option. GAPO's docstring
originally claimed the opposite — that its numerator is a bare logarithm of a
dimensioned quantity, so the base is load-bearing — and the generator's
separation assert **failed at 2.2e-16**, which is how the error was caught
rather than shipped. What is now asserted is the identity (`ln/ln == log10/
log10`) plus a separation from the real slip, **mixing** the bases. Both
studies reject `period: 1`, where the denominator is zero.

(3) **GAPO is the one study in the batch that is not scale-invariant, and it
is pinned as an identity.** Scaling every price by `k` shifts the reading by
**exactly** `ln(k)/ln(period)` — asserted in the generator to `1.8e-15` and in
a property test to 10 decimals — because GAPO carries the _units_ of the
price. `ulcerIndex` is the mirror: scale-invariant (it divides by a price) and
**not** shift-invariant, asserted as a _direction_ (adding a constant must
shrink every reading) rather than merely "different". The other five are
invariant to both. The batch's property matrix is therefore written out study
by study rather than looped over one claim — a loop would have quietly
asserted the wrong half for two of the seven.

(4) **Ulcer brought the first square root of a rolling mean, and it needed a
counter.** `sqrt(mean(drawdown²))` composes badly with an incremental
accumulator: the rolling mean carries an `O(ε)` residue from the values that
have just left the window, and the square root turns `2.5e-18` in the mean of
squares into **`1.6e-9`** in the reading — precisely where the true answer is
exactly `0` (a window at new highs, which is also the reading a caller looks
for). **The oracle caught it**: the `period 5` case failed at bar 22 against
pandas' Kahan-compensated `rolling().mean()`. The fix is a running count of
the bars that actually contributed a drawdown, `O(1)` per bar; a window with
none reports `0` exactly and every other value keeps `rollingMeanValues`'
arithmetic. Rejected: an `O(N·period)` exact walk (the `rollingMeanAbsDev`
route — correct everywhere, but ~1.3 ms per unit of period per 1M bars for a
residue that is relative `1e-16` on every reading but this one), and loosening
the oracle's global 1e-9 tolerance (shared infrastructure, and it would hide
the next study's real drift).

(5) **The zero-denominator question was asked seven times, and the mutation
matrix answered it — twice against the first draft.** The #699 test (_is the
numerator forced to zero?_) turns out to be only half the rule. The other half
is **where the division sits relative to the next kernel**, and it is new:

- **`choppinessIndex` needs two guards, and both are live.** Its halves read
  _different_ columns, so a redirected `close` puts a positive ΣTR over a zero
  span (`log10(∞)`) and bars whose high and low sit on the previous close put a
  zero ΣTR under a positive span (`log10(0)`). The division is the study's
  **last** step, so a non-finite result would reach `withColumn` — which
  **throws** on `±Infinity` rather than mapping it to a gap. Each guard has its
  own unit test and each is killed by its own mutation.
- **`gopalakrishnanRangeIndex`'s flat-window guard is live** for the same
  reason: `ln(0)` at the output.
- **`verticalHorizontalFilter` and `relativeVolatilityIndex` needed none**, on
  the #699 test alone: both read one column (VHF) or two non-negative legs
  (relVol), so a zero denominator forces a zero numerator and `0/0` is already
  `NaN`.
- **`massIndex` and `ulcerIndex` were written WITH a guard, and mutation
  testing deleted both.** Their divisions sit _upstream_ of a
  {@link rollingMeanValues} summation, and that kernel counts a **non-finite**
  cell as missing exactly as it counts a `NaN` — so an `Infinity` produced by a
  crossing-column double EMA, or by a zero rolling peak with a value under it,
  never survives to `withColumn`. The guard was unobservable: no input could
  tell it was there. This is the CCI dead-guard finding (now recorded a third
  time) arriving by a **new mechanism** — not "the numerator is forced to zero"
  but "a rolling kernel downstream of the division absorbs it" — and the pair
  of live/dead cases in the same batch is what makes the rule statable:
  **a zero-denominator guard at a study's output is load-bearing; one upstream
  of a window kernel is not.** Both crossing cases are still unit-tested (the
  behaviour is pinned even though the branch is gone).

`choppinessIndex`'s flat window is explicitly **not** the
`accumulationDistribution` flat-bar case: a close location's numerator is
algebraically forced to zero, so `0` is the answer; here the two candidate
conventions (`0` = perfectly trending, `100` = perfectly choppy) are
**opposites** for a market that did not move, so there is no value a limit
picks out.

(6) **`relVol`, not `rvi` — the name collision is resolved by yielding.**
"RVI" abbreviates both the Relative _Vigor_ Index (shipped, §6.3) and the
Relative _Volatility_ Index. The Vigor Index keeps `rvi` (it claimed it first,
and its option is a `prefix` shared with a signal column); the Volatility Index
takes **`relVol`**, and a test appends both to one series to pin that they
coexist. Its own definition fork is `F-AMBIG` in the corpus and is pinned to
**Dorsey as revised** (σ over 10, Wilder over 14): TradingView's EMA-smoothed
build is **31.3 points** away and is measured, and Dorsey's high/low variant is
two calls to this study plus an average, not an option. An unchanged close
counts as a **down** bar — a deliberate asymmetry against `rsi`'s
`upDownLegValues` split, which gives a flat bar `0` on both legs — and the test
that pins it is the one that matters: on a series of all-up closes with one
flat bar, the `rsi` rule would read exactly `100` everywhere and Dorsey's reads
63.4.

(7) **`ulcerIndex` pins the rolling variant and says what it is not.** The
corpus flags **F-AMBIG** on "smoothing variants" and three things ship under
the name: StockCharts' rolling form (what ships), Martin's cumulative original
(one number per portfolio — a different _deliverable_, and a study whose window
silently means "everything" would be a footgun beside every other bar-count
study here), and the mean-**absolute** form, which is the _Pain Index_ and has
its own name (**1.53** away on the fixture, asserted apart).

(8) **A kernel inconsistency surfaced and is documented rather than
patched.** `rollingValues`' answer to a **misnamed column** depends on the
reducer: `stdev` and `avg` take the range-exact `rollingMeanSdColumns` path,
which reads a missing column as all-`NaN`, while `max` / `min` fall through to
core's sweep, which throws. So `relativeVolatilityIndex` answers empty where
`ulcerIndex` and `verticalHorizontalFilter` — the same door, one reducer along
— throw. Both behaviours are pinned by tests and stated on all three studies.
It was not fixed here because the choice (throw everywhere, or answer
all-missing everywhere, matching `highestLowestValues`) is a kernel-level
decision that would move existing studies' behaviour, and this batch is not
the place to make it. **Carry-forward.**

(9) **Two warm-ups are measured rather than derived, because the doors are
mixed.** `ulcerIndex` reads its peak through the _column_ door (rows, skips
gaps) and its mean of squares through the _array_ door (finite values), so
over an `sma(3)` it first lands on bar **4**, not the `2 + 2·3 − 2 = 6` the
array rule alone gives. `relativeVolatilityIndex` is the same story one step
along: its σ emits from the column door's first row (over one value, where σ
is `0` — `rollingStdev`'s contract, the one `historicalVolatility` already
flags), so it starts at bar **5**, one earlier than derived. Both are pinned
by tests and stated on the studies; the general rule "compose the warm-ups"
is not enough when a study reads two doors.

(10) **`gopalakrishnanRangeIndex` is the only study in the batch that survives
an interior gap.** It reads nothing but core's rolling extremes, which _skip_ a
missing cell, so it keeps reporting over one bar fewer where the six studies
with an averaging or recursive half blank. `relativeVolatilityIndex` is the
other extreme — a Wilder recursion, so an interior gap runs to the end of the
series, as in `rsi` and `atr`. Both are pinned in the missing-cell suite rather
than left to be discovered from a chart.

Perf at 1M bars (medians of 5, run twice, agreeing within 11%):
`chaikinVolatility` 30 ms, `relativeVolatilityIndex` 75–84 ms, `massIndex`
73–81 ms, `ulcerIndex` 172–176 ms, `gopalakrishnanRangeIndex` 234–241 ms,
`verticalHorizontalFilter` 250–263 ms, `choppinessIndex` 288–291 ms — against
`ema` 14 ms, `sma` 38 ms, `rsi` 56 ms, `bollinger` 108 ms, `donchian` 241 ms,
`williamsR` 252 ms and `stochastic` 319 ms on the same run. The ordering is
entirely the substrate: the three dearest all run core's rolling **min/max**,
which is the package's most expensive reducer pair (the monotonic-deque fast
path `highestLowestValues` asks for would lift all of them at once), while the
two cheapest are pure EMA chains. Nothing here is `O(N·period)`.

**Mutation matrix**: 29 mutations, one per shipped decision (the plain/true
range fork, each smoothing type, each period's role, each default, each guard,
each normalisation, the sum-vs-mean choice, the flat-bar rule, the `relVol`
output name). **Zero survivors** after the two dead guards above were deleted
and a direct `barRangeValues` kernel test was added — the sign of `high − low`
survived every study test, because both of its consumers read only _ratios_ of
ranges and are blind to a flipped sign, so the contract had to be pinned at
the kernel. Killed-test counts ranged from 1 (a changed default period, which
only the defaults test reads) to 12 (the `relVol` → `rvi` rename, which
collides with `relativeVigorIndex`).

**Considered and not built**: a `range | trueRange` option on any of the three
range studies (two indicators behind a flag); separate peak and averaging
periods on `ulcerIndex` (no published pairing); a cumulative mode on
`ulcerIndex` (a different deliverable); a `maType` on `chaikinVolatility` or
`massIndex` (Chaikin and Dorsey both name the EMA); a log-base option on either
log study (it cancels); a high/low mode on `relativeVolatilityIndex` (two calls
and an average); and fixing the `rollingValues` missing-column asymmetry, which
is recorded above as a kernel-level carry-forward.

**Landed — the regression family (§6.7).** `linearRegression`,
`timeSeriesForecast`, `chandeForecastOscillator` and `centerOfGravity` — four
studies over **one** new kernel, `kernels/linear-regression.ts` (**K7**). The
batch's defining property is the opposite of the volatility tail's: TA-Lib
implements **five** of the eight columns here exactly (`LINEARREG`,
`LINEARREG_SLOPE`, `LINEARREG_INTERCEPT`, `LINEARREG_ANGLE`, `TSF`), so the
oracle could hold the fit itself to bar-for-bar vendor agreement (≤ 1.3e-12 at
`period 14`, masks identical) and spend its separation asserts on the three
columns that have no vendor at all (`linregR2`, `cfo`, `cog`). Decisions:

_Post-merge review (Peter, 2026-09-07)._ Adversarial pass on the merged
kernel: a window that **changes by ulps** (not flat, so the change counter
does not fire) can leave the rolling `n·Σz² − (Σz)²` at `−1e-24`, and the
closed-form ratio wrote a **negative r²** into a `0 … 1` column. The first fix
(#707, draft) triggered on the _sign_ of the spread, and the Layer-2 pass on it
showed that was not the tell: a **positive** residue read `r² = 5.8e-11` where
the exact answer was `0.75`, and `3.0` (pinned to `1.0`) where it was `0.43`.
The shipped fix judges the spread against the **gross** magnitude that has
passed through the rolling sums since the last rebuild (added and removed
alike — a rolling sum's error is `ε` times that, not `ε` times its current
value, which after a plateau step is itself residue): below `1e-3` of it the
window is recomputed two-pass on a fresh local anchor, slope and intercept
included. Verified against an exact BigInt-rational reference over
plateau-stepped, ulp-jittered input at five magnitudes; the test fails with
the fix reverted. The lesson, recorded for every future rolling-moment kernel:
**the change counter fixes mathematical degeneracy, not numerical degeneracy**,
the sign of a cancelled difference says nothing, and the honest scale for
"is this residue?" is the gross magnitude the accumulator has seen. A Codex
pass (Peter, 2026-09-07; ~456k windows at 1e-12 … 1e12, periods 2 … 200)
found no error above 5.9e-13 at ordinary magnitudes and one uncovered class:
a line at a **subnormal** magnitude (`1e-200`), whose centred squares
underflowed inside the fallback itself. The fallback now works in units of
the window's largest deviation — r² is dimensionless and the slope scales
back by one multiply — so that window reads r² = 1.

(1) **One kernel, one pass, and every reading is a projection of it.**
`linearRegressionValues(values, period)` returns `{ slope, intercept, r2 }`;
`linearRegressionAt(fit, x)` reads the fitted line at one `x`, and that is the
only place the projection arithmetic lives — `x = period − 1` is TA-Lib's
`LINEARREG`, `x = period` is `TSF`, `x = 0` is the intercept the kernel already
returns. Five studies-worth of vocabulary, three call sites, no duplicated
formula. The fit is **O(N) and flat in `period`** because `x` is the bar index:
`Σx` and `Σx²` are closed forms of `period`, and the denominator
`n²(n²−1)/12` is a positive constant — which is also why the slope needs **no
zero-denominator guard at all**, a third category beside #703's live/dead pair
(there is nothing to guard: the denominator cannot be zero for `period ≥ 2`,
and `period 1` is rejected). Measured at 1M bars: the kernel is **29 ms at
`period 14` and 29 ms at `period 200`**.

(2) **`x = 0` is the window's OLDEST bar, so the intercept is its FIRST bar.**
That is TA-Lib's convention and it is the single most confusable thing in this
batch: a reader who takes "intercept" for "the line's value now" is off by
`slope·(period − 1)`, which on the oracle input at `period 14` is up to
**13.68 points** on a series whose entire range is 19.4. Both ends ship as
columns (`linregIntercept` and `linregValue`) rather than one, the identity
`Value = Intercept + Slope·(period − 1)` is asserted in the generator, and the
kernel's docstring leads with the convention.

(3) **`linregAngle` is scale-dependent, and it ships anyway.** TA-Lib's
`LINEARREG_ANGLE` is `atan(slope)` in degrees with **no** normalisation, so the
same instrument quoted in cents reads a different angle and a $400 stock and a
$4 stock moving the same percentage do not agree. Normalising it (by price, by
σ, by anything) would have been a different indicator wearing TA-Lib's name, so
the column matches TA-Lib bar-for-bar and the property is stated on the study
instead — and **pinned as an assertion that scaling MOVES it**, to the exact
`atan(k·tan(θ))` value. It is the one column in this package whose property test
asserts a dependence rather than an invariance, which is why the batch's
property matrix is written out column by column: a loop over "these are all
scale-invariant" would have been wrong for five of the eight.

(4) **The flat-window counter, and why it is not the `ulcerIndex` finding
twice.** A flat window is a genuine `0/0` for `r2` (a line explaining all of
zero variance) and a forced zero for `slope` — the #699 test, applied twice with
opposite answers. What is new is the _magnitude_ of getting it wrong. Ulcer's
residue was a small wrong number (1.6e-9 where 0 was right); here `r2` is a
**ratio of two residues**, so it is not small, not bounded, and not signed the
right way: measured on `[186.6, 154.81, 103.74, 193.5, 193.5, 193.5, 193.5]` at
`period 3`, the flat window reads `slope = −2.1e-14` and **`r2 = −13.5`** —
outside the statistic's own `[0, 1]` range. A running count of the changes
inside the window (`y[j] !== y[j−1]`) is O(1) per bar, is integer arithmetic so
it needs no rebuild, and decides both exactly. Two mutations kill it (deleting
the branch; reporting `r2 = 0` instead of `undefined`), so it is load-bearing in
both directions.

(5) **The shifted frame is not optional here, and the failure is louder than
`zScore`'s.** `n·Σxy − Σx·Σy` differences two `O(n²·ȳ)` quantities whose
difference is `O(n²·σ)`. Measured over 200k rows of `base + 0.01·i + 3·sin(i/7)`
at `period 20`, against a two-pass reference, with the same kernel anchored at 0
as the control:

| base   | slope (raw → shifted) | r² (raw → shifted)      |
| ------ | --------------------- | ----------------------- |
| `1e6`  | 2.97e-5 → **0**       | 1.56e-2 → **5.1e-15**   |
| `1e12` | 27.8 → **0**          | `Infinity` → **1.0e-7** |

The raw frame does not merely lose precision at 1e12 — its `r²` leaves `[0, 1]`
and reaches `Infinity`, because the two cancelling moment differences round to
different signs. Above ~1e13 the _input_ stops carrying the answer (a ±3 window
at 1e15 spans ~48 ulps, so `y − anchor` is quantised to ~2% of the spread) and
no arrangement of the arithmetic recovers it; that is recorded as a
representation limit rather than papered over. The rebuild is `ranged.ts`'
aligned `i % period === 0`, which also guarantees the anchor row is always
_inside_ the current window.

(6) **`linreg` / `tsf` were considered for the K2 `MaType` menu and left
out — with a reason, not a shrug.** The Time Series Forecast is a smoother and
vendors do list it in their MA menus, and it composes on this kernel in one
`case`. What it cannot do is keep the engine's contract: **every type in the
menu is the identity at `period 1`**, and a one-bar window has no slope (the
denominator is `0` at `n = 1`). Adding it would mean a per-type minimum period —
a change to the engine's shape, its fan-out tests and every study that exposes a
`type` option, not one `case`. So the regression smooth ships as a study, the
engine's `MaType` is unchanged, and the reason is on `timeSeriesForecast`'s
docstring where a future reader will look for it.

(7) **`centerOfGravity` needed no kernel, because its weights are `wma`'s
subtracted from a constant.** Neither existing weighted-mean helper fits:
`rollingWeightedMeanValues` takes per-**row** weights (VWAP's volume), not
positional ones, and `symmetricWeightedValues` is the fixed 4-bar `(1,2,2,1)`.
But CG's descending weights `n … 1` are `(n + 1)` minus `wma`'s ascending
`1 … n`, so with `u` the position in the window
`Σ(n−u)·p = (n+1)·n·SMA − WMA·n(n+1)/2`, and dividing by `Σp = n·SMA` collapses
the whole study to **`(period + 1)·(WMA/(2·SMA) − 1)`** — the K2 engine's `wma`
over `rollingMeanValues`, both already O(N), both already carrying the
rebuild-every-`period` numerics and the strict-window mask, so their masks agree
by construction. Writing a `centerOfGravityValues` kernel instead would have
duplicated `wma`'s recurrence and its rebuild for a second place to get the same
numerics wrong. The identity is exact algebra, not an approximation, and it is
**pinned by a test against the naive `O(N·period)` definition** at four periods
(agreement ≤ 1.1e-14; measured, not pinned, 8.0e-15 to 2.5e-14 over 50k bars
at a price of 1e12 depending on the series) so a future
editor can check the shortcut rather than trust it.

(8) **CG's zero line is TradingView's, not Ehlers'.** Ehlers' own EasyLanguage
adds `(Length + 1)/2` at the end, re-centring a flat window on `0`;
TradingView's `ta.cog` leaves it off, so a flat window reads `−(period + 1)/2`
(`−5.5` at the default 10). The uncentred form ships because more consumers plot
it; the two differ by a constant that depends only on `period`, so the _shape_
is identical and the generator asserts exactly that. The sign convention (newest
bar weight 1, so the reading is negative and rises as the price does) is pinned
by a separation from the ascending-weight reading — and that separation is
asserted **against the reading's own spread** rather than a fixed number,
because CG barely moves: 0.049 against a 0.045 spread at `period 5`, 0.173
against 0.162 at 10, 0.515 against 0.458 at 20. An absolute threshold would have
been arbitrary at one period and unreachable at another.

(9) **Two live zero-denominator guards, and they are live for the #703 reason.**
`chandeForecastOscillator` divides by the price and `centerOfGravity` by the
window's sum; both divisions are their study's **last** step, so an unguarded
`x / 0` reaches `withColumn` as `±Infinity`, which throws rather than mapping to
a gap. Neither numerator is forced to zero with its denominator (a window can
forecast a non-zero level for a bar printing `0`; `[1, −1]` sums to `0` with a
weighted sum of `−1`), so both guards are reachable, unit-tested, and killed by
their own mutations. Unreachable on prices, reachable over another study's
output that crosses zero — the `ulcerIndex` shape, on the live side of the line
this time.

(10) **The strict window, uniformly, across all four.** `x` names a _position_,
so dropping a missing cell would fit the line against the wrong abscissa: the
`wma` / `trima` / `hull` rule rather than `sma`'s rows-not-contributors. A
leading gap shifts the start (so the family composes over another study's
warm-up rather than coming back empty), an interior gap blanks the gap bar and
the `period − 1` after it, and then all four recover. That uniformity is worth
noting after the volatility tail, where three studies answered a gap three
different ways.

(11) **`period ≥ 2` is named per caller, and the mutation matrix is why.**
`assertRegressionPeriod(period, name)` takes the caller's name so
`linearRegression({ period: 1 })` says `linearRegression period must be at
least 2` rather than naming the kernel. The first matrix run reported the
study-level guard as a **survivor** — the kernel's own throw covered it, and the
test only matched `/at least 2/`. The fix was to pin the message that a caller
actually sees; three mutations (one per study) now die on it. `centerOfGravity`
deliberately does **not** take the restriction: it computes a moment, not a fit,
so `period 1` is a well-defined `−1`.

Perf at 1M bars (medians of 5, run twice, agreeing within 15%):
`linearRegressionValues` **29 ms at both `period 14` and `period 200`**,
`timeSeriesForecast` 46–54 ms, `chandeForecastOscillator` 63–68 ms,
`centerOfGravity` 72–78 ms (10 and 200 within noise of each other),
`linearRegression` 93–106 ms — against `ema` 11 ms, `sma` 35 ms, `rsi` 50 ms,
`bollinger` 103 ms, `donchian` 236 ms and a hand-rolled `Float64Array` SMA floor
of 8.7 ms on the same runs. The bare kernel sits **below `sma`** and 3.3× the
floor, which is the shape the analysis predicts (one pass, three O(1)
accumulator updates, one amortised rebuild); the studies' extra cost is
`withColumn` appends and nothing else, which is why the five-column
`linearRegression` reads like the three-column `bollinger` rather than like its
own kernel. Every entry is flat in `period` — the 14/200 pairs are the evidence,
and a caller who wants only the slope can call the exported kernel and skip the
four appends.

**Mutation matrix**: 36 mutations, one per shipped decision (the `x` origin and
its sign, each of the three accumulator recurrences, the shifted frame, the
rebuild cadence, the flat-window counter in both directions, the strict window,
the warm-up index, each projection's `x`, the angle's units, each default
period, each `period ≥ 2` guard, each zero-denominator guard, CG's sign,
normaliser, `/2`, centring convention and its `wma`-vs-`sma` half). **Zero
survivors** after the `period ≥ 2` message fix in (11). Killed-test counts ran
from 1 (a changed default, which only the defaults test reads) to 21 (dropping
the intercept from the projection, which every study and every oracle case
sees).

**Considered and not built**: a column-selection option on `linearRegression`
(five projections of one fit, all warming up together — a knob to append fewer
columns is `withColumn` bookkeeping, and the kernel is exported for a caller who
wants one array); separate `linearRegSlope` / `linearRegAngle` studies (each
would re-run the same O(N) fit — the `macd` / `directionalMovement` family
rule); a `centred` option on `centerOfGravity` (a constant offset, documented
and addable by the caller); clamping `r2` into `[0, 1]` (measured: it never
exceeds 1 even on an exactly straight line at `period 200`, so the guard would
have been dead — the residue case it would have caught is the flat window,
which the change counter handles exactly); a normalised "angle" (a different
indicator wearing TA-Lib's name); and adding `linreg`/`tsf` to `MaType`, whose
reason is (6).

**Landed — the two-series family (§6.7, G7).** `correlation`, `beta`,
`priceRelative` and `performanceIndex` — the first studies in the package that
read **two instruments** — plus the K8 kernel `rollingBivariateValues`. Seven
oracle cases; the two TA-Lib-backed studies agree with `CORREL` and `BETA`
bar-for-bar (1.3e-12 and 1.1e-12 at the defaults). Decisions:

_Post-merge review (Peter, 2026-09-07)._ Two findings, both fixed. (1) The
public kernel did not validate `period` where `linearRegressionValues` does;
it now asserts an integer `≥ 2`. (2) The K8 analogue of the regression
finding: a window that changes by ulps could have its `m2` driven to `≤ 0` by
the reverse-Welford removal, the clamp then read a variance of exactly 0, and
`correlation` / `beta` reported a **false missing cell** on a window that was
not flat. The first draft rebuilt only when `m2 ≤ 0`, which the Layer-2 pass
showed was too narrow (a tiny positive `m2` beside a covariance residue read
`|corr| = 20.5`). Shipped: the kernel carries the gross shifted squares that
have passed through its moments since the last rebuild and rebuilds the window
on demand when a changing column's `m2` is below `1e-3` of that, or when
`cxy² > m2x·m2y` past rounding slack; `correlation` pins `|r|` to 1 for the
last-ulp case only. Verified against an exact BigInt-rational reference the
same way as K7. The Codex pass on #707 tightened both slacks from 1e-6 to
1e-9 (rebuilt rounding measures ~1e-13; 1e-6 would have pinned a materially
wrong `r = 1.0000005`), fixed a sign bug in the exact reference (the
covariance sign was read from a double that underflows), and named the one
class the kernel does not cover: a pair at **subnormal** magnitude, whose
moments are genuinely unrepresentable, reads flat (`undefined`) even though
the dimensionless correlation exists. Stated on `correlation` and pinned as a
missing cell rather than engineered around — prices do not live at 1e-200.
Also noted, not changed: rejecting
`benchmark === column` is opinionated (`corr(x, x) = 1` is a valid identity);
kept because a consumer who wants the identity has it in one line and the
check catches the far more common copy-paste.

(1) **The comparison series is a `benchmark` COLUMN, not a second
`TimeSeries`, and this is the batch's load-bearing design choice.** Every study
here names its comparison series with a required column on the series it is
given — `beta(wide, { column: 'close', benchmark: 'spy', period: 60 })` — and
the consumer aligns and joins first (`series.align(seq)` +
`TimeSeries.joinMany([...], { type: 'inner' })`). It is the {@link atr} shape:
a study that reads several columns of one row.

What a second-`TimeSeries` signature would have cost is worth writing down,
because it is the obvious API and it is the wrong one. Two instruments have
their own bar clocks, holidays and halts, so `beta(bars, spy, …)` cannot avoid
**inventing an alignment policy**: hold or interpolate the stale side? inner or
outer join? whose timestamps win when a holiday differs? Each answer is a
parameter, each parameter is a second way to express something core already
expresses better (`align` takes a method and a sample point; `join` takes a
type and a conflict rule), and the study would apply it **per study** — so
`correlation` and `beta` over the same pair could silently disagree because
their alignment options drifted apart. It would also make every study
non-composable with the rest of the pipeline: the joined series is the thing a
caller wants to chart, resample and slice, and the two-series signature never
produces one. Pinned by a test that builds two series, joins them for real, and
asserts the studies give the same numbers as over a hand-built wide series —
"the join is transport, not semantics" — plus a second that runs an **outer**
join and shows the strict window blanking the one-sided rows, which is the
whole answer to "what does a missing benchmark bar mean".

The cost of the choice is one new validator: a `benchmark` (or `column`) that
is not on the series **throws**, where every other study in the package reads a
misnamed column as all-missing. That is deliberate — a required option whose
only job is to name a joined column has no honest all-missing reading — and it
settles for this family the reducer-dependent inconsistency the volatility tail
recorded as a carry-forward (`rollingValues` throws under `min`/`max`, answers
empty under `avg`/`stdev`). These studies read `columnValues` directly and
inherit neither door, so the answer is chosen here: **`assertColumn`, the
mirror of `assertNoColumn`, on `benchmark` only.** The first draft applied it
to `column` too; the Layer-2 review pointed out that made `correlation({
column: 'typo' })` the one study in the package that threw where `sma({
column: 'typo' })` reads empty, so `column` now follows its siblings. The
kernel-level question is still open.

(2) **`beta` takes prices and differences them inside; `correlation` does
not.** The asymmetry is TA-Lib's and it is documented rather than reconciled.
`CORREL` correlates the **raw inputs**, so a strong reading mostly says "both
trended"; `BETA` differences internally, so its input must be prices. Matching
both bar-for-bar means the two studies in the same batch disagree about what
their `column` is — and a `returns: boolean` flag on `correlation` was
rejected as two indicators behind a flag (the `keltner` precedent) that would
also break TA-Lib comparability. The return correlation is
`correlation(wide, { column: 'ret', benchmark: 'spyRet' })` after a
`percentChange` each side, and the docstring says so. `beta`'s returns are
`percentChangeValues(v, 1)` — the shipped ROC — so they are **percent**
returns, which cancels in `cov/var`.

(3) **TA-Lib's `BETA` argument order is a trap, measured.** `talib.BETA(a, b,
n)` returns `cov(rA, rB) / var(rA)`: it regresses its **second** input on its
**first**. So the call matching `beta({ column: 'close', benchmark: 'spy' })`
is `talib.BETA(spy, close, n)` — benchmark first — and that is what the
generator asserts against. A caller who passes `(stock, index)` gets the slope
of the index on the stock: on an affine pair, `BETA(x, 2x+5) = 0.952` where
`BETA(2x+5, x) = 1.050` (measured), a different number and not a different
sign, so nothing in the output announces the mistake. Pond's option names are
the fix: **`benchmark` is always the denominator**, and the generator's
separation assert measures 4.30 between the two directions so no fixture can
pin the wrong one.

(4) **`benchmark = 2·column + 5` gives correlation exactly `+1` and a beta
that is NOT 1** — the pair of assertions that keeps the two studies honest
about what they measure. Correlation is invariant to an affine transform of
either side; beta is a slope of **returns**, and an affine transform is not
return-preserving (`Δx/(2x+5)` against `Δx/x`), so it drifts with the price
level: measured `0.976` on a random walk near 100 at `period 5`. The
exactly-`1` pair for beta is a **pure scale**, `k·column`, and both are pinned.
The `−1` side of correlation is where the last decision fell out: on
`−3·column + 1000` one window reads `−1.0000000000000002`, two ulps past the
bound, while the `+1` side is bit-exact. The batch shipped **no `±1` clamp** —
it would remove 2e-16 no threshold can see, at the price of a branch to keep
alive. That was reversed in #707 (below): once the kernel rebuilds every
ill-conditioned window and is pinned to an exact reference, the only
overshoot left is rounding, and `correlation` now pins `|r|` to 1 for it.

(5) **The kernel is the numerics decision, and the naive form is not merely
less accurate — it returns a negative variance.** `rollingBivariateValues`
carries `covariance`, `varianceX` and `varianceY` from one pass, in the
**shifted frame** (`x − anchor`, anchored on the first complete pair in the
window) with **Welford / co-moment** updates and the **aligned rebuild every
`period` rows** — [PND-SHIFTFRAME] and [PND-PROCKERN] applied to a bivariate
accumulator. Explicitly not `Σxy − ΣxΣy/n`, and the measurement is the
argument. Worst absolute error in the resulting **correlation coefficient**
over 200k rows at `period 30`, against a per-window two-pass reference:

| input                          | naive `Σxy − ΣxΣy/n` | this    |
| ------------------------------ | -------------------- | ------- |
| random walk ≈100               | 7.4e-7               | 1.7e-14 |
| prices ≈1e6 with ±3 structure  | 1.2e-2               | 2.1e-15 |
| prices ≈1e12 with ±3 structure | **`Infinity`**       | 2.4e-15 |

At 1e12 the naive variance goes negative, so its `sqrt` is `NaN` and the
reading is non-finite — the failure is loud rather than subtle, but only if
someone runs it at that magnitude. A first version of the probe accused the
**kernel** instead, because its "reference" computed the window mean as
`Σx / n` on raw 1e12 values and was itself the ill-conditioned party; the
reference now shifts by the window's own first value, and both the probe and
that lesson are in `test/bivariate-kernel.test.ts`.

(6) **The window is STRICT — all `period` rows of BOTH columns — and that is
the third window rule in the package.** Core's count-window reducers emit over
`period` **rows**, skipping gaps (right for an extreme: `highestLowestValues`);
`rollingMeanValues`' array door waits for `period` finite **values** (right for
a mean); this waits for `period` complete **pairs**. The argument is the same
one the array door makes, one step further: a thirty-bar correlation computed
from three pairs is not the statistic `period` named, and — worse — it would be
computed from a _different_ set of pairs than the caller's other column-pair
study saw. The visible consequence is that an **outer join's one-sided rows
blank**, which is the honest answer and is pinned as such.

(7) **A flat window needs no guard, and the reason is exact arithmetic rather
than a precedent.** Applying the #699 test (is the numerator forced to zero?):
if one column is constant, its centred deviations are **exactly** zero, so the
co-moment update `cxy += dx·(v − my)` adds exactly zero and the removal
subtracts exactly zero. The covariance comes back as an exact `0` beside a
variance of exact `0`, so `correlation` and `beta` are already a genuine `0/0`
→ `NaN` → a missing cell with no branch written. Pinned at the **kernel** with
`toBe(0)` rather than `toBeCloseTo`, because a residue there would turn both
studies' `0/0` into a `±Infinity` that `withColumn` throws on. `priceRelative`
is the contrast that makes the rule visible in one batch: its numerator is
**not** forced to zero, its division is the study's last step, so its
`benchmark === 0` guard is live and mutation-killed — the #703 rule (a guard at
the output is load-bearing) with both cases side by side.

TA-Lib disagrees on both, and it is measured rather than assumed: `CORREL` over
a constant input returns `0.0`, and `BETA` over a constant first input returns
`0.0`. Reporting `0` would claim "uncorrelated" from data that cannot support
the claim, so this is the batch's one deliberate value delta, stated on both
docstrings and in the fixture's conventions block. The second delta is the
same shape: TA-Lib substitutes a return of `0` for a zero previous price, where
`percentChangeValues` marks it missing (measured — on a ramp with one zeroed
bar TA-Lib emits `4.6e-07`, `-3.0e-05`, `-6.0e-05`, `-1.2e-02` across the four
bars this study blanks). Note the asymmetry a test caught: a **zero** price
costs exactly one return, the one _after_ it, because the return _into_ a zero
is a legitimate `−100%`; a **missing** price costs two.

(8) **`performanceIndex` is F-AMBIG and the fork is named, including the one
this does not ship.** What ships is the **look-back ratio** — each side's own
`period`-bar growth, divided, `1` = parity — because `(perf − 1) × 100` is
`percentChange(priceRelative, period)` **identically** (asserted in the
generator to 3.3e-14 and by a test), which makes it the missing normalisation
of the family rather than new math. Trading Technologies publishes a
**different** formula under the same name — `PI = (close/benchmark) ×
(MA(benchmark)/MA(close))`, a moving-average baseline instead of a lagged one
(<https://library.tradingtechnologies.com/trade/chrt-ti-performance-index.html>)
— and that variant is deliberately **not** shipped: it is already a composition
of two shipped primitives (`priceRelative` and any MA), whereas the look-back
form was the gap. The `× 100` and `− 1` scalings are presentation forks and are
spelled out on the docstring; the ratio ships so the two lines in this family
(`priceRelative` and this) read on the same kind of axis. **This is the one
place a reviewer should push back if they disagree** — the corpus entry came
from a vendor menu with the note "normalized relative performance" and no
formula, so the definition is pinned by argument rather than by source.

(9) **`priceRelative` says loudly what it is not.** ChartIQ lists _Price
Relative_ and _Relative Strength (comparative)_ separately and they are one
implementation, which ships under the unambiguous name; neither is Wilder's
**Relative Strength Index**. The docstring says so in a heading, because the
name collision is the most common confusion in the corpus and a caller who
reaches for "relative strength" and gets an unbounded ratio needs to be told
why in the place they are already reading.

Perf at 1M bars (medians of 5, run twice): `performanceIndex` 25–27 ms,
`priceRelative` 33–35 ms, `correlation` **61–74 ms at `period 30` and 60–64 ms
at `period 200`** — flat in `period`, as the amortised rebuild requires —
`beta` 75–79 ms (the same kernel plus two rate-of-change passes), and the bare
`rollingBivariateValues` 38–43 ms at both periods. Against `ema` 11–13 ms,
`sma` 36 ms, `rsi` 51 ms, `bollinger` 107–109 ms and `donchian` 235–240 ms on
the same runs: the bivariate kernel costs roughly one `sma` more than a
`Float64Array` floor and lands **below** `bollinger`, which is the right
neighbourhood — Bollinger is the other two-moment window study and it also
builds a series.

**Mutation matrix**: 28 mutations, one per shipped decision (the strict
window, `ddof`, the shifted frame, the rebuild, the co-moment pairing, each
default, each threshold, the `sqrt`, each denominator, the returns, each of
four zero guards, `assertColumn`). Killed-test counts ranged from 1 (a changed
default `period`, which only the defaults test reads) to 14 (`beta`'s
denominator swapped to the source's variance). **One survivor, and it is
inherent rather than a missing test**: `performanceIndex`'s warm-up. An
out-of-range look-back on a `Float64Array` reads `undefined`, whose arithmetic
is already `NaN`, so no input can distinguish a warm-up guard from its absence
(`percentChangeValues` has the same property). It was restructured from an
`if (i < period) continue` into the **loop bound** so that nothing in the file
looks like a live guard, and the redundancy is stated in a comment rather than
tested.

**Considered and not built**: a second-`TimeSeries` signature on any of the
four (decision 1); a `returns: boolean` on `correlation` (decision 2); a `±1`
clamp (decision 4); an `maType` variant of `performanceIndex` (decision 8); a
`covariance` study of its own (the kernel is exported, and a named study for a
dimensioned quantity nobody charts is vocabulary without a consumer); and
fixing the `rollingValues` misnamed-column asymmetry, which this batch settles
only for its own studies and leaves as the kernel-level carry-forward the
volatility tail recorded.

**Landed — the state machines (Phase 3, K6).** The kernel the corpus
assessment's **G2** names, plus its six first consumers: `parabolicSar`,
`superTrend`, `atrTrailingStop`, `negativeVolumeIndex`, `positiveVolumeIndex`
and `klinger`. This is the first group whose value on bar `i` is not a
function of a bounded window, so the interesting decisions are all about
_state_, not arithmetic. Decisions:

(1) **The kernel is a loop and a gap rule, and nothing else.** `foldRows(
inputs, outputCount, state, step)` walks the rows, tests every input cell for
`NaN`, and calls `step(state, i, run, inputs, outputs)` on the complete ones,
where `run` counts how many _consecutive_ complete rows end at `i`. The first
draft had an `init` / `seed` / `step` triple; `run` collapses it, because a
machine that seeds off one bar branches on `run === 1` and one that needs a
predecessor (SAR reads bar `i−1`) branches on `run === 2` and lets `run === 1`
fall through to the `NaN` the outputs already hold. The kernel also **owns the
allocation**, NaN-filled — the warm-up and the gap rule are the same fill, and
a study allocating its own buffers would silently publish `0` (a price) for
both. The step takes everything explicitly rather than closing over it, so it
is a top-level, unit-testable function with no closure on the hot path; the
study's configuration rides in the same typed state object as its carried
fields (`readonly` versus mutable is the distinction).

(2) **A missing cell RESETS the machine — and the alternative is the one that
loses.** The two honest answers are (a) reset (emit `undefined` for the
incomplete bar, re-seed from the next complete one) and (b) hold (emit
`undefined` but carry the state across). We ship (a). Ask what the _true_
answer is: a Parabolic SAR that did not see a bar cannot know whether it
flipped — the missing bar might have printed a new extreme (advancing the
acceleration factor), penetrated the stop (reversing the side and resetting
the factor), or neither, and nothing in the surrounding bars distinguishes
those. (b) would resume with a side, an extreme point and a factor that are
**not** what the definition says, and because the machine is a recursion the
error never washes out — a stop carried on the wrong side stays wrong until
the next genuine reversal. (a) throws away real information but everything it
then emits is exactly what the definition says, computed from bars the machine
saw. (b) trades a visible absence for an invisible lie, which is the trade
this package never takes.

The asymmetry with `wilderValues`, which **propagates to the end** instead, is
stated rather than reconciled, and the difference is the cost of a seed:
Wilder's is the mean of `period` bars, so a mid-series restart would silently
restate what "a 14-bar average" means there; a K6 seed is one or two bars,
which is exactly what a chart does when a halted instrument resumes. The
practical consequence is that the reset is only _visible_ for the machines
reading raw columns — `parabolicSar`, `negativeVolumeIndex`,
`positiveVolumeIndex` — because `superTrend` and `atrTrailingStop` read
`atrValues`, whose own interior-gap rule leaves every later row incomplete
before the reset can fire. Documented per study rather than averaged into a
slogan.

(3) **What a core `foldRows` would need that this one does not.** Promoting
this to core (`scanRows` / `foldEvents`, the G2 ask) needs four things the
library kernel is free to skip. **A typed row view**, since core cannot hand a
study a positional `Float64Array[]` and expect the caller to remember which
index is `low` — it would want `{ high, low, … }` narrowed by the schema, and
the cost of materialising one per row is exactly the `Event` allocation
`readNumericColumn` exists to avoid, so it would need the columnar-cursor
treatment `rolling`'s fast path already has. **A declared output schema**, so
the result is a `TimeSeries` rather than arrays a study has to `withColumn`
back on. **A missing-cell POLICY rather than a rule** — core has no business
deciding that a gap resets a caller's machine, so the reset/hold/propagate
choice becomes an option, and the honest default for a general operator is
probably `propagate` (the conservative one), with `reset` an opt-in the
financial studies would pass. And **a live counterpart**: the whole point of a
core primitive is that `LiveSeries` gets it too, and a fold whose state is
per-partition needs the factory-based per-partition state pattern
(`ARCHITECTURE.md`) rather than one object. None of the four is needed by six
batch studies, which is why the kernel stays in the package (exported from
`@pond-ts/financial` like the other kernels, not promoted to core); the shape
is now proven
and the promotion is a decision with evidence rather than a guess.

(4) **`${prefix}` + `${prefix}Trend`, and why the value column is bare.**
The three stop machines each emit two columns: the value under the **bare**
prefix and a `+1` / `−1` side. Bare rather than `${prefix}Line` (the `macd`
precedent) because MACD's three columns are three peers with no principal
among them, whereas a SAR _is_ one number and the trend annotates it — naming
the value `psarLine` would make this the one study whose principal output is
not reachable under the name the caller passed, and `psar()` would leave no
column called `psar`. The **side is a separate column rather than a derivation**
because it is genuinely not recoverable: all three clamp, so the stop can
print exactly _on_ an extreme (`min(sar, prevLow, low)`) or exactly on the
close (`atr = 0`), and `psar < low` would then draw the dot on the wrong side.
`+1` always means "the line sits below price", which is the opposite sign to
TradingView's `ta.supertrend` (its `direction := 1` is a downtrend) — the
delta is documented on the study.

(5) **SuperTrend ships the line and the side, not the bands.** `st` already
_is_ whichever final band is live, so the only thing `${prefix}Upper` /
`${prefix}Lower` would add is the **inactive** band, which no published
SuperTrend chart draws and which is an artefact of the ratchet's bookkeeping —
freezing it in the schema would make the study's contract wider than its
definition. Two columns until a documented consumer needs four.

(6) **`atrTrailingStop` is close-anchored, and the Chandelier is named, not a
knob.** Two families circulate under names this close together, so the choice
is explicit: the shipped form measures the band from the **close**
(Vervoort's, the form TradingView's ATR Trailing Stop / "UT Bot" scripts
implement), and Chuck LeBeau's **Chandelier Exit** measures it from the
rolling extreme instead. An `anchor: 'close' | 'extreme'` option was
considered and rejected — the two differ in more than one place (the extreme
form also has its own warm-up and a conventionally different flip test), so
the knob would be two studies wearing one name. The Chandelier is a
composition away (`donchian` supplies both extremes, `atr` the width).

(7) **Klinger ships the original, and the fork is named.** `F-AMBIG` in the
assessment, and it earns it. The volume force is
`volume × |2 × (dm/cm − 1)| × trend × 100` with `dm = high − low` and `cm`
accumulating `dm` over the trend leg (re-based on `dm[i−1] + dm[i]` when the
trend turns, which is also the seed) — Klinger's own, as StockCharts
documents it. The reading taken is `2 × ((dm/cm) − 1)` under the modulus, not
`2 × (dm/cm) − 1`; the oracle separates them (measured `4.0e+04` apart at the
defaults on an oscillator spanning `1.3e+05`). TradingView's `ta.kvo`, which
drops the `dm/cm` factor entirely and is just an EMA-pair oscillator of signed
volume, is documented as a **different indicator sharing the name** rather
than offered as a `variant` — a knob would hide that.

(8) **NVI/PVI: a flat volume holds on both, and the reset re-bases.** Fosback
compares strictly in each direction, so an unchanged volume is neither a
down-volume nor an up-volume bar and the two indices do **not** partition the
tape — the obvious `<` / `>=` implementation gives PVI a bar Fosback does not.
The K6 reset is most visible here: an interior gap re-bases the index at
`start` on the next complete bar, which is a deliberate difference from `obv`,
which propagates to the end. The difference is what the level _means_ — OBV
accumulates volume, a quantity with units where the distance between two
points is the reading, so a hole makes every later level wrong; NVI compounds
returns from an arbitrary base, so re-basing loses only the base.

**Deltas and measurements** (every number re-run from
`scratchpad/sfold-*.py`, cited in the commit message): `parabolicSar` is
**exactly** TA-Lib `SAR` (`0.0` maximum absolute difference at `(0.02, 0.2)`,
`(0.05, 0.5)` and `(0.01, 0.1)` over the oracle's 80 bars, masks identical),
with the `−DM` seed probed against TA-Lib on a short-opening 7-bar fixture
that a forced-long seed gets wrong. TA-Lib **has no gap semantics at all** —
measured on an interior hole it emits a full column of numbers with no gap in
it, because its comparisons against `NaN` are all false; ours resets, which is
the one deliberate delta. The other four have no TA-Lib function and are
pandas replications with the analytic first valid bar asserted and a
**separation** case against the nearby misreading in each case.

One separation could **not** be built, and the finding is worth keeping:
SuperTrend's "flip on the previous final band instead of the just-ratcheted
one" is **unobservable** whenever the close sits inside its own bar and
`multiplier ≥ 1`. While the side is up the lower band only ratchets up, so the
two readings differ only when `prevLower ≤ close < basicLower`, and
`close < basicLower` needs `multiplier · ATR < mid − close ≤ (high − low)/2`,
which the ATR bounds out. Measured `0.0` apart across every
`period 2..20 × multiplier 0.2..4.0` pair on the fixture; the generator
asserts the **equality**, so a future fixture that does separate them fails
loudly rather than leaving the claim stale.

**Perf** (1M bars, `scripts/perf-studies.mjs`; `ema()` reads 6.29 ms and
`sma()` 20.60 ms on the same run): the bare two-column fold over a no-op step
is **11.32 ms**, 1.8× `ema()`, against a **5.20 ms** floor for the same NaN
scan written inline with no callback — so the per-row indirect call is ~6 ms
per million rows and is the design (one shared loop; no study owns a loop).
A 1–4-column specialisation with hoisted locals was written and measured: 35%
at `k = 1` (which no study uses), **4% at `k = 2` and nothing at `k = 4`**, so
it was not landed. The studies then pay the package's usual column plumbing:
`parabolicSar` 41.9 ms, `superTrend` 61.4 ms, `atrTrailingStop` 49.0 ms,
`negativeVolumeIndex` 31.3 ms, `klinger` 73.2 ms — all in line with
`atrBands` (40.4 ms) and `macd` (68.1 ms) for the same output-column count.

**Mutation matrix**: 24 mutations across the kernel and the six studies, **all
killed** (1–48 failing tests each) after three rounds of test additions. The
first round left seven survivors and each one was a real gap: the oracle input
and the unit fixture both happen to open **long**, so nothing tested the `−DM`
seed; nothing exercised the three tie-breaks (`low ≤ sar`,
`not (close < lower)`, the ATS `otherwise` branch); and the NVI zero-base
guard was only reached on a path where the level was already `0`, so removing
it changed nothing. That last one also found its twin: **Klinger's `cm === 0`
guard was genuinely dead** — `cm` is a sum of non-negative ranges, so a zero
`cm` forces a zero `dm` and the ratio is `0/0 = NaN` on its own — and it was
**deleted** rather than tested, per the volatility tail's rule.

**Considered and not built**: a separate `seed`/`init` hook on the kernel
(decision 1); the hold-across-a-gap rule (2); a core `scanRows` now (3); a
`${prefix}Dir` third column or a sign-encoded single column on the stop
machines (4); SuperTrend's two band columns (5); an `anchor` knob on
`atrTrailingStop` (6); a `variant` knob on `klinger` (7); a `SAREXT` case
(its offset-on-reverse and per-side acceleration parameters are a different
function with a signed output convention); and the fold-loop specialisation
the bench did not justify.

**Landed — the moving-average stacks and smoothed-momentum tail (§6.1/§6.3).**
`guppy`, `rainbow`, `rainbowOscillator`, `kst`, `priceMomentumOscillator`,
`stochasticRsi`, `trueStrengthIndex` and `movingAverageDeviation` — eight
studies (twelve, ten and three columns among them), plus two kernel additions
the studies earned. Fifteen oracle cases; 149 in the fixture. Decisions:

(1) **Two fixed-parameter stacks, and neither gets a "which periods" option.**
`guppy` is Daryl Guppy's twelve EMAs (short 3/5/8/10/12/15 as `gmmaS{n}`, long
30/35/40/45/50/60 as `gmmaL{n}`); `rainbow` is Mel Widner's ten **recursive**
averages, each smoothing the previous. The twelve and the ten _are_ the
studies: an option would make each a generic stack-of-averages wearing a
name, so a chart legend reading "GMMA" would mean nothing without the call
site beside it. What ships instead is the period lists as exports
(`GUPPY_SHORT_PERIODS` / `GUPPY_LONG_PERIODS`) so a chart can label the ribbon,
and the observation that a caller who wants their own stack has
`movingAverage` with their own `output` names. The same reasoning covers
`kst`'s twelve constants and the PMO's four — see (4).

The one knob that _is_ vendor-compatible on both is which average, so both
take the K2 `MaType` menu. **They spell it `type`, not `maType`** — the
appended columns _are_ the moving averages, as `movingAverage`'s are, and
`maType` stays the spelling where an average is an _ingredient_
(`keltner`, `disparityIndex`, `envelope`, and this batch's
`movingAverageDeviation`). That is a new split: before this batch,
`movingAverage` was the only study using `type` and every other used `maType`.
Flagged for review rather than assumed.

(2) **The EMA-seed check needed a new form, because the fixture is 80 bars and
`guppy` reaches back 60.** The MA family's rule — rebuild the formula on
TA-Lib's SMA seed exactly, then require pond's first-sample transient to have
decayed under 0.5% of scale over the last 20 shared bars — is unusable at
`period 60`: only 21 bars are shared and the worst last-bar residue across the
twelve is still **0.367%**, with no room left to decay. The replacement is an
exact statement rather than a looser bound: two EMAs over the same input with
the same `α` and different seeds satisfy the same recursion, so their
difference is **exactly geometric**, `d[k] = d[0]·(1−α)^k`. Measured, the
relative residue from that curve is 1e-14…1e-12 for the correct rate and
**3.15** (n=15) / **0.459** (n=30) for a `2/n` rate — twelve orders of
magnitude of separation, and it makes no claim about how far the transient has
got. `_ema_seed_is_geometric` in the generator; available to any future
EMA-family study whose warm-up crowds the fixture.

(3) **`rainbowOscillator` is F-AMBIG, so the source is named and the
alternatives are measured.** ChartIQ's definition ships:
`100·(price − mean of the ten)/(HH − LL)` over `lookback` bars of the source
column, with `±100·(max − min of the ten)/(HH − LL)` as mirrored bands. The
divide-by-**price** variant sits **67.27** away and a first-average numerator
**49.16**, on a reading that spans −68.6…63.8 — both the size of the reading
itself, so the generator asserts the separation.

Its flat-window rule is where the brief's "apply the test, don't copy the
precedent" earned its keep, and the first draft got it wrong in an
instructive way. A flat `lookback` window is `undefined` — but **not** because
it is a `0/0`. The stack reaches back past the `lookback` window, so the
numerators are not forced to zero: on a series that rises then holds a level,
the stack's mean is **>10 points** from the flat level at `lookback: 3`, and
even at the default `lookback: 10`, where the stack has nearly caught up, it
is still **0.0044** away. That is a real number over zero — an infinity, not a
`0/0` — which is a _stronger_ reason for `undefined`. The first test asserted
the residue was >1 at the default look-back and **failed at 0.0044**; the
claim was wrong, the conclusion was not, and both measurements are now pinned
by tests because the "it converges, so it is really 0/0" intuition is exactly
what would talk someone into returning `0`.

(4) **Three studies with (almost) no options, and one asymmetry.** `kst`
exposes only `column` / `prefix` / `signalPeriod` — Pring published _several_
KSTs (short daily, weekly, monthly) and they are different indicators, not one
with parameters; `priceMomentumOscillator` exposes only `column` / `prefix`.
The asymmetry is deliberate and named on both docstrings: `signalPeriod` is
exposed on `kst` because vendors genuinely differ on it, and not on the PMO
because DecisionPoint's 10 is not contested. A caller wanting another
parameterisation composes it from shipped primitives, which is four lines and
honest about not being the named study.

(5) **The PMO forced the K2 engine's one non-span exponential, and the kernel
door is the smallest possible.** DecisionPoint's "custom smoothing" is
`α = 2/n`, not the span EMA's `2/(n+1)` — a different **rate**, not a
different seed, so it cannot be expressed as a span. Measured on the oracle
input, building both PMO stages on the span EMA instead puts the line
**0.1060** away on a reading whose scale is **3.9058** (2.71%). So
`kernels/moving-average.ts` gained `alphaEmaValues(values, alpha, minSamples)`
and the engine's private `emaArrayValues` became
`alphaEmaValues(v, 2/(n+1), n)` — one recursion, one seed rule, `α` supplied
rather than derived. It is **not exported from the barrel**: a span is the
vocabulary every other consumer should speak, and a study choosing its own
`α` is exactly the private smoother the engine exists to prevent.

Two more PMO facts worth keeping: its **signal is a plain span `EMA(10)`**,
not a custom-smoothed one (DecisionPoint's own asymmetry — a custom-smoothed
signal sits **0.0883** away), and the **×10 placement is immaterial** because
every stage is homogeneous (before / between / after agree to **8.9e-16**), so
the generator asserts _agreement_ there rather than separation.

(6) **`stochasticRsi` needed a strict rolling-extremes kernel, and the oracle
found the bug.** `highestLowestValues` composes on core's reducers and
therefore **skips** a missing cell — right for a bar's high and low, which
have no warm-up; wrong for a derived input. The RSI's first `rsiPeriod` rows
are missing, so the skipping door emitted a "14-bar range of the RSI"
computed from **two** values as soon as two existed, putting `%K` on bar
**17** instead of **29** and disagreeing with `talib.STOCHRSI`. The fix is
`rollingExtremesValues(values, period)` in `kernels/highest-lowest.ts`:
`rollingMeanValues`' strict rule applied to an extreme, via two monotonic
deques (O(N), flat in `period`, the `barsSinceExtremeValues` structure).
Internal, not exported.

Its `Number.isFinite` guard on the push is **redundant and stays anyway** —
the `missing` counter already carries the whole rule, so mutating the guard
away fails **zero** tests (measured). It preserves the deque's _invariant_
(candidates strictly monotonic, no `NaN`s interleaved) rather than its answer,
which is the same reason `barsSinceExtremeValues` carries it; the docstring
says so, so the surviving mutation reads as a decision rather than an untested
branch.

(7) **TA-Lib's `STOCHRSI` returns `fastk`/`fastd`, not `%K`/`%D`, so the
mapping is measured rather than assumed.** `stochRsiK` **is** TA-Lib's
`fastd` (bar for bar, 9.9e-14, identical masks); the raw unsmoothed position,
which the study does not emit, is its `fastk`; `stochRsiD` has **no** TA-Lib
counterpart. Crossing the columns is a **45-point** error on the fixture, so
the generator asserts the mismatch as well as the match — a case that only
checked "close to something TA-Lib returns" would pass on the wrong column.

The cost is a genuine name clash, documented rather than resolved: the option
names are TradingView's, so **`stochPeriod` here is `stochastic`'s `kPeriod`
and `kPeriod` here is its `slowing`**. A three-way mapping table sits on the
docstring. Each study speaking its own vendor's vocabulary is defensible; a
reviewer may reasonably prefer one vocabulary across both.

(8) **`trueStrengthIndex` deleted a zero-denominator guard the first draft
wrote**, which is #703's rule reaching a different conclusion than usual. The
division _is_ at the output, which is normally what makes such a guard live —
but the denominator is an EMA of absolute changes, so it is zero only on a
perfectly flat column, and then `|num| ≤ den` forces the numerator to zero
too. The division is a literal `0/0`, already `NaN`, already a missing cell.
The mutation matrix showed the guard failing **zero** tests, so it went. Its
options are also `longPeriod` / `shortPeriod` rather than the corpus'
`long` / `short`: bare "long" is _position_ vocabulary in a financial package.

(9) **`movingAverageDeviation` ships the points form ONLY, and that is a
step-0 finding with a measurement behind it.** The corpus lists it as "points
or percent"; the percent form is already shipped as `disparityIndex`, and
`100·maDev/MA` and `disparity` agree **bit for bit** (`0.0`, not "to
rounding") at both `(20, sma)` and `(14, ema)` — asserted in the generator. A
`mode` flag would therefore be two indicators behind an option, one of them a
duplicate export: the `keltner` precedent. The two studies are now a pair that
point at each other, and `disparityIndex`'s own docstring was corrected — it
had declined the absolute form as "`momentum`-shaped arithmetic anyone can
write", which is not quite right (`momentum` subtracts a _lagged_ price, this
a _smoothed_ one, measured 8.36 apart at `period 20`).

(10) **Perf: the new studies' 1M-bar medians, and an honest note about what
the before/after could not measure.** All from
`scripts/perf-studies.mjs` at 1M rows, against `sma()` 21.2 ms, `ema()`
6.6 ms, `bollinger()` 75.0 ms and `stochastic()` 192.9 ms on the same run:

| study                                   | 1M median |
| --------------------------------------- | --------- |
| `guppy({ type: 'ema' })`                | 189.8 ms  |
| `guppy({ type: 'sma' })`                | 258.6 ms  |
| `rainbow({ period: 2 })`                | 230.7 ms  |
| `rainbowOscillator({ 2, 10 })`          | 344.1 ms  |
| `kst()`                                 | 125.6 ms  |
| `priceMomentumOscillator()`             | 28.7 ms   |
| `stochasticRsi({ 14, 14, 3, 3 })`       | 119.5 ms  |
| `stochasticRsi({ stochPeriod: 200 })`   | 119.5 ms  |
| `trueStrengthIndex({ 25, 13, 7 })`      | 38.6 ms   |
| `movingAverageDeviation({ 20, 'sma' })` | 24.6 ms   |

The two `stochasticRsi` rows are the point of that pair: identical to the
reported precision at `period 14` and `period 200`, which is the monotonic
deque being flat in `period`. `guppy` reads as roughly twelve engine calls
plus twelve column appends, `rainbow` as ten chained array passes.

**The study-level before/after for the `alphaEmaValues` refactor is not
reportable on this runner.** Both sweeps were run (main's kernel with a
standalone shim, then the refactor), and benchmarks the change _cannot touch_
moved by −41% (`priceVolumeTrend`) and +43% (`movingAverage kama`) between
them — the noise band swamps the signal. What _is_ measurable is the change
in isolation: an interleaved micro-benchmark of the two forms over the same
1M array (`scratchpad/stacks-perf-alpha.mjs`) puts the delegating form
**12–14% above** the inlined one, **4.1–4.8 ms → 4.6–5.3 ms**, i.e. about
**+0.55 ms per 1M rows** — ~3% of `movingAverage({ 20, 'ema' })`'s 16 ms.
The first version of that benchmark ran the two forms in sequence and read a
**160%** difference that was entirely allocation ordering; alternating which
form goes first per iteration removed it. Duplicating the recursion instead
of delegating would recover the 0.55 ms and was rejected: a second copy of
the engine's EMA is precisely what the engine exists to prevent.

**Landed — the momentum and trend leftovers (§6.3/§6.4).**
`stochasticMomentumIndex`, `fisherTransform`, `schaffTrendCycle`,
`prettyGoodOscillator`, `swingIndex`, `accumulativeSwingIndex`,
`randomWalkIndex`, `ravi`, `trendIntensityIndex` and `specialK` — ten studies,
plus two internal kernels (`swingIndexValues`, `randomWalkValues`) and a
second, longer oracle input. Eighteen oracle cases; 177 in the fixture.
Decisions:

(1) **The oracle grew a second input, and it was Special K that forced it.**
Pring's Special K first prints on bar **724** (a 530-bar rate of change
smoothed over 195) and the fixture is 80 bars, so a case on it would have been
entirely `null` and would have passed **vacuously** — the exact failure mode
the "a name mismatch reads all-null and the test passes vacuously" note in the
studies README warns about, arrived at from a different direction. The fix is
a separate `longCloses` array of 900 bars in `input`, with cases carrying
`"input": "long"` and the vitest side building a close-only series from it;
extending `closes` instead would have recomputed all 159 existing cases and
turned a ten-study addition into a whole-fixture diff. Four other cases moved
onto it once it existed, and each move is a finding rather than a convenience:
**TII** at Pee's own 30/60 needs 89 bars; **STC** at Schaff's 23/50/10 has six
values on 80 bars and every one of them is exactly 0; **RAVI** at Chande's
7/65 has sixteen, over which the fast average never once crosses below the
slow one — so the **absolute value, which is the whole study**, would have
been untested. The long series' drift is deliberately slight (0.01/bar against
the short one's 0.15): at a 0.05 drift all twelve Special K terms are positive
at once and the line runs 151.5…379.3 without ever crossing zero (measured).
Three asserts in the generator hold all of that if the series ever changes.

(2) **`swingIndex`'s `limit` is REQUIRED — the second required option in the
package, after `benchmark`.** Wilder's `T` is the instrument's daily limit
move: a fact about the contract, not about the study, and the ±100 bound the
index is _defined_ by depends on it. Every candidate default is wrong in a way
that does not announce itself — `1` (what several charting packages ship)
rescales the reading by the instrument's price level, so two symbols' swing
indices stop being comparable, and "the bar's own range" makes `K/limit` a
ratio of two quantities that both move with volatility, i.e. a different
indicator wearing this one's name. So it follows `correlation`'s `benchmark`
precedent: the one number only the caller knows, named rather than guessed,
with the docstring telling an equities caller that passing a typical daily
range _is_ the choice they are making. `0`, negative and non-finite are
rejected. The property tests carry the consequence: the study is
scale-**equivariant**, and invariant only when `limit` scales too — a build
that dropped the `K/limit` factor would be scale-invariant, which is what
makes the pair a test rather than decoration.

(3) **The Schaff Trend Cycle's flat window is a sharp edge, not a corner
case, and the package's rule bites visibly.** The common TradingView port
writes `nz(frac[1])` on a flat stochastic window — it repeats the previous
reading as if it had been observed. This package does not, anywhere:
`percentOfRangeValues` owns the rule and a flat window is `undefined`. What
that costs here is worth recording, because it is not hypothetical: a
sustained trend pins the **first** stochastic at 100 for `cyclePeriod` bars,
the `0.5` smoothing of a constant is that constant, so the **second** window
is exactly flat and the line goes missing during the strongest part of the
move. On the package's own 80-bar oracle input at the defaults the MACD rises
monotonically for sixteen bars and the line starts at bar **74** rather than
the analytic **67** — so the generator asserts the analytic bar as a _lower
bound_ plus a proof that every null past it really is a flat second window,
rather than an equality that would have had to be fudged. Considered and
rejected: holding the previous value for this one study, which would have
made it the only place in the package that reports a position in a range with
no positions in it.

(4) **The Random Walk Index is the G2 shape, and it ships O(N·period)
knowingly.** Its reducer needs a _different_ rolling statistic at every
horizon inside the window — `meanTR(n)` for each `n` in `2 … period` — which
none of `rollingValues`, `rollingExtremesValues` or `foldRows` can express.
The one-`ATR(period)`-for-every-horizon shortcut is a **different indicator**,
not an optimisation: it drops the `n`-specific volatility estimate that makes
the `√n` comparison mean anything. So the sweep lives in
`kernels/random-walk.ts`, folding one horizon at a time so that memory stays
O(N) whatever `period` is, and the cost is documented rather than hidden —
328 ms at `period 14` and 1194 ms at `period 50` on 1M bars, i.e. ~25 ms per
horizon at both, with the two entries kept side by side in the bench so the
linearity stays visible. The denominator is the `n`-bar **mean** true range
rather than Wilder's ATR, on Poulos' own words and on the structural argument
that `√n` is a claim about `n` independent steps; the Wilder variant is
measured (0.190 apart at `period 14`) and its separation **shrinks with
`period`** (0.031 at 30), because the recursion and the mean converge — so it
is the short horizons where the choice shows. Also worth stating plainly, and
missed by the "distance travelled" description: both columns go **negative**
when every horizon fell.

(5) **Three F-AMBIG forks, each named and measured.** `prettyGoodOscillator`
ships Mark Johnson's span-EMA-of-true-range denominator; the Wilder-`ATR` port
is 0.211 away at `period 14` (and 0.084 at 5, the harder case, which is why
both are asserted). `trendIntensityIndex` ships M. H. Pee's **sums** of
deviations rather than the common **count** of positive ones — the sum form is
weighted by how far price strayed, which is the "intensity" the name refers
to, and the count form is 28.85 away. `ravi` ships Chande's 7/65 and his
**absolute value**: the signed form is 26.98 away on a reading whose own range
is 0…16.40, i.e. more than the whole scale, because it goes negative where
this one does not. `stochasticMomentumIndex` is a fourth in substance if not
in the corpus' flag list: Blau's `(13, 25, 2)` ship and the short `(5, 3, 3)`
fork sits 108.99 away.

(6) **`undefined` for a `0/0` needed a sharper test than "is the numerator
forced to zero", and TII is where it got one.** #699's rule says a forced-zero
numerator makes the value `0` (a flat bar's close location) rather than
missing (a stochastic's flat window). TII's denominator is `Σ|dev|`, so a zero
denominator forces `Σpos = 0` **unconditionally** — there is no
redirected-column escape, unlike every other study in this batch. It still
reads `undefined`, and the reason is the refinement: a forced zero is
necessary but not sufficient, because the answer also has to be _determined_.
Here it is not — the ratio approaches 100 from a run of tiny positive
deviations and 0 from tiny negative ones — so `0` would read "every deviation
was negative", which is exactly what did not happen. `clvValues`' flat bar is
the contrasting case, where `0` genuinely is the limit from either side. The
same test settles `swingIndex`'s `R = 0` (`K` is zero on the same bars, so the
expression is `0/0` however it is grouped) and, from the other side,
`randomWalkIndex`'s zero denominator (`low[i−n]` sits outside the true-range
window and is not forced to match today's high, so it is a real number over
zero).

(7) **A zero-denominator guard is only live if a test can reach it with a
non-zero numerator — and three of ours could not.** The first mutation matrix
had five survivors; two were provable and three were bad tests. `ravi`'s guard
test used `[-1, 1, -1, 1]`, where the **short** average is zero too, so the
division was a `0/0` and read `undefined` with or without the guard; the same
for `randomWalkIndex` on an all-flat series and for `stochasticMomentumIndex`,
whose redirected-`close` fixture was only twelve bars long against a 24-bar
default warm-up, so the guard was never reached at all. Each now uses a
fixture where the numerator is genuinely non-zero over a zero denominator
(`[4, −6, 1, 1]`; a wide first bar closing on its own low, then a frozen tape;
short periods on the flat series). The distinction matters more here than
#703's dead-guard rule suggests, because `withColumn` **throws** on a
non-finite cell rather than recording it (measured) — an unguarded division
would not mislead, it would take the study down.

(8) **Two mutations survive by proof, and both are recorded in the kernel.**
`swingIndexValues`' three `R` branches are tried `A`, `B`, `D`, and swapping
the first two changes no output: `A = B` forces either `t = 0` or `H = L`, and
in both cases `A − 0.5·B = B − 0.5·A`. `randomWalkValues`' `i < n` half of its
`blank` test is redundant because `meanTR(n)` is strict and therefore already
`NaN` on those rows; it stays because it says at the point of use which rows
are warm-up and keeps the loop off negative indices — the same reasoning
`rollingExtremesValues`' `Number.isFinite` guard carries. 51 mutations, 49
caught (1–15 failing tests each), 2 survivors, both explained above.

(9) **Two Blau studies, one vocabulary.** `stochasticMomentumIndex` takes
`longPeriod` / `shortPeriod` in that application order — the same two knobs
`trueStrengthIndex` exposes, because they are the same double-smoothing by the
same author, who writes both as `r` and `s`. `schaffTrendCycle` spells its
look-back `cyclePeriod` rather than the vendors' bare `cycle`, and `ravi`
`shortPeriod` / `longPeriod` rather than `short` / `long`, on the rule
`trueStrengthIndex` set: bare "long" is position vocabulary in a financial
package. The `0.5` recursions in the STC and the `0.33/0.67` in the Fisher
transform are **constants, not options with defaults** — exposing Ehlers'
clamp would invite a caller to set it to `1.0` and get a study that throws on
real data.

(10) **The state machines' oracles are transcriptions, and the write-up says
so.** `fisherTransform` and `schaffTrendCycle` carry state, so their pandas
side re-implements the same step rather than deriving the answer
independently — the point the #708 review made, and it holds here. What
carries the verification instead is stated on both docstrings and asserted in
the generator: the analytic first-valid bar (or, for the STC, the bound plus a
flat-window proof), and a measured separation from the plausible wrong turn —
the high/low-extremes port (5.95) and the dropped second smoothing (3.80) for
the Fisher, the unsmoothed double stochastic (98.30) for the STC. A
transcription that agreed with the _wrong definition_ would still fail those.

Perf at 1M bars (`scripts/perf-studies.mjs`, same run): `swingIndex` 21.8 ms,
`accumulativeSwingIndex` 19.0, `ravi` 48.6, `prettyGoodOscillator` 54.8,
`trendIntensityIndex` 70.5, `fisherTransform` 106.5, `schaffTrendCycle` 129.6,
`stochasticMomentumIndex` 189.1, `specialK` 290.8, `randomWalkIndex` 328.1 at
`period 14` and 1194.2 at 50. References on the same run: `ema()` 6.9,
`sma()` 20.5, `bollinger()` 73.7, `donchian()` 143.3, `stochasticRsi()` 114.6.
Only `randomWalkIndex` owns a super-linear cost, and it is the documented
`O(N·period)`; everything else is its kernels'.

**Landed — the bands and price-transform tail (§6.2/§6.8).** `typicalPrice`,
`medianPrice`, `weightedClose`, `averagePrice`, `balanceOfPower`,
`starcBands`, `highLowBands`, `bollingerBandwidth`, `bollingerPercentB`,
`primeNumberBands`, `primeNumberOscillator` and `marketFacilitationIndex` —
twelve studies (nineteen columns), plus one new kernel file
(`kernels/prime.ts`) and two additions to `kernels/typical-price.ts`. Eighteen
oracle cases; 177 in the fixture. Decisions:

(1) **Five of the twelve are EXACT against TA-Lib**, and that is the whole
reason the batch is cheap to trust. `typicalPrice` = `TYPPRICE`, `medianPrice`
= `MEDPRICE`, `weightedClose` = `WCLPRICE`, `averagePrice` = `AVGPRICE`, raw
`balanceOfPower` = `BOP`, all at `0.0` difference with identical (empty)
warm-up masks. Getting there required matching TA-Lib's **summation order**,
which is load-bearing rather than pedantic: addition does not associate, and
summing `averagePrice` in OHLC order instead of TA-Lib's `h + l + c + o`
moves the reading by **2.8e-14** on the oracle's fixture — invisible on a
chart, fatal to a bar-for-bar claim. The generator asserts both the exact
agreement and that the reordering is non-zero, so the kernel comment saying
"the order matters" is backed by a number.

(2) **`weightedCloseValues` / `averagePriceValues` went into
`kernels/typical-price.ts` against the two-consumer rule.** Each has exactly
one caller. They are there because that file _is_ the named per-bar
price-summary family (typical, median, bar range) and splitting it so
`(h+l+c)/3` is a kernel while `(h+l+2c)/4` is a loop inside a study would
leave a reader hunting for the second half. Neither is exported from the
barrel, so the public surface is unchanged — the `alphaEmaValues` treatment.
The four studies share one file (`price-transform.ts`) on the
`rolling-stat.ts` precedent: a family of one-line studies over a shared
options shape lives together, while a study with its own substantial edges
gets its own file.

(3) **Two step-0 identities were found, recorded, and pinned rather than
used as a reason not to ship.** `starcBands` **is** `movingAverage` followed
by `atrBands` around that average; `highLowBands` **is** `envelope` over a
`medianPrice` column. Both are asserted **bit-for-bit** in
`test/studies.test.ts`, not described in prose. They ship anyway because the
composition needs a scratch column on the caller's series, the corpus names
both, and — for STARC — the centre is _computed_ and therefore earns a column
where `atrBands`' caller-supplied field does not (the `keltner`/`bollinger`
rule). The package now has three ATR channels and the STARC docstring
tabulates the only thing separating them: `keltner` centres on typical price,
`starcBands` on the close, `atrBands` on an existing column with no centre.

(4) **STARC's centre takes the K2 engine's COLUMN door, not its array door**,
and that choice is what makes (3)'s identity hold on a series with missing
cells. The input is a raw price column rather than a derived array, so
`'sma'` keeps `sma()`'s rows-not-contributors contract and its accelerated
path; the array door would blank every window containing a gap and the
identity with `movingAverage` would part company there.

(5) **A flat window splits `bollingerBandwidth` from `bollingerPercentB`, and
the pair is the clearest statement of the flat rule the package has.**
BandWidth answers `0`: its numerator is `2·stdDev·σ`, _forced_ to zero, over a
non-zero centre — a real reading ("the bands have no width", which is what a
squeeze is). %B answers `undefined`: its numerator is zero only _because_ the
denominator is (a flat window's price is its own mean), a genuine `0/0`.
`bollinger` itself is `undefined` there, so the documented consequence is that
on a flat stretch BandWidth is deliberately **not** recoverable from its band
columns; everywhere else it is, bit-for-bit — which is why both studies
re-form the bands with `bollinger`'s own expression rather than simplifying to
`2·k·σ` (the two agree in real arithmetic and not in IEEE754, and both
simplifications are in the mutation matrix and both die).

(6) **Two form choices went opposite ways on purpose.** BandWidth ships
`×100` (StockCharts / ChartIQ / TradingView) rather than Bollinger's own bare
ratio; %B ships as a **decimal** (`0` = lower band, `1` = upper) rather than
`×100`, because its whole reading is "above 1 / below 0". The rule behind both
is the same — match the chart a caller is comparing against, per study — and
each docstring says which convention it took and how to recover the other.

(7) **`balanceOfPower` is F-AMBIG and ships the TA-Lib-pinnable half by
default.** TA-Lib's `BOP` is the raw per-bar ratio; ChartIQ smooths it. Raw is
the default (exact); `period` (+ `maType`, the shared menu) gives the smoothed
form. **`maType` without `period` throws** — an option that silently does
nothing is worse than an error. Its flat bar reads `0`, and the argument is
algebraic rather than borrowed: a bar with `high === low` traded at one price,
so its open and close are that price and the numerator is exactly zero (the
`clvValues` rule from #699, applied fresh). TA-Lib agrees, though it gets
there through a `high − low < 1e-8` threshold where we test `range === 0`
exactly; the generator asserts the fixture's narrowest bar (0.70) is clear of
that gap so the exactness is not quietly resting on it.

(8) **`marketFacilitationIndex` defaults to `bwmfi`, not `mfi`, and the
collision is the reason.** `moneyFlowIndex` — Quong & Soudack's
RSI-on-money-flow, an entirely different indicator published under the same
abbreviation — already owns `mfi`, and two studies cannot share a default
output: appending both would throw. `bwmfi` is Bill Williams' initials in
front of it, which is what MetaTrader calls it for the same reason, and a
test appends both to one series. This is the second such collision in the
package (`relativeVigorIndex` / `relativeVolatilityIndex`), so API.md now
carries a note for each. It ships with **no `scale` option**: unlike
`easeOfMovement`, whose `100_000_000` is a _published_ constant two vendors
share, no constant is standard here, and exposing one would be inventing a
default rather than matching one.

(9) **The prime studies are the odd pair out and the docstrings say so.**
They compute a property of the _number line_ that the data lands on, not a
statistic of the data: no window, no warm-up, no history, and — uniquely in
the package — **no homogeneity property at all**. The property tests assert
that _absence_ rather than skipping the check, and they had to be measured to
be written: scaling moves every one of 80 bars, but a `+50` shift moves only
**60 of 80** (the other twenty land the same distance from a different prime
by coincidence), which is exactly the accident a "shift-invariant" claim would
otherwise be built on. Two open conventions are pinned: `pno = price − prime`
(the phrase's own word order; the mirror is `−pno`), and an **equidistant tie
goes to the lower prime**, so `pno(6) = +1`. A price **below 2** is outside the
domain and every prime output is `undefined` — two is the smallest prime, so
there is nothing to bracket with, and reporting the prime "above" −1000 as `2`
would be a distance measured across an empty half-line. The oracle replicates
both over a **pure-Python sieve of Eratosthenes** rather than `sympy`: the
venv does not carry it, and a library would be a poor independent reference
for a study whose entire content is which integers are prime.

(10) **The prime studies' cost is the sharpest edge in the package, and it is
published rather than buried.** Primality is trial division to `√n` and the
search walks the local prime gap, so the per-bar cost grows with the price
_magnitude_ — the only operators here that do. Measured at 1M bars:
`primeNumberBands` **78 ms** at ordinary equity prices and **6465 ms** at
~1e7; `primeNumberOscillator` **55 ms** and **6548 ms**. An ~85× jump. **No
sieve**: a segmented sieve over the observed price range would collapse the
1e7 column, and it was considered and rejected on the grounds that it needs a
`Uint8Array` the width of the price range (unbounded for an instrument that
has trended), a fallback for ranges too wide to sieve, and a second code path
to test — for two studies whose reading is a property of the integers. The
kernel docstring, the study docstrings, API.md and the benchmark all carry the
numbers, and the kernel note is written as the brief for the sieve if a caller
ever reports the cost. **This is the item in this batch most likely to be
argued with**, so it is flagged here rather than left to be discovered.

(11) **`shift` vs `percent`: flagged by the builder, resolved by renaming.**
The builder spelled `highLowBands`' half-width `shift` (ChartIQ's label for
this indicator) where `envelope` spells the same quantity in the same units
`percent`, and named it as a deliberate inconsistency for review. The
integrator renamed it to **`percent`**: the `type` / `maType` split names two
different roles, but this is one knob, and a consumer who has written
`envelope({ percent })` should write `highLowBands({ percent })` without
looking it up. The docstring records the rename and ChartIQ's label.

(12) **Three docstring claims were written from precedent and were wrong; the
missing-cell tests caught all three.** Worth recording because the pattern
will recur: (a) a missing close does **not** blank `starcBands`' centre — the
column door's `avg` skips a missing cell, so the centre is drawn through the
gap and only the ATR half propagates, and it does so from the bar _after_ the
gap (true range reads the previous close), not from the gap bar; (b)
`bollingerBandwidth` loses **nothing** to a gap because it reads only window
statistics, while `bollingerPercentB` loses exactly one bar because it also
reads that bar's own price; (c) neither Bollinger derivative composes its
warm-up with its source's — over `sma(3)` both start at bar 4, their own
`period − 1`, which is `bollinger`'s inherited behaviour and is asserted to
agree with it. Each is now stated on the docstring as measured rather than
assumed.

(13) **Two mutation survivors were fixed the two different ways the rule
allows.** `balanceOfPower`'s flat-bar branch ignoring a missing body, and
`bollingerBandwidth`'s zero-centre guard, both survived because no test
reached the corner — those got tests (the second needed a window whose _mean_
is zero but which is not flat: an all-zero window reaches `NaN` through the
numerator anyway, so it never exercised the guard). `nearestPrime`'s own
domain guard survived because it was **dead**: outside the domain both
brackets already return `NaN`, the comparison is `false`, and the `NaN` upper
bracket is returned — so the guard was deleted rather than tested, per #703's
rule. One further mutation is a _proven_ no-op and is recorded as such rather
than counted as a survivor: rewriting `m + -1 * stdDev * d` as
`m - stdDev * d` is bit-identical in IEEE754.

**Landed — the volume and miscellaneous leftovers (§6.6/§6.1).**
`twiggsMoneyFlow`, `tradeVolumeIndex`, `shinoharaIntensityRatio`,
`elderImpulse`, `movingAverageCross` and `anchoredVwap` — six studies, plus
three internal kernel helpers (`trueRangeBoundsValues`,
`moneyFlowVolumeValues`, `shinoharaTermsValues`) and eleven oracle cases; 190
in the fixture. Decisions:

(1) **Two of the six had to co-mask a numerator and a denominator, and the
bug they avoid is the same one #710's SMI found.** `twiggsMoneyFlow` smooths
`flow` and `volume` with two Wilder recursions, and `anchoredVwap`
accumulates `price·volume` and `volume` with two running sums. In both, the
numerator carries gaps the denominator does not — a bar with a volume but a
missing `high` has no price term — and in both the kernel's own leading-gap
rule then puts the two on **different bar sets**: `wilderValues` steps its
seed over a leading `NaN`, and `cumulativeValues` starts at the first finite
term. The fix is one line each (blank the weight wherever the flow is blank,
_before_ smoothing), and it is a live one: a unit test punches a hole in bar
1's `high` with a 9000-share volume and pins the answer at the two bars the
numerator actually saw. Worth writing down as a rule rather than a per-study
note: **any study that divides one accumulation by another must blank both on
the same bars before either accumulates**, because every accumulating kernel
in this package has a documented leading-gap rule and none of them are
symmetric across two arrays.

(2) **The gap rule for a cumulative K6 machine is OBV's, not NVI's, and the
test is what the level MEANS.** `tradeVolumeIndex` is both a state machine
(the carried tick direction) and a running volume total, so the two rules
collide. It resets its _direction_ on a gap — the K6 rule, and unavoidable: a
bar it did not see cannot tell it which way the tape went — but it does
**not** re-seed the level; it marks it `NaN` and the arithmetic carries that
forward. That is `cumulativeValues`' asymmetry reproduced inside a fold
(leading gaps shift the start, an interior gap ends the line), and it is
right for the same reason it is right for `obv`: the level is a total of
volume, a quantity with units where the distance between two points is the
reading, so a hole makes every later level wrong by whatever the missing bar
traded. `negativeVolumeIndex` re-seeds and is also right, because it
accumulates _returns_ from an arbitrary base. `anchoredVwap` takes the OBV
rule for the same reason. So the question is not "is this a K6 machine" but
"is the level a quantity or an index".

(3) **`movingAverageCross`'s tie rule is the study, and it is why the machine
carries the last NON-ZERO sign.** Two averages are exactly equal more often
than a float argument suggests — a stepped price does it routinely — and the
naive `sign(d[i]) !== sign(d[i−1])` gets two cases wrong: it fires twice for
a crossing that passes through a tie, and it invents a crossing on a
touch-and-retreat (`below → equal → below`), reporting a return to a side the
pair never left. Carrying the last non-zero sign fixes both and makes a
crossing _through_ equality fire on the far-side bar, which is the bar a
reader watching the chart would call it. The oracle input contains **no**
exact tie, so the rule cannot be separated there; the generator asserts that
the naive build still agrees bar for bar, so the day the fixture grows a tie
the "pinned TypeScript-side" note stops being quietly true, and the rule
itself is pinned by unit tests at `fastPeriod 1 / slowPeriod 2`, where
`fast − slow` is exactly half the bar-to-bar change and a repeated close _is_
a tie.

(4) **What a gap costs `movingAverageCross` depends entirely on `maType`, and
at the default it costs nothing.** Measured on a 40-bar series with bar 30's
close removed, at 3/6: `sma` **no missing cells at all** (the K2 column door
counts _rows_, so both averages skip the missing cell and the fold never sees
an incomplete row — the K6 reset never fires); `ema` two bars (the hole, then
the fresh seed); `wma`/`hull` a whole window, seed at 36 (the array door
waits for `period` finite _values_); `smma`/`kama` the rest of the series
(Wilder). The first row is the sharp edge: a study can inherit a documented
gap rule and still have none, because its inputs never gap. The table is in
the docstring and pinned by a test with one case per door, rather than a
sentence claiming the reset "usually" fires — the first draft said exactly
that, with the wrong reason, and the probe disproved it.

(5) **Three required options now exist in the package, and the third is
`minTick`.** After `benchmark` and `swingIndex`'s `limit`,
`tradeVolumeIndex` needs the instrument's minimum tick and cannot guess it:
`0` collapses the dead band so the persistence rule — the only thing
separating the study from OBV-with-a-carried-sign — never fires on float
prices, and a fixed `0.01` is wrong by two orders of magnitude for a JPY
cross and six for a crypto pair, producing a number rather than an error.
`anchoredVwap`'s `anchor` is a fourth, and it is required for a different
reason: it is not a fact about the instrument but the **question being
asked**, and every default is a different indicator (the series start is a
cumulative-from-inception VWAP; the last bar is a constant). It is a `Date`
or epoch ms rather than a row index because that is what a caller has and
because an index does not survive a filter, a join or a resample.

(6) **`anchoredVwap` closes the half of VWAP `vwap()` named and left open —
and leaves the third half open on purpose.** `vwap`'s docstring already
recorded that the anchored form is _not_ a special case of the rolling one
(`period = length` gives one value at the last bar, not a running line) and
deferred it to "a session-anchored phase". That deferral conflated two
things: the **anchor** and the **reset**. This study ships the anchor, which
needs no calendar because it is a user parameter; the session-**reset** form
still waits on [PND-TCAL] / **G4**, and a caller who needs it today
partitions on the session and runs this per partition. The property test
pins the relationship the two forms actually have: over a 140-bar series
anchored at 40, the rolling form with `period 100` emits 41 values against
the anchored line's 100, they differ everywhere they overlap except at the
**last** bar, and there they agree exactly — which is what makes the
difference a window rather than an arithmetic one.

(7) **`elderImpulse`'s column is numeric because `withColumn` has no other
door, and that is worth stating rather than assuming.** The corpus describes
the output as a "categorical color column (string col OK)". It is not:
`TimeSeries.withColumn` takes a `Float64Array` or a `(number | undefined)[]`
and appends a **number** column, verified against
`packages/core/src/batch/time-series.ts`. `+1 / 0 / −1` is the encoding —
signed, so it sorts and sums the way the reading does, and a chart maps the
sign to Elder's green/blue/red in one expression. The same question settles
`movingAverageCross`, whose signal column is numeric for the same reason. If
a categorical column is ever wanted, it is a core feature request, not a
study workaround.

(8) **Two F-AMBIG forks, and one of them is a naming fork.**
`twiggsMoneyFlow` ships **Wilder's** exponential smoothing per the algorithm
published on Twiggs' own site (Incredible Charts); the window-sum fork sits
0.0706 away at `period 21` on a reading spanning −0.0279…0.1493, and
`chaikinMoneyFlow(21)` — the study it corrects — sits 0.1494 away, wider than
the whole reading. `shinoharaIntensityRatio`'s ambiguity is not arithmetic at
all: the A and B ratios are standard, and what differs between vendors is
which is charted as "strong". The labels come from the corpus' own list (A →
`sirStrong`, B → `sirWeak`), and the test that matters is that they carry
information — the two lines sit 23,312 apart on the oracle input. Neither
gets a flag: a flag would make one study into two.

(9) **`shinoharaIntensityRatio`'s B ratio inverts on a gappy tape, and that
is documented rather than clamped.** `prevClose − low` is negative on a bar
that gapped up and never traded back, so the denominator can approach zero
from either side. The package's own oracle input gaps on 33 of its 80 bars
and `sirWeak` there spans **−22,761.08 … 7,620.00** against a `sirStrong` of
45.51 … 584.50. That is the definition — the ratio asks "how far above the
previous close per unit below it", and on a market that never traded below it
the answer is unbounded — and the honest response is to say so, with the
worked case, and to pin a hand-computed negative reading in a unit test.
Considered and rejected: clamping the negative terms to zero, which is a real
vendor variant but a different study, and would hide exactly the tape
condition the reading is reacting to.

(10) **A shift-invariance property test needed a relative tolerance, and the
reason is a finding.** `shinoharaIntensityRatio` is shift-invariant in exact
arithmetic (every term is a difference of two prices), but not in floating
point: the shifted run computes `(o + 5000) − (l + 5000)`, whose terms carry
~1e-12 of relative error the unshifted run does not, and the B ratio
**amplifies** it wherever its denominator is near zero. Measured at bar 101
of the property fixture: 6.5e-9 absolute, 1.6e-12 relative. The test asserts
the relative form and records both numbers, rather than loosening the
absolute tolerance without saying why.

(11) **Two survivors in the mutation matrices, both equivalent mutants, both
kept.** `twiggsMoneyFlow`'s `wilderValues(flow, period, 1)` survives
`start = 0` because the co-mask makes bar 0 `NaN` in both arrays — it is
`atrValues`' redundant `start = 1`, kept for the reason that one is: it
states at the call site why bar 0 is skipped. `shinoharaTermsValues`' `if (i

> 0)`survives`i >= 0`because`close[-1]`on a typed array is`undefined`and the arithmetic yields`NaN`anyway; the branch is kept because relying on
out-of-range read behaviour to produce a warm-up is not something the next
editor should have to know. Two other mutants survived a first pass and were
**tests missing, not dead code**:`elderImpulse`'s default `emaPeriod`(a
12- and a 13-span EMA hardly ever have different slope signs — they agreed on
all 46 verdicts of the oracle fixture; a 200-bar wave separates them on
exactly two bars, and the test pins those) and its missing-previous-EMA guard
(unreachable at every published period, because the histogram is always the
slower input; at`emaPeriod 20`against a 7/4 MACD it is reachable, and bar 19
would have read`0` — a verdict from a comparison the study could not make).

Perf at 1M bars (`scripts/perf-studies.mjs`, one run): `tradeVolumeIndex`
27.8 ms, `anchoredVwap` 32.0, `movingAverageCross` 44.3 (`ema`) / 55.0
(`sma`), `twiggsMoneyFlow` 59.5, `elderImpulse` 87.5,
`shinoharaIntensityRatio` 133.9 at `period 26` and 127.1 at 200 — **flat in
`period`**, which is what its four `rollingMeanValues` scans should be and
why the 26/200 pair is in the bench. References on the same run: `obv()`
17.5, `vwap()` 56.0, `macd()` ~71, `sma()` ~21, `ema()` ~7,
`foldRows(2 cols)` ~10. Everything here is compose-only; no study in the
batch owns a super-linear cost.

**Landed — the session-anchored studies (§6.9, G4).** `sessionVwap` and
`pivotPoints` — the two studies the corpus assessment gated on the trading
calendar, and the last two the assessment ranked as high-value. Both take the
session as a **first-class input**; neither invents session boundaries.

**The option shape: both doors, one walk, `sessions` primary.** The batch was
briefed to pick one of two doors — a calendar/session list, or a session-id
column — and support the second only if it was one line on top of the first.
It is one line, and both ship, as a shared `SessionAnchorOptions`
(`contract/session-anchor.ts`, beside the OHLCV column contract):

- **`sessions: TradingCalendar | Session[]`** — the primary door, and the one
  the docstrings lead with. It is the RFC §6.1 picture: one calendar object
  shared by the data ops, the bar building and the axis, so a study and a
  chart cannot disagree about where a session starts. A `TradingCalendar` is
  narrowed with `sessionsInRange` over the series' own key range first; a raw
  `Session[]` (the schedule table a feed hands you — Amendment 2, Tidal Ask 1)
  goes through `normalizeSessions`, so an overlapping or malformed schedule
  **throws** rather than anchoring on whichever session the walk reached
  first.
- **`session: <column name>`** — the door for a series that has already been
  through `tagSessions` / `partitionBy(sessionId)`, which is the RFC's own
  stopgap (Tidal Ask 2) and therefore a shape real consumers are already in.
  Making them hand the calendar back would mean walking it twice. It is
  `columnValues` plus an `assertColumn` — a required option with no default,
  so a typo throws.

What makes carrying both honest rather than two ways to be subtly different
is that they are **the same walk**: `sessionIdValues(keys, sessions, stamped)`
moved into `kernels/session.ts`, and `TradingCalendar.tagSessions` was
rewritten to call it. So `sessionVwap(bars, { sessions: cal })` and
`sessionVwap(cal.tagSessions(bars), { session: 'session' })` are equal by
construction, and a test pins them equal under **both** stamp conventions
rather than only the default. `stamped` belongs to the `sessions` door alone
and **throws** beside `session` — a session-id column has already had the
stamp decision applied to it, so accepting the option there would be a lie;
the error points at `tagSessions`.

Rewriting `tagSessions` onto the kernel was not only tidiness. It had been
reading `series.toArray()` and `event.begin()` — one `Event` plus one data
object per row, the exact cost PR #536 removed from the study kernel — where
the study door reads `keyColumn().begin` columnar. Measured at 1M bars,
output identical on every row: **120.90 ms → 25.69 ms** (4.7×;
`scratchpad/session-tag-bench.mjs`).

**`sessionVwap` composes on `anchoredVwap` literally, not by resemblance.**
The two studies now call one kernel, `anchoredVwapValues(typical, volume,
anchors)`, where `anchors` is a **group id per row**: `anchoredVwap` passes a
single group (`NaN` before the anchor bar, one id after), `sessionVwap` passes
each bar's session id. "Session VWAP is anchored VWAP re-anchored every
session" is now a fact about the code. The fused loop also replaced the old
four-array composition (blank ×2 + `cumulativeValues` ×2 + a divide pass):
bit-identical output, **23.51 ms → 16.62 ms** at 1M rows (−29%;
`scratchpad/session-avwap-bench.mjs`). `cumulativeValues` keeps its other
three consumers.

The gap rule follows the cumulative precedent `anchoredVwap` set rather than
`negativeVolumeIndex`'s re-seed: **an interior gap ends that session's line**,
because the reading is a _level_ and skipping the bar would report an average
price that silently excludes volume that traded. The difference is that the
**reset is the recovery** — the next session open re-seeds, where
`anchoredVwap` makes the caller re-anchor by hand. Both sums are blanked
wherever either input is missing (the #710 rule), so a bar with a volume but a
missing `high` cannot bias the average toward zero. The zero-accumulated-volume
guard is live and at the **output**, exactly as in `anchoredVwap`: reachable
on a session that opens on a run of zero-volume bars, and the mutation matrix
confirms it is live (3 failures when it returns `0` instead).

**`pivotPoints`: the column set follows the method.** Camarilla defines a
fourth pair and the other three sets do not. The alternative — nine columns
always, with `ppR4`/`ppS4` permanently `undefined` for three of four methods —
invents columns that have no definition, makes "missing" ambiguous between
_not in this method_ and _no previous session_, and hands every
standard-pivot consumer two dead series. So the set varies (7 columns, or 9
for Camarilla) and the **return type is conditional on `method`**
(`PivotPointsResult`), so `.get('ppR4')` type-checks only where the column
exists. The cost is that the study is the first in the package whose return
type is hand-written rather than inferred from a `withColumn` chain — the same
`as unknown as` step `tagSessions` already makes for `TaggedSchema` — and that
a caller passing a non-literal `method` gets the union of the two shapes.
Judged worth it; the alternative is silently wrong data.

`method` is a **genuine variant menu**, not the two-indicators-behind-a-flag
case a `keltner` "band source" flag would have been: all four sets read the
same three inputs and emit the same ladder shape, differing in constants.
Two deltas are documented on the study because both are in circulation:
Woodie's ships the previous-**close** centre `(H + L + 2C)/4` rather than the
current-session-**open** variant (which would make one menu entry read a
column the other three don't), and Camarilla's levels are measured from the
**close**, not from the pivot — which is the definition, and is why its ladder
is asymmetric about `ppPivot` and why the oracle checks its two halves
separately.

Aggregation is `previousSessionHlcValues` — `aggregate` + hold-broadcast as
one pass. Three decisions in it:

- **"Previous session" means the previous session with BARS in this series**,
  not the previous entry on the calendar. A holiday the feed skipped has no
  aggregate, and reading the calendar for one would invent a bar.
- **The aggregates are taken over the cells that are PRESENT**, per column — a
  bar with a missing `high` still contributes its `low`. That is deliberately
  _not_ the blank-both-together VWAP rule: there the two sums are numerator
  and denominator of one ratio, so consuming different bars biases the answer,
  while `max`/`min`/`last` are three independent order statistics. A column
  with no present cell in a session yields `undefined`, which propagates
  through every level.
- **The seven (or nine) columns share ONE warm-up**, not one each: every level
  of every method reads all three aggregates, so a missing input blanks the
  whole ladder together. The first session with bars and every closed-time bar
  read `undefined`.

**The oracle needed a new input, and that is the one place this batch touched
the fixture's shape.** Every existing case keys bar `i` at `i` _milliseconds_ —
bar-indexed, which is all a window study needs and over which no trading
calendar can be laid (80 ms is not a trading week). Rather than a second
fixture, the five new cases carry `input.sessionTimes` and **reuse the same 80
OHLCV bars**: the prices, ranges and volume spikes the other 208 cases are
checked against are exactly the ones these are checked against. The clock is a
real one — 30-minute bars stamped at their open on a 09:30–16:00
America/New_York grid, six sessions (with a holiday on 2024-01-15 so a
weekend-plus-holiday gap exists), plus **two bars in no session**: one stamped
exactly at Monday's close, one a Saturday noon print. Without those two the
fixture could not tell a study that reads `undefined` in closed time from one
that carries the last session's value across the gap. `6 × 13 + 2 = 80`, so
the row count still matches every other input, and regeneration left all 208
existing cases byte-identical.

The references are pandas `groupby`-`cumsum` and
`groupby().agg().shift(1).reindex(sid)` — genuinely different formulations
from our sequential reset loops, not transcriptions. The vitest side rebuilds
the calendar from the **same rules** rather than from a table in the fixture,
so a disagreement between our Temporal session generation and Python's
`zoneinfo` about a session boundary fails the case instead of hiding behind a
shared input. Generator asserts: each session's first bar opens at its own
typical price; exactly 78 of 80 bars in session; the levels are flat within a
session; the ladder is ordered; the four methods are separated on R1 (0.05
floor). Separations printed by the generator: session VWAP sits **12.0162**
from the non-resetting cumulative form and **1.7147** from the unweighted
per-session mean of typical price.

**Perf at 1M bars** (`scripts/perf-studies.mjs`, one run; two calendars are
benchmarked because the O(N + sessions) claim needs evidence, not assertion):
`sessionVwap` **45.5 ms** on a ~520-session equity calendar (~27 % of bars in
session) and **55.9 ms** on a ~760-session all-day calendar (100 % in
session) — the spread is the in-session _fraction_, i.e. how much accumulation
runs, not the session count; `sessionVwap({ session: column })` 44.1 ms;
`tagSessions` 15.96 ms. `pivotPoints` **113.6 ms** (`standard`, 7 columns) and
**146.6 ms** (`camarilla`, 9) — ~16 ms per appended column, which is
`withColumn`'s cost and nothing else; the walk plus the aggregate pass is the
~15 ms `tagSessions` shows. References on the same run: `anchoredVwap` 48.5,
`obv()` 24.7, `vwap()` 94.6, `bollinger()` 115.8, `guppy()` (12 columns)
332.4, `sma()` 36.4, `ema()` 11.2. A per-bar search over the schedule would be
1e6 × 5e2 = 5e8 comparisons and could not land within an order of magnitude of
these numbers.

**Mutation matrix** (29 mutations across the four new source files plus the
two refactored ones; the tests that could see them —
`session-kernel` / `studies` / `study-oracle` / `study-missing-cells` /
`talib-properties` / `fluent` / `tag-sessions` — re-run per mutation; counts
are FAILING tests; script at `scratchpad/session-mutate.py`):

| n   | mutation                                                                               |
| --- | -------------------------------------------------------------------------------------- |
| 32  | `sessionIdValues`: open-stamped lower bound `>=` → `>` (drops each session's open bar) |
| 3   | `sessionIdValues`: ignore `stamped`, always open-stamp                                 |
| 8   | `sessionIdValues`: the id is the session INDEX, not its `open`                         |
| 1   | `sessionIdValues`: cursor skip `<=` → `<`                                              |
| 33  | `previousSessionHlc`: levels read the CURRENT session (write after the fold)           |
| 9   | `previousSessionHlc`: `prev` never advances past the first session                     |
| 12  | `previousSessionHlc`: the session high takes the MIN                                   |
| 13  | `previousSessionHlc`: the session close is the FIRST close                             |
| 1   | `previousSessionHlc`: a closed-time bar RESETS the running aggregate                   |
| 9   | `anchoredVwapValues`: never reset (one group for the whole series)                     |
| 3   | `anchoredVwapValues`: zero accumulated volume reads `0`                                |
| 3   | `anchoredVwapValues`: a leading gap is a zero, not a shifted start                     |
| 16  | `anchoredVwapValues`: a `NaN` group id still accumulates                               |
| 4   | `pivotLevelValues`: Woodie's uses the standard centre                                  |
| 3   | `pivotLevelValues`: Fibonacci 0.382 / 0.618 swapped                                    |
| 3   | `pivotLevelValues`: Camarilla centred on the pivot, not the close                      |
| 3   | `pivotLevelValues`: Camarilla R4 multiplier `1.1/2` → `1.1/3`                          |
| 4   | `pivotLevelValues`: standard R3 drops the doubling                                     |
| 6   | `pivotLevelValues`: standard R1/S1 swapped                                             |
| 11  | `pivotPoints`: Camarilla's fourth pair is not produced                                 |
| 1   | `pivotPoints`: the collision guard checks only the first column                        |
| 1   | `resolveSessionIds`: `stamped` beside the column door is ignored                       |
| 1   | `resolveSessionIds`: a raw `Session[]` skips validation                                |
| 1   | `resolveSessionIds`: range start not nudged back one ms                                |
| 2   | `resolveSessionIds`: range end not nudged forward one ms                               |
| 1   | `resolveSessionIds`: both doors together no longer throws                              |
| 1   | `resolveSessionIds`: a missing session column reads all-missing                        |
| 12  | `sessionVwap`: default output name changed                                             |
| 3   | `tagSessions`: `stamped` default flipped to `'close'`                                  |

**Two survivors on the first run, both acted on rather than papered over.**

- **Dead code, deleted.** `sessionIdValues` tested `t < s.close` (and
  `t <= s.close` close-stamped) after the cursor had already skipped every
  session that ended before `t` — so the close side is true by construction
  and flipping it failed nothing. Removed, with the invariant written where
  the test used to be (#703's rule: delete a dead guard, don't test it). It
  had been carried verbatim from `tagSessions` since the calendar landed.
- **A missing test, added.** Nothing noticed a closed-time bar resetting
  `previousSessionHlcValues`' in-progress aggregate. That is reachable only
  through the **column** door (a real schedule puts closed time _between_
  sessions, never inside one), and the rule matters there: a session ends
  when the id CHANGES, not when a bar happens to carry none — otherwise the
  second half of an interrupted run would read the first half's aggregate as
  its "previous session". Pinned in the kernel test on ids `1,1,NaN,1,2`.

The two boundary mutations on the calendar narrowing (`start − 1`, `end + 1`)
also earned a test that did not exist when they were written: a close-stamped
series whose FIRST bar sits exactly on a session's close, and any series whose
LAST bar sits exactly on a session's open. Both are reachable, both were
one-sided misses, and `sessionsInRange` being half-open is why.

**Considered and rejected.**

- **One door only.** Dropping the column door would have made an
  already-partitioned consumer (the RFC's own stopgap shape) re-walk the
  calendar; dropping the calendar door would have made every consumer run
  `tagSessions` first for no gain. Since the second is `columnValues` on top of
  the same walk, both ship.
- **A fixed nine-column pivot family.** See above — `undefined` extras make
  "missing" ambiguous and ship dead series.
- **Woodie's open-weighted centre**, and a `woodieSource` option to choose.
  A knob with one conventional value per vendor, on one of four menu entries,
  reading a column the other three don't. Documented as a delta instead.
- **A `sessionCumulativeValues` kernel** (a generic per-session running sum)
  under `sessionVwap`. It would have had exactly one consumer and cost three
  intermediate arrays; the fused `anchoredVwapValues` has two consumers and is
  the arithmetic itself.
- **Making `sessionVwap` a `partitionBy` + `anchoredVwap` recipe** rather than
  a study. That is what the pre-calendar workaround was, and it is worse on
  every axis: it needs a per-partition anchor timestamp computed by the
  caller, it does not blank closed time, and it does not survive the
  re-assembly type-wise.

**Landed — Ichimoku and ZigZag (§6.4, G5/G6 in their batch forms).**
`ichimoku` (five columns) and `zigZag` (three), plus one non-study export,
`ichimokuOffsets`; seven oracle cases, 215 in the fixture. Both are the
corpus' most-used remaining studies and both were blocked on a _gap_ rather
than on math — G5 (forward displacement past the series end) and G6
(repainting). Neither gap was closed; each study was shipped in the form that
does not need it, and the residue was turned into two named asks. Decisions:

(1) **Ichimoku ships undisplaced, and that includes Chikou, which COULD have
been shifted.** The forward half has no honest alternative — `shift(cols, -n)`
moves values across rows that already exist and there are no rows past the
last bar, so faking them means inventing bar times, which off a daily grid is
[PND-TCAL] arithmetic. The backward half is the real decision: `shift(col,
-displacement)` lands entirely on existing rows, and the textbook plot draws
Chikou that way (its point at bar `i` is `close[i + 26]`; TradingView's
built-in uses `displacement − 1` on both halves, a platform choice the
chart-side offset absorbs). It ships **raw** anyway,
for two reasons. First, **a pre-shifted Chikou is a look-ahead column** — its
value at row `i` is not knowable at row `i`, and every other column in this
package is causal; joined into a feature matrix it leaks the future with
nothing in its name or type to say so. Second, it would make the study's own
rule non-uniform: with Chikou raw the rule is one sentence (_no column is
displaced; the chart offsets `+displacement` on the spans and `−displacement`
on Chikou_), and pre-shifting one of three means a consumer has to remember
which. The plotted form is a documented one-liner
(`.shift('ichiChikou', -26)`) carrying the look-ahead warning at the point of
use.

(2) **`displacement` is therefore an option that changes no value, and that is
stated three times rather than hidden.** It is validated as a bar count,
echoed by `ichimokuOffsets`, and pinned by an **oracle case** — a run at
`displacement: 5` whose expected arrays are byte-identical to the default's,
so a future build that quietly starts shifting fails the fixture rather than
a doc review. The alternative (drop the option from the study and put it only
on the offsets helper) was rejected: Ichimoku's published parameter set is
9/26/52/**26**, and a study that cannot be told its own fourth number reads
as incomplete. Measured, the number is not decorative — had the study applied
it, Senkou A would move by up to 11.81, Senkou B 5.11 and Chikou 17.60 on a
fixture spanning 98.65…118.01.

(3) **`ichimokuOffsets` is the data-side half of charts ask C2, and it is a
map, not a number.** It returns `{ ichiTenkan: 0, ichiKijun: 0, ichiSenkouA:
+displacement, ichiSenkouB: +displacement, ichiChikou: −displacement }`, keyed
by the _actual_ prefixed column names, so a chart cannot get a sign or a name
wrong; pass it the same options object the study got. The precedent is
`GUPPY_SHORT_PERIODS` — a number a chart has to restate is a number a chart
gets wrong. **The ask this creates:** C2 (per-layer `xOffsetBars` plus forward
projection space in bars) and then C3 (a band between two _crossing_ columns
with a two-colour `fillBy: 'order'`), without which the cloud cannot be drawn
at all. Both were already on the charts list; this study is the first shipped
consumer, so they are now blocking a landed study rather than a hypothetical
one.

(4) **ZigZag makes every column repaint, deliberately, rather than mixing one
causal column in with two that do not.** `zzPivot` sits on the bar its extreme
_occurred_, which is only known when a later bar confirms it; `zzLine`
interpolates towards a pivot still in the future; and `zzDirection` was the
one that could have gone either way — the machine's _causal_ belief (still
hunting a high) or the leg a bar _retrospectively_ belongs to. The
retrospective reading shipped, because a single causal column among two
repainting ones is a trap that reads as a safety guarantee, and because
`zzDirection` is what `zzLine` is drawn from. The docstring says the whole
study is a description of the past and names the one causal reading a strategy
can take (the bar the direction _changes_ is the confirmation bar).

(5) **No `zzProvisional` column; the last leg is documented as absent.** It
would be `undefined` on every row but one, and the number it holds — the
running extreme since the last pivot — is a three-line recipe from data
already on the series (`zzDirection`'s tail names the side, the last non-null
`zzPivot` names the start). `zzDirection` _does_ cover the provisional leg,
since its direction is the one thing about it that is known, so the tail is
not blank. **What the live layer would need (the G6 repaint contract):** a
`LiveSeries` form cannot revise `zzPivot[k]` after emitting bar `k`, so it
needs either (a) a _provisional tail_ convention — the last leg emitted as
revisable state alongside the append-only confirmed pivots, with a "pivot
confirmed at bar `i`, located at bar `k`" event rather than a column write —
or (b) recompute-on-window semantics with a documented revision horizon. (a)
is the smaller change and matches what the batch study already knows: the
confirmation bar and the pivot bar are different numbers, and only the first
is ever "now". Neither is built; this is the record of what the shape has to
be.

(6) **A gap resets the machine AND discards the leg in force — the K6 rule
plus one addition.** [PND-SFOLD] resets; ZigZag additionally throws away the
provisional leg's extreme, because confirming it would mean inventing the
reversal that was never seen, and draws no line across the hole (the
interpolation runs between consecutive pivots _of the same run_). The
alternative considered was `wilderValues`' rule — end the study at the first
gap — and it was rejected on the kernel's own argument: Wilder stops because
its seed is a `period`-bar mean and restarting restates the statistic, while
ZigZag's seed is two bars and a threshold, which is exactly what a chart does
when a halted instrument resumes. Resetting costs the one leg that spanned
the hole and nothing else.

(7) **Two rules fall out of "a bar's high and low have no order", and both
are load-bearing.** The counter-extreme is only ever taken from a bar _after_
the extreme's, so (a) a single wide bar never confirms a pivot on itself — a
5% intraday range at `deviation: 5` would otherwise put two pivots on one row
— and (b) a seed whose running high and running low are the same bar fires
nothing until they part. Together they give the invariant the oracle asserts:
pivot bars are **strictly increasing** and at most one is confirmed per bar.
Neither rule is separable on the oracle's input (no bar there has a 5% range,
and the fixture's first bar is not both extremes), so both are pinned by unit
tests, and the generator asserts the invariant on every case so the day the
fixture grows such a bar the claim stops being quietly true.

(8) **The close-based fork needed no option, because the column names already
are one.** `zigZag(bars, { high: 'close', low: 'close' })` is the close-based
study exactly — zero branches in the machine, since the fold reads two input
arrays and the fork is which arrays. It ships as its own oracle case rather
than as a `source: 'close'` mode, and the same shape composes over another
study's output (`{ high: 'sma', low: 'sma' }`). Measured on the 80-bar
fixture: at 2% the fork finds 4 pivots against high/low's 6; at 5% it finds
the same three bars at prices up to 0.85 away.

(9) **`deviation` is a percent, so the property test asserts the true
statement and not the convenient one.** Scaling every price leaves the pivot
bars and `zzDirection` identical and multiplies `zzPivot`/`zzLine` — that is a
real invariance. **Shifting** is not: lifting the same path by 5000 makes a 5%
threshold worth ~250 points, which no swing in the fixture reaches, so the
pivots vanish entirely. The test asserts exactly that (all-`undefined`), which
is a stronger claim than "the columns differ". Ichimoku, by contrast, is
equivariant both ways and is asserted both ways.

(10) **The perf check turned up one real optimization and it is a kernel, not
a study tweak.** Ichimoku's three windows want the max of `high` beside the
min of `low`, and `rollingExtremesValues` returns the max **and** min of a
_single_ array — so the first build called it twice per window and discarded
half of each answer. Measured at 1M bars, that waste _was_ the study: six
deque passes at **414 ms** against a 404 ms end-to-end study, with the five
`withColumn` appends at 67 ms and the elementwise work invisible. The
three passes a paired door makes cost **213 ms**, so
`rollingBarExtremesValues(highs, lows, period)` was added to
`kernels/highest-lowest.ts` — one walk, two deques reading different arrays,
one shared missing counter — and on the package bench `ichimoku` went
**433.6 → 280.7 ms at 1M (−35%)**, and at 20/60/120 **438.4 → 266.9 (−39%)**,
from 1.75× `donchian` to 1.14×. (The 213 ms figure above is the deque work
alone; the bench measures the whole study, so it lands above it, not on it.) It is internal (not on the barrel),
so the study's own two bench entries are its only benchmark, which the perf
script now says out loud.

The kernel's missing-cell rule is **strict over BOTH arrays together** — a
bar is blank on both outputs unless all `period` cells of `high` _and_ `low`
are finite. That is stricter than a per-array rule and it reproduces exactly
what the two-call build gave, because `NaN` propagated through
`(HH + LL) / 2` anyway; stating it in the kernel is the #710 SMI rule (two
inputs consumed through separate passes must blank the same bars) moved from
a study's arithmetic into the door. It is what puts Ichimoku's warm-ups at
8/25/25/51/0 and gives the interior-gap rule its shape (a hole costs each
line exactly its own window, then it recovers). Ichimoku's lines are
Donchian midlines with a different missing-cell rule (strict here,
skip-and-carry-on there); that is noted on both rather than reconciled, per
the house convention.

(11) **The mutation matrix bought three tests and one deletion, and the one
survivor is provably equivalent.** 23 mutations, 22 killed. The first pass
left four alive and each turned out to be a different kind of finding:
`>=` → `>` on the reversal threshold survived because **no fixture landed on
the threshold** (at `deviation: 50` the arithmetic is exact in floats, so a
100 → 200 → 100 path hits it twice and now pins the closed boundary, seed
branch included); "a bar may reverse itself" survived on the **falling** leg
only, the rising mirror having been tested and the falling one not; the
line's endpoint pinning survived because it was **dead** — swept over 3M
random `(from, to, span)` triples, `from + (to − from)·span/span` never once
missed `to` — so the interpolation was restructured to write the endpoints
from the pivots and the interior only, which makes both assignments live and
keeps the "the line AT a pivot IS that pivot" guarantee as code rather than
as luck. The survivor that remains, `<` → `<=` on the direction fill, is
**equivalent by construction**: each leg owns `[start, stop)` and the next
iteration overwrites `stop` with its own direction, so the extra write
changes nothing. It is recorded in a comment beside the loop rather than
chased, the `rollingExtremesValues` precedent.

Perf at 1M bars (the full before/after table is in the commit message):
`ichimoku({9, 26, 52})` **280.7 ms** and `ichimoku({20, 60, 120})` **266.9** —
**flat in the periods**, as three deque passes must be; `zigZag({deviation:
5})` **82.2** and at `0.5` **80.4** — flat in the threshold, as a fold plus a
walk over the confirmed pivots must be. References on the same run:
`donchian()` 247.2, `stochastic()` 340.9, `foldRows(2 cols)` 18.3, `sma()`
37.8, `ema()` 12.0. ZigZag is compose-only; Ichimoku's cost is entirely its
kernel's, which is why the optimization went there rather than into the
study.

**Fan-out mechanics (how the three parallel study PRs were run).** One
builder agent per study group on `isolation: "worktree"` branches
(`fanout/returns`, `fanout/stoch`, `fanout/volume`), Opus models per Peter,
integrated one at a time onto `main` by the library agent. Lessons: (1) an
agent that backgrounds `npm run verify` yields before it commits — verify
must run in the foreground; (2) the scratchpad is shared across worktrees,
so every agent prefixes its scratch files; (3) `git merge-tree` previews
against merge-commit history say "clean" where the real merge onto a
squash-merged base conflicts in every shared file (index, fluent, API.md,
tests, oracle generator, fixture) — budget for a hand merge, regenerate the
oracle fixture rather than resolving it textually, and never run a shell
heredoc inside an `&&` chain during that merge (it breaks the chain and the
following steps run on a conflicted tree); (4) three ~230k-token builders in
parallel exhaust the session rate limit — two at a time. (5) A builder's "measured"
claim is re-measured against the oracle venv before it is repeated
anywhere: #688's OBV write-up quoted a TA-Lib gap output that was actually
the fill-with-previous-close answer, and it reached the docstring, a test
comment, the CHANGELOG, this plan and the PR body before the Layer-2
reviewer re-ran TA-Lib.

### [PND-SFOLD] — K6 stateful-fold kernel — **landed** in the package, not promoted to core

`foldRows` (`packages/financial/src/kernels/fold.ts`) ships with six
consumers; the design, the gap rule and what a **core** `foldRows` would need
before it earns promotion are written up under "Landed — the state machines
(Phase 3, K6)" above. Nothing here is open work: the remaining question —
whether this becomes a core `scanRows` — is gated on a consumer outside
`@pond-ts/financial` wanting it, and the four things it would need are
recorded so that decision starts from evidence.

_Layer-2 review of #708, recorded._ The non-TA-Lib oracles here (`superTrend`,
`atrTrailingStop`, NVI/PVI, `klinger`) are pandas transcriptions of the shipped
step functions — same `run` counter, same branch order — so they are
**change-detectors**, not independent derivations; the separation probes
against the plausible wrong turns carry the correctness weight, and a
third-party re-derivation of Klinger and NVI is the open ask a Codex pass
would answer. The SuperTrend flip-order claim was over-general: the structural
argument holds where the code states it (`multiplier ≥ 1`, close inside its
own bar); below 1 the reviewer's random-walk data separated 55 of 168 sets
(all at 0.2 or 0.5, up to 5.0 price units) while this fixture reads 0.0 across
the whole grid (re-measured at integration, 0 of 133 — fixture luck, not a
guarantee). The note is scoped and the generator asserts the equality only at
multiplier 1, the regime the argument covers.

### [PND-STUDYCAT] — Runtime study catalog

**Origin.** Tidal's F-charts-25 (2026-09-07, relayed by the owner): adopting
the 105-study corpus into a `@pond-ts/process` registry means declaring each
study's name, input roles, numeric params with bounds and defaults, and
output suffixes with units — all of which the package carries only in
types TypeScript erases. Tidal's report put the corpus at twelve distinct
input shapes, six output arities and zero to four params — ~400 facts, each
a silent wrong answer if mistyped, re-checked per release — and stopped
before transcribing to ask for a runtime descriptor.

**Tidal's correction (2026-09-11), and what it proves.** Two of those
figures were wrong, and the way they were wrong is the ask restated: three
independent parses of the same 0.66.0 `.d.ts` files (Tidal's original, its
reviewer's, its re-derivation) gave three different input-column
distributions, because _whether a field is a data input or a knob_ is a
judgement the type surface does not settle. Only the study count and the
output-arity distribution survived all three. The catalog draws exactly
that line — `inputs` and `params` are distinct fields, classified
mechanically by `defineStudy` — so the disagreement cannot recur. From the
catalog itself (109 fluent methods, the authority now): inputs `1 ×47 ·
2 ×23 · 3 ×22 · 4 ×17` over thirteen distinct role sets; params `0 ×15 ·
1 ×50 · 2 ×24 · 3 ×13 · 4 ×7`; outputs `1 ×74 · 2 ×19 · 3 ×10 · 5 ×3 · 7 ×1
· 10 ×1 · 12 ×1`; units `inherit 77 · percent 47 · ratio 29 · delta 15 ·
volume 8 · signal 6 · index 3 · bars 1` over 186 output columns. Tidal
also noted that API.md's per-study table already held most of these facts
as prose; it is a hand transcription (the builders used it as a
cross-check, never the authority), its options cell is a signature that
does not draw the input/knob line, and it carries no bounds or ranges —
evidence for the descriptor, not a substitute.

**Shape.** `StudyDescriptor` is modelled on process's `OpDef` (its words:
`role`, `id`, `unit`, `suggest`) so a consumer maps rather than interprets
— not a mirror: an input carries its `default`, a required option carries
an `example` where process requires a `default`, and `anchor` has no
counterpart. The descriptor: `name`, `family`, `summary`, `inputs`
(`{ role, default? }` — absent default ⇒ required), `params` (a record keyed
by option: `NumberParam`-shaped with `kind: 'integer' | 'number'`,
`default` **or** `example`, `min`/`max`, `suggest`; or `kind: 'enum'` with
`of`), `naming` (`output` | `prefix` + default), `outputs`
(`{ id, unit }`), `anchor?: 'session'`, `run`. Three things Tidal's sketch
did not cover, found in the actual option surface: menu params (`maType`
on 17 studies, pivot `method`, price-oscillator `mode`); required options
with no default (`benchmark` on four studies, `minTick`, `limit`, …) — the
descriptor carries an `example` instead of a default; and the
session-anchored pair, whose `TradingCalendar` union is not a param — the
descriptor flags `anchor: 'session'` and the consumer supplies the calendar.

**What the builders found the seed seam could not say** (three shapes,
all added in the same wave): a bare-prefix primary line — eleven studies
name their line `${prefix}` and only the companions with a suffix
(`superTrend`'s `st`/`stTrend`, `trix`, `kst`, `klinger`, `smi`, `tsi`, …),
so `id: ''` is legal under `prefix` naming, at most one per study; an
option whose **absence is a switch, not a value** — `balanceOfPower`'s
`period` (absent is TA-Lib's raw per-bar ratio, present smooths it), which
no `default` can state honestly, so `optional: true` with an `example`,
and its `maType`, legal only alongside it, carries `requires: 'period'` (a
control shows it only when the period is on; the test runs it with it);
and `anchoredVwap`'s `anchor: Date | number`, an instant the consumer
supplies, modelled as `anchor: 'time'` beside the session anchor. The
builders also reported **no disagreement anywhere** between a docstring's
stated default, API.md's row and the source's `??` — 109 for 109 — which
is the first time that has been checked mechanically.

**Unit calls that took judgement** (all recorded in comments where they
sit): `centerOfGravity` is `'bars'` (a position measured in bars back, and
scale-invariant), not the `'delta'` the brief guessed; `stochasticRsi` is
`'percent'` (the source scales by 100); `linearRegression`'s `Angle` is
`'ratio'` for want of an angle bucket; `priceOscillator` and
`volumeOscillator` describe the **default** `mode` (`'percent'`) and say so;
`swingIndex` is `'delta'` (bounded ±100 but scale-equivariant with
`limit`), `accumulativeSwingIndex` `'index'`; `easeOfMovement` and
`marketFacilitationIndex` are `'ratio'` (no natural unit); `primeNumberBands`
and `atrBands` are `'inherit'` (levels you draw on the price axis, whatever
their half-width is). `rollingPercentile`'s default output name is computed
(`p${q}`), so its `naming.default` is `'p90'` only because its `example` is
`90` — the one coupled pair in the catalog, noted in a comment.

**`unit` is a closed vocabulary, not a free string.** Tidal's use is axis
membership, so the vocabulary answers that question: only `'inherit'` (a
level in the source's units) may share the source's axis; `'delta'` is the
source's units but zero-centred (MACD, momentum); `'percent'`, `'ratio'`,
`'signal'`, `'volume'`, `'index'`, `'bars'` are the rest. Process's
`UnitSpec` is `'inherit' | string`; the catalog is narrower on purpose.

**Guarded two ways, because a catalog that drifts is worse than none.**
(1) `defineStudy<Options>()` instantiates the study's options interface on
the wide schema, where every column option's type is `never`
(`NumericColumnNameForSchema<SeriesSchema>` is `never`), numbers are
`number`, menus are string-literal unions and `output`/`prefix` are
`string` — enough to classify every key mechanically. `inputs` and `params`
are mapped types over those key sets, so a missed or misspelt key, a
`default` on a required option, an `example` on an optional one, a menu
value outside the union or an object-typed option (`UNCOVERED_OPTIONS`) is a
compile error. (2) `test/catalog.test.ts` runs every descriptor against its
study on a 120-bar OHLCV fixture: the columns appended are exactly the ones
declared; running with every default stated explicitly is bit-identical to
running with none (the defaults are the study's); every menu value runs; a
declared `min`/`max` is accepted and one past it throws (so a bound is
inclusive, and declared only where the study validates a _constant_ — a
`slowPeriod` that must exceed the `fastPeriod`, or a strictly-positive real,
declares none; the Layer-2 review of #718 found 29 such `min`s that the
study rejected at the bound itself, which is why the test runs the bound
both ways); both `suggest` endpoints run at the other options' defaults
and the default sits inside the range; every output has a value on the
120-bar fixture (with `specialK`, whose warm-up is longer, named as the
one exception); and the catalog's names equal the set of `proto.X =`
mounts in `fluent.ts`, so a study added without a descriptor fails the
suite. The compile-time guard cannot check that an enum's `of` lists every
member of the union, or that `outputs` matches the return type — the
runtime test covers the first by running each value and the second by
diffing the schema.

**Decisions.** Per-family files (`catalog/<family>.ts`) rather than a
descriptor co-located in each study file: the fan-out is file-disjoint, a
family reads as a table, and the parity test catches a missing study either
way. A separate `./catalog` subpath rather than the main entry: a registry
wants every study; a one-study consumer must not pay for them. `outputs`
describe the **default** params — `pivotPoints`' `'camarilla'` adds an
`R4`/`S4` pair, noted in a comment rather than modelled. `lookback` (process's
warm-up declaration) deliberately not included in this pass: it is a claim
per study that the studies do not yet make uniformly; a second pass once a
consumer asks. Nine families are the assessment's §6 groups with `'price'`
and `'session'` split out.

### [PND-BBFLAT] — `bollinger` on a flat window

Tidal's F-charts-24: `bollinger` emits `undefined` for both bands when
`σ = 0`, on the recorded grounds that a zero-width statistical band is a
degenerate statistic and that downstream "outside the band" tests should
not fire on every bar of a flat stretch. The consequence a chart sees is a
band that breaks into segments around an unbroken middle line over any
stale or illiquid stretch. The bands **are** defined there — `middle ± k·0`
— and `keltner` already returns the degenerate channel at zero range, so the
package is inconsistent with itself. Decision: change `bollinger` to
`upper = lower = middle` on a flat window, leaving `undefined` to mean
warm-up only. `bollingerPercentB` stays `undefined` there (a genuine 0/0 —
the price sits nowhere in a band of no width) and `bollingerBandwidth`
stays `0` (its numerator is forced to zero, the #699 rule); their docstrings
cite `bollinger`'s old behaviour and are updated in the same change. Queued
behind [PND-STUDYCAT] at the owner's direction.

**Landed** (2026-09-08). One line in `bollinger.ts` (the `d === 0 ? NaN`
guard removed; a missing σ still propagates as NaN), the docstring names
the change and the old rationale, `bollinger-derived.ts` and `keltner.ts`
updated where they cited the old behaviour, two tests flipped and the
degenerate band pinned (`upper = lower = middle`, warm-up still the only
`undefined`), a CHANGELOG `Changed` entry. Behaviour shift on a shipped
study, so recorded here rather than folded in silently.

### [PND-TCAL] — Trading-time deferred items

Documented, none blocking:

- **`neighbourSpans` point-key slot widths on the discontinuous axis**
  (interval-keyed bars from `aggregate(barSequence)` — the primary path —
  are immune).
- **Exact exchange-tz tick grain** and **timezone control for the cursor
  readout** — _moved 2026-09-13_ to
  [PND_TIMEZONE_PLAN.md](PND_TIMEZONE_PLAN.md) ([PND-TZFIN] keeps the
  rules' zone on `TradingCalendar`; [PND-TZAXIS] renders the axis and
  readouts in it, explicit `timeZone` prop winning). The "own design
  conversation" this item deferred is that plan.
- Overnight sessions in `TradingCalendar.fromRules` (explicit-list only for
  now).
