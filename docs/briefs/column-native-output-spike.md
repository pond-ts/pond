# Brief: column-native output spike (§A of the columnar-live-protocol RFC)

**Status:** spike plan — the **earned first increment** of
[`docs/rfcs/columnar-live-protocol.md`](../rfcs/columnar-live-protocol.md) §A.
A brief is more concrete than the RFC: this scopes a real spike to run. The
spike itself does **not** merge to `main` without a human API sign-off (it adds
to the public `LiveSeries` listener surface — see "API gate").

## Why this, why now

§A graduated from "deferred until friction" to "earned" because the gRPC
experiment brought a **measured** signal (RFC Review notes §3): at the P=1000 /
N=1000 saturation cell, the aggregator's `fanout.ts` per-`Event` work is

| phase                                           | p99      | % of pushMany |
| ----------------------------------------------- | -------- | ------------- |
| `fanoutRecordMs` (per-event column reads)       | 0.26 ms  | ~30%          |
| `fanoutSerializeMs` (`toJsonRow` + JSON encode) | 0.44 ms  | ~50%          |
| pond's own pushMany                             | ~0.13 ms | ~15%          |

~80% of the per-`pushMany` budget is per-`Event` listener work that runs
**after** pond's own work, plus ~6.7M transient row-object allocations/min.
PR #170 took the _storage_-side `Event` cost to zero on the chunked path; the
_output_-side cost is still paid the moment a consumer subscribes to
`'event'`/`'batch'` (the chunked path calls `materializeEventsFromStore` to
synthesize transient events). §A removes that last materialization.

## Goal

Prototype a **columnar-window listener**: the consumer receives the just-
appended batch as an immutable columnar window (zero `Event` synthesized on the
chunked path), and walks columns directly. Confirm the win against a real
consumer (the gRPC A/B) before any public API lands.

## The decisions the spike must resolve

1. **Payload shape (the open fork from the RFC).**
   - **(a) `TimeSeries<S>`** — gRPC endorses it (they already consume
     `TimeSeries`), reuses the entire chart-extraction column API
     (`Float64Column`, `KeyColumn.at`, `toFloat64Array`, `bin`), zero new
     vocabulary. Risk (Codex, RFC §2.7): must be a genuine zero-copy _view_
     over the chunk's immutable store, not an independent snapshot. The
     trusted-store factory lives on `ColumnarStore`/`SeriesStore` today, **not**
     on `TimeSeries` — so this needs a thin public `TimeSeries`-over-a-shared-
     store path, and the spike must verify it's allocation-free (no column copy).
   - **(b) lighter `LiveRun` / `ColumnarRun` view** — a minimal read-only
     window type (`length` / `beginAt(i)` / `column(name)` / `at(i)` /
     `toTimeSeries()` / `events()`), explicitly "a window view, not a series."
     Smaller surface; avoids implying snapshot semantics.
   - **Spike rule:** lead with (a). If wrapping a chunk store as a `TimeSeries`
     is provably zero-copy and ergonomic, (a) wins (no new type). Fall back to
     (b) only if (a) forces materialization or muddies `TimeSeries`'s
     ownership contract.

2. **Listener name (additive — Q3 is resolved: do NOT change `'batch'`).** The
   columnar listener is the columnar sibling of `'batch'` (fires once per
   `pushMany`). Candidates: `'frame'`, `'run'` (consistent with the RFC §C
   `appendRun` vocabulary), `'block'`, `'columns'`. (`'window'` is out — it
   collides with the retention window.) Pick in the spike; lean `'run'`.

3. **Cross-backing uniformity.** The listener must exist on every `LiveSeries`,
   not only chunked ones. On the chunked backing it hands the chunk's store as
   a window (zero `Event`); on the array backing it wraps the batch (array-
   backed series aren't the throughput case, so materializing there is fine).
   Confirm the API reads uniformly.

## Scope guards — what the spike does NOT touch

- **No §B** (reorder / corral / grace-flush). Strict time-keyed only.
- **No coalescing / re-chunking.** v1 contract stays "one window per
  `pushMany`" (RFC §A tension 1).
- **No change to `'batch'` / `'event'` / `'evict'` payloads.** Purely additive.
- **No columnar `'evict'`** variant yet (follow-up; the measured tax is on the
  append/fanout path, not eviction).
- **No partition-routing migration** (that's the separate Phase 2
  `scatterByPartition` work).

## Measurement (the spike is not done without numbers)

1. **gRPC A/B (the agent offered this).** (i) `Event`-count + minor-GC delta
   with vs without the chunked backing's transient output materialization at
   the saturation cell; (ii) after the listener lands, `fanout.ts` p99 with the
   columnar window (encoder walks columns) vs today's `events.map(toJsonRow)` +
   `JSON.stringify`. Target: the ~0.44 ms serialize tax shrinks materially.
2. **In-pond micro-bench.** Extend `scripts/perf-live-columnar.mjs`: columnar-
   window listener vs `'event'` vs `'batch'` on a batched workload — allocations
   (heap delta) and throughput. Confirm **zero `Event` allocated end-to-end**
   when only the columnar listener is attached on the chunked path.

## API gate (do not skip)

Adding `on('<name>', (window) => …)` to `LiveSeries` widens the **public
listener surface**, and the payload type is a **public type** decision. Per
CLAUDE.md, both require human approval before merge. The spike prototypes on a
branch and reports numbers plus the resolved fork; the human signs off on the
name and payload before it becomes real. Layer-2 adversarial review plus a
Codex pass (the surface touches type definitions) apply as usual.

## Success criteria

- A consumer subscribing **only** to the columnar-window listener triggers
  **no `Event` materialization** on the chunked path (verified in the
  in-pond bench).
- The gRPC A/B shows a material drop in the fanout serialize-path cost.
- Existing `'event'` / `'batch'` / `'evict'` behavior is byte-for-byte
  unchanged (full suite green; the listener is purely additive).

## Increments

1. **Spike** (this brief): prototype listener + payload on a branch, in-pond
   bench, resolve the fork + name. No merge (API gate).
2. **gRPC A/B**: the experiment agent runs the with/without measurement and
   reports into `friction-notes/columnar-rebench.md`.
3. **If the win lands**: human API sign-off → real implementation → a PLAN
   entry (the binding version; this brief + the RFC stay as the "why").

## Cross-references

- [`docs/rfcs/columnar-live-protocol.md`](../rfcs/columnar-live-protocol.md) —
  §A (and the V2 amendment that marks §A earned); §C's `appendRun` vocabulary.
- [`docs/briefs/column-native-live-pipeline.md`](column-native-live-pipeline.md)
  — the brief behind the chunked backing (PR #170) this builds on; its Phase 2
  `scatterByPartition` note is the internal sibling of this output work.
- `packages/core/src/live/live-series.ts` — `#pushManyColumnar` +
  `materializeEventsFromStore` (the transient-output cost §A removes).
- `packages/core/scripts/perf-live-columnar.mjs` — the in-pond bench to extend.
