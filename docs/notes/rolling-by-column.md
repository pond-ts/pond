# `rollingByColumn` — windowed aggregation over a value axis (design note)

**Status:** building (estela wave PR 1). The sliding-window sibling of
`byColumn`. Drives estela's headline remaining friction — the "window/scan over
a derived monotonic axis" digest (4 votes, HIGH), specifically its **#1**
instance, `geo.rollingSpread` (the zoom-stable variance band).

## Problem

`byColumn(col, binning, mapping)` (shipped 0.27) collapses rows into **disjoint
value-bins** — the value-axis analogue of `aggregate`. estela adopted it
byte-for-byte for splits-profiles / power-histograms / zones. What's still
hand-rolled is the **sliding-window** case over the same kind of derived
monotonic axis:

- `geo.rollingSpread` — at each point, p5/p95 + p25/p75 of the raw samples
  within a **fixed ±120 m window of cumulative distance** (`SPREAD_RADIUS_M`).
  A _centered window_ reduced per position — not disjoint bins. Two-pointer in
  app code today.

This is to `rolling` what `byColumn` is to `aggregate`: `rolling` windows the
**temporal key**; `rollingByColumn` windows an **arbitrary monotonic value
column**.

## Scope — what this is and is NOT

estela's "windowed over a derived axis" digest is really three shapes; this note
covers only the first:

- **#1 fixed-window reduce** (`rollingSpread`) → **this primitive.**
- **#2/#3 extremal-window sweep** (`bestEffortsByDistance`, the power curve —
  "best mean over windows of each of many lengths") → a _different_ primitive
  (mean-maximal / best-effort sweep). estela rates it **low urgency** (the
  prefix-sum two-pointer is fine). Deferred; not this PR.
- **#4 stateful scan** (`splitsByDistance` — hysteresis reference + carryover
  boundary carried across bins) → estela explicitly _"flagging the boundary,
  not asking for a fix."_ Out of scope (a running fold, not a window).

## API

```ts
series.rollingByColumn(
  col,                 // numeric, MONOTONIC NON-DECREASING axis column
  { radius },          // centered window half-width in the axis's units
  mapping,             // same AggregateMap as aggregate / byColumn
): Array<ReduceResult<S, Mapping>>
```

Returns **one record per row, positionally aligned with the series** (`out[i]` =
the mapped aggregates over the window centered at `axis[i]`). Length ===
`series.length`.

## Why a positional array (not a TimeSeries, not `{start,end}` records)

- **Per-row, not per-bin.** Unlike `byColumn` (which collapses to bins), the
  windowed reduction yields exactly one record per input row. So it could be a
  `TimeSeries` (keys preserved). It is NOT one in PR 1, deliberately: that form
  needs a column-append mechanism (`fromTrustedColumns`, PR 2 of this wave), and
  keeping PR 1 standalone matches the agreed build order (1 → 2 → 3). Once PR 2
  lands, the TimeSeries form is a free additive follow-on (attach the array's
  columns onto the source series).
- **No reserved-name tax.** byColumn reserves `start`/`end` in every record for
  the bin range. The windowed output is positionally aligned with the source, so
  the caller already has `axis[i]` — no need to carry it in the record, no
  reserved-name collision. Record `i` is just `ReduceResult` (the aggregates).
- **Familiar.** estela already consumes `byColumn`'s array; a positional array of
  the same reducer outputs is the same idiom.

## Window semantics

- **Centered, inclusive both ends.** The window for position `i` is every row `j`
  with `axis[i] − radius ≤ axis[j] ≤ axis[i] + radius`. Centered (not trailing
  like temporal `rolling`) because the use case is a symmetric spread band; the
  `{ radius }` spec makes "centered" explicit at the call site, so the shared
  `rolling` root doesn't mislead.
- **Monotonic-axis requirement.** `col` must be **non-decreasing**. This is the
  real constraint that makes it a _window_ (vs `byColumn`'s order-free group-by)
  and enables the O(n) two-pointer. Validated up front; a descending step throws
  `RangeError` naming the first offending row. (estela's `cumDist` and every
  other axis in the digest are monotonic.)
- **Missing / non-finite axis cells** can't be placed in the ordering → a row
  with a missing/non-finite `axis` value is **excluded from every window**, and
  its own output slot gets each reducer's **empty snapshot** (fresh per row, so
  array-kind reducers don't alias one `[]`). The result stays positionally
  aligned with the series (length === `series.length`). Within a window, the
  reducer non-finite policy applies to the _source_ columns as usual.

## Reuse / implementation

Mirrors `computeByColumn` (`batch/by-column.ts`): reuse
`normalizeAggregateColumns` (mapping → specs) and `bucketStateFor`, read straight
off the columnar store (`Column.read(i)`, no event materialization). The one
structural difference: a window is a _moving_ multiset, so reducer state needs
`add` **and** `remove` as the window's two pointers advance — i.e. it reuses the
same `rollingState()` factory the live `rolling` path uses (monotone-deque /
sorted-array removal), NOT the append-only `bucketStateFor`. Percentiles
(`median`, `p5`/`p95`/`p25`/`p75`) remove by value (sorted array) — order-
independent, correct for the two-pointer. **This is the same removal contract the
live reorder assessment flags** (`docs/notes/live-columnar-assessment-2026-06.md`):
any reducer used here must have a correct `remove`. Window/extrema reducers
(`min`/`max`/`first`/`last`) remove by _arrival index_ — fine here because the
two-pointer evicts in axis order, which for a sorted axis IS arrival order.

Complexity: **O(n)** for the two-pointer sweep (lo/hi each advance ≤ n total) ×
the per-step reducer `add`/`remove` cost (O(log w) for percentile's sorted
array, w = window occupancy). One pass, no event materialization. Perf check
(`scripts/perf-rolling-by-column.mjs`) before merge per CLAUDE.md.

## Validation

- `col` names a `number`-kind column; the column is non-decreasing.
- `radius` finite and `> 0`.
- Empty series → `[]`.
- A degenerate window (single row, or all rows within `radius`) reduces over
  exactly the in-window rows — no special-casing.

## Deferred (noted, not built)

- **Arbitrary query grid.** `rollingSpread` is evaluated at the chart's _bucket_
  positions, windowing the _raw_ samples — query points ≠ data rows. PR 1
  evaluates at data rows (call it on the raw series, downsample after; or on the
  bucketed series for a coarser band). An explicit query-positions argument is
  the extension if the per-row form proves insufficient on adoption.
- **Trailing / asymmetric windows** (`{ width, align }`, `{ before, after }`) —
  add only if a use case earns them; `{ radius }` is the demonstrated need.
- The **sweep** (#2/#3) and **scan** (#4) primitives above.
