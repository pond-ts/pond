# Using pond from a coding agent

You are reading this because a project depends on `pond-ts` or one of the
`@pond-ts/*` packages, or because you are deciding whether it should. This
file is the shortest route to correct code. It ships inside every pond
tarball as `AGENTS.md`, next to `API.md` (every public export, one line
each, with its source file) and `CHANGELOG.md`.

Docs: <https://pond-ts.org> · index for agents: <https://pond-ts.org/llms.txt>
· source: <https://github.com/pond-ts/pond>.

## What pond is, in three lines

- A **typed, immutable time series** (`TimeSeries`) whose schema is declared
  once `as const` and narrows every downstream transform — no casts.
- The **same operator vocabulary on a streaming buffer** (`LiveSeries`):
  push events in, subscribe to incremental `rolling` / `aggregate` views,
  bounded by retention.
- **Domain packages on top**: React hooks, canvas charts that read a series
  directly, financial studies + trading calendars, fitness analytics, and an
  experimental processing-graph runtime.

## Which package

| You need to…                                                            | Install                              | Import from                                           |
| ----------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| Load timestamped rows; bucket, regrid, roll, fill, join, partition them | `pond-ts`                            | `'pond-ts'`                                           |
| Ingest a live feed and keep rolling stats over the last N minutes       | `pond-ts`                            | `'pond-ts'` (`LiveSeries`)                            |
| Share a series' type across a wire boundary with zero runtime           | `pond-ts`                            | `'pond-ts/types'`                                     |
| Own / subscribe to a series inside React                                | `@pond-ts/react`                     | `'@pond-ts/react'`                                    |
| Draw it (line, area, band, bar, scatter, box, candlestick, heat map)    | `@pond-ts/charts` (+ react, pond-ts) | `'@pond-ts/charts'`                                   |
| OHLCV bars, SMA/EMA/RSI/MACD/Bollinger/ATR/VWAP…, market-hours calendar | `@pond-ts/financial`                 | `'@pond-ts/financial'`, `'@pond-ts/financial/fluent'` |
| GPS / power / heart-rate activity analytics                             | `@pond-ts/fit`                       | `'@pond-ts/fit'`                                      |
| Computations as JSON plans with caching + provenance (experimental)     | `@pond-ts/process`                   | `'@pond-ts/process'`                                  |

All six release together under one version. Keep their ranges in step — a
pre-1.0 caret (`^0.67.0`) does **not** span minors.

## The idioms that cover most jobs

### 1. Declare the schema, build the series

```ts
import { TimeSeries, Sequence } from 'pond-ts';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'latencyMs', kind: 'number' },
] as const; // ← load-bearing. Without it every column widens to string.

const s = TimeSeries.fromJSON({
  name: 'latency',
  schema,
  rows, // positional tuples [time, host, latencyMs] or objects { time, host, latencyMs }
  sort: true, // input not already time-ordered? sort on construction (stable)
});
```

Time cells accept ms-since-epoch numbers, `Date`s, or ISO strings **with an
offset** (`…Z`, `…+01:00`). A wall-clock string with no offset throws unless
you pass `parse: { timeZone: 'America/New_York' }`.

Other doors: `TimeSeries.fromPoints(points)` for wide `{ ts, a, b }` rows,
`fromColumns` for struct-of-arrays / `Float64Array`, `fromArrow` for an Arrow
table, `fromEvents`. `toJSON()` round-trips.

### 2. Downsample, regrid, slide — three different verbs

```ts
// Fewer rows out than in: one row per bucket.
const perMin = s.aggregate(Sequence.every('1m'), {
  latencyMs: 'avg', // reducer by column …
  p95: { from: 'latencyMs', using: 'p95' }, // … or a named output; reducers: sum avg min max count first last median stdev pNN
  host: 'last',
});

// Same information, on a regular grid (hold / interpolate). No reduction.
const gridded = s.align(Sequence.every('10s'), { method: 'hold' });

// One output per input event, looking back over a window.
const rolled = s.rolling('5m', {
  latencyMs: 'avg',
  sd: { from: 'latencyMs', using: 'stdev' },
});
```

`Sequence.every()` takes fixed durations only (`'10s'`, `'5m'`, `'1h'`,
`'1d'`). Months, weeks-in-a-zone, calendar days: `Sequence.calendar('month',
{ timeZone })`. Common shortcuts: `s.baseline('latencyMs', { window: '1h',
sigma: 2 })` appends avg / sd / upper / lower in one pass;
`s.outliers(col, { window, sigma })` keeps only the rows outside the band.

### 3. Per-entity, then flatten

```ts
const perHost = s
  .partitionBy('host') // every stateful operator below runs per host
  .rolling('5m', { latencyMs: 'avg' })
  .collect(); // one flat TimeSeries, `host` re-injected as a column
// or .toMap() → Map<host, TimeSeries>
```

### 4. Clean, fill, join, read out

```ts
const clean = s.dedupe().fill({ latencyMs: 'hold' }); // also 'linear', 'zero', gap caps
const joined = a.join(b); // on the time key; see API.md for options
clean.toPoints(); // [{ ts, host, latencyMs }, …] — chart-library friendly
clean.toRows(); // positional tuples
clean.column('latencyMs').mean(); // typed column: min/max/sum/mean/stdev/median/percentile
clean.column('latencyMs').toFloat64Array(); // zero-copy for canvas / WebGL loops
```

Everything returns a **new** series. There is no `push` on a `TimeSeries`;
if you are appending, you want a `LiveSeries`.

### 5. Streaming

```ts
import { LiveSeries, Sequence } from 'pond-ts';

const live = new LiveSeries({
  name: 'latency',
  schema,
  retention: { maxAge: '15m' }, // or { maxEvents: 10_000 }
  ordering: 'reorder', // tolerate late rows …
  graceWindow: '5s', // … up to this late
});

const view = live.partitionBy('host').rolling('5m', { latencyMs: 'avg' });
const stop = view.on('event', (e) => render(e.get('host'), e.get('latencyMs')));

live.push([Date.now(), 'api-1', 42]); // validated against the schema
live.pushMany(batch);
const snapshot = live.toTimeSeries(); // immutable batch copy for analytics
```

`live.aggregate(Sequence.every('1m'), …)` emits `'bucket'` (partial) and
`'close'` (final) events. Retention bounds memory; `sample({ stride })`
between `partitionBy` and a long `rolling` bounds it further at firehose
rates.

### React and charts

```tsx
import { useLiveSeries } from '@pond-ts/react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
} from '@pond-ts/charts';

const [live, snap] = useLiveSeries({
  name: 'latency',
  schema,
  retention: { maxAge: '10m' },
});

<ChartContainer width={800} cursor="crosshair" panZoom>
  <ChartRow height={240}>
    <YAxis id="ms" />
    <Layers>
      <LineChart series={snap} column="latencyMs" axis="ms" />
    </Layers>
  </ChartRow>
</ChartContainer>;
```

Charts read a pond series directly — do the maths in pond (`rolling`,
`aggregate`, `align`) and hand the result to a layer. `width` is a pixel
number or `'auto'` (the parent then needs a definite width, or nothing draws).
Hooks: `useTimeSeries`, `useLiveSeries`, `useSnapshot`, `useLiveQuery`,
`useDerived`, `useWindow`, `useCurrent`, `useLatest`.

### Financial

```ts
import '@pond-ts/financial/fluent'; // once, anywhere: adds studies to TimeSeries
import { TradingCalendar } from '@pond-ts/financial';

const studied = bars
  .sma({ period: 20 })
  .rsi({ period: 14 })
  .bollinger({ period: 20 });
// or, function form: sma(bars, { period: 20 })
const cal = TradingCalendar.fromRules(
  { timeZone: 'America/New_York', open: '09:30', close: '16:00' },
  { from: '2026-01-05', to: '2026-02-13' },
);
```

Studies read `'close'` by default, take **bar-count** periods, append
columns, preserve row count (warm-up rows are `undefined`). Sixty-plus of
them; `import { STUDIES } from '@pond-ts/financial/catalog'` lists them at runtime. Session-aligned bars: `ticks.aggregate(cal.barSequence('5m'), {...})`.

## Mistakes agents actually make

1. **Dropping `as const` on the schema.** Everything compiles and every
   column is `string`. If `.get('x')` is not `number | undefined`, this is
   why.
2. **`aggregate` when you meant `rolling`, or vice versa.** `aggregate`
   changes the row count (one per bucket); `rolling` keeps it (one per
   event); `align` puts rows on a grid without reducing.
3. **`Sequence.every('1M')` for months.** Not fixed-length → use
   `Sequence.calendar('month', { timeZone })`.
4. **Wall-clock strings without a zone.** `'2025-01-01T09:00'` throws; add
   `parse: { timeZone }` or use offset strings / ms numbers.
5. **Unsorted rows.** The constructor throws and names the row; pass
   `sort: true` rather than sorting by hand.
6. **Mutating.** Nothing mutates. Capture the return value.
7. **Iterating events in a hot loop for a chart.** Use `column(name)` /
   `toFloat64Array()` or hand the series to `@pond-ts/charts` — do not
   rebuild point arrays per frame.
8. **Mismatched package versions.** All `pond-ts` / `@pond-ts/*` at the same
   version, always.
9. **Reaching for a chart-library adapter first.** If the project uses React,
   `@pond-ts/charts` consumes the series with no adapter; `toPoints()` is the
   bridge for other libraries.

## Where to read next

- `API.md` (this folder) — find any export and its source file.
- <https://pond-ts.org/llms.txt> — every docs page with a one-line
  description; `https://pond-ts.org/llms-<area>.txt` for a single-fetch dump
  of one area (`pond-ts`, `charts`, `financial`, …).
- <https://pond-ts.org/docs/pond-ts/mental-model> — one picture, and the
  pandas / pondjs translation tables.
- <https://pond-ts.org/docs/how-to-guides> — end-to-end builds with the
  friction already ironed out (dashboard, messy CSV ingest, histograms,
  large series).
- Claude Code users: `/plugin marketplace add pond-ts/pond` then
  `/plugin install pond-ts@pond-ts` installs skills for core, charts and
  financial.
