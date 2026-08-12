# Design principles and semantics to preserve

> Moved from PLAN.md on 2026-07-20 (PLAN reorganization). These are evergreen
> rules that hold across all new work — keep this file current if a principle
> changes.

These hold across all new work:

- **`TimeSeries` stays immutable.** Live mutation belongs in `LiveSeries`.
- **Schema types flow through every operation.** New methods must produce typed
  output schemas. If a method can't be typed, it shouldn't ship.
- **Half-open `[begin, end)` bucketing.** All sequence-based operations use this
  convention.
- **Alignment is separate from aggregation.** `resample` composes them; it
  doesn't merge them.
- **Transforms are views or accumulators.** If an operation needs only per-event
  or carry-forward state, it's a `LiveView`. If it needs a growing buffer
  (buckets, sliding window), it's an accumulator. Both implement `LiveSource`
  for chaining.
- **Data is the clock.** Bucket close, watermark advance, and window eviction
  are all driven by event timestamps, not wall-clock timers.
- **No background timers or implicit scheduling.** The caller owns the event
  loop. The library is a data structure, not a framework.
- **Browser-safe by default.** Node-specific APIs go behind a separate entry
  point.
- **Bulk paths read columns, never events.** `series.events` is consumer
  ergonomics at the edges, not a data plane: it materializes an `Event` (plus
  a data object per `data()` call) per row, which at scale costs more than
  the operation being fed (PR #536: ~400 ms of a ~569 ms 1M-row SMA was the
  `events` walk). Operator implementations, derived-data plumbing, and
  anything else that touches every row reads the columnar store —
  `column(name)`, key buffers, validity — and new operators build output via
  trusted construction with a documented fallback, following the
  `tryAggregateColumnarTimeKeyed` / `tryRollingCountColumnarNumeric`
  pattern. An `events.map(...)` in an operator body or a downstream
  package's hot path is a bug even when the tests pass.

## Selection is a mark, not a recolour of the data

**A live mark must not be shown by changing the colour that carries the value.**
Selection and hover draw in the _annotation_ register — an edge, an outline, an
inset accent — and leave the datum's own colour alone.

Two layers arrived at this independently, which is what makes it a rule rather
than a preference:

- **`<HeatMap>`** refuses to swap a cell's fill for a highlight, because on a
  heat map the colour _is_ the datum — replacing it erases the reading the chart
  exists to give. A live cell takes an outline instead ([PND-HEATMAP]).
- **`<BarList>`** marks a selected row with an inset accent edge and leaves the
  magnitude bar its data colour.

Observed from the outside by the estela agent, whose hand-built list recoloured
the whole bar on select and which is adopting the convention after seeing it:
"selection is a mark, not a data recolour — arguably the cleaner one."

The corollary is the test: **if a reader could mistake the live treatment for a
different value, it is wrong.** That is why `<HeatMap>`'s hover is an outline
rather than an alpha pop — dimming a cell shifts where the reader places it on
the colour scale, which is the same error in a quieter form.

The one deliberate exception is `binColors`, where each bar's _own_ fill pops
for both states so a red/green volume bar keeps its meaning while live. That is
a recolour of intensity, not of hue — the value's identity survives it.

## Semantics to preserve

### Half-open bucketing

For sequence-based bucketing and alignment, interval membership is half-open:
`[begin, end)`. Example: times `10`, `15`, `20` in bucket `[10, 20)` includes
`10` and `15`, excludes `20`.

### Alignment sample position

- default: `begin`
- optional: `center`
- `end` is intentionally not a target mode

### Temporal selection vocabulary

Keep these distinct:

- `within(...)` = fully contained
- `overlapping(...)` = intersects, no key modification
- `trim(...)` = intersects and clips key extents
