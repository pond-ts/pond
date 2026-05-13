# Framework-layer design: columnar core substrate

**For:** the implementation team starting Phase 4.7 step 1.
**From:** pond-ts library agent (Claude), 2026-05-13.
**Status:** implementation-facing design document. Concrete API sketch, not strategic context.
**Cross-references (required reading):**

- [`docs/rfcs/columnar-core.md`](../rfcs/columnar-core.md) — the binding RFC including V1 (Codex draft), V2 (gRPC-feedback response), and V3 (investigation-synthesis response) amendments.
- [`docs/briefs/columnar-investigation-synthesis.md`](columnar-investigation-synthesis.md) — the synthesis that drove V3's commitments.
- [`docs/briefs/core-columnar-store-spike.md`](core-columnar-store-spike.md) — the spike brief that's the evidence base.
- [`PLAN.md`](../../PLAN.md) Phase 4.7 — the binding work entry.

## Purpose

This document translates the RFC's strategic commitments into a concrete implementation-facing design for the **framework layer** — Phase 4.7's step 1. The RFC tells you _what_ to build and _why_; this document tells you _how the API surface_ looks so the implementation PR has an answer key rather than open design questions.

Subsequent steps (TimeSeries integration, reducer adaptation, derived transforms, etc.) get their own per-step design notes as needed. This document is scoped to the foundational framework layer alone.

## Module layout

The framework lives at `packages/core/src/columnar/`, organized as:

```
packages/core/src/columnar/
├── README.md                      Framework boundary + public/internal contract
├── index.ts                       Internal-only barrel export
├── store.ts                       ColumnarStore, factories, view-store
├── column.ts                      Column<T> interfaces + concrete types
├── builder.ts                     ColumnBuilder<T>, finalize semantics
├── validity.ts                    ValidityBitmap operations
├── dictionary.ts                  Dictionary string columns
├── chunk.ts                       ChunkedColumn, chunk-boundary primitives
├── keys.ts                        KeyColumn, EventKey wrapper cache
├── views.ts                       Index views, row-selection, slice
├── events.ts                      Lazy event materialization (eventAt cache)
├── intake.ts                      Validated row intake, trusted intake
├── exports.ts                     Store-native toRows / toObjects / toJSON / toPoints
└── __tests__/                     Independent test suite for the framework
```

**Public-internal boundary.** Everything under `packages/core/src/columnar/` is internal — no public re-export from `packages/core/src/index.ts`. Consumers (`TimeSeries`, `LiveSeries`, reducer registry, etc.) import via paths like `from './columnar/store'`. This keeps the framework's API mobile during v1.0 development; nothing about its shape is locked at the public surface until the public-API operators that consume it stabilize.

**Independent test suite.** The framework gets its own `__tests__/` directory exercising every primitive in isolation. No `TimeSeries` / `LiveSeries` dependency in framework tests — proves the framework is genuinely independent. Test count target: ~200 framework-only tests covering construction, column ops, builders, validity, views, dictionary encoding, chunked columns, and exports.

**Bundle-size pin.** `<25 KB` gzipped delta to pond-ts core after framework lands. CI gate. The framework is shipped code, not designed-for-extension-but-tree-shaken — every primitive justifies its weight.

## Core types

### `ColumnarStore<S>`

The substrate's primary type. Immutable, schema-typed, columnar.

```ts
interface ColumnarStore<S extends SeriesSchema> {
  readonly schema: S;
  readonly length: number;

  /** Key column — typed array, one entry per row. */
  readonly keys: KeyColumn;

  /** Value columns, keyed by schema-column name. */
  readonly columns: ReadonlyMap<string, Column>;

  /** Optional chunks; absent for un-chunked stores. */
  readonly chunks?: ReadonlyArray<ColumnarChunk<S>>;

  /** Direct typed-array key access — bisect / range-query primitive. */
  keyAt(i: number): EventKey;
  beginAt(i: number): number;
  endAt(i: number): number;

  /** Lazy event materialization with per-index cache. */
  eventAt(i: number): EventForSchema<S>;

  /** Full materialization for compatibility-boundary calls; reuses eventAt cache. */
  toEvents(): ReadonlyArray<EventForSchema<S>>;

  /** Store-native exports (no Event materialization). */
  toRows(): ReadonlyArray<RowForSchema<S>>;
  toObjects(): ReadonlyArray<NormalizedObjectRowForSchema<S>>;
  toJSON(opts?: { rowFormat?: JsonRowFormat }): TimeSeriesJsonOutput<S>;
  toPoints(): ReadonlyArray<PointForSchema<S>>;
}
```

**Construction factories:**

```ts
namespace ColumnarStore {
  /** Validated intake — used by TimeSeries constructor. */
  function fromValidatedRows<S extends SeriesSchema>(
    schema: S,
    rows: ReadonlyArray<RowForSchema<S>>,
  ): ColumnarStore<S>;

  /** Trusted intake — for #fromTrustedEvents path; optionally carries event cache. */
  function fromTrustedEvents<S extends SeriesSchema>(
    schema: S,
    events: ReadonlyArray<EventForSchema<S>>,
    options?: { eventCache?: Map<number, EventForSchema<S>> },
  ): ColumnarStore<S>;

  /** Trusted intake from already-columnar output (concat, joins, derived transforms). */
  function fromTrustedStore<S extends SeriesSchema>(
    schema: S,
    keys: KeyColumn,
    columns: ReadonlyMap<string, Column>,
    options?: {
      eventCache?: Map<number, EventForSchema<S>>;
      chunks?: ColumnarChunk<S>[];
    },
  ): ColumnarStore<S>;

  /** Builder-style construction — for pivotByGroup, live ring buffer materialization. */
  function fromBuilders<S extends SeriesSchema>(
    schema: S,
    keyBuffer: KeyBuffer,
    builders: ReadonlyMap<string, ColumnBuilder>,
  ): ColumnarStore<S>;
}
```

### `Column<T>` and concrete types

```ts
type Column = Float64Column | BooleanColumn | StringColumn | ArrayColumn;

interface ColumnBase<T> {
  readonly kind: ColumnKind;
  readonly length: number;
  readonly validity?: ValidityBitmap; // absent if all cells defined

  /** Read a single cell; undefined if validity bit is 0. */
  read(i: number): T | undefined;

  /** Linear scan with callback; skips invalid cells unless told otherwise. */
  scan(
    fn: (value: T, i: number) => void,
    options?: { skipInvalid?: boolean },
  ): void;

  /** Zero-copy slice by range. */
  sliceByRange(start: number, end: number): Column;

  /** Zero-copy slice by index selection (for filter / partitionBy / groupBy). */
  sliceByIndices(indices: Int32Array): Column;
}

interface Float64Column extends ColumnBase<number> {
  readonly kind: 'number';
  readonly values: Float64Array;
}

interface BooleanColumn extends ColumnBase<boolean> {
  readonly kind: 'boolean';
  readonly values: Uint8Array; // 1 bit per value, packed
}

interface StringColumn extends ColumnBase<string> {
  readonly kind: 'string';
  readonly dictionary?: ReadonlyArray<string>; // present for dict-encoded
  readonly indices?: Int32Array; // present for dict-encoded
  readonly fallback?: ReadonlyArray<string | undefined>; // present for non-dict
}

interface ArrayColumn extends ColumnBase<ArrayValue> {
  readonly kind: 'array';
  readonly offsets?: Int32Array; // length-prefix encoding
  readonly values?: Column; // values column for nested elements
  readonly fallback?: ReadonlyArray<readonly unknown[] | undefined>;
}
```

**Derivation primitive:**

```ts
Column.derive<U>(
  source: Column,
  outputKind: ColumnKind,
  writer: (out: ColumnWriter<U>, source: Column) => void,
): Column;
```

For `diff` / `rate` / `pctChange` / `cumulative` / `shift` — write a new typed-array column derived from a source column. `ColumnWriter<U>` is the framework's append-with-validity primitive.

### `ColumnBuilder<T>`

For dynamic-schema batch output (`pivotByGroup`) and live append-only rings (`LiveSeries` numeric ring buffer).

```ts
interface ColumnBuilder<T> {
  readonly kind: ColumnKind;

  /** Append a value at the next position. */
  append(value: T | undefined): void;

  /** Sparse fill — write at an explicit row index (for pivotByGroup). */
  appendAt(rowIndex: number, value: T | undefined): void;

  /** Returns the column count so far. */
  readonly length: number;

  /** Finalize into a frozen Column. */
  finalize(): Column;
}

namespace ColumnBuilder {
  function forKind<T>(
    kind: ColumnKind,
    initialCapacity?: number,
  ): ColumnBuilder<T>;

  /** Ring-buffer-shaped builder for live append. */
  function ring<T>(kind: ColumnKind, retention: number): RingColumnBuilder<T>;
}

interface RingColumnBuilder<T> extends ColumnBuilder<T> {
  /** Evict the oldest N entries. */
  evictPrefix(n: number): void;

  /** Lazy ring growth: capacity starts at `initialCapacity`, doubles on append until `retention`. */
  readonly capacity: number;
  readonly head: number;
}
```

### `KeyColumn`

The key axis. Three concrete shapes corresponding to `Time` / `TimeRange` / `Interval`.

```ts
type KeyColumn = TimeKeyColumn | TimeRangeKeyColumn | IntervalKeyColumn;

interface TimeKeyColumn {
  readonly kind: 'time';
  readonly begin: Float64Array;
  // end === begin for time-keyed
}

interface TimeRangeKeyColumn {
  readonly kind: 'timeRange';
  readonly begin: Float64Array;
  readonly end: Float64Array;
}

interface IntervalKeyColumn {
  readonly kind: 'interval';
  readonly begin: Float64Array;
  readonly end: Float64Array;
  readonly values: StringColumn; // interval labels, dictionary-encoded when possible
}
```

**EventKey wrapper cache.** The store maintains a `Map<number, EventKey>` cache keyed by row index — built lazily on first `keyAt(i)` call. Reuses across `keyAt`, `eventAt`, and operator hot paths (e.g., `bisect`'s key comparison).

### `ValidityBitmap`

```ts
interface ValidityBitmap {
  readonly bits: Uint8Array; // 1 bit per row, packed
  readonly definedCount: number;
  isDefined(i: number): boolean;
  countInRange(start: number, end: number): number;
}

namespace ValidityBitmap {
  function ofLength(length: number): ValidityBitmap;
  function allDefined(length: number): undefined; // sentinel — no bitmap needed
}
```

**Convention:** validity bitmap is **optional** on a column. Absent means "all cells defined." Allocated only when at least one cell is undefined. Reducers and exports check by-presence: `if (col.validity) skip-undefined; else iterate-all`.

### `ChunkedColumn`

For zero-copy `concat` over temporally-disjoint inputs.

```ts
interface ChunkedColumn extends ColumnBase {
  readonly kind: ColumnKind;
  readonly chunks: ReadonlyArray<Column>;
  readonly chunkOffsets: Int32Array; // length = chunks.length + 1
  // chunks[k] covers rows [chunkOffsets[k], chunkOffsets[k+1])
}
```

A store can be chunked (i.e., its columns are `ChunkedColumn`s) when `concat`-ed from disjoint inputs. Operators that read by index translate row index → chunk + chunk-local index automatically. Most operators don't need to care.

## API surface — key primitives by use case

### Index views (V3 commitment #1)

```ts
namespace Store {
  /** Returns a view-store that borrows source columns under an index projection. */
  function withRowSelection<S extends SeriesSchema>(
    source: ColumnarStore<S>,
    indices: Int32Array,
  ): ColumnarStore<S>;

  /** Forces a view-store to compact into owned typed-array buffers. */
  function materialize<S extends SeriesSchema>(
    view: ColumnarStore<S>,
  ): ColumnarStore<S>;
}
```

The view-store's columns return `sliceByIndices(viewIndices)` projections lazily. `materialize()` is called by:

- The first transform that derives a new column from a view (compact-on-write)
- Public-API operators that need owned buffers
- The `toEvents()` / `eventAt(i)` boundary when accessed at unusual scale

Read-only chains skip materialization entirely.

### Multi-source operations (V3 commitment #9)

```ts
namespace Store {
  /** Binary key-aligned merge — used by join. joinMany is a left-fold. */
  function joinByKey<S1, S2, R>(
    left: ColumnarStore<S1>,
    right: ColumnarStore<S2>,
    options: JoinOptions,
  ): ColumnarStore<R>;

  /** N-way merge of pre-sorted same-schema stores; produces a chunked output when inputs are disjoint. */
  function concatSorted<S>(
    stores: ReadonlyArray<ColumnarStore<S>>,
  ): ColumnarStore<S>;
}
```

`concatSorted` produces a `ChunkedColumn`-backed store when input key ranges don't overlap (zero-copy); falls back to compacted merge when ranges interleave.

### Zero-copy schema operations

```ts
namespace Store {
  /** Rename columns via schema metadata only — buffers shared. */
  function withColumnsRenamed<S>(
    store: ColumnarStore<S>,
    map: Record<string, string>,
  ): ColumnarStore<S>;

  /** Replace one column with a derived buffer; other columns shared. */
  function withColumnReplaced<S>(
    store: ColumnarStore<S>,
    name: string,
    column: Column,
  ): ColumnarStore<S>;

  /** Append a new column; other columns shared. */
  function withColumnAppended<S>(
    store: ColumnarStore<S>,
    name: string,
    column: Column,
  ): ColumnarStore<S>;

  /** Drop columns via schema metadata. */
  function withColumnsSelected<S>(
    store: ColumnarStore<S>,
    names: ReadonlyArray<string>,
  ): ColumnarStore<S>;
}
```

These are the workhorse primitives for `select`, `rename`, `diff` / `rate` / `pctChange` / `cumulative` / `shift` / `fill` / `smooth`. Most operations in `TimeSeries.ts` reduce to "compute one new column, pass everything else through by reference."

### Live ring buffer (V3 commitment #8)

```ts
class ColumnarRingBuffer<S extends SeriesSchema> {
  /**
   * Append-only by construction. Ordering modes (strict / drop /
   * reorder) are a `LiveSeries`-layer concern, not a ring-buffer
   * concern — strict / drop wire to the ring after `#insert`
   * validates; reorder mode takes the event-backed fallback path
   * and never touches the ring. See RFC V4 amendment.
   */
  constructor(
    schema: S,
    options: {
      retention: number;
      lazyGrowth?: boolean;
    },
  );

  /** Default true: lazy ring growth starting at capacity 64, doubling on append. */
  readonly lazyGrowth: boolean;

  /** Append one row. */
  appendRow(row: RowForSchema<S>): void;

  /** Append a batch — vectorized into typed-column writes. */
  appendBatch(batch: ColumnarBatch<S>): void;

  /** Evict oldest n rows (retention trim). */
  evictPrefix(n: number): void;

  /** Snapshot to an immutable ColumnarStore<S>. */
  snapshot(): ColumnarStore<S>;
}
```

`LiveSeries`'s numeric ring buffer (Phase 4.7 step 7) builds on this. Listener-API integration stays at the `LiveSeries` layer; the framework just provides the buffer.

### Scatter primitive (V3 commitment #5)

```ts
namespace Store {
  /** Per-row partition routing — internal scatter used by LivePartitionedSeries. */
  function scatterByPartition<S, K extends string>(
    rows: ColumnarBatch<S>,
    partitionColumn: keyof S & string,
  ): Map<K, ColumnarBatch<S>>;
}
```

Wins at batch sizes ≥ 100. Public `pushColumns(...)` API is still v1.x; this is the internal primitive.

## Implementation sequencing within step 1

The framework layer is the most load-bearing single step (~6 weeks). Sub-sequenced as follows; each sub-step a self-contained PR with its own tests:

| Sub-step | Scope                                                                                                                                                            | Duration |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1a       | `Column` interfaces + `Float64Column` / `BooleanColumn` + `ValidityBitmap`                                                                                       | ~1 week  |
| 1b       | `StringColumn` (dict + fallback) + `DictionaryColumn` operations                                                                                                 | ~1 week  |
| 1c       | `KeyColumn` (all three kinds) + `keyAt` / `beginAt` / `endAt` + EventKey cache                                                                                   | ~3 days  |
| 1d       | `ColumnarStore<S>` core (read-only) + `toEvents` / `eventAt` / store-native exports                                                                              | ~1 week  |
| 1e       | `ColumnBuilder` + factories (`fromValidatedRows`, `fromTrustedEvents`, `fromTrustedStore`, `fromBuilders`)                                                       | ~1 week  |
| 1f       | Index views (`withRowSelection`, `materialize`) + zero-copy schema ops (`withColumnsRenamed`, `withColumnReplaced`, `withColumnAppended`, `withColumnsSelected`) | ~1 week  |
| 1g       | `ChunkedColumn` + `concatSorted`                                                                                                                                 | ~3 days  |
| 1h       | `ColumnarRingBuffer<S>` (lazy ring growth) + `scatterByPartition`                                                                                                | ~1 week  |

Sub-steps land sequentially as PRs against the `docs/columnar-substrate-v1` branch (or a new framework-layer branch). Each PR exercises the standard two-pass review (Layer 2 + Codex).

**Total framework-layer time:** ~6 weeks. **Total Phase 4.7:** 3–4 months end-to-end across all 8 steps (per V2/V3).

## Test strategy

### Per-primitive unit tests

Each sub-step's PR includes tests for the primitives it lands:

- Column read / scan / slice (range, indices)
- Builder append, sparse fill, finalize
- Validity-bitmap operations
- KeyColumn variants and EventKey cache
- View-store materialization triggers
- Schema-op buffer-sharing assertions
- Ring-buffer lazy growth, eviction, snapshot

### Cross-primitive integration tests

After 1f (index views + schema ops), add a test suite exercising real composition patterns:

- View-of-view-of-view (filter chain depth) — does materialization trigger correctly?
- Index-view + `withColumnReplaced` (compact-on-write) — does the right partition compact?
- `concatSorted` with interleaved vs disjoint inputs — does chunked output engage correctly?
- Builder + `fromBuilders` + view-store round-trip — does identity preserve?

### Bundle-size CI gate

After every framework sub-step, the bundle-size check fires. Target: framework adds `<25 KB` gzipped after sub-step 1h. Earlier sub-steps target proportionally lower (1a alone: `<8 KB`).

### Independence verification

After 1d (the first sub-step that touches `ColumnarStore`), add a test that imports only from `packages/core/src/columnar/` and constructs / manipulates stores end-to-end. No `TimeSeries` / `LiveSeries` import. Pins the framework as genuinely independent.

## Public API invariants (recap from RFC)

Preserved by the framework's design:

1. **`series.events === series.events`** — via `toEvents()` caching the result.
2. **`at(i)` reference stability** — via `eventAt(i)`'s per-index `Map<number, Event>` cache.
3. **`at(i)` ↔ `events` consistency** — `toEvents()` reuses the cache.
4. **`TimeSeries.concat` event identity** — via `fromTrustedEvents`'s optional `eventCache` parameter.
5. **Event-shaped iteration** — `Symbol.iterator` calls `eventAt(i)` per step.

Tests for each of these land in the TimeSeries-integration step (step 2), not the framework layer itself. The framework provides the primitives; `TimeSeries` consumes them with the contracts in place.

## Known unknowns

The synthesis report identified items the implementation needs to measure during step 1:

- **Small-N regression curve** — sub-1k row series might lose to plain `Event[]`. Add `perf-columnar-small-n.mjs` covering N from 10 to 100k.
- **V8 cost of `Int32Array`-indirected column reads** — drives the auto-compaction threshold for filter chains. Add `perf-columnar-filter-chain.mjs`.
- **EventKey instance reuse cost** — affects key-heavy operators. Add `perf-columnar-keyat-cache.mjs`.
- **`at(i)` hover-handler pattern** — chart-code per-frame access. Add `perf-columnar-hover-access.mjs`.

These benches inform threshold heuristics in the framework. Land them alongside the relevant sub-steps so the right defaults ship in v1.0.

## Non-goals for this design doc

This document is implementation-facing for step 1 only. It doesn't cover:

- **Step 2 (TimeSeries integration).** Gets its own design note when step 1 lands.
- **Step 3+ (reducer adaptation, derived transforms, etc.).** Same — per-step design notes as each earns its slot.
- **Strategic decisions.** Those live in the RFC. If you find yourself questioning the index-view pattern or the reducer registry shape, the RFC is the place to surface that — not this document.
- **WASM kernels / WebGPU / Arrow JS interop.** Future doors per V2's "what stays out of v1.0 scope." Framework designed to enable them; not built for them.

## Sequencing relative to other work

- **v0.17.x** continues with bug fixes (current state).
- **v0.18.0** ships streaming milestone A (`LiveChange` source-side, independent of columnar).
- **v0.18.x** lands the framework layer (this design doc's scope) — likely 3–4 patch releases as sub-steps 1a through 1h ship sequentially.
- **v0.19.0** is the first user-visible substrate landing (TimeSeries integration, step 2).
- Subsequent versions per the V2 release shape.

## What the implementation team should do first

1. Read this document end-to-end.
2. Read the RFC's V3 amendment section for context on commitments.
3. Read the synthesis brief for the bottom-up evidence base.
4. Start sub-step 1a — `Column` interfaces + `Float64Column` / `BooleanColumn` + `ValidityBitmap`. Smallest, most isolated piece; lands the foundational types the rest build on.
5. Two-pass review (Layer 2 + Codex) per PR. Each sub-step's PR includes its own test surface + bundle-size delta.

This document is the answer key. The implementation work is plumbing it in.
