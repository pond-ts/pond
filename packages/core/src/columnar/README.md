# Columnar framework

This directory holds the columnar storage substrate that underpins
pond-ts internals starting in Phase 4.7. The framework is a **pure
indexed columnar data store** — it knows about typed arrays,
columns, key buffers, and indexed access, but it does **not** know
about pond-ts row-API types (`Event`, `EventKey`, `Time`,
`TimeRange`, `Interval`).

Row-API materialization lives one layer up in
[`../series-store.ts`](../series-store.ts) (`SeriesStore<S>`), which
wraps a `ColumnarStore` with a `SeriesSchema` and provides
`eventAt` / `toEvents` / `Symbol.iterator` / row-shape exports plus
the lazy `Map<number, Event>` cache and the five public-API
invariants from the RFC.

## What's in here

| File               | Sub-step | Contents                                                               |
| ------------------ | -------- | ---------------------------------------------------------------------- |
| `validity.ts`      | 1a       | `ValidityBitmap` — bit-packed validity tracking                        |
| `column.ts`        | 1a       | `Column` discriminated union; `Float64Column`, `BooleanColumn`         |
| `string-column.ts` | 1b       | `StringColumn` (dict-encoded + fallback), dictionary heuristic         |
| `array-column.ts`  | 1c       | `ArrayColumn` (fallback mode) + empty-array sentinel                   |
| `key-column.ts`    | 1c       | `TimeKeyColumn`, `TimeRangeKeyColumn`, `IntervalKeyColumn` (buffers)   |
| `store.ts`         | 1d       | `ColumnarStore<S>` — schema-validated typed store; pure indexed access |
| `index.ts`         | (barrel) | Internal-only re-exports                                               |
| _later sub-steps_  | 1e–1h    | Builders, views, chunked columns, ring buffer                          |

See [`docs/briefs/columnar-framework-design.md`](../../../../docs/briefs/columnar-framework-design.md)
for the full design.

## Boundary contract

**Pure substrate.** Nothing under `columnar/` imports from outside
this directory at runtime, and the only allowed type imports are
from peer files within `columnar/` itself. The framework owns its
own type vocabulary in
[`types.ts`](types.ts) — `ColumnDef`, `ColumnSchema`,
`ScalarValue`, `ArrayValue`, `KeyKind`, `AnyColumnKind`.

The row-API library's `SeriesSchema` (`packages/core/src/types.ts`)
is structurally compatible with the framework's `ColumnSchema`,
so the row-API adapter at `series-store.ts` passes its own `S
extends SeriesSchema` parameter through to `ColumnarStore<S>`
without friction. The framework doesn't know that `SeriesSchema`
exists.

**Forbidden upstream imports.** The independence test in
`series-store.test.ts` enforces this by scanning every file under
`columnar/` for imports from:

- `TimeSeries`, `LiveSeries`, `PartitionedTimeSeries`, etc.
  (operators)
- `Event`, `Time`, `TimeRange`, `Interval` (row-API value classes)
- `temporal` (the row-API key interface module)
- `types` (pond-ts's row-API type module — framework has its own
  at `columnar/types.ts`)
- `reducers/` (operator implementations)

**No external runtime.** The framework provides Apache
Arrow-compatible concepts without depending on Arrow JS. Future
doors (Arrow zero-copy export, WASM kernels, WebGPU) stay open;
nothing is built for them in v1.0.

## Conventions

- **Validity bitmap is optional.** `column.validity` absent means
  every cell is defined; build code only allocates a bitmap when
  at least one slot is missing.
- **Buffer slots for invalid cells are arbitrary.** Consumers must
  consult `validity` before treating a slot as meaningful.
- **`sliceByRange` is buffer-zero-copy where the kind allows it.**
  `Float64Column.sliceByRange` returns a `subarray` view;
  `BooleanColumn.sliceByRange` repacks because bit boundaries
  don't align to byte boundaries.
- **`sliceByIndices` always materializes.** Index-projection
  zero-copy lives at the store level via `withRowSelection`
  (sub-step 1f).
- **Defensive ownership of caller-supplied references.** Builders /
  factories that accept caller arrays or maps copy them at
  construction time (matches the PR #134 round-2 / PR #135 L2
  pattern). The framework never trusts a `ReadonlyMap` /
  `ReadonlyArray` to be runtime-immutable.
- **Sentinel for `scan(skipInvalid: false)`.** Invalid rows
  receive a documented sentinel matching the column's value type:
  `0` for numeric, `false` for boolean, `''` for string,
  `EMPTY_ARRAY_SENTINEL` for array.

## Test surface

Independent tests live at `packages/core/test/columnar/`. They
construct and exercise columnar primitives without importing from
`TimeSeries` / `LiveSeries` / `Event` / etc. Target: ~280
framework-only tests by the end of sub-step 1d. The cross-module
independence test (with the import-graph scan) lives in
`test/series-store.test.ts` and runs against this directory's
files.
