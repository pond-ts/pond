/**
 * Type-level tests for `live.sample({...})`. The headline pin: the
 * pre-partition call sites (`LiveSeries.sample`, `LiveView.sample`)
 * require `unsafeGlobal: true` in the strategy; the partitioned call
 * sites (`LivePartitionedSeries.sample`, `LivePartitionedView.sample`)
 * accept `SampleStrategy` directly with no token.
 *
 * v0.17.0 ships **stride only** on the live side. `SampleStrategy` /
 * `GlobalSampleStrategy` therefore expose `{ stride: number }` only;
 * reservoir lives on `BatchSampleStrategy` (snapshot-side, used by
 * `TimeSeries.sample` / `PartitionedTimeSeries.sample`).
 *
 * The bias trap was first surfaced by the gRPC experiment's M3.5
 * prototype: a global stride counter against round-robin host order
 * silently dropped 90% of hosts. This file pins that pre-partition
 * call sites cannot compile without the acknowledgment token.
 */
import {
  LiveSeries,
  LiveView,
  TimeSeries,
  type BatchSampleStrategy,
  type GlobalSampleStrategy,
  type SampleStrategy,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'value', kind: 'number' },
] as const;

const live = new LiveSeries({ name: 'metrics', schema });

// ── LiveSeries.sample requires unsafeGlobal: true ───────────────

// @ts-expect-error — bare { stride: N } on LiveSeries must require unsafeGlobal
const _bare = live.sample({ stride: 10 });
void _bare;

// @ts-expect-error — { reservoir } is not a live-side strategy in v0.17.0
const _resLive = live.sample({ reservoir: { size: 100 }, unsafeGlobal: true });
void _resLive;

// With unsafeGlobal: true and stride, compiles.
const _stride = live.sample({ stride: 10, unsafeGlobal: true });
void _stride;

// ── LiveView.sample requires unsafeGlobal: true ─────────────────

const view = live.filter((e) => (e.get('value') as number) > 0);

// @ts-expect-error — bare strategy on LiveView must require unsafeGlobal
const _viewBare = view.sample({ stride: 10 });
void _viewBare;

// With unsafeGlobal: true, compiles.
const _viewStride = view.sample({ stride: 10, unsafeGlobal: true });
void _viewStride;

// ── LivePartitionedSeries.sample is safe (no token needed) ──────

const partitioned = live.partitionBy('host');

// Bare stride compiles cleanly — partitioned is safe by construction.
const _safe = partitioned.sample({ stride: 10 });
void _safe;

// @ts-expect-error — reservoir is snapshot-only in v0.17.0
const _safeRes = partitioned.sample({ reservoir: { size: 100 } });
void _safeRes;

// ── LivePartitionedView.sample is safe ─────────────────────────

const chained = partitioned.fill({ value: 'hold' });
const _chainedSafe = chained.sample({ stride: 10 });
void _chainedSafe;

// ── Return types ────────────────────────────────────────────────

// LiveSeries.sample → LiveView<S> (so the chainable surface is available).
declare const _liveViewType: LiveView<typeof schema>;
const fromLive = live.sample({ stride: 10, unsafeGlobal: true });
const _checkLive: typeof _liveViewType = fromLive;
void _checkLive;

// Chainable post-sample (was a v0.16.x gap caught in PR #129 review).
const _chained = live
  .sample({ stride: 10, unsafeGlobal: true })
  .filter((e) => (e.get('value') as number) > 0);
void _chained;

// SampleStrategy is stride-only on the live surface in v0.17.0.
const _stridStrat: SampleStrategy = { stride: 10 };
void _stridStrat;

// GlobalSampleStrategy is stride-only with the token.
const _globalStrat: GlobalSampleStrategy = { stride: 10, unsafeGlobal: true };
void _globalStrat;

// BatchSampleStrategy (snapshot-side) covers both stride and reservoir.
const _batchStride: BatchSampleStrategy = { stride: 10 };
const _batchRes: BatchSampleStrategy = { reservoir: { size: 100 } };
void _batchStride;
void _batchRes;

// ── Snapshot-side: TimeSeries.sample accepts both forms ─────────

const series = new TimeSeries({ name: 'metrics', schema, rows: [] });
const _strideSnap = series.sample({ stride: 10 });
const _resSnap = series.sample({ reservoir: { size: 100 } });
void _strideSnap;
void _resSnap;
