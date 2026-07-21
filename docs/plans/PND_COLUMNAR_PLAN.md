# PND_COLUMNAR_PLAN — columnar substrate: remaining levers

> Breakout plan for the **Columnar substrate** roadmap section in
> [PLAN.md](../../PLAN.md). The batch columnar wave is **complete** (framework
> 1a–1h, TimeSeries integration, reducer fast paths, the full transform wave,
> column API 8a–8e) — full history in
> [docs/archive/phase-4-7-columnar-substrate.md](../archive/phase-4-7-columnar-substrate.md).
> RFCs: [columnar-core.md](../rfcs/columnar-core.md),
> [columnar-live-protocol.md](../rfcs/columnar-live-protocol.md),
> [column-api.md](../rfcs/column-api.md). Ground truth assessments:
> [columnar-arc-assessment-2026-06.md](../notes/columnar-arc-assessment-2026-06.md),
> [live-columnar-assessment-2026-06.md](../notes/live-columnar-assessment-2026-06.md).

Live columnar sits at a defensible **retention-boundary waypoint**: the
originating OOM (gRPC partition retention) is solved (chunked backing +
column-native partition routing #175). Everything below is friction-gated —
each lever has a named consumer signal that would earn it. Label warning from
the archive: "3C" historically meant both the batch rolling _output_ path
(SHIPPED #225) and the live rolling _reducer_ state (still deferred —
[PND-LROLL] here).

## Tasks

### [PND-COLOUT] — Column-native output (§A)

The dominant remaining allocation slice at the live output boundary:
~11.7 MB/s transient at the gRPC OOM cell (~90k Events/s + ~90k
row-objects/s for shared `'batch'` listeners); V8 confirmed the 37k retained
Events are all emit-side. Spike plan:
[docs/briefs/column-native-output-spike.md](../briefs/column-native-output-spike.md)
(payload fork, additive listener name, before-number locked by the V6
re-bench, API gate).

### [PND-REORD] — Columnar reorder (§B)

Append-only main store + sorted "late corral" overlay + grace-flush
compaction, per
[columnar-live-protocol.md](../rfcs/columnar-live-protocol.md) §B.
**Unearned** — no consumer signal yet; stays RFC context until one arrives.

### [PND-LROLL] — Live rolling columnar reducer state (Step 3 Phase C)

The only lever that would actually cut the gRPC ceiling's GC line (the Step-7
ring-buffer attempt was falsified: the consumer needs `Event`s regardless of
backing — walk-back brief at
[docs/briefs/step-7-live-series-ring-buffer.md](../briefs/step-7-live-series-ring-buffer.md)).
Per-reducer `rollingColumn` state machines; open design question whether the
extension surface is internal or a public contract like
`ReducerDef.reduceColumn`. Earns its slot only if a workload pushes near
ceiling (production target 100k/s; V5 measured ~210k/s = 2.1× headroom).

### [PND-PLANNR] — Aggregate planner (step 5)

Minimal fused planner: precompute bucket spans once, answer simple reducers
from prefix sums/counts, fall back to the event-walked path. Friction-gated.

### [PND-DICT] — String / dictionary reducer adaptation (step 6)

`unique` / `top` / `samples` / grouped `count` over dictionary-encoded
columns. Friction-gated.

### [PND-WCNAN] — `withColumn` NaN-canonical `Float64Array` intake

**Source:** dashboard-agent friction report (pond-ts-dashboard engine A/B,
2026-07-21). `withColumn` rejects NaN today, so a consumer deriving a **gated**
column (a value that is present for some rows, missing for others) must hand it
in as a boxed `(number | undefined)[]` rather than a typed array. At density
that boxing is the dominant adapter cost the report measured — the per-tick
derivation memo goes 6.3 ms @ 86k → **~25 ms @ 360k**, mostly boxing three
derived columns per host per tick.

**Ask:** accept a NaN-as-missing `Float64Array` as `withColumn` intake —
symmetric with what `colToValues` already **emits** (NaN for a missing cell).
Then a consumer reads columns out as typed arrays, derives into a fresh
`Float64Array` writing `NaN` for gated-out cells, and hands it straight back —
allocation-free, no boxing. This is one face of the broader **NaN-vs-`undefined`
sentinel asymmetry** flagged as friction #3/#4 in the wide-schema report: the
read side speaks NaN, the write side (`withColumn`) demands `undefined`. Design
call: whether NaN-intake is a `withColumn` option/overload or the columnar
substrate canonicalizes the two sentinels end to end. Friction-gated but has a
named consumer and a measured cost.
