# `byColumn` — value-axis aggregation (design note)

**Status:** accepted, building. The design-note the geo/fit RFC (`docs/rfcs/geo.md`
§13) committed `byColumn` would get before its PR. Drives the estela / `@pond-ts/fit`
experiment's headline friction (F-geo-2, confirmed ×3).

## Problem

`aggregate(sequence, mapping)` and `rolling(window, mapping)` bucket only the
**temporal key**. estela repeatedly needs to bucket over a **value column**:

- per-km splits + elevation-vs-distance profile → bucket over cumulative
  distance (a derived, **monotonic** column);
- power distribution (time per 25 W bin) → bucket over the **power** value (a
  **non-monotonic** column) by even width;
- FTP zones (time per Coggan zone) → bucket over power by **explicit edges**.

All three are "group rows by which value-bin they fall in, then reduce each
bin." Today they're hand-rolled array walks.

## API

```ts
series.byColumn(
  col,                                  // numeric column whose value defines the bin
  { width, origin? } | { edges },       // binning
  mapping,                              // same AggregateMap as aggregate / reduce
): Array<{ start: number; end: number } & ReduceResult<S, Mapping>>
```

`byColumn` is to `reduce` what `aggregate` is to a single bucket: `reduce`
collapses the whole series to one record; `byColumn` collapses **each value-bin**
to one record. The result is an **ordered array of bin records**, each carrying
its `[start, end)` range plus the mapped aggregates.

**Why an array, not a `TimeSeries`** (owner decision, 2026-06-15): value-bins
(distance / power ranges) are genuinely not time-indexed, and pond's keys carry
time semantics (`Time.toDate()`, `timeRange()`, `asTime`). Returning a
`TimeSeries` keyed by a value-range would make those time operations silently
nonsensical. An array of `{ start, end, ...aggregates }` is honest, matches what
estela hand-rolls, and mirrors `reduce`'s plain-record return. If real
composition friction (e.g. `rolling` over the bins) shows up later, a dedicated
numeric-bin key kind can be reconsidered then — it is the larger change.

## Binning

- **`{ width, origin? }`** — even-width bins. `origin` defaults to `0`; bin index
  for value `v` is `floor((v - origin) / width)`. Bins are emitted
  **contiguously** from the lowest to the highest occupied bin (interior empty
  bins included, so a histogram / profile has no gaps). `start = origin + i*width`,
  `end = start + width`. Monotonic source → the occupied bins are contiguous
  index ranges (splits / profile); non-monotonic → a histogram.
- **`{ edges }`** — explicit ascending edges `[e₀, e₁, …, eₙ]` → `n` bins, bin `i`
  = `[eᵢ, eᵢ₊₁)`. One record per bin, in order. A value `< e₀` or `>= eₙ` is
  **out of range** and its row is dropped (mirrors `aggregate`'s `range`).

## Row exclusion

A row is dropped from binning (contributes to no bin) when its `col` value is
**missing or non-finite** (can't be placed), or — for `{ edges }` — **outside**
`[e₀, eₙ)`. Within a bin, the **reducer non-finite policy** applies as usual to
the _source_ columns (non-finite source values are skipped per
`docs/notes/reducer-nan-policy.md`). Empty bins emit each reducer's empty value
(`count` → 0, `avg`/`min`/… → `undefined`), exactly like an empty `aggregate`
bucket.

## Reuse / implementation

Reuses `normalizeAggregateColumns` (mapping → `{ output, source, reducer, kind }`
specs), `bucketStateFor` (one state per (bin, output column); each row `add`s its
source value to its bin's states), and the columnar store reads
(`Column.read(i)`, no event materialization). One pass over `col` to assign bin
indices (O(1) per row for `width`, O(log E) binary search for `edges`), one pass
per source column to scatter into per-bin states, then snapshot each bin. Linear
in rows × mapped columns. Same two regimes (monotonic / non-monotonic) run the
identical scatter code — the bin index is just `floor` vs binary-search.

## Validation

- `col` must name a `number`-kind column.
- `{ width }`: `width` finite and `> 0`; `origin` (if given) finite.
- `{ edges }`: length ≥ 2, strictly ascending, all finite.
- Empty series (or all rows dropped) → `[]`.
