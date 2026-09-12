---
name: pond-financial
description: Financial market data in TypeScript — OHLC / OHLCV bars, candlesticks, moving averages (SMA, EMA), RSI, MACD, Bollinger bands, ATR, VWAP, stochastics and other technical indicators or studies, trading-session calendars and market-hours-aware bucketing, backtest-style rolling statistics over price series — using @pond-ts/financial on top of pond-ts. Use when a project computes indicators over price bars or needs a trading calendar.
---

# Studies and calendars with `@pond-ts/financial`

Sixty-plus oracle-verified studies (checked against pandas / TA-Lib) that
**append columns** to a bar `TimeSeries`, plus a `TradingCalendar` that makes
buckets, rolling windows and chart axes stop at the close. Pure computation:
Node + browser, no data fetching, no rendering (charts are `@pond-ts/charts`).

```sh
npm install @pond-ts/financial pond-ts   # same version; pond-ts is a peer
```

## Bars are a plain pond series

```ts
import { TimeSeries } from 'pond-ts';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'volume', kind: 'number' },
] as const;

const bars = TimeSeries.fromJSON({ name: 'AAPL', schema, rows, sort: true });
```

Ticks → bars is core pond: `ticks.aggregate(Sequence.every('5m'), { open:
{ from: 'price', using: 'first' }, high: { from: 'price', using: 'max' },
low: { from: 'price', using: 'min' }, close: { from: 'price', using: 'last' },
volume: 'sum' })`. Use the calendar (below) instead of `Sequence.every` when
bars must not span the close.

## Studies: fluent or function form

```ts
import '@pond-ts/financial/fluent'; // once per app: augments TimeSeries with study methods

const studied = bars
  .sma({ period: 20 }) // → sma
  .ema({ period: 10, output: 'ema10' }) // name the output column
  .bollinger({ period: 20 }) // → bbUpper / bbMiddle / bbLower
  .rsi({ period: 14 }) // → rsi
  .macd({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }) // → macdLine / macdSignal / macdHist
  .atr({ period: 14 })
  .vwap({ period: 20 });
```

```ts
import { sma, rsi } from '@pond-ts/financial'; // no prototype augmentation
const same = rsi(sma(bars, { period: 20 }), { period: 14 });
```

Rules every study follows:

- `column` selects the input (default `'close'`; multi-input studies read
  `high` / `low` / `close` / `volume` by those names). Any numeric column
  works, including another study's output.
- Periods are **bar counts**, not durations.
- **Length-preserving warm-up**: the first `period − 1` outputs are
  `undefined`; the row count is unchanged, so outputs line up with the source
  and chart directly.
- `output` (or `prefix` for multi-column families) renames outputs; the
  defaults are listed in `API.md`.
- Definitions follow the textbook / pandas conventions (`ewm(adjust=False)`,
  population stdev). Bar-for-bar parity with a specific vendor is not a goal;
  deltas are documented per study.

`import { STUDIES } from '@pond-ts/financial/catalog'` enumerates every study
with its inputs, outputs and parameters at runtime — use it to build UIs or to
let an agent pick a study by description.

## Trading calendar

```ts
import { TradingCalendar } from '@pond-ts/financial';

const nyse = TradingCalendar.fromRules(
  { timeZone: 'America/New_York', open: '09:30', close: '16:00' },
  { from: '2026-01-05', to: '2026-03-31' },
);
// or TradingCalendar.fromSessions(iterableOfSessions) for exchange-supplied sessions

const daily = ticks.aggregate(nyse.sessionSequence(), {
  close: { from: 'price', using: 'last' },
}); // one bar per session
const fiveMin = ticks.aggregate(nyse.barSequence('5m'), {
  close: { from: 'price', using: 'last' },
}); // intraday, never spanning a close
```

Session-aligned buckets never straddle a close, weekends and holidays produce
no buckets, and `@pond-ts/charts` takes the same calendar
(`<ChartContainer calendar={nyse}>`) so the axis skips closed time.

## Pitfalls

1. Forgetting `import '@pond-ts/financial/fluent'` and getting
   `bars.sma is not a function` — or importing it and then also calling the
   function form (fine, just redundant).
2. Passing a duration (`'20m'`) as `period` — studies count bars.
3. Treating warm-up `undefined`s as zeros in downstream maths; filter or
   `fill` deliberately.
4. Building bars with `Sequence.every` across the close, then wondering why
   the first bar of the day is wrong — use `cal.barSequence(period)` / `cal.sessionSequence()`.
5. Version skew between `@pond-ts/financial` and `pond-ts`.

## Read next

- Financial hub: <https://pond-ts.org/docs/financial/> · charts for OHLC: <https://pond-ts.org/docs/charts/financial>
- Single-file dump: <https://pond-ts.org/llms-financial.txt>
- `node_modules/@pond-ts/financial/API.md` — every study, its outputs and parameters.
