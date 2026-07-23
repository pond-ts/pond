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
