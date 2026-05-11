import { describe, expect, it } from 'vitest';
import {
  LiveAggregation,
  LiveSeries,
  LiveView,
  LiveRollingAggregation,
  Sequence,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function makeLive() {
  return new LiveSeries({ name: 'test', schema });
}

// ── Time-based window ───────────────────────────────────────────

describe('LiveRollingAggregationtime-based', () => {
  it('computes aggregate over time window', () => {
    const live = makeLive();
    live.push(
      [0, 10, 'a'],
      [1000, 20, 'a'],
      [2000, 30, 'a'],
      [3000, 40, 'a'],
      [4000, 50, 'a'],
    );
    const tail = new LiveRollingAggregation(live, '5s', { value: 'avg' });
    expect(tail.value().value).toBe(30); // avg(10,20,30,40,50)
    tail.dispose();
  });

  it('evicts events outside the window', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a'], [2000, 30, 'a']);
    const tail = new LiveRollingAggregation(live, '3s', { value: 'sum' });
    // window covers [0, 2000], cutoff = 2000-3000 = -1000, all included
    expect(tail.value().value).toBe(60);

    live.push([5000, 40, 'a']);
    // cutoff = 5000-3000 = 2000, events at 0 and 1000 are evicted
    expect(tail.value().value).toBe(70); // 30+40
    tail.dispose();
  });

  it('updates on each push', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, '10s', { value: 'sum' });
    const updates: number[] = [];
    tail.on('update', (v) => updates.push(v.value as number));

    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);
    expect(updates).toEqual([10, 30]);
    tail.dispose();
  });

  it('handles empty source', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, '5s', { value: 'avg' });
    expect(tail.value().value).toBeUndefined();
    expect(tail.windowSize).toBe(0);
    tail.dispose();
  });

  it('processes existing events', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a']);
    const tail = new LiveRollingAggregation(live, '5s', { value: 'sum' });
    expect(tail.value().value).toBe(30);
    tail.dispose();
  });

  it('keeps events exactly at boundary', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [5000, 20, 'a']);
    const tail = new LiveRollingAggregation(live, '5s', { value: 'sum' });
    // cutoff = 5000-5000 = 0, event at 0 has timestamp === cutoff, NOT evicted
    expect(tail.value().value).toBe(30);
    tail.dispose();
  });
});

// ── Count-based window ──────────────────────────────────────────

describe('LiveRollingAggregationcount-based', () => {
  it('keeps last N events', () => {
    const live = makeLive();
    live.push(
      [0, 10, 'a'],
      [1000, 20, 'a'],
      [2000, 30, 'a'],
      [3000, 40, 'a'],
      [4000, 50, 'a'],
    );
    const tail = new LiveRollingAggregation(live, 3, { value: 'avg' });
    expect(tail.windowSize).toBe(3);
    expect(tail.value().value).toBe(40); // avg(30,40,50)
    tail.dispose();
  });

  it('evicts oldest when window exceeds count', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, 2, { value: 'sum' });
    live.push([0, 10, 'a'], [1000, 20, 'a']);
    expect(tail.value().value).toBe(30);
    live.push([2000, 30, 'a']);
    expect(tail.value().value).toBe(50); // 20+30
    expect(tail.windowSize).toBe(2);
    tail.dispose();
  });

  it('count of 1 always has the latest event', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, 1, { value: 'sum' });
    live.push([0, 10, 'a']);
    expect(tail.value().value).toBe(10);
    live.push([1000, 20, 'a']);
    expect(tail.value().value).toBe(20);
    tail.dispose();
  });

  it('handles fewer events than window size', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, 100, { value: 'sum' });
    live.push([0, 10, 'a'], [1000, 20, 'a']);
    expect(tail.value().value).toBe(30);
    expect(tail.windowSize).toBe(2);
    tail.dispose();
  });
});

// ── Multiple columns ────────────────────────────────────────────

describe('multiple columns', () => {
  it('reduces multiple columns independently', () => {
    const numSchema = [
      { name: 'time', kind: 'time' },
      { name: 'a', kind: 'number' },
      { name: 'b', kind: 'number' },
    ] as const;
    const live = new LiveSeries({ name: 'multi', schema: numSchema });
    live.push([0, 10, 100], [1000, 20, 200], [2000, 30, 300]);
    const tail = new LiveRollingAggregation(live, '5s', { a: 'avg', b: 'max' });
    expect(tail.value().a).toBe(20);
    expect(tail.value().b).toBe(300);
    tail.dispose();
  });

  it('supports numeric output-map reducers through eviction', () => {
    const numSchema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
      { name: 'mem', kind: 'number' },
    ] as const;
    const live = new LiveSeries({ name: 'multi', schema: numSchema });
    const tail = new LiveRollingAggregation(live, '2s', {
      cpuAvg: { from: 'cpu', using: 'avg' },
      cpuMax: { from: 'cpu', using: 'max' },
      memSum: { from: 'mem', using: 'sum' },
    });

    live.push([0, 10, 100], [1000, 20, 200], [3000, 40, 400]);

    expect(tail.value()).toEqual({
      cpuAvg: 30,
      cpuMax: 40,
      memSum: 600,
    });
    expect(tail.windowSize).toBe(2);
    tail.dispose();
  });
});

// ── Subscriptions ───────────────────────────────────────────────

describe('subscriptions', () => {
  it('on() returns this for chaining', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, '5s', { value: 'sum' });
    const result = tail.on('update', () => {});
    expect(result).toBe(tail);
    tail.dispose();
  });

  it('dispose stops receiving source events', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, '5s', { value: 'sum' });
    live.push([0, 10, 'a']);
    expect(tail.value().value).toBe(10);
    tail.dispose();
    live.push([1000, 20, 'a']);
    // Value doesn't change after dispose
    expect(tail.value().value).toBe(10);
  });
});

// ── Edge cases ──────────────────────────────────────────────────

describe('edge cases', () => {
  it('rejects unknown column', () => {
    const live = makeLive();
    expect(
      () =>
        new LiveRollingAggregation(live, '5s', { nonexistent: 'sum' } as any),
    ).toThrow(/unknown source column/);
  });

  it('many rapid pushes with count window', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, 10, { value: 'sum' });
    for (let i = 0; i < 1000; i++) {
      live.push([i * 1000, i, `h${i % 5}`]);
    }
    // Last 10 events: 990..999, sum = 990+991+...+999 = 9945
    expect(tail.value().value).toBe(9945);
    expect(tail.windowSize).toBe(10);
    tail.dispose();
  });

  it('single event in window', () => {
    const live = makeLive();
    live.push([0, 42, 'a']);
    const tail = new LiveRollingAggregation(live, '5s', { value: 'avg' });
    expect(tail.value().value).toBe(42);
    tail.dispose();
  });

  it('works with min reducer', () => {
    const live = makeLive();
    live.push([0, 30, 'a'], [1000, 10, 'a'], [2000, 50, 'a']);
    const tail = new LiveRollingAggregation(live, 2, { value: 'min' });
    expect(tail.value().value).toBe(10); // min(10, 50)
    live.push([3000, 5, 'a']);
    expect(tail.value().value).toBe(5); // min(50, 5)
    tail.dispose();
  });
});

// ── LiveSource interface ────────────────────────────────────────

describe('LiveRollingAggregationLiveSource', () => {
  it('exposes name and schema', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, '5s', { value: 'avg' });
    expect(tail.name).toBe('test');
    expect(tail.schema[0]).toEqual({ name: 'time', kind: 'time' });
    expect(tail.schema[1]).toEqual({
      name: 'value',
      kind: 'number',
      required: false,
    });
    tail.dispose();
  });

  it('length equals total output events', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, '5s', { value: 'sum' });
    expect(tail.length).toBe(0);
    live.push([0, 10, 'a'], [1000, 20, 'a'], [2000, 30, 'a']);
    expect(tail.length).toBe(3);
    tail.dispose();
  });

  it('at() returns output events with rolling aggregate', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a'], [2000, 30, 'a']);
    const tail = new LiveRollingAggregation(live, '5s', { value: 'sum' });

    expect(tail.at(0)?.get('value')).toBe(10); // sum after first event
    expect(tail.at(1)?.get('value')).toBe(30); // sum after second
    expect(tail.at(2)?.get('value')).toBe(60); // sum after third
    tail.dispose();
  });

  it('output events have source timestamps', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a']);
    const tail = new LiveRollingAggregation(live, '5s', { value: 'sum' });

    expect(tail.at(0)?.begin()).toBe(0);
    expect(tail.at(1)?.begin()).toBe(1000);
    tail.dispose();
  });

  it('at() supports negative indexing', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a'], [2000, 30, 'a']);
    const tail = new LiveRollingAggregation(live, '5s', { value: 'sum' });

    expect(tail.at(-1)?.get('value')).toBe(60);
    expect(tail.at(-2)?.get('value')).toBe(30);
    tail.dispose();
  });

  it('on("event") fires per source event and returns unsubscribe', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, '5s', { value: 'sum' });
    const values: number[] = [];
    const unsub = tail.on('event', (event: any) => {
      values.push(event.get('value'));
    });

    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);
    expect(values).toEqual([10, 30]);

    unsub();
    live.push([2000, 30, 'a']);
    expect(values).toEqual([10, 30]);
    tail.dispose();
  });

  it('output events reflect window eviction', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, 2, { value: 'sum' });

    live.push([0, 10, 'a']);
    expect(tail.at(0)?.get('value')).toBe(10);

    live.push([1000, 20, 'a']);
    expect(tail.at(1)?.get('value')).toBe(30);

    live.push([2000, 30, 'a']);
    // Window evicted first event, so sum is now 20+30=50
    expect(tail.at(2)?.get('value')).toBe(50);
    expect(tail.length).toBe(3);
    tail.dispose();
  });

  it('can feed a LiveView for chaining', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(live, '5s', { value: 'avg' });
    const view = new LiveView(tail as any, (event: any) =>
      (event.get('value') as number) > 15 ? event : undefined,
    );

    live.push([0, 10, 'a']); // avg=10, filtered out
    expect(view.length).toBe(0);

    live.push([1000, 20, 'a']); // avg=15, filtered out
    expect(view.length).toBe(0);

    live.push([2000, 30, 'a']); // avg=20, passes
    expect(view.length).toBe(1);
    tail.dispose();
  });

  it('processes existing events into output buffer', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a']);
    const tail = new LiveRollingAggregation(live, '5s', { value: 'sum' });

    expect(tail.length).toBe(2);
    expect(tail.at(0)?.get('value')).toBe(10);
    expect(tail.at(1)?.get('value')).toBe(30);
    tail.dispose();
  });
});

describe('LiveRollingAggregation minSamples', () => {
  it('value() returns undefined while window is below the threshold', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(
      live,
      '10s',
      { value: 'avg' },
      { minSamples: 3 },
    );
    expect(tail.value().value).toBeUndefined();

    live.push([0, 10, 'a']);
    expect(tail.value().value).toBeUndefined();

    live.push([1000, 20, 'a']);
    expect(tail.value().value).toBeUndefined();

    // Crosses the threshold on the third event.
    live.push([2000, 30, 'a']);
    expect(tail.value().value).toBe(20); // avg(10,20,30)
    tail.dispose();
  });

  it('emits undefined into the output buffer during warm-up', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(
      live,
      '10s',
      { value: 'avg' },
      { minSamples: 2 },
    );
    live.push([0, 10, 'a']);
    expect(tail.at(0)?.get('value')).toBeUndefined();
    live.push([1000, 20, 'a']);
    expect(tail.at(1)?.get('value')).toBe(15);
    tail.dispose();
  });

  it('returns to undefined when eviction drops the count below the threshold', () => {
    const live = makeLive();
    const tail = new LiveRollingAggregation(
      live,
      '5s',
      { value: 'avg' },
      { minSamples: 2 },
    );
    live.push([0, 10, 'a'], [1000, 20, 'a']);
    expect(tail.value().value).toBe(15);

    // A single far-future event evicts everything older than 5s
    // before it; the window now holds just one event, dropping back
    // below minSamples.
    live.push([20_000, 99, 'a']);
    expect(tail.value().value).toBeUndefined();
    tail.dispose();
  });

  it('LiveSeries.rolling threads minSamples to the aggregation', () => {
    const live = makeLive();
    const tail = live.rolling('10s', { value: 'avg' }, { minSamples: 3 });
    live.push([0, 10, 'a'], [1000, 20, 'a']);
    expect(tail.value().value).toBeUndefined();
    live.push([2000, 30, 'a']);
    expect(tail.value().value).toBe(20);
    tail.dispose();
  });

  it('LiveView.rolling threads minSamples', () => {
    const live = makeLive();
    const view = new LiveView(live as any, (event: any) => event);
    const tail = view.rolling(
      '10s',
      { value: 'avg' },
      { minSamples: 3 },
    ) as any;
    live.push([0, 10, 'a'], [1000, 20, 'a']);
    expect(tail.value().value).toBeUndefined();
    live.push([2000, 30, 'a']);
    expect(tail.value().value).toBe(20);
    tail.dispose();
  });

  it('LiveAggregation.rolling threads minSamples (validates the option)', () => {
    // Threading is mechanical; a validation error proves the option
    // reaches the underlying LiveRollingAggregation.
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('1s'), {
      value: 'avg',
    });
    expect(() =>
      agg.rolling('10s', { value: 'avg' }, { minSamples: -1 }),
    ).toThrow(/non-negative integer/);
    agg.dispose();
  });

  it('rejects negative or non-integer minSamples', () => {
    const live = makeLive();
    expect(
      () =>
        new LiveRollingAggregation(
          live,
          '5s',
          { value: 'avg' },
          { minSamples: -1 },
        ),
    ).toThrow(/non-negative integer/);
    expect(
      () =>
        new LiveRollingAggregation(
          live,
          '5s',
          { value: 'avg' },
          { minSamples: 1.5 },
        ),
    ).toThrow(/non-negative integer/);
  });
});
