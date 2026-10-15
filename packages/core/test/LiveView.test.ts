import { describe, expect, it } from 'vitest';
import {
  Event,
  LiveAggregation,
  LiveSeries,
  LiveView,
  Sequence,
  LiveRollingAggregation,
  TimeSeries,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function makeLive() {
  return new LiveSeries({ name: 'test', schema });
}

// ── filter() ───────────────────────────────────────────────────

describe('filter()', () => {
  it('filters events by predicate', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a']);
    const view = live.filter((e) => e.get('host') === 'a');
    expect(view.length).toBe(2);
    expect(view.at(0)?.get('value')).toBe(10);
    expect(view.at(1)?.get('value')).toBe(30);
    view.dispose();
  });

  it('processes existing events on construction', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const view = live.filter((e) => e.get('host') === 'a');
    expect(view.length).toBe(1);
    expect(view.at(0)?.get('value')).toBe(10);
    view.dispose();
  });

  it('receives new events after construction', () => {
    const live = makeLive();
    const view = live.filter((e) => (e.get('value') as number) > 15);
    expect(view.length).toBe(0);

    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c']);
    expect(view.length).toBe(2);
    expect(view.at(0)?.get('value')).toBe(20);
    expect(view.at(1)?.get('value')).toBe(30);
    view.dispose();
  });

  it('filter that rejects all produces empty view', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const view = live.filter(() => false);
    expect(view.length).toBe(0);
    view.dispose();
  });

  it('filter that accepts all keeps all events', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const view = live.filter(() => true);
    expect(view.length).toBe(2);
    view.dispose();
  });

  it('empty source produces empty view', () => {
    const live = makeLive();
    const view = live.filter(() => true);
    expect(view.length).toBe(0);
    view.dispose();
  });

  it('first() and last()', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a']);
    const view = live.filter((e) => e.get('host') === 'a');
    expect(view.first()?.get('value')).toBe(10);
    expect(view.last()?.get('value')).toBe(30);
    view.dispose();
  });

  it('at() supports negative indices', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a'], [2000, 30, 'a']);
    const view = live.filter(() => true);
    expect(view.at(-1)?.get('value')).toBe(30);
    expect(view.at(-2)?.get('value')).toBe(20);
    view.dispose();
  });

  it('preserves source name and schema', () => {
    const live = makeLive();
    const view = live.filter(() => true);
    expect(view.name).toBe('test');
    expect(view.schema).toEqual(live.schema);
    view.dispose();
  });
});

// ── map() ──────────────────────────────────────────────────────

describe('map()', () => {
  it('transforms events', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const view = live.map(
      (e) =>
        new Event(e.key(), {
          ...e.data(),
          value: (e.get('value') as number) * 2,
        }),
    );
    expect(view.length).toBe(2);
    expect(view.at(0)?.get('value')).toBe(20);
    expect(view.at(1)?.get('value')).toBe(40);
    view.dispose();
  });

  it('preserves event count', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c']);
    const view = live.map(
      (e) =>
        new Event(e.key(), {
          ...e.data(),
          value: (e.get('value') as number) + 1,
        }),
    );
    expect(view.length).toBe(3);
    view.dispose();
  });

  it('processes existing events on construction', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    const view = live.map(
      (e) =>
        new Event(e.key(), {
          ...e.data(),
          value: (e.get('value') as number) * 10,
        }),
    );
    expect(view.at(0)?.get('value')).toBe(100);
    view.dispose();
  });

  it('receives new events after construction', () => {
    const live = makeLive();
    const view = live.map(
      (e) =>
        new Event(e.key(), {
          ...e.data(),
          host: (e.get('host') as string).toUpperCase(),
        }),
    );
    live.push([0, 10, 'hello']);
    expect(view.at(0)?.get('host')).toBe('HELLO');
    view.dispose();
  });

  it('preserves event keys', () => {
    const live = makeLive();
    live.push([5000, 10, 'a']);
    const view = live.map(
      (e) => new Event(e.key(), { ...e.data(), value: 99 }),
    );
    expect(view.at(0)?.begin()).toBe(5000);
    view.dispose();
  });
});

// ── Subscriptions ──────────────────────────────────────────────

describe('subscriptions', () => {
  it('on("event") fires for passing events', () => {
    const live = makeLive();
    const view = live.filter((e) => e.get('host') === 'a');
    const received: number[] = [];
    view.on('event', (e) => received.push(e.get('value') as number));

    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a']);
    expect(received).toEqual([10, 30]);
    view.dispose();
  });

  it('on("event") does not fire for filtered-out events', () => {
    const live = makeLive();
    const view = live.filter(() => false);
    let count = 0;
    view.on('event', () => count++);

    live.push([0, 10, 'a'], [1000, 20, 'b']);
    expect(count).toBe(0);
    view.dispose();
  });

  it('on("event") fires for mapped events', () => {
    const live = makeLive();
    const view = live.map(
      (e) =>
        new Event(e.key(), {
          ...e.data(),
          value: (e.get('value') as number) * 2,
        }),
    );
    const received: number[] = [];
    view.on('event', (e) => received.push(e.get('value') as number));

    live.push([0, 10, 'a'], [1000, 20, 'b']);
    expect(received).toEqual([20, 40]);
    view.dispose();
  });

  it('unsubscribe stops listener', () => {
    const live = makeLive();
    const view = live.filter(() => true);
    const received: number[] = [];
    const unsub = view.on('event', (e) =>
      received.push(e.get('value') as number),
    );

    live.push([0, 10, 'a']);
    unsub();
    live.push([1000, 20, 'b']);
    expect(received).toEqual([10]);
    view.dispose();
  });

  it('dispose stops receiving source events', () => {
    const live = makeLive();
    const view = live.filter(() => true);
    live.push([0, 10, 'a']);
    expect(view.length).toBe(1);

    view.dispose();
    live.push([1000, 20, 'b']);
    expect(view.length).toBe(1);
  });

  it('multiple listeners on same view', () => {
    const live = makeLive();
    const view = live.filter(() => true);
    const a: number[] = [];
    const b: number[] = [];
    view.on('event', (e) => a.push(e.get('value') as number));
    view.on('event', (e) => b.push(e.get('value') as number));

    live.push([0, 10, 'x']);
    expect(a).toEqual([10]);
    expect(b).toEqual([10]);
    view.dispose();
  });
});

// ── Chaining ───────────────────────────────────────────────────

describe('chaining', () => {
  it('filter → filter', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a'], [3000, 5, 'a']);
    const view = live
      .filter((e) => e.get('host') === 'a')
      .filter((e) => (e.get('value') as number) > 10);
    expect(view.length).toBe(1);
    expect(view.at(0)?.get('value')).toBe(30);
    view.dispose();
  });

  it('filter → map', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a']);
    const view = live
      .filter((e) => e.get('host') === 'a')
      .map(
        (e) =>
          new Event(e.key(), {
            ...e.data(),
            value: (e.get('value') as number) * 2,
          }),
      );
    expect(view.length).toBe(2);
    expect(view.at(0)?.get('value')).toBe(20);
    expect(view.at(1)?.get('value')).toBe(60);
    view.dispose();
  });

  it('map → filter', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c']);
    const view = live
      .map(
        (e) =>
          new Event(e.key(), {
            ...e.data(),
            value: (e.get('value') as number) * 2,
          }),
      )
      .filter((e) => (e.get('value') as number) > 30);
    expect(view.length).toBe(2);
    expect(view.at(0)?.get('value')).toBe(40);
    expect(view.at(1)?.get('value')).toBe(60);
    view.dispose();
  });

  it('map → map', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    const view = live
      .map(
        (e) =>
          new Event(e.key(), {
            ...e.data(),
            value: (e.get('value') as number) + 5,
          }),
      )
      .map(
        (e) =>
          new Event(e.key(), {
            ...e.data(),
            value: (e.get('value') as number) * 2,
          }),
      );
    expect(view.at(0)?.get('value')).toBe(30); // (10+5)*2
    view.dispose();
  });

  it('filter → aggregate', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a'], [5000, 40, 'a']);
    const agg = live
      .filter((e) => e.get('host') === 'a')
      .aggregate(Sequence.every('5s'), { value: 'sum' });
    expect(agg.closedCount).toBe(1);
    expect(agg.closed().at(0)?.get('value')).toBe(40); // 10+30
    agg.dispose();
  });

  it('filter → rolling', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a'], [3000, 40, 'a']);
    const r = live
      .filter((e) => e.get('host') === 'a')
      .rolling('10s', { value: 'avg' });
    expect(r.value().value).toBeCloseTo(26.67, 1); // avg(10,30,40)
    r.dispose();
  });

  it('filter → toTimeSeries', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a']);
    const ts = live
      .filter((e) => e.get('host') === 'a')
      .toTimeSeries('filtered');
    expect(ts).toBeInstanceOf(TimeSeries);
    expect(ts.name).toBe('filtered');
    expect(ts.length).toBe(2);
    expect(ts.at(0)?.get('value')).toBe(10);
    expect(ts.at(1)?.get('value')).toBe(30);
  });

  it('new events flow through chained views', () => {
    const live = makeLive();
    const view = live
      .filter((e) => e.get('host') === 'a')
      .map(
        (e) =>
          new Event(e.key(), {
            ...e.data(),
            value: (e.get('value') as number) * 10,
          }),
      );

    const received: number[] = [];
    view.on('event', (e) => received.push(e.get('value') as number));

    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a']);
    expect(received).toEqual([100, 300]);
    expect(view.length).toBe(2);
    view.dispose();
  });

  it('new events flow through filter → aggregate', () => {
    const live = makeLive();
    const agg = live
      .filter((e) => e.get('host') === 'a')
      .aggregate(Sequence.every('5s'), { value: 'sum' });
    const closed: number[] = [];
    agg.on('event', (e) => closed.push(e.get('value') as number));

    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a']);
    expect(closed).toEqual([]);

    live.push([5000, 40, 'a']);
    expect(closed).toEqual([40]); // 10+30
    agg.dispose();
  });
});

// ── toTimeSeries ───────────────────────────────────────────────

describe('toTimeSeries', () => {
  it('creates an immutable snapshot', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const view = live.filter(() => true);
    const ts = view.toTimeSeries();
    expect(ts).toBeInstanceOf(TimeSeries);
    expect(ts.length).toBe(2);
    view.dispose();
  });

  it('uses view name by default', () => {
    const live = makeLive();
    const view = live.filter(() => true);
    expect(view.toTimeSeries().name).toBe('test');
    view.dispose();
  });

  it('snapshot is independent of future pushes', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    const view = live.filter(() => true);
    const ts = view.toTimeSeries();
    live.push([1000, 20, 'b']);
    expect(ts.length).toBe(1);
    expect(view.length).toBe(2);
    view.dispose();
  });

  it('snapshot works with TimeSeries operations', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a'], [2000, 30, 'b']);
    const ts = live.filter((e) => e.get('host') === 'a').toTimeSeries();
    expect(ts.reduce('value', 'sum')).toBe(30);
  });
});

// ── select() ───────────────────────────────────────────────────

describe('select()', () => {
  it('narrows columns', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const view = live.select('value');
    expect(view.length).toBe(2);
    expect(view.at(0)?.get('value')).toBe(10);
    expect(view.at(0)?.data()).toEqual({ value: 10 });
    view.dispose();
  });

  it('updates schema to only selected columns', () => {
    const live = makeLive();
    const view = live.select('value');
    expect(view.schema.length).toBe(2); // time + value
    expect(view.schema[1]!.name).toBe('value');
    view.dispose();
  });

  it('receives new events with narrowed columns', () => {
    const live = makeLive();
    const view = live.select('host');
    live.push([0, 10, 'a']);
    expect(view.at(0)?.get('host')).toBe('a');
    expect(view.at(0)?.data()).toEqual({ host: 'a' });
    view.dispose();
  });

  it('preserves event keys', () => {
    const live = makeLive();
    live.push([5000, 10, 'a']);
    const view = live.select('value');
    expect(view.at(0)?.begin()).toBe(5000);
    view.dispose();
  });

  it('select multiple columns', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    const view = live.select('value', 'host');
    expect(view.at(0)?.data()).toEqual({ value: 10, host: 'a' });
    expect(view.schema.length).toBe(3); // time + value + host
    view.dispose();
  });

  it('chains with filter', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a']);
    const view = live.filter((e) => e.get('host') === 'a').select('value');
    expect(view.length).toBe(2);
    expect(view.at(0)?.data()).toEqual({ value: 10 });
    expect(view.at(1)?.data()).toEqual({ value: 30 });
    view.dispose();
  });

  it('select → aggregate', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [5000, 30, 'a']);
    const agg = live.select('value').aggregate(Sequence.every('5s'), {
      value: 'sum',
    });
    expect(agg.closedCount).toBe(1);
    expect(agg.closed().at(0)?.get('value')).toBe(30); // 10+20
    agg.dispose();
  });

  it('toTimeSeries preserves narrowed schema', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const ts = live.select('value').toTimeSeries();
    expect(ts.length).toBe(2);
    expect(ts.at(0)?.data()).toEqual({ value: 10 });
  });

  it('on LiveView chains correctly', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const view = live.filter(() => true).select('value');
    expect(view.length).toBe(2);
    expect(view.at(0)?.data()).toEqual({ value: 10 });
    view.dispose();
  });
});

// ── window() ───────────────────────────────────────────────────

describe('window() time-based', () => {
  it('keeps events within time window', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [3000, 20, 'a'], [6000, 30, 'a']);
    const view = live.window('5s');
    // cutoff = 6000 - 5000 = 1000, event at 0 evicted
    expect(view.length).toBe(2);
    expect(view.first()?.get('value')).toBe(20);
    expect(view.last()?.get('value')).toBe(30);
    view.dispose();
  });

  it('evicts as new events arrive', () => {
    const live = makeLive();
    const view = live.window('3s');
    live.push([0, 10, 'a'], [1000, 20, 'a'], [2000, 30, 'a']);
    expect(view.length).toBe(3);

    live.push([5000, 40, 'a']);
    // cutoff = 5000 - 3000 = 2000, events at 0 and 1000 evicted
    expect(view.length).toBe(2);
    expect(view.first()?.get('value')).toBe(30);
    view.dispose();
  });

  it('keeps events exactly at boundary', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [5000, 20, 'a']);
    const view = live.window('5s');
    // cutoff = 5000 - 5000 = 0, event at 0 NOT evicted (not < 0)
    expect(view.length).toBe(2);
    view.dispose();
  });

  it('empty source produces empty window', () => {
    const live = makeLive();
    const view = live.window('5s');
    expect(view.length).toBe(0);
    view.dispose();
  });

  it('toTimeSeries reflects current window', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [3000, 20, 'a'], [6000, 30, 'a']);
    const view = live.window('5s');
    const ts = view.toTimeSeries();
    expect(ts.length).toBe(2);
    expect(ts.at(0)?.get('value')).toBe(20);
    view.dispose();
  });

  it('on("event") fires for every event entering the window', () => {
    const live = makeLive();
    const view = live.window('5s');
    const received: number[] = [];
    view.on('event', (e) => received.push(e.get('value') as number));

    live.push([0, 10, 'a'], [3000, 20, 'a'], [6000, 30, 'a']);
    expect(received).toEqual([10, 20, 30]);
    view.dispose();
  });

  it('from LiveSeries.window()', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [3000, 20, 'a'], [6000, 30, 'a']);
    const view = live.window('5s');
    expect(view.length).toBe(2);
    expect(view.first()?.get('value')).toBe(20);
    view.dispose();
  });
});

describe('window() count-based', () => {
  it('keeps last N events', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a'], [2000, 30, 'a'], [3000, 40, 'a']);
    const view = live.window(2);
    expect(view.length).toBe(2);
    expect(view.first()?.get('value')).toBe(30);
    expect(view.last()?.get('value')).toBe(40);
    view.dispose();
  });

  it('evicts oldest when new events arrive', () => {
    const live = makeLive();
    const view = live.window(3);
    live.push([0, 10, 'a'], [1000, 20, 'a'], [2000, 30, 'a']);
    expect(view.length).toBe(3);

    live.push([3000, 40, 'a']);
    expect(view.length).toBe(3);
    expect(view.first()?.get('value')).toBe(20);
    view.dispose();
  });

  it('handles fewer events than window size', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    const view = live.window(100);
    expect(view.length).toBe(1);
    view.dispose();
  });

  it('window of 1 always has the latest', () => {
    const live = makeLive();
    const view = live.window(1);
    live.push([0, 10, 'a']);
    expect(view.at(0)?.get('value')).toBe(10);
    live.push([1000, 20, 'a']);
    expect(view.length).toBe(1);
    expect(view.at(0)?.get('value')).toBe(20);
    view.dispose();
  });
});

describe('window() chaining', () => {
  it('filter → window', () => {
    const live = makeLive();
    live.push(
      [0, 10, 'a'],
      [1000, 20, 'b'],
      [2000, 30, 'a'],
      [3000, 40, 'b'],
      [6000, 50, 'a'],
    );
    const view = live.filter((e) => e.get('host') === 'a').window('5s');
    // filtered: [0,10,a], [2000,30,a], [6000,50,a]
    // window cutoff = 6000 - 5000 = 1000, event at 0 evicted
    expect(view.length).toBe(2);
    expect(view.first()?.get('value')).toBe(30);
    expect(view.last()?.get('value')).toBe(50);
    view.dispose();
  });

  it('window → aggregate', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [3000, 20, 'a'], [6000, 30, 'a']);
    const agg = live.window('5s').aggregate(Sequence.every('5s'), {
      value: 'sum',
    });
    // window has events at 3000 and 6000
    // aggregate sees those and closes [0,5000) with 20
    expect(agg.closedCount).toBe(1);
    agg.dispose();
  });

  it('window → toTimeSeries → batch operations', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a'], [2000, 30, 'a']);
    const ts = live.window(2).toTimeSeries();
    expect(ts.reduce('value', 'sum')).toBe(50); // 20+30
  });

  it('rejects invalid window size', () => {
    const live = makeLive();
    expect(() => live.window(0)).toThrow();
    expect(() => live.window(-1)).toThrow();
    expect(() => live.window(1.5)).toThrow();
  });
});

// ── Edge cases ─────────────────────────────────────────────────

describe('window() eviction by head index ([PND-LVWIN])', () => {
  // The window evicts by advancing a head index and compacts the array
  // only now and then, so most of the time the buffer holds evicted
  // events in front of the view's own. Check every reader against a
  // plainly computed window after each push, across many compactions.
  type Row = readonly [number, number, string];

  function expectMatches(
    view: LiveView<typeof schema>,
    expected: readonly Row[],
  ) {
    const n = expected.length;
    expect(view.length).toBe(n);
    expect(view.count()).toBe(n);
    expect(view.first()?.begin()).toBe(expected[0]?.[0]);
    expect(view.last()?.begin()).toBe(expected[n - 1]?.[0]);
    for (let i = 0; i < n; i++) {
      expect(view.at(i)?.begin()).toBe(expected[i]![0]);
      expect(view.at(i - n)?.begin()).toBe(expected[i]![0]);
    }
    expect(view.at(n)).toBeUndefined();
    expect(view.at(-n - 1)).toBeUndefined();

    expect(Array.from(view.keyColumn().begin)).toEqual(
      expected.map((r) => r[0]),
    );
    expect(Array.from(view.column('value').toFloat64Array())).toEqual(
      expected.map((r) => r[1]),
    );
    const ts = view.toTimeSeries();
    expect(ts.length).toBe(n);
    expect(ts.at(0)?.get('value')).toBe(expected[0]?.[1]);

    const seen: number[] = [];
    view.every((e, i) => {
      seen.push(i);
      expect(e.begin()).toBe(expected[i]![0]);
      return true;
    });
    expect(seen).toEqual(expected.map((_, i) => i));
    if (n > 0) {
      const mid = expected[n >> 1]!;
      expect(view.find((e) => e.begin() === mid[0])?.get('value')).toBe(mid[1]);
      expect(view.find((_, i) => i === n - 1)?.begin()).toBe(
        expected[n - 1]![0],
      );
      expect(view.some((e) => e.begin() === expected[0]![0] - 1)).toBe(false);
      expect(view.bisect(mid[0])).toBe(n >> 1);
      expect(view.includesKey(mid[0])).toBe(true);
      expect(view.includesKey(expected[0]![0] - 1)).toBe(false);
      const before = expected.filter((r) => r[0] <= mid[0] + 1).pop()!;
      expect(view.atOrBefore(mid[0] + 1)?.begin()).toBe(before[0]);
      expect(view.atOrBefore(expected[0]![0] - 1)).toBeUndefined();
      expect(view.atOrAfter(expected[0]![0] - 1)?.begin()).toBe(
        expected[0]![0],
      );
      expect(view.atOrAfter(expected[n - 1]![0] + 1)).toBeUndefined();
    }

    const groups = view
      .partitionBy('host')
      .toMap((g) => Array.from(g.keyColumn().begin));
    for (const host of ['a', 'b']) {
      expect(groups.get(host) ?? []).toEqual(
        expected.filter((r) => r[2] === host).map((r) => r[0]),
      );
    }
  }

  // 1,000 rows, 1 to 3 ms apart, alternating hosts.
  const rows: Row[] = [];
  for (let i = 0, t = 0; i < 1000; i++, t += 1 + (i % 3))
    rows.push([t, i, i % 2 === 0 ? 'a' : 'b']);

  it('count window matches the last N events after every push', () => {
    const live = makeLive();
    const view = live.window(37);
    for (let i = 0; i < rows.length; i++) {
      live.push(rows[i]!);
      expectMatches(view, rows.slice(Math.max(0, i + 1 - 37), i + 1));
    }
    view.dispose();
  });

  it('time window matches the events within ms of the newest', () => {
    const live = makeLive();
    const view = live.window('50ms');
    for (let i = 0; i < rows.length; i++) {
      live.push(rows[i]!);
      const cutoff = rows[i]![0] - 50;
      expectMatches(
        view,
        rows.slice(0, i + 1).filter((r) => r[0] >= cutoff),
      );
    }
    view.dispose();
  });

  it('batched pushes give the same window as single pushes', () => {
    const live = makeLive();
    const view = live.window(100);
    for (let i = 0; i < rows.length; i += 64)
      live.push(...rows.slice(i, i + 64));
    expectMatches(view, rows.slice(-100));
    view.dispose();
  });

  it('LiveView.window() over a view evicts the same way', () => {
    const live = makeLive();
    const view = live.filter(() => true).window('50ms');
    for (const row of rows) live.push(row);
    const cutoff = rows[rows.length - 1]![0] - 50;
    expectMatches(
      view,
      rows.filter((r) => r[0] >= cutoff),
    );
    view.dispose();
  });

  it('mirrors source eviction on top of the window', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      retention: { maxEvents: 20 },
    });
    const view = live.window(50);
    const evicted: number[] = [];
    view.on('evict', (es) => evicted.push(...es.map((e) => e.begin())));
    for (const row of rows) live.push(row);
    // Retention (20) is tighter than the window (50): the view follows it.
    expectMatches(view, rows.slice(-20));
    // Every event the source dropped while still in the view was reported
    // once, in order.
    expect(evicted).toEqual(rows.slice(0, -20).map((r) => r[0]));
    view.dispose();
  });

  it('a custom evict callback sees only the view’s events', () => {
    const live = makeLive();
    const lengths: number[] = [];
    const view = new LiveView<typeof schema>(live, (e: any) => e, {
      evict: (events) => {
        lengths.push(events.length);
        return events.length > 10 ? events.length - 10 : 0;
      },
    } as any);
    for (const row of rows.slice(0, 100)) live.push(row);
    expectMatches(view, rows.slice(90, 100));
    expect(Math.max(...lengths)).toBe(11);
    view.dispose();
  });

  it('a custom evict callback returning a fraction drops whole events', () => {
    // As `splice(0, 1.5)` did before: 1.5 drops one event.
    const live = makeLive();
    const view = new LiveView<typeof schema>(live, (e: any) => e, {
      evict: (events) => (events.length >= 3 ? 1.5 : 0),
    } as any);
    for (const row of rows.slice(0, 6)) live.push(row);
    expectMatches(view, rows.slice(4, 6));
    view.dispose();
  });

  it('window and source retention evicting in turn', () => {
    // Bursts of 40 rows 1 ms apart, then 10 rows 9 ms apart: in a burst
    // the window (30 events) is the tighter limit, in the sparse stretch
    // the source's retention (40 ms) is. The view must hold the
    // intersection.
    const live = new LiveSeries({
      name: 'test',
      schema,
      retention: { maxAge: '40ms' },
    });
    const view = live.window(30);
    let windowBound = 0;
    let retentionBound = 0;
    const seen: Row[] = [];
    for (let i = 0, t = 0; i < 600; i++, t += i % 50 < 40 ? 1 : 9) {
      const row: Row = [t, i, i % 2 === 0 ? 'a' : 'b'];
      seen.push(row);
      live.push(row);
      const expected = seen.slice(-30).filter((r) => r[0] >= t - 40);
      expectMatches(view, expected);
      if (expected.length === 30) windowBound++;
      else retentionBound++;
    }
    expect(windowBound).toBeGreaterThan(50);
    expect(retentionBound).toBeGreaterThan(50);
    view.dispose();
  });

  it('keeps its buffer within about twice the view', () => {
    // Evicted slots are reclaimed by compaction; without it the buffer
    // would grow with every event pushed.
    const time = makeLive();
    const timeView = time.window('50ms');
    const count = makeLive();
    const countView = count.window(37);
    const capped = new LiveSeries({
      name: 'test',
      schema,
      retention: { maxEvents: 25 },
    });
    const mirrored = capped.filter(() => true);
    for (const row of rows) {
      time.push(row);
      count.push(row);
      capped.push(row);
      for (const v of [timeView, countView, mirrored])
        expect(v._bufferLength).toBeLessThanOrEqual(2 * v.length + 1);
    }
    // Disposing compacts, so a kept reference holds only the live events.
    timeView.dispose();
    expect(timeView._bufferLength).toBe(timeView.length);
    countView.dispose();
    mirrored.dispose();
  });
});

describe('edge cases', () => {
  it('at out of bounds returns undefined', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    const view = live.filter(() => true);
    expect(view.at(5)).toBeUndefined();
    expect(view.at(-5)).toBeUndefined();
    view.dispose();
  });

  it('empty filter view first/last return undefined', () => {
    const live = makeLive();
    const view = live.filter(() => false);
    expect(view.first()).toBeUndefined();
    expect(view.last()).toBeUndefined();
    view.dispose();
  });

  it('many rapid pushes through filter', () => {
    const live = makeLive();
    const view = live.filter((e) => (e.get('value') as number) % 2 === 0);
    for (let i = 0; i < 1000; i++) {
      live.push([i * 1000, i, `h${i % 5}`]);
    }
    expect(view.length).toBe(500);
    expect(view.last()?.get('value')).toBe(998);
    view.dispose();
  });

  it('LiveAggregation accepts LiveView directly', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [5000, 30, 'a']);
    const view = live.filter((e) => e.get('host') === 'a');
    const agg = new LiveAggregation(view, Sequence.every('5s'), {
      value: 'sum',
    });
    expect(agg.closedCount).toBe(1);
    expect(agg.closed().at(0)?.get('value')).toBe(10);
    agg.dispose();
    view.dispose();
  });

  it('LiveRollingAggregation accepts LiveView directly', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a']);
    const view = live.filter((e) => e.get('host') === 'a');
    const r = new LiveRollingAggregation(view, '10s', { value: 'sum' });
    expect(r.value().value).toBe(40); // 10+30
    r.dispose();
    view.dispose();
  });
});

// ── Eviction mirroring ────────────────────────────────────────

describe('eviction mirroring', () => {
  it('view mirrors evictions from a retention-capped LiveSeries', () => {
    const live = new LiveSeries({
      name: 'capped',
      schema,
      retention: { maxEvents: 3 },
    });
    const view = live.filter((e) => (e.get('value') as number) > 0);

    // Fill to capacity
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c']);
    expect(view.length).toBe(3);

    // Push another — LiveSeries evicts the oldest, view should mirror
    live.push([3000, 40, 'd']);
    expect(live.length).toBe(3); // [1000, 2000, 3000]
    expect(view.length).toBe(3); // mirrored eviction: [20, 30, 40]
    expect(view.first()?.get('value')).toBe(20);
  });

  it('view fires evict listeners when mirroring', () => {
    const live = new LiveSeries({
      name: 'capped',
      schema,
      retention: { maxEvents: 2 },
    });
    const view = live.filter(() => true);

    live.push([0, 10, 'a'], [1000, 20, 'b']);

    const evicted: unknown[] = [];
    view.on('evict', (removed) => {
      evicted.push(...removed);
    });

    live.push([2000, 30, 'c']);
    expect(evicted.length).toBe(1);
    expect((evicted[0] as any).get('value')).toBe(10);
  });

  it('filtered view evicts only matching events', () => {
    const live = new LiveSeries({
      name: 'capped',
      schema,
      retention: { maxEvents: 3 },
    });
    // Only keep host='a' events
    const view = live.filter((e) => e.get('host') === 'a');

    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'a']);
    expect(view.length).toBe(2); // 10, 30

    // Evict oldest (t=0, host=a) — view should drop it
    live.push([3000, 40, 'b']);
    expect(live.length).toBe(3); // [1000, 2000, 3000]
    expect(view.length).toBe(1); // only t=2000 (host=a) remains
    expect(view.first()?.get('value')).toBe(30);
  });

  it('chained views propagate eviction', () => {
    const live = new LiveSeries({
      name: 'capped',
      schema,
      retention: { maxEvents: 3 },
    });
    const v1 = live.filter(() => true);
    const v2 = v1.map((e) => e);

    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c']);
    expect(v2.length).toBe(3);

    live.push([3000, 40, 'd']);
    expect(v2.length).toBe(3);
    expect(v2.first()?.get('value')).toBe(20);

    v2.dispose();
    v1.dispose();
  });

  it('does not subscribe to evict on LiveAggregation source', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [60_000, 20, 'b']);
    const agg = live.aggregate(Sequence.every('1m'), { value: 'sum' });

    // This should NOT throw — the EMITS_EVICT symbol prevents the
    // broken duck-typing path that used to route to the update set
    const view = new LiveView(agg as any, (e: any) => e);
    expect(view.length).toBe(agg.closedCount);

    // Push more data through — should not throw
    live.push([120_000, 30, 'c']);

    view.dispose();
    agg.dispose();
  });
});

// ── toTimeSeries() snapshot cache ──────────────────────────────

describe('toTimeSeries() snapshot cache', () => {
  it('returns the same instance for back-to-back identical-state calls', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const view = live.filter(() => true);
    const a = view.toTimeSeries();
    const b = view.toTimeSeries();
    expect(b).toBe(a); // cache hit — no rebuild
    expect(a.length).toBe(2);
    view.dispose();
  });

  it('invalidates on append', () => {
    const live = makeLive();
    const view = live.filter(() => true);
    live.push([0, 10, 'a']);
    const a = view.toTimeSeries();
    live.push([1000, 20, 'b']);
    const b = view.toTimeSeries();
    expect(b).not.toBe(a);
    expect(a.length).toBe(1);
    expect(b.length).toBe(2);
    expect(b.at(1)?.get('value')).toBe(20);
    view.dispose();
  });

  it('invalidates on source eviction (retention)', () => {
    const live = new LiveSeries({
      name: 'r',
      schema,
      retention: { maxEvents: 2 },
    });
    const view = live.filter(() => true);
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const a = view.toTimeSeries();
    expect(a.length).toBe(2);
    live.push([2000, 30, 'c']); // evicts [0]
    const b = view.toTimeSeries();
    expect(b).not.toBe(a);
    expect(b.length).toBe(2);
    expect(b.first()?.get('value')).toBe(20);
    view.dispose();
  });

  it('invalidates on time-window eviction', () => {
    const live = makeLive();
    const view = live.window('3s');
    live.push([0, 10, 'a'], [1000, 20, 'a']);
    const a = view.toTimeSeries();
    expect(a.length).toBe(2);
    live.push([5000, 30, 'a']); // cutoff 2000 → evicts [0], [1000]
    const b = view.toTimeSeries();
    expect(b).not.toBe(a);
    expect(b.length).toBe(1);
    expect(b.first()?.get('value')).toBe(30);
    view.dispose();
  });

  it('rebuilds for a different name (cache holds only the latest)', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    const view = live.filter(() => true);
    const a = view.toTimeSeries('one');
    const b = view.toTimeSeries('two');
    expect(b).not.toBe(a);
    expect(a.name).toBe('one');
    expect(b.name).toBe('two');
    view.dispose();
  });

  it('cache hit returns fresh content, never a stale empty snapshot', () => {
    const live = makeLive();
    const view = live.filter(() => true);
    const empty = view.toTimeSeries();
    expect(empty.length).toBe(0);
    expect(view.toTimeSeries()).toBe(empty); // empty state caches too
    live.push([0, 10, 'a']);
    const filled = view.toTimeSeries();
    expect(filled).not.toBe(empty);
    expect(filled.length).toBe(1);
    view.dispose();
  });
});
