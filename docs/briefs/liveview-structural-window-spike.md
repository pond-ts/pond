# Brief: structural zero-copy window spike (§A increment 2)

**Status:** spike plan — increment 2 of the §A pull/read cut. Increment 1
([#179](https://github.com/pjm17971/pond-ts/pull/179), shipped experimental
in 0.19.0) gave the **allocation-skip**: `LiveView.column()` gathers from the
view's `Event[]` each tick, skipping the intermediate `TimeSeries` + the
per-partition `TimeSeries`, but still _builds_ a fresh typed array per tick.
Increment 2 closes the rest: **true zero-copy** — read columns straight off
the chunked store's existing typed-array chunks, no per-tick build, no event
materialization. Does not merge without an API sign-off (new public read
surface). Sibling: [`column-on-liveview-spike.md`](column-on-liveview-spike.md).

## Why this, why now

The dashboard A/B (report in `LiveView spike A-B report.md`) confirmed
increment 1's win is the _gather delta_ (≈1.5–2× at its scale), and flagged
the ceiling: for **zero-copy ingest→canvas** the substrate work matters more
than the surface alone. Increment 1's own brief named the wrinkle: even a
chunked-backed `LiveSeries`, when you call `.window('5m')`, **materializes row
events** into the `LiveView`'s `#events`, so `column()` there is a build, not
a read. Increment 2 is the structural change that removes that materialization
for the chunked path.

## The consumer (be precise about which path benefits)

True zero-copy applies to **charting the raw metric stream off a top-level
strict time-keyed (chunked-backed) `LiveSeries`** — `liveSeries.window('5m')`
→ column read → canvas. It does **not** apply to the dashboard's _baseline_
bands: those come through `rolling().collect()`, which is `Event[]`-backed
(`collect()` hard-sets `__backing: 'array'`). Making the rolling/collect
output columnar is a strictly bigger, separate follow-on — out of scope here.
So increment 2's win lands on the raw-line path; the baseline path keeps
increment 1's allocation-skip.

## Design — read-through windowed columnar read

The chunked store (`ChunkedColumnarLiveStorage`) holds `ColumnarStore[]`
chunks (typed-array columns + keys), zero retained `Event`s. A window is a
row range `[startIdx, endIdx)` over those chunks:

1. **Resolve the window** — `'5m'` → first index whose `begin >= latest − ms`
   (bisect over the store's keys, which are sorted); a count window → last N.
2. **Slice the chunk range** — the boundary chunks get a zero-copy
   `sliceByRange`; middle chunks stay whole. The result per column is a
   **`ChunkedColumn`** (Phase 1) over those segments — references the existing
   buffers, **no copy**. `toFloat64Array()` then concats once (a memcpy of
   contiguous typed arrays) or is genuinely zero-copy when the window lands in
   a single chunk. The key axis comes back as a `TimeKeyColumn` the same way.
3. **Read-through, not a buffer** — the read computes against the source's
   _current_ chunk store on demand. No event mirror, no separate window
   buffer. Pair with `useLiveVersion` for React invalidation (already shipped).

The win vs increment 1: increment 1 is `N × Event.get()` per column per tick
(plus the event objects); increment 2 is a typed-array concat (or a slice) and
**zero events**. Expect a multiple faster on the gather, and flat heap.

## The decisions the spike must resolve

1. **Where the read surface lives (the crux).**
   - **(a)** On `LiveSeries` directly — `liveSeries.windowColumns(size)` (or
     reuse `column()`/`keyColumn()` with a window arg) returning a small
     read object with `keyColumn()` / `column(name)`. Smallest surface;
     read-through.
   - **(b)** Make `LiveView` structural when its source is chunked — i.e.
     `liveSeries.window('5m')` returns a view that holds chunk-slices instead
     of mirroring events. Cleanest call-site parity with increment 1, but
     `LiveView`'s event-mirror is load-bearing for every non-chunked path, so
     this is the biggest rework / highest risk.
   - **(c)** A dedicated `LiveColumnWindow` read type.
   - **Spike rule:** lead with (a)/(c) (read-through, contained). Only attempt
     (b) if it falls out cleanly; the event-mirror must keep working for
     filter/map/reorder/collect sources.

2. **Substrate gap — windowed multi-chunk slice.** Add to
   `ChunkedColumnarLiveStorage` a `windowColumns(startIdx, endIdx)` (keys +
   each column as a `ChunkedColumn` over the chunk slices) — generalize the
   existing `#evictExact` boundary-slice logic to a non-mutating `[start,end)`
   read. Verify the boundary slice is zero-copy and the multi-segment
   `ChunkedColumn` round-trips through `toFloat64Array()` correctly.

3. **Window resolution.** Reuse `LiveSeries`'s key bisect (or add a
   `beginAt`-bisect on the store) to map `'5m'` / count → `[startIdx, endIdx)`.

4. **Non-chunked fallback.** For `Event[]`-backed sources (collect, reorder,
   interval, internal), the structural read isn't available — fall back to the
   increment-1 gather, or surface "not chunked-backed" clearly. Decide which.

## Scope guards — what the spike does NOT touch

- **Chunked, strict, time-keyed only** — the exact case the chunked storage
  serves. Other backings keep increment 1 (or are unsupported).
- **No columnar `collect()` / `rolling()` output** — the baseline-path
  zero-copy follow-on is separate and bigger.
- **No §B** (reorder / corral). Append-only.
- **No change to `LiveView`'s event-mirror** for the non-chunked paths.

## Measurement (the spike is not done without numbers)

1. **In-pond bench** (`scripts/perf-liveview-structural.mjs` or extend
   `perf-liveview-columns.mjs`): windowed column read off a chunked store
   (concat / slice) vs increment 1's event-gather, at the dashboard cells.
   Confirm: a multiple faster on the gather, and **zero `Event` allocated**
   end-to-end (heap delta, in process isolation — the in-pond gauge caveat
   from `perf-live-columnar.mjs` applies).
2. **Dashboard A/B** — the raw-metric chart path (not the baseline), via the
   harness the dashboard agent kept.

## API gate (do not skip)

A new windowed columnar read surface on `LiveSeries` (or a new view type)
widens the public live surface — human sign-off + Layer-2 + a Codex pass, as
with increment 1. Experimental (0.19.x); surface may change.

## Increments

1. **Spike** (this brief): the store's `windowColumns` + a read-through
   surface (decision 1) + in-pond bench, on a branch. Resolve the decisions.
   No merge (API gate).
2. **Dashboard A/B**: raw-line path, reported back.
3. **If the win lands**: human sign-off → real implementation → PLAN entry.

## Cross-references

- [`column-on-liveview-spike.md`](column-on-liveview-spike.md) — increment 1
  (allocation-skip), shipped in 0.19.0 via #179.
- [`column-native-live-pipeline.md`](column-native-live-pipeline.md) — the
  chunked backing this reads from.
- `packages/core/src/live/live-chunked-storage.ts` — `ColumnarStore[]` chunks,
  `sliceStore`, boundary-slice eviction (the read generalizes this).
- `packages/core/src/columnar/` — `ChunkedColumn` + `concatSorted` (the
  multi-segment column the windowed read returns).
