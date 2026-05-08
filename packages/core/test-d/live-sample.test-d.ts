/**
 * Type-level tests for `live.sample({...})`.
 *
 * v0.17.0 ships **stride only** on the live side. `SampleStrategy` is
 * `{ stride: number }`; reservoir lives on `BatchSampleStrategy`
 * (snapshot-side, used by `TimeSeries.sample` /
 * `PartitionedTimeSeries.sample`).
 *
 * Multi-entity bias trap (gRPC experiment's M3.5 prototype: stride-10
 * against round-robin host order silently kept 8 of 80 hosts) is
 * documented in the operator JSDoc, not gated through a type-level
 * token — same convention as `rolling` / `aggregate` / `fill` /
 * `diff` / `rate` / `cumulative` / `pctChange` / `reduce`, all of
 * which silently mix entities on a multi-entity stream unless scoped
 * per-partition first.
 */
import {
  LiveSeries,
  LiveView,
  TimeSeries,
  type BatchSampleStrategy,
  type SampleStrategy,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'value', kind: 'number' },
] as const;

const live = new LiveSeries({ name: 'metrics', schema });

// ── LiveSeries.sample accepts SampleStrategy directly ───────────

const _stride = live.sample({ stride: 10 });
void _stride;

// @ts-expect-error — { reservoir } is not a live-side strategy in v0.17.0
const _resLive = live.sample({ reservoir: { size: 100 } });
void _resLive;

// ── LiveView.sample is the same shape ───────────────────────────

const view = live.filter((e) => (e.get('value') as number) > 0);
const _viewStride = view.sample({ stride: 10 });
void _viewStride;

// ── LivePartitionedSeries.sample is the safe-by-construction shape ──

const partitioned = live.partitionBy('host');
const _safe = partitioned.sample({ stride: 10 });
void _safe;

// @ts-expect-error — reservoir is snapshot-only in v0.17.0
const _safeRes = partitioned.sample({ reservoir: { size: 100 } });
void _safeRes;

// ── LivePartitionedView.sample chains cleanly ──────────────────

const chained = partitioned.fill({ value: 'hold' });
const _chainedSafe = chained.sample({ stride: 10 });
void _chainedSafe;

// ── Return types ────────────────────────────────────────────────

// LiveSeries.sample → LiveView<S> (chainable surface available).
declare const _liveViewType: LiveView<typeof schema>;
const fromLive = live.sample({ stride: 10 });
const _checkLive: typeof _liveViewType = fromLive;
void _checkLive;

// Chainable post-sample (was a v0.16.x gap caught in PR #129 review).
const _chained = live
  .sample({ stride: 10 })
  .filter((e) => (e.get('value') as number) > 0);
void _chained;

// SampleStrategy is stride-only on the live surface in v0.17.0.
const _stridStrat: SampleStrategy = { stride: 10 };
void _stridStrat;

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
