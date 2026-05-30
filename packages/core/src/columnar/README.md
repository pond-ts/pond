# Columnar framework

The columnar storage substrate that underpins pond-ts internals starting
in Phase 4.7. A **pure indexed columnar data store** — it knows about
typed arrays, columns, key buffers, validity bitmaps, and indexed
access, but it does **not** know about pond-ts row-API types (`Event`,
`EventKey`, `Time`, `TimeRange`, `Interval`).

Row-API materialization lives one layer up in
[`../live/series-store.ts`](../live/series-store.ts) (`SeriesStore<S>`),
which wraps a `ColumnarStore` with a `SeriesSchema` and provides
`eventAt` / `toEvents` / `Symbol.iterator` / row-shape exports plus the
lazy `Map<number, Event>` cache and the five public-API invariants from
the RFC.

**As of v0.18.0 (Phase 4.7 step 8), the per-kind column classes are
public.** The `Float64Column` / `BooleanColumn` / `StringColumn` /
`ArrayColumn` classes, their chunked variants, and the `KeyColumn`
variants are re-exported from [`packages/core/src/index.ts`](../index.ts)
so consumers can name the types `series.column('x')` returns. The
public-facing method surface (reductions, `bin`, `toFloat64Array`,
`at` / `slice`) is mounted onto these classes from
[`../column.ts`](../column.ts), one layer up, so this directory stays a
pure substrate (no reducer dependency — enforced by the `series-store`
purity test).

The rest of this directory remains framework-internal and may evolve
without a major bump: builders, validity helpers, `ColumnarStore`, view
transforms, `concatSorted`, `scatterByPartition`, `ColumnarRingBuffer`.

## What's in here

| File                                     | Sub-step | Contents                                                                                  |
| ---------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| [`validity.ts`](validity.ts)             | 1a       | `ValidityBitmap` — bit-packed validity tracking; one-shot `freeze` snapshot               |
| [`column.ts`](column.ts)                 | 1a, 1g   | `Column` union; `Float64Column`, `BooleanColumn`; `kind` + `storage` discriminators       |
| [`string-column.ts`](string-column.ts)   | 1b       | `StringColumn` (dict-encoded + fallback); dict ops + heuristic                            |
| [`array-column.ts`](array-column.ts)     | 1c       | `ArrayColumn` (fallback mode); element-wise contract; defensive freeze                    |
| [`key-column.ts`](key-column.ts)         | 1c, 1f   | `TimeKeyColumn`, `TimeRangeKeyColumn`, `IntervalKeyColumn`; `sliceByIndices`              |
| [`types.ts`](types.ts)                   | 1d       | Framework-local types (`ColumnDef`, `ColumnSchema`, `ScalarValue`, `ArrayValue`)          |
| [`store.ts`](store.ts)                   | 1d       | `ColumnarStore<S>` — schema-validated indexed store; pure substrate                       |
| [`builder.ts`](builder.ts)               | 1e       | Per-kind builders with one-shot `finalize` and amortized O(1) capacity doubling           |
| [`view.ts`](view.ts)                     | 1f, 1g   | `withRowSelection`, `materialize`, zero-copy schema ops                                   |
| [`chunked-column.ts`](chunked-column.ts) | 1g       | Four chunked variants + eager aggregate validity + per-kind `materializeChunked*` helpers |
| [`concat.ts`](concat.ts)                 | 1g       | `concatSorted` — N-way temporally-disjoint concat                                         |
| [`ring-buffer.ts`](ring-buffer.ts)       | 1h       | `ColumnarRingBuffer<S>` — mutable circular buffer with failure-atomic append              |
| [`scatter.ts`](scatter.ts)               | 1h       | `scatterByPartition` — partition by scalar value column                                   |
| [`index.ts`](index.ts)                   | (barrel) | Internal-only re-exports                                                                  |

Total: ~6,100 lines of source. See
[`docs/briefs/columnar-framework-design.md`](../../../../docs/briefs/columnar-framework-design.md)
for the full design and [PLAN.md](../../../../PLAN.md) Phase 4.7 for
the sub-step roster.

## Core concepts

### `ColumnarStore<S>`

The framework's primary read-only container. Composes:

- A `KeyColumn` (one of three kinds) — pure typed-buffer key storage.
- A `ReadonlyMap<columnName, Column>` of value columns.
- A declared `schema: S` (a `ColumnSchema` from `types.ts`).

Provides indexed-access accessors (`beginAt(i)`, `endAt(i)`,
`valueAt(rowIndex, columnName)`) and the structural validation
described under "Trust boundaries" below. Construction goes through
`ColumnarStore.fromTrustedStore(schema, keys, columns)` — the
constructor is private to keep the column / key / schema shape
consistent.

### Column union: `kind` + `storage` discriminators

`Column` is an 8-variant discriminated union — four scalar kinds, two
storage modes per kind:

| `kind`      | `storage: 'packed'`              | `storage: 'chunked'`   |
| ----------- | -------------------------------- | ---------------------- |
| `'number'`  | `Float64Column` (`Float64Array`) | `ChunkedFloat64Column` |
| `'boolean'` | `BooleanColumn` (bit-packed)     | `ChunkedBooleanColumn` |
| `'string'`  | `StringColumn` (dict + fallback) | `ChunkedStringColumn`  |
| `'array'`   | `ArrayColumn` (fallback)         | `ChunkedArrayColumn`   |

Narrow on `kind` first, then on `storage`, to reach the kind-specific
hot-path fields:

```ts
if (col.kind === 'number') {
  if (col.storage === 'packed') {
    col._values; // Float64Array — direct iteration for reducers
  } else {
    col.chunks; // ReadonlyArray<Float64Column>
  }
}
```

Both modes implement the same interface: `read(i)` / `scan(fn,
options)` / `sliceByRange(start, end)` / `sliceByIndices(indices)`.
Callers using only those methods work transparently across either
storage; only reducers and other hot-path callers need to narrow.

`materialize(store)` compacts every chunked value column into its
plain counterpart, so reducers can guarantee `storage === 'packed'`
with a single up-front call.

### Key column variants

| Kind          | Class                | Storage                                                         |
| ------------- | -------------------- | --------------------------------------------------------------- |
| `'time'`      | `TimeKeyColumn`      | Single `Float64Array`; `end === begin` (same buffer reference)  |
| `'timeRange'` | `TimeRangeKeyColumn` | `begin` + `end` `Float64Array`s; `begin[i] <= end[i]` validated |
| `'interval'`  | `IntervalKeyColumn`  | `begin` + `end` + labels (`StringColumn \| Float64Column`)      |

`IntervalKeyColumn` discriminates its label storage at the column
level via `labelKind: 'string' | 'number'`. Numeric labels reject
`NaN` / `Infinity` at construction (numeric labels must be finite
for ordering semantics); string labels go through the standard
`StringColumn` dict-vs-fallback heuristic.

Each variant exposes `beginAt(i)`, `endAt(i)`, and `sliceByIndices` for
gather. Out-of-range `beginAt` / `endAt` throw `RangeError`; the
`sliceByIndices` helper writes default `0` for out-of-range source
indices (the framework's view-store eagerly validates indices before
reaching this path — see `withRowSelection`).

### Validity bitmap

`column.validity` is an optional `ValidityBitmap` — packed 1 bit per
row, `bits[i >> 3] & (1 << (i & 7))` is the bit for row `i`. The
field is **absent** when every cell is defined; build code only
allocates a bitmap when at least one slot is missing.

`MutableValidityBitmap` (used by builders during column construction)
has a one-shot `freeze()` that copies bits into a fresh `Uint8Array`
— the frozen snapshot can't alias the mutable buffer. Subsequent
`set` / `clear` / `freeze` calls throw, which prevents a builder
from corrupting an already-finalized column.

### `ColumnSchema` vs `SeriesSchema`

The framework owns its own type vocabulary in
[`types.ts`](types.ts) — `ColumnDef`, `ColumnSchema`, `ScalarValue`,
`ArrayValue`, `KeyKind`, `AnyColumnKind`. The row-API library's
`SeriesSchema` (`packages/core/src/types.ts`) is **structurally
compatible** with `ColumnSchema`, so the row-API adapter at
`live/series-store.ts` passes its own `S extends SeriesSchema`
parameter through to `ColumnarStore<S>` without type-level friction.
The framework doesn't know that `SeriesSchema` exists.

## Storage modes

### Packed (plain)

A single flat typed buffer per column — `Float64Array` for `'number'`,
bit-packed `Uint8Array` for `'boolean'`, dictionary + indices (or
fallback array) for `'string'`, `(ArrayValue | undefined)[]` for
`'array'`. This is the default mode for store construction and what
reducers consume.

### Chunked

A sequence of plain chunks composed into a single logical column
without copying the underlying buffers. Used for:

- **`concatSorted` of N temporally-disjoint stores** — each input
  store's value column becomes one chunk of the output. Zero-copy.
- **Streaming append (LiveSeries)** — emitted batches can be added
  as fresh chunks rather than reallocating-and-copying a single flat
  buffer.

Each chunked variant holds `chunks: ReadonlyArray<PlainVariant>` +
`chunkOffsets: Int32Array` (prefix sum, length = `chunks.length + 1`).
Row→chunk lookup is a linear scan for small chunk counts (under 9)
or binary search beyond. Reads / scans / multi-chunk slices stay
chunked; `sliceByIndices` materializes (gather destroys chunk
locality).

**Aggregate validity is computed eagerly** at construction by walking
each chunk's per-chunk validity. This preserves the "no bitmap ⇒ all
cells defined" convention so `col.validity === undefined` reliably
means "all cells defined" — a chunked column can't silently mask
invalid cells.

**Chunks are always plain.** `concatSorted` flattens chunked inputs
into their constituent chunks so the chunked-column data structure
stays one level deep.

### Mutable ring (streaming)

`ColumnarRingBuffer<S>` is a mutable, append-only circular buffer
sized by `retention`. Used for streaming sources (LiveSeries, gRPC
ingest, websocket feeds). The framework's ring is
**ordering-agnostic** — strict / drop / reorder semantics live at the
`LiveSeries` adapter layer per RFC V4.

Internal layout per row `i` lives at physical position
`(head + i) % capacity`. Lazy growth (default) starts at
`min(retention, 64)` and doubles to `retention`. Eviction advances
`head` once `length === retention`. `snapshot()` builds an immutable
`ColumnarStore<S>` with owned typed buffers in logical order; the
snapshot is decoupled from subsequent ring mutations.

## Operation families

### View / derivation primitives

[`view.ts`](view.ts) provides six framework-level ops that produce a
derived `ColumnarStore<S>`:

- `withRowSelection(source, indices)` — materializing gather via
  per-column `sliceByIndices`. Eagerly validates every index is in
  `[0, source.length)`.
- `materialize(view)` — compacts chunked value columns to plain;
  identity fast-path when every column is already packed.
- `withColumnsRenamed(source, renames)` — schema rename; buffers
  shared by reference.
- `withColumnReplaced(source, name, column)` — replace one value
  column; kind + length must match.
- `withColumnAppended(source, name, column)` — append a new value
  column; length must match.
- `withColumnsSelected(source, names)` — project to a subset of
  value columns. Empty `names` is allowed (key-only store).

The five schema ops are genuinely zero-copy on column buffers — they
compose a fresh schema and columns `Map` while keeping the same
column instances.

### `concatSorted`

[`concat.ts`](concat.ts) provides N-way concat over temporally-disjoint
sorted stores. Validates schema structural equality, key disjointness
(strict `<` for Time, half-open `<=` for TimeRange/Interval), and
runs `validateColumnLength` on the aggregate before allocating any
flat key buffer. Output: materialized key column, chunked value
columns (flattens nested chunking).

### `scatterByPartition`

[`scatter.ts`](scatter.ts) partitions a store by a scalar value
column. Returns `Map<ScalarValue, ColumnarStore<S>>`. Per-bucket
sub-stores preserve schema and relative row order; cross-bucket order
is unspecified (it's a Map). Loud-failure default: throws on the
first undefined partition cell. Pass `{ onUndefined: 'drop' }` for
lax behavior. NaN bucketed under the `NaN` key (JS Map's
SameValueZero makes it stable).

### Ring buffer

[`ring-buffer.ts`](ring-buffer.ts) — `appendBatch(batch)`,
`evictPrefix(n)`, `snapshot()`. Per the "failure-atomic" patterns
below, every destructive mutation is sequenced after the throwing
work.

## Trust boundaries and invariants

### What each layer validates

- **`Float64Column` constructor** — buffer underflow, validity length
  match.
- **`StringColumn` constructor** — mutually exclusive dict / fallback
  modes; in-range dictionary indices for defined cells; fallback
  no-validity invariant; explicit validity consistency.
- **`ArrayColumn` constructor** — element-wise `ArrayValue` contract
  (every element finite-number / string / boolean); defensive freeze
  on every cell.
- **`TimeKeyColumn` / `TimeRangeKeyColumn` / `IntervalKeyColumn`
  constructors** — finite timestamps; intra-row `begin <= end`;
  per-row label defined for intervals; finite numeric labels.
- **`ColumnarStore.fromTrustedStore`** — key kind matches `schema[0]`;
  schema column names unique; every schema value column present in
  the columns map with matching kind + length; no extra columns;
  reserved unsafe names (`__proto__` / `prototype` / `constructor`)
  rejected.
- **`ColumnarRingBuffer` constructor** — retention is a non-negative
  integer ≤ `MAX_COLUMN_LENGTH`; `schema[0].kind` is a key kind;
  every value column's kind is one of `'number' | 'boolean' |
'string' | 'array'`; `intervalLabelKind` required iff the schema
  is interval-keyed.
- **`appendBatch`** — schema structural equality with the ring;
  matching `labelKind` for interval rings.
- **`concatSorted`** — schema structural equality across inputs; key
  disjointness; aggregate `MAX_COLUMN_LENGTH` before allocation.
- **`scatterByPartition`** — partition column not the key column; not
  array-kind; validated `onUndefined`.

### Failure-atomic operations

Both the ring buffer's `#grow` and `appendBatch` are **failure-atomic
under memory pressure**. The invariants:

- **`#grow`** — builds all replacement key + value rings into local
  variables first, then commits by swapping `#keys` / `#values` /
  `#head` / `#capacity` in one block. If any allocation throws, the
  ring is unchanged.
- **`appendBatch`** — pre-stages every array-column cell (the
  `slice()` + `Object.freeze` work that can throw under memory
  pressure) BEFORE applying any destructive op. Then calls
  `#grow` (atomic). Then applies `#clearAllSlots` or
  `evictPrefix`. Then performs the actual writes (pure
  reference-assignment loop, no allocation). A throw at any step
  leaves the ring exactly as it was.

These are documented in JSDoc on the methods. Deterministic
allocation-failure injection isn't feasible in JS without
monkey-patching typed-array constructors, so the structural ordering
is the proof of atomicity.

### Defensive ownership

Caller-supplied references are copied / frozen at construction time
so a caller mutating the source after handoff can't corrupt the
framework's invariants:

- `ColumnarStore.fromTrustedStore` copies the columns `Map`.
- `ChunkedFloat64Column` (etc.) `slice()` + `Object.freeze` the
  caller's `chunks` array.
- `ArrayColumn` constructor copies every defined cell, then
  `Object.freeze`s each.
- `MutableValidityBitmap.freeze()` copies the underlying `Uint8Array`
  before handing the snapshot back.
- `ColumnarRingBuffer.appendBatch` defensively `slice()` + freezes
  array-column source cells during the pre-stage phase.

### Sentinels for `scan({ skipInvalid: false })`

Invalid rows receive a documented per-kind sentinel matching the
column's value type:

- `Float64Column`: arbitrary slot value (typically `0`).
- `BooleanColumn`: arbitrary slot value (typically `false`).
- `StringColumn`: `''` (empty string) — uniform across dict-encoded
  and fallback modes.
- `ArrayColumn`: shared frozen `EMPTY_ARRAY_SENTINEL` (identity-
  comparable for "this row was invalid").

Callers consult `column.validity` for the authoritative defined-state.

## Boundary contract

**Pure substrate.** Nothing under `columnar/` imports from outside
this directory at runtime, and the only allowed type imports are
from peer files within `columnar/` itself.

**Forbidden upstream imports.** The independence test in
[`test/series-store.test.ts`](../../test/series-store.test.ts) scans
every file under `columnar/` for imports from:

- `TimeSeries`, `LiveSeries`, `PartitionedTimeSeries`,
  `LivePartitionedSeries`, `LiveAggregation`, `LiveRollingAggregation`,
  `LiveFusedRolling`, `LiveView`, `LiveReduce`,
  `LivePartitionedFusedRolling`, `LivePartitionedSyncRolling` —
  operator implementations.
- `Event`, `Time`, `TimeRange`, `Interval` — row-API value classes.
- `temporal` — row-API key interface module.
- `types` — pond-ts's row-API type module (framework has its own at
  `columnar/types.ts`).
- `reducers/` — operator implementations directory.

This test fires on every build. Adding a new file here, or changing
an existing file's imports, must keep this set empty.

**No external runtime.** The framework provides Apache Arrow-compatible
concepts without depending on Arrow JS. Future doors (Arrow zero-copy
export, WASM kernels, WebGPU) stay open; nothing is built for them
in v1.0.

## Adding to the framework

### A new column kind

1. Add the discriminator value to `ColumnKind` in
   [`types.ts`](types.ts) and `column.ts`.
2. Create `src/columnar/<kind>-column.ts` with a class implementing
   `kind` + `storage: 'packed'` + `length` + `validity?` + the four
   methods (`read`, `scan`, `sliceByRange`, `sliceByIndices`).
3. Add a `Chunked<Kind>Column` to [`chunked-column.ts`](chunked-column.ts)
   following the existing pattern (delegate `read` + `scan` to chunks,
   provide a `materializeChunked<Kind>` helper).
4. Widen the `Column` union in [`column.ts`](column.ts).
5. Add cases to [`concat.ts`](concat.ts)'s value-column dispatch.
6. Add init / regrow / snapshot / write branches to
   [`ring-buffer.ts`](ring-buffer.ts)'s helpers.
7. Add per-kind tests at `test/columnar/<Kind>Column.test.ts`.

### A new view / derivation op

1. Add to [`view.ts`](view.ts) following the `withRowSelection` /
   `withColumnsRenamed` shape. Construct outputs via
   `ColumnarStore.fromTrustedStore` so structural validation runs.
2. Add tests at `test/columnar/View.test.ts`.

### A new store-level operation

If the op composes views, put it in [`view.ts`](view.ts). If it
needs a new storage shape (chunked, ring, etc.), follow the
`concat.ts` / `ring-buffer.ts` pattern: separate file, internal
helpers prefixed with the operation name, tests in a matching
file at `test/columnar/`.

## Deferred / future doors

These were considered and intentionally skipped during step 1; the
code is structured to absorb them later without API breakage.

- **Chunked key columns.** `concatSorted` currently materializes
  the key column even when value columns stay chunked. Keys are
  smaller than value columns and uniform `keyAt` accessors stay
  simpler this way. A chunked key variant lands when streaming
  workloads show the O(N) key copy is the bottleneck.
- **Lazy view-mode columns.** `withRowSelection` is materializing;
  the framework brief sketched a path where row-selection produces
  a view-mode column that defers gathering until a hot-path
  reducer triggers it. Behind the same API.
- **Arrow JS zero-copy export.** The buffer shapes are Arrow-
  compatible already. A `toArrow(store)` helper can land in step 2+
  without touching the substrate.
- **ArrayColumn length-prefix encoding.** Currently `ArrayColumn` is
  fallback-only. A length-prefix mode (`offsets: Int32Array` +
  `values: Column`) for arrays sharing a homogeneous element kind
  is sketched in the design brief; deferred until a reducer
  earns it.
- **`StringColumn` cross-chunk dictionary unification.**
  `ChunkedStringColumn` keeps per-chunk dictionaries. Building a
  union dictionary at construction would let dict-encoded reads
  stay on the integer-index hot path even across chunks, but the
  cost is paid eagerly even when callers only do read / scan.
  The deferred path: `materialize` rebuilds with
  `stringColumnFromArray` which makes the dict-vs-fallback
  decision once across the whole compacted column.
- **WASM kernels.** Reducers that operate on packed `Float64Array`
  buffers can be replaced with WASM implementations without
  touching the substrate. The discriminator and method interfaces
  give us the contract.
- **`SharedArrayBuffer` + Worker pool for reducer parallelism.**
  The substrate's packed `Float64Array` / `Uint8Array` buffers are
  shape-compatible with `SharedArrayBuffer` — a worker pool could
  partition row ranges across cores for `sum` / `count` / `groupby`
  /`filter` with zero serialization. Deferred for two reasons:
  (1) v1.0 is browser-first, and `SharedArrayBuffer` requires
  cross-origin isolation (`COOP` + `COEP` response headers) which
  many hosts don't ship by default; (2) keeping a single substrate
  shape across Node and browser is more valuable than per-runtime
  perf wins at this stage. The trigger is a Node-side reducer
  workload (likely in step 5+ — string / dictionary reducers, or
  the aggregate planner) where the parallelism payoff covers the
  workers'-startup-cost floor, and where we can plumb an opt-in
  pool without affecting the browser shape. Adjacent prior art:
  `@cervid/data` makes this its core perf story for Node-only
  dataframes; the typed-array layout there is structurally
  identical to ours.

## Test surface

Independent tests live at
[`packages/core/test/columnar/`](../../test/columnar/). They construct
and exercise columnar primitives without importing from `TimeSeries` /
`LiveSeries` / `Event` / etc. Current count: **490 framework-only
tests** across 12 test files at the end of sub-step 1h. The
cross-module independence test (with the forbidden-import scan
described above) lives in
[`test/series-store.test.ts`](../../test/series-store.test.ts) and runs
against this directory's files on every build.

Per-file test counts:

| Test file                    | Tests | Covers                                                            |
| ---------------------------- | ----: | ----------------------------------------------------------------- |
| `ValidityBitmap.test.ts`     |    69 | Bit-packing, popcount, slice / gather, mutable freeze             |
| `Column.test.ts`             |    47 | Float64 + Boolean read / scan / slice / sliceByIndices            |
| `StringColumn.test.ts`       |    94 | Dict + fallback modes, remap-to-target-dict, heuristic            |
| `ArrayColumn.test.ts`        |    37 | Element-wise contract, defensive freeze, sentinel                 |
| `KeyColumn.test.ts`          |    24 | Three key kinds, sliceByIndices, label kind discrimination        |
| `ColumnarStore.test.ts`      |    17 | Construction validation, defensive map ownership                  |
| `ColumnBuilder.test.ts`      |    34 | One-shot finalize, capacity doubling, overwrite paths             |
| `View.test.ts`               |    49 | All six derivation ops, eager index validation, unsafe names      |
| `ChunkedColumn.test.ts`      |    42 | Four chunked variants, aggregate validity, binary-search path     |
| `Concat.test.ts`             |    20 | Three key kinds, schema mismatch, maxEnd disjointness             |
| `ColumnarRingBuffer.test.ts` |    41 | Per-kind round-trips, growth, eviction, atomic append, decoupling |
| `Scatter.test.ts`            |    16 | Per-kind partitions, NaN bucketing, drop policy, typo guard       |
