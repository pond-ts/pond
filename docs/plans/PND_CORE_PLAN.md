# PND_CORE_PLAN — core batch/react backlog

> Breakout plan for the **Core** roadmap section in [PLAN.md](../../PLAN.md).
> Historical context: the audit notes
> ([technical-audit-2026-06.md](../notes/technical-audit-2026-06.md),
> [technical-audit-2026-06-v2.md](../notes/technical-audit-2026-06-v2.md)) and
> the archived phase logs in [docs/archive/](../archive/).

## Tasks

### [PND-PARTCOL] — partition key in the static type after partitioned `aggregate` / `rolling`

**Shipped 2026-09-12 (#724); confirmed by cold-start run 1b** — arms C and D
re-run against the build wrote `{ p95, count }` with no `host`, called
`get('host')` on the collected result, compiled, and matched the reference
exactly (see the note). Two small follow-ups it surfaced: the injected `By`
columns are typed `required: false` like every aggregate output although the
runtime always fills them (agents add needless `undefined` guards), and
[PND-DISTINCT] below. **Codex pass on #724 (after merge) found two unsound corners, fixed in the
follow-up PR:** a broad schema with a literal column typed the injected field
as `undefined` (now guarded — `WithPartitionColumns<S, Mapping, By>` leaves a
broad schema's mapping alone), and `By` had no variance, so
`PartitionedTimeSeries<S, K, 'host'>` accepted a `region` view (now a phantom
`declare readonly __partitionColumns?: (by: By) => void` pins it
contravariantly; specialised → legacy assignment still works). Lesson: a
generic that appears only inside a conditional in return positions has no
variance to TypeScript — pin it explicitly. Implemented exactly as the
corrected fix shape below:
`PartitionedTimeSeries<S, K, By extends string = never>`, `partitionBy`
overloads capture `By` (`const Col` — single string or array element union,
and alongside typed `groups`), `aggregate` / `rolling` return
`AggregateSchema | RollingSchema` over `WithPartitionColumns<Mapping, By>`
(`Mapping & { [C in Exclude<By, keyof Mapping>]: 'first' }`), every operator
threads `By`, and `smooth` / `baseline` regained `K`. Type tests in
`test-d/partitioned-partcol.test-d.ts` cover single + composite partitions,
mapping-key-wins (`host: 'count'` → number), chaining into `baseline`, typed
groups, and that schema-preserving operators are untouched. No runtime
change; 2 941 runtime tests unchanged. Decision: `By` defaults to `never`
rather than "all columns" so an untyped `PartitionedTimeSeries<S>` keeps
today's result types. Not done here: the live side.
`LivePartitionedSeries` already carries a `ByCol` type parameter; whether
its clock-trigger `rolling` / `aggregate` result types name the auto-injected
column was not verified in this pass — check before assuming parity.

**Surfaced by:** [PND-COLDSTART] run 1
([cold-start-adoption-2026-09.md](../notes/cold-start-adoption-2026-09.md)) —
three independent fresh agents all had to work around it, the same way.

**The gap.** `PartitionedTimeSeries.aggregate` and `.rolling` return
`PartitionedTimeSeries<AggregateSchema<S, Mapping>, K>` /
`<RollingSchema<S, Mapping>, K>` — the key column plus the mapping's outputs.
The runtime calls `augmentMappingWithPartitionCols` so the collected series
carries the partition column (documented as auto-inject), but the type does
not:

```ts
const p95 = s
  .partitionBy('host')
  .aggregate(Sequence.every('5m'), { p95: { from: 'ms', using: 'p95' } })
  .collect();
p95.events[0].get('host'); // TS2345: '"host"' is not assignable to '"p95"'
```

`baseline`, `smooth`, `fill`, `dedupe` keep `S`'s value columns and are not
affected (an earlier draft of this task listed `baseline` and `reduce`; the
review corrected it — `reduce` is not on `PartitionedTimeSeries` at all).

The workaround every agent found is to name the column in the mapping
(`host: 'first'`), which is what the runtime injection does anyway.

**Fix shape (corrected by the Codex pass on #723).** Three facts from the
source constrain it:

- The runtime (`partitioned-time-series.ts` `augmentMappingWithPartitionCols`)
  spreads the user's mapping first and then **appends** each `by` column that
  the mapping does not already name, as a `'first'`-style spec, in `by` order.
  So the injected columns come **after** the mapping outputs, and a mapping key
  that names a `by` column wins **including its kind** — `host: 'count'`
  yields an optional-number `host`, not the source's string.
- `aggregate` and sequence-driven `rolling` produce an **`interval`** key
  column, not `S[0]`, so a result schema written as `[S[0], …]` is wrong for
  them.
- `PartitionedTimeSeries<S, K>`'s `K` is the partition **value** type
  (`toMap(): Map<K, …>`), and the runtime `by` field is typed as every
  possible value-column name, so the selected literals cannot be recovered
  from today's types. A new generic **is** required.

Therefore: capture `By` at `partitionBy(by)` as the element union of the
column(s) passed (single string or array — `partitionBy` accepts both), and
have `aggregate` / `rolling` return the **existing** `AggregateSchema` /
`RollingSchema` applied to the mapping augmented at the type level with
`{ [C in Exclude<By, keyof Mapping>]: 'first' }`. That reproduces the runtime
exactly — same key column, same order (mapping outputs then injected `by`
columns), same "existing key wins, kind and all" rule — without inventing a
second schema shape. `baseline` / `smooth` dropping `K` in their return types
is folded into the same pass.

**Acceptance.** The snippet above compiles; type-level tests in `test-d/` pin
it for `aggregate` and `rolling`, for a single `by` column **and** a
multi-column `partitionBy(['region', 'host'])`, and for the
"mapping-key-wins" case (`host: 'count'` stays optional-number); the arm-C /
arm-D `TS2345` detour disappears on a re-run of the harness; the guide's "one
sharp edge" paragraph can be deleted.

### [PND-DISTINCT] — distinct values of a string column

**Surfaced by:** cold-start run 1b (D2). The agent reached for
`series.column('host').unique()` — `TS2339`, no such method on
`StringColumn` — and fell back to `partitionBy('host').toMap().keys()`, which
builds ten `TimeSeries` to read ten names. `'unique'` exists as an
`aggregate` reducer but there is no whole-column door. Shape to consider:
`column(name).distinct(): ReadonlyArray<string>` on string (and number)
columns, dict-encoded fast path where the column is dictionary-backed
(the same path `_distinctPartitionKeys` already takes). Small; queue behind
[PND-COLAPI].

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

**Corrected post-merge (adversarial review of #677, 2026-08-28).** The first
write-up of this said an explicit `range` was "honoured verbatim". That is
false at the event level, and the test meant to pin it started on a month
boundary, where `'overlap'` is a no-op — so it asserted nothing. What is
actually true: `range` bounds the **grid**, not the scan. With 60 daily bars
from 1 Jan and `range: [10 Jan, 20 Feb]`, the January bucket comes back
complete at **31**, including the nine bars _before_ the window. The
consequence is the property the table above describes — a bucket reads the
same under any range containing it, so an edge bucket does not change value as
a viewport slides across it — but it is not clipping, and the docs said it
was. Anyone who needs the window to bound the events must narrow the series
instead, accepting partial edge buckets in exchange.

Two further corrections from the same review: a pre-realized `BoundedSequence`
argument bypasses coverage entirely (`toBoundedSequence` short-circuits on it),
which is correct — an explicit bucket list should not be extended with a
bucket the caller did not ask for — but was undocumented while the docstring
asserted coverage unconditionally; it is now the documented escape hatch for
the old edge. And `'overlap'` moves the _trailing_ edge too against a
non-default `sample`, because it drops the sample offset that `'sample'`
shifts both edges by. `aggregate` hardcodes `'begin'`, so that one is a
`bounded` contract detail rather than a behaviour change. All three are now
pinned by tests.

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
