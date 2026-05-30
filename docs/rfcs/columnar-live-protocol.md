# Columnar Live Protocol

**Status:** planning note.

**Relationship to PLAN.md:** This RFC is strategic context, not a
commitment. [PLAN.md](../../PLAN.md) is the binding source of truth for what
is actually being built; phases adopted into PLAN are commitments, and the
rest of this document is forward-looking. See
[CLAUDE.md → Strategic RFCs](../../CLAUDE.md) for the layering.

**Authorship:** developed across a design thread between contributors. Each
section carries inline attribution; this table is the index for cold readers.

| Section                                              | Contributor                                                                 |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Original draft (all sections)                        | pond-ts library agent (Claude) — synthesizing a design thread with pjm17971 |
| §B corral / LSM-overlay architecture (the core idea) | pjm17971                                                                    |
| §A columnar-output framing (the seed)                | pjm17971                                                                    |
| Reducer-combine taxonomy + count-window analysis     | pond-ts library agent (Claude)                                              |

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
  handing a listener `TimeSeries.fromTrustedStore(chunk)` is near-zero-cost
  (cheaper than `snapshot()`, which still row-rebuilds).
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

An LSM-ish lifecycle bounds the corral:

```text
append chunks -> immutable sorted-ish runs
late corral   -> small sorted mutable run (memtable-ish)
watermark     -> once grace passes, compact corral rows into main runs
```

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
remove-that-isn't-an-eviction); or (b) provisional-until-watermark semantics
(simpler, adds latency).

**Recommended v1 scope:** support `maxAge` (time window) only for columnar
reorder; punt count-window-reorder to "snapshot and reduce." Time windows
keep the overlay monotonic, which keeps the Tier 1/2 combine valid — a clean,
honest scope line.

### Compaction cost

Compacting corral rows into immutable columnar chunks means producing a new
chunk for the affected run. Late rows usually cluster near the tail, so
compaction touches only the newest 1–2 chunks; a very old late row touching
an old chunk is rare. A corral row that ages out of the retention window
before the watermark never needs compacting — it's just evicted. So corral
churn ≈ (late rate × grace window), bounded; compaction is amortized cheap,
worst-case bounded.

---

## §C — The unifying protocol

_Original draft: pond-ts library agent (Claude)._

§A and §B are not two threads. Both demand the same thing: **the live
boundary protocol should be structural/columnar, not per-row-`Event`.**

Once the boundary vocabulary is structural deltas —

```text
appendRun(chunk)      // the fast path: a whole batch as one columnar run
insertLate(run)       // a sorted mid-stream insert (corral admission)
dropRange(n)          // retention eviction of the oldest n
compact(corral->run)  // watermark: fold late rows into main runs
```

— both wins fall out of one substrate:

- **Output side (§A):** listeners consume these deltas (a `TimeSeries`
  window per run, an explicit late-insert, an explicit drop) instead of N
  synthesized `Event`s.
- **Reduce side (§B):** `LiveReduce` consumes the same deltas, so eviction
  stops being identity/FIFO guesswork — `dropRange` and `insertLate` are
  unambiguous. That ambiguity is exactly where PR #170's reducer bug lived:
  the per-row protocol couldn't say "this evict removed the _sorted-prefix_,
  not the oldest _arrival_."

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
