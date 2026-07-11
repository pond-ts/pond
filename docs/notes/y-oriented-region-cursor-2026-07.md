# Y-oriented region cursor (horizontal histograms) — follow-up note (2026-07-11)

Parked after the region-cursor value-axis + histogram wave (#424, #425).
Direction: **park, don't build** — pjm17971 reviewing the histogram
bin-snap, 2026-07-11. Captured here so the design context survives.

## What shipped, and the gap it leaves

The region cursor (`cursor="region"` + `onRegionSelect`) is a **vertical
band** that selects a range on the **shared x axis**:

- Step 1 (#424) — ungated it from time-only to time **or** value, and made
  the payload a neutral `[lo, hi]` (`Layers.tsx:337` drag-start gate,
  `Layers.tsx:743` render gate).
- Step 2 (#425) — a `<BarChart>` publishes its bar `[begin, end)` spans as
  snap buckets (`binIntervals`, `context.ts:398`/`:486`), and the container
  snaps the region cursor to them (`ChartContainer.tsx:774` `cursorBuckets`,
  bins fallback at `:800`). A vertical histogram now drag-selects bar by bar.

**The gap: a horizontal histogram doesn't snap.** `binBuckets` returns
`null` for `orientation !== 'vertical'` (`BarChart.tsx:373`). That's
deliberate and correct — a horizontal histogram (e.g. `HeartRateZones`,
`Histogram.stories.tsx:289`) puts the **value/count on x** and the **bins
on the y axis** (the zone labels are `<YAxis ticks>` at slot centres
`{ at: i + 0.5 }`). The existing x-band region cursor would select a range
of _counts_ — meaningless. The thing a user wants to select — a range of
**bins/zones** — lives on **y**.

## What building it would take

A **y-oriented region cursor**: a _horizontal_ band dragged up/down the y
axis, snapping to the bin bands on y. It is **not a flag flip** — the whole
region machinery is x/`xScale`-oriented:

- `tracker.ts` `bucketAt`/`regionSpan`/`bandRect` (`:16`/`:43`/`:73`) take
  a scalar coordinate + buckets; they're axis-agnostic _math_, so they'd
  mostly reuse. But everything feeding them is x:
- `regionAnchor` + the pointer handlers in `Layers.tsx` read
  `xScale.invert(px)` and set a `hoverX`; a y-version needs a `hoverY` /
  y-anchor and `yScale.invert(py)`.
- `bandRect` maps the span through `xScale` to a **vertical** rect
  (`{x0, x1}`); a y-band needs a **horizontal** rect (`{y0, y1}`) through
  `yScale`.
- **The load-bearing complication: the y scale is per-row, x is shared.**
  The region cursor rides the container's shared x geometry (one cursor,
  synced across rows). A y-band is inherently per-row. A horizontal
  histogram _stands alone in its container_ (a horizontal chart forces
  `xKind:'value'` and can't share with time rows — see `BarChart`
  orientation docs), so in practice there's exactly **one** row — which
  makes a per-row y-band tractable, but the cursor model still has to grow
  a row-local branch rather than reuse the shared-x path wholesale.
- Payload: `onRegionSelect([lo, hi])` would report the **y-value** range
  (or the ordinal bin range) — a second axis-units meaning on the same
  callback. Worth deciding whether that overloads `onRegionSelect` or wants
  its own `onBandSelect`.

## Why parked

Horizontal histograms are the less-common case; the vertical distribution /
time-in-zone histogram (the one people drag-select) is done. The y-oriented
cursor is a coherent but **moderate** lift that duplicates the x-cursor onto
a per-row y axis, and there's **no consumer asking for it** yet. Flagged
originally in #413 ("a value-band, y-oriented region cursor for horizontal
histograms is a separate feature") and breadcrumbed in the `onRegionSelect`
JSDoc. Build it when a real horizontal-histogram selection use-case arrives;
until then the friction hasn't earned the plumbing.

## Status

Not scheduled. PLAN carries the pointer. Code refs verified at `389870f`.
