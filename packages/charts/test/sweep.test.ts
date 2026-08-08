import { describe, expect, it } from 'vitest';
import { firstAbove, firstAtOrAbove, sweep1D } from '../src/sweep.js';
import type { SelectInfo } from '../src/context.js';

/**
 * The 1-D sweep session (`sweep.ts`) — `<MultiSelector>`'s per-drag range
 * query (interaction RFC A7.6/A7.7). Pure-helper level of the two-level
 * verification: the intersection cut, the half-open edge rule, gap trimming,
 * the delta gate, and the cached materialisation (A5.2's "the hits are free").
 * The component wiring above it is pinned in `multi-selector.test.tsx`.
 */

/** Ten contiguous unit marks: mark i spans [i*10, (i+1)*10), value i. */
function marks(gapAt: readonly number[] = []) {
  const begin = Array.from({ length: 10 }, (_, i) => i * 10);
  const end = Array.from({ length: 10 }, (_, i) => (i + 1) * 10);
  const gaps = new Set(gapAt);
  const calls: [number, number][] = [];
  const session = sweep1D({
    id: 'm',
    begin,
    end,
    length: 10,
    selectable: (i) => !gaps.has(i),
    materialize: (lo, hi) => {
      calls.push([lo, hi]);
      const out: SelectInfo[] = [];
      for (let i = lo; i < hi; i += 1) {
        if (gaps.has(i)) continue;
        out.push({
          id: 'm',
          key: begin[i]!,
          value: i,
          color: '#000',
          label: 'm',
        });
      }
      return out;
    },
  });
  return { session, calls, begin, end };
}

describe('binary-search cuts', () => {
  const xs = [0, 10, 20, 30, 40];
  it('firstAbove: first index with xs[i] > v', () => {
    expect(firstAbove(xs, 5, -1)).toBe(0);
    expect(firstAbove(xs, 5, 0)).toBe(1); // strict: equal is not above
    expect(firstAbove(xs, 5, 15)).toBe(2);
    expect(firstAbove(xs, 5, 40)).toBe(5);
  });
  it('firstAtOrAbove: first index with xs[i] >= v', () => {
    expect(firstAtOrAbove(xs, 5, -1)).toBe(0);
    expect(firstAtOrAbove(xs, 5, 0)).toBe(0); // inclusive: equal counts
    expect(firstAtOrAbove(xs, 5, 15)).toBe(2);
    expect(firstAtOrAbove(xs, 5, 41)).toBe(5);
  });
});

describe('capture — intersection against the half-open window (RFC A7.6)', () => {
  it('covers exactly the marks intersecting [x0, x1)', () => {
    const { session } = marks();
    session.update(15, 35); // clips mark 1, spans 2, clips 3
    expect(session.hits().map((h) => h.value)).toEqual([1, 2, 3]);
  });

  it('shared edges follow the half-open rule: a mark beginning at x1 is out, one ending at x0 is out', () => {
    const { session } = marks();
    session.update(10, 30); // mark 0 ends AT 10 (out); mark 3 begins AT 30 (out)
    expect(session.hits().map((h) => h.value)).toEqual([1, 2]);
  });

  it('an empty or reversed window covers nothing', () => {
    const { session } = marks();
    session.update(35, 15);
    expect(session.hits()).toEqual([]);
    expect(session.extent()).toBeNull();
  });

  it('a zero-width window covers only a mark strictly containing it', () => {
    const { session } = marks();
    session.update(25, 25);
    expect(session.hits().map((h) => h.value)).toEqual([2]);
  });
});

describe('the span extent — snapped outward to covered marks (the edge rule)', () => {
  it('reports [begin(first), end(last)) of the covered run', () => {
    const { session } = marks();
    session.update(15, 35);
    expect(session.extent()).toEqual([10, 40]);
  });

  it('the extent round-trips: every covered mark key is inside [lo, hi), every neighbour outside', () => {
    const { session } = marks();
    session.update(15, 35);
    const [lo, hi] = session.extent()!;
    const covered = session.hits().map((h) => h.key);
    for (const k of covered) expect(k >= lo && k < hi).toBe(true);
    // The next mark past the sweep begins exactly at `hi` — the open side.
    expect(40 >= lo && 40 < hi).toBe(false);
    expect(0 >= lo && 0 < hi).toBe(false);
  });

  it('trims edge gaps: the span never snaps to a mark that owns no membership', () => {
    const { session } = marks([1, 3]); // marks 1 and 3 are gaps
    session.update(15, 40); // raw run would be marks 1..3
    expect(session.hits().map((h) => h.value)).toEqual([2]);
    expect(session.extent()).toEqual([20, 30]);
  });

  it('interior gaps stay inside the extent and simply own no membership', () => {
    const { session } = marks([2]);
    session.update(15, 45); // marks 1..4, 2 is a gap
    expect(session.hits().map((h) => h.value)).toEqual([1, 3, 4]);
    expect(session.extent()).toEqual([10, 50]);
  });

  it('an all-gap run covers nothing', () => {
    const { session } = marks([1, 2]);
    session.update(15, 25);
    expect(session.hits()).toEqual([]);
    expect(session.extent()).toBeNull();
  });
});

describe('the delta gate + cached materialisation (RFC A1.4 / A5.2)', () => {
  it('update returns true only when the covered set changed', () => {
    const { session } = marks();
    expect(session.update(15, 35)).toBe(true);
    // Same covered run from a slightly different window: no change.
    expect(session.update(17, 33)).toBe(false);
    // One more mark crossed: change.
    expect(session.update(17, 45)).toBe(true);
  });

  it('hits() materialises once per change — the preview array IS the commit payload', () => {
    const { session, calls } = marks();
    session.update(15, 35);
    const preview = session.hits();
    expect(calls.length).toBe(1);
    // Re-reading (the release path) does not re-query — same array, no call.
    expect(session.hits()).toBe(preview);
    expect(calls.length).toBe(1);
    // An unchanged update keeps the cache too.
    session.update(16, 34);
    expect(session.hits()).toBe(preview);
    expect(calls.length).toBe(1);
  });

  it('a session starts empty — a press is not a sweep', () => {
    const { session, calls } = marks();
    expect(session.hits()).toEqual([]);
    expect(session.extent()).toBeNull();
    expect(calls.length).toBe(0);
  });
});
