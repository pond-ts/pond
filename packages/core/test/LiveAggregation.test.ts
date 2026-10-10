import { describe, expect, it, vi } from 'vitest';
import {
  LiveAggregation,
  LiveSeries,
  LiveView,
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

// ── Basic bucketing ─────────────────────────────────────────────

describe('LiveAggregation bucketing', () => {
  it('aggregates events into fixed buckets', () => {
    const live = makeLive();
    live.push(
      [0, 10, 'a'],
      [1000, 20, 'a'],
      [2000, 30, 'a'],
      [3000, 40, 'a'],
      [4000, 50, 'a'],
    );
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'avg',
    });
    // All in one open bucket [0, 5000)
    expect(agg.closedCount).toBe(0);
    expect(agg.hasOpenBucket).toBe(true);
    const snap = agg.snapshot();
    expect(snap.length).toBe(1);
    expect(snap.at(0)?.get('value')).toBe(30);
    agg.dispose();
  });

  it('closes bucket when event crosses boundary', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [2000, 20, 'a'], [4000, 30, 'a']);
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    expect(agg.closedCount).toBe(0);

    live.push([5000, 40, 'a']);
    expect(agg.closedCount).toBe(1);
    const closed = agg.closed();
    expect(closed.length).toBe(1);
    expect(closed.at(0)?.get('value')).toBe(60); // 10+20+30
    agg.dispose();
  });

  it('produces multiple closed buckets', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });

    // bucket [0, 5000): 10+20=30
    live.push([0, 10, 'a'], [2000, 20, 'a']);
    // bucket [5000, 10000): 30+40=70, closes [0,5000)
    live.push([5000, 30, 'a'], [7000, 40, 'a']);
    // bucket [10000, 15000): 50, closes [5000,10000)
    live.push([10000, 50, 'a']);

    expect(agg.closedCount).toBe(2);
    const closed = agg.closed();
    expect(closed.at(0)?.get('value')).toBe(30);
    expect(closed.at(1)?.get('value')).toBe(70);

    const snap = agg.snapshot();
    expect(snap.length).toBe(3);
    expect(snap.at(2)?.get('value')).toBe(50);
    agg.dispose();
  });

  it('snapshot includes open bucket', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'avg',
    });
    const snap = agg.snapshot();
    expect(snap.length).toBe(1);
    expect(snap.at(0)?.get('value')).toBe(10);

    const closed = agg.closed();
    expect(closed.length).toBe(0);
    agg.dispose();
  });

  it('empty source produces empty aggregation', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    expect(agg.closedCount).toBe(0);
    expect(agg.hasOpenBucket).toBe(false);
    expect(agg.snapshot().length).toBe(0);
    expect(agg.closed().length).toBe(0);
    agg.dispose();
  });
});

// ── Multiple reducers ───────────────────────────────────────────

describe('multiple reducers', () => {
  it('aggregates multiple columns', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a'], [5000, 30, 'b']);
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'avg',
      host: 'keep',
    });
    const snap = agg.snapshot();
    expect(snap.length).toBe(2);
    expect(snap.at(0)?.get('value')).toBe(15);
    expect(snap.at(0)?.get('host')).toBe('a');
    expect(snap.at(1)?.get('value')).toBe(30);
    agg.dispose();
  });

  it('supports percentile reducers', () => {
    const live = makeLive();
    live.push(
      [0, 10, 'a'],
      [1000, 20, 'a'],
      [2000, 30, 'a'],
      [3000, 40, 'a'],
      [4000, 50, 'a'],
    );
    const agg = new LiveAggregation(live, Sequence.every('10s'), {
      value: 'p50',
    });
    const snap = agg.snapshot();
    expect(snap.at(0)?.get('value')).toBe(30);
    agg.dispose();
  });
});

// ── Subscriptions ───────────────────────────────────────────────

describe('subscriptions', () => {
  it('event fires when a bucket finalizes', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    const closed: number[] = [];
    agg.on('event', (event) => {
      closed.push(event.get('value') as number);
    });

    live.push([0, 10, 'a'], [2000, 20, 'a']);
    expect(closed).toEqual([]);

    live.push([5000, 30, 'a']);
    expect(closed).toEqual([30]); // 10+20

    agg.dispose();
  });

  it('update fires on every source event', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    let updateCount = 0;
    agg.on('update', () => updateCount++);

    live.push([0, 10, 'a'], [1000, 20, 'a']);
    expect(updateCount).toBe(2);
    agg.dispose();
  });

  it('every on() overload returns an unsubscribe function', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    const counts = { event: 0, bucket: 0, update: 0 };
    const offEvent = agg.on('event', () => counts.event++);
    const offBucket = agg.on('bucket', () => counts.bucket++);
    const offUpdate = agg.on('update', () => counts.update++);

    live.push([0, 10, 'a'], [5000, 20, 'a']);
    expect(counts).toEqual({ event: 1, bucket: 2, update: 2 });

    offEvent();
    offBucket();
    offUpdate();
    live.push([10000, 30, 'a']);
    expect(counts).toEqual({ event: 1, bucket: 2, update: 2 });

    // Idempotent.
    offEvent();
    offBucket();
    offUpdate();
    agg.dispose();
  });

  it('unsubscribing one listener leaves the others attached', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    const a: number[] = [];
    const b: number[] = [];
    const offA = agg.on('event', (e) => a.push(e.get('value') as number));
    agg.on('event', (e) => b.push(e.get('value') as number));
    live.push([0, 10, 'a'], [5000, 20, 'a']);
    offA();
    live.push([10000, 30, 'a']);
    expect(a).toEqual([10]);
    expect(b).toEqual([10, 20]);
    agg.dispose();
  });

  it("throws on an unknown type, naming 'event' for the removed 'close'", () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    expect(() => (agg as any).on('close', () => {})).toThrow(
      /'close' was removed — use 'event'/,
    );
    expect(() => (agg as any).on('nope', () => {})).toThrow(TypeError);
    agg.dispose();
  });

  it('dispose stops receiving source events', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    let count = 0;
    agg.on('update', () => count++);
    live.push([0, 10, 'a']);
    expect(count).toBe(1);
    agg.dispose();
    live.push([1000, 20, 'a']);
    expect(count).toBe(1);
  });
});

// ── Interval keys ───────────────────────────────────────────────

describe('output series', () => {
  it('closed buckets have interval keys', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [5000, 20, 'a']);
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    const closed = agg.closed();
    expect(closed.at(0)?.begin()).toBe(0);
    expect(closed.at(0)?.end()).toBe(5000);
    agg.dispose();
  });

  it('snapshot is a valid TimeSeries for further operations', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a'], [5000, 30, 'b'], [6000, 40, 'b']);
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    // Push one more to close the first two buckets
    live.push([10000, 50, 'c']);
    const snap = agg.snapshot();
    expect(snap.length).toBe(3);
    // Can call TimeSeries methods on the snapshot
    expect(snap.reduce('value', 'sum')).toBe(10 + 20 + 30 + 40 + 50);
    agg.dispose();
  });
});

// ── Processes existing events ───────────────────────────────────

describe('existing events', () => {
  it('processes events already in the source', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [2000, 20, 'a'], [5000, 30, 'a']);

    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    // [0, 5000) was closed by the event at 5000
    expect(agg.closedCount).toBe(1);
    expect(agg.closed().at(0)?.get('value')).toBe(30);
    expect(agg.snapshot().at(1)?.get('value')).toBe(30);
    agg.dispose();
  });
});

// ── Edge cases ──────────────────────────────────────────────────

describe('edge cases', () => {
  it('gap between buckets creates separate closed entries', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    // Skip directly to bucket [15000, 20000)
    live.push([15000, 20, 'a']);
    // The [0, 5000) bucket closed
    expect(agg.closedCount).toBe(1);
    expect(agg.closed().at(0)?.get('value')).toBe(10);
    agg.dispose();
  });

  it('rejects unknown column', () => {
    const live = makeLive();
    expect(
      () =>
        new LiveAggregation(live, Sequence.every('5s'), {
          nonexistent: 'sum',
        } as any),
    ).toThrow(/unknown source column/);
  });

  it('works with 1-second buckets', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('1s'), {
      value: 'sum',
    });
    live.push([0, 1, 'a'], [500, 2, 'a'], [1000, 3, 'a'], [1500, 4, 'a']);
    expect(agg.closedCount).toBe(1);
    expect(agg.closed().at(0)?.get('value')).toBe(3); // 1+2
    agg.dispose();
  });
});

// ── LiveSource interface ────────────────────────────────────────

describe('LiveSource interface', () => {
  it('exposes name and schema', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    expect(agg.name).toBe('test');
    expect(agg.schema[0]).toEqual({ name: 'time', kind: 'interval' });
    expect(agg.schema[1]).toEqual({
      name: 'value',
      kind: 'number',
      required: false,
    });
    agg.dispose();
  });

  it('length equals closedCount', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [5000, 20, 'a'], [10000, 30, 'a']);
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    expect(agg.length).toBe(2);
    expect(agg.length).toBe(agg.closedCount);
    agg.dispose();
  });

  it('at() returns closed bucket events', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [2000, 20, 'a'], [5000, 30, 'a']);
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    expect(agg.at(0)?.get('value')).toBe(30);
    expect(agg.at(0)?.begin()).toBe(0);
    expect(agg.at(0)?.end()).toBe(5000);
    agg.dispose();
  });

  it('at() supports negative indexing', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [5000, 20, 'a'], [10000, 30, 'a']);
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    expect(agg.at(-1)?.get('value')).toBe(20);
    expect(agg.at(-2)?.get('value')).toBe(10);
    agg.dispose();
  });

  it('on("event") fires on bucket close and returns unsubscribe', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    const values: number[] = [];
    const unsub = agg.on('event', (event) => {
      values.push(event.get('value') as number);
    });
    live.push([0, 10, 'a'], [5000, 20, 'a']);
    expect(values).toEqual([10]);

    unsub();
    live.push([10000, 30, 'a']);
    expect(values).toEqual([10]);
    agg.dispose();
  });

  it('can feed a LiveView for further chaining', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    const view = new LiveView(agg as any, (event: any) =>
      (event.get('value') as number) > 25 ? event : undefined,
    );

    live.push([0, 10, 'a'], [2000, 20, 'a']);
    live.push([5000, 30, 'a']);
    // bucket [0,5000) closed with sum=30, passes filter
    expect(view.length).toBe(1);

    live.push([10000, 5, 'a']);
    // bucket [5000,10000) closed with sum=30, passes filter
    expect(view.length).toBe(2);

    live.push([15000, 1, 'a']);
    // bucket [10000,15000) closed with sum=5, filtered out
    expect(view.length).toBe(2);

    view.dispose();
    agg.dispose();
  });
});

// ── Grace period ────────────────────────────────────────────────

describe('grace period', () => {
  it('delays bucket closing by grace duration', () => {
    const live = makeLive();
    const agg = new LiveAggregation(
      live,
      Sequence.every('5s'),
      { value: 'sum' },
      { grace: '3s' },
    );

    live.push([0, 10, 'a'], [2000, 20, 'a']);
    live.push([5000, 30, 'a']);
    // Without grace, bucket [0,5000) would close here
    // With 3s grace: closeCutoff = 5000 - 3000 = 2000, bucket end=5000 > 2000
    expect(agg.closedCount).toBe(0);

    live.push([8000, 40, 'a']);
    // closeCutoff = 8000 - 3000 = 5000, bucket [0,5000) end=5000 <= 5000 → closes
    expect(agg.closedCount).toBe(1);
    expect(agg.closed().at(0)?.get('value')).toBe(30);
    agg.dispose();
  });

  it('accepts late events within grace window', () => {
    const live = new LiveSeries({ name: 'test', schema, ordering: 'reorder' });
    const agg = new LiveAggregation(
      live,
      Sequence.every('5s'),
      { value: 'sum' },
      { grace: '3s' },
    );

    live.push([0, 10, 'a'], [3000, 20, 'a']);
    live.push([5500, 30, 'a']);
    // Bucket [0,5000) still pending (closeCutoff = 5500-3000 = 2500)
    expect(agg.closedCount).toBe(0);

    // Late event arrives for bucket [0,5000)
    live.push([4500, 15, 'a']);
    // closeCutoff = max(5500,4500) - 3000 = 2500, bucket still pending
    expect(agg.closedCount).toBe(0);

    // Advance past grace
    live.push([8000, 50, 'a']);
    // closeCutoff = 8000-3000 = 5000, bucket [0,5000) closes
    expect(agg.closedCount).toBe(1);
    // Late event was included: 10+20+15 = 45
    expect(agg.closed().at(0)?.get('value')).toBe(45);
    agg.dispose();
  });

  it('drops events arriving after grace expires', () => {
    const live = new LiveSeries({ name: 'test', schema, ordering: 'reorder' });
    const agg = new LiveAggregation(
      live,
      Sequence.every('5s'),
      { value: 'sum' },
      { grace: '2s' },
    );

    live.push([0, 10, 'a'], [5000, 20, 'a']);
    // closeCutoff = 5000-2000 = 3000, bucket [0,5000) end=5000 > 3000, pending
    live.push([7000, 30, 'a']);
    // closeCutoff = 7000-2000 = 5000, bucket [0,5000) closes
    expect(agg.closedCount).toBe(1);
    expect(agg.closed().at(0)?.get('value')).toBe(10);

    // Very late event for bucket [0,5000) — already closed
    live.push([1000, 99, 'a']);
    // Should be dropped, not create a new bucket
    expect(agg.closedCount).toBe(1);
    expect(agg.closed().at(0)?.get('value')).toBe(10);
    agg.dispose();
  });

  it('handles multiple pending buckets', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      ordering: 'reorder',
      graceWindow: 15000,
    });
    const agg = new LiveAggregation(
      live,
      Sequence.every('5s'),
      { value: 'sum' },
      { grace: '10s' },
    );

    live.push([0, 10, 'a']); // bucket [0, 5000)
    live.push([6000, 20, 'a']); // bucket [5000, 10000)
    live.push([11000, 30, 'a']); // bucket [10000, 15000)
    // closeCutoff = 11000-10000 = 1000
    // All three pending: ends are 5000, 10000, 15000 — all > 1000
    expect(agg.closedCount).toBe(0);
    expect(agg.hasOpenBucket).toBe(true);

    // Out-of-order events to various buckets
    live.push([3000, 5, 'a']); // → bucket [0, 5000)
    live.push([8000, 7, 'a']); // → bucket [5000, 10000)

    // Advance watermark to close first two
    live.push([15000, 40, 'a']);
    // closeCutoff = 15000-10000 = 5000
    // bucket [0,5000) end=5000 <= 5000 → closes (10+5=15)
    // bucket [5000,10000) end=10000 > 5000 → still pending
    expect(agg.closedCount).toBe(1);
    expect(agg.closed().at(0)?.get('value')).toBe(15);

    live.push([20000, 50, 'a']);
    // closeCutoff = 20000-10000 = 10000
    // bucket [5000,10000) end=10000 <= 10000 → closes (20+7=27)
    // bucket [10000,15000) end=15000 > 10000 → still pending
    expect(agg.closedCount).toBe(2);
    expect(agg.closed().at(1)?.get('value')).toBe(27);
    agg.dispose();
  });

  it('closes pending buckets in chronological order', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      ordering: 'reorder',
      graceWindow: 30000,
    });
    const agg = new LiveAggregation(
      live,
      Sequence.every('5s'),
      { value: 'sum' },
      { grace: '10s' },
    );
    const closedValues: number[] = [];
    agg.on('event', (event) => {
      closedValues.push(event.get('value') as number);
    });

    live.push([0, 10, 'a']);
    live.push([6000, 20, 'a']);
    live.push([11000, 30, 'a']);

    // Jump far ahead to close all three at once
    live.push([25000, 100, 'a']);
    // closeCutoff = 25000-10000 = 15000
    // All three close: [0,5000), [5000,10000), [10000,15000)
    expect(closedValues).toEqual([10, 20, 30]);
    agg.dispose();
  });

  it('snapshot includes all pending buckets in order', () => {
    const live = makeLive();
    const agg = new LiveAggregation(
      live,
      Sequence.every('5s'),
      { value: 'sum' },
      { grace: '10s' },
    );

    live.push([0, 10, 'a']);
    live.push([6000, 20, 'a']);
    live.push([11000, 30, 'a']);

    const snap = agg.snapshot();
    expect(snap.length).toBe(3);
    expect(snap.at(0)?.get('value')).toBe(10);
    expect(snap.at(0)?.begin()).toBe(0);
    expect(snap.at(1)?.get('value')).toBe(20);
    expect(snap.at(1)?.begin()).toBe(5000);
    expect(snap.at(2)?.get('value')).toBe(30);
    expect(snap.at(2)?.begin()).toBe(10000);
    agg.dispose();
  });

  it('zero grace (default) matches immediate-close behavior', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });

    live.push([0, 10, 'a'], [2000, 20, 'a']);
    expect(agg.closedCount).toBe(0);

    live.push([5000, 30, 'a']);
    expect(agg.closedCount).toBe(1);
    expect(agg.closed().at(0)?.get('value')).toBe(30);
    agg.dispose();
  });

  it('grace with numeric milliseconds', () => {
    const live = makeLive();
    const agg = new LiveAggregation(
      live,
      Sequence.every('5s'),
      { value: 'sum' },
      { grace: 2000 },
    );

    live.push([0, 10, 'a']);
    live.push([5000, 20, 'a']);
    // closeCutoff = 5000-2000 = 3000, bucket end 5000 > 3000
    expect(agg.closedCount).toBe(0);

    live.push([7000, 30, 'a']);
    // closeCutoff = 7000-2000 = 5000, bucket end 5000 <= 5000
    expect(agg.closedCount).toBe(1);
    agg.dispose();
  });

  it('defaults grace from source graceWindow', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      ordering: 'reorder',
      graceWindow: '3s',
    });
    // No explicit grace option — should inherit 3000ms from source
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });

    live.push([0, 10, 'a']);
    live.push([5000, 20, 'a']);
    // With inherited 3s grace: closeCutoff = 5000-3000 = 2000, bucket end 5000 > 2000
    expect(agg.closedCount).toBe(0);

    live.push([8000, 30, 'a']);
    // closeCutoff = 8000-3000 = 5000, bucket end 5000 <= 5000
    expect(agg.closedCount).toBe(1);
    agg.dispose();
  });

  it('explicit grace overrides source graceWindow', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      ordering: 'reorder',
      graceWindow: '10s',
    });
    // Explicit grace: '1s' overrides source's 10s
    const agg = new LiveAggregation(
      live,
      Sequence.every('5s'),
      { value: 'sum' },
      { grace: '1s' },
    );

    live.push([0, 10, 'a']);
    live.push([5000, 20, 'a']);
    // With 1s grace: closeCutoff = 5000-1000 = 4000, bucket end 5000 > 4000
    expect(agg.closedCount).toBe(0);

    live.push([6000, 30, 'a']);
    // closeCutoff = 6000-1000 = 5000, bucket end 5000 <= 5000
    expect(agg.closedCount).toBe(1);
    agg.dispose();
  });

  it('source without graceWindow defaults to zero grace', () => {
    const live = makeLive(); // strict ordering, no graceWindow
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });

    live.push([0, 10, 'a']);
    live.push([5000, 20, 'a']);
    // No grace: closes immediately
    expect(agg.closedCount).toBe(1);
    agg.dispose();
  });
});

// ── Bucket event (provisional updates) ──────────────────────────

describe('on("bucket")', () => {
  it('fires on every accumulation with provisional state', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    const updates: number[] = [];
    agg.on('bucket', (event) => {
      updates.push(event.get('value') as number);
    });

    live.push([0, 10, 'a']);
    expect(updates).toEqual([10]);

    live.push([2000, 20, 'a']);
    expect(updates).toEqual([10, 30]);
    agg.dispose();
  });

  it('carries interval key for the bucket', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    const intervals: [number, number][] = [];
    agg.on('bucket', (event) => {
      intervals.push([event.begin(), event.end()]);
    });

    live.push([0, 10, 'a']);
    expect(intervals).toEqual([[0, 5000]]);

    live.push([6000, 20, 'a']);
    expect(intervals).toEqual([
      [0, 5000],
      [5000, 10000],
    ]);
    agg.dispose();
  });

  it('fires before event when bucket finalizes', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    const order: string[] = [];
    agg.on('bucket', () => order.push('bucket'));
    agg.on('event', () => order.push('event'));

    live.push([0, 10, 'a']);
    // bucket fires for accumulation
    expect(order).toEqual(['bucket']);

    live.push([5000, 20, 'a']);
    // bucket fires for new bucket accumulation, then event fires for old bucket
    expect(order).toEqual(['bucket', 'bucket', 'event']);
    agg.dispose();
  });

  it('tracks provisional updates with grace period', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      ordering: 'reorder',
    });
    const agg = new LiveAggregation(
      live,
      Sequence.every('5s'),
      { value: 'sum' },
      { grace: '5s' },
    );
    const bucketValues: number[] = [];
    agg.on('bucket', (event) => {
      if (event.begin() === 0) {
        bucketValues.push(event.get('value') as number);
      }
    });

    live.push([0, 10, 'a']);
    expect(bucketValues).toEqual([10]);

    live.push([2000, 20, 'a']);
    expect(bucketValues).toEqual([10, 30]);

    // Late event still accumulates into first bucket during grace
    live.push([3000, 5, 'a']);
    expect(bucketValues).toEqual([10, 30, 35]);
    agg.dispose();
  });

  it('does not fire for dropped late events', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      ordering: 'reorder',
    });
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    let bucketCount = 0;
    agg.on('bucket', () => bucketCount++);

    live.push([0, 10, 'a']);
    expect(bucketCount).toBe(1);

    live.push([5000, 20, 'a']);
    expect(bucketCount).toBe(2); // new bucket

    // Late event for already-closed bucket — dropped, no bucket event
    live.push([1000, 99, 'a']);
    expect(bucketCount).toBe(2);
    agg.dispose();
  });

  it('returns an unsubscribe function', () => {
    const live = makeLive();
    const agg = new LiveAggregation(live, Sequence.every('5s'), {
      value: 'sum',
    });
    let count = 0;
    const off = agg.on('bucket', () => count++);
    expect(typeof off).toBe('function');
    live.push([0, 10, 'a']);
    off();
    live.push([1000, 20, 'a']);
    expect(count).toBe(1);
    agg.dispose();
  });
});
