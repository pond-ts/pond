# Columnar arc assessment — June 2026

Status analysis of the Phase 4.7 columnar work, written 2026-06-10
against `main` at v0.20.0 by the Pond technical consultant agent
(Claude). Companion to
[`technical-audit-2026-06.md`](technical-audit-2026-06.md). North star
used throughout: **overall improved performance while maintaining a
consistent and clear API surface.**

Sources: PLAN.md Phase 4.7 roster, `docs/rfcs/columnar-core.md` /
`column-api.md` / `columnar-live-protocol.md`,
`docs/briefs/collect-output-columnar-arc.md`,
`docs/notes/chart-spike-friction.md`, CHANGELOG v0.18–v0.20, and a
ground-truth pass over `packages/core/src/columnar/`, `batch/`, and
`live/`. Load-bearing claims were verified against source; one
agent-report discrepancy was resolved by reading the code (see
"Partition routing is conditional" below).

---

## 1. Where it actually stands (v0.20.0)

- **Framework layer (steps 1a–1h): done.** Typed-array columns for
  all four value kinds, validity bitmaps, chunked variants, builders,
  `ColumnarRingBuffer`, `scatterByPartition`. ~482 framework tests;
  substrate purity (zero upstream imports) enforced by an
  independence test on every PR.
- **Batch `TimeSeries`: columnar-first.** All row intake routes
  through `validateAndNormalizeColumnar` (3.6× faster construction,
  no per-row Event allocation); point accessors route through the
  store; events lazy-materialize with identity-preserving caches.
- **Reduce fast paths (step 3A): done.** 8 built-in numeric reducers
  via `ReducerDef.reduceColumn` — sum/min/max/avg 59–73×, stdev 35×,
  median/p95 3.4× at N=1M.
- **Public column API (step 8): done and validated.**
  `series.column()` / `keyColumn()` / `.slice()` / `.bin()`,
  schema-narrowed types; chart experiment M1 adopted it (10M points
  full-window in 10.7 ms, –18% vs spike accessors).
- **Live chunked backing (step 7): shipped, conditional.** Strict
  time-keyed `LiveSeries` get chunked columnar storage (4.6× heap
  win); reorder/drop/interval-keyed series stay on `Event[]` backing
  by design.

**Partition routing is conditional.** v0.20's column-native partition
routing applies only when the _source_ is chunked-backed: partitions
then inherit chunked backing
(`live-partitioned-series.ts:1035`). Array-backed sources and
per-event routing still force `__backing: 'array'`
(`live-partitioned-series.ts:327–329`, `:450`, `:459`). The −99.4%
Event-retention / 60×-fewer-stores numbers are real but apply to the
chunked-source path only.

**Summary: substrate done, intake done, terminal reads done. The
middle of the pipeline — transforms and windowed aggregation — is
still row-shaped.** Everything below lives there.

---

## 2. What realistically remains, in recommended order

### 2.1 Step 3B — `aggregate()` per-bucket fast path (`reduceColumnRange`)

The natural next step; the chart experiment's friction item #6
explicitly ranked it above 3C. On sorted time-keyed data, buckets are
contiguous index ranges, so this is the shipped `reduceColumn`
pattern plus two bounds — low design risk, **zero public surface**.
`aggregate()` is the most-used heavy batch operator; this is the
largest unclaimed batch win.

### 2.2 Step 4 — derived transforms, paired with operator extraction

More important than its roster position suggests, because of a subtle
property of the current half-state: **batch operators read
`this.events`, which triggers full lazy materialization.** A user who
builds a series (fast, columnar) and then calls `.fill().select()`
pays the entire N-Event materialization tax that step 2c removed from
construction — the 3.6× win evaporates for pipeline users at the
first transform. The framework ops already exist
(`withColumnsSelected/Renamed/Replaced`, `sliceByIndices`); step 4 is
wiring operators to them.

Step 4 is also the natural vehicle for the operator extraction from
`time-series.ts` (audit §3) — pairing them means each operator is
touched once, and the type-safe schema-construction helpers (audit
§2) can land in the same pass.

### 2.3 Chart M1 carry-forwards (cheap, surface-positive)

In the chart experiment's priority order:
`col.toFloat64Array()` (storage-agnostic gather),
`series.bisectBegin(ts)`, `TimeSeries.fromTrustedColumns(...)`, and
the `bin` NaN-convention JSDoc note. **`toFloat64Array` matters most
for the north star**: it is the documented reason storage dispatch
(`packed` vs `chunked`) currently leaks into user code at the
`.values` boundary (friction NF3). Closing it removes a discriminator
users shouldn't have to know about.

### 2.4 Chunked-native column methods

All chunked-variant reductions delegate to `materialize().method()`
(~2× cost, an O(N) copy). Acceptable for v1, but `concatSorted`
output and live snapshots are chunked — the tax sits exactly where
streaming consumers read.

### 2.5 Step 6 — string / dictionary reducers

`unique`, `top`, `samples`, grouped `count` over dictionary-encoded
columns. The shared reducer abstraction is the RFC's last genuinely
open design question. Moderate gains; committed for the v1.0 wave.

### 2.6 Step 5 — minimal aggregate planner

Mostly an enabler for 3B's generality (precompute bucket spans once,
prefix-sum simple reducers). "Minimal" is still undefined — keep it
that way until 3B shows what's needed.

### 2.7 Step 3C — `rolling()` fast path (last, expectations tempered)

The row path is already O(N) sliding-window, so unlike reduce this is
a **constant-factor win (likely 3–10×, not 59×)**. It needs
per-reducer rolling state (monotonic deques, running sums) — exactly
the territory where numerical-stability bugs have already been caught
twice. The queued gRPC V5 re-bench is explicitly designed to decide
whether 3C or further live-buffer work earns the next slot; let it.

### 2.8 Live §A (column-native output) — friction-gated only

The gRPC profile "earned" it (~50% of saturation budget is
output-Event tax), but production target is 100k/s with 2.56×
measured headroom, and the live-protocol RFC's V3 north star ranks
reducer speed first and output tax last. The zero-copy arc was
correctly killed by measurement (`perf-band-gather.mjs`: <6% of a
frame at ≤64 hosts). Do not resurrect without a consumer at ceiling.

### Deliberately staying dead

Worth keeping dead, with the evidence that killed each: `pushColumns`
public API (no wire-batching producer yet), `groupBy` columnarization
(measured worst-case regression; `partitionBy().apply()` is the
recommended pattern), count-window reorder corral (non-monotonic
overlay), reorder-mode columnar backing (V2 commitment),
WASM/WebGPU/SIMD (doors open, not committed).

---

## 3. Where the gains are, ranked

| Opportunity                 | Expected gain                                                                                                                                                                           | Confidence                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 3B aggregate range path     | Order-of-magnitude on numeric aggregates of large series (reuses the 59–73× reduce kernels per bucket)                                                                                  | High — same pattern as shipped 3A    |
| Step 4 transforms           | Recovers the 3.6× construction win for _pipelines_; memory: avoids N Events + N frozen dicts per chain stage                                                                            | High — framework ops exist           |
| Live gather allocation skip | `LiveView.column()` on a chunked source reads buffers instead of walking `Event[]` through a `(number\|undefined)[]` intermediate — the measured B→C gap in `perf-liveview-columns.mjs` | Medium-high                          |
| Chunked-native reductions   | Removes the 2× materialize tax on concat/snapshot outputs                                                                                                                               | High, modest size                    |
| Step 6 dict reducers        | Speed + memory on string-heavy aggregation                                                                                                                                              | Medium                               |
| 3C rolling                  | 3–10× constant factor (asymptotics already right)                                                                                                                                       | Medium                               |
| Live §A output tax          | Large at gRPC ceiling, ~nothing below it                                                                                                                                                | Defer until a consumer is at ceiling |

Memory gains have mostly already landed (lazy events 4×, chunked live
backing 4.6×, v0.20 partition routing). The remaining memory lever is
step 4 — chained transforms not materializing intermediate Event
arrays.

---

## 4. Likely regressions — where to point the bench scripts

1. **Silent numeric divergence is the worst class, and rolling is its
   natural home.** Two instances already caught in review (stdev
   catastrophic cancellation; NaN-laundered min/max). Running-sum
   rolling state drifts in ways batch recompute doesn't. The parked
   "principled NaN + Welford" design doc should land **before** 3C,
   not after — bug-for-bug parity was the right close for 3A but is
   not a stable foundation for sliding-window state.
2. **Small-N dispatch overhead.** Step 2a showed the shape: +40%
   construction until 2c recovered it. Every fast path adds a
   dispatch branch and per-bucket slice setup; at one event per
   bucket (the per-element-floor scenario the perf policy mandates),
   3B could plausibly _lose_ to the row walk. Keep the floor scenario
   in every new perf script; accept a row-path fallback below a
   threshold rather than forcing columnar everywhere.
3. **Export-heavy flows are already regressed and unrecovered.**
   `series.events` and `toRows`/`toObjects`/`toJSON` got slower when
   cost moved from build to first access; column-native export paths
   were explicitly deferred. For snapshot-then-serialize users (the
   gRPC server shape), this is a standing tax — worth a measurement
   before deciding it's fine.
4. **Strictness regressions.** The v0.18 interval-label-kind
   enforcement was a breaking change born of per-column homogeneity.
   Steps 4 and 6 will surface more places where the row path silently
   tolerated mixed shapes. Each needs the v0.18 treatment:
   CHANGELOG-documented, error message that explains why.
5. **Dual-path semantic drift — the API-consistency regression.**
   Array-backed (reorder/drop/interval) and chunked-backed series are
   two implementations of the same class, and `partitionBy` can flip
   a sub-series between them. A behavior difference here isn't a perf
   regression; it's the same method returning different answers
   depending on an invisible storage decision. (Audit §1.5 wearing
   its columnar hat.)
6. **Bundle size.** The <25 KB pin slipped past 26 KB at step 1g, the
   ring buffer added ~12–15 KB more, and the promised "targeted size
   optimization sub-step" has not reappeared in the roster. For
   browser/chart consumers this is a quiet regression no bench script
   watches.

---

## 5. North-star recommendations

The project's instincts have been right and the discipline is the
asset: the column-api V3 walkback (columns only for single-column,
time-detached work; everything multi-column / time-aware stays
event-shaped) is the correct line, and measurement has killed the
right things. Three recommendations to keep it that way:

1. **Sequence as 3B → 4 (+ operator extraction) → carry-forwards →
   6 → 5 → 3C**, with live §A strictly friction-gated. Every step
   before 3C is zero-or-negative public surface; `toFloat64Array`
   actually _shrinks_ what users must understand.
2. **Add a row/columnar parity suite** — the same operator matrix run
   on array-backed and chunked-backed series, asserting identical
   outputs. The reducer NaN-parity tests prove the pattern;
   generalizing it is the cheapest defense against regression classes
   1 and 5, and it makes the eventual dual-path consolidation safe.
3. **Re-pin the bundle budget before step 4** lands more kernels —
   either re-commit to a number with a CI size check, or explicitly
   amend the target in the RFC so the slippage is a decision rather
   than drift.

Scope read: steps 1–3A+8 (the hard substrate work) shipped in roughly
two weeks of PR cadence. What remains is comparable in size but lower
in design risk — except 3C, which is the one place where design risk
and numerical risk stack, which is exactly why it should go last.

---

## Open design questions carried forward (from the RFC trail)

Tracked here so they aren't lost; the binding versions live in the
RFCs:

- String-reducer shared abstraction (columnar-core open question #1;
  step 6 answers it).
- Transform-chain materialization tax in practice (step 4
  at-implementation discovery).
- Chunked `.slice()` / hot-path chunk iteration vs transparent
  materialize (column-api §12; deferred to chart M2/M3 feedback).
- `.values` validity-trap naming (RFC leans keep; revisit only on
  user reports).
- Column lifetime contract (view over parent buffers; needs one
  JSDoc paragraph).
- `binByTime` shape (post-M1 chart iteration).
- first/last time-order redefinition opportunity if columnar reorder
  ever lands (v1.x+).
- Aggregate planner "minimal" threshold (defined by 3B friction).
