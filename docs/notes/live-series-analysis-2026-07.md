# LiveSeries analysis & forward plan — July 2026

Complete analysis of the live buffer (`LiveSeries` + its two storage
backings), with the columnar adoption question settled empirically.
Conducted 2026-07-02 against `main` at v0.35.0 by the Pond technical
consultant agent (Claude). The brief: decide whether to keep or
**unroll** the chunked-columnar live backing, and either way find the
memory/hot-path improvements needed before finalizing this code as
pond's best-effort live streaming layer.

**Method.** Three tracks: (1) first-hand read of the storage core
(`live-series.ts`, `live-chunked-storage.ts`, `live-storage.ts`);
(2) a stakes inventory — every consumer of the chunked path, every
behavioral divergence between backings, the full walkback history;
(3) a fresh 19-scenario benchmark grid against the built v0.35.0 dist
(ingest × batch size, listener tax, snapshot cadence, rolling
downstream, retained heap, GC churn, CPU profiles, eviction stress —
median-of-5, ratios primary, `--expose-gc`; scripts + raw
`results.jsonl` + `.cpuprofile`s at `/tmp/live-bench/`, per-machine).

---

## 0. Verdict

**Keep the chunked backing. Do not unroll. But fix the two
implementation gaps that make it look like a mixed bag, then
consolidate and declare the layer done.**

The data splits cleanly: on **batched** ingest — the case chunked was
built for — it wins everything (4–12× ingest, 5.1–5.4× less retained
memory, 18× less GC pause, and it _stays_ ahead with listeners
attached, rolling accumulators downstream, and eviction storms). On
**per-event** ingest and **per-frame snapshots** it loses — and both
losses are implementation gaps with in-repo fixes already sketched,
not architecture.

The deeper finding reframes the "complex tradeoffs the user couldn't
really make": **auto-selection keys on schema and ordering
(strict + time-keyed → chunked), but the property that actually
determines which backing wins is ingest batch size — which the
selector never sees.** A gRPC server pushing 1,000-row batches lands
on the happy path; a browser telemetry app pushing per-event on the
default config silently gets the worst of both worlds. Fix that
mismatch and the hidden tradeoff dissolves — the user never needs to
know two backings exist.

---

## 1. Architecture at HEAD (first-hand read)

The dual path is narrower than the June audits implied:

- **Reads, eviction, and snapshots are already unified** behind one
  `ReadableLiveStorage` interface (`live-storage.ts:68`) — only the
  append/fan-out path branches on `#chunked` vs `#perRow`
  (`live-series.ts:229–234`, `:482–485`).
- **The chunked backing is itself a row/column hybrid**: committed
  `ColumnarStore` chunks behind a row-tuple **pending tier**
  (flush threshold 256, `live-chunked-storage.ts:153–158`) that the
  gRPC-V7 wave added to fix thin partition scatter (one chunk per
  slice was 23.5× the object count).
- **Event materialization is listener-conditional**: with no row
  listeners, the chunked path creates zero `Event` objects end to end
  (`live-series.ts:649–651`); the partition router consumes
  column-native deltas via the internal `#onChunk` channel
  (`:640–643`).
- **Selection is invisible and internal**: `__backing` is `@internal`,
  absent from the public d.ts; no user code or docs depend on it.
  React hooks and `LiveView.column()` are backing-agnostic.
- **Known divergences**: commit granularity (whole-chunk vs per-row —
  now documented in `pushMany`'s JSDoc, an audit-v2 finding
  addressed); the June-audit listener hazards (no error isolation,
  undefined re-entrancy) remain open on **both** paths.

The critical structural gap found in the read, later quantified by the
bench: `push(row)` is a wrapper over `pushMany([row])`, and
`#pushManyColumnar` commits **every batch as a chunk with no minimum
size** (`live-series.ts:533–545` → `#commitChunk`) — the pending tier
is wired only to the partition-routing `_stageRows` path. Per-event
push on a chunked series = one 1-row `ColumnarStore` (+ key column +
four 1-element `Float64Array`s + a column `Map`) per event. The code's
own comment records the assumption: "in practice a storage uses either
`appendStore` — the source's big batches — or `stageRows`"
(`live-chunked-storage.ts:221–225`). The default config violates the
assumption silently.

---

## 2. The numbers (v0.35.0, Apple M4 Pro, node 22; ratio > 1 = chunked better)

| Scenario                                 | chunked                           | array               | ratio                                     |
| ---------------------------------------- | --------------------------------- | ------------------- | ----------------------------------------- |
| A1 per-event push, 500k                  | 9.4k evt/s                        | 12.8k evt/s         | **0.73× — array wins; both pathological** |
| A2 pushMany(10)                          | 451 ms                            | 4,614 ms            | **10.2×**                                 |
| A3 pushMany(100)                         | 48.7 ms (10.3M evt/s)             | 570 ms (877k evt/s) | **11.7×**                                 |
| A4 pushMany(1000)                        | 36.3 ms                           | 154.8 ms            | **4.3×**                                  |
| B1–B3 A3 + event/batch listeners         | ~121 ms                           | ~559 ms             | **4.6×**                                  |
| C1 snapshot per frame (50k window)       | 9.15 ms/frame                     | 7.49 ms/frame       | **0.82× (array wins)**                    |
| D A3 + rolling('1m', avg)                | 230 ms                            | 581 ms              | **2.5×**                                  |
| E1/E2 retained, 50k/200k window          | 43.9 / 42.2 B/evt                 | 225.7 / 226.7 B/evt | **5.1–5.4×**                              |
| E3 200k + string column                  | 46.9 B/evt                        | 250.7 B/evt         | **5.3×**                                  |
| F GC pause during A3                     | 1.91 ms (5 GCs)                   | 34.78 ms (20 GCs)   | **18.2×**                                 |
| G 20s sustained mixed                    | 452k evt/s                        | 412k evt/s          | 1.10× (≈noise)                            |
| H evict stress (490k evictions)          | 126 ms                            | 171 ms              | **1.36×**                                 |
| **A1-mem: 100k window filled per-event** | **1,634.8 B/evt, 100,000 chunks** | 226.0 B/evt         | **0.14× — array 7.2× leaner**             |
| A1-mem fill time                         | 3,595 ms                          | 25.9 ms             | ~0.007×                                   |

Cross-backing sanity held everywhere (identical rolling values to full
float precision, identical eviction counts and final lengths).

**Refining the June claim.** The stakes inventory suggested the heap
win was "conditional on zero listeners." The bench splits that
correctly: the **retained-memory win (5.1–5.4×) is unconditional** —
listeners only create transient young-gen Events; retention is what's
retained. What _is_ conditional is the **churn** advantage: listener-
free ingest sees an 18× GC-pause win, but in the mixed dashboard
profile (listener + per-frame snapshots) chunked's GC share was 33.1%
vs array's 23.5% — transient materialization plus snapshot garbage
swamp it.

### Where the CPU actually goes (profiles, mixed workload)

1. **`toTimeSeries()` is the shared #1 cost under dashboard cadence —
   ~35–40% of CPU on both backings** — and it does double work:
   `snapshot()` materializes every retained row (chunked: per-cell
   `valueAt` Map lookup + `new Time` per row; array: per-cell
   `event.get`), then the validating `TimeSeries` constructor
   **re-validates data the buffer already validated at ingest**. The
   chunked storage carries a comment deferring the columnar fast-path
   snapshot because "snapshot isn't the hot path"
   (`live-chunked-storage.ts:367–370`) — under per-frame cadence it is
   _the_ hot path, and it is the entire reason array wins scenario C.
   `LiveSeries` also never received the mutation-counter snapshot
   memoization `LiveView` got in #180.
2. **Array retention is a memmove machine**: `dropPrefix` (splice) is
   **29.2% of array self-time** (`live-storage.ts:116`), O(window) per
   batch — this single function explains the array A-series collapse
   as batches shrink.
3. **Chunked has an O(chunks) term on every push**: the cross-batch
   order check calls `beginAt(length−1)` → `#locate`'s linear chunk
   scan (`live-chunked-storage.ts:287`; callers
   `live-series.ts:574,623`) — invisible at batch=100 (0.5%),
   catastrophic at batch=1 (100k one-row chunks → 53 s).
4. Smaller: `valueAt` re-does a `columns.get(name)` per cell (7.8%);
   `LiveRollingAggregation` allocates a full `value()` result per
   ingested event even with zero `'update'` subscribers
   (`live-rolling-aggregation.ts:292`); chunked `evictPrefix`
   materializes evicted rows _through the Event cache_ it then
   immediately remaps.

---

## 3. The unroll option, weighed honestly

What unrolling would buy: one `pushMany` path (~10 LOC of branching +
~179 chunked-only LOC in `live-series.ts` + the 464-line
`live-chunked-storage.ts` + ~60 tests removed); one commit-granularity
story; no lazy Event cache + eviction remap; a smaller surface for the
listener-hazard fixes.

What unrolling would forfeit, all measured:

- **The partition-routing wins** (v0.20 / PR #175): 60× fewer stores,
  −99.4% Event retention, +24% sustained throughput at 256 partitions.
  The `_onChunk` column-native channel and the coalescing tier die
  with the backing; every partition reverts to per-event `Event[]`
  feeding. This was shipped as an **OOM fix** — unrolling reopens the
  OOM class.
- **4–12× batched ingest and 5× retained memory** on the default
  config for any batched source (wire snapshots, `pushJson` batches,
  the gRPC shape).
- **The substrate for Live §A / columnar rolling** (the
  columnar-live-protocol RFC's direction) — Step-3C-style live
  reducers would consume chunks; rebuilding the storage later means
  re-litigating everything Step 7 already taught.

And the history cuts both ways but lands on keep: the Step-7
**per-event columnar ring buffer** was correctly walked back
(9.4× slower, _more_ heap — `docs/briefs/step-7-live-series-ring-buffer.md`
§13), because a per-event columnar buffer decomposes Events the
consumer forces into existence anyway. The chunked backing is the
surviving design precisely because it is **batch-granular** — it only
loses when fed like the thing that was already falsified. The bench's
A1 result is Step 7's lesson resurfacing through the selection gap,
not new evidence against chunked.

**Rejected: unroll.** Also rejected: exposing `__backing` as a public
knob — the north star says users shouldn't carry a tradeoff we can
make evaporate.

---

## 4. Recommended plan

Sequenced so correctness lands before optimization, every perf step
carries the CLAUDE.md discipline (complexity note + perf script +
before/after table), and the layer earns "finalized" status at the
end. Estimated as 6 small PRs; nothing here changes public API.

### Phase 1 — Robustness first (backing-independent, blocks "finalized")

The empirically reproduced audit hazards must not survive into a
finalized layer, and fixing them _first_ means every later phase is
protected by the shared machinery:

1. **Listener error isolation + re-entrancy contract** — one shared
   fan-out driver used by both append paths (snapshot the listener
   set, per-listener try/catch with an error surface, documented
   re-entrancy semantics). This also collapses the two fan-out
   sequences into one place, addressing audit §1.5's divergence risk
   at the same time.
2. **Chain-aware `LiveView.dispose()`** and a `maxPartitions`
   option/warning on `LivePartitionedSeries` (audit §§1.3–1.4) —
   same wave, same files.

### Phase 2 — Kill the auto-selection footgun (the A1/A1-mem fix)

3. **Route sub-threshold `pushMany` batches through the existing
   pending tier** (threshold = the existing `flushThreshold` 256)
   instead of committing 1-row chunks. Per-event `push()` then
   accumulates row tuples and compacts every 256 events — array-class
   or better ingest, ~45 B/event retained instead of 1,635. The tier,
   its ordering contract, and its flush mechanics already exist and
   are production-tested by the partition router.
4. **O(1) last-key cache** on the chunked storage (drop the
   `beginAt(length−1)` → `#locate` linear scan from every push).
   Together, 3+4 target: A1 from 53 s → ≤ array, A1-mem from 0.14× →
   ≥ 1×. **Gate: re-run the grid's A/E scenarios; chunked must be
   ≥ array on every ingest pattern before Phase 3 starts.**

### Phase 3 — The snapshot tax (biggest shared win, ~35–40% of dashboard CPU)

5. **Trusted snapshot paths on both backings**: chunked — concat
   chunks + pending into a trusted `SeriesStore` handoff (the
   in-code deferred follow-up; no materialization, no re-validation);
   array — route through the existing trusted-events construction
   instead of rows + `validateAndNormalizeColumnar`.
6. **Mutation-counter memoization on `LiveSeries.toTimeSeries()`**
   (mirror LiveView's #180): back-to-back identical-state snapshots
   return by reference — this is what the React hooks hit every
   frame. Gate: scenario C flips to chunked-parity-or-better; G's
   snapshot frames drop out of the profile top-5.

### Phase 4 — Array-side retention + micro-hotspots

7. **Head-offset trim for `EventArrayLiveStorage.dropPrefix`**
   (compact when offset > capacity/2) — 29.2% of array self-time;
   this is the fix for the users who _legitimately_ stay on the array
   backing (reorder/drop/interval keys).
8. Micro batch: hoist column handles in
   `materializeEventsFromStore`/`snapshot` (kill per-cell Map
   lookups); skip `LiveRollingAggregation.value()` when no `'update'`
   subscriber; `evictPrefix` materialization bypassing the Event
   cache.

### Phase 5 — Consolidation + the regression net

9. **Array-vs-chunked parity suite**: the same operator/behavior
   matrix (push shapes × ordering modes × listeners × eviction ×
   snapshot) asserting identical observable outputs — the live twin
   of the batch parity suite, and the durable defense against the
   dual-path drift class.
10. **Commit `perf-live-backing.mjs`** encoding this grid (A/B/C/E/F
    minimum) as the standing benchmark, so the next wave measures
    against today's numbers instead of re-deriving them.
11. **Docs**: one honest paragraph in `live-series.mdx` on the
    storage model — "batched ingest is stored columnar, per-event
    ingest coalesces through a row tier; you don't choose and don't
    need to" — plus the commit-granularity note that already exists
    in JSDoc.

### Then: declare it finalized

After Phase 5, the live layer is: one fan-out driver, two storage
strategies behind one interface with a parity suite proving they're
observationally equivalent, no ingest pattern that regresses vs the
simple alternative, and a committed benchmark grid. That is a
defensible "current best effort for live streaming data processing" —
and the falsifiability clause: **if after Phases 2–3 the re-run grid
shows chunked losing any realistic scenario by >10%, reopen the
unroll decision with this document as the baseline.** The remaining
RFC directions (Live §A column-native output, columnar rolling
reducers) stay friction-gated exactly as before; nothing in this plan
depends on them.

---

## Method notes

- G (sustained mixed) is a single 20 s run per backing and C2 sits at
  the noise edge; both labeled as such. All other scenarios are
  median-of-5 with warmups, fresh process per (scenario × backing),
  backing asserted behaviorally inside each run.
- The eviction grid exercised chunk-aligned evictions; the
  partial-boundary `sliceStore` path was not load-tested (covered by
  unit tests; noted for the Phase 5 parity suite).
- Retained-heap numbers separate `heapUsed` from `arrayBuffers`; the
  A1-mem 1,635 B/event is pure JS-heap object overhead (buffers too
  small to leave the heap), which is the pathology in one number.
