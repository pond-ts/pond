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
