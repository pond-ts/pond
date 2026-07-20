# PND_CORE_PLAN — core batch/react backlog

> Breakout plan for the **Core** roadmap section in [PLAN.md](../../PLAN.md).
> Historical context: the audit notes
> ([technical-audit-2026-06.md](../notes/technical-audit-2026-06.md),
> [technical-audit-2026-06-v2.md](../notes/technical-audit-2026-06-v2.md)) and
> the archived phase logs in [docs/archive/](../archive/).

## Tasks

### [PND-COLAPI] — Bundle-safe column API + validity-aware bulk read

The top charts→core carry-forward (F-1, HIGH): the prototype-augmented
column-API methods (`toFloat64Array`, `at`, `slice`, scalar reductions) are
**tree-shaken out of Vite/Rollup browser bundles** despite
`sideEffects: ["./dist/column.js"]` — they work in Node but throw in a
bundled app. Full analysis:
[docs/notes/charts-m1-friction.md](../notes/charts-m1-friction.md). Ship with
it: a validity-aware **`column.toFloat64Array({ missing })`** (both the fit
lib and charts hand-roll "missing → NaN"; two consumers), and
**`column.hasAnyDefined()` / `allMissing()`** (replaces estela's O(N)
presence scan, backs `series.has(col)`).

### [PND-WIRE] — Protobuf columnar wire + streaming append

The wire-format contract is design-settled (JSON rows = REST/dev default;
JSON columnar = bulk endpoint; protobuf columnar = binary/streaming feed —
all through the one `fromColumns`/`fromJSON` door). Remaining build:
the reference **protobuf columnar codec** (packed-double blob →
`Float64Array` view → `fromColumns`, delta-encoded key column) and the
**`SeriesUpdate{from_index, appended}`** streaming/append extension onto
`LiveSeries`. Driver: Tidal's binary WS feed (SpiderRock). Measured sizing
record and design rationale: the "Wire format + columnar ingress" section of
[docs/archive/charts-wave-2026.md](../archive/charts-wave-2026.md).

### [PND-INGEST] — `fromColumns({ onOutOfOrder: 'throw' | 'sort' | 'clamp' })`

Reopens the #344 `clampNonDecreasing` reject with a second real signal
(Tidal's noisy time samples): clamp (carry-forward a lone backwards blip) is
a distinct, sometimes-more-correct op from sort. Fold the existing
`sort?: boolean` into the enum (keep `sort: true` as a one-release alias);
default stays `throw`.

### [PND-TSVAR] — `TimeSeries<S>` variance refactor + `toJSON` narrowing

`toJSON()` returns the loose schema and `RowForSchema` can't honor
`required: false` because tightening either propagates variance through every
method that returns `TimeSeries<S>`, breaking four overload sets
(`pivotByGroup`, `rolling`, `arrayAggregate`, `arrayExplode`). Fix requires a
class-wide variance refactor (covariant read-side split, or per-overload
type-level helpers). Cheaper first attempt for the toJSON half: extract the
serialization body to a module-level `serializeToJSON<S>` helper both classes
wrap thinly. Full write-ups in
[phases-0-3-foundations.md](../archive/phases-0-3-foundations.md) and the
snapshot/append section of
[phase-4-live-composition.md](../archive/phase-4-live-composition.md).

### [PND-GATHER] — Dashboard snapshot-cost queue

Surface-minimal items from the 256-host stress reports, ranked by
value-per-surface: **`TimeSeries.partitionBy().toMap()` gather-only** (the
snapshot dual of the `LiveView` memo; workaround already bought
218 ms → 300 μs), **`column.dropMissing()`** (the one correctness item),
NaN-as-missing error nudge, `push`×N vs `pushMany` JSDoc warning (90,000×
gap).

### [PND-AUDIT] — v2-audit P2 backlog

The non-P0/P1 residue of the 2026-06 audits (task numbers from the audit
triage): #104 papercuts (`collapse` mixed-kind row-0 inference, inconsistent
unknown-column handling across 6 ops, `kind→builder` triplication,
`withKeyColumn` naming, subarray-retention docs), #106 row/columnar parity
matrix (NaN-untested surfaces), #118 smaller items
(`Sequence.calendar('hour')` unit validation, dead `validateAndNormalize`
cleanup, #200 self-casts, F3–F12 doc/type), #100 CI TZ matrix +
perf-scripts-in-CI + coverage, #102 cast growth + type-safe schema helpers,
#108 bundle-size re-pin (48.5 KB vs the <25 KB RFC target).

### [PND-CITYPE] — CI type-check widening

`npm run verify` doesn't type-check `test/` (vitest strips types;
`test:type` covers `src` + `test-d/` only), so a public-API type break can
land without `verify` failing — this is how v0.14.2 happened. Add
`tsc -p tsconfig.vitest.json --noEmit` to verify; blocked by ~30 existing
type errors in test files (~half a day of cleanup).

### [PND-PERF] — Micro-perf leftovers (low priority, incremental)

From the original audit, still open: `Time`/`Interval` comparisons allocate a
throwaway `TimeRange`; `Event` double-`Object.freeze` overhead; `rows` getter
materializes N frozen arrays per access; `aggregateValues` double-filter;
`compareEventKeys` `localeCompare` tiebreak; `joinMany` pairwise instead of
N-way merge; `parseDurationInput` duplication.

### [PND-REACT] — React layer remainders

Document `rate()`/`diff()`/`pctChange()` behavior at `dt = 0` (concurrent
events → `undefined`; a `rateOver({ every })` variant may earn its keep
later); dashboard-guide fixes (lead with `useLiveQuery`; document derived
views × retention); the audit-suggested `useSyncExternalStore` migration.

## Parking lot

- `unpivot` (wide-to-long) — manual workaround documented; promote on a real
  case.
- `percentiles(...qs)` multi-quantile reducer — three `pNN` columns is cheap
  and loses no efficiency.
- `fromTrustedColumns` skip-validation escape hatch — `fromColumns` +
  `withColumn`'s validated attach cover today's consumers.
- `F-schema-key-name` (key column must be named `time`) — structural blast
  radius; JSDoc clarification landed; revisit if it recurs.
- Operator extraction for the live god-files (`live/live-series.ts`,
  `live/live-partitioned-series.ts`) — the batch extraction template exists.
- Shared `columnFromValuesByKind` kind→builder dispatch (duplicated across
  `fillOp` / `mapOp` / `collapseOp`).
- Tighter `DurationString` template-literal type — bounded-union dead end
  documented in `utils/duration.ts`.
