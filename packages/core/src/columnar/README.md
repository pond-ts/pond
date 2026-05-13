# Columnar framework

This directory holds the columnar storage substrate that underpins
pond-ts internals starting in Phase 4.7. The framework is the v1.0
foundation; consumers (`TimeSeries`, `LiveSeries`, reducers, etc.)
import from it via relative paths.

## What's in here

| File              | Sub-step | Contents                                                                                  |
| ----------------- | -------- | ----------------------------------------------------------------------------------------- |
| `validity.ts`     | 1a       | `ValidityBitmap` — bit-packed validity tracking                                           |
| `column.ts`       | 1a       | `Column` discriminated union; `Float64Column`, `BooleanColumn`                            |
| `index.ts`        | (barrel) | Internal-only re-exports                                                                  |
| _later sub-steps_ | 1b–1h    | `StringColumn`, `ArrayColumn`, `KeyColumn`, `ColumnarStore`, builders, views, ring buffer |

See [`docs/briefs/columnar-framework-design.md`](../../../../docs/briefs/columnar-framework-design.md)
for the full design, including module layout and primitive contracts.

## Boundary contract

**Internal only.** Nothing in this directory is re-exported from
`packages/core/src/index.ts`. The framework's API surface is mobile
during v1.0 development — primitives may move, rename, or restructure
without a major-version bump. Once public API operators that consume
the framework stabilize, the public surface they expose stabilizes;
the framework stays internal.

**No upstream dependencies.** Files under `columnar/` do not import
from `TimeSeries`, `LiveSeries`, or any operator. The framework
provides primitives; the rest of pond-ts is built on them, not the
other way around. An independence test (lands with sub-step 1d) pins
this rule.

**No external runtime.** The framework provides Apache Arrow-compatible
concepts without depending on Arrow JS. Future doors (Arrow zero-copy
export, WASM kernels, WebGPU) stay open; nothing is built for them
in v1.0.

## Conventions

- **Validity bitmap is optional.** `column.validity` absent means
  every cell is defined; build code only allocates a bitmap when at
  least one slot is missing.
- **Buffer slots for invalid cells are arbitrary.** Consumers must
  consult `validity` before treating a slot as meaningful.
- **`sliceByRange` is buffer-zero-copy where the kind allows it.**
  `Float64Column.sliceByRange` returns a `subarray` view;
  `BooleanColumn.sliceByRange` repacks because bit boundaries don't
  align to byte boundaries.
- **`sliceByIndices` always materializes.** Index-projection
  zero-copy lives at the store level via `withRowSelection`
  (sub-step 1f).

## Test surface

Independent tests live at `packages/core/test/columnar/`. They
construct and exercise columnar primitives without importing from
`TimeSeries` / `LiveSeries`. Target: ~200 framework-only tests by
the end of sub-step 1h.
