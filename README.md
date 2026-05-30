# pond-ts

**Highly optimised, fully typed Timeseries library for TypeScript**

Schema-driven events, composable batch transforms, push-based streaming
ingest, multi-entity partitioning, and an optional React integration —
all strict TypeScript end to end, all immutable.

**pond-ts** is the TypeScript-first successor to
[pondjs](https://github.com/esnet/pond), rewritten from scratch with a
focus on type safety, composability, and the live-streaming patterns
that pondjs never grew.

```sh
npm install pond-ts                 # core
npm install @pond-ts/react          # React hooks (optional)
```

- **Typed schemas** — declare once, every transform downstream narrows
  off it. `event.get('cpu')` returns `number | undefined` straight from
  the schema; no `as` casts.
- **Batch + streaming with the same vocabulary** — `filter`, `map`,
  `aggregate`, `rolling`, `diff`, `rate`, `fill`, `cumulative`,
  `sample`, `reduce` all exist on both `TimeSeries` and `LiveSeries`.
- **Multi-entity by construction** — `partitionBy('host')` routes per
  entity; `rolling` / `aggregate` / `fill` / `sample` over a partitioned
  view all become per-entity automatically.
- **Bounded-memory streaming** — retention policies, eviction-aware
  views, and sampling decouple downstream window length
  from event rate at firehose loads (up to 500k events/sec on a
  single node.js instance.)
- **Triggers** — for control of rolling emission cadences. Synchronised
  partitioned rolling fires across partitions on every boundary.
- **Typed column extraction** — `series.column('cpu')` returns a
  schema-narrowed typed column with single-pass reductions
  (`min`/`max`/`sum`/`mean`/`stdev`/`median`/`percentile`/`minMax`),
  index downsampling (`bin`), and a zero-copy `toFloat64Array()` for
  canvas / WebGL draw loops — no per-event allocation on the hot path.
- **No legacy baggage**

## Quick start: batch

```ts
import { Sequence, TimeSeries } from 'pond-ts';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'requests', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

const cpu = TimeSeries.fromJSON({
  name: 'cpu',
  schema,
  rows: [
    ['2025-01-01T00:00:00Z', 0.31, 120, 'host1'],
    ['2025-01-01T00:01:00Z', 0.44, 135, 'host2'],
    ['2025-01-01T00:02:00Z', 0.52, 141, 'host1'],
    ['2025-01-01T00:03:00Z', 0.48, 128, 'host1'],
    ['2025-01-01T00:04:00Z', 0.63, 166, 'host3'],
  ],
});

const byMinute = cpu.aggregate(Sequence.every('1m'), {
  cpu: 'avg',
  requests: 'sum',
  host: 'last',
});

const bands = cpu.baseline('cpu', { window: '2m', sigma: 2 });
//    ^ appends rolling avg / sd / upper / lower in one pass.

const anomalies = cpu.outliers('cpu', { window: '2m', sigma: 2 });
//    ^ schema-preserving filter — same columns, just the spikes.
```

The full batch surface (`align`, `rolling`, `smooth`, `groupBy`, `join`,
`reduce`, `diff`, `rate`, `fill`, `dedupe`, `materialize`, `sample`,
`partitionBy`, `pivotByGroup`, …) follows the same shape: TimeSeries
in, TimeSeries out, schema preserved.

## Quick start: live (streaming)

```ts
import { LiveSeries, Sequence } from 'pond-ts';

// 1. Same schema; this is a live append buffer with retention.
const live = new LiveSeries({
  name: 'cpu',
  schema,
  retention: { maxAge: '10m' }, // keep only the last 10 minutes
});

// 2. Push as events arrive. Each push is validated against the schema.
live.push([Date.now(), 0.45, 128, 'api-1']);

// 3. Compose live views — incremental, push-driven, eviction-aware.
const recentAvg = live.rolling('5m', { cpu: 'avg' });
recentAvg.on('event', (e) => render(e.get('cpu')));

// 4. Snapshot to a TimeSeries for batch analytics at any time.
const snap = live.toTimeSeries();
```

The full live surface (`filter`, `map`, `select`, `window`, `aggregate`,
`rolling`, `reduce`, `diff`, `rate`, `pctChange`, `fill`, `cumulative`,
`sample`) is incremental — events flow, views emit, retention bounds
memory.

## Quick start: multi-entity

`partitionBy` routes events into per-key buffers. Every stateful
operator downstream of `partitionBy` runs per-partition automatically:

```ts
const perHost = cpu
  .partitionBy('host')
  .rolling('5m', { cpu: 'avg', cpu_sd: 'stdev' });

// .collect() fans the per-partition outputs back into a flat TimeSeries
// with the partition key auto-injected as a column.
const flat = perHost.collect();
```

Same shape on the live side — `live.partitionBy('host')` returns a
`LivePartitionedSeries` whose `rolling` / `fill` / `diff` / `sample`
methods all maintain per-partition state.

## Quick start: bounded-memory sampling

At firehose rates, a long rolling baseline blows the heap. `sample({
stride: N })` decouples baseline length from event rate; chain it
between `partitionBy` and `rolling`:

```ts
// Per-host 1-in-10 stride feeding a per-host 5m baseline.
live
  .partitionBy('host')
  .sample({ stride: 10 })
  .rolling('5m', { cpu_avg: 'avg', cpu_sd: 'stdev' });
```

For visualization, the snapshot side ships reservoir sampling too —
single-pass Algorithm R, sorted by key, fixed point count regardless of
source size:

```ts
const points = series.sample({ reservoir: { size: 500 } }).toRows();
// 500 uncorrelated points drawn uniformly from the source.
```

## Performance

pond-ts is **7.6x faster** than pondjs on average across all comparable
operations, with no regressions. The advantage grows with data size.

| Category          | Speedup (N=16k) | Notes                                         |
| ----------------- | --------------- | --------------------------------------------- |
| **Aggregation**   | 25–32x          | O(N+B) bucketing vs O(N×B) Pipeline           |
| **Alignment**     | 32x             | Forward cursor vs repeated binary search      |
| **Rate/diff**     | 18x             | Direct array walk vs Pipeline materialization |
| **Fill**          | 10–11x          | Single-pass vs Pipeline per strategy          |
| **Transforms**    | 3–16x           | Pre-validated constructor skips re-validation |
| **Construction**  | 7x              | Plain objects vs ImmutableJS wrapping         |
| **Statistics**    | 7–9x            | Direct computation vs ImmutableJS iteration   |
| **Serialization** | 4x              | Simpler internal representation               |
| **Event access**  | 23x             | Array indexing vs ImmutableJS `get()`         |

See the [full benchmark results](website/docs/reference/benchmarks.mdx)
for detailed numbers. Run locally:

```sh
npm run build && node packages/core/bench/vs-pondjs.cjs
```

## Documentation

The full guide is at **<https://pjm17971.github.io/pond-ts/>**.

- **[Start here](https://pjm17971.github.io/pond-ts/docs/)**
  — five-minute walkthrough with batch, live, and React examples.
- **[Concepts](https://pjm17971.github.io/pond-ts/docs/start-here/concepts)**
  — temporal keys, sequences, windowing, partitioning, triggers, late
  data.
- **[Transforms reference](https://pjm17971.github.io/pond-ts/docs/pond-ts/transforms/queries)**
  — every batch operator (queries, aggregation, alignment, rolling,
  smoothing, sampling, cleaning, reshape, anomaly detection).
- **[Live reference](https://pjm17971.github.io/pond-ts/docs/pond-ts/live/live-series)**
  — `LiveSeries`, live transforms, triggering.
- **[How-to guides](https://pjm17971.github.io/pond-ts/docs/how-to-guides)**
  — building a dashboard, ingesting messy data.
- **[API reference (auto-generated)](https://pjm17971.github.io/pond-ts/generated-api/core/)**
  — TypeDoc output, every public class and method.
- **[CHANGELOG](./CHANGELOG.md)** — what shipped in each release.

## Examples

- **[pond-ts-dashboard](https://github.com/pjm17971/pond-ts-dashboard)**
  — a working React dashboard that streams synthetic per-host CPU /
  request metrics, computes per-host rolling baselines, flags anomalies
  against ±σ bands, and renders everything as live line and bar charts
  (~600 lines of TypeScript). Walked through end-to-end in
  [Building a dashboard](website/docs/how-to-guides/dashboard-guide.mdx).

## Develop

The repo is an npm-workspaces monorepo with two published packages
(`pond-ts`, `@pond-ts/react`). Node 18+ for runtime; Node 20+ for the
docs site (Docusaurus).

```sh
npm install         # one-time, hoists deps for both packages
npm run build       # build both packages
npm test            # runtime + type-level tests on both packages
npm run format      # prettier write across the repo
npm run verify      # format check + build + test (CI parity)
```

`packages/core/` is the `pond-ts` package; `packages/react/` is
`@pond-ts/react`. Docs live in `website/`.

## License

MIT
