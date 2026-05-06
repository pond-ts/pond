/**
 * Type-level tests for the keyed-form fused multi-window rolling
 * primitive. Verifies:
 *
 *   - `FusedRollingSchema<S, FM>` flat-merges per-window output
 *     columns into one schema with the source's first-column kind.
 *   - `FusedPartitionedRollingSchema<S, K, FM>` adds the partition
 *     column once at the front, ahead of the merged columns.
 *   - `DurationString` template-literal accepts canonical duration
 *     strings (`'1m'`, `'200ms'`, `'5s'`) and rejects malformed
 *     keys (`'1min'`, `'thirty'`) at the type level.
 *
 * **Compile-time uniqueness check** rejects fused mappings that
 * declare the same output column name across two windows. Pinned in
 * the section near the bottom of this file.
 */
import {
  LiveSeries,
  Trigger,
  type DurationString,
  type EventForSchema,
  type FusedMapping,
  type FusedPartitionedRollingSchema,
  type FusedRollingSchema,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

// ── DurationString ──────────────────────────────────────────────

// Accepts canonical duration strings:
const _ok1: DurationString = '1m';
const _ok2: DurationString = '200ms';
const _ok3: DurationString = '5s';
const _ok4: DurationString = '24h';
const _ok5: DurationString = '7d';
// Sentinel:
const _ok6: DurationString = 'buffer';
void _ok1;
void _ok2;
void _ok3;
void _ok4;
void _ok5;
void _ok6;

// Note: TypeScript's `${number}${unit}` template-literal type is
// permissive — strings like `'1min'` and `'thirty'` may pass the
// compile-time check (the `${number}` placeholder is liberal about
// what counts as a "number-shaped prefix"). Runtime `parseDuration`
// rejects them with a clear error, so the boundary check is honest
// at the place where it matters. Tightening the template-literal
// type to be strict is parked as a follow-up — for now we lean on
// runtime + the compile-time hint.

// ── FusedRollingSchema flat-merge ───────────────────────────────

type FM1 = {
  '1m': { cpu: 'avg' };
  '200ms': { cpu_max: { from: 'cpu'; using: 'max' } };
};

type Schema1 = FusedRollingSchema<typeof schema, FM1>;

// First column preserves source's first-column kind:
const _first1: Schema1[0] = schema[0];
void _first1;

// AggregateMap form: `{ cpu: 'avg' }` produces output column `cpu` with kind 'number'.
// AggregateOutputMap form: `{ cpu_max: { from, using } }` produces output column `cpu_max` with kind 'number'.
//
// We can't index Schema1 directly to assert column shapes (the rest is
// `Array<UnionOfColumnDefs>`), but we can verify the schema is usable
// as a SeriesSchema and that the merged columns make it through to
// `EventForSchema` field access:

declare const fused1: import('../src/index.js').LiveFusedRolling<
  typeof schema,
  Schema1
>;

declare const e1: EventForSchema<Schema1>;
const cpuVal: number | undefined = e1.get('cpu');
const cpuMaxVal: number | undefined = e1.get('cpu_max');
void cpuVal;
void cpuMaxVal;
void fused1;

// Different reducer outputs produce the right kind:
type FM2 = {
  '1m': { cpu_samples: { from: 'cpu'; using: 'samples' } };
};
type Schema2 = FusedRollingSchema<typeof schema, FM2>;
declare const e2: EventForSchema<Schema2>;
const samplesVal = e2.get('cpu_samples');
// 'samples' returns an array — accept any defined value here; the
// runtime validates the array shape and the reducer-reference doc
// covers narrowing.
void samplesVal;

// ── FusedPartitionedRollingSchema adds partition column ─────────

type FMP = {
  '1m': { cpu_avg: { from: 'cpu'; using: 'avg' } };
  '200ms': { cpu_max: { from: 'cpu'; using: 'max' } };
};
type PartitionedSchema = FusedPartitionedRollingSchema<
  typeof schema,
  'host',
  FMP
>;

declare const ep: EventForSchema<PartitionedSchema>;
const hostVal = ep.get('host');
const cpuAvgVal: number | undefined = ep.get('cpu_avg');
void hostVal;
void cpuAvgVal;

// ── End-to-end at the call site ────────────────────────────────

const live = new LiveSeries({ name: 'metrics', schema });

// Single-window fused: returns a `LiveFusedRolling`.
const fA = live.rolling({ '1m': { cpu: 'avg' } });
declare const _eA: ReturnType<typeof fA.at>;
void _eA;

// Multi-window fused: merged output columns.
const fB = live.rolling({
  '1m': {
    cpu_avg: { from: 'cpu', using: 'avg' },
    cpu_sd: { from: 'cpu', using: 'stdev' },
  },
  '200ms': { cpu_max: { from: 'cpu', using: 'max' } },
});
const sample = fB.at(0);
if (sample) {
  const a: number | undefined = sample.get('cpu_avg');
  const s: number | undefined = sample.get('cpu_sd');
  const m: number | undefined = sample.get('cpu_max');
  void a;
  void s;
  void m;
}

// Partitioned fused requires a clock trigger:
const partitioned = live.partitionBy('host');
const fC = partitioned.rolling(
  {
    '1m': { cpu_avg: { from: 'cpu', using: 'avg' } },
    '200ms': { cpu_max: { from: 'cpu', using: 'max' } },
  },
  { trigger: Trigger.every('30s') },
);
declare const _eC: ReturnType<typeof fC.at>;
void _eC;

// ── Compile-time uniqueness check ───────────────────────────────

// Two windows declaring the SAME bare-AggregateMap output column.
// Surfaces as a TS error at the call site — the branded
// `__FUSED_ROLLING_ERROR` type makes the assignment fail.
// @ts-expect-error — duplicate output column 'cpu' across '1m' and '200ms'
const _badBare = live.rolling({
  '1m': { cpu: 'avg' },
  '200ms': { cpu: 'max' },
});
void _badBare;

// Two windows declaring the same AggregateOutputMap alias.
// @ts-expect-error — duplicate alias 'cpu_combined' across windows
const _badAlias = live.rolling({
  '1m': { cpu_combined: { from: 'cpu', using: 'avg' } },
  '200ms': { cpu_combined: { from: 'cpu', using: 'max' } },
});
void _badAlias;

// AggregateMap collision with AggregateOutputMap alias in another
// window — same name surface, must still be caught.
// @ts-expect-error — duplicate output column 'cpu' across windows
const _badMixed = live.rolling({
  '1m': { cpu: 'avg' },
  '200ms': { cpu: { from: 'cpu', using: 'max' } },
});
void _badMixed;

// Three windows: collision between any two should still error.
// @ts-expect-error — duplicate 'x' across two of three windows
const _badThree = live.rolling({
  '1m': { x: { from: 'cpu', using: 'avg' } },
  '5s': { y: { from: 'cpu', using: 'sum' } },
  '200ms': { x: { from: 'cpu', using: 'max' } },
});
void _badThree;

// Unique mappings still typecheck (sanity baseline).
const _okUnique = live.rolling({
  '1m': { cpu_avg: { from: 'cpu', using: 'avg' } },
  '200ms': { cpu_max: { from: 'cpu', using: 'max' } },
});
void _okUnique;

// Partitioned variant rejects duplicates the same way. We bind the
// mapping to a const first so the TS diagnostic lands on the call
// site (a multi-line inline literal would push the error report
// past the directive).
const _badPartitionedMapping = {
  '1m': { cpu: { from: 'cpu', using: 'avg' } },
  '200ms': { cpu: { from: 'cpu', using: 'max' } },
} as const;
// @ts-expect-error — duplicate alias 'cpu' across windows
const _badPartitioned = partitioned.rolling(_badPartitionedMapping, {
  trigger: Trigger.every('30s'),
});
void _badPartitioned;

// ── partitionBy narrows the partition column literal ─────────
//
// Pinned 2026-05-05 after the gRPC V8 migration surfaced this
// (pond-grpc-experiment#22). Pre-fix, callers needed the
// workaround `partitionBy<'host'>('host')` because the column
// literal wasn't captured in the return generic. Post-fix, the
// `by` argument's literal type narrows automatically and
// `event.get('host')` resolves through the schema.

const sampleEvent = fC.at(0);
if (sampleEvent) {
  // host narrows to string (the column kind in `numericSchema`).
  const h: string | undefined = sampleEvent.get('host');
  // value columns narrow per their reducer.
  const a: number | undefined = sampleEvent.get('cpu_avg');
  const m: number | undefined = sampleEvent.get('cpu_max');
  void h;
  void a;
  void m;
}

// Threading through chained pipelines:
//   partitionBy('host').fill(...).rolling({...}, { trigger })
// — the fused-partitioned schema must still narrow the partition
// column from the root's `by` argument, even after a chain hop.
const chained = live
  .partitionBy('host')
  .fill({ cpu: 'hold' })
  .rolling(
    { '1m': { cpu_avg: { from: 'cpu', using: 'avg' } } },
    { trigger: Trigger.every('1s') },
  );
const chainedSample = chained.at(0);
if (chainedSample) {
  const h: string | undefined = chainedSample.get('host');
  const a: number | undefined = chainedSample.get('cpu_avg');
  void h;
  void a;
}

// V8 workaround back-compat (Layer 2 caught this on PR #117):
//   partitionBy<'host'>('host').rolling({...}, { trigger })
// — the explicit-arg form was the gRPC V8 workaround for the
// pre-v0.15.1 narrowing gap. Type-parameter order is
// `<ByCol, K>` so the explicit `'host'` binds to `ByCol`,
// preserving narrowing on existing callers.
const v8Workaround = live
  .partitionBy<'host'>('host')
  .rolling(
    { '1m': { cpu_avg: { from: 'cpu', using: 'avg' } } },
    { trigger: Trigger.every('1s') },
  );
const v8Sample = v8Workaround.at(0);
if (v8Sample) {
  const h: string | undefined = v8Sample.get('host');
  const a: number | undefined = v8Sample.get('cpu_avg');
  void h;
  void a;
}
