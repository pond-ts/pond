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

### [PND-SFOLD] — K6 stateful-fold kernel (studies Phase 3)

A few Phase-3 studies (PSAR, SuperTrend, etc.) need the K6 stateful-fold
shim — a per-bar fold with carried state that doesn't fit the rolling
kernels. Design the kernel when Phase-1 breadth is done and a consumer pulls
on a Phase-3 study.

### [PND-TCAL] — Trading-time deferred items

Documented, none blocking:

- **`neighbourSpans` point-key slot widths on the discontinuous axis**
  (interval-keyed bars from `aggregate(barSequence)` — the primary path —
  are immune).
- **Exact exchange-tz tick grain** — the current grain buckets by
  runtime-local calendar.
- **Timezone control for the cursor readout** — the grain-aware default
  (#484 follow-up) sidesteps the daily-bar case, but true exchange-/display-tz
  handling is its own design conversation.
- Overnight sessions in `TradingCalendar.fromRules` (explicit-list only for
  now).
