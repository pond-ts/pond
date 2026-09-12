# @pond-ts/financial

[![npm](https://img.shields.io/npm/v/@pond-ts/financial?label=%40pond-ts%2Ffinancial)](https://www.npmjs.com/package/@pond-ts/financial)
[![CI](https://github.com/pond-ts/pond/actions/workflows/ci.yml/badge.svg)](https://github.com/pond-ts/pond/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-pond--ts.org-1f6feb)](https://pond-ts.org/docs/financial/)

**Technical studies and a trading calendar on [pond-ts](https://www.npmjs.com/package/pond-ts).**

Twenty oracle-verified studies (moving averages, bands, RSI, MACD, ATR,
stochastics, Donchian, OBV, VWAP, …) that append columns to a bar
`TimeSeries`, plus a `TradingCalendar` that knows when the market is open so
rolling windows, bucketing and chart axes stop at the close. Pure
computation: browser + Node, no data fetching, no rendering, no React (the
chart side lives in `@pond-ts/charts`).

```sh
npm install @pond-ts/financial pond-ts
```

`pond-ts` is a peer dependency; the pond packages release together, so keep
their ranges in step.

## Quick start

A study takes a series and options and returns the series with more columns
on it. Import the fluent entry once and chain them:

```ts
import '@pond-ts/financial/fluent';

const study = bars // a TimeSeries with open/high/low/close/volume columns
  .bollinger({ period: 20 })
  .ema({ period: 10 })
  .rsi({ period: 14 })
  .macd({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 })
  .vwap({ period: 20 });
// + bbUpper/bbMiddle/bbLower, ema, rsi, macdLine/macdSignal/macdHist, vwap
```

Every study is also a plain function, for code that would rather not augment
`TimeSeries`:

```ts
import { bollinger, ema } from '@pond-ts/financial';

const same = ema(bollinger(bars, { period: 20 }), { period: 10 });
```

Each study reads a column (default `'close'`, or the named `high` / `low` /
`close` / `volume` inputs for the multi-input ones) so it runs over any
numeric column, including another study's output. Periods are bar counts.
Warm-up rows are `undefined` and the row count is preserved, so the result
lines up on the source's time axis.

A trading calendar turns "5-minute bars" into session-aligned bars — no
weekend or holiday buckets, no bar spanning the close:

```ts
import { TradingCalendar } from '@pond-ts/financial';

const cal = TradingCalendar.fromRules(
  { timeZone: 'America/New_York', open: '09:30', close: '16:00' },
  { from: '2026-01-05', to: '2026-02-13' },
);

const fiveMin = ticks.aggregate(cal.barSequence('5m'), {
  close: { from: 'price', using: 'last' },
});
cal.isOpen(instant); // inside a session and not inside a break
```

## What's in the box

- **Studies** — verified bar-for-bar against a pandas oracle before they
  ship, the named indicators against TA-Lib as well:
  - _averages and bands_: `sma`, `ema`, `bollinger`, `envelope`, `donchian`,
    `vwap`
  - _oscillators_: `rsi`, `macd`, `stochastic`, `williamsR`, `momentum`,
    `percentChange`, `zScore`, `obv`
  - _volatility and range_: `atr`, `historicalVolatility`, `rollingStdev`,
    `rollingMin`, `rollingMax`, `rollingPercentile`
- **`@pond-ts/financial/fluent`** — mounts every study as a `TimeSeries`
  method (opt-in by import; ESM only).
- **`TradingCalendar`** — `fromRules` (hours, `weekmask`, `holidays`,
  `breaks`, `earlyCloses`, resolved DST-correctly in the exchange's time zone)
  or `fromSessions` (an explicit list); `sessions()`, `sessionOn()`,
  `isTradingDay()`, `isOpen()`, `sessionSequence()` / `barSequence()` for
  bucketing, and `tagSessions()` to key a `partitionBy` so stateful ops never
  bridge a close.
- **Discontinuity providers** — `weekendSkip()`, `segmentDiscontinuity()`,
  `identityDiscontinuity()` and `calendar.discontinuities()`: the d3fc-style
  five-method surface a trading-time axis consumes. `@pond-ts/charts` reads it
  structurally, so there is no package coupling.
- **`@pond-ts/financial/parallel`** — Node-only: `.withWorkers()` runs the
  rolling studies across worker threads for large partitioned series.

Bar-for-bar vendor parity is a non-goal: where a study deliberately departs
from TA-Lib (a flat window is `undefined`, not `0`; a gap in a running sum
propagates rather than being skipped) the docstring says so and a test pins
it.

## Documentation

Guides, live examples and the full API live at **<https://pond-ts.org>** — the
[package page](https://pond-ts.org/docs/financial/) and the
[financial charts hub](https://pond-ts.org/docs/charts/financial).
Source and issues: [github.com/pond-ts/pond](https://github.com/pond-ts/pond).

## License

MIT
