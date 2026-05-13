# Friction note: columnar conversion — transforms

**For:** pond-ts core maintainers, Phase 4.7 substrate work.
**From:** investigation agent (Claude), 2026-05-13.
**Scope:** `select`, `rename`, `collapse`, `asTime`/`asTimeRange`/`asInterval`, `diff`/`rate`/`pctChange`/`cumulative`/`shift`, `filter`, `map`, `fill`, `smooth` (ema/movingAverage/loess), plus their `LiveView` counterparts.
**Reading basis:** `TimeSeries.ts` (1009–1090, 1929–2482, 3063–3346, 3358–3692, 3717–3763), `LiveView.ts`, `Event.ts`, `core-columnar-store-spike.md` Phase 3. Not read: `columnar-core.md`.

---

## 1. Operators investigated

- **Schema-rewriting** (`select`, `rename`, `collapse`, `asTime`/`asTimeRange`/`asInterval`): all build a new `Event[]` via `.events.map(...)` + `#fromTrustedEvents`.
- **Column-appending** (`diff`, `rate`, `pctChange`, `cumulative`, `shift`): `events.map(...)` with `new Event(key, {...data, [col]: ...})` per row. Every event shallow-spread regardless of how many columns actually change.
- **`filter`:** retains source `Event` references via `Array.filter` + trusted construction. No cell copy.
- **`map`:** `events.map(fn)` then _renormalized_ through `toRows(...)` + `new TimeSeries({...})` — only operator paying public-constructor validation on output.
- **`fill`:** **already columnar internally.** Builds `columns: Record<name, ScalarValue[]>` + parallel `times: number[]`, per-column gap sweep with all-or-nothing limit / maxGap, synthesizes events at the end.
- **`smooth`:** all three methods extract `anchors: number[]` + `sourceValues: (number|undefined)[]` up front, compute a scalar `resultValues` array, walk back to events.
- **`LiveView`:** per-event `process(event) => Event | undefined` closures over running state. Buffer is `EventForSchema[]`. Output events allocated one at a time.

---

## 2. Transform-chain composition (the central question)

**Today** every chain link allocates a fresh `Event[]` of length N: walk source `events`, pull `event.data()` per row, spread into `{...data, [col]: ...}`, allocate frozen `Event`, hand to `#fromTrustedEvents`.

**Under columnar this becomes a buffer-sharing problem.** Sketch:

- `ColumnarStore<S>` exposes per-column `Column<T>` handles. A `Column` is either a **base buffer** (typed array + optional validity bitmap) or a **view** (`{source, slice?, indices?, rename?}`).
- A derived store is a new schema + `ReadonlyMap<name, ColumnHandle>`; most handles point back at base buffers. **Allocation only for columns the transform actually computes.**
- `#fromTrustedStore(...)` replaces `#fromTrustedEvents`. Zero-copy.

`series.diff('cpu').fill('hold').rolling('5m', m)`:

- `diff('cpu')`: new `Float64Array` + validity bitmap for `cpu`. Other columns shared.
- `fill('hold')`: rewrites `cpu` again (one new buffer + bitmap); others still shared.
- `rolling(...)`: reads filled `cpu` directly. Spike-validated 6–12× on numeric scans.

**Total chain allocation cost: two `cpu` rewrites** — not three full event arrays. **Derived series do not have to compact eagerly.** They compact only changed columns.

Eager compaction is needed only in: (1) `map` with a user closure (§8); (2) materializing public `Event` instances at the API boundary — one realloc per row, the cost of preserving `series.events`; (3) crossing into a non-substrate adapter (JSON, Arrow). All bounded by call site, not by composition depth.

---

## 3. Per-operator-family conversion path

- **`select` / `rename`:** schema-metadata-only. New store with a subset / renamed handle map; columns shared. **Effectively free.**
- **`collapse`:** allocates one new column (reducer output); drops or appends others. Same algorithmic work minus per-event spread. **Parity-or-better.**
- **`asTimeRange` / `asTime({at:'begin'})`:** metadata-only on already-`(begin,end)`-keyed sources. `asTime({at:'center'|'end'})` allocates a new `beginMs` typed array. `asInterval` allocates an interval-values column (dictionary-encoded for small label sets). **Parity-to-clean-win.**
- **`diff` / `rate` / `pctChange` / `shift` / `cumulative`:** tight loop over source `Float64Array`, write to target `Float64Array` + bitmap. No `event.data()`, no spread, no per-row alloc. **Clean win** — extrapolating from the spike's 6–12× whole-column reduce.
- **`filter`:** (a) **index-selection view** (shared base columns + `Int32Array indices`) or (b) **eager compaction**. Recommend (a) by default with `compact()` when selectivity > ~50%, index-view depth > ~3, or downstream is a tight numeric scan. **Clean win on low selectivity, parity on high.**
- **`fill`:** direct port — already column-shaped. Validity bitmap replaces `=== undefined`. `'linear'` is the same lerp over `Float64Array`. **Cleanest port in scope.**
- **`smooth('ema')`:** single-pass accumulator over typed source → new typed array. **Clean win.**
- **`smooth('movingAverage')`:** two-pointer monotonic walk with running sum/count, already O(N). Typed-array version drops the per-row property hop; centered alignment isn't complicated by columnar. **Clean win.**
- **`smooth('loess')`:** binary search into anchors + weighted regression over a neighborhood. Already operates on numeric arrays (`loessAnchors: number[]`, `loessValues: number[]`); direct port to `Float64Array` is **parity-to-modest-win**. The brief's worry doesn't materialize.

---

## 4. Framework primitives needed

```ts
// Read
Column.read(i): T | undefined
Column.scan((value, i) => …)
Column.sliceByIndices(indices: Int32Array): Column   // index-view, no alloc
Column.sliceByRange(start, end): Column              // range-view, no alloc

// Write (returns a new owned Column)
Column.derive<U>(name, kind, writer: (out, source) => void): Column

// Store
Store.withSchema(schema): Store                       // metadata-only (rename, drop)
Store.withColumnsRenamed(map: Record<string, string>): Store
Store.withColumnReplaced(name, col: Column): Store    // for diff/rate/cumulative/shift/fill/smooth
Store.withColumnAppended(name, col: Column): Store    // for smooth({output}), collapse({append: true})
Store.withRowSelection(indices: Int32Array): Store    // for filter; defers compaction
Store.materialize(): Store
Store.materializeColumn(name): Column

// Key columns
KeyColumn.asTime(at: 'begin'|'center'|'end'): KeyColumn
KeyColumn.asTimeRange(): KeyColumn
KeyColumn.asInterval(values: Column<string|number>): KeyColumn

// Event boundary (already in spike Phase 2.5)
Store.eventAt(i): Event
Store.eventArray(): readonly Event[]
```

Validity bitmaps (`Uint8Array`) are load-bearing — every numeric column needs them to round-trip `undefined` cells through the public Event API without per-cell boxing.

---

## 5. Clean wins (estimated)

- **`select` / `rename`, `asTimeRange`, `asTime({at:'begin'})`:** O(N) → O(1) metadata. **>100×.**
- **`fill`:** algorithm already column-shaped; the win is dropping the per-row spread and `new Event` at the end. Cf. spike's 34× on `toChartBuffer` (same pattern). **2–4×.**
- **`diff` / `rate` / `pctChange` / `shift` / `cumulative`:** drop `event.data()` per row _and_ output `new Event` alloc. **5–10×** on numeric paths.
- **`smooth('ema')`, `smooth('movingAverage')`:** typed-array loop vs. event walk. **~5×.**

Higher-confidence numbers need `perf-columnar-transform-chain.mjs` (suggested in spike, not yet run).

## 6. Neutral parity

- **`smooth('loess')`:** algorithmic cost dominates; typed-array constants help, big-O unchanged.
- **`collapse` with custom reducer:** reducer-call cost dominates.
- **`asTime({at:'center'|'end'})`, `asInterval`:** one new column allocation each.
- **`filter` on high-selectivity predicates:** indirection vs. compacted store. Auto-tune at materialize boundaries.

## 7. Regression risk + mitigations

- **`map` (user closure)** — see §8.
- **Stacked filter chains** create triple-indirection. Auto-materialize when depth exceeds threshold or downstream is a tight numeric scan.
- **`Event` reference identity:** today `series.filter(p).events[0] === source.events[i]` holds. Under columnar, lazy-materialized events are new objects. Mitigation: spike's Phase 2.5 per-index cache + a trust hand-off — `filter` carries forward materialized events by index.
- **Pass-through columns in numeric derivatives:** `diff('cpu')` on a series with `string`/`array` columns must share, not copy them. Handled by `withColumnReplaced`.
- **`collapse({append: true})` after a renamed/selected upstream:** view-store schema-tracking must propagate. Pin in tests.

---

## 8. Public Event API cost — the `map` problem

`map(schema, fn)` takes an opaque user closure returning `Event`. The substrate cannot route through typed-array math.

**(a) Materialize per event, run `fn`, write back per column.** N event materializations + N `Event.set`/`merge` spread-copies. **Parity with today.**

**(b) Add `mapColumn(name, fn)` — scalar transform on one numeric column.** Strict subset of `map`; covers the common case ("multiply `cpu` by 100", "cap to [0,1]"). Substrate routes through typed-array transform. **Clean win** on the column-shaped majority of `map` calls.

**(c) Keep `map` event-backed inside the substrate.** Don't try; result built via `new TimeSeries(...)` like today. **Parity** — today's floor.

**Recommendation: (b) + (c) together.** No semantic loss, no API regression, clean win where it's achievable.

Note: internal operators in §3 should not go through `Event.set`/`merge`/`withKey` (which all allocate); they should write into store columns directly via a private build path.

---

## 9. Knowns and unknowns

**Known:** `fill` is mechanically column-shaped; the numeric derivatives are pure column scans; schema-only operators are O(1); `ema`/`movingAverage` port cleanly.

**Unknown without prototyping:**

- V8 cost of `Int32Array`-indirected column reads — drives the filter compaction policy.
- Whether `Column<T>` is a polymorphic interface or operators dispatch on kind once up front. Spike's existing `ColumnBuffer` discriminated union favors the latter; needs validation under V8.
- LiveView under columnar. The `process(event) => Event` shape fights typed-array ring buffers. Likely a separate sub-spike; gating Phase 4.7 on it would expand scope materially.
- `collapse` with non-scalar reducer outputs (array-valued reducers) — verify array-column representation handles it.

---

## 10. Recommendations

1. **Treat §4 as the framework's transform-side surface.** Operator impls in `TimeSeries.ts` should be thin shells over these primitives — `Store.withColumnReplaced(name, sourceCol.derive(...))` plus the math.
2. **Port `fill` first.** Already column-shaped, largest single-operator win, exercises the validity-bitmap design as the gap detector. Best design driver.
3. **Bundle the numeric derivative quintet** (`diff`/`rate`/`pctChange`/`cumulative`/`shift`) into one PR. Shared template; coherent test surface.
4. **Defer `filter` compaction policy** to a measurement-driven follow-up. Both modes must work; the auto-tune heuristic needs benches.
5. **Add `mapColumn(name, fn)` as a new method.** Don't replace `map`. The split is principled and matches the substrate's "preserve the API, optimize the hot path" thesis.
6. **Don't redesign `LiveView` in this work.** Live's per-event closure model needs its own spike.

**Headline:** transform chains compose cleanly under columnar. The hard question (eager compaction or buffer sharing?) resolves to **share by default**, compact only at the materialization boundary and as a selectivity-driven choice on `filter`. `map`'s opacity is bounded — `mapColumn` covers the column-shaped majority, the original `map` stays event-backed at parity. **`loess` does not fight columnar.** The clean wins from `fill`, the numeric derivative quintet, `smooth('ema'|'movingAverage')`, and the schema-only operators align with the spike's measured pattern.
