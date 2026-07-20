# Performance expectations and the bench-vs-real-world gap

> Moved from PLAN.md on 2026-07-20 (PLAN reorganization). Durable design note;
> the documentation deliverable it names is tracked as [PND-OBSDOC] in
> [PND_DOCS_PLAN.md](../plans/PND_DOCS_PLAN.md).

A design note worth pinning, surfaced concretely by the gRPC
experiment's M3 milestone.

The library benchmark publishes peak throughput numbers (e.g. **538k
events/sec at P=100, N=10** in the multi-partition rolling
benchmark). These numbers are **achievable iff the caller hands
`pushMany` arrays of N events**. Per-event sources without wire
batching see roughly an order-of-magnitude less:

| Scenario                                                    | Effective throughput                            |
| ----------------------------------------------------------- | ----------------------------------------------- |
| Library bench, `pushMany([...N events])`, N=10              | **538k events/sec**                             |
| Per-event push (`live.push([row])` once per source event)   | ~70k events/sec end-to-end (gRPC framing-bound) |
| Macrotask-coalesced `pushMany` over a per-event gRPC stream | ~73k events/sec (+7-17%); avg batch 1.4 events  |
| Wire-level batched `pushMany` (estimated)                   | 200-400k events/sec                             |

The gap is **wire-shape, not pond**. gRPC delivers one event per
`'data'` callback; `setImmediate`-based coalescing rarely catches
more than the event that triggered the schedule. To approach library
peak with a real network source, the **producer must batch at the
wire** (e.g. `stream EventBatch { repeated Event }` in proto, with
the producer accumulating 1-10ms of events per frame and the
aggregator unpacking into a single `pushMany`).

**Documentation implication:** the benchmarks page (and the README's
"performance" section) should grow a one-paragraph callout that
frames the bench numbers honestly:

> _Pond's bench numbers reflect what's possible when the caller hands
> `pushMany` an array of N events. If you're forwarding from a
> per-event source — gRPC `'data'` callbacks, EventSource frames,
> message-broker `qos=1` subscribers — your effective throughput
> depends on whether the wire layer batches. Per-event forwarding
> typically reaches ~14% of the bench peak; producer-side wire
> batching can recover most of the gap. The
> [gRPC experiment's M3 friction notes](link) show this in detail._

Worth doing alongside the docs-backlog pass above — same MDX
deploy.

**`@pond-ts/server` implication:** the eventual server package
should ship a `coalesce({ windowMs })` strategy with a tested
default, plus a reference `EventBatch`-style proto in examples.
Both surfaced as M3 friction-note carry-forwards. Captured here so
the M5 RFC starts with these pre-baked rather than re-discovering
them.

**What this is NOT:** a deficiency in pond. The bench numbers are
real; `pushMany` is the right primitive; the wire-shape consideration
is inherent to network-bound architectures. Documenting the
expectation is the deliverable, not optimisation work.
