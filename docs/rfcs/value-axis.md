# RFC: The value axis — non-time x in pond-ts (analytics + visualization)

> **Status:** draft, for red-team. **Not a commitment** (see CLAUDE.md →
> Strategic RFCs). This explores whether a non-time x-axis _belongs_ in
> pond-ts and, if so, the shape it should take across the analytics core
> and the chart layer. Phases adopted into PLAN.md become the contract;
> the rest is forward-looking context.
>
> **Original draft:** the pond-ts library agent (Claude), prompted by
> pjm17971 (estela's time-and-distance need + the value-axis work already
> landed in core). Review layers from the estela / geo / core agents are
> appended as new sections — _layer, don't rewrite_ (per `streaming.md`).

## 1. The question, and the bar it has to clear

estela visualizes activity data over **both time and distance** — pace and
HR over distance, per-km splits, laps, an elevation-vs-distance profile. The
chart layer (`@pond-ts/charts`) is **time-locked**: `ChartContainer` owns a
single `scaleTime`, every row shares it, the x is wall-clock. That was a
deliberate early simplification.

So: does a non-time x-axis belong here? The bar is not "is it useful"
(obviously, for estela). The bar pjm17971 set is **elegance** — it has to
_emerge from pond's existing grain_, not be grafted on. If it reads as a
foreign feature bolted to a time-series library, it doesn't belong, however
useful.

The thesis of this draft is that it clears that bar **because the analytics
core already crossed this line** — comprehensively, and before the chart did.
The non-time axis is not a new concept we're proposing; it's a concept pond
_already has_ that the chart hasn't caught up to.

## 2. It already belongs: the analytics side shipped it

Two operators, already merged, are the value-axis analogues of the temporal
ones — and the core's own JSDoc names them exactly that:

- **`byColumn(col, spec, mapping)`** — _"value-axis aggregation. Where
  `aggregate` buckets the temporal key, `byColumn` buckets rows by the value
  of a numeric column and collapses each value-bin to one record."_ Returns
  `Array<{ start, end, ...aggregates }>` — value-interval records, **not a
  `TimeSeries`, "because value-bins (distance / power ranges) are not
  time-indexed."** Binning modes: even `{ width, origin }` or explicit
  `{ edges, inclusive }`. The documented use cases _are estela's_: **per-km
  splits, the elevation-vs-distance profile, power/HR zones, distributions.**
- **`rollingByColumn(col, { radius, at? }, mapping)`** — _"the value-axis
  analogue of `rolling`."_ A centered sliding window along a value axis,
  one record per row (positionally aligned, zip against the axis column).
  And it already takes **`{ at }` — "a non-decreasing array of explicit
  center values (e.g. a chart's coarse display grid)"** — i.e. the core
  author pre-wired the chart-reduces-over-a-value-axis use case.

Both **require a non-decreasing numeric column** and enforce it (a descending
step throws). Both reduce with the same validated reducer mapping the temporal
operators use.

Read that back: the value axis is not hypothetical in pond. It is a **shipped,
load-bearing concept in the analytics layer**, with splits / profiles / zones
as first-class documented outputs and a chart display-grid hook already in the
API. The only layer still asserting "x is time" is the chart. **That asymmetry
— not a missing feature — is what this RFC is really about.**

## 3. Why it generalizes cleanly: ordering vs calendar

The reason the value axis fits rather than fights is worth stating precisely,
because it tells us _what_ to generalize and what to leave alone.

pond's key has always been a **monotonic numeric ordering**. Time (epoch ms)
is the canonical instance, but the machinery splits into two kinds:

- **Ordering-based — works for any monotonic numeric axis.** `bisect`,
  `nearest`, `atOrBefore` / `atOrAfter`, the columnar slice, interval (`[begin,
end)`) keys, count- or radius-windowing, binning a monotone column into
  ranges. None of this needs wall-clock semantics — only an ordering and a
  metric (distance between two axis values).
- **Calendar/clock-specific — genuinely time-flavored.** `Sequence.every('10m')`
  (needs to know what a minute is), timezone-aware tick formatting,
  `scaleTime`'s nice clock-boundary ticks.

A value axis (cumulative distance, accumulated work, depth, elapsed seconds)
**reuses the ordering machinery wholesale** and substitutes value-flavored
bucketing (`byColumn`'s `width` / `edges` — already built) for clock-flavored
bucketing, and value-flavored formatting (`"5.0 km"` — chart side, TODO) for
tz-aware time formatting. That is the whole shape of the change. It belongs
because it is _the concept pond already has, minus the calendar sugar._

## 4. The data model — largely settled by the core's grain

There is a real fork here, and pond core has already chosen a side. The two
candidate models:

- **(A) Value-as-key** — re-key a `TimeSeries` by distance so the key _is_
  distance. Conceptually pure, but it discards the natural (time) key, forces a
  re-sort, and means a series carries one axis when an activity inherently has
  several (time, distance, …).
- **(B) Project onto a designated column** — the series keeps its natural key;
  analytics and the view _project_ onto a monotonic value column. Operators
  take the axis column; output is records.

**Core chose (B), explicitly and twice.** `byColumn` returns `{ start, end, … }`
records "**not a `TimeSeries`, because value-bins are not time-indexed**";
`rollingByColumn` returns positionally-aligned records, "the caller already
has the axis column to zip against." There is no `reKeyBy(column)` and the
returns deliberately avoid pretending value-bins are time.

So the chart should follow the same grain and consume **two existing shapes**,
not invent a third:

1. **Value-interval records** — `byColumn`'s `{ start, end, ...values }[]`. These
   map _directly_ onto the chart's interval marks (`BarChart` / `BoxPlot` /
   `BandChart` already key on `[begin, end)`). A per-km split chart is
   `byColumn('cumDist', { width: 1000 }, …)` → bars over `[start, end)`. **Splits
   and laps are byColumn output rendered as interval marks** — no new data
   concept required.
2. **A raw series + a named monotonic axis-column** — plot `hr` against
   `cumDist` by zipping the `cumDist` column with the values (with
   `rollingByColumn({ at })` for the reduced/decimated form). This is the
   point/line case.

The only genuinely new _data_ glue is a thin **records → plottable adapter**
(the long-standing "pace-axis carry-forward": a `byColumn`/`rollingByColumn`
result is an array of records, and the chart wants to iterate `{ axisStart,
axisEnd, value }`). That adapter is small and belongs in the chart's data
module (`fromValueBins`, alongside `fromTimeSeries`).

## 5. The visualization side

### 5a. x-geometry: widen a type, don't abandon a principle

`ChartContainer`'s `xScale: ScaleTime` generalizes to a **monotonic value
scale** (linear over a value domain; `scaleTime` is the default instance). The
container gains an x-axis _spec_ — which column is the axis (default: the time
key), its `[min, max]` domain, its formatter.

Crucially, the architecture's actual bet — **one shared x-geometry across all
rows** — survives untouched. An activity dashboard sharing a _distance_ axis
(HR, pace, elevation rows all reading the same `cumDist` x; the synced cursor
at 5 km lighting up all three) is the _same model_ as sharing a time axis. We
are widening the **type** of the shared x, not removing the sharing. The early
"x is time" decision was a simplification of this; its value (shared x) is
preserved.

### 5b. Most of the cursor/axis work just shipped is already axis-agnostic

In hindsight, the M4–M5 cursor + axis-format work generalizes into this for
nearly free:

- **`resolveAxisFormat` / `resolveTimeFormat`** already make the x formatter
  pluggable. A distance axis is a value formatter (`'.1f'` → `"5.0 km"`); time
  is the `scaleTime.tickFormat` instance. The split is already there.
- The **cursor is x-_pixel_ based** (`cursorX`, `xScale.invert`). On a value
  axis, `invert` returns a distance instead of epoch-ms; the cursor-time chip
  becomes a cursor-x chip through the same formatter. The flag/staff/dot
  geometry is unchanged (it anchors at `(xScale(x), yScale(value))` regardless
  of what x _means_).

So the new surface area on the chart is smaller than it looks: an x-axis spec,
a value-formatting `XAxis` (sibling of the value `YAxis` we already have), and
the data adapter. The cursor, gutters, sync, and selection come along.

### 5c. x-axis chrome

`TimeAxis` generalizes to an **`XAxis`** that formats value-or-time — the exact
mirror of how `YAxis` already formats an arbitrary value axis. (Symmetry worth
noting: today the _y_ axis is general and the _x_ axis is special-cased to
time; this makes them siblings.)

### 5d. Splits / laps — and a reason to un-park range-editing

A lap or split is an **interval on the value axis** — `[dist_start,
dist_end)` — which is precisely `byColumn`'s `{ start, end }` output and
precisely what bar/box/band marks already render. So:

- **Splits/laps visualization = `byColumn` value-intervals as interval marks.**
- **Editable laps = the range-editing RFC (`#261`, parked) applied to a value
  axis.** Editing a range on a distance axis _is_ editing a split/lap boundary.
  This gives `#261` a concrete, user-born driver and re-prioritizes it from
  "parked" to "companion work."

### 5e. One axis per container

A `ChartContainer` is one shared x. Time-vs-distance is therefore a **per-
container choice** (or a UI toggle that swaps the x-column spec and re-derives
the scale + decimation). We are _not_ proposing a container with a time row and
a distance row — that breaks the shared-x premise, and there's no use case for
it. (A dashboard with both a time view and a distance view is two containers.)

## 6. The decimator is the same plumbing (see `charts.md` perf section)

The performance work and the value axis are **one generalization viewed from
two ends.** The decimator needs to bucket the visible slice over a monotonic
axis into ~`plot_width` buckets; the value-axis chart needs to project, slice,
and scale over a monotonic axis. Same prerequisite: _"what is my x column, its
domain, and the visible slice?"_

Concretely:

- The proposed per-pixel downsampler — referenced in core as `bin(W, reducer)`
  "for the chart per-pixel downsampler" — is the **render-time** reduction.
- `rollingByColumn({ at: displayGrid })` is the **value-axis** render-time
  reduction the core already exposes.

Both ride the same x-projection plumbing this RFC adds. **Build them together:**
the value-axis x-spec is the decimator's prerequisite, and the decimator's `bin`
is one of the value-axis chart's scaling tools. Doing one alone pays most of the
cost of the other.

## 7. The one genuinely open question — consolidation vs principled twins

This is the part to _not_ rush, and where I'd most want the red-team.

The core now has **twins**: `aggregate` / `byColumn`, `rolling` /
`rollingByColumn` (and `bin` proposed). As the chart pulls the value axis in,
the tempting move is a unifying **`Axis` abstraction** — the temporal key _or_ a
designated monotonic column, carrying its own monotonicity guarantee and
metric — that `aggregate` / `rolling` / `bin` / `nearest` / the chart all
parameterize over, collapsing the twins into one operator each.

The honest counter-argument is that **the twins may be principled, not
duplication**:

- **Input differs ontologically.** The temporal key _is_ the sorted index;
  `aggregate` exploits that (no validation, it's the storage order). A value
  column is _data that happens to be monotonic_; `byColumn` must validate
  non-decreasing and cannot assume it's the index.
- **Output differs.** `aggregate` → a `TimeSeries` (time-indexed, re-keyable,
  chainable). `byColumn` → records (`{ start, end, … }`, deliberately _not_
  time-indexed). A unified operator would have to return one or the other and
  lie about half its uses.

So the difference in _both_ input (index vs column) and output (series vs
records) suggests the twinning reflects a real seam in the model, not an
accident waiting to be DRY'd away.

**Recommendation (the "not rushed" part):** build the chart on the **existing**
value-axis outputs — which requires _no_ resolution of this question — and
**defer the operator-surface consolidation** until a third axis-projection (or
sustained friction from the twins) earns it. Unifying on spec, before the chart
has even consumed what exists, is exactly the kind of premature elegance that
ages badly. Let the evidence accumulate; the chart doesn't block on it.

## 8. What this unifies (it is not a new island)

- **The "wall-clock vs relative/elapsed-time axis" backlog item** (charts axis
  backlog) — elapsed-seconds-from-start is a value axis; subsumed here.
- **geo F-geo-2 distance bucketing** — shares `byColumn` / `bin`.
- **The pace-axis carry-forward** (records → plottable) — lands here as the
  data adapter.
- **Splits/laps + range-editing `#261`** — value-interval marks + editable
  ranges on a distance axis.

The value axis is the keystone several pending threads already lean on.

## 9. Non-goals

- **Not 2D.** A value x is still a single shared 1-D axis. Scatter's 2D-nearest
  cursor (deferred from the cursor RFC) remains its own, separate question; this
  does not address or require it.
- **Not arbitrary non-monotonic x.** Monotonic-non-decreasing is the contract
  (`byColumn`/`rollingByColumn` already enforce it; the chart slice/cull/cursor-
  snap all assume it). Lap-_relative_ distance (resets each lap) is not a valid
  global x — laps are intervals on _cumulative_ distance.
- **Not generalizing the calendar.** `Sequence.every('10m')` stays time. Whether
  a value-step sequence is wanted (e.g. centers every 1 km) is a separate,
  optional question — `byColumn({ width })` likely already covers the need.
- **Not re-keying `TimeSeries` by value** (§4 — core chose records).
- **Not a commitment.** A direction to test.

## 10. Tentative phasing (friction-driven — not a roadmap to march)

1. **Chart x-geometry generalization** — `ScaleTime` → monotonic value scale;
   an x-axis spec (axis column + domain + formatter, default = time key); the
   value-formatting `XAxis`; the `fromValueBins` adapter for `byColumn` records.
   Reuses the shipped cursor + axis-format work.
2. **The decimator** (`bin` / `rollingByColumn({ at })`) on the same plumbing.
3. **Splits/laps marks**, then **lap editing** (range-editing `#261` on the
   value axis).
4. **(Deferred)** operator-surface consolidation — only if §7 earns it.

## Open decisions (for the red-team)

- **Data model** — confirm records / series-against-a-column (not re-keying) is
  right for estela's actual data shape. _[estela]_
- **x-spec API** — how the chart names its axis column + domain + formatter, and
  how `time` stays zero-config default. _[library]_
- **`bin` vs `byColumn`** — is the per-pixel `bin` just `byColumn` with a
  plot-width-derived `width`/`edges`, or a distinct render-time primitive?
  _[geo / library]_
- **Consolidation** — `Axis` abstraction vs principled twins (§7). Defer? _[core
  / library]_
- **Value-step `Sequence`** — needed, or does `byColumn({ width })` cover it?
  _[core]_
- **One-axis-per-container** — acceptable for estela's dashboards? _[estela]_
- **Naming** — "value axis" (matches `byColumn`'s `value-axis` vocabulary) vs
  "domain" vs "monotonic axis."

---

## Review — estela agent (use-case) _[to fill]_

_(append findings here; layer, don't rewrite)_

## Review — geo agent (F-geo-2 / `bin`) _[to fill]_

## Review — core / library _[to fill]_

## Amendments — original author _[to fill after reviews]_
