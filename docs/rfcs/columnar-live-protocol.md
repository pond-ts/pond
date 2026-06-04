# Columnar Live Protocol

**Status:** planning note. **Current prioritization → [Amendment V3 — North
star (2026-06-04)](#amendment-v3--north-star-prioritized-goals-for-the-live-columnar-surface-2026-06-04).**

**Relationship to PLAN.md:** This RFC is strategic context, not a
commitment. [PLAN.md](../../PLAN.md) is the binding source of truth for what
is actually being built; phases adopted into PLAN are commitments, and the
rest of this document is forward-looking. See
[CLAUDE.md → Strategic RFCs](../../CLAUDE.md) for the layering.

**Authorship:** developed across a design thread between contributors. Each
section carries inline attribution; this table is the index for cold readers.

| Section                                              | Contributor                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Original draft (§A–§D + open questions)              | pond-ts library agent (Claude) — synthesizing a design thread with pjm17971 |
| §B corral / LSM-overlay architecture (the core idea) | pjm17971                                                                    |
| §A columnar-output framing (the seed)                | pjm17971                                                                    |
| Reducer-combine taxonomy + count-window analysis     | pond-ts library agent (Claude)                                              |
| Review notes §1 (design / coherence)                 | neutral pond-ts review agent (Claude)                                       |
| Review notes §2 (adversarial technical)              | Codex                                                                       |
| Review notes §3 (use-case, gRPC)                     | gRPC experiment agent (Claude)                                              |
| Author response & amendments — V2                    | pond-ts library agent (Claude)                                              |
| Amendment V3 — north star (prioritized goals)        | pjm17971 (prioritization); pond-ts library agent (Claude), recording        |

**Audience:** future pond-ts contributors deciding how the _live boundary_
(the protocol between a `LiveSeries`/`LiveSource` and its listeners and
reducers) should evolve now that storage underneath it is columnar.

**Thesis.** The chunked columnar `LiveSeries` backing (PR #170) made live
_storage_ column-native: a top-level strict time-keyed series holds its
window as batch-granular `ColumnarStore` chunks and retains zero `Event`
objects. But the _protocol_ at the boundary — `on('event', (e: Event) =>
…)`, `on('evict', (evs: Event[]) => …)` — is still per-row-`Event`. That
boundary is where the remaining `Event` materialization happens, and it is
where two separate friction signals converge:

1. **Output tax.** Subscribing to `'event'` forces the chunked backing to
   materialize a transient `Event` per row, partly defeating the heap win it
   exists to deliver.
2. **Reorder blur.** Once rows can be inserted out of arrival order
   (`ordering: 'reorder'`), the per-row append/evict protocol can't cleanly
   express "a row moved into the middle" — the ambiguity that PR #170's
   `LiveReduce` eviction bug lived in.

Both point at the same conclusion: **the live boundary protocol should be
structural and columnar, not per-row-`Event`.** A small structural-delta
vocabulary — `appendRun`, `insertLate`, `dropRange`, `compact` — is the
shared spine; column-native output (§A) and a columnar `reorder`
implementation (§B) are two consumers of it (§C).

This RFC captures that direction. **Nothing here is committed.** No current
consumer needs it yet (see §D). It exists so the direction is red-teamable
before code, and so two design threads have a durable home.

---

## §A — Column-native output

_Original draft: pond-ts library agent (Claude); seed: pjm17971._

Today a listener receives synthesized `Event` objects. For a batched,
high-rate producer this is the last per-row allocation in an otherwise
columnar pipeline (columns in → columns stored → **Events out**).

**Proposal.** Add a columnar-window listener whose payload is a
`TimeSeries<S>` — not a new `Chunk` type. Reasons `TimeSeries` is the right
unit:

- It already _is_ the columnar window. Post-Step-2a a `TimeSeries` wraps a
  `#store`; the chunked backing already holds `ColumnarStore` chunks, so
  wrapping a chunk as a series is near-zero-cost (cheaper than `snapshot()`,
  which still row-rebuilds). _Correction (Review notes §4b/§7): the
  trusted-store factory today lives on `ColumnarStore` / `SeriesStore`, not on
  `TimeSeries` — a thin public `TimeSeries` (or lighter `LiveRun`) view over a
  chunk is small **new** surface, not zero. The "near-zero-cost" claim holds;
  the "zero new vocabulary" claim does not. See the payload-shape fork in the
  amendment._
- It reuses the entire chart-extraction column API (`Float64Column`,
  `KeyColumn.at`, `toFloat64Array`, `bin`). The consumer who wants
  throughput walks columns; the consumer who wants per-event iteration calls
  `ts.at(i)` / `ts.events()`. **That is the materialize adaptor, and it
  already exists** — zero new vocabulary.

**Listener taxonomy under this proposal.**

- `'event'` (per-row) — stays, reframed as the materialize adaptor. The
  right default for low-volume / per-event producers.
- a columnar-window listener (name TBD) — one `TimeSeries<S>` per push,
  creates no `Event`. The throughput path.
- `'evict'` — could also go columnar (evicted prefix as a `TimeSeries`
  window), same heap argument.
- `partitionBy` routing migrates onto this internally — this is the deferred
  Phase 2 `scatterByPartition` work; same insight, internal rather than
  public.

**Honest tensions (must be red-teamed before code).**

1. **Couples the API to input batching granularity.** A consumer doing
   1000 × `push(oneRow)` gets 1000 one-row windows and sees ~no benefit; the
   win is real only for _batched_ producers (the gRPC aggregator, the
   dashboard). Output coalescing / re-chunking would decouple that — but it
   is a separate feature with a latency tradeoff and must **not** ride along
   in v1. v1 contract = "one window per `pushMany`," documented.
2. **"Zero-copy" needs precision.** We hand an immutable view (the column
   API is read-only), not the mutable backing array. The win is "no per-row
   `Event` allocation," not "no bytes copied."
3. **`'event'` is not going away.** This is a throughput tool, not a
   replacement.

**Prime beneficiary: `@pond-ts/react`.** Charts want columns. `useLiveSeries`
could expose the latest window for charting with no per-event churn — closing
the loop with the charts experiment's findings (M1/M2).

---

## §B — Column-native `reorder` (the corral / LSM overlay)

_Core architecture: pjm17971. Taxonomy + count-window analysis: pond-ts
library agent (Claude)._

`reorder` is the one ordering mode the chunked backing does **not** support
today: append-only chunks can't take a sorted mid-stream insert. The
promising shape if `reorder` ever goes columnar keeps the happy path fast and
puts the disorder in a smaller side structure that pays the reorder tax.

```text
main store:   append-only columnar chunks, mostly in-order  (today's fast path)
late corral:  small sorted side buffer of accepted out-of-order rows
read/reduce:  base window from main chunks
              + matching late rows from corral
              -> reducer-specific combine/merge
```

An LSM-ish lifecycle bounds the corral ("corral" = the small sorted side
buffer holding accepted out-of-order rows until they're folded into the main
store):

```text
append chunks -> immutable sorted-ish runs
late corral   -> small sorted mutable run (memtable-ish)
grace-flush   -> once the reorder grace window passes, compact corral rows
                 into main runs
```

> **Terminology — this "grace-flush" is NOT a streaming watermark.** It is a
> storage-internal compaction/flush trigger (LSM "flush"), purely a function
> of when out-of-order rows can no longer arrive. It says nothing about output
> finality or emission, and does not reintroduce the semantic watermark that
> [`streaming.md`'s "Why no watermarks" non-goal](streaming.md) rejects as the
> slippery slope to "mini Beam." Earlier drafts of this section called it a
> "watermark"; that was a poor word choice flagged in review (see Review
> notes §1). The north-star cross-reference stands — this is a GC/flush
> mechanism, not a finality protocol.

**The property worth protecting above all else:** when the corral is empty
(the common case — late rows are rare), read cost collapses to _exactly_
today's chunked path. You pay tax only in proportion to actual disorder. Any
design that taxes the happy path to support reorder has lost the plot.

### Reducer-combine taxonomy

The combine cost splits into three tiers, not two:

**Tier 1 — O(1)/O(N) monoid combine.** `sum`, `count`, `avg` (combine
`{sum,count}`), `min`, `max`, `stdev` (Chan's parallel-variance combine),
`topN` (global top-N ⊆ union of each side's top-N → merge 2N candidates).
True mergeable monoids: `reduce(main) ⊕ reduce(corral)`.

**Tier 2 — efficient but not a monoid.** `median` / `percentile`: not
computable from sub-results, but if both sides keep sorted arrays (main
already does via `rollingSortedArray`, corral is tiny) the p-th value is a
two-sorted-array rank-select in O(log n + log k). `unique`: set-union,
O(corral). Cheap with a small corral; the combine is structural, not
arithmetic.

**Tier 3 — needs the merged sequence.** `difference` (a mid-sequence insert
splits one gap into two — genuinely positional), `samples`, custom reducers.
These need a sorted merge of main-window + corral before evaluation.

**Escape hatch for `first`/`last`.** They land in Tier 3 only if they keep
_arrival-order_ semantics. Redefined as **time-order** first/last (arguably
the more intuitive meaning), they drop to Tier 1: `first(A∪B) =
min-key(first(A), first(B))`. So a columnar reorder is an opportunity to
_fix_ first/last's semantics, not just survive them.

### The count-window wrinkle is the genuinely hard part

The overlay is clean for **time windows** (`maxAge`) and non-monotonic for
**count windows** (`maxEvents`):

- **Time window:** the corral contributes rows whose key ∈ [start, end],
  full stop. _Purely additive_ — composes cleanly with Tier 1/2.
- **Count window:** admitting a late row into the top-N _displaces_ the
  current Nth row. So the corral doesn't just _add_ rows, it can _mask_ a
  main-window row that's no longer in the last N. That breaks the clean
  `reduce(main) ⊕ reduce(corral)` combine, because `reduce(main)` now
  includes a row that shouldn't count.

Resolution options for count windows: (a) compute last-N over merged tail
keys and _mask_ displaced main rows (reducer must support a
remove-that-isn't-an-eviction); or (b) provisional-until-grace-flush
semantics (simpler, adds latency).

**Recommended v1 scope:** support `maxAge` (time window) only for columnar
reorder; punt count-window-reorder to "snapshot and reduce." Time windows
keep the overlay monotonic, which keeps the Tier 1/2 combine valid — a clean,
honest scope line.

### Compaction cost

Compacting corral rows into immutable columnar chunks means producing a new
chunk for the affected run. Late rows usually cluster near the tail, so
compaction touches only the newest 1–2 chunks; a very old late row touching
an old chunk is rare. A corral row that ages out of the retention window
before the grace-flush never needs compacting — it's just evicted. So corral
churn ≈ (late rate × grace window), bounded. **Compaction _rewrite_ cost,
however, is not yet bounded by the data structure** — an adversarial reorder
stream can keep targeting the oldest retained run. "Amortized cheap" is
workload optimism until a concrete compaction policy is specified (threshold,
max run size, in-place vs leveled rewrite, late-row coalescing). Flagged by
Codex (Review notes §2); resolving it is a precondition for §B graduating from
RFC to build.

---

## §C — The unifying protocol

_Original draft: pond-ts library agent (Claude). **Downgraded in V2** — see
Review notes §1 and the amendment: the "one spine" claim below oversells the
link; §A and §B share a premise and one primitive, not a full substrate._

§A and §B share a premise: **the live boundary protocol should be
structural/columnar, not per-row-`Event`.** (The original draft called this
"one substrate, two consumers"; review rightly flagged that as oversell — §A
exercises only `appendRun`/`dropByKeyRange`, while `insertLate`/`compact` and
the hard parts are pure §B. They are adjacent ideas sharing one primitive, not
a single spine. Kept here as written with the correction noted; resolved in
the amendment.)

Once the boundary vocabulary is structural deltas —

```text
appendRun(chunk)         // the fast path: a whole batch as one columnar run
insertLate(run)          // a sorted mid-stream insert (corral admission)
dropByKeyRange(from,to)  // retention eviction by key-range (see below: NOT dropRange(n))
compact(corral->run)     // grace-flush: fold late rows into main runs
```

— both wins fall out of one substrate:

- **Output side (§A):** listeners consume these deltas (a `TimeSeries`
  window per run, an explicit late-insert, an explicit drop) instead of N
  synthesized `Event`s.
- **Reduce side (§B):** `LiveReduce` consumes the same deltas, so eviction
  stops being identity/FIFO guesswork. That ambiguity is exactly where PR
  #170's reducer bug lived: the per-row protocol couldn't say "this evict
  removed the _sorted-prefix_, not the oldest _arrival_." **But structural
  deltas are necessary, not sufficient** (Codex, Review notes §4): a bare
  `dropRange(n)` is _still_ ambiguous under reorder — it must mean "drop the
  oldest rows in the merged logical order as of sequence number S," and the
  reducer must receive the removed keys/ids or be able to reproduce the same
  merged view. Otherwise the identity bug is merely _relocated_ from `Event`
  identity to "which physical rows did this logical range refer to?" This is
  why the v1 vocabulary above uses `dropByKeyRange(from,to)`, not
  `dropRange(n)` — key-range eviction is unambiguous under the time-window v1
  scope; count/prefix eviction reopens the ambiguity.

**The reducer/consumer contract.** Two ways to make removal unambiguous
under reordering, possibly both:

- **Stable internal row ids** — every row gets a monotonic id that survives
  reordering; reducer state is keyed by id, removal is id-based not
  position-based. (PR #170's `absIdx` is a primitive version of this.) The
  catch is not the id — it's that today's `min`/`max`/`first`/`last` rolling
  states _discard_ dominated elements, so id-keyed removal still needs a
  structure that can resurrect them (sorted array / order-statistics tree),
  not a monotone deque.
- **Explicit structural deltas** — `appendRun` / `insertLate` / `dropRange`
  as above; the reducer reacts to structural change, not row identity.

These are orthogonal; the structural-delta protocol is the batching/
columnar spine, the stable-id contract is the within-reducer correctness
mechanism.

---

## §D — Scope, sequencing, and what is _not_ committed

_Original draft: pond-ts library agent (Claude)._

Two distinct things live in this RFC and must not be conflated:

- **Narrow (LiveReduce-only) fix for the documented reorder gap.** The
  pre-existing limitation — `min`/`max`/`first`/`last`/`samples` return
  stale/`undefined` for `reorder` + retention (see
  [PLAN.md "Deferred"](../../PLAN.md) and `LiveReduce`'s JSDoc) — is fixable
  _without any of this_: give `min`/`max` a removal-by-value state (sorted
  array, as `median` already uses), selected only for reorder sources,
  keeping the O(1) monotone deque on the append-only hot path. No corral, no
  protocol change. This is the proportionate fix the moment a consumer
  actually needs reorder + retention + extrema.

- **Broad (columnar live protocol) architecture.** §A + §B + §C. Makes
  reorder a first-class _columnar_ citizen and the output boundary
  zero-`Event` — but it is a substrate-level change to the live layer.

**Neither is earned yet.** As of PR #170, no consumer uses reorder +
retention + windowed reducers (it was silently broken and nothing noticed);
no consumer has hit the output `Event` tax hard enough to ask for columnar
output. This stays RFC context until a friction signal arrives:

- The **narrow fix** earns itself when a real reorder consumer needs
  windowed extrema.
- **§A (columnar output)** earns itself when a batched consumer (gRPC,
  dashboard, or `@pond-ts/react` charting) measures the output `Event` tax as
  a real cost.
- **§B (columnar reorder)** earns itself when a reorder consumer hits the
  heap wall at the scale the chunked backing was built for.

When work derived from this RFC lands in PLAN.md, the PLAN entry is the
binding version; this RFC stays as the "why."

## Open questions (for the review layer)

1. **§A unit:** confirm `TimeSeries<S>` is the output unit (vs a lighter
   `Chunk` type). The draft argues strongly for `TimeSeries`.
2. **§A naming:** the columnar-window listener name. `'window'` collides with
   retention; `'frame'` / `'block'` are candidates; or deprecate
   `Event[]`-valued `'batch'` and reissue it `TimeSeries`-valued.
3. **§A `'batch'`/`'evict'`:** change their payloads, or add new
   names additively?
4. **§B scope:** is "time-window-only for columnar reorder v1" the right
   line, or is count-window-reorder worth the non-monotonic complexity?
5. **§C contract:** stable row ids, explicit structural deltas, or both? Does
   the structural protocol replace the `'event'`/`'evict'` events or layer
   beside them?
6. **first/last redefinition:** is moving reorder first/last from
   arrival-order to time-order a welcome semantic fix or a breaking surprise?

---

## Review notes — 2026-05-30

Three independent reviews ran the multi-agent pattern against the original
draft, on deliberately non-overlapping lenses. Full text lives on
[PR #171](https://github.com/pjm17971/pond-ts/pull/171); the load-bearing
points are captured here so the RFC stays self-contained for a cold reader.

### §1 — Design / coherence review _(neutral pond-ts review agent, Claude)_

[Full comment.](https://github.com/pjm17971/pond-ts/pull/171#issuecomment-4582886622)
A fresh reader with no authoring stake, on internal-coherence and
scope-discipline:

1. **§C is the weakest claim.** §A and §B share one verb (`appendRun`) and a
   slogan, not a spine — §C's own "these are orthogonal" line concedes it. The
   "one substrate" framing oversells the connective tissue.
2. **Watermark contradiction (load-bearing).** §B's "watermark compaction" +
   the `streaming.md` north-star cross-ref collide with `streaming.md`'s
   attributed "Why no watermarks" non-goal. The distinction (storage-internal
   flush vs semantic watermark) must be drawn explicitly.
3. **Center of gravity vs §D's restraint.** §B is ~40% of the doc at
   implementation altitude for a bug already fixed and that no consumer hits;
   the prose honors friction-driven, the page-weight builds the cathedral.
4. Smaller: §B silently reopens the brief's resolved Q4; `TimeSeries.fromTrustedStore`
   overstates (factory is on the store classes); §A has an honest-tensions
   list, riskier §B has none; "corral" undefined on first use.

### §2 — Adversarial technical review _(Codex)_

[Full comment.](https://github.com/pjm17971/pond-ts/pull/171#issuecomment-4582894490)
Grounded in the #170 implementation and reducer code:

1. **Overlay invariants underspecified.** "Append-only main, mostly in-order"
   isn't enough — once compaction lands a late row, either compaction rewrites
   the affected run preserving sorted metadata, or main becomes a _set of
   sorted runs_ and all readers do multi-run overlay reads. This determines
   whether retention stays prefix-droppable and whether `beginAt(i)` stays
   cheap. There's also an **admission race**: a late row within grace but older
   than the retention cutoff must be rejected _before_ entering the corral, or
   compaction resurrects already-evicted rows.
2. **Compaction cost isn't bounded by the structure** — only by workload
   optimism — until a concrete policy exists.
3. **Reducer taxonomy needs "provided-state-is-X" qualifiers:** `stdev` needs
   `(n, mean, M2)`; `unique` needs refcount-by-value not a bare set; `min`/`max`
   are Tier 1 only with value-removable state (today's monotone deque does NOT
   qualify); `median`/`percentile` depend on materialized sorted arrays + same
   logical window + interpolation semantics; `topN` must carry the tie-break
   key; `first`/`last` time-order is a semantic switch, not a silent retier.
4. **Structural deltas are necessary, not sufficient** — `dropRange(n)` stays
   ambiguous unless it carries eviction coordinates; prefer key-range eviction
   for the time-window v1.
5. §D's narrow fix is a **narrow _extrema_ fix** (`min`/`max`) — `first`/`last`/
   `samples` still need ordered-by-logical-order state or a documented
   "unsupported" stance.
6. Count-window v1 scope is right but must be **operational**: `maxEvents` _and_
   mixed `maxAge + maxEvents` force array/row fallback.
7. `TimeSeries` payload must not imply a full independent snapshot if it's
   really a window view; a lighter `LiveRun`/`ColumnarRun` view may be cleaner,
   with `toTimeSeries()`/`events()` as adapters.

### §3 — Use-case review _(gRPC experiment agent, Claude)_

[Full comment.](https://github.com/pjm17971/pond-ts/pull/171#issuecomment-4582901573)
The OOM-motivation consumer, grounded in its heap profile and `BENCH.md`:

- **§A's friction is already measured, not hypothetical.** `fanout.ts`'s
  serialize tax is **0.44 ms p99 ≈ 50%** of the per-pushMany budget at
  saturation; ~80% of that budget is per-`Event` listener work _after_ pond's
  own work; ~6.7M transient row-object allocations/min. A `TimeSeries<S>`
  window listener collapses the recordFanout loop to two column reads. **Strong
  endorsement; `TimeSeries<S>` is the right unit** (they already consume it).
- **Q3:** add the columnar listener as a _new_ name additively; don't change
  `'batch'`'s payload (migration safety).
- **§B:** they use `reorder` only on a low-volume late-data path, `maxAge`
  only, never at firehose — **time-window-only v1 is fine**, count-window N/A,
  first/last→time-order safe for them.
- **§C migration:** low-to-moderate, no blockers; structural deltas are
  _simpler_ for their subscribers; they don't need stable row ids.
- Offer: an A/B wire-side allocation measurement (Event-count delta with vs
  without the chunked backing's transient materialization) against
  pond@0.17.1.

## Author response & amendments — V2, 2026-05-30 _(pond-ts library agent, Claude)_

The reviews converge cleanly; the direction holds and is sharper. **Inline
corrections already applied to the original draft** (each marked in place):
watermark → grace-flush + an explicit "not a semantic watermark"
disambiguation (§1.2); `fromTrustedStore` factual fix (§1.4/§2.7);
`dropRange(n)` → `dropByKeyRange` in §C's vocabulary (§2.4); the compaction-cost
caveat (§2.2); the "one spine" downgrade flag and the necessary-not-sufficient
correction on the reduce-side bullet (§1.1/§2.4); "corral" defined on first use
(§1.4). V2 positions on the rest:

1. **§C downgraded, accepted (§1.1).** §A and §B are adjacent ideas sharing a
   _premise_ (structural/columnar boundary) and one primitive (`appendRun` /
   run-as-unit), not one substrate. The honest unification is narrower: §A is
   independently valuable and buildable without any of §B; §C's value is the
   _delta vocabulary + eviction-coordinate discipline_, which §B needs and §A
   merely benefits from. The RFC no longer claims building §A teaches you §B.

2. **§A is the first _earned_ step — status change (§3).** The gRPC profile is
   a real, measured friction signal (50% of the saturation budget is the
   output `Event` tax), not the hypothetical §D framed. §A graduates from
   "deferred until friction" to **"earned; smallest first increment of this
   RFC."** Accepting the offered A/B allocation measurement to quantify the
   delta against the shipped chunked backing before any API lands. This does
   **not** pull §B forward — §B stays unearned.

3. **§A payload is an open fork, not settled (§2.7/§1.4).** `TimeSeries<S>`
   (gRPC endorses; they already consume it) vs a lighter `LiveRun`/`ColumnarRun`
   view with `toTimeSeries()`/`events()` adapters (Codex: avoids implying a
   full independent snapshot). Resolution deferred to the §A design spike;
   Q1 reframed accordingly. Q3 resolved: **additive new name, `'batch'`
   unchanged.**

4. **§B invariants are now preconditions, not hand-waves (§2.1/§2.2).** Before
   §B could graduate: (a) pick the main-store model — rewrite-in-place
   preserving sorted-run metadata _vs_ explicit sorted-run-set with multi-run
   overlay reads; (b) specify the admission policy that rejects
   below-retention-cutoff late rows before they enter the corral; (c) specify a
   concrete compaction policy (threshold / max run size / leveling /
   coalescing). These are logged in §B inline and gate any build.

5. **Reducer taxonomy carries Codex's qualifiers (§2.3).** Each tier entry is
   "Tier N _provided the state is X_." The key one for honesty: today's
   `min`/`max` monotone-deque state does **not** qualify for Tier 1 — the
   value-removable structure is exactly the §D narrow fix. The taxonomy
   describes _achievable-with-the-right-state_, not _today's-state_.

6. **§D reworded to "narrow _extrema_ fix" (§2.5).** The `min`/`max`
   sorted-array fix does not cover `first`/`last`/`samples`; those need
   logical-order-keyed state or a documented "unsupported under reorder +
   retention" stance. The PLAN "Deferred" note inherits this precision.

7. **Count-window scope made operational (§2.6).** Columnar reorder v1 is
   `maxAge`-only; `maxEvents` and mixed `maxAge + maxEvents` fall back to the
   array/row backing (the count side reintroduces displacement / overlay
   non-monotonicity). Q4 resolved on the scope axis: time-window-only is the
   line.

8. **Q4-reopen acknowledged (§1.4).** §B does reopen the brief's resolved "Q4:
   reorder keeps the array backing" — deliberately, as RFC-level exploration of
   the indexed-columnar path the brief deferred as "not a known different
   failure." Not a silent contradiction; an explicit "revisit when earned."

9. **Page-weight / center-of-gravity (§1.3).** §B's depth is _exploratory_ —
   the shape to reach for _if_ a reorder consumer earns it — not a build spec.
   Marked as such rather than trimmed: it captures real design thinking
   (pjm17971's corral architecture) worth preserving, and §D + the gRPC review
   both confirm §A, not §B, is the near-term path.

**Net:** no change to the strategic direction. The doc is more honest (§C
downgrade, watermark disambiguation, taxonomy qualifiers), and the _sequencing_
sharpened materially: **§A is now the earned first step** (gRPC's measured
tax), §B's preconditions are explicit, and the narrow extrema fix is the
proportionate near-term answer to the documented reducer gap. Next concrete
move when the user chooses to act: an §A design spike + the gRPC A/B
measurement — not a §B build.

## Amendment V3 — North star: prioritized goals for the live columnar surface (2026-06-04)

_(pjm17971's prioritization, recorded by the pond-ts library agent (Claude).
Grounded in the 2026-06 dashboard-friction wave — three reports at 256-host
stress — and the measurements it drove: #175, #180, and the
`perf-band-gather.mjs` arc-deferral verdict. See PLAN.md "Dashboard → Current
wave.")_

The §A–§C draft framed the live boundary around **output tax** and **reorder
blur**. Real-workload friction reprioritizes that frame. These four goals, in
order, are the north star for the live columnar surface. They are **direction,
not commitments** — they say which axis wins when axes trade off.

**1. Reducer speed over a full buffer — the headline.** Reducing a live buffer
many ways at once (avg / percentiles / min·max / per-partition / binned,
simultaneously, on demand) is _why people reach for the library_ — even when
ingest is throttled by the consumer (e.g. delivery to a web client). Columnar
storage's largest payoff is that each reduction becomes a typed-array **scan**
instead of an `Event[]` walk. This outranks every other axis.

**2. Consistent columnar + event outputs.** The `column()` read/reduce surface
should be available **uniformly** — batch and live, the same shape everywhere —
not columnar in one place and event-only in another. Ship the columnar option
even where it is _not_ zero-copy, or occasionally slower, and **document the
quirk** rather than withhold it (columnar is the right handoff to data-vis, and
`column()` has the ergonomics). Consistency is _surface-friendly_: a
predictable, uniform API lowers cognitive load — the opposite of the
hard-to-explain, inconsistent surface (e.g. a storage-representation opt-in
toggle) that should be rejected.

**3. Architectural simplicity / uniformity — the tie-breaker.** Prefer uniform
engineering even at some performance cost. LLMs raise the complexity ceiling
but do not remove the tax: clever per-case paths make agents struggle, reviews
harder, humans lost. One uniform column-scan path beats N special cases.

**4. Memory — lowest, and bounded.** A memory win is welcome but **rejected if
it costs more than ~10% throughput** — OOM is a real failure mode for
"`LiveSeries` as a mini stream-processor on real workloads," but it is one axis
among four. And it only matters when **holding a whole buffer**, _not_ for
aggregated downstream views.

**What this reorders.**

- It **validates deferring the "column-native output" arc** (chunk `collect()`
  / rolling output for zero-copy reads). That arc aimed at memory + zero-copy
  _ingest_ on an _aggregated downstream view_ — goal 4, the lowest axis, on the
  one place memory does _not_ matter — and required a hard-to-explain opt-in
  mode (goal 3 forbids). `perf-band-gather.mjs` confirmed the per-partition band
  gather is <6% of a frame at ≤64 hosts. #175 lands memory exactly where it
  counts (full-buffer hold) at no throughput cost — the right scope for goal 4.
- It **moves the headline** from §A's "output tax" (avoid per-row `Event` on the
  output boundary) to **reduction over the buffer**. The two overlap — both want
  columns, not events — but the _motivation_ is reducer speed, not heap.

**The open question goal 1 turns on (scan vs gather).** Does the live reduce
path today — `view.column('cpu').mean()`, `partitionBy(col).toMap(g =>
g.reduce(...))` — **scan the chunked columns directly**, or
gather-from-`Event[]`-into-a-typed-array and _then_ reduce? On a chunked-backed
buffer (#175) the typed arrays are already there to scan; if the path re-walks
events to rebuild them, that is the unclaimed reducer-speed win — and the next
concrete move is to **measure it before building**. The dashboard's
snapshot-side `partitionBy.toMap` gather-only ask (the dual of increment 1) is
the same question on the batch side, and is also goal 2 (closing a batch/live
inconsistency).

## Cross-references

- [PLAN.md](../../PLAN.md) — "Deferred" (reorder + retention windowed-reducer
  limitation), Phase B/Phase 2 columnar live work.
- [`docs/briefs/column-native-live-pipeline.md`](../briefs/column-native-live-pipeline.md)
  — the brief behind the chunked backing (PR #170) and the Phase 2
  `scatterByPartition` note.
- [`docs/rfcs/streaming.md`](streaming.md) — streaming semantics; the live
  layer's north star.
- [`docs/rfcs/columnar-core.md`](columnar-core.md) — the columnar substrate
  RFC; "public APIs stay row-oriented at the boundary" is the line §A
  proposes to revisit for the _output_ boundary specifically.
- [`docs/rfcs/column-api.md`](column-api.md) — the column-centric extraction
  API §A reuses as the materialize adaptor.
