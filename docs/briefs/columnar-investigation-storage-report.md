# Investigation: columnar conversion — storage + access core

**For:** pond-ts framework-layer design.
**From:** fresh investigation agent (Claude), 2026-05-13.
**Scope:** `TimeSeries` construction, public `Event` API, lazy event
materialization, the five public-API invariants.

## 1. Operators investigated

- `TimeSeries.ts`: constructor (L858), `#fromTrustedEvents` (L949),
  `events` field (L676), `at`/`first`/`last` (L992–L1006), `length`
  (L4000), `Symbol.iterator` (L4005), `toArray` (L4019),
  construction paths `fromJSON`/`fromEvents`/`concat`/`fromPoints`
  (L731, L773, L820, L4319), export paths `toRows`/`toObjects`/
  `toJSON`/`toPoints` (L975–L988, L892, L4044), plus `bisect`/
  `atOrBefore`/`atOrAfter` (L3445–L3490).
- `Event.ts`: full API including `get`/`set`/`merge`/`select`/
  `rename`/`collapse`/`withKey`/`data`/`key`/temporal predicates/
  `toRow`/`toJsonRow`.
- `validate.ts`: `validateAndNormalize` (row-major outer loop, one
  `new Event` per row); cross-referenced against
  `LiveSeries.#validateRow` (L1086 of `LiveSeries.ts`).
- `types.ts`: `SeriesSchema`, `ScalarKind`, `ColumnValue`,
  `EventForSchema<S>`, `RowForSchema<S>`.

The spike (`core-columnar-store-spike.md`, Phases 1–2.5) provided
measured evidence; I trust those numbers rather than re-measuring.

## 2. Likely conversion path

**Constructor.** Keep `validateAndNormalize`'s row-major outer loop;
swap the inner `new Event(key, data)` for column-builder appends.
Finish the store into immutable typed buffers; release input rows
for GC. Eliminates per-row `Object.freeze({...data})` and `new Event`
until something asks. Spike measured construction 382ms → 71ms on
1M rows.

**`#fromTrustedEvents` (the trusted factory).** Hit by every derived
operator. Two viable shapes: (1) walk the trusted `Event[]` and copy
payloads into typed columns; (2) parallel `#fromTrustedStore` that
operators with already-columnar output (planned aggregate, future
columnar `filter` / `select`) call to skip the `Event→column` round-
trip. Build path 1 first to preserve invariant 4 cleanly, then add
path 2 incrementally.

**`events` getter.** Cached materialization on first access; once
materialized, the array is frozen and the per-index cache is dropped.
Pinned in spike Phase 2.

**`at(i)`/`first()`/`last()`/iteration.** Materialize one `Event`
from the store on demand. A per-index `Map<number, Event>` cache
preserves reference stability across repeated calls without forcing
the full array.

**Export paths.** One-pass column walks that assemble row/object/
JSON output directly — no intermediate `Event` materialization. For
`toPoints`, spike measured 200ms → 0.33ms on 1M rows for copied
chart-buffer mode; row-object `toPoints` keeps the per-row object
allocation but skips `Event` construction.

**`Event` API, three classes:**

- **Pure reads (`get`/`data`/`key`/`begin`/`end`/`type`/`timeRange`):**
  unchanged. Once the `Event` exists, payload is a plain frozen
  object.
- **Pure-temporal predicates (`overlaps`/`contains`/`trim`/`asTime`
  / etc.):** key-only, no payload touch.
- **Functional rewrites (`set`/`merge`/`select`/`rename`/`collapse`
  /`withKey`):** leave alone. Build new frozen payload object, return
  new `Event`. A lazy-column-override wrapper would break `Event`'s
  private-field identity (called out in the spike's risks section).

## 3. Primitives needed

- `ColumnarStore.fromValidatedRows(schema, rows)` — constructor.
- `ColumnarStore.fromTrustedEvents(schema, events)` — `#fromTrustedEvents`.
- `store.length: number`.
- `store.eventAt(i): Event` — lazy materialization with internal cache.
- `store.toEvents(): Event[]` — full materialization, reuses
  `eventAt` cache.
- `store.keyAt(i): EventKey` / `store.beginAt(i)`: number /
  `store.endAt(i)`: number — for `bisect`/`timeRange`/`before`/`after`
  without materializing events.
- `store.column<K>(name)`: typed-array-backed read-only view.
- `store.toRows()/toObjects()/toJSON()/toPoints()` — store-native
  exports the `TimeSeries` methods delegate to.
- `store.slice(start, end)`: zero-copy view, falling back to compact
  when ownership is needed.
- Internal `EventKey` wrapper cache so `keyAt` and `eventAt` return
  identical key instances at the same index.

## 4. Clean wins

- **Constructor allocation** — no per-row `Object.freeze`/`new
Event`; ~5× on 1M rows from the spike.
- **`toPoints` / chart extraction** — 34×–1000× depending on copy
  mode; row-object `toPoints` still allocates per-row but skips
  events.
- **`toJSON`/`toRows`/`toObjects`** — one column-walk per output row
  instead of "event walk → data() → serialize". Modest, compounds
  with constructor savings for build-then-serialize workflows.
- **`length`/`first()`/`last()`** — `store.length` / single-index
  materialization; lazy series pays nothing extra.
- **`bisect`/`includesKey`/`atOrBefore`/`atOrAfter`** — reads
  `store.beginAt(mid)` directly from a Float64Array instead of going
  through `events[mid]!.key().compare(...)`. Small but real, hits the
  hot path on `align(linear, cursor)` which `bisect`s per anchor.

## 5. Neutral parity

- **`Event` API methods themselves** — once an event exists, they're
  plain JS object work.
- **`Symbol.iterator`** — forced to allocate one `Event` per step
  under any substrate. Incremental rather than upfront-array.
- **`fromEvents`/`concat`** — sort is keys-only and cheap, but the
  result must populate the store from trusted events (same
  `Event→row→column` walk we eliminated elsewhere). Neutral at worst;
  source `Event` references stay live for invariant 4.

## 6. Regression risk

- **Single-event materialization cost.** `series.at(5)` becomes a
  column-walk instead of an array read. A chart hover handler hitting
  `at(i)` dozens of times per frame would pay per-call.
  **Mitigation:** the per-index `Map<number, Event>` cache (proven in
  spike Phase 2.5) absorbs repeated access. Worth a chart-hover
  micro-benchmark before merge.
- **Small-series workloads.** Spike wins all show up at 100k+ rows.
  Below ~1k events, the typed-array/validity-bitmap setup cost likely
  loses to plain `Event[]`. The spike doesn't tell us how steep the
  small-N curve is. **Mitigation:** either accept it (real hotspots
  are large series anyway) or keep an event-backed fast path for very
  small series at the substrate boundary. Flagged as an unknown.
- **`Event.set`/`merge`/`select`.** Can't get faster — payload
  materializes exactly when called. Retains a strong reference to a
  now-materialized event, defeating "lazy series, never touched
  events" optimizations. **Mitigation:** none needed; callers using
  these are explicitly opting into row-shape work.
- **Validation error-message contract.** "Per-column validation"
  would break the row/col coordinates and reorder which error fires.
  **Mitigation:** keep the row-major outer loop; only swap the inner
  `new Event` for column-builder appends. Per-column validation is
  not observable from the public API, and row-major intake is fine
  for cache locality.
- **`concat` invariant cost** — see §7.

## 7. Public-API-invariant costs

1. **`series.events === series.events` after first access.** Cached
   frozen array; trivially preserved. Already pinned.
2. **`at(i)` returns the same instance across calls.** Per-index
   `Map<number, Event>` cache. Cost: one map entry per uniquely-
   asked index. Spike measured ~0 MB delta for casual access. Cleared
   on full `events` materialization.
3. **`at(i)` ↔ `events` consistency.** Full `events` materialization
   reuses cached `Event` instances from the per-index cache and fills
   the rest. One extra length-N pass on first `events` access if any
   indices were touched. Acceptable.
4. **`concat` preserves source `Event` identity.** Locked-in commitment
   (PLAN). The result store keeps the source events strongly
   reachable; framework needs `#fromTrustedStore` (or
   `#fromTrustedEvents`) to optionally carry a pre-populated event
   cache. **This is the most subtle invariant** — call it a load-
   bearing footgun. Today the contract is automatic (events live in
   `Event[]`). Under columnar, the framework expresses "carry forward
   the source caches" explicitly: events already materialized on either
   input retain `===`; events never touched on either input go through
   fresh materialization and lose `===`. That matches current
   semantics in practice — today, every event has been materialized,
   so identity is universal. The columnar version makes the boundary
   visible. Worth pinning in tests across both touched and never-
   touched indices.
5. **Event-shaped iteration.** Calls `store.eventAt(i)` per step with
   cache reuse. Same cost as invariant 2.

The new `series.eventAt(i)` accessor (per PLAN) is the "explicit
stable reference" escape hatch — always caches. `at(i)`'s cache is
"don't re-allocate three times if the chart calls thrice" rather
than a hard contract.

## 8. Knowns / unknowns

**Knowns:** numeric reducer win, lazy-materialization memory win,
chart extraction win — all measured and stable. Invariants
preservable via the per-index cache, pinned in spike Phase 2.5. The
`Event` API doesn't fundamentally change.

**Unknowns to measure before merge:**

- Small-N construction curve (sweep N from 10 to 100k for `fromJSON`).
- Hot single-event-touch micro-benchmark (`at(i)` in a 10k-iter loop,
  varying cache hit rate).
- `concat` carrying forward source caches at scale — memory and
  construction time both.
- `EventKey` instance reuse across `keyAt`/`eventAt`. Affects key-
  comparison-heavy operators (`align(linear)`, `bisect`-driven paths).

## 9. Recommendations

1. **Row-major outer loop stays in validation.** Swap only the inner
   `new Event` for column-builder appends. Preserves the error-message
   contract and intake cache locality.
2. **`eventAt(i)` with internal key+event cache is the core
   primitive.** Don't introduce an `EventView` class — the private-
   field problem makes structural compatibility impossible without an
   API break.
3. **`#fromTrustedEvents` keeps its current signature.** Add a
   parallel internal `#fromTrustedStore` that columnar-native
   operators call to skip `Event→column` round-trips.
4. **`concat` carries forward source event caches.** Build the result
   store + a pre-populated cache map from inputs' caches. Pin
   identity in a test covering both already-touched and never-touched
   indices.
5. **Export paths become store-native one-pass walks** — no
   intermediate `Event` materialization for `toRows`/`toObjects`/
   `toJSON`/`toPoints`. Quiet ~30% win on `toJSON` for build-then-
   serialize workflows (no measurement yet, but per-row `Event`
   allocation savings are real).
6. **Surface `series.eventAt(i)` as the explicit-identity accessor.**
   Document `at(i)`'s cache as best-effort optimization.
7. **Cache `EventKey` wrappers inside the store.** Build the `Time`/
   `TimeRange`/`Interval` once per touched index and reuse across
   `keyAt`/`beginAt`/`eventAt`. Compounds in key-heavy operators.
8. **Add `perf-storage-access.mjs`** before the TimeSeries-integration
   step lands. Existing spike scripts don't cover hot single-event-
   touch or the small-N regression floor.
