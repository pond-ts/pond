/**
 * Strategy types for `sample(...)` chainable operators on live and
 * snapshot surfaces. The actual sampling logic is inline at each
 * call site (LiveSeries / LiveView / LivePartitionedSeries /
 * LivePartitionedView for live; TimeSeries / PartitionedTimeSeries
 * for snapshot) — there's no separate operator class. Stride mode
 * is a closure-captured counter inside a `LiveView`'s `process`
 * function; reservoir mode lives only on the snapshot side.
 *
 * Why no live-side reservoir in v0.17.0: reservoir's Algorithm R
 * replacement produces non-prefix evictions, but the existing
 * live-eviction protocol (`'evict'` event + cutoff-based mirroring
 * in `LiveView`) assumes prefix evictions only. Bridging the two
 * needs an exact-removal eviction channel — likely arriving with
 * the streaming RFC's `LiveChange` model in v0.17.x+. Snapshot-side
 * reservoir is unaffected (single-pass Algorithm R, no eviction
 * concern) and is the canonical visualization shape:
 * `series.sample({reservoir:{size:500}}).toRows()`.
 */

/**
 * Sampling strategy for live (chainable) call sites. v0.17.0 ships
 * stride only; reservoir mode is deferred — see `BatchSampleStrategy`
 * for the snapshot-side superset.
 */
export type SampleStrategy = { stride: number };

/**
 * Sampling strategy for the pre-partition (global) live call sites
 * (`LiveSeries.sample`, `LiveView.sample`). Requires the
 * `unsafeGlobal: true` token so the call site acknowledges the
 * bias-trap risk: a single global counter against a structured
 * input stream (e.g., round-robin host order) silently keeps the
 * same subset of partitions and drops the rest. Chaining
 * `partitionBy(c).sample(...)` instead is safe by construction and
 * doesn't require this token.
 *
 * The bias trap was first surfaced by the gRPC experiment's M3.5
 * prototype (pond-grpc-experiment#33): a stride-10 filter at the
 * gRPC ingest layer, fed a round-robin per-host event stream,
 * silently kept 8 of 80 hosts and dropped 72.
 */
export type GlobalSampleStrategy = { stride: number; unsafeGlobal: true };

/**
 * Sampling strategy for snapshot-side `TimeSeries.sample` /
 * `PartitionedTimeSeries.sample`. Includes both stride and reservoir;
 * batch is single-pass over a known-N events array, so reservoir's
 * Algorithm R has no eviction-protocol concerns and ships in v0.17.0.
 *
 * **Stride** (`{ stride: N }`): keeps every Nth event, uniform-over-
 * time. Cheap, deterministic. Default for "I want my windowed stats
 * to use a thinned stream."
 *
 * **Reservoir** (`{ reservoir: { size: K } }`): K-of-N random via
 * Algorithm R. Single-pass; sorts the result by key to preserve
 * `TimeSeries`'s chronological invariant. Default for visualization
 * (`series.sample({reservoir:{size:500}}).toRows()` gives uncorrelated
 * points — no `aggregate(seq, ...)` grid collapse) and population-
 * level summaries.
 *
 * **When to use which:**
 *
 * | Use case | Stride | Reservoir |
 * | --- | --- | --- |
 * | Sliding-window stats (rolling avg / percentiles) | ✅ default | n/a |
 * | Population summary over the snapshot | ⚠️ regular-spacing | ✅ default |
 * | Visualization (scatter plot, sparkline) | ⚠️ regular-spacing | ✅ default |
 * | Top-K / unique reducers | ❌ misses singletons | ⚠️ also misses |
 *
 * Reducer outputs (`'count'`, `'sum'`, `'samples'`, `topN`)
 * downstream of `sample` reflect the sampled stream, not the source.
 * Multiply by stride / by `N/K` to estimate true counts.
 */
export type BatchSampleStrategy =
  | { stride: number }
  | { reservoir: { size: number } };
