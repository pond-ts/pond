# Brief: column API on `LiveView` spike (§A read/pull cut)

**Status:** spike plan — the **pull/read** sibling of
[`column-native-output-spike.md`](column-native-output-spike.md), both under
[`docs/rfcs/columnar-live-protocol.md`](../rfcs/columnar-live-protocol.md) §A.
The spike does **not** merge to `main` without a human API sign-off (it widens
the public `LiveView` surface and adds a React hook — see "API gate").

## Two cuts of §A — keep them distinct

§A ("the live columnar substrate becomes directly visible") has two
consumer-driven cuts that share substrate but differ in delivery:

|             | Prong 1 — push/output                             | Prong 2 — pull/read (this brief)                                                      |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Consumer    | gRPC aggregator                                   | React dashboard                                                                       |
| Delivery    | listeners **emit** columnar chunks per `pushMany` | caller **reads** columns off a live view on demand                                    |
| Surface     | `on('run', (window) => …)`                        | `liveView.column()` / `keyColumn()` / `partitionBy().toMap()` + a React change signal |
| Measured by | gRPC A/B (P=1000)                                 | dashboard memo delta                                                                  |

Shared substrate: both expose the live buffer's columnar storage as columns.
The spike should reuse the same trusted-store→column path prong 1 uses, so the
two cuts don't diverge into parallel implementations.

## Why this, why now

The dashboard agent's 0.18.0 report ranked this its **#1** ("biggest
architectural unlock"). Today the dashboard hits a forced detour:

```
liveSeries → .window('5m')        LiveView (has the data, no column API)
            → useSnapshot          TimeSeries (column API mounted)
            → memo: snap.partitionBy('host').toMap(g => g.column('cpu').toFloat64Array())
```

The snapshot exists only to provide three things the live side lacks:

1. **Typed-array column gather** — `column()` / `keyColumn()` are `TimeSeries`
   methods; `LiveView` doesn't expose them.
2. **A React-memoizable reference per frame** — `LiveSeries` / `LiveView`
   mutate in place, so their reference is stable across appends and a
   `useMemo([liveView])` never re-runs. The snapshot hands React a fresh
   reference per throttle tick. This is a **correctness** gap, not just perf.
3. **`partitionBy.toMap(g => …)`** that walks per-partition now — lives on
   `TimeSeries`; the live `partitionBy` is subscription-oriented, not
   "walk-the-data-now."

## The honest wrinkle the spike must respect: backing decides the win

"The snapshot isn't really copying" is **backing-dependent**:

| Source the view reads                                              | What column-on-`LiveView` buys                                                                                                                                          |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw `liveSeries.window('5m')` (chunked top-level ingest)           | **true zero-copy** ingest→canvas                                                                                                                                        |
| The collected baseline (`rolling().collect()`, **Event[]**-backed) | **allocation-skip** only — the typed array is still _built_ from events each tick; what's saved is the intermediate `TimeSeries` + N per-partition `TimeSeries` objects |

`collect()` hard-sets `__backing: 'array'` (chunked is for batched top-level
ingest only), so the dashboard's _baseline_ pipeline is Event[]-backed — the
allocation-skip case, not zero-copy. True end-to-end zero-copy for the baseline
would also need the rolling/collect output to go columnar (a strictly bigger
§A follow-on, out of scope here). **The spike must measure both backings and
report which win applies where** — overclaiming "zero-copy" uniformly is the
trap.

Size, calibrated: ~0.4–0.65 ms of the dashboard's 1.3 ms memo at current scale
(the report's own 30–50% estimate); structural at 1M+ events (GC stops scaling
with window length). The 1M+ consumer (gRPC) doesn't use React — so this is a
render-axis **bet**, justified more by correctness (#2) and API consistency
than by a binding frame-budget constraint today.

## The decisions the spike must resolve

1. **Read surface on `LiveView`.** Does `liveView.column(name)` return the same
   `Float64Column | ChunkedFloat64Column` union as `TimeSeries`, narrowed by
   schema? `liveView.keyColumn()`? Confirm it reads uniformly across chunked
   and array backings (zero-copy on chunked, build on array).
2. **Window scoping.** The dashboard wants the 5-min view, not the whole
   buffer. `liveSeries.window('5m')` → `LiveView` → `column()` must reflect the
   _bounded_ range. Confirm the windowed view exposes columns over its slice.
3. **Partition fan-out (the crux).** `liveView.partitionBy('host').toMap(g =>
g.column(...).toFloat64Array())` needs a **walk-now** per-partition read.
   The live `partitionBy` is subscription-oriented today. Options: (a) a
   read-only `partitionBy().toMap()` on the live view that buckets the current
   window into per-partition column views; (b) fall back to snapshotting
   internally (defeats the purpose — reject unless (a) is infeasible). Resolve
   how per-partition column views are produced without per-tick `TimeSeries`
   allocation.
4. **React change signal.** Wrap `liveSeries.on('append' | 'batch', cb)` with
   `useSyncExternalStore`, throttled. `getSnapshot` must return a **changing
   primitive** (an append/version counter), not the mutable view (returning the
   stable object tears). Decide: a new hook (`useLiveColumns`?) vs. refactoring
   `useSnapshot`'s internals onto `useSyncExternalStore` (behavior-identical).

## Scope guards — what the spike does NOT touch

- **No §B** (reorder / corral / grace-flush). Strict, append-only read.
- **Not prong 1** — no `on('run')` columnar-output listener (separate brief).
- **No columnar `collect()` / `rolling()` output.** The spike measures the
  allocation-skip on the existing Event[]-backed collect; making collect output
  columnar (to unlock zero-copy for the baseline) is a follow-on, explicitly
  noted, not built.
- **No change to `useSnapshot` / `useWindow` behavior.** Additive; if their
  internals move onto `useSyncExternalStore`, behavior stays byte-identical
  (full react suite green, incl. the new `test-d/`).

## Measurement (the spike is not done without numbers)

1. **Dashboard A/B** (the dashboard agent runs it). Per-tick memo with vs
   without the live-column read path + `useSyncExternalStore`, at the current
   cell and at a stress cell (256 hosts / 384k events). Target: the report's
   30–50% memo drop at current scale; confirm GC/allocation stops scaling with
   window length at the stress cell.
2. **In-pond micro-bench.** `liveView.column().toFloat64Array()` vs
   snapshot-then-`column()`, on **chunked vs array** backing — heap delta +
   throughput. Confirm: zero column copy on chunked; no intermediate
   `TimeSeries` / per-partition `TimeSeries` on array.

## API gate (do not skip)

Adding `column()` / `keyColumn()` / `partitionBy().toMap()` to `LiveView`
widens the **public live surface**, and a new React hook is **public hook
surface** — both require human approval before merge per CLAUDE.md. The spike
prototypes on a branch and reports numbers + the resolved decisions; the human
signs off on the surface before it becomes real. Layer-2 review + a Codex pass
(touches type definitions) apply.

## Success criteria

- Chunked-backed `liveView.column()` is a **zero-copy view** (no column copy;
  verified in the in-pond bench).
- Event[]-backed read produces **no intermediate `TimeSeries` / per-partition
  `TimeSeries`** per tick (the allocation-skip).
- The `useSyncExternalStore` signal is tearing-safe and throttled; existing
  hooks unchanged.
- Dashboard A/B shows a material memo drop at current scale and flat GC at the
  stress cell.

## Increments

1. **Spike** (this brief): prototype the `LiveView` read surface + partition
   fan-out + the `useSyncExternalStore` hook on a branch; in-pond bench;
   resolve decisions 1–4. No merge (API gate).
2. **Dashboard A/B**: the dashboard agent wires it and reports the memo delta.
3. **If the win lands**: human API sign-off → real implementation → a PLAN
   entry (the binding version; this brief + the RFC stay as the "why").

## Cross-references

- [`docs/rfcs/columnar-live-protocol.md`](../rfcs/columnar-live-protocol.md) §A.
- [`column-native-output-spike.md`](column-native-output-spike.md) — prong 1
  (push/output), the sibling cut sharing the trusted-store→column substrate.
- [`website/docs/recipes/streaming-baseline.mdx`](../../website/docs/recipes/streaming-baseline.mdx)
  — the consumer pattern this optimizes (snapshot-then-gather → read-on-view).
- `packages/core/src/live/live-series.ts`,
  `packages/core/src/live/live-partitioned-series.ts` — `LiveView` /
  `LivePartitionedSeries` (the subscription-oriented partition shape decision 3
  must reconcile).
- `packages/react/src/useSnapshot.ts` / `useWindow.ts` — the throttled-snapshot
  hooks whose internals decision 4 may move onto `useSyncExternalStore`.
