import { describe, expect, it, vi } from 'vitest';

import { LiveSeries } from '../../src/live/live-series.js';

/* -------------------------------------------------------------------------- */
/* Phase 1 pins — the chunked-backed LiveSeries path.                          */
/*                                                                             */
/* A top-level strict + time-keyed series auto-selects the chunked columnar    */
/* backing. The broad LiveSeries suite already runs through it (every          */
/* strict-time series); this file pins the chunked-specific contract: batch    */
/* intake, exact retention through LiveSeries, listener fan-out, the strict    */
/* batch order-check, LiveReduce over a chunked source (the FIFO fix), and     */
/* partitionBy (which keeps partitions array-backed).                          */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function chunkedLive(retention?: { maxEvents?: number; maxAge?: string }) {
  // ordering 'strict' (default) + time key → chunked backing.
  return new LiveSeries({ name: 'c', schema: SCHEMA, retention });
}

function batch(base: number, n: number) {
  return Array.from(
    { length: n },
    (_, i) => [base + i, base + i, `h${(base + i) % 3}`] as const,
  );
}

describe('chunked LiveSeries — batch intake + reads', () => {
  it('pushMany batches, reads across chunk boundaries', () => {
    const live = chunkedLive();
    live.pushMany(batch(0, 1000));
    live.pushMany(batch(1000, 1000));
    expect(live.length).toBe(2000);
    expect(live.at(0)!.get('value')).toBe(0);
    expect(live.at(1000)!.get('value')).toBe(1000);
    expect(live.last()!.get('value')).toBe(1999);
    expect(live.at(2000)).toBeUndefined();
  });

  it('at(i) is reference-stable', () => {
    const live = chunkedLive();
    live.pushMany(batch(0, 500));
    expect(live.at(42)).toBe(live.at(42));
  });

  it('single push() works (1-row chunk)', () => {
    const live = chunkedLive();
    live.push([1000, 7, 'a']);
    expect(live.length).toBe(1);
    expect(live.at(0)!.get('value')).toBe(7);
  });

  it('bisect / includesKey / atOrBefore on the chunked buffer', () => {
    const live = chunkedLive();
    for (let i = 0; i < 10; i += 1) live.push([i * 1000, i, 'a']);
    expect(live.bisect(5000)).toBe(5);
    expect(live.includesKey(5000)).toBe(true);
    expect(live.includesKey(5500)).toBe(false);
    expect(live.atOrBefore(5500)!.get('value')).toBe(5);
  });
});

describe('chunked LiveSeries — strict ordering', () => {
  it('throws on an out-of-order row within a batch', () => {
    const live = chunkedLive();
    expect(() =>
      live.pushMany([
        [2000, 2, 'a'],
        [1000, 1, 'a'],
      ]),
    ).toThrow();
  });

  it('throws when a batch starts before the current last', () => {
    const live = chunkedLive();
    live.pushMany(batch(0, 100)); // up to 99
    expect(() => live.push([50, 0, 'a'])).toThrow();
  });

  it('accepts equal timestamps (non-decreasing)', () => {
    const live = chunkedLive();
    live.pushMany([
      [1000, 1, 'a'],
      [1000, 2, 'a'],
    ]);
    expect(live.length).toBe(2);
  });
});

describe('chunked LiveSeries — exact retention', () => {
  it('maxEvents is exact (boundary-slice, not chunk-granular)', () => {
    const live = chunkedLive({ maxEvents: 1500 });
    live.pushMany(batch(0, 1000));
    live.pushMany(batch(1000, 1000));
    live.pushMany(batch(2000, 1000));
    expect(live.length).toBe(1500); // exact
    expect(live.at(0)!.get('value')).toBe(1500);
    expect(live.last()!.get('value')).toBe(2999);
  });

  it('maxAge is exact at the row level', () => {
    const live = chunkedLive({ maxAge: '5s' });
    live.push([0, 0, 'a']);
    live.push([1000, 1, 'a']);
    live.push([7000, 7, 'a']); // 0 and 1000 are > 5s behind 7000
    expect(live.length).toBe(1);
    expect(live.at(0)!.get('value')).toBe(7);
  });
});

describe('chunked LiveSeries — listener fan-out', () => {
  it('event → batch → evict ordering, per-event before retention', () => {
    const live = chunkedLive({ maxEvents: 2 });
    const order: string[] = [];
    let lenAtThirdEvent = -1;
    let count = 0;
    live.on('event', () => {
      count += 1;
      if (count === 3) lenAtThirdEvent = live.length;
      order.push('event');
    });
    live.on('batch', () => order.push('batch'));
    live.on('evict', () => order.push('evict'));

    live.pushMany(batch(0, 2)); // fills window
    order.length = 0;
    live.push([2000, 2, 'a']); // 3rd event, then evict 1
    expect(order).toEqual(['event', 'batch', 'evict']);
    expect(lenAtThirdEvent).toBe(3); // pre-retention buffer observed
    expect(live.length).toBe(2);
  });

  it('evict listener gets the correct evicted events in order', () => {
    const live = chunkedLive({ maxEvents: 2 });
    const evicted: number[] = [];
    live.on('evict', (evs) => {
      for (const e of evs) evicted.push(e.get('value') as number);
    });
    live.pushMany([
      [0, 10, 'a'],
      [1000, 20, 'a'],
      [2000, 30, 'a'],
      [3000, 40, 'a'],
    ]);
    expect(evicted).toEqual([10, 20]);
  });

  it('no listener: still ingests + retains correctly', () => {
    const live = chunkedLive({ maxEvents: 100 });
    for (let b = 0; b < 5; b += 1) live.pushMany(batch(b * 100, 100));
    expect(live.length).toBe(100);
    expect(live.at(0)!.get('value')).toBe(400);
  });

  // All-or-nothing batch commit (the documented divergence from the
  // per-row Event[] path, see pushMany JSDoc): the whole chunk is
  // appended BEFORE any 'event' fires, so every event of a batch
  // observes the full post-batch length — not a row-by-row 1,2,3.
  it('every event of a pushMany observes the full post-batch length', () => {
    const live = chunkedLive();
    const seen: number[] = [];
    live.on('event', () => seen.push(live.length));
    live.pushMany(batch(0, 3));
    expect(seen).toEqual([3, 3, 3]); // not [1, 2, 3]
  });

  // A listener that throws mid-fan-out leaves the ENTIRE batch
  // committed (the chunk is already appended), and length/ingested
  // stay mutually consistent. (The per-row path would commit only the
  // prefix up to the throw — intrinsic, documented difference.)
  it('a mid-fan-out listener throw leaves the whole batch committed', () => {
    const live = chunkedLive();
    let fired = 0;
    live.on('event', () => {
      fired += 1;
      if (fired === 2) throw new Error('boom');
    });
    expect(() => live.pushMany(batch(0, 3))).toThrow('boom');
    expect(live.length).toBe(3); // all 3 committed despite the throw on #2
    expect(live.stats().ingested).toBe(3);
  });
});

describe('chunked LiveSeries — LiveReduce (FIFO eviction)', () => {
  it('removes evicted events from reducer state over a chunked source', () => {
    const live = chunkedLive({ maxEvents: 2 });
    const r = live.reduce({ value: 'avg' });
    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);
    expect(r.value().value).toBe(15);
    live.push([2000, 30, 'a']); // evicts value=10 → avg(20,30)=25
    expect(r.value().value).toBe(25);
    r.dispose();
  });
});

describe('chunked LiveSeries — snapshot + clear', () => {
  it('toTimeSeries is independent and ordered', () => {
    const live = chunkedLive();
    live.pushMany(batch(0, 100));
    live.pushMany(batch(100, 100));
    const ts = live.toTimeSeries('snap');
    expect(ts.length).toBe(200);
    expect(ts.at(0)!.get('value')).toBe(0);
    expect(ts.at(150)!.get('value')).toBe(150);
    live.push([200, 200, 'a']);
    expect(ts.length).toBe(200); // unaffected
  });

  it('clear empties + fires evict', () => {
    const live = chunkedLive();
    const spy = vi.fn();
    live.on('evict', spy);
    live.pushMany(batch(0, 10));
    live.clear();
    expect(live.length).toBe(0);
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('chunked source — partitionBy (partitions stay array-backed)', () => {
  it('routes to partitions and aggregates correctly over a chunked source', () => {
    const live = chunkedLive();
    const byHost = live.partitionBy('host');
    live.pushMany([
      [0, 10, 'a'],
      [1000, 20, 'b'],
      [2000, 30, 'a'],
    ]);
    const parts = byHost.collect();
    // collect() unified buffer is array-backed; routing went through
    // the source's 'event' fan-out (chunked materializes transiently).
    expect(parts.length).toBe(3);
    parts.dispose?.();
  });
});
