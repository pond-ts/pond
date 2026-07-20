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
