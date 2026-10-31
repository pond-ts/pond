import { describe, expect, it } from 'vitest';
import { LiveSeries } from '../src/index.js';
import type { LiveSeriesOptions } from '../src/live/live-series.js';

// [PND-HOOKSIGNAL] The payload-free change signal the React hooks use in
// place of `'event'` / `'evict'` listeners. Two promises are pinned here:
// it fires on exactly the pushes the channel fires on, seeing the same
// series state as the channel's last call, and subscribing to it never
// makes the column-native backing build `Event`s.

const ON_SIGNAL = Symbol.for('pond-ts:onSignal');
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;
type S = typeof schema;
type Signal = (type: 'event' | 'evict', fn: () => void) => () => void;
const signal = (live: object): Signal =>
  ((live as Record<symbol, Signal>)[ON_SIGNAL] as Signal).bind(live);

const rows = (from: number, n: number): [number, number, string][] =>
  Array.from({ length: n }, (_, i) => [
    (from + i) * 1000,
    from + i,
    i % 2 ? 'a' : 'b',
  ]);

/**
 * Record, per push, what the channel's LAST call saw (length + snapshot
 * rows) and what the signal saw. `undefined` means "did not fire".
 */
function record(live: LiveSeries<S>, type: 'event' | 'evict') {
  let viaChannel: unknown;
  let viaSignal: unknown;
  let signalCalls = 0;
  const seen = () => ({
    length: live.length,
    rows: live.toTimeSeries().toRows(),
  });
  (live.on as (t: string, f: () => void) => () => void)(type, () => {
    viaChannel = seen();
  });
  signal(live)(type, () => {
    signalCalls += 1;
    viaSignal = seen();
  });
  return (push: () => void) => {
    viaChannel = viaSignal = undefined;
    signalCalls = 0;
    push();
    return { viaChannel, viaSignal, signalCalls };
  };
}

const configs: Array<[string, Partial<LiveSeriesOptions<S>>]> = [
  ['column backing (strict)', {}],
  ['event backing (reorder)', { ordering: 'reorder' }],
  ['event backing (drop)', { ordering: 'drop' }],
];

describe('LiveSeries change signal [PND-HOOKSIGNAL]', () => {
  for (const [label, options] of configs) {
    describe(label, () => {
      it("'event' signal fires once per push, seeing the channel's last state", () => {
        const live = new LiveSeries({
          name: 'x',
          schema,
          retention: { maxEvents: 5 },
          ...options,
        });
        const step = record(live, 'event');
        for (const push of [
          () => live.pushMany(rows(0, 3)),
          () => live.push(rows(3, 1)[0]!),
          () => live.pushMany(rows(4, 4)), // retention trims after this
          () => live.pushMany([]),
        ]) {
          const r = step(push);
          expect(r.viaSignal).toEqual(r.viaChannel);
          expect(r.signalCalls).toBe(r.viaChannel === undefined ? 0 : 1);
        }
      });

      it("'evict' signal fires where 'evict' does (retention, clear)", () => {
        const live = new LiveSeries({
          name: 'x',
          schema,
          retention: { maxEvents: 3 },
          ...options,
        });
        const step = record(live, 'evict');
        for (const push of [
          () => live.pushMany(rows(0, 2)), // no eviction
          () => live.pushMany(rows(2, 3)), // evicts 2
          () => live.clear(),
          () => live.clear(), // empty: no eviction
        ]) {
          const r = step(push);
          expect(r.viaSignal).toEqual(r.viaChannel);
          expect(r.signalCalls).toBe(r.viaChannel === undefined ? 0 : 1);
        }
      });
    });
  }

  it('a drop-mode push whose rows are all rejected fires neither', () => {
    const live = new LiveSeries({ name: 'x', schema, ordering: 'drop' });
    live.pushMany(rows(10, 1));
    const step = record(live, 'event');
    const r = step(() => live.pushMany(rows(0, 2)));
    expect(r).toEqual({
      viaChannel: undefined,
      viaSignal: undefined,
      signalCalls: 0,
    });
  });

  it('subscribing builds no Events on the column backing', () => {
    const live = new LiveSeries({
      name: 'x',
      schema,
      retention: { maxEvents: 2 },
    });
    let n = 0;
    signal(live)('event', () => (n += 1));
    signal(live)('evict', () => (n += 1));
    live.pushMany(rows(0, 4));
    expect(n).toBe(2);
    // 'event' + 'batch' listener count: zero means the push built no
    // `Event` (see `#commitChunk`).
    expect(live._rowListenerCount).toBe(0);
  });

  it('unsubscribe stops the signal', () => {
    const live = new LiveSeries({ name: 'x', schema });
    let n = 0;
    const off = signal(live)('event', () => (n += 1));
    live.pushMany(rows(0, 2));
    off();
    live.pushMany(rows(2, 2));
    expect(n).toBe(1);
  });

  it('partition sub-series: signal matches the channel on routed pushes and age sweeps', () => {
    const source = new LiveSeries({
      name: 'x',
      schema,
      retention: { maxAge: '3s' },
    });
    const parts = source.partitionBy('host', { groups: ['a', 'b'] as const });
    source.pushMany(rows(0, 2)); // spawn both partitions
    const a = parts.toMap().get('a') as unknown as LiveSeries<S>;
    // Routed column-native (`_stageRowsOpen` / `_stageRowsClose`).
    expect(a._isChunked).toBe(true);
    const onEvent = record(a, 'event');
    const onEvict = record(a, 'evict');
    const both = (push: () => void) => {
      let e: ReturnType<ReturnType<typeof record>> | undefined;
      const v = onEvict(() => {
        e = onEvent(push);
      });
      return { e: e!, v };
    };
    // Routes to both partitions; 'a' ages out its oldest rows.
    const r1 = both(() => source.pushMany(rows(2, 6)));
    expect(r1.e.viaChannel).toBeDefined();
    expect(r1.v.viaChannel).toBeDefined();
    // Only 'b' gets a row; 'a' ages out by the age sweep alone.
    const r2 = both(() => source.pushMany([[20_000, 1, 'b']]));
    expect(r2.e.viaChannel).toBeUndefined();
    expect(r2.v.viaChannel).toBeDefined();
    for (const r of [r1, r2]) {
      expect(r.e.viaSignal).toEqual(r.e.viaChannel);
      expect(r.e.signalCalls).toBe(r.e.viaChannel === undefined ? 0 : 1);
      expect(r.v.viaSignal).toEqual(r.v.viaChannel);
      expect(r.v.signalCalls).toBe(r.v.viaChannel === undefined ? 0 : 1);
    }
  });

  it("age sweep fires the 'evict' signal with no 'evict' listener attached", () => {
    const source = new LiveSeries({
      name: 'x',
      schema,
      retention: { maxAge: '3s' },
    });
    const parts = source.partitionBy('host', { groups: ['a', 'b'] as const });
    source.pushMany(rows(0, 2));
    const a = parts.toMap().get('a') as unknown as LiveSeries<S>;
    let n = 0;
    signal(a)('evict', () => (n += 1));
    const before = a.length;
    source.pushMany([[20_000, 1, 'b']]); // 'a' gets nothing, sweeps by age
    expect(a.length).toBeLessThan(before);
    expect(n).toBe(1);
  });
});
