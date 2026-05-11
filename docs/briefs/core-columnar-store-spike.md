# Brief: core columnar store spike

**For:** pond-ts core maintainers.
**From:** Codex, 2026-05-10.
**Status:** spike sketch — not a binding work commitment.
**Cross-references:**

- [`PLAN.md`](../../PLAN.md) — current binding decision: row-oriented
  `Event[]` storage stays in core; columnar storage lives at the chart
  boundary for now.
- [`docs/rfcs/charts.md`](../rfcs/charts.md) — chart package commits to
  typed-array columnar buffers via `ChartDataSource`.
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — current batch/live/core layering
  and trusted-construction patterns.

## Goal

Test whether converting pond's internal core representation from row-oriented
`Event[]` storage to a hidden columnar store would produce enough memory and
throughput improvement to justify revisiting the current PLAN decision.

This is deliberately a spike, not a roadmap item. The deliverable is evidence:
heap numbers, benchmark numbers, and a short recommendation on whether the
hybrid design is worth an RFC later.

## Context

The current core stores one `Event` object per row. Each event owns:

- an `EventKey` object (`Time`, `TimeRange`, or `Interval`)
- a frozen payload object keyed by column name
- object/array allocations around construction, transforms, and export paths

That shape is excellent for the public API:

```ts
series.at(0)?.get('cpu');
for (const event of series) event.data();
series.events;
```

It is less ideal for large scans. Numeric reducers repeatedly walk event
objects, load payload fields by string key, and allocate result events. A
columnar store would instead keep:

- key arrays (`beginMs`, `endMs`, optional interval labels)
- one typed array per numeric/boolean column
- string and array columns in side tables
- one validity bitmap per nullable/optional column

The likely win is lower heap use, better cache locality, less property lookup,
and faster reducer/rolling/fill scans. The likely cost is complexity around
`Event` ergonomics, `LiveSeries` eviction, and the public `.events` property.

## Arrow Alignment

If this spike moves past a toy store, align the internal vocabulary with Apache
Arrow where it helps:

- store values in contiguous buffers
- represent missingness with a validity bitmap
- keep string columns dictionary-encodable
- keep array columns offset-addressable rather than nested JS arrays where
  practical
- think in batches/chunks, not only one monolithic growable array

The goal is not "depend on Arrow immediately." The first goal is to avoid
inventing an incompatible columnar shape. If the spike succeeds, a later RFC can
decide whether pond should:

1. keep a lightweight Arrow-inspired internal store,
2. expose zero-copy export to Arrow vectors/tables, or
3. use Arrow JS directly for some buffers.

Default stance for the spike: Arrow-compatible concepts, pond-owned runtime
objects. Pulling in Arrow JS as a dependency should require evidence that it
saves more complexity than it adds in bundle size, typing, and mutation model.

## Non-goals

- Do not break the public `Event` API.
- Do not remove or rename `TimeSeries.events`.
- Do not make `Event` a plain interface in the spike.
- Do not convert every operator before proving the storage win.
- Do not touch the chart RFC's `ChartDataSource` path; that remains the
  near-term columnar boundary.

## Core Hypothesis

Hybrid B from `PLAN.md` is the only plausible core direction:

> columnar internals + row/Event API outside.

The spike should prove or disprove this specific version:

- `TimeSeries` owns a private `ColumnarStore<S>`.
- Public row APIs materialize `Event` objects lazily.
- Hot analytical paths read directly from the store.
- Derived series build stores directly where possible.
- `LiveSeries` remains row-oriented until batch results justify a second spike.

If batch cannot show clear wins without wrecking ergonomics, live should not be
touched.

## Prototype Shape

Add an internal-only store, probably under `packages/core/src/internal/`:

```ts
type ColumnarStore<S extends SeriesSchema> = {
  readonly schema: S;
  readonly length: number;
  readonly chunks?: ReadonlyArray<ColumnarChunk<S>>;
  readonly keyKind: 'time' | 'timeRange' | 'interval';
  readonly beginMs: Float64Array;
  readonly endMs: Float64Array;
  readonly intervalValues?: ReadonlyArray<string | number>;
  readonly columns: ReadonlyMap<string, ColumnBuffer>;
};

type ColumnBuffer =
  | { kind: 'number'; values: Float64Array; validity?: Uint8Array }
  | { kind: 'boolean'; values: Uint8Array; validity?: Uint8Array }
  | {
      kind: 'string';
      dictionary?: ReadonlyArray<string>;
      indices?: Int32Array;
      values?: ReadonlyArray<string | undefined>;
      validity?: Uint8Array;
    }
  | {
      kind: 'array';
      offsets?: Int32Array;
      values?: ColumnBuffer;
      fallback?: ReadonlyArray<readonly unknown[] | undefined>;
      validity?: Uint8Array;
    };
```

The sketch intentionally uses Arrow-ish words (`validity`, `dictionary`,
`indices`, `offsets`, `chunks`) while leaving implementation freedom. A phase-1
numeric spike can ignore dictionary/offset encoding and keep strings/arrays in
fallback side arrays, but the shape should not block that upgrade.

For the spike, keep the existing constructor and build both representations:

```ts
this.events = validateAndNormalize(input);
this.#store = ColumnarStore.fromEvents(this.schema, this.events);
```

That is intentionally wasteful. It isolates the question "are columnar scans
faster?" before taking on the harder question "can columnar replace events?"

Only if phase 1 wins should phase 2 remove eager `events` construction.

## Phase 1: Sidecar Store and Read-Only Benchmarks

Add the sidecar store behind a feature branch or isolated experiment commit.
Keep all public behavior exactly as-is.

Implement store-backed versions of read-heavy paths only:

- `reduce`
- `aggregate` for time-keyed point series
- event-driven `rolling`
- `fill` on numeric columns
- `toPoints` / chart-facing extraction if still in core

Do not rewrite transforms such as `select`, `rename`, `collapse`, `map`, or
`arrayExplode` yet. They stress schema rewriting and event materialization
rather than the raw scan advantage.

Benchmark against existing event-backed code using compiled core output:

- 100k, 1M events
- 1, 5, 20 numeric columns
- sparse optional columns with 10%, 50%, 90% validity
- mixed string + numeric schemas
- dictionary-friendly string columns such as `host` with 10, 100, 10k distinct
  values
- partitioned workloads where per-partition sub-series multiply allocation
- chunk sizes of 4k, 16k, and monolithic arrays

Measure:

- median runtime
- p95 runtime
- heap used after construction
- heap used after the benchmark operation
- GC observations where possible
- optional Arrow export/import cost if a thin adapter is easy to prototype

Decision gate:

- Continue only if at least two high-value operations improve by 25%+ runtime
  or 35%+ heap on realistic 100k+ workloads.
- Stop if wins show up only in synthetic wide-numeric cases that current users
  do not hit.

## Phase 2: Lazy Event Materialization

If phase 1 wins, test replacing eager `events` construction for `TimeSeries`
only.

Shape:

- Constructor validates rows directly into `ColumnarStore`.
- `events` becomes a cached getter that materializes `Event[]` on first access.
- `at(i)`, `first()`, `last()`, iterator, and `toArray()` materialize one event
  or the cached event array.
- Internal hot paths must avoid `this.events`.

This phase is where compatibility risk lives. Things to test explicitly:

- `series.events === series.events` remains true after first access.
- Events returned from `at(i)` are stable if called repeatedly.
- `TimeSeries.concat` reference-preservation expectations are revisited. Today
  concat preserves source `Event` instances; a columnar core may need to either
  keep that guarantee by sharing/materializing source events or document why the
  guarantee blocks the migration.
- Existing tests around `fromEvents`, `concat`, iteration, `toRows`, `toJSON`,
  and `partitionBy` still pass.

Decision gate:

- Continue only if lazy materialization does not force broad public type changes
  and does not make common row APIs materially slower for small/medium series.

## Phase 3: Derived Store Construction

Only after lazy events are viable, prototype store-native derived transforms:

- `select` / `rename`: reuse column buffers by reference where schema-safe.
- `filter`: build an index selection first; compact buffers only if the result
  escapes into mutation-sensitive paths.
- `slice`, `head`, `tail`: zero-copy views over store ranges.
- `diff`, `rate`, `pctChange`, `shift`, `cumulative`: write new numeric buffers
  directly.
- `aggregate` / `rolling`: already store-backed from phase 1; emit store-backed
  result series.

The important question is whether the store supports cheap views. If every
derived operation compacts every column eagerly, the model may still allocate
too much despite faster scans.

Decision gate:

- Continue only if common transform chains beat the current trusted-event path
  while preserving schema typing.

## Phase 4: LiveSeries Feasibility, Separately

Do not convert `LiveSeries` as part of the first spike. It has different
invariants:

- append and reorder insertion
- retention eviction
- per-event listener identity
- `on('event')`, `on('batch')`, and `on('evict')` all publish `Event` objects
- held event references after eviction must remain meaningful

If batch wins, run a second spike with a live ring-buffer store:

- append-only typed arrays with head/length/capacity
- optional reorder buffer for late events
- event materialization at listener boundaries
- batch listener option that could eventually emit store slices, not just
  `Event[]`

The Phase 4.5 change-stream work in `PLAN.md` should inform this. A future
`LiveChange` carrying columnar-batch updates would make live-columnar much less
awkward than forcing today's event-listener API through typed arrays.

## Expected Hot Spots

The spike should pay special attention to these current row-shape costs:

- `Event` construction and payload freezing
- repeated `event.data()[columnName]` lookup inside reducers
- `events -> rows -> Event` output paths in derived transforms that have not
  already been trusted
- `partitionBy` / live partition routing, where the same event shape gets
  copied or routed many times
- rolling reducers that repeatedly read the same numeric columns
- `toRows`, `toObjects`, `toJSON`, and `toPoints` materialization paths

## Risks

### Public `.events`

`TimeSeries.events` is public and widely used internally. A real migration must
replace internal reads with store methods while preserving external behavior.
This is the biggest compatibility constraint.

### `Event` Private Fields

`Event` uses private fields, so a lightweight `EventView` class is not
structurally assignable to `Event`. The safe spike path is lazy materialization
of real `Event` instances. If that cost erases the win, a deeper API refactor
would be required and likely belongs in v2 territory.

### Strings and Arrays

Columnar is cleanest for numbers and booleans. String and array columns still
need object references, interning, or dictionary encoding. Do not overbuild this
in phase 1; store them as side arrays and measure numeric-heavy operations.
However, choose names and invariants that can evolve toward Arrow's dictionary
and list-vector model if the spike continues.

### Arrow Dependency Risk

Arrow JS may be the right interchange layer and may even be useful internally,
but it should not be assumed. Risks to check before adopting it directly:

- browser bundle size
- friction with pond's schema types
- mutation/append ergonomics for `LiveSeries`
- whether Arrow's chunk/table abstractions simplify or complicate existing
  operators
- whether zero-copy export is enough without making Arrow the storage owner

### Small Series Regressions

Most users may work with thousands of points, not millions. A columnar core that
only helps 1M-row synthetic benches but slows ordinary `Event` workflows is not
a good trade.

### Type-Level Blast Radius

The current class already has known variance limitations. The spike should avoid
public type changes. If store internals force method overload churn, that is a
negative signal.

## Benchmark Scripts

Suggested scripts:

- `packages/core/scripts/perf-columnar-construction.mjs`
- `packages/core/scripts/perf-columnar-reduce.mjs`
- `packages/core/scripts/perf-columnar-rolling.mjs`
- `packages/core/scripts/perf-columnar-transform-chain.mjs`
- `packages/core/scripts/perf-columnar-memory.mjs`
- `packages/core/scripts/perf-columnar-arrow-interop.mjs`

Each script should print JSON with:

```json
{
  "scenario": "100k x 5 numeric",
  "eventBackedMs": 12.3,
  "columnarBackedMs": 7.4,
  "eventBackedHeapMb": 82.1,
  "columnarBackedHeapMb": 39.8
}
```

Run with `node --expose-gc` when memory is part of the claim.

## Final Deliverable

One short markdown report, not a PR-sized rewrite:

- summary table of runtime and heap deltas
- list of operators converted in the spike
- compatibility notes from the full test suite
- recommendation:
  - **stop** and keep columnar at chart boundary
  - **defer** until Phase 4.5 / v1.0
  - **promote to RFC** for Hybrid B

Promotion requires clear evidence, not vibes:

- 25%+ runtime or 35%+ heap improvement on realistic workloads
- no public API break
- manageable implementation size
- a credible live-story follow-up

## Default Recommendation Before Evidence

Keep the current PLAN decision. Build chart-side columnar first. Treat this
spike as the way to challenge that decision later, not as permission to start a
core rewrite now.

## Initial Phase 1 Notes

Implemented on branch `codex/core-columnar-store-spike`:

- internal `ColumnarStore<S>` sidecar under `packages/core/src/internal/`
- Arrow-inspired buffers for numbers, booleans, dictionary strings, and
  fallback arrays
- `TimeSeries` privately associates a store via `WeakMap`, including trusted
  construction paths
- `TimeSeries.reduce()` now reads through the store
- direct typed-array reducers for `sum`, `avg`, `count`, `min`, and `max`
- benchmark scripts for construction, reduction, and memory

First benchmark signal after `npm run build --workspace=pond-ts`:

| Scenario                      | Operation      | Event-backed | Columnar/public reduce |
| ----------------------------- | -------------- | -----------: | ---------------------: |
| 100k rows, dense numeric      | `avg(cpu)`     |     1.212 ms |               0.097 ms |
| 100k rows, 10% sparse numeric | `avg(cpu)`     |     1.308 ms |               0.333 ms |
| 1M rows, dense numeric        | `avg(cpu)`     |    13.028 ms |               2.053 ms |
| 100k rows, 10 hosts           | `unique(host)` |     2.361 ms |               2.868 ms |
| 1M rows, 100 hosts            | `unique(host)` |    29.744 ms |              29.357 ms |

Construction-side observation:

| Scenario                            | Full `TimeSeries` construction | Sidecar construction |
| ----------------------------------- | -----------------------------: | -------------------: |
| 100k rows, low-cardinality strings  |                      34.398 ms |             7.377 ms |
| 100k rows, high-cardinality strings |                      37.952 ms |             8.901 ms |
| 1M rows                             |                     382.877 ms |            71.431 ms |

Memory-side observation from `store.estimatedBytes()`:

- 100k rows with two numeric columns, one boolean, and one dictionary string:
  ~3.5-3.8 MB sidecar payload.
- 1M rows of the same shape: ~35.3 MB sidecar payload.

Interpretation:

- Numeric reductions already pass the Phase 1 runtime bar.
- String/dictionary reducers do not yet justify themselves; they are neutral to
  slightly worse on `unique`.
- Sidecar construction is a noticeable extra cost while events are still built
  eagerly. The real memory question requires Phase 2 lazy event materialization,
  because today's implementation intentionally holds both shapes.
- Full core tests passed (`1294` runtime/type tests), so the sidecar is
  behavior-compatible so far.

Second slice: time-keyed `aggregate()`:

- added `ColumnarStore.reduceColumnRange(...)`
- prototyped routing time-keyed point-series `aggregate()` through the store,
  then kept the runtime path event-backed while the benchmark explores the
  operator-planning shape explicitly
- added lazy numeric prefix sums/counts so `sum`, `avg`, and `count` can answer
  bucket ranges without rescanning every value
- kept `packages/core/scripts/perf-columnar-aggregate.mjs` as the experiment
  harness

Fair benchmark shape: both sides construct `TimeSeries` outputs so output-event
construction is included. The experimental columnar path precomputes bucket
spans once, then answers numeric bucket ranges from prefix sums/counts.

| Scenario                                | Operation           | Event-backed | Experimental columnar |
| --------------------------------------- | ------------------- | -----------: | --------------------: |
| 100k rows, 10 events/bucket, dense      | `avg`/`sum`/`count` |     4.923 ms |              3.326 ms |
| 100k rows, 10 events/bucket, 10% sparse | `avg`/`sum`/`count` |     3.801 ms |              2.961 ms |
| 1M rows, 60 events/bucket, dense        | `avg`/`sum`/`count` |    18.813 ms |              6.923 ms |
| 100k rows, 10 events/bucket, dense      | `unique(host)`      |    10.718 ms |             10.372 ms |
| 1M rows, 60 events/bucket, dense        | `unique(host)`      |    52.221 ms |             52.883 ms |

Interpretation:

- Whole-column numeric `reduce()` is a clear win.
- Bucketed numeric `aggregate()` can win if the operator plans bucket spans once
  and answers simple reducers from prefix sums/counts.
- `unique(host)` is neutral, not compelling. Dictionary encoding does not help
  unless the reducer works over dictionary indices directly.
- The runtime `aggregate()` path is intentionally left event-backed in this
  branch. Promoting the columnar version needs a real fused operator design, not
  the earlier naive "ask each column to reduce this range" hook.

Third slice: chart/data extraction:

- added `ColumnarStore.toChartBuffer(...)`
- output shape matches the chart RFC direction: `Float64Array` x values,
  `Float64Array` y columns, and optional validity masks
- supports zero-copy borrowing of internal buffers and `{ copy: true }` for
  ownership-sensitive adapters
- added `packages/core/scripts/perf-columnar-chart-buffer.mjs`

Benchmark shape: compare `series.toPoints()` object-row export against
chart-buffer extraction for three numeric columns.

| Scenario              | `toPoints()` | zero-copy chart buffer | copied chart buffer |
| --------------------- | -----------: | ---------------------: | ------------------: |
| 100k rows, dense      |    22.655 ms |               0.002 ms |            0.328 ms |
| 100k rows, 10% sparse |    15.483 ms |               0.001 ms |            0.366 ms |
| 1M rows, dense        |   203.638 ms |               0.001 ms |            5.860 ms |

Interpretation:

- This is the strongest result so far and lines up with the chart RFC: columnar
  is excellent at the chart/data-source boundary.
- Zero-copy extraction is basically metadata assembly. Even copied typed arrays
  are dramatically cheaper than creating and freezing one JS object per point.
- This supports keeping `toPoints()` as the compatibility escape hatch while a
  future `@pond-ts/charts` adapter consumes typed buffers directly.
- The result does not by itself justify converting all core operators to
  columnar; it specifically strengthens the "chart-side columnar first"
  decision.

Fourth slice: Phase 2 lazy event materialization:

- changed constructor-built `TimeSeries` instances so `events` is a cached
  getter backed by the internal store instead of an eagerly retained event array
- kept trusted-event construction paths cached up front so transforms and
  `TimeSeries.concat(...)` continue to preserve event references
- added `ColumnarStore.eventAt(...)` / `toEvents()` for compatibility
  materialization
- pinned `series.events === series.events`, repeated `at(i)` identity, and
  `first()` / `last()` stability in tests
- updated `packages/core/scripts/perf-columnar-memory.mjs` to report both JS
  heap and typed-array `arrayBuffers`

Memory benchmark shape: construct from rows, release the input rows, measure
the lazy series, run a store-backed `reduce()`, then force `series.events`.

| Scenario                    | Rows delta | Lazy series delta | After store read | Event materialization delta |
| --------------------------- | ---------: | ----------------: | ---------------: | --------------------------: |
| 100k rows, dense            |    14.5 MB |            3.6 MB |          4.75 MB |                    18.05 MB |
| 100k rows, sparse/high-card |   15.03 MB |           4.01 MB |          5.16 MB |                    17.85 MB |
| 1M rows, dense              |  144.96 MB |          35.32 MB |         46.76 MB |                   179.33 MB |

Interpretation:

- Phase 2 clears the memory gate for constructor-built series that stay on
  columnar/read-heavy paths: the retained shape drops from row-object scale to
  typed-buffer scale.
- `heapUsed` alone is misleading because the columnar payload lives mostly in
  `arrayBuffers`; the combined heap-plus-array-buffer number is the useful
  comparison.
- Store-backed `reduce()` keeps events unmaterialized, but prefix caches add
  typed-array memory on first numeric reads.
- Compatibility access is intentionally expensive: once `series.events` is
  forced, the row-object cost returns and is cached for stable references.
- Full core tests passed (`1295` runtime/type tests), so lazy materialization is
  behavior-compatible for the current suite.
