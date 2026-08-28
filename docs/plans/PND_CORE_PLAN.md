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

## [PND-AGGCOVER] — `aggregate` covers its range (2026-08-28)

**Shipped.** Reported by Tidal in [#672](https://github.com/pond-ts/pond/pull/672)
(`docs/notes/tidal-aggregate-leading-bucket-2026-08.md`, cross-ref F-charts-16):
`aggregate` emitted the first grid boundary _at or after_ the first event, so
events between the two aggregated into nothing — silently. 60 daily bars rolled
to a calendar month came back holding 38.

**Root cause, and why it was one line.** `Sequence.bounded()` selected buckets
by asking whether the bucket's **sample point** fell in the range, not whether
its **extent** overlapped it. In the fixed branch that was a `Math.ceil` on the
first index; in the calendar branch it was starker — `toPlainDateStart` floors
`range.begin()` to the containing bucket at the top of the loop, and the
inclusion test one block below then discarded exactly that bucket. The flooring
Tidal re-implemented as `floorToWindow` in the consumer was already sitting in
pond, a few lines above the test that threw its result away.

The reported asymmetry (trailing partial kept, leading dropped) falls out of the
same test: both edges compare the bucket's _begin_, which is symmetric in sample
terms and asymmetric in coverage terms.

**The fix.** `bounded()` gained `coverage: 'sample' | 'overlap'` (new exported
type `SequenceCoverage`); `aggregate` realizes with `'overlap'`. Because
`'overlap'` only moves the leading edge — the trailing test `begin <=
range.end()` is what `lastIndex` already computes — the change is provably
confined to the bucket containing `range.begin()`.

**Decisions, and what was rejected:**

- **Fixed in `bounded()`, not at the `aggregate` call site.** Pre-flooring the
  range inside `aggregate` needs a calendar floor, which means exporting or
  duplicating `toPlainDateStart` — precisely the duplication the report was
  filed about.
- **Default, not opt-in** (the report's ask #1 over its ask #2). The behaviour
  contradicted `aggregate`'s own documented membership rule, so it is a bug;
  a flag to opt into correctness ages badly. Cost accepted: row counts and
  sums change for any caller whose first event was off-boundary. Landed as a
  `Changed` entry saying so in those terms, not an `Added`.
- **`align` / `materialize` / sequence-`rolling` deliberately keep `'sample'`.**
  Their sample point _becomes the output key_, so coverage semantics would emit
  a point keyed before the range the caller asked for. This is the real content
  of the fix: alignment asks "what is the value at each grid point", aggregate
  asks "which bucket does each event fall in" — only the second owes every
  input event a home. Now stated in `aggregate`'s docstring, next to the
  membership rule it was contradicting.
- **The report's ask #3 (expose the flooring) came free** rather than as a
  separate `Sequence.floor(t)` method: `bounded({ start: t, end: t }, {
coverage: 'overlap' })` returns exactly the bucket containing `t`. Pinned by
  a test so it stays a supported use, not an accident.

**Corroboration: live already did it right.** `LiveAggregation` derives each
event's bucket by flooring the event's _own_ timestamp
(`live/live-aggregation.ts` `#bucketFor`), so the live path never dropped a
leading event. Batch and live disagreed on where a bucket grid starts; this
fix removes that divergence rather than creating one.

**Why it hid for four waves:** UTC-midnight daily bars land exactly on
day/week/month boundaries, so flooring is a no-op — and Tidal's own fixtures
were anchored on 1 Jan 2024, a Monday that is also a month start, the one date
that cannot show the bug. There is now a regression test for that exact
no-op case, because it is the shape that will keep passing while a future
change re-breaks the others.

**What the edge buckets actually contain, and the usage rule it implies**
(owner question, 2026-08-28: "range came from a charts pan/zoom — do we
include events before `range.begin()`, partially fill, or discard?").

`range` bounds the **grid only**. The event scan runs over the whole series
with pure `[bucket.begin(), bucket.end())` membership, so the answer is not
chosen by `aggregate` — it is decided by whether the caller's series extends
past the range, and **the output cannot tell you which you got**. Measured on
1440 one-minute bars, hourly grid, viewport 09:20 → 11:40:

| series vs. range                        | leading   | middle | trailing |
| --------------------------------------- | --------- | ------ | -------- |
| extends past range, **before** this fix | _dropped_ | 60     | 60       |
| extends past range, **after**           | **60**    | 60     | 60       |
| pre-clipped to range, **before**        | _dropped_ | 60     | **41**   |
| pre-clipped to range, **after**         | **40**    | 60     | **41**   |

- **Complete bucket** is what you get when the series has the data. Bar heights
  are then stable under a pan — panning changes _which_ buckets are visible,
  never their values. This is the correct semantics: a bucket's value is a
  property of the data and the grid, not of who is looking.
- **Partial fill** is what you get on a pre-clipped series — silently. `40` and
  `41` are indistinguishable from real dips.
- **Discard** is what the leading edge did before this fix, and what nothing
  does now.

Two conclusions. First, **this fix did not create the partial-bucket problem**:
the trailing edge always had it (`41`, silently, under either coverage). The
old leading drop was not a policy protecting anyone from partials — it was the
same sample-point bug, which happened to hide one of the two. The fix makes the
treatment symmetric.

Second, **the usage rule**: hand `aggregate` the full series and let `range`
bound the grid. Do not pre-clip and then aggregate — `within(v).aggregate(...)`
is the natural thing to type and it silently produces partial edge buckets,
where `aggregate(grid, m, { range: v })` on the unclipped series does not.

**Deferred — a `'contained'` coverage mode.** Neither before nor after can a
consumer ask for "only buckets you could fill completely": a bucket starting
inside the range and running past its end is emitted under _either_ mode, so a
consumer who genuinely can only supply a clipped series has no honest option.
That would be a third mode (only buckets lying wholly inside the range), not a
partial-fill policy. Not built: no consumer has asked, and pond waits for the
second signal. The vocabulary is now in place if one arrives.

**Left open — per-partition grid misalignment.** `partitionBy().aggregate()`
delegates per group, so with no explicit `range` each partition floors to its
_own_ first event's bucket and partitions can emit misaligned grids. That was
already true before this fix (each partition previously started at its own
first boundary) and is unchanged by it, but it means a per-entity rollup still
needs an explicit `range` to produce a shared grid. Parked below rather than
fixed here — it wants its own decision about whether the partitioned default
should be the parent's extent.

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
- Per-partition `aggregate` grids: with no explicit `range` each partition
  floors to its own first event's bucket, so partitions can emit misaligned
  grids. Workaround (an explicit `range`) is one argument; promote if a
  consumer hits it. See [PND-AGGCOVER].
