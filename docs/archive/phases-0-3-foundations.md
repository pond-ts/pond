# Archive: Phases 0–3 — core performance, batch hardening/expansion, columnar primitives, live core

> **Archived from PLAN.md on 2026-07-20** as part of the PLAN reorganization.
> Frozen historical record — do not update. The current roadmap lives in
> [PLAN.md](../../PLAN.md); per-area breakout plans live in [docs/plans/](../plans/).

## Completed work

### Phase 0: Core performance (done)

All five critical O(N^2) hot paths have been optimized:

| Method                     | Was             | Now                   | Speedup (largest test)  |
| -------------------------- | --------------- | --------------------- | ----------------------- |
| `aggregate()`              | O(N x B)        | O(N + B)              | **172x** at 16k events  |
| `rolling()` (event-driven) | O(N^2)          | O(N) sliding window   | **182x** at 4k events   |
| `smooth('movingAverage')`  | O(N^2)          | O(N) sliding deque    | **15x** at 4k events    |
| `smooth('loess')`          | O(N^2 log N)    | precomputed neighbors | **7.5x** at 1.6k events |
| `includesKey()`            | O(N)            | O(log N) bisect       | **819x** at 8k events   |
| `#alignLinearAt()`         | O(N) + O(log N) | forward cursor        | **134x** at 4k events   |

Landed in commits `05a7af3` and `60b2f07`. Each change has dedicated regression
tests and a benchmark script.

Internal pre-validated constructor path now skips the
`events -> toRows() -> validateAndNormalize() -> events` round-trip for
order-preserving derived transforms (`filter`, `select`, `rename`, `collapse`,
`map`, etc.). Landed in commit `2ef6265`. A chained `filter -> select -> rename
-> collapse -> map` derivation is **2.5x** faster at 8k events.

### Phase 1 progress: Batch hardening (in progress)

- [x] `toJSON()` round-trips with `fromJSON(...)`
- [x] `toRows()` and `toObjects()` explicit normalized export helpers
- [x] both array-row and object-row JSON shapes supported
- [x] docs cover both ingest and export
- [x] custom aggregate reducers and named aggregate outputs
- [x] edge-case tests for empty series, single-event series, empty aggregation
      buckets, rolling alignment edge cases, and half-open interval semantics
- [x] test and document custom reducers for `rolling()` (type plumbing already
      accepted `CustomAggregateReducer`; added edge-case tests and docs)

### Source-layout migration (shipped — kebab-case layer folders, schema split)

`packages/core/src/` was a flat 26-file root mixing public classes,
helpers, types, and `Live*` operators. The migration moved every
non-barrel module into a layer folder under a single naming rule.

**Shipped via PRs #137, #138, #140, #141, #142, #143, #144, #145.**

Final layout:

```
packages/core/src/
├── index.ts              # public package barrel (only file at root)
├── batch/                # TimeSeries, PartitionedTimeSeries, validate, json, aggregate-columns
├── core/                 # event, interval, time, time-range, temporal, calendar, duration, errors
├── columnar/             # internal storage substrate (unchanged)
├── live/                 # LiveSeries + every Live*, series-store, live-history, triggers
├── reducers/             # reducer registry (unchanged)
├── schema/               # type vocabulary split by concern (10 files; was types.ts + types-*.ts)
└── sequence/             # Sequence, BoundedSequence, sample
```

Naming rule: every file is kebab-case; class names stay PascalCase
inside the file. No mixed convention, no judgment calls about
"public concept vs internal helper." Documented in ARCHITECTURE.md
under "Source layout conventions."

`schema/` decomposes the former 1022-line, 82-export `types.ts` into
10 focused files (`series.ts`, `events.ts`, `json.ts`,
`aggregate.ts`, `reduce.ts`, `rolling.ts`, `reshape.ts`, `diff.ts`,
`join.ts`, `public.ts`) plus an internal `schema/index.ts` barrel.
The `pond-ts/types` subpath still resolves; `package.json#exports`
was updated to point at `dist/schema/public.{d.ts,js}`.

**No compatibility shims left at the root.** Each layer-move PR
rewired every import site rather than leaving 1-line re-exports
behind. Per-PR diffs were larger, but the end state needs no v1.0
cleanup pass for shim removal.

**What's still aspirational** (not shipped here):

- Operator extraction from `batch/time-series.ts` (~4850 lines).
  **Underway as of the Step-4 transform wave** — `batch/operators/`
  now exists with `cumulative.ts` as the first extracted operator
  (PR #190); `select` / `rename` reshape the store column-native but
  inline (not yet pulled into `operators/`). The "thin API shell +
  `batch/operators/*.ts`" goal in ARCHITECTURE.md is now in motion,
  one operator per PR. Not yet started for `live/live-series.ts`
  (1185 lines) and `live/live-partitioned-series.ts` (1448 lines).
- `io/` layer (row/object/json/point converters) is reserved in
  ARCHITECTURE.md but not yet created — comes into existence when
  operator extraction surfaces the relevant code paths.

**Why this was worth doing now.** Phase 4.7 (columnar core
substrate) and the eventual operator extraction both touch every
public-class file. Doing them on the old flat layout meant
arbitrating PascalCase/kebab-case naming and "public concept vs
internal helper" judgment per PR; doing them on a clean layered
tree means the storage rewrite and operator splits land as
mechanical moves into known homes.

**Public API unchanged.** Every `import { ... } from 'pond-ts'`
and `import type ... from 'pond-ts/types'` resolves to the same
identifiers it did before #137. 1670/1670 tests pass on every
migration PR.

---

## Phase 1: Batch hardening (in progress)

Goal: make the existing batch surface trustworthy enough to extend.

Remaining scope: none — all items complete. Phase 1 is ready for the decision
gate: is the batch layer complete and trustworthy enough to be the foundation?

Definition of done:

- [x] custom reducer typing and runtime behavior are documented and covered
- [x] edge-case coverage exists for every current analytical primitive

### Remaining performance items (lower priority, address incrementally)

From the original audit, not yet addressed:

- `Time`/`Interval` temporal comparisons still allocate a throwaway `TimeRange`
  per call
- `Event` constructor still does `Object.freeze({ ...data })` +
  `Object.freeze(this)` — measurable overhead at scale
- `rows` getter still materializes N frozen arrays on every access — should
  cache lazily or become a method
- `aggregateValues` still filters the values array twice — one pass suffices
- `compareEventKeys` still uses `localeCompare` for tiebreaking on fixed
  strings — plain `<` is ~10x faster
- `joinMany` still does repeated pairwise joins — an N-way sorted merge would
  be one pass
- `parseDurationInput` is duplicated in `TimeSeries.ts` and `Sequence.ts`

### Known type-level limitation: `TimeSeries<S>` variance

Both Codex and Claude agents flagged in the CSV-cleaner experiment that:

- `toJSON()` returns `TimeSeriesJsonInput<SeriesSchema>` (loose) rather than
  `TimeSeriesJsonInput<S>`, so a typed `TimeSeries<Schema>` round-tripped
  through `toJSON` loses its specific schema. Callers cast back at the
  call site (`as TimeSeriesJsonInput<MySchema>`).
- `RowForSchema` doesn't honor `required: false`, so
  `new TimeSeries({ rows: [[ts, undefined, ...]] })` rejects undefined
  cells even when the schema allows them. Workaround: go through
  `fromJSON({ rows: [[ts, null, ...]] })` instead, which already widens
  cells via `JsonRowForSchema`.

Both fixes are real and correct in isolation, but trying to land them
hits a class-wide variance issue: many `TimeSeries` methods have
overloads that return `TimeSeries<NarrowSchema>` while the impl returns
`TimeSeries<SeriesSchema>`. Tightening `toJSON`'s return to use `<S>`
makes `TimeSeries<NarrowSchema>` no longer assignable to
`TimeSeries<SeriesSchema>` (the variance now propagates through every
method that references S in a return position), which breaks the
overload-impl compatibility check on `pivotByGroup`, `rolling`,
`arrayAggregate`, and `arrayExplode`.

Fixing this properly requires a class-wide variance refactor — either
restructure each invariant overload to use a separate type-level helper
that doesn't tie back to the class generic, or split `TimeSeries<S>`
into a covariant read-side and an invariant write-side. Both are
non-trivial. Queued as future work; the workarounds above are honest
documentation in the meantime.

---

## Phase 2: Batch expansion

Status: complete.

Goal: fill the most obvious product gaps in the batch analytics story.

Completed:

- [x] `reduce` — collapse a series to a scalar or record (whole-series aggregation)
- [x] `groupBy` — partition by column value, optional transform callback
- [x] `diff` / `rate` — per-event differences and per-second rates of change
- [x] `fill` — per-column gap-filling strategies (hold, linear, zero, literal)
- [x] `pivotByGroup` — long-to-wide reshape on a categorical column; the missing
      inverse of `groupBy` for cases where you want one wide series instead of N
      separate ones (added late, after dashboard-agent feedback)
- [x] `TimeSeries.concat([s1, s2, ...])` — fan-in primitive that closes the
      `groupBy(col, fn)` round-trip without forcing callers out of the typed
      contract. Concatenate same-schema series, re-sort by key, return one
      wider series. Shipped in v0.8.2 after the CSV-cleaner agent run flagged
      the missing third leg of the fan-out / column-merge / row-append triangle.
      Initially named `merge` (matching pondjs lineage); renamed to `concat`
      pre-release after the adversarial review flagged the verb-overlap with
      `Event.merge(patch)` and the cleaner alignment with `Array.prototype.concat`,
      `pandas.concat(axis=0)`, and SQL `UNION ALL`.
- [x] `TimeSeries.fromEvents(events, { schema, name })` — companion to `merge`
      for the rare case where you have a flat events array (not a list of
      series) to assemble. Sorts by key. Shipped in v0.8.2.
- [x] `TimeRange.toJSON()` and `.toString()` — `{ start, end }` ms shape that
      round-trips through `new TimeRange(...)` and JSON wire formats; ISO
      `start/end` for debug. Shipped in v0.8.2.
- [x] `series.partitionBy(col)` and `PartitionedTimeSeries<S>` — chainable
      view that scopes stateful transforms to within each partition, fixing
      the cross-entity correctness hazard surfaced by all three CSV-cleaner
      agents. Sugar for `fill` / `align` / `rolling` / `smooth` / `baseline` /
      `outliers` / `diff` / `rate` / `pctChange` / `cumulative` / `shift` /
      `aggregate` plus `apply(fn)` escape hatch. Sugar methods return another
      `PartitionedTimeSeries` (persistent across chains, e.g.
      `ts.partitionBy('host').dedupe(...).fill(...).collect()`); `.collect()`
      materializes back to a regular `TimeSeries`. Shipped in v0.9.0 (PR 1
      of the wave).

Scope: none — all items complete.

Dropped:

- `fillNull` — `fill()` covers all use cases; a separate method doesn't earn its
  API surface

- `resample` — everything it would do is already covered by `aggregate()`
  (downsample) and `align()` (upsample); adding it as pure sugar doesn't earn
  its API surface

Nice-to-have in the same wave:

- per-column alignment policies

Hold for later unless a concrete user need appears:

- `unpivot` — wide-to-long; sketched on the
  [Reshaping](../../website/docs/pond-ts/transforms/reshape.mdx#unpivot)
  page with a manual workaround. Promote to shipped if a real case
  appears.

### Design notes

**`groupBy`**: returns `Map<string, TimeSeries<S>>` keyed by group values,
preserving full typing on inner series. Optional transform callback avoids
materializing intermediate maps:

```ts
const perHost = series.groupBy('host');
const perHostRolling = series.groupBy('host', (group) =>
  group.rolling('5m', { cpu: 'avg' }),
);
```

**`reduce`**: collapses an entire series to a scalar or record, using the same
reducer specs as `aggregate` but without a time-bucketing sequence. Where
`aggregate` always produces a new `TimeSeries`, `reduce` produces a plain value.
Supports both built-in and custom reducers, same as `aggregate`:

```ts
// single column
const avg = series.reduce('cpu', 'avg'); // => number

// multi-column
const summary = series.reduce({
  cpu: 'avg',
  requests: 'p95',
});
// => { cpu: number, requests: number }

// custom reducer
const weighted = series.reduce(
  'cpu',
  (values) => values.reduce((a, b) => a + b, 0) / values.length,
);

// per-group reduction
const perHost = series.groupBy('host', (g) =>
  g.reduce({ cpu: 'avg', requests: 'p95' }),
);
// => Map<string, { cpu: number, requests: number }>
```

**`diff` / `rate`**: operate on one or more named numeric columns. Non-specified
columns pass through unchanged. First event gets `undefined` in affected columns
by default; `{ drop: true }` removes it instead. `rate` divides by time gap in
seconds. Options object is always the last argument, after column names.

```ts
// single column
const deltas = series.diff('requests');
const perSec = series.rate('requests');

// multi-column
const deltas = series.diff('requests', 'cpu');
const perSec = series.rate('requests', 'cpu');

// drop first event instead of undefined
const deltas = series.diff('requests', { drop: true });
```

**`fill`**: replaces `undefined` values using per-column strategies. Strategies
and options are separate arguments. Strategy names: `hold` (forward fill),
`linear` (time-interpolated), `zero`. Non-string values in the mapping are
literal fill values. `limit` caps consecutive fills per column.

```ts
// single strategy for all columns
series.fill('hold');
series.fill('hold', { limit: 3 });

// per-column strategies
series.fill({ cpu: 'linear', host: 'hold' });

// literal fill values
series.fill({ cpu: 0, host: 'unknown' });
```

`linear` requires known values on both sides of a gap; leading and trailing
undefined runs are left unfilled.

**`pivotByGroup`**: reshapes long-form data into wide rows. Each distinct
value of a categorical column becomes its own column in the output schema,
named `${group}_${value}`, holding the value column at that timestamp.
Rows sharing a timestamp collapse into one output row; missing
`(timestamp, group)` cells are `undefined`. Output schema is dynamic
(column names depend on runtime data), so the return type is
`TimeSeries<SeriesSchema>` (loosely typed) — callers bridging to charts
read columns by name out of `toPoints()` rows.

```ts
// Long: { ts, cpu, host } per row
// Wide: { ts, "api-1_cpu", "api-2_cpu", ... } per row
const wide = long.pivotByGroup('host', 'cpu');
wide.toPoints(); // ready for Recharts <Line dataKey="api-1_cpu" /> etc.
```

Duplicate `(timestamp, group)` pairs throw by default; opt-in with
`{ aggregate: 'avg' | 'sum' | 'first' | 'last' | ... }` to combine
(reuses the `aggregate()` reducer registry, including custom functions
and `pN` / `topN` parsed names). Requires a time-keyed input.

The single-value-column form covers the dashboard case ("one metric,
multiple producers"). A typed-output overload ships in v0.8.1:
`pivotByGroup(group, value, { groups: [...] as const })` propagates the
declared group set to the output schema as literal column names, so
downstream `baseline` / `rolling` / `toPoints` calls narrow without
`as never` casts. The declared form also preserves declaration order
(not alphabetical) and emits columns for declared-but-empty groups so
the schema is stable across runs. The untyped form remains as the
open-set discovery path returning `TimeSeries<SeriesSchema>`. Both
live behind one method via overload.

Rejected follow-ups (from v0.8.0 dashboard-agent feedback):

- **Multi-value-column pivot** — `pivotByGroup('host', ['cpu', 'memory'])`.
  Cross-host-cross-metric layouts hit this, but the workaround
  (two pivots + `join`) is one extra line and stays inside the typed
  contract. Not earning the API surface.
- **`baselineMany` / multi-column `baseline`** — replacing the
  chained `wide = wide.baseline(...)` reassignment with a single
  multi-column call. Cosmetic — the chain is idiomatic immutable-API
  code and reads fine in practice.

Both rejections will be revisited only if a second concrete case
lands.

**Per-column alignment**: extend `align()` to accept a per-column map. Default
(`'hold'`) applies to any column not in the map:

```ts
const aligned = series.align(Sequence.every('1m'), {
  method: { cpu: 'linear', host: 'hold' },
});
```

Definition of done:

- each method has both API docs and worked examples
- type flow is preserved through all new methods
- batch examples cover realistic host/service metrics workflows

---

## Phase 2.5: Columnar primitives

Status: complete.

Goal: fill the remaining analytical gaps that pandas users expect, without
exposing a general "access neighboring events" API. Each operation is a named
columnar primitive that the library implements internally by walking the event
array — the user describes what they want, not how to iterate.

Completed:

- [x] `pctChange` — percentage change relative to previous value
- [x] `cumulative` — running accumulation (sum, max, min, count, custom)
- [x] `shift` — lag/lead column values by N events
- [x] `bfill` strategy for `fill()` — backward fill (propagate next known value backward)
- [x] built-in aggregator parity with original pondjs: `median`, `stdev`,
      `percentile` (`p50`, `p95`, `p99`, etc.), `difference`, `keep`

### Design notes

**`pctChange`**: same shape as `diff`/`rate`. Computes `(curr - prev) / prev`
for named numeric columns. First event gets `undefined` (no previous value).
Purely value-relative — time gap doesn't matter.

```ts
const pct = series.pctChange('requests');
const pct = series.pctChange(['cpu', 'mem']);
const pct = series.pctChange('requests', { drop: true });
```

For period-over-period comparison (today vs yesterday, current vs one hour ago),
the idiomatic approach is `shiftKeys` + `join` rather than a single-series
`pctChange` — that's a separate composition pattern, not a primitive.

**`cumulative`**: takes a mapping of column names to accumulation functions.
Returns a series of the same length with running values. Supported built-ins:
`sum`, `max`, `min`, `count`. Custom accumulators via function.

```ts
const running = series.cumulative({ requests: 'sum' });
const peaks = series.cumulative({ cpu: 'max' });
const mixed = series.cumulative({
  requests: 'sum',
  cpu: 'max',
  errors: 'min',
});
```

Non-accumulated columns pass through unchanged. Unlike `rolling` (fixed window),
`cumulative` grows from the first event — every event sees all prior values.

**`shift`**: moves column values forward (lag) or backward (lead) by N events.
Vacated positions get `undefined`. Useful for "compare to N ticks ago" on
regular-grid data, or as a building block for custom derived metrics.

```ts
const lagged = series.shift('value', 1); // lag by 1
const lead = series.shift('value', -1); // lead by 1
const lagged = series.shift(['cpu', 'mem'], 2);
```

For time-based shifting (e.g. "value 1 hour ago" on irregular data), the
pattern is to `align` to a regular grid first, then `shift` by the
corresponding number of events. A dedicated `shiftKeys(duration)` that offsets
event timestamps (for join-based period comparison) may come later if the
pattern proves common enough.

**`bfill` for `fill()`**: adds a `'bfill'` strategy to the existing `fill()`
method — the mirror of `'hold'` (forward fill). Walks the event array backward,
propagating the next known value into preceding `undefined` gaps. Supports
`limit` to cap consecutive fills, same as other strategies. Works in per-column
mode too:

```ts
series.fill('bfill');
series.fill('bfill', { limit: 3 });
series.fill({ cpu: 'linear', host: 'bfill' });
```

Trailing `undefined` runs (no future value to propagate) are left unfilled,
mirroring how `'hold'` leaves leading runs unfilled.

**Aggregator parity**: the original pondjs shipped 12 built-in reducers. We have
7 (`sum`, `avg`, `min`, `max`, `count`, `first`, `last`). The five missing ones:

- **`median`** — middle value of the sorted bucket. Same as `percentile(50)` but
  earns its own name for readability.
- **`stdev`** — population standard deviation of bucket values.
- **`percentile`** — q-th percentile. Expressed as `'p50'`, `'p95'`, `'p99'`,
  etc. in reducer specs. Linear interpolation between adjacent ranks by default.
- **`difference`** — range within a bucket (`max - min`). Useful for spread /
  volatility measures.
- **`keep`** — returns the value if all bucket values are identical, `undefined`
  otherwise. Useful for preserving constant columns (e.g. `host`) through
  aggregation.

These extend the existing `AggregateFunction` union and work everywhere reducers
are accepted: `aggregate()`, `reduce()`, `rolling()`, and `collapse()`.

```ts
series.aggregate(Sequence.every('10m'), {
  latency: 'p95',
  cpu: 'median',
  host: 'keep',
});

series.reduce({ latency: 'stdev', spread: 'difference' });
```

Definition of done:

- each method follows the `diff`/`rate` pattern (columns + options)
- type flow is preserved — affected columns become optional number
- tests cover empty series, single event, leading/trailing gaps, and
  composition with groupBy
- all 12 original pondjs reducers are available as built-in names
- `percentile` patterns (`p50`, `p95`, `p99`) parse correctly in reducer specs

---

## Phase 3: Live core

Status: complete.

Goal: introduce a minimal but principled live layer without collapsing the
immutable `TimeSeries` model.

Scope:

- [x] `LiveSeries<S>` — mutable, append-optimized buffer sharing the same schema
      type as `TimeSeries`
- [x] push/append APIs
- [x] retention policies (`maxEvents`, `maxAge`); ~~`maxBytes`~~ removed in v0.14.0 as unused
- [x] immutable snapshot via `toTimeSeries()`
- [x] ordering modes (`strict`, `drop`, `reorder`) and late-arrival policy
- [x] subscriptions (`event`, `batch`, `evict`) — synchronous, inline with push
- [x] docs page for LiveSeries

Non-goals for this phase:

- live aggregation, rolling, or smoothing
- React hooks

### Design notes

**Retention** runs on every push. No background timers — the caller controls the
event loop. Data is the clock.

**Ordering**: three modes — `strict` (default, throws on out-of-order),
`drop` (silently discards late events), `reorder` (inserts in sorted position
within a grace window).

**Subscriptions** are synchronous and fire inline with `push`. Async fanout is
the caller's responsibility.

**Subscription ordering**: within a single `push()` call, listeners fire in
this order: `event` (once per event, inline with insertion) → retention runs →
`batch` (once with all added events) → `evict` (if retention removed events).

**`reorder` mode**: without a `graceWindow`, any out-of-order event is inserted
in sorted position via binary search. With a `graceWindow`, events older than
the window relative to the latest timestamp throw. This gives callers control
over how much disorder they'll tolerate.

**`toTimeSeries()` snapshot**: reconstructs rows from the internal event array
and passes them through the standard `TimeSeries` constructor. This re-validates
events redundantly but keeps the two classes fully decoupled. Snapshot is not a
hot path — if profiling proves otherwise, a trusted constructor bridge can be
added later.

**Byte estimation** (`maxBytes`) was shipped in this phase but removed in
v0.14.0 — no real user reached for it, and the gRPC experiment's V3 profile
flagged the per-push estimator as the largest single self-time line (6.2%)
purely maintaining a counter no working app consulted. Pre-1.0 cleanup;
`maxEvents` covers the eviction patterns real apps actually need.

Definition of done:

- [x] `LiveSeries` can ingest ordered data reliably
- [x] retention and snapshot semantics are clearly documented
- [x] subscriptions are predictable and synchronous
- [x] the API is small enough to change if the composition model reveals flaws
