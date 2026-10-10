/**
 * Type-level tests for [PND-LIVESRC] and the listener-return contract on
 * the live incremental operators.
 *
 * Pins that:
 * - `LiveAggregation<S, Out>` and `LiveRollingAggregation<S, Out>` are
 *   assignable to `LiveSource<Out>` — their `on('event')` listener
 *   receives the narrowed `EventForSchema<Out>`, the same type `at()`
 *   and `closed()` hand out.
 * - Listeners on every `on()` overload get schema-narrowed events.
 * - Every `on()` overload returns an unsubscribe function (`() => void`),
 *   matching `LiveSeries` / `LiveView`; none returns `this`.
 * - The removed `'close'` alias no longer compiles.
 */
import {
  LiveSeries,
  Sequence,
  type EventForSchema,
  type LiveSource,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

const live = new LiveSeries({ name: 'metrics', schema });

// ── LiveAggregation ─────────────────────────────────────────────

const agg = live.aggregate(Sequence.every('1m'), {
  cpu_avg: { from: 'cpu', using: 'avg' },
  n: { from: 'cpu', using: 'count' },
});
type AggOut = (typeof agg)['schema'];

// [PND-LIVESRC]: assignable to LiveSource<Out>.
const aggSource: LiveSource<AggOut> = agg;
void aggSource;

// The listener's event is the type the `closed()` series' events have.
declare const closedEvt: NonNullable<
  ReturnType<ReturnType<typeof agg.closed>['at']>
>;
agg.on('event', (e) => {
  const fromClosed: typeof closedEvt = e;
  const back: EventForSchema<AggOut> = closedEvt;
  void fromClosed;
  void back;
});

const offEvent: () => void = agg.on('event', (e) => {
  const v: number | undefined = e.get('cpu_avg');
  // @ts-expect-error — not an output column
  e.get('cpu');
  void v;
});
const offBucket: () => void = agg.on('bucket', (e) => {
  const v: number | undefined = e.get('n');
  void v;
});
const offUpdate: () => void = agg.on('update', () => {});
offEvent();
offBucket();
offUpdate();

// @ts-expect-error — `'close'` was removed; use `'event'`
agg.on('close', () => {});

// ── LiveRollingAggregation ──────────────────────────────────────

const rolling = live.rolling('5m', { cpu: 'avg' });
type RollOut = (typeof rolling)['schema'];

const rollSource: LiveSource<RollOut> = rolling;
void rollSource;

const offRollEvent: () => void = rolling.on('event', (e) => {
  const v: number | undefined = e.get('cpu');
  void v;
});
const offRollUpdate: () => void = rolling.on('update', (value) => {
  void value;
});
offRollEvent();
offRollUpdate();
