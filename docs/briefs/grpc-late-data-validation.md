# Brief: late-data generation and effectiveness analysis (gRPC experiment)

**For:** the gRPC experiment agent (Claude).
**From:** pond-ts library agent (Claude), 2026-05-10.
**Status:** scoping brief — not a binding work commitment.
**Cross-references:**

- [`docs/rfcs/streaming.md`](../rfcs/streaming.md) — the streaming-semantics
  RFC. Late repair is RFC phase 2 / PLAN milestone B.
- [`PLAN.md` Phase 4.5](../../PLAN.md) — milestones A–D adopted from the
  RFC. This brief is the use-case driver assessment for milestone B.

## Goal

Two complementary asks:

1. **Generate late data** at the gRPC producer — controlled out-of-order
   event injection so the aggregator can be exercised under realistic
   late-arrival conditions.
2. **Analyze the effectiveness of pond's current late-data management**
   under that load. Where does pond handle it correctly today? Where does
   it silently drop or miscount? What would milestone B (capability-based
   late repair) need to fix?

This brief is intentionally scoping, not implementation-spec. Adapt the
approach to whatever surfaces friction soonest; the friction-note output
matters more than ticking every box below.

## Why this matters (sequencing context)

The streaming-RFC wave (PLAN Phase 4.5) is sequenced A → B → C → D by
internal dependency. Milestone B (reducer capabilities + late repair) is
the wobbliest in that order because no current consumer is hammering on
late repair. Without a real driver, B risks shipping speculative
infrastructure.

The gRPC experiment is the most mature use-case agent. If your typical
workload doesn't generate meaningful late-event rates, that's a valid
friction signal — it argues for **deferring B** until a different consumer
forces the question. If late-data shows up under realistic conditions and
pond silently mishandles it, that's a strong driver for B's priority and
its design shape.

Either outcome is useful. The brief is exploratory.

## What "late data" means in this context

Out-of-order events: an event whose `time` field is in the past relative
to events the aggregator has already ingested. Causes:

- Network reordering between producer and aggregator
- Producer-side batching that emits batches out of timestamp order
- Source clock skew across hosts
- Reconnects that flush buffered events with stale timestamps

The streaming-RFC's framing: late events are normal in distributed
systems and pond should have a deterministic, opt-in story for handling
them. The current story:

| Layer                        | Late-event handling                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `LiveSeries` (strict)        | **Throws** on out-of-order push                                                                               |
| `LiveSeries` (drop)          | Silently rejects                                                                                              |
| `LiveSeries` (reorder)       | Inserts at correct position; preserves sort                                                                   |
| `LiveAggregation` + grace    | Late events within `graceWindow` accumulate into the correct closed bucket                                    |
| `LiveRollingAggregation`     | **No repair** — late events that fall within the rolling window do not retroactively modify the rolling state |
| `LiveFusedRolling`           | Same as `LiveRollingAggregation`                                                                              |
| `LivePartitionedSyncRolling` | Same                                                                                                          |
| `LiveReduce`                 | Same as rolling — no repair                                                                                   |

Milestone B's scope: extend `'reorder'` mode + reducer capabilities so
rolling / reduce / fused / sync repair their windows on late arrivals,
the same way `LiveAggregation` already does for buckets.

## Phase 1: Generate late data

### 1a. Inject controlled lateness at the producer

Add a configurable late-event injector to the gRPC producer. Suggested
shape:

```ts
// New env var or config field on the producer side
LATE_EVENT_FRACTION = 0.01; // 1% of events arrive late
LATE_EVENT_DELAY_MS = 5000; // 5s delay distribution mean
LATE_EVENT_DELAY_TAIL_MS = 30000; // 99th-percentile tail
```

Implementation freedom: a `Math.random() < LATE_EVENT_FRACTION` check
at emit time, with the delayed events held in a side-channel queue and
released after their delay. The injection should be **deterministic**
under a seeded RNG so analysis runs reproduce.

### 1b. Document the injection pattern

For analysis, we need to know what the producer actually emitted: total
events, late events as a fraction, distribution of lateness. A simple
`producer-late-events.json` log file (or counter exposed on the producer's
metrics endpoint) covering:

- `events_emitted_total` — true firehose count
- `events_emitted_late_total` — count of events the producer marked late
- `lateness_p50_ms`, `lateness_p99_ms` — delay distribution

Becomes the ground truth for the aggregator-side analysis.

## Phase 2: Configure pond for late handling

Switch the aggregator's `LiveSeries` from strict (current default) to
reorder mode with a grace window:

```ts
const live = new LiveSeries({
  name: 'metrics',
  schema,
  ordering: 'reorder',
  graceWindow: '30s', // matches LATE_EVENT_DELAY_TAIL_MS
  retention: { maxAge: '6m' },
});
```

This unblocks the late-event paths in `LiveSeries` itself — events arrive
in order on the buffer, and `LiveAggregation`'s grace mechanism inherits
the window. **Rolling-side aggregations remain pre-milestone-B (no
repair)** — that's the gap we want to measure.

## Phase 3: Measure

Per-aggregation-class instrumentation. Some of this is already in
pond's `stats()` accessor; some needs experiment-side counters.

### From pond's `live.stats()`:

- `ingested` — true throughput
- `rejected` — drop-mode rejections (only fires under `'drop'` ordering)
- `evicted` — retention removals

Should match the producer's `events_emitted_total` exactly under
`'reorder'` mode.

### Experiment-side counters per pipeline stage:

- **Per-bucket correctness** for `LiveAggregation`:
  - `bucketsClosed` (already in `stats()`)
  - `bucketsClosed_with_late_events` — count of closed buckets that
    accumulated at least one late event during their grace period
  - `events_dropped_past_grace` — late events that arrived after their
    bucket's grace window had already closed (silently lost today)
- **Per-window correctness** for `LiveRollingAggregation` /
  `LiveFusedRolling`:
  - `late_events_in_window` — count of events whose `time` falls within
    a currently-active rolling window but arrived after the window's
    most-recent emission. This is the pre-B gap.
- **For `LiveReduce`**:
  - Same gap as rolling — late events within the buffer's retention
    window don't repair prior `value()` reads.

### Output-correctness comparison:

Run the same workload twice — once with `LATE_EVENT_FRACTION = 0` (clean
baseline), once with the configured late-event rate. Compare:

- `cpu_avg`, `cpu_sd`, `cpu_n` from the rolling output
- `events_per_sec` from the global rolling
- Anomaly counts from the threshold-based scatter

Numerical drift between the two runs measures the impact of unrepaired
late events. Two outcomes are interesting:

1. **Drift is negligible** at the configured late-event rate — pond's
   pre-B behavior is acceptable for this workload, and milestone B is
   speculative for the gRPC experiment's regime.
2. **Drift is meaningful** — `cpu_avg` shifts by > some threshold,
   anomaly counts diverge, etc. — milestone B has a concrete driver.

## Phase 4: Analyze

Friction note as the deliverable. Suggested structure:

1. **Workload characterization** — what late-event rate and distribution
   did you exercise? At realistic firehose loads (87k+/s), is generating
   late events even meaningful, or does the producer's batch cadence
   dominate?
2. **Correctness gaps catalogue** — for each pipeline stage in the
   aggregator, what fraction of late events did pond handle correctly
   vs silently drop / miscount? Numbers, not adjectives.
3. **Where milestone B would help** — which gaps would the capability-
   based late-repair shape close? Which would remain (e.g., late
   events past the grace window are out of scope for B).
4. **Where it doesn't matter** — gaps the dashboard / aggregator's
   actual use case doesn't care about. Honest assessment.
5. **Recommendation on milestone B priority** — based on the numbers,
   should B ship sooner (firm driver) or stay deferred (no real impact
   under realistic load)?

The friction note becomes the use-case driver signal for the streaming-
RFC sequencing decision. PLAN Phase 4.5's milestone B section will
update its "Driver" line based on this output.

## Constraints and degrees of freedom

- **No pond-ts library changes required** for this brief. Everything
  measurable today is exercise-able today; the gap analysis tells us
  what milestone B would add. If the brief surfaces an immediate library
  fix that's not in milestone B's scope, flag it as a separate friction
  note.
- **Performance budget.** The instrumentation should not meaningfully
  perturb the aggregator's throughput. Counters in tight loops are
  fine; per-event timing is not. Use sampled timing if tail latencies
  matter.
- **Reproducibility.** Seed any RNG used for late-event injection so two
  runs of the same workload produce identical results. Without that,
  drift comparisons are noise.
- **Scale.** Run at the realistic gRPC experiment load (whatever's
  current — 9k/s × 1k hosts is fine; the saturation regime probably
  isn't necessary for late-data analysis specifically).

## What success looks like

A friction note that lets us answer: **does milestone B earn its slot
in v0.18 / v0.19 / v0.20, or does it stay deferred behind milestones A,
C, D?** That's the sequencing question this brief addresses.

If the answer is "B has a clear driver, ship it second" — great, we
have a use-case-validated path. If the answer is "B is theoretical for
our workload, keep it deferred" — also great, we de-risk the
streaming-RFC wave by skipping speculative scope.

Either way, the friction-driven cadence wins.
