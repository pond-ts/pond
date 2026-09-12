---
name: pond-ts
description: Working with timestamped rows in TypeScript or Node — loading metrics, logs, sensor, telemetry or price data; bucketing / downsampling to 1-minute or 5-minute intervals; rolling averages, rolling percentiles, baselines and anomaly bands; regridding or gap-filling; per-host / per-symbol / per-entity statistics; joining series; keeping rolling stats over a live stream with bounded memory — using the pond-ts library (typed immutable TimeSeries + streaming LiveSeries). Use whenever a project has or would benefit from pond-ts instead of hand-rolled array loops.
---

# Time series with `pond-ts`

Typed, immutable time series with one operator vocabulary for batch
(`TimeSeries`) and streaming (`LiveSeries`). Every operator returns a new
series of a known schema, so you chain. Before writing array loops over
timestamped rows, check whether one of the operators below is the job.

```sh
npm install pond-ts
```

Two files ship inside the package and are worth opening once:
`node_modules/pond-ts/AGENTS.md` (this guide, longer) and
`node_modules/pond-ts/API.md` (every export → purpose → source file).

## 1. Schema first, then a series

```ts
import { TimeSeries, Sequence } from 'pond-ts';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'latencyMs', kind: 'number' },
] as const; // required — without it every column type widens to string

const s = TimeSeries.fromJSON({ name: 'latency', schema, rows, sort: true });
// rows: [time, host, latencyMs] tuples or { time, host, latencyMs } objects.
// time: ms number | Date | ISO string WITH offset. Wall-clock strings need parse: { timeZone }.
```

Other constructors: `fromPoints` (wide `{ ts, … }` rows), `fromColumns`
(struct-of-arrays / `Float64Array`), `fromArrow`, `fromEvents`. `toJSON()`
round-trips. Kinds: `time`, `number`, `string`, `boolean`, `array`.

## 2. Pick the verb

| Job                                             | Call                                                                                                                  | Rows out            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Downsample into buckets                         | `s.aggregate(Sequence.every('5m'), { latencyMs: 'avg', n: { from: 'latencyMs', using: 'count' } })`                   | one per bucket      |
| Put rows on a regular grid, no reduction        | `s.align(Sequence.every('10s'), { method: 'hold' \| 'linear' })`                                                      | one per grid point  |
| Sliding statistic                               | `s.rolling('5m', { latencyMs: 'avg' })` · `s.rolling({ count: 100 }, …)` for a count window (a bare number is **ms**) | one per input event |
| Rolling mean ± kσ bands in one pass             | `s.baseline('latencyMs', { window: '1h', sigma: 2 })` → `avg / sd / upper / lower`                                    | one per input event |
| Only the rows outside the band                  | `s.outliers('latencyMs', { window: '1h', sigma: 2 })`                                                                 | subset              |
| Whole-series summary                            | `s.reduce({ latencyMs: 'p99' })` or `s.column('latencyMs').percentile(99)`                                            | one value           |
| Fill gaps                                       | `s.fill({ latencyMs: 'hold' \| 'linear' \| 'zero' \| 'bfill' })`                                                      | same                |
| Drop duplicate keys                             | `s.dedupe()`                                                                                                          | fewer               |
| Rate of change                                  | `s.diff()`, `s.rate()`, `s.pctChange()`, `s.cumulative()`                                                             | same                |
| Smooth a noisy column                           | `s.smooth('latencyMs', 'ema', { alpha: 0.3 })` — methods `ema` / `movingAverage` / `loess`; `output` renames          | same                |
| Time-range slicing                              | `s.within(range)`, `s.tail('10m')`, `s.before(t)`, `s.after(t)`, `s.slice(i, j)`                                      | subset              |
| Columns                                         | `s.select('a', 'b')`, `s.rename({ a: 'b' })`, `s.map(…)`, `s.withColumn(…)`                                           | same                |
| Join two series on time                         | `a.join(b)`; many: `TimeSeries.joinMany([...])`                                                                       | union / inner       |
| Group by a column value                         | `s.groupBy('host')` → `Map<string, TimeSeries>`                                                                       | groups              |
| Histogram: bin a numeric column, reduce per bin | `s.byColumn('latencyMs', { width: 50 }, { n: { from: 'latencyMs', using: 'count' } })` — or `{ edges: [...] }`        | one per bin         |
| Key by a quantity instead of time               | `s.byValue('distanceKm')` → `ValueSeries` (same operators minus calendar ones)                                        | same                |

Reducers: `sum avg mean min max count first last median stdev difference`
and `p<N>` (`'p95'`); `keep unique samples top<N>` for non-numeric columns.
Mapping keys are output names; `{ from, using }` renames or reuses a source.

`Sequence.every()` accepts fixed durations only (`'10s' '5m' '1h' '1d'`).
Months / calendar days in a zone: `Sequence.calendar('month', { timeZone })`.

## 3. Per-entity

```ts
const perHost = s
  .partitionBy('host') // every stateful operator below runs per host
  .fill({ latencyMs: 'hold' })
  .rolling('5m', { latencyMs: 'avg' })
  .collect(); // flat TimeSeries with `host` re-injected; or .toMap()
```

## 4. Read out

```ts
s.toPoints(); // [{ ts, host, latencyMs }] — feed other chart libraries
s.toRows(); // positional tuples;  s.toObjects(); s.toColumns(); s.toArrow()
s.column('latencyMs').mean(); // typed column: min max sum mean stdev median percentile minMax
s.column('latencyMs').toFloat64Array(); // zero-copy for draw loops
s.first();
s.last();
s.at(i);
s.length;
s.timeRange();
for (const e of s.events) e.get('latencyMs'); // number | undefined
```

## 5. Streaming

```ts
import { LiveSeries } from 'pond-ts';

const live = new LiveSeries({
  name: 'latency',
  schema,
  retention: { maxAge: '15m' }, // or { maxEvents: 10_000 } — bounds memory
  ordering: 'reorder', // or 'strict' (default, throws on late) / 'drop'
  graceWindow: '5s',
});

const view = live.partitionBy('host').rolling('5m', { latencyMs: 'avg' });
const unsubscribe = view.on('event', (e) => {
  /* incremental output */
});

live.push([Date.now(), 'api-1', 42]);
live.pushMany(rows);
live.toTimeSeries(); // immutable snapshot for batch analytics
```

Live views: `filter map select window aggregate rolling reduce diff rate
pctChange fill cumulative sample`. `live.aggregate(seq, …)` emits `'bucket'`
(partial) and `'close'` (final). At firehose rates put `sample({ stride: N })`
between `partitionBy` and a long `rolling`. React: `@pond-ts/react`
(`useLiveSeries`, `useSnapshot`, …); drawing: `@pond-ts/charts`.

## Pitfalls

1. Missing `as const` → all columns `string`, nothing errors.
2. `aggregate` vs `rolling` vs `align`: bucket-count rows / input-count rows / grid rows.
3. `Sequence.every('1M')` → use `Sequence.calendar('month', …)`.
4. Wall-clock ISO strings without a zone throw; ms numbers and `Z` strings do not.
5. Out-of-order input throws with the row index → `sort: true`.
6. Nothing mutates; `TimeSeries` has no `push` — that is `LiveSeries`.
7. Iterating `events` in a render loop — use `column(...)` / `toFloat64Array()`.
8. All `pond-ts` / `@pond-ts/*` packages at one version (`^0.x` does not span minors).

## Read next

- Mental model + pandas / pondjs translation tables: <https://pond-ts.org/docs/pond-ts/mental-model>
- Every operator page: <https://pond-ts.org/llms.txt> (index) · <https://pond-ts.org/llms-pond-ts.txt> (core docs, one file)
- Reducer reference: <https://pond-ts.org/docs/pond-ts/transforms/reducer-reference>
- `node_modules/pond-ts/API.md`
