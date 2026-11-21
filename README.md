# pond

[![npm](https://img.shields.io/npm/v/pond-ts?label=pond-ts)](https://www.npmjs.com/package/pond-ts)
[![crates.io](https://img.shields.io/crates/v/pond-rs?label=pond-rs)](https://crates.io/crates/pond-rs)
[![PyPI](https://img.shields.io/pypi/v/pond-rs?label=pip%20pond-rs)](https://pypi.org/project/pond-rs/)
[![CI](https://github.com/pond-ts/pond/actions/workflows/ci.yml/badge.svg)](https://github.com/pond-ts/pond/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/pond-ts)](https://github.com/pond-ts/pond/blob/main/LICENSE)
[![docs](https://img.shields.io/badge/docs-pond--ts.org-1f6feb)](https://pond-ts.org)

**Time series you can trust, from a batch of history to a live stream to the chart on screen.**

pond is for data that is a list of readings over time: server metrics, prices,
sensor and meter readings, heart rate on a run. You describe your columns once,
then ask the questions you actually have: the average per minute, a rolling
five-minute window, the same thing per host, one row per calendar day in New
York (including the 23-hour day when the clocks change), which readings are
out of the ordinary. The same operations work on a fixed batch of history and
on a live stream that keeps itself up to date as events arrive, and the chart
package draws the results directly, with no conversion step.

It is written in TypeScript, fully typed, and has a Rust twin, **pond-rs**,
that gives the same answers bit for bit and can be used from Rust, from
JavaScript (as WebAssembly) and from Python. pond-ts is the from-scratch
successor to [pondjs](https://github.com/esnet/pond).

<p align="center">
  <img src="docs/readme/tour.gif" alt="44 years of daily Pacific sea temperature in three parts: zooming from the whole record down to individual days and back, a one-year rolling window sweeping across the record and back, and bars of temperature against normal re-bucketed from one month to two years and back, with El Niño years in red and La Niña years in blue" width="880">
</p>

<sub>The real library on real data: 16,275 days of sea-surface temperature in
the Niño 3.4 region of the Pacific (NOAA OISST v2.1), the record that defines
El Niño. Every frame is recomputed by pond, using the call shown at the top of
the card: `within` plus `aggregate` to keep the zoom at about one bucket per
few pixels, `rolling` for the moving window, and `aggregate(Sequence.every(…))`
for the bars, drawn by `@pond-ts/charts`. Source and recorder:
[`docs/readme/demo/`](docs/readme/demo/).</sub>

## What's in this repository

**TypeScript packages** (npm, all released together under one version):

| Package                                                                  | What it's for                                                                                                                                               | Folder               |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| [`pond-ts`](https://www.npmjs.com/package/pond-ts)                       | The core. `TimeSeries` for data you have, `LiveSeries` for data still arriving, one set of operations for both. Runs in Node or the browser.                | `packages/core`      |
| [`@pond-ts/charts`](https://www.npmjs.com/package/@pond-ts/charts)       | React charts drawn on canvas that take a pond series as-is: line, area, band, bar, scatter, box, candlestick, heat map; cursors, selection, pan and zoom.   | `packages/charts`    |
| [`@pond-ts/react`](https://www.npmjs.com/package/@pond-ts/react)         | React hooks that hold a live series in a component and re-render it at a steady pace however fast events arrive.                                            | `packages/react`     |
| [`@pond-ts/financial`](https://www.npmjs.com/package/@pond-ts/financial) | 109 technical studies (moving averages, RSI, MACD, Bollinger, VWAP, Ichimoku, …), each checked against a pandas / TA-Lib reference, plus trading calendars. | `packages/financial` |
| [`@pond-ts/fit`](https://www.npmjs.com/package/@pond-ts/fit)             | Activity data: reads FIT / GPX / TCX files; distance, elevation, power, heart-rate zones, splits.                                                           | `packages/fit`       |
| [`@pond-ts/process`](https://www.npmjs.com/package/@pond-ts/process)     | **Experimental.** A whole calculation written down as data (JSON), so a program or an AI model can build one, run it, and cache the result.                 | `packages/process`   |

**pond-rs, the Rust version** — same operations, same results as pond-ts (a
test suite checks every operation against output written by pond-ts):

| Package                                                        | What it's for                                                                                                     | Folder           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| [`pond-rs`](https://crates.io/crates/pond-rs) (crates.io)      | The Rust library: batch and live series, all 109 studies, Arrow files in and out, work spread over several cores. | `crates/pond-rs` |
| [`@pond-ts/wasm`](https://www.npmjs.com/package/@pond-ts/wasm) | pond-rs compiled to WebAssembly for Node and browsers, called with pond-ts's method names.                        | `packages/rs`    |
| [`pond-rs`](https://pypi.org/project/pond-rs/) (PyPI)          | pond-rs from Python. pandas, polars and pyarrow tables go in and come back out.                                   | `crates/pond-py` |

How fast: across the 173 benchmark cases measured while building it, pond-rs
on 4 cores was faster than pond-ts in 170, with a median of 7.5× (6.8× on a
single core), and was about even with polars overall
([full comparison](crates/pond-rs/bench/COMPARISON.md)). pond-ts itself is
20.7× faster than its predecessor pondjs on average across 54 shared
operations ([Performance](#performance) below).

**Also here:** the docs site [pond-ts.org](https://pond-ts.org) (`website/`), a
Claude Code plugin with skills for using pond (`plugins/pond-ts`), worked
example apps (`apps/`: a live chart drawn off the main thread, and a demo of
`@pond-ts/process`), and the roadmap and design notes ([PLAN.md](PLAN.md),
`docs/`).

```sh
npm install pond-ts                                   # core: enough for Node pipelines and non-React apps
npm install @pond-ts/charts @pond-ts/react pond-ts    # add the React chart stack
cargo add pond-rs                                     # Rust
pip install pond-rs                                   # Python
```

## What the core does

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

## Quick start: charts (React)

`@pond-ts/charts` reads a `TimeSeries` or `LiveSeries` directly — do the maths
in pond, hand the result to a layer. Rows share one x scale, so they pan,
zoom and track the cursor together.

```tsx
import {
  BandChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  CrosshairCursor,
} from '@pond-ts/charts';

// `bands` is the baseline() result from the batch quick start:
// cpu + avg / sd / upper / lower columns.
export function CpuChart({ width }: { width: number }) {
  return (
    <ChartContainer width={width} panZoom>
      <CrosshairCursor />
      <ChartRow height={240}>
        <YAxis id="cpu" format=".0%" />
        <Layers>
          <BandChart series={bands} lower="lower" upper="upper" axis="cpu" />
          <LineChart series={bands} column="cpu" axis="cpu" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
```

Pass `width="auto"` to measure the parent instead. Live data renders through
the same layers: own the series with `useLiveSeries` from `@pond-ts/react`
and pass its snapshot as `series`.

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

Measured against three reference points (snapshot 2026-07-30; full tables,
methodology, and every losing number in the
[benchmark reference](website/docs/reference/benchmarks.mdx)):

- **vs pondjs** (the predecessor): faster on all 54 measurable shared
  operations — geometric mean **20.7×**, `aggregate` up to 453×,
  `median` 157×, and `select` / `rename` effectively instant (O(1)
  column rebinds).
- **vs pandas** (500k-bar workload): roughly **even** — ahead on `ema`,
  `mean`, `median` / `percentile`; behind ~1.1–1.9× on the rolling
  studies. A five-study strategy pass runs 1.28× slower than pandas'
  Cython kernels.
- **vs polars, single-threaded**: **ahead on composite studies**
  (`bollinger` 0.53×, strategy stack 0.85×, `ema` 0.32× — lower is
  pond-ts faster), behind 4–9× on whole-column reductions (the SIMD gap;
  half-closed already by blocked summation) and on raw ingest, where
  pond-ts front-loads validation the dataframe engines defer.
- **vs polars on all 10 cores**: behind ~3.5× on the strategy stack —
  pond-ts has no parallelism today; a measured 2.42× worker-thread path
  is on the roadmap (`[PND-PROCPAR]`).

The honest one-line version: the rewrite beat its predecessor by an order
of magnitude, holds its own per-core against the native engines on the
composite queries that dominate real workloads, and knows exactly where
it is behind. Run locally:

```sh
npm run build && node packages/core/bench/vs-pondjs.cjs
```

## Domain packages

Optional, domain-specific, all on plain pond series:

- **[`@pond-ts/financial`](https://www.npmjs.com/package/@pond-ts/financial)**
  — 109 oracle-verified technical studies (SMA, EMA, RSI, MACD,
  Bollinger, ATR, VWAP, …) that append columns to a bar series, a fluent
  `bars.sma({ period: 20 }).rsi({ period: 14 })` form, and a
  `TradingCalendar` so session-aligned bars, rolling windows and chart axes
  stop at the close.
- **[`@pond-ts/fit`](https://www.npmjs.com/package/@pond-ts/fit)** — fitness
  and activity analytics: typed quantities with units, canonical activity
  series, geo (distance, elevation, best efforts), power (NP / IF / TSS,
  curves), heart-rate zones, splits.
- **[`@pond-ts/process`](https://www.npmjs.com/package/@pond-ts/process)** —
  **experimental.** Computations as data: processing graphs authored fluently
  or composed as JSON, resolved against a declared op vocabulary with
  content-addressed caching, provenance and per-node timings. The API is
  expected to move.

## Documentation

The full guide is at **<https://pond-ts.org/>**.

- **[Start here](https://pond-ts.org/docs/)**
  — five-minute walkthrough with batch, live, and React examples.
- **[Concepts](https://pond-ts.org/docs/start-here/concepts)**
  — temporal keys, sequences, windowing, partitioning, triggers, late
  data.
- **[Transforms reference](https://pond-ts.org/docs/pond-ts/transforms/queries)**
  — every batch operator (queries, aggregation, alignment, rolling,
  smoothing, sampling, cleaning, reshape, anomaly detection).
- **[Live reference](https://pond-ts.org/docs/pond-ts/live/live-series)**
  — `LiveSeries`, live transforms, triggering.
- **[How-to guides](https://pond-ts.org/docs/how-to-guides)**
  — building a dashboard, ingesting messy data.
- **[API reference (auto-generated)](https://pond-ts.org/generated-api/core/)**
  — TypeDoc output, every public class and method.
- **[CHANGELOG](./CHANGELOG.md)** — what shipped in each release.

## Versioning

All seven npm packages (the six above plus `@pond-ts/wasm`, pond-rs compiled
to WebAssembly) release together under one version — keep them in step.

- **Today (0.x):** a minor release may contain breaking changes; each is
  marked **breaking** in the [CHANGELOG](./CHANGELOG.md) with a migration
  note. Patch releases never break.
- **From 1.0:** [semver](https://semver.org/) — breaking changes only in a
  major release.
- **Public API:** the exports of each package's entry points, mapped in
  [API.md](API.md). Anything marked experimental (including all of
  `@pond-ts/process`) or internal is excluded.

Details: [pond-ts.org/docs/reference/versioning](https://pond-ts.org/docs/reference/versioning).

## For coding agents

pond is built by agents and expects to be used by them. Three things exist so
an agent can go from "never heard of pond" to working code without a human in
the loop:

- **`AGENTS.md` + `API.md` ship inside every npm tarball** —
  `node_modules/pond-ts/AGENTS.md` is a one-read guide (which package for
  which task, the idioms, the mistakes agents make); `API.md` maps every
  public export to its source file. Source:
  [docs/agents/USING_POND.md](docs/agents/USING_POND.md), [API.md](API.md).
- **<https://pond-ts.org/llms.txt>** — every docs page with a one-line
  description, plus `llms-<area>.txt` single-fetch dumps per package.
- **Claude Code plugin** — skills for core, charts and financial, versioned
  with the library:
  ```
  /plugin marketplace add pond-ts/pond
  /plugin install pond-ts@pond-ts
  ```

## Examples

- **[pond-ts-dashboard](https://github.com/pjm17971/pond-ts-dashboard)**
  — a working React dashboard that streams synthetic per-host CPU /
  request metrics, computes per-host rolling baselines, flags anomalies
  against ±σ bands, and renders everything as live line and bar charts
  (~600 lines of TypeScript). Walked through end-to-end in
  [Building a dashboard](website/docs/how-to-guides/dashboard-guide.mdx).

## Develop

The repo is an npm-workspaces monorepo with six published packages
(`pond-ts`, `@pond-ts/react`, `@pond-ts/charts`, `@pond-ts/financial`,
`@pond-ts/fit`, `@pond-ts/process`). Node 18+ for runtime; Node 20+ for the
docs site (Docusaurus).

```sh
npm install         # one-time, hoists deps for all packages
npm run build       # build both packages
npm test            # runtime + type-level tests on both packages
npm run format      # prettier write across the repo
npm run verify      # format check + build + test (CI parity)
```

Each package lives under `packages/<name>/` (`core` is `pond-ts`, the rest
match their scoped names). Docs live in `website/` — its own npm root, not a
workspace.

## License

MIT
