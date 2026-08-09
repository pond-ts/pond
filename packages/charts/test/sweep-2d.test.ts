import { describe, expect, it } from 'vitest';
import { sweep2D } from '../src/sweep.js';
import type { SelectInfo } from '../src/context.js';

/**
 * `sweep2D` — the rect gesture's cut ([PND-INTERACT2D]).
 *
 * The x half is `sweep1D`'s two binary-search probes; the y half is the
 * layer's own filter, applied inside `materialize`. What is pinned here is the
 * machinery around them: the delta gate (which now has to notice a y-only
 * move), the point-layer edge case, and the extent rule — which must describe
 * the marks that *survived* the y filter, not the x run they came from.
 */

/** A point layer: `begin === end`, keys 0…4. */
const points = (ys: number[]) => {
  const xs = Float64Array.from(ys.map((_, i) => i));
  const hits: SelectInfo[] = [];
  return {
    xs,
    session: sweep2D({
      id: 'p',
      begin: xs,
      end: xs,
      length: ys.length,
      spanFrom: 'drag',
      materialize: (lo, hi, y0, y1) => {
        const out: SelectInfo[] = [];
        for (let i = lo; i < hi; i += 1) {
          const v = ys[i]!;
          if (v < y0 || v >= y1) continue;
          out.push({ id: 'p', key: i, value: v, color: '#0', label: 'p' });
        }
        return out;
      },
      channels: (_h, y0, y1) => ({ y: [y0, y1] }),
    }),
    hits,
  };
};

describe('sweep2D — the rect cut', () => {
  it('keeps only the marks inside BOTH windows', () => {
    const { session } = points([0, 5, 1, 6, 2]);
    session.update(0, 5, 4, 10); // all keys, y in [4,10)
    expect(session.hits().map((h) => h.key)).toEqual([1, 3]);
  });

  it('re-cuts on a y-only move — the gate is two-dimensional', () => {
    // The failure this exists to catch: a delta gate that only watched the x
    // run would return `false` for a purely vertical drag and the preview
    // would freeze while the pointer moved.
    const { session } = points([0, 5, 1, 6, 2]);
    expect(session.update(0, 5, 4, 10)).toBe(true);
    expect(session.update(0, 5, 4, 10)).toBe(false); // genuinely unchanged
    expect(session.update(0, 5, 0, 3)).toBe(true); // same x, new y
    expect(session.hits().map((h) => h.key)).toEqual([0, 2, 4]);
  });

  it('includes a point sitting exactly on the press edge', () => {
    // `sweep1D`'s cut is `firstAbove(end, x0)`, which on a point layer
    // (`end === begin`) would drop the mark under the pixel the drag started
    // on — inside the rect the user is drawing, but outside the run.
    const { session } = points([1, 1, 1]);
    session.update(0, 2, 0, 5);
    expect(session.hits().map((h) => h.key)).toEqual([0, 1]);
  });

  it('spans the DRAG window, so the half-open test keeps the last point', () => {
    // `[first.key, last.key]` looks tighter and drops its own right edge:
    // `SpanSelection.x` is half-open, so a span of [0, 4] excludes key 4. A
    // point has no interval to snap outward to, so the drag window — which is
    // half-open by construction — is the honest descriptor. The y channel
    // already reports the drag window for the same reason.
    const { session } = points([5, 5, 5, 5, 5]);
    session.update(0, 5, 0, 10);
    expect(session.hits().map((h) => h.key)).toEqual([0, 1, 2, 3, 4]);
    expect(session.extent()).toEqual([0, 5]);
  });

  it('…and still reports nothing when the y filter emptied the run', () => {
    // The x run is non-empty and the drag window is real; the SPAN must not
    // be, because no mark survived. A span here would re-select five marks
    // the drag never covered.
    const { session } = points([0, 0, 0, 0, 0]);
    session.update(0, 5, 8, 10);
    expect(session.hits()).toEqual([]);
    expect(session.extent()).toBeNull();
  });

  it('reports the drag window as the y channel, not the points’ bounds', () => {
    const { session } = points([2, 3]);
    session.update(0, 2, 0, 10);
    expect(session.extent2D?.()).toEqual({ y: [0, 10] });
  });

  it('is empty before a drag, and reports nothing', () => {
    const { session } = points([1, 2]);
    expect(session.hits()).toEqual([]);
    expect(session.extent()).toBeNull();
    expect(session.extent2D?.()).toBeNull();
  });

  it('normalizes a reversed y window — dragging upward is a drag', () => {
    const { session } = points([1, 5]);
    session.update(0, 2, 10, 0);
    expect(session.hits().map((h) => h.key)).toEqual([0, 1]);
  });

  it('declares itself 2-D, so the gesture knows to track y', () => {
    expect(points([1]).session.twoD).toBe(true);
  });
});

describe('sweep2D over a BINNED layer (the heat map shape)', () => {
  /** Three bins × two rows; the y filter snaps outward to whole row slots. */
  const grid = () => {
    const begin = Float64Array.from([0, 10, 20]);
    const end = Float64Array.from([10, 20, 30]);
    const rows = ['low', 'high'];
    const rowRun = (y0: number, y1: number): [number, number] => {
      const g0 = Math.max(0, Math.floor(y0));
      const g1 = Math.min(2, Math.ceil(y1));
      return [g0, g1 > g0 ? g1 : g0];
    };
    return sweep2D({
      id: 'h',
      begin,
      end,
      length: 3,
      spanFrom: 'bins',
      materialize: (lo, hi, y0, y1) => {
        const [g0, g1] = rowRun(y0, y1);
        const out: SelectInfo[] = [];
        for (let b = lo; b < hi; b += 1)
          for (let g = g0; g < g1; g += 1)
            out.push({
              id: 'h',
              key: begin[b]!,
              value: 1,
              color: '#0',
              label: rows[g]!,
            });
        return out;
      },
      channels: (_h, y0, y1) => {
        const [g0, g1] = rowRun(y0, y1);
        return { rows: rows.slice(g0, g1) };
      },
    });
  };

  it('snaps a partial row window outward to whole slots', () => {
    const s = grid();
    // y 0.4→0.6 touches only row 0, and must claim all of it.
    s.update(0, 10, 0.4, 0.6);
    expect(s.extent2D?.()).toEqual({ rows: ['low'] });
    s.update(0, 10, 0.4, 1.2); // now grazes row 1 as well
    expect(s.extent2D?.()).toEqual({ rows: ['low', 'high'] });
  });

  it('names rows rather than numbering slots, so a reorder survives', () => {
    const s = grid();
    s.update(0, 30, 0, 2);
    expect(s.extent2D?.()).toEqual({ rows: ['low', 'high'] });
  });

  it('extents outward to whole bin columns', () => {
    const s = grid();
    s.update(4, 14, 0, 2); // starts and ends mid-bin
    expect(s.extent()).toEqual([0, 20]);
  });

  it('yields cells of every covered bin × every covered row', () => {
    const s = grid();
    s.update(0, 20, 0, 2);
    expect(s.hits()).toHaveLength(4); // 2 bins × 2 rows
  });
});
