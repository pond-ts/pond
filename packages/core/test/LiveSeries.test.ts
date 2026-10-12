import { describe, expect, it, vi } from 'vitest';
import {
  LiveAggregation,
  LiveSeries,
  Sequence,
  LiveRollingAggregation,
  TimeSeries,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function makeLive(opts?: Partial<ConstructorParameters<typeof LiveSeries>[0]>) {
  return new LiveSeries({ name: 'test', schema, ...opts });
}

// ── Construction ────────────────────────────────────────────────

describe('LiveSeries construction', () => {
  it('creates an empty series', () => {
    const live = makeLive();
    expect(live.length).toBe(0);
    expect(live.name).toBe('test');
    expect(live.first()).toBeUndefined();
    expect(live.last()).toBeUndefined();
  });

  it('rejects graceWindow without reorder mode', () => {
    expect(() => makeLive({ ordering: 'strict', graceWindow: '5s' })).toThrow(
      /graceWindow.*reorder/,
    );
    expect(() => makeLive({ ordering: 'drop', graceWindow: '5s' })).toThrow(
      /graceWindow.*reorder/,
    );
  });

  it('accepts graceWindow with reorder mode', () => {
    expect(() =>
      makeLive({ ordering: 'reorder', graceWindow: '5s' }),
    ).not.toThrow();
  });

  it('rejects graceWindow that exceeds retention.maxAge', () => {
    // A late event accepted within a 30s grace would be evicted
    // immediately by a 10s retention window — the grace promise would
    // be empty. Fail at construction so the caller picks consistent
    // values.
    expect(() =>
      makeLive({
        ordering: 'reorder',
        graceWindow: '30s',
        retention: { maxAge: '10s' },
      }),
    ).toThrow(/graceWindow.*cannot exceed retention\.maxAge/);
  });

  it('accepts graceWindow without retention.maxAge (guard must not fire on partial config)', () => {
    expect(() =>
      makeLive({ ordering: 'reorder', graceWindow: '10s' }),
    ).not.toThrow();
    expect(() =>
      makeLive({
        ordering: 'reorder',
        graceWindow: '10s',
        retention: { maxEvents: 100 },
      }),
    ).not.toThrow();
  });

  it('accepts graceWindow equal to or less than retention.maxAge', () => {
    expect(() =>
      makeLive({
        ordering: 'reorder',
        graceWindow: '10s',
        retention: { maxAge: '10s' },
      }),
    ).not.toThrow();
    expect(() =>
      makeLive({
        ordering: 'reorder',
        graceWindow: '5s',
        retention: { maxAge: '1m' },
      }),
    ).not.toThrow();
  });

  it('grace + retention.maxAge preserve late events within grace', () => {
    // End-to-end: a late event accepted within grace must survive
    // retention pruning. Without the construction guard this test
    // would still pass for grace ≤ maxAge, but it pins the composition
    // and would fail if anyone widened retention to use maxAge only
    // without grace-awareness in the future.
    const live = makeLive({
      ordering: 'reorder',
      graceWindow: '5s',
      retention: { maxAge: '30s' },
    });
    live.push([30000, 1, 'a']); // latest = 30000
    live.push([26000, 2, 'b']); // 4s late, within grace
    expect(live.length).toBe(2);
    // Push enough to trigger retention — latest advances, old events evicted.
    live.push([60000, 3, 'c']); // cutoff = 30000; a@30000 stays, b@26000 evicted
    expect(live.length).toBe(2);
    expect(live.first()!.begin()).toBe(30000);
    expect(live.last()!.begin()).toBe(60000);
    // The key guarantee: at no point was b accepted *and then* evicted
    // in the same push — it lived between its insert and the later
    // `c` push, not for zero time.
  });

  it('rejects invalid schema', () => {
    expect(
      () => new LiveSeries({ name: 'bad', schema: [] as any, rows: [] }),
    ).toThrow();
  });
});

// ── Push and access ─────────────────────────────────────────────

describe('push and access', () => {
  it('pushes single rows', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    live.push([1000, 20, 'b']);
    expect(live.length).toBe(2);
    expect(live.at(0)?.get('value')).toBe(10);
    expect(live.at(1)?.get('host')).toBe('b');
  });

  it('pushes multiple rows at once', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c']);
    expect(live.length).toBe(3);
    expect(live.at(2)?.get('value')).toBe(30);
  });

  it('first and last accessors', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    expect(live.first()?.get('value')).toBe(10);
    expect(live.last()?.get('value')).toBe(20);
  });

  it('at supports negative indices', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c']);
    expect(live.at(-1)?.get('value')).toBe(30);
    expect(live.at(-2)?.get('value')).toBe(20);
  });

  it('normalizes timestamp keys', () => {
    const live = makeLive();
    live.push([1000, 10, 'a']);
    expect(live.at(0)?.begin()).toBe(1000);
  });

  it('validates row length', () => {
    const live = makeLive();
    expect(() => live.push([0, 10] as any)).toThrow(/expected 3.*got 2/);
  });

  it('validates required columns', () => {
    const live = makeLive();
    expect(() => live.push([0, undefined, 'a'] as any)).toThrow(/required/);
  });

  it('validates cell types', () => {
    const live = makeLive();
    expect(() => live.push([0, 'not-a-number', 'a'] as any)).toThrow(
      /expected finite number/,
    );
  });

  it('push with no arguments is a no-op', () => {
    const live = makeLive();
    live.push();
    expect(live.length).toBe(0);
  });

  it('supports optional columns', () => {
    const optSchema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number', required: false },
    ] as const;
    const live = new LiveSeries({ name: 'opt', schema: optSchema });
    live.push([0, undefined]);
    expect(live.at(0)?.get('value')).toBeUndefined();
  });
});

// ── Internal trusted-pipeline path ──────────────────────────────

describe('_pushTrustedEvents (internal trusted path)', () => {
  it('inserts events without re-validation, mirroring pushMany', () => {
    const source = makeLive();
    source.push([0, 10, 'a'], [1000, 20, 'b']);

    const trusted = makeLive();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (trusted as any)._pushTrustedEvents([source.at(0)!, source.at(1)!]);

    expect(trusted.length).toBe(2);
    expect(trusted.at(0)!.get('value')).toBe(10);
    expect(trusted.at(1)!.get('host')).toBe('b');
  });

  it('fires event/batch listeners and applies retention like pushMany', () => {
    const source = makeLive();
    source.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c']);

    const trusted = makeLive({ retention: { maxEvents: 2 } });
    let eventFires = 0;
    let batchSize = 0;
    let evictedSize = 0;
    trusted.on('event', () => eventFires++);
    trusted.on('batch', (events) => (batchSize = events.length));
    trusted.on('evict', (events) => (evictedSize = events.length));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (trusted as any)._pushTrustedEvents([
      source.at(0)!,
      source.at(1)!,
      source.at(2)!,
    ]);

    expect(eventFires).toBe(3);
    expect(batchSize).toBe(3);
    // maxEvents: 2 evicts the oldest after the batch
    expect(evictedSize).toBe(1);
    expect(trusted.length).toBe(2);
    expect(trusted.first()!.begin()).toBe(1000);
  });

  it('honors ordering rules — strict rejects out-of-order even on the trusted path', () => {
    // The trust contract is only about validation+allocation; ordering
    // is part of #insert and still applies.
    const source = makeLive();
    source.push([0, 10, 'a'], [2000, 20, 'b']);

    const trusted = makeLive(); // strict default
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() =>
      (trusted as any)._pushTrustedEvents([source.at(1)!]),
    ).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => (trusted as any)._pushTrustedEvents([source.at(0)!])).toThrow(
      /out-of-order/,
    );
  });

  it('no-op for empty array', () => {
    const trusted = makeLive();
    let fires = 0;
    trusted.on('batch', () => fires++);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (trusted as any)._pushTrustedEvents([]);
    expect(trusted.length).toBe(0);
    expect(fires).toBe(0);
  });
});

// ── Ordering modes ──────────────────────────────────────────────

describe('ordering: strict', () => {
  it('accepts in-order events', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    expect(live.length).toBe(2);
  });

  it('accepts same-timestamp events', () => {
    const live = makeLive();
    live.push([1000, 10, 'a'], [1000, 20, 'b']);
    expect(live.length).toBe(2);
  });

  it('throws on out-of-order events', () => {
    const live = makeLive();
    live.push([1000, 10, 'a']);
    expect(() => live.push([500, 20, 'b'])).toThrow(/out-of-order/);
  });
});

describe('ordering: drop', () => {
  it('silently drops out-of-order events', () => {
    const live = makeLive({ ordering: 'drop' });
    live.push([1000, 10, 'a']);
    live.push([500, 20, 'b']);
    expect(live.length).toBe(1);
    expect(live.at(0)?.get('value')).toBe(10);
  });

  it('accepts in-order events normally', () => {
    const live = makeLive({ ordering: 'drop' });
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    expect(live.length).toBe(2);
  });

  it('does not fire event listener for dropped events', () => {
    const live = makeLive({ ordering: 'drop' });
    const events: number[] = [];
    live.on('event', (e) => events.push(e.get('value') as number));
    live.push([1000, 10, 'a'], [500, 20, 'b'], [2000, 30, 'c']);
    expect(events).toEqual([10, 30]);
  });
});

describe('ordering: reorder', () => {
  it('inserts out-of-order events in sorted position', () => {
    const live = makeLive({ ordering: 'reorder' });
    live.push([2000, 30, 'c']);
    live.push([0, 10, 'a']);
    live.push([1000, 20, 'b']);
    expect(live.at(0)?.get('value')).toBe(10);
    expect(live.at(1)?.get('value')).toBe(20);
    expect(live.at(2)?.get('value')).toBe(30);
  });

  it('respects grace window', () => {
    const live = makeLive({ ordering: 'reorder', graceWindow: '5s' });
    live.push([10000, 10, 'a']);
    live.push([8000, 20, 'b']); // within 5s grace
    expect(live.length).toBe(2);
  });

  it('throws when event is outside grace window', () => {
    const live = makeLive({ ordering: 'reorder', graceWindow: '5s' });
    live.push([10000, 10, 'a']);
    expect(() => live.push([1000, 20, 'b'])).toThrow(/outside grace window/);
  });

  it('allows unlimited reorder without grace window', () => {
    const live = makeLive({ ordering: 'reorder' });
    live.push([10000, 10, 'a']);
    live.push([0, 20, 'b']);
    expect(live.at(0)?.begin()).toBe(0);
    expect(live.at(1)?.begin()).toBe(10000);
  });

  it('stable insert for same-timestamp events', () => {
    const live = makeLive({ ordering: 'reorder' });
    live.push([1000, 10, 'a']);
    live.push([1000, 20, 'b']);
    live.push([500, 5, 'c']);
    expect(live.at(0)?.get('value')).toBe(5);
    expect(live.at(1)?.get('value')).toBe(10);
    expect(live.at(2)?.get('value')).toBe(20);
  });
});

// ── Retention ───────────────────────────────────────────────────

describe('retention: maxEvents', () => {
  it('evicts oldest events when limit exceeded', () => {
    const live = makeLive({ retention: { maxEvents: 3 } });
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c'], [3000, 40, 'd']);
    expect(live.length).toBe(3);
    expect(live.first()?.get('value')).toBe(20);
    expect(live.last()?.get('value')).toBe(40);
  });

  it('fires evict subscription', () => {
    const live = makeLive({ retention: { maxEvents: 2 } });
    const evicted: number[] = [];
    live.on('evict', (events) => {
      for (const e of events) evicted.push(e.get('value') as number);
    });
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c']);
    expect(evicted).toEqual([10]);
  });
});

describe('retention: maxAge', () => {
  it('evicts events older than maxAge relative to latest', () => {
    const live = makeLive({ retention: { maxAge: '5s' } });
    live.push([0, 10, 'a'], [3000, 20, 'b'], [6000, 30, 'c'], [10000, 40, 'd']);
    expect(live.first()?.begin()).toBeGreaterThanOrEqual(5000);
  });

  it('keeps events exactly at the boundary', () => {
    const live = makeLive({ retention: { maxAge: '5s' } });
    live.push([0, 10, 'a'], [5000, 20, 'b']);
    // cutoff = 5000 - 5000 = 0, event at 0 has begin === cutoff, so NOT evicted
    expect(live.length).toBe(2);
  });
});

describe('retention: combined', () => {
  it('applies maxEvents and maxAge together', () => {
    const live = makeLive({
      retention: { maxEvents: 10, maxAge: '3s' },
    });
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c'], [5000, 40, 'd']);
    // maxAge cutoff = 5000 - 3000 = 2000, so events at 0 and 1000 are evicted
    expect(live.first()?.begin()).toBe(2000);
  });
});

// ── Subscriptions ───────────────────────────────────────────────

describe('subscriptions', () => {
  it('event listener fires per event', () => {
    const live = makeLive();
    const values: number[] = [];
    live.on('event', (e) => values.push(e.get('value') as number));
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    expect(values).toEqual([10, 20]);
  });

  it('batch listener fires once per push call', () => {
    const live = makeLive();
    let batchCount = 0;
    let lastBatchSize = 0;
    live.on('batch', (events) => {
      batchCount++;
      lastBatchSize = events.length;
    });
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    expect(batchCount).toBe(1);
    expect(lastBatchSize).toBe(2);
  });

  it('evict listener fires when retention evicts', () => {
    const live = makeLive({ retention: { maxEvents: 2 } });
    const evicted: number[] = [];
    live.on('evict', (events) => {
      for (const e of events) evicted.push(e.get('value') as number);
    });
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    expect(evicted).toEqual([]);
    live.push([2000, 30, 'c']);
    expect(evicted).toEqual([10]);
  });

  it('unsubscribe stops listener', () => {
    const live = makeLive();
    const values: number[] = [];
    const unsub = live.on('event', (e) =>
      values.push(e.get('value') as number),
    );
    live.push([0, 10, 'a']);
    unsub();
    live.push([1000, 20, 'b']);
    expect(values).toEqual([10]);
  });

  it('multiple listeners on same event type', () => {
    const live = makeLive();
    const a: number[] = [];
    const b: number[] = [];
    live.on('event', (e) => a.push(e.get('value') as number));
    live.on('event', (e) => b.push(e.get('value') as number));
    live.push([0, 10, 'x']);
    expect(a).toEqual([10]);
    expect(b).toEqual([10]);
  });

  it('clear fires evict for all events', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const evicted: number[] = [];
    live.on('evict', (events) => {
      for (const e of events) evicted.push(e.get('value') as number);
    });
    live.clear();
    expect(evicted).toEqual([10, 20]);
    expect(live.length).toBe(0);
  });

  it('clear on empty series does not fire evict', () => {
    const live = makeLive();
    const called = vi.fn();
    live.on('evict', called);
    live.clear();
    expect(called).not.toHaveBeenCalled();
  });

  it('subscription ordering: event fires before batch', () => {
    const live = makeLive();
    const order: string[] = [];
    live.on('event', () => order.push('event'));
    live.on('batch', () => order.push('batch'));
    live.push([0, 10, 'a']);
    expect(order).toEqual(['event', 'batch']);
  });

  it('subscription ordering: batch fires before evict', () => {
    const live = makeLive({ retention: { maxEvents: 1 } });
    const order: string[] = [];
    live.on('batch', () => order.push('batch'));
    live.on('evict', () => order.push('evict'));
    live.push([0, 10, 'a']);
    live.push([1000, 20, 'b']);
    expect(order).toEqual(['batch', 'batch', 'evict']);
  });
});

// ── toTimeSeries ────────────────────────────────────────────────

describe('toTimeSeries', () => {
  it('creates an immutable snapshot', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'b']);
    const ts = live.toTimeSeries();
    expect(ts).toBeInstanceOf(TimeSeries);
    expect(ts.length).toBe(2);
    expect(ts.at(0)?.get('value')).toBe(10);
    expect(ts.at(1)?.get('host')).toBe('b');
  });

  it('snapshot is independent of future pushes', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    const snap = live.toTimeSeries();
    live.push([1000, 20, 'b']);
    expect(snap.length).toBe(1);
    expect(live.length).toBe(2);
  });

  it('uses custom name if provided', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    const ts = live.toTimeSeries('snapshot-1');
    expect(ts.name).toBe('snapshot-1');
  });

  it('uses LiveSeries name by default', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    expect(live.toTimeSeries().name).toBe('test');
  });

  it('empty LiveSeries produces empty TimeSeries', () => {
    const live = makeLive();
    const ts = live.toTimeSeries();
    expect(ts.length).toBe(0);
  });

  it('snapshot works after retention eviction', () => {
    const live = makeLive({ retention: { maxEvents: 2 } });
    live.push([0, 10, 'a'], [1000, 20, 'b'], [2000, 30, 'c']);
    const ts = live.toTimeSeries();
    expect(ts.length).toBe(2);
    expect(ts.at(0)?.get('value')).toBe(20);
  });

  it('snapshot preserves event keys', () => {
    const live = makeLive();
    live.push([5000, 10, 'a']);
    const ts = live.toTimeSeries();
    expect(ts.at(0)?.begin()).toBe(5000);
  });

  it('snapshot works with TimeSeries operations', () => {
    const live = makeLive();
    live.push([0, 10, 'a'], [1000, 20, 'a'], [2000, 30, 'b'], [3000, 40, 'b']);
    const ts = live.toTimeSeries();
    const groups = ts.groupBy('host');
    expect(groups.get('a')?.length).toBe(2);
    expect(groups.get('b')?.length).toBe(2);
  });
});

// ── Edge cases ──────────────────────────────────────────────────

describe('edge cases', () => {
  it('single event', () => {
    const live = makeLive();
    live.push([0, 42, 'x']);
    expect(live.length).toBe(1);
    expect(live.first()?.get('value')).toBe(42);
    expect(live.last()?.get('value')).toBe(42);
  });

  it('at out of bounds returns undefined', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    expect(live.at(5)).toBeUndefined();
    expect(live.at(-5)).toBeUndefined();
  });

  it('push after clear works normally', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    live.clear();
    live.push([1000, 20, 'b']);
    expect(live.length).toBe(1);
    expect(live.at(0)?.get('value')).toBe(20);
  });

  it('many rapid pushes', () => {
    const live = makeLive();
    for (let i = 0; i < 1000; i++) {
      live.push([i * 1000, i, `host-${i % 10}`]);
    }
    expect(live.length).toBe(1000);
    expect(live.last()?.get('value')).toBe(999);
  });

  it('retention with many rapid pushes', () => {
    const live = makeLive({ retention: { maxEvents: 100 } });
    for (let i = 0; i < 1000; i++) {
      live.push([i * 1000, i, `host-${i % 10}`]);
    }
    expect(live.length).toBe(100);
    expect(live.first()?.get('value')).toBe(900);
  });
});

// ── Convenience methods ─────────────────────────────────────────

describe('aggregate() method', () => {
  it('returns a LiveAggregation', () => {
    const live = makeLive();
    const agg = live.aggregate(Sequence.every('5s'), { value: 'avg' });
    expect(agg).toBeInstanceOf(LiveAggregation);
    agg.dispose();
  });

  it('subscribes with on()', () => {
    const live = makeLive();
    const closed: number[] = [];
    const agg = live.aggregate(Sequence.every('5s'), { value: 'sum' });
    agg.on('event', (e) => closed.push(e.get('value') as number));
    live.push([0, 10, 'a'], [2000, 20, 'a'], [5000, 30, 'a']);
    expect(closed).toEqual([30]);
    agg.dispose();
  });
});

describe('rolling() method', () => {
  it('returns a LiveRollingAggregation', () => {
    const live = makeLive();
    const r = live.rolling('5s', { value: 'avg' });
    expect(r).toBeInstanceOf(LiveRollingAggregation);
    r.dispose();
  });

  it('subscribes with on()', () => {
    const live = makeLive();
    const updates: number[] = [];
    const r = live.rolling('5s', { value: 'sum' });
    r.on('update', (v) => updates.push(v.value as number));
    live.push([0, 10, 'a'], [1000, 20, 'a']);
    expect(updates).toEqual([10, 30]);
    r.dispose();
  });
});
