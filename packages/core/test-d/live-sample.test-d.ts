/**
 * Type-level tests for `live.sample({...})`. The headline pin: the
 * pre-partition call sites (`LiveSeries.sample`, `LiveView.sample`)
 * require `unsafeGlobal: true` in the strategy; the partitioned call
 * sites (`LivePartitionedSeries.sample`, `LivePartitionedView.sample`)
 * accept `SampleStrategy` directly with no token.
 *
 * The bias trap was first surfaced by the gRPC experiment's M3.5
 * prototype: a global stride counter against round-robin host order
 * silently dropped 90% of hosts. This file pins that pre-partition
 * call sites cannot compile without the acknowledgment token.
 */
import {
  LiveSeries,
  type LiveSample,
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

// @ts-expect-error — bare { reservoir } on LiveSeries must require unsafeGlobal
const _bareRes = live.sample({ reservoir: { size: 100 } });
void _bareRes;

// With unsafeGlobal: true, both strategies compile.
const _stride = live.sample({ stride: 10, unsafeGlobal: true });
const _reservoir = live.sample({
  reservoir: { size: 100 },
  unsafeGlobal: true,
});
void _stride;
void _reservoir;

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

// Bare strategy compiles cleanly — partitioned is safe by construction.
const _safe = partitioned.sample({ stride: 10 });
const _safeRes = partitioned.sample({ reservoir: { size: 100 } });
void _safe;
void _safeRes;

// ── LivePartitionedView.sample is safe ─────────────────────────

const chained = partitioned.fill({ value: 'hold' });
const _chainedSafe = chained.sample({ stride: 10 });
void _chainedSafe;

// ── Return types ────────────────────────────────────────────────

// LiveSeries.sample → LiveSample<S>
declare const _liveSampleType: LiveSample<typeof schema>;
const fromLive = live.sample({ stride: 10, unsafeGlobal: true });
// Assignment compiles — return type is LiveSample<S>.
const _checkLive: typeof _liveSampleType = fromLive;
void _checkLive;

// SampleStrategy union type covers both forms.
const _stridStrat: SampleStrategy = { stride: 10 };
const _resStrat: SampleStrategy = { reservoir: { size: 100 } };
void _stridStrat;
void _resStrat;
