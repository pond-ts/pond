# Archive: Phase 4.7 — columnar core substrate (v1.0 wave)

> **Archived from PLAN.md on 2026-07-20** as part of the PLAN reorganization.
> Frozen historical record — do not update. The current roadmap lives in
> [PLAN.md](../../PLAN.md); per-area breakout plans live in [docs/plans/](../plans/).

## Phase 4.7: Columnar core substrate (v1.0 wave)

Status: adopted 2026-05-11. Not started.

**Status update (2026-06-10)** — the framing below is the original adoption
note; for current ground-truth see the consultant assessment
([`docs/notes/columnar-arc-assessment-2026-06.md`](../notes/columnar-arc-assessment-2026-06.md),
against v0.20.0). **Shipped:** substrate (1a–1h), batch columnar-first intake,
reduce fast paths (3A: 59–73× numeric), **3B aggregate per-bucket** (#186/#187),
public column API (step 8), _conditional_ live chunked backing (step 7,
strict-time-keyed only), and the **first transforms + operator extraction**
(step 4: `select` #188, `rename` #189, `cumulative` #190 — the latter the first
op pulled into `batch/operators/`, establishing the template; `withRowRange`
substrate #191; `diff`/`rate`/`pctChange` #192). **The remaining middle of the
pipeline — the rest of the transforms and windowed rolling — is still
row-shaped.** Recommended remaining sequence (consultant §5, north-star-ranked),
with the shipped prefix struck through: ~~3B aggregate per-bucket~~ →
~~4 transforms + operator extraction~~ ✅ **COMPLETE** (cumulative #190,
diff/rate #192, fill #194, slice #195, mapColumns #196, shift #197, collapse;
`tail`/`filter` left as deferred judgment calls, event-based `map` permanently
out of scope) → **chart carry-forwards (next)** → 6 dict reducers → 5 planner →
3C rolling
(last; numerical risk stacks there).
Every step before 3C is zero-or-negative public surface. Live §A (column-native output) stays **friction-gated** — the
zero-copy arc was correctly killed by measurement (`perf-band-gather.mjs`).
Near-term items tracked as backlog tasks (3B, step 4 + extraction, row/columnar
parity suite, `toFloat64Array` carry-forward, bundle-budget re-pin). North
star: overall performance with a consistent, clear API surface — reducer speed
first ([columnar-live-protocol RFC Amendment V3](../rfcs/columnar-live-protocol.md)).

**Status update (2026-06-16, against v0.27.0) — the batch columnar wave is
COMPLETE.** Everything in the "recommended remaining sequence" above that lives
on the batch path has shipped. Since the 2026-06-10 note: columnar `timeRange()`
(#214, killed the cold-aggregate cliff), `first`/`last` columnar fast path
(#215) + columnar `partitionBy` split (#216) (the two v2-audit P1s #115/#116),
the principled non-finite reducer policy (#218), numerically-stable rolling
stdev via Welford order-independent delete (#222) + a standing differential
parity-fuzz suite (#223), the **columnar rolling _output_ path** (#225), and
**`byColumn` value-axis aggregation** (#227). Plus the v0.23 greenfield-polish
wave (#206–#211: stripped internal `EMITS_EVICT` from the `.d.ts`, `{ sort: true }`
intake, `at(-1)` parity, F1 type unify). There is no row-shaped middle left in
the batch pipeline that a consumer has flagged.

**The one label that confuses every reading of this roadmap:** "3C rolling"
above means the batch rolling **output** path — SHIPPED (#225). The
gRPC-rebench section below uses "Step 3 Phase C" for the _live_ rolling
**reducer** columnar state — still DEFERRED, unearned. Same number, different
layer.

**Live columnar is a different shape and a different bar.** It went columnar
only where a consumer's measured pain proved it pays, and it is at a defensible
**retention-boundary waypoint**, not an end-to-end rewrite — the originating
live problem (gRPC partition-retention OOM) is _solved_ (chunked backing +
column-native partition routing #175). Full state, batch-vs-live asymmetry, the
parked items + the measurement that parked each, and the one live correctness
loose end (reorder+retention windowed extrema, which belongs with the
robustness cluster #98/#99/#114, not the optimization queue) in the consultant
assessment
([`docs/notes/live-columnar-assessment-2026-06.md`](../notes/live-columnar-assessment-2026-06.md)).

This is the **v1.0 substrate**. Adoption decision documented in
[`docs/rfcs/columnar-core.md`](../rfcs/columnar-core.md) ("Library-agent
response and adoption" section); evidence base in
[`docs/briefs/core-columnar-store-spike.md`](../briefs/core-columnar-store-spike.md);
spike implementation on branch `codex/core-columnar-store-spike`
(PR #130, not for merge — kept as the Phase 3 implementation baseline).

**Goal: a foundational columnar framework that underpins pond-ts
internals, preserving the public event-shaped API.** Builds the
substrate that future streaming, charts, server, and ecosystem work
ride on top of. Future optimization doors (WASM reducer kernels,
WebGPU large scans, SIMD via wasm-simd, zero-copy Arrow export) stay
open for v1.x but are not committed for v1.0 itself.

**Strategic frame.** The columnar substrate is not a series of one-off
fast paths; it's a properly abstracted, independently-tested layer
that the rest of pond-ts is rebuilt on. The spike measured the wins
(numeric reduce 6–12×, memory under lazy event materialization 4×
reduction, chart extraction 34×); the strategic argument is timing —
do this before streaming-RFC milestones B/C/D land so they ship
natively on the substrate, not as retrofits of row-oriented internals.
See the RFC for the full argument.

**Locked-in commitments (from the RFC's "Library-agent response"):**

1. Columnar storage adopted broadly across internals (`TimeSeries`,
   derived series, `LiveSeries` ring buffers, the streaming change
   channel, chart `ChartDataSource`). Public APIs (Event, `at(i)`,
   `live.on('event')`, etc.) stay row-oriented at the boundary.
2. Framework as a foundational layer at `packages/core/src/columnar/`
   (or similar), independently tested, with its own bench suite.
   Apache Arrow-compatible concepts without Arrow runtime dependency.
3. Public API invariants preserved (the five from the RFC):
   `series.events === series.events`, `at(i)` reference stability,
   `at(i)` ↔ `events` consistency, `concat` event identity (preserved
   for events the source has materialized; under columnar the
   per-index cache propagates through concat — under today's
   eager-events shape every event is materialized so the guarantee
   is universal in practice; see V4 amendment for the tightened
   contract), event-shaped iteration. `series.at(i)`'s reference
   stability is the contractual stable-reference accessor; no new
   public API.
4. Phase 3 (derived transform chains) is part of the implementation,
   not a prerequisite gate. Implementation adjusts mid-stream if
   Phase 3 surfaces a deal-breaker; worst case is a narrower
   columnar scope (numeric scans + chart extraction + live numeric
   rolling) with row-backed paths for transform chains.
5. String / dictionary reducer adaptation in v1.0 wave (`unique`,
   `top`, `samples`, grouped `count` over dictionary-encoded
   columns).
6. `LiveSeries` columnar ring buffer in v1.0, scoped narrowly:
   numeric typed ring buffers for hot rolling windows + built-in
   reducers. Strings / custom reducers / array columns / mixed
   schemas stay event-backed inside the framework.
7. Aggregate planner: minimal fused planner; precompute bucket
   spans once, answer simple reducers from prefix sums/counts,
   fall back to event-walked path for non-decomposable operations.
8. Private fields on `TimeSeries` / `LiveSeries`, NOT WeakMap
   sidecars (the spike's shape is exploration-only).

**Implementation sequence (rough, ~3–4 months focused work):**

1. Framework layer (~6 weeks) — `Column<T>` interfaces,
   `Float64Column` / `BooleanColumn` / `DictionaryColumn` /
   `ArrayColumn` concrete impls, validity bitmaps, chunked columns,
   range-aware primitives. Independently tested. Bundle-size pin:
   `<25 KB` gzipped delta to pond-ts core.

   Sub-sequenced per
   [`docs/briefs/columnar-framework-design.md`](../briefs/columnar-framework-design.md).
   Per-sub-step status:
   - **1a — Float64Column, BooleanColumn, ValidityBitmap.** ✅
     Shipped (PR #132, merged 2026-05-13). 116 framework tests,
     bundle delta < 5 KB gzipped. Length validation
     (`MAX_COLUMN_LENGTH = 2**31 - 8`), packed validity bitmap with
     one-shot freeze that copies bits into an owned buffer,
     boundary tests on every public entry point. Two rounds of
     Codex adversarial review per the PR comment trail.
   - **1b — StringColumn (dict + fallback), DictionaryColumn ops.** ✅
     Shipped (PR #133, merged 2026-05-13). 210 framework tests
     (+94 from 1b's StringColumn surface). Constructor enforces:
     mutually exclusive dict/fallback modes; dictionary indices in
     range for valid cells; fallback no-validity invariant (every
     slot must be a string, else throw); explicit validity
     consistency. `scan` uses `''` as the missing-value sentinel
     for invalid rows in both modes (no divergence); validity-aware
     cross-dictionary `remapColumnToDictionary` for join paths.
     Four rounds of Codex adversarial review per the PR comment
     trail, each finding real issues; the contract surface ended
     up substantially more rigorous than the original draft.
   - **1c — ArrayColumn + KeyColumn (time / timeRange / interval),
     EventKey cache.** ✅ Shipped (PR #134, merged 2026-05-13).
     289 framework tests (+79 across ArrayColumn + KeyColumn).
     `ArrayColumn` (fallback mode) with defensive freeze on cells,
     `EMPTY_ARRAY_SENTINEL` for `scan(skipInvalid:false)`,
     element-wise `ArrayValue` contract enforcement. Three
     `KeyColumn` variants with lazy `Map<number, EventKey>` cache
     pinning `keyAt(i) === keyAt(i)`. `IntervalKeyColumn` supports
     discriminated label columns (`StringColumn | Float64Column`)
     for `IntervalValue = string | number` round-trip, with
     hardened runtime discriminator and per-row type/finite
     assertions. Three rounds of Codex adversarial review per
     the PR trail; each round closed real gaps.
   - **1d — ColumnarStore (read-only) + SeriesStore row-API
     adapter (Path B layering split).** ✅ Shipped (PR #135,
     merged 2026-05-13). 324 framework + adapter tests.

     **Architectural pivot mid-review.** The initial 1d shape had
     `ColumnarStore` materialize Events, manage the eventCache,
     and emit row-shape exports — framework-level code that knew
     about `Event` / `EventKey` / `Time` / `TimeRange` /
     `Interval`. Three rounds of review (L2 + 2 Codex) found
     correctness issues at the same surface (cache validation
     incomplete, key identity, kind-aware data equality, extra-
     /missing-fields leaks) because those concerns sit at the
     wrong layer.

     Pivoted to clean separation:

     **Pure framework** at `packages/core/src/columnar/`. Zero
     upstream imports (runtime or type). Owns its own type
     vocabulary at `columnar/types.ts` (`ColumnDef`,
     `ColumnSchema`, `ScalarValue`, `ArrayValue`, `KeyKind`).
     `ColumnarStore<S>` is schema-validated composition of
     `KeyColumn` + value columns + `valueAt`. Independence test
     scans every framework file for forbidden imports
     (`Event` / `Time` / `TimeRange` / `Interval` / `temporal` /
     `types` / operators).

     **Row-API adapter** at `packages/core/src/series-store.ts`.
     `SeriesStore<S>` wraps a `ColumnarStore` + optional
     eventCache. Owns `keyAt` / `eventAt` / `toEvents` /
     `Symbol.iterator` / `toRows` / `toObjects` + the five
     public-API invariants from the RFC. Structural cache
     validation: structural key equality via `EventKey.equals`,
     per-column data agreement, exact-schema field set (no
     extras OR missing fields), kind-aware value equality
     (`Object.is` for numbers so NaN matches itself, shallow
     element-wise for arrays so the `ArrayColumn` defensive freeze
     doesn't break cache sharing).

     Bundle: 17.2 KB framework + 4.0 KB adapter = 21.2 KB
     gzipped (under the framework-design <25 KB target).

     The split also surfaced what later sub-steps need to
     decide: row-shape intake factories (`fromValidatedRows`,
     `fromTrustedEvents`) belong at the `SeriesStore` layer; the
     framework's `ColumnBuilder` operates on column data.

   - **1e — `ColumnBuilder` primitives + `fromValidatedRows`
     row-intake.** ✅ Shipped (PR #136, merged 2026-05-13). 34
     builder tests + 11 row-intake tests. Framework adds Float64
     / Boolean / String / Array column builders with one-shot
     `finalize`, defensive copy at append for arrays, and
     amortized O(1) capacity doubling. Row-API adapter adds
     `SeriesStore.fromValidatedRows` that delegates to
     `validateAndNormalize`, walks events into builders, and
     pre-populates the eventCache so event identity survives
     intake. Two real bugs caught in review — both in the
     overwrite path: `#writeAt(rowIndex, undefined)` failing to
     clear the validity bit (L2), and defined→defined `appendAt`
     overwrite inflating `#definedCount` without a bitmap (Codex
     round 1). Both fixed with regression tests.
     Deferred follow-up (start of 1f or later): `fromTrustedEvents`
     (skip validation pass) and framework-level `fromBuilders`
     factory on `ColumnarStore` — both reuse the in-place
     `buildSeriesStoreFromEvents` helper.
   - **1f — Index views (`withRowSelection`, `materialize`) +
     zero-copy schema ops.** ✅ Shipped (PR #147, merged
     2026-05-27). 49 view tests; framework total ~370 tests.
     Five framework-level ops: `withRowSelection` (materializing
     gather via per-column `sliceByIndices`), `materialize`
     (identity for 1f; stable surface for the future lazy-view
     path), `withColumnsRenamed`, `withColumnReplaced`,
     `withColumnAppended`, `withColumnsSelected`. All three
     `KeyColumn` variants got `sliceByIndices(indices)` methods
     to support the gather path. Three rounds of review (L2 +
     Codex × 2) found real correctness gaps closed before merge:
     eager out-of-range index validation (silent epoch-row
     corruption under `withColumnsSelected([])`), unsafe column
     names (`__proto__` / `prototype` / `constructor` reserved
     centrally at `ColumnarStore.fromTrustedStore`), and
     inherited-Object-prototype names as rename-map keys
     (`renames[name]` walked `Object.prototype`; fixed with
     `hasOwnProperty.call`). The materializing-vs-lazy decision
     is documented; lazy view-mode columns are a future-doors
     optimization with the existing API as the stable surface.
   - **1g — Chunked value columns + `concatSorted` + `materialize`
     compaction.** ✅ Shipped (PR #148, merged 2026-05-25). 62
     framework tests after Codex round-1 fixes (42 `ChunkedColumn` - 20 `Concat`); framework total ~433 tests.
     Four chunked value-column variants
     (`ChunkedFloat64Column`, `ChunkedBooleanColumn`,
     `ChunkedStringColumn`, `ChunkedArrayColumn`) — each holds a
     `ReadonlyArray<Plain>` of chunks + `chunkOffsets: Int32Array`
     (prefix sum), eagerly computes an aggregate validity bitmap
     (preserving the "no bitmap ⇒ all defined" convention), and
     implements the shared `Column` interface
     (`read`/`scan`/`sliceByRange`/`sliceByIndices`). The `Column`
     union widens to include them; a new `storage: 'packed' |
'chunked'` secondary discriminator lets hot-path callers
     (reducers) narrow on `kind === 'number' && storage ===
'packed'` to dereference `Float64Column.values` etc.
     `sliceByRange` stays chunked across multi-chunk ranges
     (zero-copy on chunk boundaries) and collapses to plain
     within a single chunk; `sliceByIndices` always
     materializes (gather destroys chunk locality).
     `concatSorted(stores)` N-way concat over temporally-disjoint
     stores: validates schema structural equality, key disjointness
     (strict `<` for Time, half-open `<=` for TimeRange/Interval),
     materializes the key column (`begin`/`end`/labels — labels
     rebuilt via `stringColumnFromArray` so the dict-vs-fallback
     heuristic runs on the whole), and flattens nested chunked
     inputs so chunks always stay one level deep. `materialize`
     now does real work: walks each value column, compacts any
     chunked variants to their plain counterparts via dedicated
     `materializeChunked*` helpers, and returns the input
     unchanged when every column is already packed (identity
     fast-path).
   - **1h — `ColumnarRingBuffer` + `scatterByPartition`.** ✅
     Shipped (PR pending, branch `feat/columnar-step-1h`). 49 new
     framework tests (35 `ColumnarRingBuffer` + 14 `Scatter`);
     framework total ~482 tests.
     `ColumnarRingBuffer<S>` is a mutable, append-only circular
     buffer backing streaming sources. Circular indexing with
     `head` + `length` + `capacity`; logical row `i` lives at
     physical `(head + i) % capacity`. Per-column mutable storage
     for all four value kinds (Float64Array, bit-packed Uint8Array,
     `(string|undefined)[]`, `(ArrayValue|undefined)[]`) and all
     three key kinds (Time, TimeRange, Interval — the latter
     requires `intervalLabelKind: 'string' | 'number'` in options).
     `appendBatch(batch: ColumnarStore<S>)` validates schema
     structural equality and routes per-row writes through circular
     indexing. Lazy growth (default true) starts at
     `min(retention, 64)` and doubles to `retention`; eager mode
     pre-allocates. Eviction advances `head` once `length ===
retention`. Batches larger than `retention` keep only the
     trailing `retention` rows. `evictPrefix(n)` and `snapshot()`
     decouple the immutable view from ongoing append/evict — the
     snapshot owns fresh typed buffers and dict-rebuilds the
     string columns via `stringColumnFromArray` so encoding
     decisions run once on the snapshot window. The ring is
     **ordering-agnostic** (per RFC V4); strict/drop/reorder
     semantics live at the `LiveSeries` layer.
     `scatterByPartition(source, columnName)` partitions a store
     by a scalar value column, returning
     `Map<ScalarValue, ColumnarStore<S>>`. Rejects array-kind
     partition columns and the key column. Drops rows whose
     partition cell is undefined or `NaN` (the `NaN !== NaN`
     gotcha makes it useless as a Map key). Per-bucket sub-stores
     preserve schema and the input's relative row order;
     cross-bucket order is unspecified (it's a Map).

   **State after 1h (2026-05-25).** All step-1 sub-steps (1a–1h)
   shipped. The framework layer is complete; the next batch of
   work is TimeSeries integration (step 2 in this section's
   roadmap). 1885 tests total across core + react. Framework
   total: ~482 columnar tests. Bundle target (<25 KB gzipped)
   slipped past 26 KB at 1g; 1h adds ~12-15 KB more (ring buffer
   is substantial). Targeted size optimization will be a separate
   sub-step before merging the framework into the user-visible
   API. The pure-substrate layering established in PR #135 (Path
   B) has held cleanly across every subsequent sub-step — no
   framework file imports `Event` / `Time` / `TimeRange` /
   `Interval` / `temporal` / row-API types, verified by the
   independence test on each PR.

2. TimeSeries integration (~3 weeks) — private-field columnar store,
   lazy event materialization, API invariants pinned by tests.
   Sub-stepped per the integration pattern.
   - **2a + 2b — Private `#store` field + lazy `events` getter +
     point-accessor routing.** ✅ Shipped (PR #150, merged
     2026-05-25). 78 TimeSeries tests (+8 columnar-integration
     invariants); 1849 in `packages/core`. `TimeSeries`'s row-
     oriented `events: ReadonlyArray<Event>` field replaced with a
     private `#store: SeriesStore<S>` + lazy `get events()`. Every
     point accessor (`at` / `first` / `last` / `find` / `some` /
     `every` / `includesKey` / `bisect` / `atOrBefore` /
     `atOrAfter` / `Symbol.iterator`) routes through
     `#store.eventAt(i)` or `#store.keyAt(i)` directly — no full
     event-array materialization on point lookups. `bisect` does
     O(log N) `keyAt` probes with zero Event allocations.
     Module-private `TRUSTED_STORE_SENTINEL` Symbol routes
     trusted-store paths through the public constructor (ES
     private-field installation requires a running constructor;
     the previous `Object.create(prototype)` shape is no longer
     viable). `series.events` is `Object.freeze`d after lazy
     materialization to preserve immutability invariants. Five
     review rounds total (L2 medium + Codex × 4): events freeze,
     `fill('linear')` kind sensitivity, point-accessor refactor
     pulled in from 2b, fill contract docs, mixed-kind interval
     breaking change documented in CHANGELOG, `at(NaN)` integer
     guard, cache-validation fast-path.
     **Perf: +40% construction vs the pre-2a row-array baseline**
     (15ms → 21ms at N=100k). The substrate has real construction
     cost; the recovery path is sub-step 2c's column-native intake
     (bypass per-row Event allocation in `validateAndNormalize`).
     Benchmark script at `packages/core/scripts/perf-timeseries-
columnar.mjs`.
   - **2c — Column-native intake.** ✅ Shipped (PR #151, merged
     2026-05-25). New `validateAndNormalizeColumnar` in
     `validate.ts` walks rows once and writes directly into
     per-column typed-array buffers + per-row key buffers,
     skipping the N Event allocations + N frozen data dicts that
     `validateAndNormalize` paid for the row-shape pipeline.
     `SeriesStore.fromValidatedRows` routes through the new
     path with an empty event cache; events lazy-materialize on
     first `eventAt(i)` access. Lazy validity bitmap allocation
     (first-missing-cell triggers alloc + back-fill of previously-
     defined bits). Inlined the bitmap allocate-+-backfill in the
     hot loop (L2 perf nit) so per-row × per-column iterations
     don't allocate closures. **Perf vs main (3.6× faster
     construction, 3× faster point-access):**
     - build N=100k: 14.9ms → 4.19ms (-72%)
     - build N=1M: 167ms → 46ms (-72%)
     - build + 100 at(i) N=100k: 14.1ms → ~4.9ms (-65%)
     - build + bisect N=100k: 14.5ms → ~4.8ms (-67%)
     - **trade-off**: `series.events` full-materialize is now
       slower (lazy materialization shifts cost from build to
       first-events-access). The columnar substrate's whole
       point is "don't materialize rows you don't need." Users
       opting into row materialization pay there.
       The existing `validateAndNormalize` stays as-is for
       `TimeSeries.fromEvents` and other Event-array consumers.
       Column-native `toRows` / `toObjects` / `toJSON` paths
       deferred to a later sub-step (the lazy events path is
       already fast enough for the common cases).
   - **2d — Invariant test + bench**. Pin the five public-API
     invariants from the RFC at the TimeSeries layer. Run the
     perf bench against multiple workload patterns (dashboard
     build-once-use-many, one-shot transform, streaming append).
3. Numeric reducer adaptation (~2 weeks) — `sum` / `avg` / `count` /
   `min` / `max` / `stdev` / `median` / percentile family.
   - **3 Phase A — `series.reduce()` column fast path.** ✅ Shipped
     (PR #153, merged 2026-05-26). Optional
     `ReducerDef.reduceColumn(col: Float64Column)` for the 8
     built-in numeric reducers; `tryReduceColumnFastPath` dispatches
     when the target column is packed `Float64Column` and the
     reducer defines `reduceColumn`. Inline validity-bitmap walk
     pattern (`(bits[i >> 3]! & (1 << (i & 7))) !== 0`) avoids
     per-cell function calls. **Perf vs main (N=1M):**
     - sum: 33.9 ms → 0.57 ms (**59×**)
     - count: 28.8 ms → ~0 ms (∞ via O(1) `validity.definedCount`)
     - min: 33.7 ms → 0.46 ms (**73×**)
     - max: 33.5 ms → 0.57 ms (**59×**)
     - avg: 33.9 ms → 0.57 ms (**59×**)
     - stdev: 40.2 ms → 1.16 ms (**35×**) — two-pass formula for
       numerical stability (catastrophic cancellation in one-pass
       at large magnitudes; row-API also uses two-pass)
     - median / p95: 185 ms → 54 ms (**3.4×**) —
       `Float64Array.sort` intrinsic compare dominates over
       `Array.sort` with comparator
       L2 + Codex reviews caught two correctness divergences in the
       parity claim: stdev one-pass cancellation (closed via
       two-pass) and NaN-laundered min/max + sort-order divergence
       (closed via bug-for-bug row-API mirroring; single-pass
       `Number.isNaN` detector preserves `Float64Array.sort` for the
       no-NaN common case). 8 new regression tests pin row/column
       parity across all reducers on NaN-bearing inputs.
   - **3 Phase B — `series.aggregate()` per-bucket fast path.**
     ✅ Shipped (PR #186 + empty-bucket strengthening re-commit
     #187, merged 2026-06). `tryAggregateColumnarTimeKeyed(begins,
getColumn, buckets, columns)` in `batch/aggregate-columns.ts`
     reduces each time-keyed bucket straight off the column via the
     Phase-A `reduceColumn` fast paths, no per-bucket event
     materialization. Honest-baseline caveat pinned in
     `scripts/perf-aggregate-range.mjs` (the displaced `states` path
     was lighter than the custom-fn baseline; the small floor
     regression was accepted against goal-3, no magic-number
     threshold). Friction item #6 from
     [M1 chart-extraction](../../experiments/pond-ts-charts/) flagged
     `reduceColumnRange` as the more directly useful next step than
     Phase C — chart's per-frame Y-extent compute over the visible
     subarray is exactly the shape this serves.
   - **3 Phase C — `series.rolling()` fast path.** Deferred.
     Sliding windows need add/remove semantics; monotonic-deque
     - running-stats patterns don't map cleanly to a single
       `reduceColumn` call. Probably a per-reducer `rollingColumn`
       state factory.
   - **Followup — principled NaN + Welford semantics.** Codex
     flagged a shared row + column stdev overflow on `[1e308,
1e308]` (sum overflows before mean). Both paths share this
     numerical-stability gap. Folded into a broader design-doc
     follow-up that also decides whether NaN should be filtered
     universally across reducers (currently both paths exhibit
     surprising NaN-laundered behavior; bug-for-bug parity is
     the closed state).
4. Derived transforms (~3 weeks) — `select` / `rename` / `filter` /
   `slice` / `head` / `tail` / `diff` / `rate` / `pctChange` /
   `cumulative` / `shift` columnar paths. **In progress — recovers
   the 3.6× columnar construction win that the consultant found
   "evaporates at the first transform" (batch operators read
   `this.events`, forcing full lazy materialization).** Each
   transform reshapes the store directly via the column-native view
   ops (`withColumnsSelected` / `withColumnsRenamed` /
   `withColumnReplaced`) + `#fromTrustedStore`, no events touched.
   Doubles as **operator extraction** (ARCHITECTURE.md "thin API
   shell + `batch/operators/*.ts`"): each op becomes a pure
   `(store, schema, spec) → {store, schema}` function, the method a
   thin delegate. Per-transform status:
   - **`select`** ✅ Shipped (PR #188, merged 2026-06). Column-native
     reshape via `withColumnsSelected`; 7–10× pipeline win
     (`newPipeline ≈ build`).
   - **`rename`** ✅ Shipped (PR #189, merged 2026-06).
     `withColumnsRenamed`; stricter than the old event path (rejects
     key-rename + target collisions). Same pipeline win.
   - **`cumulative`** ✅ Shipped (PR #190, merged 2026-06). **First
     fully extracted operator** — `cumulativeOp` in
     `batch/operators/cumulative.ts`, establishing the Step-4
     template. 5.4–5.9× pipeline win. Exact parity (11 existing +
     7 column-native-edge tests); a type-defeated non-numeric target
     now fails fast (kind guard) instead of silently corrupting.
   - **`withRowRange` substrate** ✅ Shipped (PR #191, merged 2026-06).
     Contiguous row-range store slice (`view.ts`) — the row-dimension
     sibling of `withRowSelection`; the substrate precursor for
     `drop` and the row-range transforms (`slice` / `head` / `tail`).
   - **`diff` / `rate` / `pctChange`** ✅ Shipped (PR #192, merged
     2026-06). `diffRateOp` in `batch/operators/diff-rate.ts`; first
     consumer of `withRowRange` (`drop: true` slices off the
     predecessor-less first row). 5.3–7× pipeline win. Exact parity
     (31 existing tests, verified additionally by a 7,200-case
     differential fuzz in L2) + 7 column-native-edge tests, incl. the
     first **chunked-input direct-operator tests** (the storage-
     agnostic `col.read` contract; unreachable through the method
     since `concat` is still events-based → packed).
   - **`cumulative` chunked-input backfill** ✅ Shipped (PR #193,
     merged 2026-06). Completed the chunked-coverage policy for every
     extracted operator (the pattern proven on diff/rate in #192).
   - **`fill`** ✅ Shipped (PR #194, merged 2026-06). `fillOp` in
     `batch/operators/fill.ts` — the largest transform body
     (god-file −181 net). Multi-kind rebuild (number/string/boolean/
     array), only-rebuild-changed zero-copy passthrough, lazy times,
     `withRowRange` not needed (schema-stable). 4.9–5.5× pipeline win.
     L2 + a Codex pass both cleared it. One **deliberate behavior
     change** (not parity, now documented): a kind-mismatched literal
     throws (was: a silently-inconsistent series). 47 existing + 7
     column-native-edge tests.
   - **`slice`** ✅ Shipped (PR — this wave-step). Inline reshape via
     `withRowRange` (like `select`/`rename`, no per-row walk → no
     operator file); normalizes `Array.prototype.slice` semantics
     (negative indices, `ToInteger` truncation, clamps) to an absolute
     range first. Pinned by an 11-case suite incl. a differential
     sweep against `Array.prototype.slice`.
   - **`mapColumns`** ✅ Shipped (PR — this wave-step). **New public
     method** (not a conversion): a per-cell column value transform,
     `mapColumns({ col: (value) => newValue })`, extracted as `mapOp`.
     Same kind in/out (number→number, string→string, …) ⇒ schema
     unchanged; missing cells carry. The column-scoped counterpart of
     the event-based `map()` — fills the gap that there was no
     ergonomic per-cell column transform (you'd have used the slow
     event `map`). ~5–6× pipeline win. Same-kind enforced at the type
     level (`mapColumns.test-d.ts`); chunked-input + NaN pinned via
     direct `mapOp`. Surfaced by the user from the PR-comment scope
     note below.
   - **`shift`** ✅ Shipped (PR — this wave-step). `shiftOp` in
     `batch/operators/shift.ts`; per-target numeric shift+pad
     (`out[i] = col.read(i−n)`, else undefined-pad), `cumulative`-shaped
     (widens targets to optional number). 5.8–6.8× pipeline win. Exact
     parity (11 existing tests) + 8 column-native-edge tests incl.
     chunked-input.
   - **`collapse`** ✅ Shipped (PR — this wave-step). `collapseOp` in
     `batch/operators/collapse.ts` — reads only the keyed columns,
     runs the reducer over a minimal `{key: value}` object (no full
     Event), composes via `withColumnsSelected` (drop keyed unless
     `append`) + `withColumnAppended`; output kind inferred from row 0.
     4.7–6.5× pipeline win (more modest in spirit — the per-row reducer
     dominates both paths — but the event-materialization tax still
     dominates the measured number). Parity pinned by the existing
     `TimeSeries.test`/`Event.test` collapse cases + 8 column-native-edge
     tests incl. chunked-input.
   - **Transform wave COMPLETE.** All genuinely column-native-able
     batch transforms now read columns, not `this.events`. Judgment
     calls left intentionally event-shaped / deferred: `tail(duration)`
     (key-bisect + `withRowRange` — convertible, low value),
     `filter` (predicate is event-shaped; only the row-subset assembly
     via `withRowSelection` would be column-native). The event-based
     `map(nextSchema, (event, i) => newEvent)` is permanently out of
     scope — an arbitrary event→event closure can't be vectorized
     (distinct from the new per-cell `mapColumns`). **Follow-up:**
     extract the shared `columnFromValuesByKind` kind→builder dispatch
     (duplicated across `fillOp` / `mapOp` / `collapseOp`).
   - **`asTime` / `asTimeRange` / `asInterval` rekeys** ✅ Shipped
     (post-wave). Key-axis kind reinterpretation via the new internal
     `withKeyColumn` view op (the key-dimension sibling of
     `withColumnReplaced`): reads the existing key's `begin`/`end`
     buffers, builds the new-kind `KeyColumn`, reuses value columns by
     reference — no events. `asTimeRange` ~9× (zero-copy buffer reuse).
     **Breaking:** `asInterval`'s label fn now takes the interval's
     `TimeRange` + index, not the whole `Event` (this is what lets the
     function form stay columnar) — `range => range.begin()` unchanged;
     CHANGELOG [Unreleased]. This corrects the earlier mis-bucketing of
     `asX` as "inherently event-shaped" — they were always key-axis
     rekeys, just needing the `withKeyColumn` primitive.
5. Aggregate planner (~2 weeks).
6. String / dictionary reducer adaptation (~2 weeks).
7. `LiveSeries` numeric ring buffer (~2 weeks).
8. Chart-extraction alignment — **column-centric public API**
   (~2-3 weeks total, per the sub-step sequencing).

   Implements [`docs/rfcs/column-api.md`](../rfcs/column-api.md)
   (V3, adopted 2026-05-27). The RFC promotes the PR #152 spike
   accessor (`series.column('x')` / `series.keyColumn()`) into a
   canonical, kind-narrowed, time-detached public surface for
   single-column work. Multi-column composition and time-aware
   operations stay event-shaped per
   [`columnar-core.md`](../rfcs/columnar-core.md). RFC went
   through original draft → chart-experiment review → independent
   library review → V2 amendment → Codex pass on V2 → piece A
   (type system rewrite) → V3 restructure (pieces B + C + D + E) →
   Codex pass on V3 → V3.1 fixes (KeyColumn range-key invariant,
   per-kind method consistency, walkback log cleanup). Adopted as
   the binding spec; sub-step status:
   - **8a — Public type re-exports.** ✅ Shipped (PR #154,
     merged 2026-05-27). Re-exported the curated public Column
     surface from `pond-ts`'s top-level barrel: per-kind classes
     (Float64Column / BooleanColumn / StringColumn / ArrayColumn),
     chunked variants, key-column variants (TimeKeyColumn /
     TimeRangeKeyColumn / IntervalKeyColumn), union /
     discriminator types (Column, KeyColumn, ColumnKind,
     ColumnStorage, ScanOptions, IntervalLabelKind,
     ValidityBitmap). Substrate-internal items (builders,
     validity helpers, ColumnarStore, view transforms,
     concatSorted, scatterByPartition, ColumnarRingBuffer,
     factory functions, sentinels) deliberately held back. Closes
     M1 friction item #4. Type test
     `packages/core/test-d/column-api-reexports.test-d.ts` pins
     every re-exported symbol against the literal-narrowing
     contract. L2 high confidence, no Codex round needed (pure
     re-export, no runtime behavior change).
   - **8b — `Float64Column` scalar reductions + schema-narrowed
     `column()`.** ✅ Shipped (PR #155, merged 2026-05-27). Public
     method surface on all four packed column classes AND their
     chunked variants (`min` / `max` / `sum` / `mean` / `stdev` /
     `median` / `percentile(q)` / `count` / `minMax` / `hasMissing`
     / `nullCount` / `first` / `last` / `firstDefined` /
     `lastDefined` / `at` / `slice` on Float64Column;
     kind-appropriate subsets on Boolean / String / Array per RFC
     §7.3). Mounted via declaration-merging + prototype attachment
     in `packages/core/src/column-api.ts`, which lives outside
     `columnar/` so the substrate stays pure (substrate-purity
     test still passes). Reducer-backed methods delegate to PR
     #153's `reducer.reduceColumn` fast paths; chunked methods
     delegate to `materialize().method()` for v1 (~2× cost vs
     packed-native; future PR can add chunked-native impls).
     Schema-narrowed `TimeSeries.column<Name>(name: Name)`
     overload from RFC §7.2 — public wide overload dropped, so
     typos / key-column names / out-of-schema strings fail to
     compile rather than silently returning undefined. Tests:
     45 new runtime + comprehensive `.test-d.ts` per RFC §7.4.
     Review chain: L2 medium → 3 substantive fixes (chunked
     type-safety hole, missing negative tests, JSDoc/code
     mismatch) → Codex pass approve, no material findings.
   - **8c — `bin` (chart per-pixel downsampler).** ✅ Shipped (PR
     #156, merged 2026-05-27). `Float64Column.bin(W, reducer)` lands the chart's
     headline primitive: equal-width index bins with a reducer per
     bin, output type narrowing per reducer name (`'minMax'` →
     `{ lo, hi }`, scalar reducers → `Float64Array(W)`). The fused
     `'minMax'` variant collapses the chart's manual per-pixel
     min/max loop into one method call; the `{ lo, hi }` shape was
     the chart-experiment reviewer's stride-1 cache-pattern finding.
     Empty-bin convention: `sum` / `count` → 0 (mathematical),
     others → NaN (canvas-friendly: `ctx.lineTo(px, NaN)` breaks
     the sub-path). `slice` (zero-copy view) was already on the
     substrate from earlier work and exposed via 8b — the original
     8c framing of "slice + bin together" was unnecessary once 8b
     shipped slice as part of the substrate's already-mounted
     surface, so 8c was scoped to bin alone. Implementation
     delegates per bin to PR #153's `reducer.reduceColumn` fast
     paths; `minMax` inlines through the substrate's existing
     fused walk. Chunked variant delegates to materialize-then-bin
     per the 8b pattern. Tests: 28 new runtime tests covering all
     reducers, percentile via `'p${q}'`, empty / sparse bins,
     validity gaps (including chunked-specific coverage), edge
     cases, plus type-test narrowing per reducer. **Naming
     walkback:** V3 of the RFC originally proposed `binnedByIndex`
     to disambiguate from a deferred `binnedByTime`; in review the
     past-tense form felt overlong, so the method renamed to `bin`
     with the time-axis companion renamed to `binByTime` for
     parallelism. The disambiguation V3 was protecting is
     preserved by the operation's location — Column is detached
     from the time axis (§5 guardrail), so `col.bin` is necessarily
     index-domain. RFC's V3 amendment log records the rename with
     historical context.
   - **8d — `KeyColumn` `.at(i)` + `.slice(s, e)` + narrowed
     `keyColumn()`.** ✅ Shipped (PR #159, merged 2026-05-27).
     Mirrors Column's shape on the key axis: `.at(i)` returns the
     raw row shape (`number` for `TimeKeyColumn`, `{ begin, end }`
     for `TimeRangeKeyColumn`, `{ begin, end, label }` for
     `IntervalKeyColumn`) per the substrate columnar idiom;
     `.slice(s, e)` is a zero-copy index-range view (typed-array
     `subarray` under the hood; for `IntervalKeyColumn` the labels
     column is sliced in lockstep). Substrate gained
     `sliceByRange(start, end)` + `fromValidatedSubarray` trusted-
     construction factory on all three key-column variants — the
     latter is the key perf primitive that keeps slice O(1) rather
     than O(N) (skips the per-row finiteness scan that the public
     constructor runs, since a subarray of a validated buffer is
     itself validated). `TimeSeries.keyColumn()` return type now
     narrows to `KeyColumnForSchema<S>` per RFC §7.5 — consumers
     no longer need `instanceof` / discriminator checks just to
     reach kind-specific fields like `.labels`. The
     `KeyColumnForSchema` type is implemented via a distributive
     `KeyColumnForKind<K>` helper so broad schemas (e.g.
     `TimeSeries<SeriesSchema>`) get the full key-column union
     rather than collapsing to `never`. Closes the chart-
     experiment's NF4 finding (hover/tooltip wants
     `keyColumn().at(i)`) and unblocks M5 heatmap. KeyColumn does
     NOT get scalar reductions in v1 — `TimeKeyColumn` min/max are
     trivial (`begin[0]` / `begin[length - 1]`); range-key max-end
     requires a scan and is RFC-deferred per §4 close-cases. Tests:
     34 new runtime + type-test narrowing per variant. New public
     type re-exports: `KeyColumnForKind`, `KeyColumnForSchema`,
     `TimeRangeKeyAt`, `IntervalKeyAt`. Review chain: L2 medium →
     5 substantive fixes (slice-input NaN/Infinity, JSDoc cleanup,
     non-public `keyAt` reference, stale comment, frozen-by-
     convention misleading wording) → Codex needs-attention → 3
     substantive fixes (at-input NaN/fractional/Infinity gate,
     `KeyColumnForSchema` distributivity collapsing to `never` for
     broad schemas, trusted-slice factory closing the O(N)
     validation hidden behind the "zero-copy" claim). The full
     audit trail is on PR #159's two L2 + two Codex comments.
   - **8e — M1 chart adopts the new API.** ✅ Shipped 2026-05-27 in
     pond-ts-charts-experiment commit
     [`e89eca1`](https://github.com/pjm17971/pond-ts-charts-experiment/commit/e89eca1).
     The single-column line chart rewrote from spike accessors
     (`series.column('x').values` + manual per-pixel min/max loop)
     to the column-centric idiom
     (`series.column('x').slice(s, e).bin(W, 'minMax')`). Per-frame
     chart work shrank from ~33 lines of hand-written reducer +
     downsampler code to 8 lines of method calls. Bench confirms
     a clean win at the load-bearing scale: N=10M full-window
     drops from 13.1 ms → 10.7 ms (-18%), comfortably under the
     16.7 ms 60 fps budget with real headroom for canvas draw.
     **Validation gate verdict:** kind dispatch retires cleanly
     (schema narrowing eliminates the `kind !== 'number'` and
     `| undefined` guards). Storage dispatch survives at the
     `.values` boundary because pond-ts doesn't yet expose a
     storage-agnostic typed-array materializer at the column-API
     surface — captured as friction NF3 in
     [`M1-column-api-adoption.md`](https://github.com/pjm17971/pond-ts-charts-experiment/blob/main/friction-notes/M1-column-api-adoption.md).
     Carry-forward items into the next pond-ts wave (in priority
     order): `series.bisectBegin(ts: number): number` (was F3,
     ergonomic), `col.toFloat64Array(): Float64Array`
     (storage-agnostic gather, closes F1 + NF3),
     `TimeSeries.fromTrustedColumns(...)` (was F5, producer-side
     intake), JSDoc note on `bin`'s NaN empty-bin convention
     (NF1, doc-only). API shape is proven for single-column
     line charts; M2 (multi-column) and M3 (chunked) are the
     next validation passes.
   - **8f — `BooleanColumn` / `StringColumn` reductions, on
     demand.** `all` / `any` / `none` on `BooleanColumn`;
     `uniqueCount` on `StringColumn`. Each method lands when an
     actual consumer use case earns it — not on spec. Docs lead
     with the generic Column shape and surface per-kind reductions
     as additive. Pending; awaits experiment friction.
   - **8g — (Deferred) `series.binByTime(name, W, range,
reducer)` on TimeSeries.** Time-aware variant for irregular-
     sample charts. Composable today as
     `series.within(t0, t1).aggregate(every((t1-t0)/W), { col:
reducer }).column(col).values`; the dedicated shortcut lands
     only when measured per-frame friction earns it. Deferred per
     pond's "friction-driven additions" discipline.
   - **8h — Docs update.** JSDoc on `series.reduce(col, reducer)`
     points single-column callers at `series.column(name).method()`
     as the recommended idiom. Docs site recipe for the column-
     centric pattern (and a `@pond-ts/react` section on column
     identity, memoization, and `useEffect` dependencies — see
     RFC §12 caching decision). Lands alongside 8b.

Each step lands as its own PR with the standard two-pass review
(Layer 2 + Codex). The framework layer is the most load-bearing;
reviewing it well matters more than ticking the whole sequence off
quickly.

**Validation pattern.** Each step is exercised by a use-case agent
before merge — the gRPC experiment is the natural primary driver
(memory pressure was its recurring friction), supplemented by the
dashboard / webapp telemetry / future experiments as they arise.
Per CLAUDE.md "Multi-agent experiments and the feedback model,"
friction reports drive refinement; the substrate is foundational
enough that getting feedback per step matters more than usual.

**Release shape (tentative).** v1.0 is the target version when the
substrate + the streaming milestones (B/C/D) that ship on top all
land cleanly. Tentative version map:

- v0.17.x — current patch wave (partitionBy ordering inheritance,
  etc.) — bug fixes only
- v0.18.0 — streaming milestone A (`LiveChange` source-side) — ships
  independently of columnar
- v0.18.x — columnar framework layer (step 1) lands behind feature
  flag or as internal-only initially
- v0.19.0 — columnar TimeSeries integration (steps 2–4) — first
  user-visible substrate landing
- v0.19.x — aggregate planner + string reducer adaptation +
  LiveSeries ring buffer (steps 5–7)
- v0.20.0 — streaming milestones B + C ship on substrate
- v1.0.0 — substrate complete + milestone D + chart alignment;
  v1.0 framing is the version when public API stability commits
  long-term

Release shape is tentative; if implementation surfaces a different
sequencing or a chunk doesn't earn its slot, the version map
adjusts.

### Next wave: gRPC re-bench → substrate adoption (queued 2026-05-28)

The chart-experiment closed its adoption + measurement cycle on
2026-05-28 (see
[`pjm17971/pond-ts-charts-experiment/STATUS.md`](https://github.com/pjm17971/pond-ts-charts-experiment/blob/main/STATUS.md))
and validated the substrate against single-column and multi-column
chart workloads at N=10M / 60fps. The natural next consumer for
substrate validation is the **gRPC experiment** — that's where the
columnar overhaul was originally strategically aimed (per the
columnar-core RFC's motivation), and the substrate has matured
upstream of the gRPC workload without the gRPC hot path re-benching
against it.

**Outcome (2026-05-29): the wave ran, and the measurable conclusion
is that the substrate's free wins were already delivered by v0.17.1;
the next real lever (columnar rolling) doesn't earn its cost at
current production headroom.** Phase A (V5 re-bench) completed; Phase
B Step 7 (LiveSeries ring buffer) was attempted and **walked back**
after the bench falsified it. Details below + in the experiment
friction note. The phase descriptions that follow are the original
plan, annotated with what actually happened.

**Step 7 walk-back — the durable finding.** The LiveSeries columnar
ring buffer was built and benched ([brief](../briefs/step-7-live-series-ring-buffer.md)):
ingest 9.4× slower (630ms vs 67ms for 300k rows), heap retained
_higher_ (36MB vs 28MB), not lower. **Why it can't win: the gRPC hot
path needs `Event` objects** — the rolling pipeline subscribes to
`'event'`, so `LiveSeries` materializes an Event per row regardless
of backing. The ring then decomposes it back into columns (strictly
more work than create + store-reference), and the "don't retain
events" payoff didn't even show as a heap win. A columnar _buffer_
can't avoid the allocation when the consumer needs events; only a
columnar _rolling reducer_ (Step 3 Phase C) would cut the V5 GC
pressure. Kept: the storage-strategy refactor (PR #168, earned its
keep). Reverted: PR #169 reverts #167's `_appendRowTrusted`. The
ring attempt is preserved on branch `feat/step-7-ring-storage`
(not merged). Same measure-and-walk-back discipline as the `bin
{out}` revert.

**Wave shape.** Three phases. Documented in detail at
[`pjm17971/pond-grpc-experiment/friction-notes/columnar-rebench.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/columnar-rebench.md) —
that file is the binding plan for the experiment-side work; this
section is the pond-ts side.

- **Phase A — Baseline re-bench (gRPC agent, no library code).**
  Run the V4 bench harness (`pnpm perf` — four bench:agg load
  points + ceiling profile) against the current v0.17.1 pin. V4 was
  measured at v0.14.0; v0.15.0 (fused rolling), v0.16.0
  (pipeline.stats), v0.17.0 (live.sample), v0.17.1 (partitionBy
  default-inherit) have shipped since. The V5 row of the
  V1→V2→V3→V4 bench table is the deliverable. **No public API
  consequences.**

- **Phase B — Library work prioritized by what V5 surfaces.** Two
  candidates, both pre-named in this Phase 4.7 roadmap:
  - **Step 7 — `LiveSeries` numeric ring buffer.** ❌ **ATTEMPTED
    AND WALKED BACK (2026-05-29).** Wired `ColumnarRingBuffer` (step
    1h) under `LiveSeries` for strict/drop modes; bench showed 9.4×
    slower ingest and _higher_ heap retention. The ring can't win
    because the consumer (rolling pipeline) needs `Event` objects
    regardless of backing — see the walk-back finding above. The
    storage-strategy refactor that preceded it (PR #168) stays as
    clean architecture; the ring backing was reverted.
  - **Step 3 Phase C — `series.rolling()` columnar fast path.** The
    structural fix for V4's 8.2% `LivePartitionedSyncRolling.ingest`
    self-time line. Per-reducer `rollingColumn` state factory (or
    batch-recompute over substrate slices). **Public API
    consequence:** the per-reducer extension surface is the design
    question — is `rollingColumn` an internal hook on the reducer
    registry, or is it a public extension contract (analogous to
    `ReducerDef.reduceColumn` from PR #153)? Defer the decision to
    the V5-surfaced friction; if no custom-reducer driver shows up,
    keep it internal.

  Ordering between Step 7 and Step 3C depended on V5's profile.
  V5 said "Step 7 first" (GC dominant at 22%), but the Step 7
  walk-back proved that recommendation wrong: the GC line is driven
  by the rolling pipeline's per-event `Event` consumption, not by
  buffer storage. **Step 3 Phase C is the only lever that would
  actually cut it** — but it's a much larger change (per-reducer
  columnar state machines) and earns its slot only if a future
  workload pushes near ceiling. Production target is 100k/s; V5 hits
  ~210k/s (2.1× headroom). Deferred until friction earns it.

- **Phase C — Consumer re-adoption + dashboard validation.** The
  gRPC experiment bumps to whatever ships from Phase B and
  produces the V6 bench. In parallel, the **dashboard agent** —
  the second consumer surface, owning the React/`useSnapshot` /
  `useLiveQuery` path — gets looped in for adoption friction on
  the same substrate. Two independent friction reports converge
  on the writeup: gRPC reports the throughput story, dashboard
  reports the snapshot/render story. Substrate's strategic
  justification is met when both consumers report wins.

**Operating rules for this wave.**

- **PR merges wait for human approval.** Standing instruction from
  2026-05-28 — every library PR in this wave gets the standard
  two-layer review (Layer 1 self + Layer 2 adversarial agent + Codex
  pass when below-high confidence), then **pauses** for human review
  before merge. Agent-merge default per CLAUDE.md is suspended for
  this wave so the user can pace engagement.
- **Each PR carries a benchmark.** Performance-centered work
  (which most of this wave is) reports before/after numbers in the
  commit message per the CLAUDE.md "Performance check for new
  operators" section. The V4 bench table format is the template.
- **Each PR carries a plan summary and motivation in the body.**
  Including a section on public API consequences when any exist —
  even invariant-preserving changes (Step 7) get an explicit
  "invariants preserved" subsection so the diff reviewer can verify
  rather than infer.
- **Friction notes live in the consumer experiment, not pond-ts.**
  gRPC's V5 / V6 reports land in `friction-notes/columnar-rebench.md`
  in the experiment repo; pond-ts gets the corresponding PR with the
  library-actionable item. Same discipline the chart-experiment
  used.

**What this leaves on the table (intentionally).** Steps 4
(derived transforms columnar), 5 (aggregate planner), 6 (string/
dict reducers), 8e/8f/8g (additional chart sub-steps) all defer
until a consumer friction earns their shape. The chart-experiment's
M3 (chunked rendering) and M5 (interval heatmap) remain deferred
per their respective notes.

**Deferred (surfaced by the chunked-live wave, PR #170 Codex pass).**
`LiveReduce` over an `ordering: 'reorder'` source **with retention**
returns stale/`undefined` snapshots for the windowed reducers
(`min` / `max` / `first` / `last` / `samples`). Their rolling state
(monotone deque / head-removal ordered entries) assumes eviction
removes the oldest-_arrived_ event first — true for `strict` / `drop`
and the chunked backing (all append-only), but `reorder`'s
sorted-prefix eviction can drop a later arrival, which those
structures can't represent. Value-based reducers (`avg` / `count` /
`sum` / `stdev` / `median` / `percentile` / `unique`) remove by value
and stay correct. This is **pre-existing** (true on `main` before the
chunked work; the PR #170 FIFO change merely swapped one wrong answer
for another, now reverted to identity-primary) and is documented in
`LiveReduce`'s class JSDoc + pinned by the value-based test in
`live-buffer-as-window.test.ts`. The fix, when a consumer earns it:
give `min`/`max` a removal-by-value structure (sorted array, as
`median` already uses) selected only for reorder sources — keeping
the O(1) monotone deque on the append-only hot path. Workaround today:
`live.toTimeSeries().reduce(...)`. The broader architecture for a
columnar `reorder` (append-only main store + sorted "late corral"
overlay + grace-flush compaction) and the column-native output boundary
it shares a spine with are captured in
[`docs/rfcs/columnar-live-protocol.md`](../rfcs/columnar-live-protocol.md)
— RFC context, not committed.

**The V6 re-bench corrected the target (2026-05-30).** The gRPC
experiment re-benched against the released v0.18.0
([pond-grpc-experiment#42](https://github.com/pjm17971/pond-grpc-experiment/pull/42))
and **falsified Phase 1's heap framing for the real consumer.** The
chunked backing engaged on the source (67k chunks), but the retained
`Event` count was **unchanged (6.77M)** and net heap went **up ~210 MB** —
because the dominant retention is the **100 `partitionBy('host')`
sub-series**, which Phase 1 carved out to `Event[]` (`__backing: 'array'`)
on the assumption "partitions aren't the OOM driver." That assumption was
wrong: ~67k retained Events per partition × 100. Phase 1 aimed at the
wrong tier. What it _did_ deliver is real and worth keeping: minor GC max
pause **−74%**, ingest→fanout p99 **−78%**, pushManyTotal p99 **−77%** —
Phase 1 is a churn/latency fix, **not** the heap fix it was billed as.

**Phase 2 — column-native partition routing (✅ MERGED #175, 2026-06-03;
gRPC V8 clean win).** The genuine OOM fix. `partitionBy(...)` over a
chunked source routes its chunks to per-partition slices and stages them
into chunked-backed partition sub-series — replacing the per-partition
`Event[]` retention with columnar chunks. The naive "one chunk per
(batch × partition)" was a V7 regression (1.58M chunks, 4.1× heap,
throughput collapse — the thin-scatter / ~1-row-chunk pathology); the fix
is a **per-partition coalescing tier** (`ChunkedColumnarLiveStorage`
stages gathered tuples and flushes one packed chunk per 256 rows). gRPC
**V8** cleared every gate: ColumnarStore 1.58M→94k (60×, matches the
threshold), retained heap 2.22 GB→1.92 GB (−13.5%, below the V6
baseline), Event retention 6.77M→37,891 (−99.4%, the remainder all
emit-side), sustained throughput 41k→51k/s (+24%), ingest→fanout p99
−25%. One soft caveat: `pushManyTotalMs` p99 7.1 ms vs 3.6 ms (the flush
lands on threshold-crossing batches; p50 unchanged, under deadline) —
smoothable later, not a blocker. Merged as #175 (2026-06-03) after a fresh
L2 + Codex re-review (task #89); **no new public surface** (only `_`-internal
hooks). Implementation now on `main` (`live/live-partitioned-series.ts`
`#routeChunk`, `live/live-chunked-storage.ts` coalescing tier). Scope plan:
[`docs/briefs/columnar-partition-routing.md`](../briefs/columnar-partition-routing.md).

**Next (now unblocked by Phase 2): column-native output (§A).**
Before-number locked by V6: **~11.7 MB/s** transient at the OOM cell
(~90k Events/s + ~90k row-objects/s for the shared `'batch'` listeners),
and the V8 result confirms it's the dominant remaining allocation slice
(the 37k retained Events are all emit-side). §A removes that
_output-boundary_ slice — separate from the partition-retention fix
above. Spike plan:
[`docs/briefs/column-native-output-spike.md`](../briefs/column-native-output-spike.md).
§B (columnar reorder) stays unearned.

**Cross-references:**

- [`docs/rfcs/columnar-live-protocol.md`](../rfcs/columnar-live-protocol.md)
  — the live boundary protocol: column-native output (§A), columnar
  reorder corral/LSM overlay (§B), and the structural-delta spine that
  unifies them (§C). Successor-direction to this wave's chunked backing.
  Carries the full multi-agent review layer + V2 amendments.
- [`docs/briefs/columnar-partition-routing.md`](../briefs/columnar-partition-routing.md)
  — **Phase 2, the measured-earned OOM fix** (re-prioritized ahead of §A
  by the gRPC V6 re-bench): column-native partition routing via
  `scatterByPartition` + chunked-backed strict-time partition sub-series.
- [`docs/briefs/column-native-output-spike.md`](../briefs/column-native-output-spike.md)
  — the §A increment (column-native output), now sequenced **after**
  Phase 2: payload fork, additive listener name, before-number locked by
  the V6 re-bench, API gate.
- [`docs/rfcs/columnar-core.md`](../rfcs/columnar-core.md) — the
  binding RFC with full library-agent response.
- [`docs/briefs/core-columnar-store-spike.md`](../briefs/core-columnar-store-spike.md)
  — evidence base from the Codex spike.
- [`docs/rfcs/streaming.md`](../rfcs/streaming.md) — streaming
  RFC; sequencing addendum notes how milestone A + columnar
  interact.
- [`docs/rfcs/charts.md`](../rfcs/charts.md) — chart RFC; v1
  charts share columnar primitives with core.
- [`docs/rfcs/column-api.md`](../rfcs/column-api.md) — column-centric
  public API RFC (V3 adopted 2026-05-27). Binding spec for Phase 4.7
  step 8's sub-step sequencing (8a-8h above). Deliberate, small,
  scoped walkback of `columnar-core.md`'s "public API remains
  event-shaped" commitment, scoped to single-column / time-agnostic
  operations. Survived original draft → two parallel reviews →
  V2 amendment → Codex pass → V3 restructure → second Codex pass
  → V3.1 fixes. Type-system design verified compilable; type-level
  acceptance tests pinned in RFC §7.4 as CI-enforced contract.
- The previous "row-oriented core stays" deferred-design entry
  (now superseded; walked back in the Deferred Design Decisions
  section above).
