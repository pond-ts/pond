# Friction note: columnar conversion — aggregation family

**For:** pond-ts core maintainers.
**From:** investigation agent (Claude Opus), 2026-05-13.
**Status:** scoping report — feasibility analysis, not implementation.

## 1. Operators investigated

Read end-to-end: `TimeSeries.reduce` (1539-1574), `TimeSeries.rolling`
(2681-3037), `TimeSeries.baseline` (4118-4216), `TimeSeries.outliers`
(4253-4303), `aggregateInternal` (4349-4460), `aggregate-columns.ts`.
Read every reducer in `reducers/`: `count`, `sum`, `avg`, `min`, `max`,
`first`, `last`, `median`, `stdev`, `difference`, `keep`, `samples`,
`unique`, `top`, `percentile`, plus the deque / sorted-array / ordered-
entries helpers in `rolling.ts`. Read `LiveAggregation`,
`LiveRollingAggregation`, `LiveFusedRolling`, `LivePartitionedSyncRolling`,
`LiveReduce`.

Shape that emerges: every operator walks events, calls `event.data()`,
indexes a `Record` by string column name, and pushes the result
through a reducer state machine. The reducer registry's
`(add, remove, snapshot)` contract is the single integration point —
every batch and live aggregation path funnels through it via
`bucketStateFor` / `rollingStateFor`.

## 2. Likely conversion path

**Numeric reducers (sum, avg, count, min, max, stdev, difference).**
Cleanest case. The hot path is iterating a `Float64Array` plus a
validity bitmap. Three sub-shapes:

- **Whole-column reduce** — straight typed-array loop. The spike's
  6-12x measurement.
- **Bucketed aggregate (time-keyed)** — precompute bucket spans once,
  answer `sum`/`avg`/`count` from prefix sums/counts; range-scan for
  `min`/`max`/`stdev`/`difference`.
- **Rolling** — keep the existing monotone-deque (min/max) and running
  sum/sum-sq (avg/stdev). Win is that `add`/`remove` reads a typed-
  array slot instead of `data[source]`.

**Percentile / median (`pNN`, `median`).** Reducer state today is a
sorted `number[]` with `splice`. A sorted `Float64Array` would still
be O(N) memmove on insert/remove. **Treat as parity, not a win** —
keep the `number[]`.

**Array-output reducers (`unique`, `top`).** Real win exists only
when the source is a dictionary-encoded string column: `add(value)`
becomes `add(dictIdx)`, with `unique` keeping a `Uint8Array`
presence-bitmap over the dictionary and `top` an `Int32Array` of
counts. `snapshot()` walks the dictionary once. For non-dictionary
strings or array columns, fall through to today's Map-based path.

**`samples`.** Two viable shapes: (a) capture **source indices** into
the column (an `Int32Array`-backed ring), materialize values at
`snapshot()`; (b) copy values into a typed buffer. Option (a) needs
the source column to outlive every captured event, which holds for
batch but not for live with retention. **Recommendation: indices
for batch, values for live.** Same `ScalarValue[]` output, hidden
inside the reducer.

**Custom-function reducers.** Stay event-backed per Phase 4.7
commitment. Materialize events from the columnar store lazily and
feed them through today's path.

**`baseline` / `outliers`.** Both delegate to `rolling`, so they
inherit the rolling win. Their tails (append band columns,
`|raw - avg| > sigma*sd` filter) become straight typed-array zip
loops with `Int32Array` output for `outliers`.

## 3. Primitives needed

```ts
// Whole-column scan (the win in series.reduce, LiveReduce snapshot).
reduceNumeric(col: Float64Column, op: 'sum'|'avg'|'min'|'max'|'count'|'stdev'|...): number | undefined;

// Range-restricted scan (per-bucket in aggregate, per-window snapshots).
reduceNumericRange(col: Float64Column, start: number, end: number, op: ...): number | undefined;

// Lazy prefix structures for fused-bucket numeric aggregate.
prefixSum(col: Float64Column): Float64Array;
prefixCount(col: Float64Column): Int32Array;

// Dictionary-encoded string access for unique/top fast path.
dictionarySize(col: DictionaryColumn): number;
dictionaryAt(col: DictionaryColumn, idx: number): string | undefined;
dictionaryIndicesRange(col: DictionaryColumn, start: number, end: number): Int32Array; // or zero-copy view

// Per-row materialization fallback for custom reducers.
eventAt(store: ColumnarStore, i: number): Event;
toIterable(store: ColumnarStore, start?, end?): Iterable<Event>;

// Live ring-buffer side.
appendChunk(store: LiveRingBuffer, chunk: ColumnarChunk): number;
evictPrefix(store: LiveRingBuffer, n: number): void;

// Universal escape hatch.
scanRange(store, start, end, cb: (idx: number) => void): void;
```

Signatures are sketch-grade; names roughly mirror what the spike
prototype already implemented (`reduceColumnRange`, `toChartBuffer`).

## 4. Reducer registry shape

**The `(add, remove, snapshot)` contract survives, narrowly.**
It's the right granularity for rolling-window updates (one event
in / one event out) and bucket accumulation; reshaping to batch-
oriented would lose the streaming case.

**It grows new optional methods** for built-ins that can exploit
columnar:

```ts
type ReducerDef = {
  outputKind: 'number' | 'source' | 'array';

  // Existing — kept verbatim, custom reducers depend on this.
  reduce(defined, numeric): ColumnValue | undefined;
  bucketState(): AggregateBucketState;
  rollingState(): RollingReducerState;

  // NEW — optional. Operators prefer these when present.
  reduceColumn?(col: Column, validity?: Uint8Array): ColumnValue | undefined;
  reduceColumnRange?(col, start, end, validity?): ColumnValue | undefined;
  bucketStateColumn?(): ColumnarBucketState;
  rollingStateColumn?(): ColumnarRollingState;
};

type ColumnarBucketState = {
  addRange(col, start, end, validity?): void;
  addOne(col, idx: number): void;
  snapshot(): ColumnValue | undefined;
};

type ColumnarRollingState = {
  addOne(col, idx: number): void;
  removeOne(col, idx: number): void;
  snapshot(): ColumnValue | undefined;
};
```

**Why optional, not a replacement:** custom functions arrive via
`bucketStateFor` / `rollingStateFor` adapters that wrap a function
into `AggregateBucketState`. Forcing columnar-aware shapes everywhere
would break them. The operator checks: if reducer is built-in and
column kind matches → fast path; else → existing event-walked
fallback. **This makes a mixed mapping (numeric `avg` + custom
function) not regress** — the numeric column runs columnar, the
custom column falls back, both share the same bucket boundaries.

## 5. Aggregate planner shape

Minimum viable:

```ts
type AggregatePlan = {
  bucketStarts: Float64Array; // length = bucket count
  bucketEnds: Float64Array;
  bucketBegin: Int32Array; // event-index of first event in bucket
  bucketEnd: Int32Array; // event-index past last event in bucket
  columns: Array<{
    output: string;
    source: string;
    kind: ScalarKind;
    strategy:
      | {
          kind: 'prefix-numeric';
          op: 'sum' | 'avg' | 'count';
          prefixSum: Float64Array;
          prefixCount: Int32Array;
        }
      | { kind: 'range-scan'; reducer: ReducerDef } // numeric min/max/stdev/difference
      | { kind: 'dict-counts'; reducer: 'unique' | 'top'; n?: number }
      | { kind: 'fallback'; reducer: AggregateReducer }; // custom or non-decomposable
  }>;
};
```

Bucket-spans walk is O(B + N) (single linear sweep advancing one
cursor through sorted bucket starts). The planner stays simple —
its value is consolidating dispatch in one place.

`LiveAggregation` doesn't use the planner: buckets close
incrementally and `bucketStateFor` runs per-event. The columnar
improvement there is inside `bucketStateFor` — numeric columns
route to a state that reads a `Float64Array` slot rather than a
`data[source]` lookup. Per-bucket state allocation isn't the hot
allocation; per-event lookup is.

## 6. Clean wins

- **Whole-column numeric `reduce()`** — the spike's 6-12x.
- **`baseline()` / `outliers()`** — `Float64Array` arithmetic in
  lockstep instead of per-event row arrays.
- **Aggregate planner with prefix sums** — spike measured ~2.7x on
  1M rows for `avg`/`sum`/`count`. Per-bucket allocation drops to
  one number per bucket per column.
- **`LiveReduce` / `LiveRollingAggregation` numeric fast path** —
  spike already shipped this for `LiveRollingAggregation`. Extension
  to `LiveReduce` and `LiveFusedRolling` is mechanical.
- **GC pressure across all four live rollings.** Today each ingest
  allocates `{ index, timestamp, values: ColumnValue[] }` per event.
  Under columnar rings, ingest writes scalars into pre-allocated
  slots. For kHz fused-rolling, this is the dominant GC cost.

## 7. Neutral parity

- **`unique` / `top` on dictionary string columns** — spike measured
  neutral. Win is ~10-20% only when actually dictionary-encoded;
  Map-based counts dominate either way.
- **`median` / `pNN` rolling** — sorted `number[]` vs sorted
  `Float64Array` are equivalent for realistic windows (< ~1000).
  Larger windows would need entirely different structures (skip
  lists, indexed sums); out of scope.
- **`first`, `last`, `keep`** — minimal arithmetic. Columnar removes
  one property lookup per event; gain is 10-20%, not 5x.

## 8. Regression risk

- **Custom-function reducers.** Per-event cost today is `data[source]`
  - `items.push(v)`. Under columnar, reading `v` requires Event
    materialization (expensive) or a column-typed `col.at(i)`. **Mitigation:**
    thin `col.at(i): ColumnValue | undefined`. Confidence: medium;
    measurement needed.
- **`samples` rolling.** v0.14.3's win came from skipping a 1-element
  array wrap per scalar `add`. **Mitigation:** ring of `Int32Array`
  source indices (capture-index variant) or `Float64Array` (numeric
  variant). Both avoid per-event objects.
- **`unique` over array-kind column.** Today's inner walk iterates a
  small JS array; under columnar it walks values-buffer + offsets.
  Per-element parity; offset arithmetic adds fixed cost. Needs
  measurement.
- **Construction-time prefix sums.** For series that aggregate or
  reduce only once, prefix-build cost may exceed the per-call win.
  **Mitigation:** defer prefix construction to second invocation, or
  to operators that demonstrably benefit.
- **Registry contract change.** Every built-in needs the new optional
  methods added (15+ files). Tests for existing contract preserved
  as fallback. Implementation: ~2 weeks of careful work.

## 9. Knowns / unknowns

**Known.** The `(add, remove, snapshot)` contract can grow optional
methods without breaking custom-function callers. Numeric reduce is
the headline win. Aggregate planner with prefix sums beats event-
walking at scale. Live rolling numeric fast path is proven (spike
Phase 4).

**Unknown — needs measurement.**

- Dictionary-encoded `unique` / `top`: >25% win or noise? Spike
  data covers one cardinality.
- Custom-function reducer cost — is `col.at(i)` truly close to
  `data[source]`, or does the union-typed return hurt?
- `samples` rolling with source-index ring: are source buffers
  stable enough across `LiveSeries` retention for index-based
  capture? The spike's Phase 4 ring only captures numeric values.
- Aggregate planner construction cost on small series: when does
  prefix-build amortize?

**Surprise.** The `aggregate-columns.ts` normalizer is already
shared between batch and live — load-bearing for behavior symmetry.
Any column-spec extension (planner fast-path hint, source-kind
flag) should land there, not duplicated per operator. The spike
brief doesn't anticipate this; it falls out of existing organization.

## 10. Recommendations

1. **Keep the `(add, remove, snapshot)` contract.** Add optional
   columnar variants on `ReducerDef`. Custom-function and fallback
   paths use the existing shape unchanged.
2. **Build the aggregate planner as one self-contained module.**
   Public surface: `buildAggregatePlan(store, sequence, columnSpecs, range)`.
   Operator delegates, executes, builds the result store.
3. **Defer the `samples` rolling redesign until the live ring
   buffer is wired up.** v0.14.3's scalar/array discrimination
   keeps the row-shape path tight today; the natural breaking
   point is the live ring buffer.
4. **For `unique` / `top` over dictionary columns: ship a fast
   path only if a gRPC-experiment bench shows >25%.** Otherwise
   leave as parity — the spike's neutral measurement guards
   against over-investment.
5. **Pin reducer-contract preservation tests early.** Before
   columnar fast paths land, walk every built-in × (batch, bucket,
   rolling) asserting identical outputs to today. Safety net for
   the optional-method additions.
6. **Custom-function fallback materializes events; don't be
   clever.** `Iterable<Event>` lazily backed by the columnar store
   is the right shape. If one custom function in a multi-column
   mapping forces all columns through fallback, that's acceptable —
   users can split the call.
