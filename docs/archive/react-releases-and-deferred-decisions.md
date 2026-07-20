# Archive: Phase 5 React integration, release grouping, decision gates, deferred design decisions

> **Archived from PLAN.md on 2026-07-20** as part of the PLAN reorganization.
> Frozen historical record — do not update. The current roadmap lives in
> [PLAN.md](../../PLAN.md); per-area breakout plans live in [docs/plans/](../plans/).

## Phase 5: React integration

Status: in progress. Monorepo restructure complete — `@pond-ts/react` package
at `packages/react/`. Hooks shipped at v0.4.2; usability fixes in progress.

Goal: make Pond useful in frontend apps without forcing a framework-y runtime
model into the core package.

Entry point: `@pond-ts/react` (separate workspace package)

### Hooks

- [x] `useLiveSeries` — creates and owns a `LiveSeries` for component lifetime;
      returns a stable `live` ref and a throttled `TimeSeries` snapshot
- [x] `useTimeSeries` — memoized `TimeSeries.fromJSON(...)` for static/fetched
      data; re-parses only when key changes
- [x] `useSnapshot` — converts any `LiveSource` into a throttled `TimeSeries`
      snapshot for rendering; works with `LiveSeries`, `LiveView`,
      `LiveAggregation`, and `LiveRollingAggregation`
- [x] `useWindow` — derived windowed view that updates as the source grows;
      disposes the view on cleanup
- [x] `useDerived` — applies a batch transform to a snapshot, recomputing when
      the input changes
- [x] `takeSnapshot` — utility: build a `TimeSeries` from any `LiveSource`

### Usability fixes (from external testing)

- [x] `Time.toDate()` — added missing convenience method
- [x] `useWindow` StrictMode fix — view created in `useEffect`, not `useMemo`
- [x] `TimeSeries[Symbol.iterator]` and `toArray()` — ergonomic iteration
- [x] `useSnapshot` accepts `SnapshotSource<S>` structural type — avoids casts
      when passing `LiveAggregation` or `LiveRollingAggregation`
- [x] `LiveView` eviction mirroring — filtered/mapped views now mirror source
      evictions (uses `EMITS_EVICT` symbol to safely detect evict-capable sources)
- [x] `LiveAggregation<S, Out>` and `LiveRollingAggregation<S, Out>` — output
      schema type parameter enables `event.get('col')` to narrow through
      aggregation chains (e.g. `agg.at(0)?.get('cpu')` returns `number | undefined`
      instead of `ScalarValue | undefined`)
- [x] Schema-transform types already exported: `AggregateSchema`, `RollingSchema`,
      `DiffSchema`, `SmoothSchema`, `SmoothAppendSchema`, `SelectSchema`,
      `RenameSchema`, `CollapseSchema`
- [x] `useLiveQuery` — bundles `useMemo` + `useSnapshot` into one call; return
      shape matches `useLiveSeries`, cuts hook count roughly in half for dashboards
      with multiple derived views
- [x] `useLatest` — subscribes to a live source and returns only the most recent
      event; lighter than a full `TimeSeries` snapshot for stat cards and gauges

### Remaining

- [ ] Document `rate()` / `diff()` / `pctChange()` behavior when `dt = 0` —
      concurrent events (same timestamp) produce `undefined`. Workaround is to
      filter per-producer first. A `rateOver({ every: '1s' })` variant that
      normalizes to fixed wall-clock windows may be worth adding later.
- [x] `smooth('ema', { warmup: N })` — drops the first `N` output rows so
      callers don't have to write `.slice(N)` after every EMA call. Shipped
      in v0.5.7. A `seed` variant that initializes the EMA with a specific
      value (rather than trimming the output) is still open if the need
      comes up.
- [x] `outliers(col, { window, sigma, alignment? })` — rolling-baseline
      anomaly detection as a first-class operator. Returns `TimeSeries<S>`
      filtered to events deviating from the rolling avg by more than
      `sigma * rolling_stdev`. Collapses the 30-line manual pattern
      (rolling → avgByTs Map → filter loop) into one call. Shipped in
      v0.5.8.
- [x] `baseline(col, { window, sigma, alignment?, names? })` — appends
      `avg` / `sd` / `upper` / `lower` columns to the source schema in
      one rolling pass; band-chart `toPoints()` (wide rows after
      v0.7.0) and outlier-filter `.filter(cpu > upper)` both read from
      the same intermediate. Replaces the dashboard's "call rolling
      for bands, call outliers for dots" two-pass pattern with one
      call. Shipped in v0.5.9. v0.5.10 followup: `upper` / `lower`
      collapse to
      `undefined` when the rolling window is flat (`sd === 0`) so a
      naive `value > upper || value < lower` filter doesn't flag every
      non-equal point; matches `outliers()`. The two methods are now
      documented as conceptually equivalent (not sugar — they're
      independently implemented). First trial of the two-comment review
      protocol landed through PR #47.
- [x] `toPoints()` / `TimeSeries.fromPoints(points, { schema })` —
      chart-library interop. Originally narrow-form
      `toPoints(col) → { ts, value }[]` in v0.5.8; redesigned in
      v0.7.0 to wide rows
      (`toPoints() → { ts, ...valueColumns }[]`) to match the
      multi-column nature of `TimeSeries` and feed Recharts /
      Observable Plot / visx without a manual merge step.
      `fromPoints` accepts the inverse wide-row shape over any
      time-keyed schema.
- [ ] Dashboard guide doc fixes — show `useLiveQuery` as the idiomatic pattern
      rather than manual `useMemo` + `useSnapshot`; document how derived views
      interact with `LiveSeries` retention.

**Render throttling** is critical. Raw data can arrive at hundreds of events per
second. The `throttle` option caps how often the snapshot is recomputed.
Stateless transforms are cheap enough to build inline during render; stateful
transforms must be created once via `useMemo` on the `live` ref (or
`useLiveQuery`).

Requirements before starting:

- live composition semantics from phases 3 and 4 should already feel stable

Definition of done:

- [x] live data can flow from WebSocket-like sources into throttled React renders
- hooks have examples that mirror likely product use
- the docs explain when to use lazy views vs memoized derived data

---

## Recommended release grouping

| Release band | Focus                                                        |
| ------------ | ------------------------------------------------------------ |
| `0.1.x`      | Performance fixes, hardening, serialization, custom reducers |
| `0.2.x`      | `groupBy`, `reduce`, `diff`/`rate`, `fill`                   |
| `0.2.5`      | `pctChange`, `cumulative`, `shift`                           |
| `0.3.x`      | `LiveSeries` core and subscriptions                          |
| `0.4.x`      | Live views and live stateful transforms                      |
| `0.5.x`      | React hooks                                                  |
| `0.6.x`      | Node adapters and third-party chart adapters                 |

---

## Decision gates

Before moving from one major phase to the next, answer the relevant question:

- After Phase 1: is the batch layer complete and trustworthy enough to be the
  foundation?
- After Phase 3: is the `LiveSeries` shape correct, or are we still learning?
- After Phase 4: do live/stateful composition rules feel simple enough for
  users?
- After Phase 5: do common frontend use cases work without ad hoc glue?

If the answer is no, stay in the phase and tighten the model before expanding.

---

## Deferred design decisions

### Array column values (`unique`, `topK`, `percentiles`)

**Status: shipped.** `unique` reducer and the four array column operators
(`includes`, `count`, `containsAll`, `explode`) landed on branch
`feat/array-columns`. The sections below describe the design; see the
implementation checklist at the bottom for what's done and what's still open.

**Decision: reducers may output arrays, but array columns are inert.**

A `'unique'` reducer (distinct values in a bucket) is a natural aggregation —
"which hosts reported in this window?" — but it collides with a constraint:
`CustomAggregateReducer` returns `ScalarValue | undefined`
(`number | string | boolean`), and the natural output of `unique` is
`string[]`.

The full-fat approach — making `ScalarValue[]` a first-class value everywhere —
is expensive. Every conditional type, every reducer, `fill`, `align`, `diff`,
`rate`, chart adapters, JSON round-trips — all need to handle or reject arrays.

But most array-valued use cases share a property: **the array is a reducer
output, never an input to further numerical operations.** You never `avg` a tag
list. You never `diff` a set of host names. The arrays are read-only results
that pass through the pipeline untouched.

That observation dramatically reduces the blast radius:

#### What changes

- **New column kind `'array'`** with value type `ScalarValue[]`.
  `NormalizedValueForKind<'array'>` → `ScalarValue[]`.
- **Reducer registry** gains an `outputKind` that can be `'array'`. A reducer
  like `'unique'` declares `outputKind: 'array'`; the output schema column gets
  `kind: 'array'` automatically.
- **`toJSON` / `fromJSON`** encode array cells as JSON arrays. No format break —
  existing scalar cells are unchanged, and a cell that happens to be an array
  serializes naturally.
- **`CustomAggregateReducer`** return type widens to
  `ScalarValue | ScalarValue[] | undefined`.

#### What stays the same (inert behavior)

- **`NumericColumnNameForSchema`** already filters to `kind: 'number'` — so
  `diff`, `rate`, `pctChange`, `cumulative`, `rolling` naturally skip array
  columns with no code changes.
- **`fill`** strategies (`hold`, `zero`, `linear`, `bfill`) don't apply — array
  columns are skipped.
- **`align`** interpolation doesn't apply — array columns pass through.
- **`filter`, `map`, `select`, `rename`, `collapse`** operate at the event
  level, not individual cell values — arrays pass through naturally.
- **`aggregate` / `rolling`** on a column that is already `'array'` — only
  reducers that accept array inputs would work (`first`, `last`, `keep`,
  `count`). Numeric reducers reject or ignore.

#### Built-in reducers that return arrays

- **`unique`** — distinct non-undefined values, sorted. Works on any column
  kind. **Shipped.**
- **`top(n)`** — top N values by frequency, sorted by count descending with
  deterministic scalar tie-break. Implemented as a string-pattern reducer
  (`'top3'`, `'top10'`, …) parallel to `pNN`, plus a `top(n)` helper that
  returns the typed string literal. Incremental bucket/rolling state via
  a count map, so `rolling('5m', { host: top(3) })` is O(1) per update.
  **Shipped.**
- **`percentiles(...qs)`** — compute multiple quantiles in one pass:
  `percentiles(50, 90, 99)` returns `number[]`. Avoids three separate
  `p50` / `p90` / `p99` columns. **Deferred** — the workaround (declaring
  three output columns) is ergonomic enough and doesn't lose efficiency
  (each `pNN` reducer already shares a sorted-array rolling state). Revisit
  only if multi-quantile dashboards become a common pattern.

#### Array column operators

Once array columns exist, a small set of operators makes them useful for
tagging workflows (e.g. "which hosts reported?", "does this bucket include
host X?"). All operators are prefixed `array*` so they read clearly and
don't collide with existing scalar / temporal methods (e.g. temporal
`contains(range)`).

**Filters** (same schema, predicate-only):

- **`arrayContains(col, value)`** — keep events where the array column
  contains `value`. Common pattern: "show only buckets that saw host
  `api-1`."
- **`arrayContainsAll(col, values)`** — keep events where the array
  contains _every_ value in `values` (AND / subset).
- **`arrayContainsAny(col, values)`** — keep events where the array
  contains _at least one_ value in `values` (OR / intersection non-empty).

**Per-event reduction** — reuses the existing reducer registry:

- **`arrayAggregate(col, reducer, options?)`** — feed each event's array
  to a reducer (`count`, `sum`, `avg`, `min`, `max`, `median`, `stdev`,
  `difference`, `pNN`, `first`, `last`, `keep`, `unique`, or a custom
  function) as if it were a bucket of values. This unifies "count the
  array length" with "average a sample list" with "dedupe within the
  array" under one method. Output kind is inferred from the reducer
  (`outputKind: 'number'` → `number`, `'array'` → `array`, `'source'`
  falls back to `'string'` unless overridden with `{ kind }`). Without
  `as`, the source column is replaced in place; with `{ as: "name" }` a
  new column is appended and the source array is preserved.
  Custom reducer contract matches `CustomAggregateReducer`:
  `(values: ReadonlyArray<ColumnValue | undefined>) => ColumnValue | undefined`.

**Flatten**:

- **`arrayExplode(col, options?)`** — fan each event out into one event
  per element of the array. Default replaces the array column with a
  scalar column of kind `kind` (default `'string'`, overridable).
  With `{ as: "name" }` the array column is preserved and a new scalar
  column `name` carries the per-element value; the source array is
  repeated on each fanned-out event. Events with empty or `undefined`
  arrays are dropped. The resulting series may contain events with
  duplicate timestamps.

All five are batch `TimeSeries` methods. Live equivalents (`LiveView`
variants of `arrayContains` / `arrayContainsAll` / `arrayContainsAny`)
are deferred but straightforward — they'd be stateless predicate views.
Live `arrayAggregate` and `arrayExplode` need more thought (how
`arrayExplode` interacts with eviction is the hard case).

#### Implementation checklist

- [x] Add `'array'` to `ScalarKind`, `ScalarValue`, `NormalizedValueForKind`.
      New types: `ArrayValue = ReadonlyArray<ScalarValue>` and
      `ColumnValue = ScalarValue | ArrayValue`.
- [x] Widen `CustomAggregateReducer` return type to `ColumnValue | undefined`.
      `ReducerDef.outputKind` gains `'array'`.
- [x] Ship `unique` as the first built-in (outputKind: `'array'`). Works in
      `reduce`, `aggregate`, and `rolling` contexts.
- [x] JSON round-trip support for array cells (passes through unchanged;
      validate enforces element kinds on read).
- [x] Array column operators: `arrayContains`, `arrayContainsAll`,
      `arrayContainsAny`, `arrayAggregate`, `arrayExplode`. All append-mode
      operators (`arrayAggregate`, `arrayExplode`) accept `{ as }`.
- [x] `top(n)` — top N values by frequency with incremental bucket/rolling
      state. Usable as `'top3'`, `top(3)`, or any `` `top${number}` ``.
- [ ] `percentiles(...qs)` — multi-quantile reducer. Deferred; the
      workaround of declaring three `pNN` columns is cheap and clear.
- [ ] Live equivalents of array column operators (deferred until there's a
      concrete live dashboard need).

### Internal storage shape: row-oriented stays; columnar lives at the chart boundary

**Status: SUPERSEDED by Phase 4.7 (Columnar core substrate), 2026-05-11.** A
Codex evidence-gathering spike measured the gap — see
[`docs/rfcs/columnar-core.md`](../rfcs/columnar-core.md) and
[`docs/briefs/core-columnar-store-spike.md`](../briefs/core-columnar-store-spike.md).
The evidence (6–12× numeric reduce, 4× memory reduction under lazy event
materialization, neutral on string reducers) plus the strategic timing
argument (do this before streaming-RFC milestones B/C/D so they ship on
the substrate, not on row-oriented internals that need retrofitting)
flipped the decision. The original deferred-design framing below stays
for trajectory reasons — future readers can see what was decided when
and why the position changed. Phase 5 of this PLAN is the binding entry.

---

**Status (prior): deferred. Logged 2026-05-10.**

**Decision (superseded).** Keep row-oriented (`Event[]`) internal storage in `TimeSeries` /
`LiveSeries`. Columnar storage lives at the **chart-package boundary** as an
explicit fast path (`ChartDataSource` + typed-array buffers per
[`docs/rfcs/charts.md`](../rfcs/charts.md)), not as a core refactor.

**Reasoning.** A modern analytical engine would store columns: one
`Float64Array` per numeric column, validity bitmaps, string interning,
sequential cache-friendly iteration, SIMD-friendly inner loops in reducers.
Apache Arrow / DuckDB / Polars all do this. The win is real — at firehose
× 100k events × tens of columns we're paying ~6×–10× the memory and
iteration cost a columnar store would.

But the cost-benefit analysis at pond's target operating point doesn't
support the rewrite:

- 100k+/sec on a non-distributed JavaScript runtime is plenty for the
  workloads we target. Workloads needing millions/sec are on Beam / Spark —
  a different operational and cost regime that pond explicitly doesn't
  compete with (per the streaming RFC's "non-goals").
- The `Event` API ergonomics (`event.get('cpu')` schema-narrowed, `set` /
  `merge` / `select` / `collapse` / `data()` / `key()`) are a real
  product moat. They're across 1,300+ tests, every reducer, every operator,
  every React hook. We don't disassemble that for "a bit more speed."
- The row-oriented tax is real and visible — v0.14 / v0.15 perf wave was
  a string of row-shape paper cuts (`estimateEventBytes` removal in
  v0.14.0, trusted-pipeline partition router in v0.14.0,
  `samples.rollingState()` scalar-add allocation fix in v0.14.3, O(1)
  head-index eviction in v0.15.2). Each fix addresses an instance of the
  class; columnar would address the class. We accept the per-fix cost in
  exchange for keeping the API intact.

**Where columnar pays back NOW: the browser.** Beam / Spark don't run
there. The perf ceiling for visualization at firehose × tens of series
is a place pond can credibly win — `@pond-ts/charts` adopts columnar
internals via the layered architecture in
[`docs/rfcs/charts.md`](../rfcs/charts.md), specifically the typed-array
store + chunked Path2D cache + viewport/decimator pipeline. The core
public API stays row-oriented; columnar lives behind the chart adapter
boundary.

**Three positions considered:**

1. **Row-oriented core + chart-side columnar adapter (adopted).** The
   chart package commits to columnar from v1 via `ChartDataSource`; the
   core API stays `Event`-shaped. User-facing perf cliff (browser
   rendering) closed without forcing a core refactor.
2. **Hybrid: columnar internals + Event views + row API outside (right
   north star, deferred).** TimeSeries internals migrate to typed-array
   columns; `at(i)` / iterators return Event _views_ that read lazily from
   buffers. Reducers' hot loops can drop to column reads. The
   duckdb / Arrow / Polars precedent — _columnar internals, row API for
   ergonomics._ Significant refactor; LiveSeries mutability complicates
   Event lifetimes (held Event view after eviction). Earns its slot only
   after the streaming-RFC milestones land — refactors should follow
   major architectural commitments, not lead them.
3. **Columnar everywhere, Event becomes a transient projection
   (rejected).** Best perf, simplest internals, major API break.
   v2.0 territory; the API moat goes with it.

**When to revisit (Hybrid B):**

- After Phase 4.5 milestones A–D land (the change-stream model and
  capability registry inform what columnar internals would consume —
  e.g. `LiveChange` could carry columnar-batch updates instead of
  per-event `Event`s).
- When chart-side columnar machinery is proven in production (validates
  the inner-loop primitives a core migration would reuse).
- v1.0 is a natural forcing function.

If revisited, **Hybrid B is the target.** A serious RFC at that point —
not before. Premature refactor risk plus the streaming-RFC work earns
more leverage right now.

**Cross-references:**

- The chat thread that surfaced this decision: 2026-05-10, during the
  `@pond-ts/charts` Codex review on
  [`docs/rfcs/charts.md`](../rfcs/charts.md). The chart RFC's
  "Internal data shape: columnar typed arrays from day one (Codex 2)"
  section is where columnar got committed at the chart boundary; the
  conversation pivoted on whether the same commitment should extend to
  the core. This entry says no.
- Row-shape paper cuts (evidence of the tax): CHANGELOG entries for
  v0.14.0 (`estimateEventBytes`, trusted-pipeline router), v0.14.3
  (`samples.rollingState()` allocation), v0.15.2 (O(1) eviction).
- Streaming RFC's non-goals (
  [`docs/rfcs/streaming.md`](../rfcs/streaming.md) §"Non-goals"):
  "pond should not become 'mini Beam'." Columnar-everywhere is part of
  what would push us in that direction; staying row-oriented in the
  core keeps us on the deterministic-single-process side of the line
  the RFC draws.
