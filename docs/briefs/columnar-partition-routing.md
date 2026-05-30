# Brief: column-native partition routing (the earned OOM fix)

**Status:** scope plan — the **measured-earned OOM fix** for the
high-partition-count consumer. Supersedes §A as the next library lever (per the
gRPC V6 re-bench). The build does **not** merge without a human API sign-off (it
touches `partitionBy` internals) + Layer 2 + Codex.

## Why this, why now — the V6 finding

PR #170 (Phase 1, chunked source backing) was framed as the OOM fix. The gRPC
experiment's V6 re-bench on v0.18.0
([pond-grpc-experiment#42](https://github.com/pjm17971/pond-grpc-experiment/pull/42))
falsified that framing for the real consumer:

- The chunked backing **engaged on the source** (67k `ColumnarStore` chunks),
  but the retained `Event` count was **unchanged at 6.77M** and net heap went
  **up ~210 MB**.
- **The dominant retention is the 100 `partitionBy('host')` sub-series**, not
  the source. Phase 1 explicitly carved those out to the `Event[]` backing
  (`__backing: 'array'`) on the assumption "partitions are fed per-event, not
  the OOM driver." That assumption was wrong for the partitioned-rolling
  consumer: 6.73M events ÷ 100 hosts ≈ 67k retained Events per partition.
- What #170 _did_ deliver: minor GC max pause **−74%**, ingest→fanout p99
  **−78%**, pushManyTotal p99 **−77%** — a real churn/latency win, just not the
  heap win. Phase 1 is a latency fix; **this** is the heap/OOM fix.

So the OOM lever the wave has been chasing since the start lives in the
**partition sub-series**, and reaching it needs column-native routing.

## Goal

`partitionBy(...)` routes a source batch to its per-partition sub-series as
**column batches** (no per-row `Event`), and strict-time partition sub-series
use the chunked columnar backing. Result: the per-partition `Event[]` retention
(the 6.77M) is replaced by columnar chunks — the heap drop Phase 1 aimed for,
now at the right tier.

## How it composes with what already shipped

- **`scatterByPartition`** (substrate, shipped #149): buckets a columnar batch
  by a key column into per-partition column slices. This is the routing
  primitive — it already exists; Phase 2 wires it into the live partition path.
- **Chunked backing** (shipped #170): the per-partition storage target. Phase 2
  lifts the `__backing: 'array'` carve-out for **strict-time** partition
  sub-series so they accept column batches via `appendStore` instead of per-row
  `Event` push.
- Today's path (to replace): `partitionBy` subscribes to the source's `'event'`
  and pushes each event into its partition one at a time (per-row, `Event[]`).
  This is both the transient-materialization churn _and_ the per-partition
  retention.

## Decisions the build must resolve

1. **Routing path.** Source chunk → `scatterByPartition(keyColumn)` → per-
   partition `ColumnarStore` sub-batch → partition's chunked `appendStore`. No
   `Event` synthesized on this path. (Replaces the per-event `'event'`
   subscription for routing.)
2. **Carve-out lift, scoped.** Only **strict + time-keyed** partition
   sub-series move to the chunked backing — matching the source's gate. `reorder`
   / `drop` / interval-keyed / count-window partitions stay `Event[]` (same
   constraints as the source path; see the chunked backing's limits).
3. **Per-event downstream semantics.** Partition sub-series feed downstream
   operators (`rolling`, `reduce`, …) that may consume per-event. The partition's
   _own_ `'event'`/`'batch'` fan-out to its downstream is a **separate listener
   boundary** — that's §A territory (column-native output). Phase 2 fixes
   partition **storage + routing-in**; the partition→downstream churn is §A.
   Decide: does the partition still synthesize transient Events for its
   downstream fan-out (correct, some churn remains), and is that acceptable for
   v1? (Likely yes — retention is the OOM driver; downstream churn is the §A
   follow-up.)
4. **Ordering within a partition.** `scatterByPartition` preserves source order
   per bucket; confirm each partition sub-batch is in-order for the chunked
   backing's strict append contract (it should be — source is strict).
5. **`collect`/`apply` unified buffers.** Keep on `Event[]` for now (not the
   retention driver); revisit only if a profile says otherwise.

## Scope guards — what Phase 2 does NOT do

- **No §A** (column-native output to external listeners) — that's the separate,
  already-scoped spike; this brief is storage + routing-in only.
- **No `reorder` partitions** (needs the corral architecture; RFC §B, unearned).
- **No count-window partitions** on the chunked path (same `maxEvents` constraint
  as the source — array fallback).
- **No public-API shape change** intended — `partitionBy` / `collect` /
  per-partition operators keep their signatures and observable values; this is
  an internal storage/routing swap. Any observable divergence (e.g. the chunked
  all-or-nothing commit semantics, now per-partition) must be documented like
  #170's was.

## Measurement (the build isn't done without numbers)

1. **gRPC V7 re-run** — the same OOM cell. The pass condition is the one V6
   failed: **partition `Event`/`Time` retention drops ~5–9×** (the heap win,
   finally at the right tier). The gRPC agent owns this re-bench.
2. **In-pond bench** — extend `perf-live-columnar.mjs` (or a new
   `perf-partition-routing.mjs`): partitioned ingest, chunked-routed vs array,
   retained heap + ingest throughput + routing allocation. Confirm **zero
   per-partition `Event`** on the routed path.

## API gate

Touches `partitionBy` / `LivePartitionedSeries` internals and the
per-partition storage strategy. Per CLAUDE.md, changes to the partitioned-series
surface get human sign-off, Layer 2, and a Codex pass — storage / routing
correctness and the strict-order / ordering contract are exactly the kind of
subtle ground that pulls Codex confidence. The build prototypes on a branch and
reports the V7 and in-pond numbers; the human signs off before merge.

## Sequencing

1. **This brief** — scope (done).
2. **Build** Phase 2 on a branch: scatter-routing + chunked partitions, in-pond
   bench, the carve-out lift. No merge (API gate).
3. **gRPC V7 re-run** confirms the partition-retention drop.
4. **If the win lands** → human sign-off → merge → release → §A is next.

## Cross-references

- [`docs/rfcs/columnar-live-protocol.md`](../rfcs/columnar-live-protocol.md) —
  §A (output) is the sibling/after; the structural-delta framing.
- [`docs/briefs/column-native-live-pipeline.md`](column-native-live-pipeline.md)
  — Phase 1 (the source chunked backing) + the original Phase 2
  `scatterByPartition` note this realizes.
- [`docs/briefs/column-native-output-spike.md`](column-native-output-spike.md) —
  §A, now sequenced **after** Phase 2.
- [pond-grpc-experiment#42](https://github.com/pjm17971/pond-grpc-experiment/pull/42)
  — the V6 re-bench that earned this (partition-retention finding + §A
  before-number).
- `packages/core/src/columnar/scatter.ts` — the `scatterByPartition` primitive.
- `packages/core/src/live/live-partitioned-series.ts` — the routing site +
  the `__backing: 'array'` carve-out to lift.
- `packages/core/src/live/live-chunked-storage.ts` — the per-partition storage
  target.
