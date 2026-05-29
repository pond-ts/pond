# Step 7 — `LiveSeries` columnar ring buffer (design brief)

**Status:** Draft, queued 2026-05-29. **Awaiting human review before any code lands.**
**Author:** pond-ts library agent (Claude).
**Wave:** Phase 4.7 next-wave → gRPC re-bench → substrate adoption. Phase B Step 7 per [PLAN.md "Next wave"](../../PLAN.md#next-wave-grpc-re-bench--substrate-adoption-queued-2026-05-28).

## TL;DR

Swap `LiveSeries`'s internal storage from `EventForSchema<S>[]` to the
already-shipped `ColumnarRingBuffer<S>` substrate primitive (step 1h,
PR #149). Mirror the TimeSeries 2a/2b/2c integration pattern: private
`#ring` field, lazy `Event` materialization with caching, every public
method preserved. The substrate's first wiring through to the live
hot path.

Expected wins targeted by the V5 profile:
- **Drop the 22% GC self-time line at ceiling.** Old: Events stored in
  buffer for up to `maxAge`/`maxEvents` lifetime → tenured allocations →
  major GC pressure. New: Events allocated only for listener fan-out →
  immediately garbage → nursery sweep.
- **Recover some of the V5 ceiling (210k/s) toward the V1 manual baseline
  (410k/s).** Per-event allocation pressure is the structural ceiling
  on the current shape.
- **Cheaper `toTimeSeries()` snapshots.** Direct columnar→TimeSeries
  handoff via the trusted-construction `#store` channel (PR #150's
  `TRUSTED_STORE_SENTINEL` path) instead of row-shape rebuild.

**Public API consequences: zero new surface, zero removals, zero
renames. Every existing `LiveSeries` invariant preserved.** This brief's
load-bearing section is the invariants checklist (§5) — one pin-test
named per invariant.

## 1. Motivation

The V5 columnar re-bench ([pond-grpc-experiment M3.5.md V5 section](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/M3.5.md))
established two things:

1. **The substrate has matured upstream of the LiveSeries hot path.**
   Step 1 (framework — Float64Column, ColumnarRingBuffer, etc.), Step 2
   (TimeSeries integration — lazy events, column-native intake), and
   Step 3 Phase A (reducer fast path) are all merged to pond-ts main.
   But the gRPC experiment's hot path (`pushMany` → `partitionBy →
   rolling` → fanout) is unchanged — it still allocates `Event` per
   row, stores them in an array, applies retention by `splice`,
   materializes a row array for snapshot.
2. **The remaining ceiling cost is per-event allocation pressure.**
   V5 ceiling cpuprofile (P=1000 × N=1000, pond-ts 0.17.1) top lines:
   - (GC) 22.0%
   - `LivePartitionedFusedRolling.ingest` 12.9%
   - `LivePartitionedSeries.js:561` (anonymous in `_pushTrustedEvents` fan-out) 9.2%

   GC is the single largest cost line and double the next contender.
   The bisect [committed 2026-05-29](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/M3.5.md#v5-regression-bisect---what-closed-the-v8--v5-ceiling-gap-mystery)
   confirmed no actionable pond-ts regression between v0.15.2 and
   v0.17.1; v0.15.2's 21× retention-eviction speedup is load-bearing
   and the ceiling sits flat at ~210-217k/s on the current workload.

Step 7 is the structural fix that targets this line. The substrate
primitive is already in place (`ColumnarRingBuffer` from PR #149,
482 framework tests). Step 7 is the integration on top — the same
integration pattern Step 2 used for `TimeSeries`, applied to
`LiveSeries`.

## 2. The change

### Internal storage swap

**Before** (current `live/live-series.ts` lines 227–276):
```ts
export class LiveSeries<S extends SeriesSchema> {
  ...
  #events: EventForSchema<S>[];
  ...
  constructor(options) {
    ...
    this.#events = [];
  }
}
```

**After:**
```ts
export class LiveSeries<S extends SeriesSchema> {
  ...
  #ring: ColumnarRingBuffer<ColumnSchemaForSchema<S>>;
  #eventCache: Map<number, EventForSchema<S>>;  // lazy event materialization, mirrors SeriesStore
  ...
  constructor(options) {
    ...
    this.#ring = new ColumnarRingBuffer(
      schemaToColumnSchema(options.schema),
      {
        retention: this.#maxEvents === Infinity ? DEFAULT_RING_RETENTION : this.#maxEvents,
        lazyGrowth: true,
        intervalLabelKind: keyKindOf(options.schema) === 'interval' ? inferLabelKind(options.schema) : undefined,
      },
    );
    this.#eventCache = new Map();
  }
}
```

Two helpers needed:
- `schemaToColumnSchema(s: SeriesSchema): ColumnSchema` — maps the row-API
  schema vocabulary onto the framework's column-schema vocabulary. Most
  fields map 1:1; key-kind discrimination + interval label kind handled.
- `DEFAULT_RING_RETENTION` — a chosen ceiling when the caller specifies
  no `maxEvents`. Current LiveSeries supports unbounded growth via
  `maxEvents: Infinity`. The ring buffer requires a finite `retention`.
  Options for resolving: (a) pick a high default (e.g. 2^24 = 16M rows;
  the framework's MAX_COLUMN_LENGTH); (b) auto-grow the ring's retention
  on demand (extends the substrate); (c) require finite `maxEvents`
  (breaking change, rejected). Recommendation: (a) — high default that
  any reasonable workload won't hit, surfaced as a documented limit. See
  §6 open questions.

### Lazy event materialization with caching

The columnar-core RFC commits to **`at(i)` reference stability** —
`live.at(i) === live.at(i)` across calls, until eviction. This is one
of the five public-API invariants. The internal storage no longer
contains `Event` objects, so they must be materialized on first access
and cached.

Pattern (mirroring `SeriesStore.eventAt(i)` from PR #150):

```ts
at(index: number): EventForSchema<S> | undefined {
  if (index < 0) index = this.#ring.length + index;
  if (index < 0 || index >= this.#ring.length) return undefined;
  let event = this.#eventCache.get(index);
  if (event === undefined) {
    event = this.#materializeEventAt(index);
    this.#eventCache.set(index, event);
  }
  return event;
}
```

`#materializeEventAt(i)` reads the ring's columns at logical index `i`
and constructs an `Event<S>`. Cache invalidated on eviction (entries
for indices below the new head are dropped — same shape as
`SeriesStore`'s cache invalidation under `withRowSelection`).

**Critical: event identity survives eviction shift.** When retention
evicts `n` events from the head, logical index `i` (post-eviction)
corresponds to what was logical index `i + n` (pre-eviction). The
cache must remap: `for k in cache: if k < n: drop; else: cache[k - n] = cache[k]`.
This is the same logic the substrate's `withRowSelection` cache uses;
abstract into a small helper.

### Push path

```ts
pushMany(rows: ReadonlyArray<RowForSchema<S>>): void {
  if (rows.length === 0) return;
  // 1. Validate and normalize (existing path, unchanged).
  const events = rows.map(row => this.#validateRow(row));

  // 2. Apply ordering policy (existing #insert logic, but on ring).
  const accepted = this.#applyOrderingPolicy(events);

  // 3. Build a ColumnarStore from accepted events (column-native intake).
  const batch = buildBatchFromEvents(accepted, this.schema);

  // 4. Single appendBatch — substrate handles retention.
  const beforeLength = this.#ring.length;
  this.#ring.appendBatch(batch);
  const afterLength = this.#ring.length;

  // 5. Compute eviction delta + remap event cache.
  const evicted = beforeLength + accepted.length - afterLength;
  if (evicted > 0) this.#evictEventCacheBy(evicted);

  // 6. Fire listeners in the existing order (event → batch → evict).
  this.#fireEventListeners(accepted);
  this.#statsIngested += accepted.length;
  this.#fireBatchListeners(accepted);
  if (evicted > 0) this.#fireEvictListeners(evictedEvents);  // see open Q below
}
```

**Why this is the win.** The `events` array built at step 1 is
short-lived: used for ordering validation, materialized into a
ColumnarStore for ring intake, fed to listeners, then garbage-collected
(no listener retains; the ring stores column data, not Event refs).
Compared to the existing path where each Event is `#events.push`'d and
lives until eviction (potentially minutes of tenured-generation
lifetime), this is the structural fix V5's profile pointed at.

### Snapshot path

```ts
toTimeSeries(name?: string): TimeSeries<S> {
  return TimeSeries.fromTrustedStore(
    this.#ring.snapshot(),
    { name: name ?? this.name, schema: this.schema }
  );
}
```

`ColumnarRingBuffer.snapshot()` already returns a fully-formed
`ColumnarStore<S>`. The TimeSeries trusted-store factory from PR #150
adopts it directly. No row-shape rebuild. Expect material speed-up
vs current path which goes events → toRows → validateAndNormalize.

Question: `TimeSeries.fromTrustedStore` exists as a private path
through `TRUSTED_STORE_SENTINEL`. Step 7 exposes it through this
internal channel. Not a public API addition. (See §6 open Qs for the
public `fromTrustedStore` ergonomics question — orthogonal to Step 7,
deferred.)

## 3. Public API consequences — zero net change

Every method on `LiveSeries` preserved with identical signatures and
identical behavioral contracts. Enumerated below.

**Construction / lifecycle:**
- `new LiveSeries(options: LiveSeriesOptions<S>)` — same options, same throws, same defaults.
- `clear()` — empties the ring; fires `'evict'` listener with the cleared events (materialized from ring before clearing).

**Read accessors (point):**
- `at(i)` — schema-narrowed return type unchanged. Reference-stable via cache.
- `first()`, `last()` — delegate to `at(0)` / `at(length - 1)`.
- `length` getter — same.
- `graceWindowMs` getter — same.

**Read accessors (query — Tier 2 from v0.16.0):**
- `find(pred)`, `some(pred)`, `every(pred)` — iterate via `at(i)`.
- `includesKey(key)`, `bisect(key)`, `atOrBefore(key)`, `atOrAfter(key)` — binary search via `keyAt(i)` on the ring (no Event materialization needed for the search itself; only the returned event materializes through `at(i)`).

**Write:**
- `push(...rows)` — sugar over `pushMany`.
- `pushMany(rows)` — see §2 above.
- `pushJson(rows | json)` — delegates to `pushMany`.

**Exports:**
- `toTimeSeries(name?)` — see §2 above; cheaper.
- `toRows()`, `toObjects()`, `toJSON({...})` — materialize from ring as before, but via column-native paths where possible.

**Reactive composition:**
- `filter(pred)`, `map(fn)`, `select(...)`, `window(size)` → return `LiveView<S>`.
- `sample({stride})` → returns `LiveView<S>`.
- `aggregate(seq, mapping)`, `rolling(spec, opts)`, `reduce(mapping)` → return `LiveAggregation` / `LiveRollingAggregation` / `LiveFusedRolling` / `LiveReduce`.

**Stats + meta:**
- `stats()`, `timeRange()`, `eventRate()`, `count()` — same shapes.
- `on('event' | 'batch' | 'evict', fn)` — same listener contracts.
- `fill({...})` — same.

**Partitioning:**
- `partitionBy(by, opts?)` — returns `LivePartitionedSeries<S>`. **The
  partitioned variant gets its own ring buffer per partition.**

**Trusted internal path (already exists):**
- `_pushTrustedEvents(events)` — internal-only fast path used by
  `LivePartitionedSeries.#routeEvent`. Step 7 rewires this to use
  column-native `appendBatch` directly. No change to public surface;
  the underscore-prefixed name communicates "internal" per pond-ts
  convention.

## 4. Why this isn't an RFC

The columnar-core RFC ([`docs/rfcs/columnar-core.md`](../rfcs/columnar-core.md))
already committed to:

> 6. `LiveSeries` columnar ring buffer in v1.0, scoped narrowly:
>    numeric typed ring buffers for hot rolling windows + built-in
>    reducers. Strings / custom reducers / array columns / mixed
>    schemas stay event-backed inside the framework.

And to the five public-API invariants (Event identity, `at(i)`
reference stability, `at(i)` ↔ `events` consistency, `concat` event
identity, event-shaped iteration).

Step 7 is the implementation of that commitment, not a new direction.
This brief covers the integration shape — analogous to how Step 2
integration ([PR #150](https://github.com/pjm17971/pond-ts/pull/150))
landed without a fresh RFC because PR #135 had already specified the
substrate layer.

**Note on RFC scope-walk.** The columnar-core RFC's narrow scoping
(numeric-only ring buffers) was conservative — predicated on the
substrate being unproven at the time. The substrate now supports all
four value-column kinds plus interval keys (PR #149 ships
ColumnarRingBuffer with full kind coverage). Step 7 can carry all
kinds without RFC amendment, since the implementation just delegates
to whatever the substrate supports.

## 5. Invariants checklist — one pin-test per invariant

Every test name below must exist as a passing test before the PR
opens. The PR body lists these by name in an "Invariants preserved"
subsection so the reviewer can verify rather than infer.

### Five RFC-committed invariants

1. **`series.events === series.events`** — `liveSeries-invariants.events-reference-stability`
2. **`at(i)` reference stability** — `liveSeries-invariants.at-reference-stability` (calls `at(i)` twice across N=10 indices on a buffer of N=1000, asserts `===` for every pair; then pushes N=100 more rows with retention `maxEvents: 500`, asserts surviving indices still `===`).
3. **`at(i) ↔ events` consistency** — `liveSeries-invariants.at-events-consistency` (after a sequence of pushes + evictions, `liveSeries.events[i] === liveSeries.at(i)` for every i ∈ [0, length)).
4. **`concat` event identity** — orthogonal (TimeSeries-only).
5. **Event-shaped iteration** — `liveSeries-invariants.symbol-iterator-yields-events` (for-of yields the same events as `at(i)` does for every i).

### Listener fan-out

6. **`event` listener fires once per push event, in insertion order, with materialized `Event<S>` payload** — `liveSeries-invariants.event-listener-fires-per-push`.
7. **`batch` listener fires once per `pushMany` call with all accepted events** — `liveSeries-invariants.batch-listener-fires-once-per-pushMany`.
8. **`evict` listener fires with the evicted events array** — `liveSeries-invariants.evict-listener-fires-with-evicted-events` (subtle: requires the evicted Events to be materialized before they're dropped from the ring; see §6 open Q on evict-listener cost).
9. **Subscriber ordering: `event` → retention runs → `batch` → `evict`** — `liveSeries-invariants.subscriber-ordering`.

### Retention semantics

10. **`maxEvents` cap is honored** — `liveSeries-invariants.maxEvents-cap`.
11. **`maxAge` cap is honored** — `liveSeries-invariants.maxAge-cap`.
12. **Retention runs on every push** — `liveSeries-invariants.retention-runs-per-push`.
13. **Default retention is unbounded** (within `DEFAULT_RING_RETENTION` ceiling) — `liveSeries-invariants.no-retention-grows-to-default-ceiling`.

### Ordering modes

14. **`strict` mode: out-of-order events throw** — `liveSeries-invariants.strict-throws-on-out-of-order`.
15. **`drop` mode: out-of-order events silently dropped, `rejected` counter increments** — `liveSeries-invariants.drop-counts-rejected`.
16. **`reorder` mode: out-of-order events insert at sorted position via binary search** — `liveSeries-invariants.reorder-inserts-at-sorted-position`.
17. **`reorder` mode with `graceWindow`: events past grace throw** — `liveSeries-invariants.reorder-past-grace-throws`.

### Grace window

18. **`graceWindow > maxAge` rejected at construction** — `liveSeries-invariants.graceWindow-exceeds-maxAge-throws`.
19. **`graceWindow` only valid with `reorder`** — `liveSeries-invariants.graceWindow-requires-reorder`.

### Snapshot

20. **`toTimeSeries()` returns a `TimeSeries<S>` with identical events** — `liveSeries-invariants.toTimeSeries-event-equivalence`.
21. **`toTimeSeries()` is independent of the live source** — `liveSeries-invariants.toTimeSeries-snapshot-independence` (post-snapshot pushes / evicts don't affect the snapshot).

### Partitioned variant

22. **`partitionBy(by)` routes events to per-partition `LiveSeries` correctly** — `livePartitionedSeries-invariants.routing` (existing test, must still pass).
23. **Per-partition retention / ordering / grace inherits from source unless overridden** — `livePartitionedSeries-invariants.option-inheritance` (existing tests from v0.17.1 M4 fix; must still pass).

### Pipeline composition

24. **`LiveView` `filter` / `map` / `select` chain unaffected** — `liveSeries-invariants.liveView-pipeline-composition`.
25. **`LiveAggregation` / `LiveRollingAggregation` / `LiveFusedRolling` ingest from ring-backed source unaffected** — `liveSeries-invariants.rolling-from-ring-source` (numerical parity vs row-backed baseline on the same input).

### Empty / edge cases

26. **Empty buffer behaviors: `at(0)` returns `undefined`, `first()`/`last()` return `undefined`, `length === 0`, `toTimeSeries()` returns an empty TimeSeries** — `liveSeries-invariants.empty-buffer-behaviors`.
27. **`clear()` empties buffer, fires `evict`, resets `length` to 0** — `liveSeries-invariants.clear-semantics`.
28. **`pushMany([])` is a no-op (no listener fires, no stat increments)** — `liveSeries-invariants.empty-pushMany-noop`.

### Performance pin (bench-style)

29. **Per-event GC self-time at ceiling regime drops below 10%** — `bench-step7-ceiling.gc-pressure` (target: V5's 22% → ≤10%; pin in commit message, not a CI assertion).

## 6. Open design questions

These do NOT block the design pass but need a decision before the PR
body locks. Each carries a recommended default.

### Q1: Default retention ceiling when caller doesn't set `maxEvents`

Current LiveSeries supports unbounded buffer growth (`maxEvents:
Infinity`). The ring buffer requires a finite `retention`. Options:
- **(a) High default ceiling, documented limit.** E.g. 2^24 = ~16M
  rows. Any realistic workload stays below. **Recommended.**
- **(b) Substrate-extend the ring to support unbounded growth.** Adds
  complexity to the substrate; the unbounded case is rare in real
  workloads.
- **(c) Require finite `maxEvents`.** Breaking change. Rejected.

### Q2: When does the evict-listener get its Event objects?

Today: `#applyRetention` returns `EventForSchema<S>[]` of evicted Events;
`evict` listener gets that array. The Events are already in the buffer
(stored shape), so materialization cost is zero.

After Step 7: the ring stores columns, not Events. Evicting `n` rows
from the head leaves "n columns of data that nobody refs anymore."
The `evict` listener wants `EventForSchema<S>[]`. Options:
- **(a) Materialize on eviction.** Allocates Events at the moment of
  eviction. Probably fine — eviction is amortized O(1) per push but
  the per-eviction cost is 0..N (typically small). **Recommended.**
- **(b) Pass column-shape evicted data.** Breaks the `EvictListener`
  contract. Rejected.
- **(c) Pre-materialize evicted Events lazily on listener consumption.**
  Bookkeeping complex; not obviously worth it.

### Q3: `event` listener fan-out — skip Event allocation when no listeners?

Today: per-row Event allocated unconditionally for the `event`
listener fan-out, even when `#onEvent.size === 0`.

After Step 7: same. Option to optimize:
- **(a) Skip Event allocation when `#onEvent.size === 0`.** Saves
  allocation in the common gRPC case where the LivePartitionedSeries
  is the only consumer (it uses `_pushTrustedEvents` internally,
  doesn't subscribe to `'event'`).
- **(b) Always allocate.** Simpler. Maintain identical behavior
  whether listener is present or not.

**Recommended: (b) initially**, (a) as a follow-up optimization if
the bench shows it earns its complexity. Step 7's main lever is
buffer storage, not listener path. Don't conflate.

### Q4: Should the ring expose row-shape append directly, skipping the column-batch build?

The current step's `pushMany` path: events array → `buildBatchFromEvents`
→ `ColumnarStore` → `ring.appendBatch`. The intermediate ColumnarStore
allocation could be skipped if the ring directly accepted row-shape
intake.

The substrate's design (RFC V4) is "ring is column-shape, ordering-
agnostic." Adding a row-shape entry point widens its surface.

**Recommended: no.** Build the intermediate `ColumnarStore` per
pushMany; trust that V8's nursery handles it. Revisit only if bench
identifies this as material.

### Q5: Interval-keyed LiveSeries support

The substrate's ring needs `intervalLabelKind` (`'string' | 'number'`)
for interval-keyed schemas. The current LiveSeries doesn't expose this
choice; it's inferred from the runtime data.

Options:
- **(a) Infer at construction from schema introspection.** If the
  interval column has a typed-label hint, use it; else default to
  `'string'` (the more general kind) and convert if data drifts.
- **(b) Add an `intervalLabelKind?: 'string' | 'number'` option to
  `LiveSeriesOptions`.** Surfaces the choice. Public API addition.
- **(c) Defer interval-keyed LiveSeries to Step 7.5.** Numeric-only
  in v1, per the RFC's original scoping.

**Recommended: (c)** for the initial Step 7 PR — keeps scope tight.
Interval-keyed LiveSeries can carry the same internal storage swap in
a follow-up, once a real consumer asks for it.

## 7. Bench protocol

Same V4 / V5 harness — `pnpm perf` in pond-grpc-experiment. PR body
carries the V6 row of the V1→V5 table.

**Primary success criterion:**
- **GC self-time at ceiling drops from 22.0% (V5) to ≤ 10%.**

**Secondary success criteria:**
- **Ceiling rate moves materially toward V1's 410k/s.** Target: ≥ 280k/s
  (some recovery of V8's claimed one-off), stretch ≥ 350k/s.
- **`toTimeSeries()` is at least 3× faster** (per the Step 2c TimeSeries
  construction win; expect similar shape on the live side).
- **p99 latency at 78k/s improves toward V8's reported 0.16ms** (V5
  was 5.54ms; even halving moves the needle).
- **92k × 1k hosts heap moves back below V4's 1,181 MB** (V5: 1,857 MB;
  the regression hypothesized as per-partition fused-rolling state
  cost may be ameliorated by skip allocation of internal Event refs
  per partition).

**Non-regression criteria:**
- No public API behavior changes (the 28 invariant pin-tests in §5).
- No regression on `bench:aggregate` / `bench:rolling` / `bench:materialize`
  on the pond-ts side (those don't touch LiveSeries directly; safety check).
- Bundle size delta < 5 KB gzipped (likely; LiveSeries doesn't import
  new substrate code beyond what TimeSeries already pulls in).

**Bench-runner sequence in the PR body:**
1. **Pond-ts side perf:** `npm run build && cd packages/core && node scripts/perf-live-series.mjs` (new bench, mirror of `perf-timeseries-columnar.mjs` from PR #150 — push N rows, snapshot, push more, snapshot, etc.). Measures pond-only LiveSeries throughput.
2. **gRPC experiment side perf:** `cd ../pond-grpc-experiment && pnpm perf` against linked pond-ts main. The V6 bench table.

## 8. Estimated PR size + review approach

**LOC estimate:** 800-1,200 LOC across:
- `packages/core/src/live/live-series.ts` — the storage swap (~400-500 LOC modified, ~100 added for cache helpers).
- `packages/core/src/live/series-row-helpers.ts` (new file) — `schemaToColumnSchema`, `buildBatchFromEvents`, `materializeEventFromRing` helpers (~150 LOC).
- `packages/core/test/LiveSeries.invariants.test.ts` (new file) — the 28 invariant pin-tests from §5 (~600 LOC).
- `packages/core/scripts/perf-live-series.mjs` (new file) — bench harness (~100 LOC, mirror of perf-timeseries-columnar.mjs).
- Minor touches to `live/live-partitioned-series.ts`, `live/live-view.ts` if any internal paths need rewiring.

**Single PR or two?** Single PR. Storage swap + invariant tests + bench
are coherent and atomic. Splitting "swap" from "tests" creates a
half-state where the contract isn't pinned.

**Review approach:**
1. **Layer 1 self-review.** Per CLAUDE.md PR review section — read diff
   cold, especially the invariants pin-tests vs the implementation.
2. **Layer 2 adversarial agent review.** Mandatory; this PR is deep
   type-system + invariant work. Confidence will not be high.
3. **Codex adversarial pass.** Mandatory per the wave's standing rule
   (PR bodies declare invariant-preserving changes, Codex verifies).
4. **Human approval gate.** Wave standing rule: PR merges wait for human
   regardless of agent review state.

**Iteration expectation.** Plan on 2-3 review rounds before the PR
body's invariant claims are bulletproof. The 28 invariant pin-tests
are the load-bearing artifact; review will focus on whether each
test actually verifies what it claims.

## 9. What comes after Step 7

Per [PLAN.md "Next wave"](../../PLAN.md#next-wave-grpc-re-bench--substrate-adoption-queued-2026-05-28):

- **Phase C re-adoption** (gRPC experiment bumps to Step-7'd pond-ts,
  produces V6 bench, dashboard agent joins for second-consumer
  validation on the React `useSnapshot` / `useLiveQuery` path).
- **Step 3 Phase C** (rolling fast path) as the next library lever
  if V6 shows the `LivePartitionedFusedRolling.ingest` 12.9% line
  is now the dominant remaining cost.

Step 7's success defines the gating criterion for Step 3 Phase C: if
GC drops below 10% AND ceiling moves materially, Step 3C is earned by
the remaining per-event reducer-state cost. If GC doesn't drop, Step 7
needs a follow-up before Step 3C earns its slot.

## 10. Status

**Awaiting human review.** Once approved, the implementation pass
begins with:
1. Create branch `feat/step-7-live-series-ring`.
2. Land the helpers + storage swap + invariant pin-tests as a single
   PR.
3. Run pond-ts perf + gRPC V6 bench; report both in the PR body.
4. Open PR for Layer 2 + Codex review + human approval.

No code begins until this brief gets a green light.

---

**Cross-references:**

- [`PLAN.md` Phase 4.7 "Next wave"](../../PLAN.md#next-wave-grpc-re-bench--substrate-adoption-queued-2026-05-28)
- [`docs/rfcs/columnar-core.md`](../rfcs/columnar-core.md) — binding RFC for the wave; locked-in commitment #6 names this step.
- [`pond-grpc-experiment/friction-notes/columnar-rebench.md`](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/columnar-rebench.md) — experiment-side binding plan.
- [`pond-grpc-experiment/friction-notes/M3.5.md` V5 section](https://github.com/pjm17971/pond-grpc-experiment/blob/main/friction-notes/M3.5.md) — the V5 findings + bisect that motivate Step 7.
- [PR #149](https://github.com/pjm17971/pond-ts/pull/149) — `ColumnarRingBuffer` substrate (already shipped).
- [PR #150](https://github.com/pjm17971/pond-ts/pull/150) — Step 2a/2b TimeSeries integration; analogous shape Step 7 mirrors.
- [PR #151](https://github.com/pjm17971/pond-ts/pull/151) — Step 2c column-native intake; the snapshot fast-path pattern Step 7 leverages.
