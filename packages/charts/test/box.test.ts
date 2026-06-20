import { describe, expect, it } from 'vitest';
import { boxExtent, drawBox } from '../src/box.js';
import { recordingContext } from './canvas-mock.js';
import type { BoxSeries } from '../src/data.js';

/**
 * Build a {@link BoxSeries}. `xEnd` defaults to `x` (a point key, end===begin) so
 * most tests pass five quantile rows and let the box collapse to a min-width
 * mark; pass `xEnd` for an interval key with real width.
 */
const bx = (
  x: number[],
  q: {
    lower: number[];
    q1: number[];
    median: number[];
    q3: number[];
    upper: number[];
  },
  xEnd: number[] = x,
): BoxSeries => ({
  x: Float64Array.from(x),
  xEnd: Float64Array.from(xEnd),
  lower: Float64Array.from(q.lower),
  q1: Float64Array.from(q.q1),
  median: Float64Array.from(q.median),
  q3: Float64Array.from(q.q3),
  upper: Float64Array.from(q.upper),
  length: x.length,
});

const identity = (v: number) => v;
const style = {
  fill: '#abc',
  fillOpacity: 0.3,
  stroke: '#123',
  strokeWidth: 1.5,
  median: '#456',
  medianWidth: 2,
  whisker: '#789',
  whiskerWidth: 1,
};

/** A single finite key, [begin, end] = [10, 30], quantiles 1/2/3/4/5. */
const oneBox = () =>
  bx([10], { lower: [1], q1: [2], median: [3], q3: [4], upper: [5] }, [30]);

describe('boxExtent', () => {
  it('returns [min lower, max upper] over finite keys (the whisker reach)', () => {
    const box = bx([0, 1], {
      lower: [1, 0],
      q1: [2, 1],
      median: [3, 2],
      q3: [4, 3],
      upper: [5, 8],
    });
    // min lower over keys = 0; max upper = 8.
    expect(boxExtent(box)).toEqual([0, 8]);
  });

  it('excludes a gap key (any quantile NaN) from the extent', () => {
    // key 1 has a NaN median → not drawn, ignored even though its upper is huge.
    const box = bx([0, 1], {
      lower: [1, 0],
      q1: [2, 1],
      median: [3, NaN],
      q3: [4, 3],
      upper: [5, 99],
    });
    expect(boxExtent(box)).toEqual([1, 5]);
  });

  it('returns null when no key has all five quantiles finite', () => {
    const box = bx([0, 1], {
      lower: [NaN, 0],
      q1: [2, 1],
      median: [3, 2],
      q3: [4, 3],
      upper: [5, NaN],
    });
    expect(boxExtent(box)).toBeNull();
  });
});

describe('drawBox', () => {
  it('emits box fill, outline, whiskers, then median — in that order', () => {
    const { ctx, calls } = recordingContext();
    drawBox(ctx, oneBox(), identity, identity, style);
    const seq = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(seq).toEqual([
      // box fill (graded, bracketed)
      'save',
      'fillRect',
      'restore',
      // box outline
      'strokeRect',
      // whiskers: one path, 4 moveTo + 4 lineTo (2 stems + 2 caps)
      'beginPath',
      'moveTo', // upper stem start (q3)
      'lineTo', // upper stem end (upper)
      'moveTo', // upper cap start
      'lineTo', // upper cap end
      'moveTo', // lower stem start (q1)
      'lineTo', // lower stem end (lower)
      'moveTo', // lower cap start
      'lineTo', // lower cap end
      'stroke',
      // median line on top
      'beginPath',
      'moveTo',
      'lineTo',
      'stroke',
    ]);
  });

  it('draws the q1→q3 box from its interval x-span', () => {
    const { ctx, calls } = recordingContext();
    // begin=10, end=30 → x-span [10,30]. A realistic flipped y-scale (range top
    // = small pixel): q3=4 → 96 (box top), q1=2 → 98 (box bottom) → height 2.
    const flipY = (v: number) => 100 - v;
    drawBox(ctx, oneBox(), identity, flipY, style);
    const rect = calls.find((c) => c.name === 'fillRect');
    // fillRect(x0, yQ3, width, yQ1 - yQ3) = (10, 96, 20, 2)
    expect(rect?.args).toEqual([10, 96, 20, 2]);
    // The outline strokes the same rect.
    expect(calls.find((c) => c.name === 'strokeRect')?.args).toEqual([
      10, 96, 20, 2,
    ]);
  });

  it('centres whiskers on the box and caps them at half width', () => {
    const { ctx, calls } = recordingContext();
    drawBox(ctx, oneBox(), identity, identity, style);
    const moves = calls.filter((c) => c.name === 'moveTo');
    const lines = calls.filter((c) => c.name === 'lineTo');
    // Box [10,30] → mid=20, cap half = (20 * 0.5)/2 = 5 → cap spans [15,25].
    // Upper stem: moveTo(20, q3=4) → lineTo(20, upper=5).
    expect(moves[0]?.args).toEqual([20, 4]);
    expect(lines[0]?.args).toEqual([20, 5]);
    // Upper cap at upper=5: moveTo(15,5) → lineTo(25,5).
    expect(moves[1]?.args).toEqual([15, 5]);
    expect(lines[1]?.args).toEqual([25, 5]);
    // Lower stem: moveTo(20, q1=2) → lineTo(20, lower=1).
    expect(moves[2]?.args).toEqual([20, 2]);
    expect(lines[2]?.args).toEqual([20, 1]);
    // Lower cap at lower=1: moveTo(15,1) → lineTo(25,1).
    expect(moves[3]?.args).toEqual([15, 1]);
    expect(lines[3]?.args).toEqual([25, 1]);
  });

  it('draws the median line across the full box width', () => {
    const { ctx, calls } = recordingContext();
    drawBox(ctx, oneBox(), identity, identity, style);
    const moves = calls.filter((c) => c.name === 'moveTo');
    const lines = calls.filter((c) => c.name === 'lineTo');
    // Median is the 5th moveTo/lineTo (after the 4 whisker pairs): full span at y=3.
    expect(moves[4]?.args).toEqual([10, 3]);
    expect(lines[4]?.args).toEqual([30, 3]);
  });

  it('maps quantiles through the y-scale', () => {
    const { ctx, calls } = recordingContext();
    // flip y: yScale(v) = 100 - v.  q3=4 → 96, q1=2 → 98 → height 2.
    drawBox(ctx, oneBox(), identity, (v) => 100 - v, style);
    expect(calls.find((c) => c.name === 'fillRect')?.args).toEqual([
      10, 96, 20, 2,
    ]);
  });

  it('applies fill + opacity for the box and brackets it with save/restore', () => {
    const { ctx, calls } = recordingContext();
    drawBox(ctx, oneBox(), identity, identity, style);
    // The box fill block: save → set fillStyle → set globalAlpha → fillRect → restore.
    const idxSave = calls.findIndex((c) => c.name === 'save');
    expect(calls[idxSave]?.name).toBe('save');
    expect(calls[idxSave + 1]).toMatchObject({
      type: 'set',
      name: 'fillStyle',
      args: ['#abc'],
    });
    expect(calls[idxSave + 2]).toMatchObject({
      type: 'set',
      name: 'globalAlpha',
      args: [0.3],
    });
    expect(calls[idxSave + 3]?.name).toBe('fillRect');
    expect(calls[idxSave + 4]?.name).toBe('restore');
  });

  it('uses the median + whisker style channels', () => {
    const { ctx, calls } = recordingContext();
    drawBox(ctx, oneBox(), identity, identity, style);
    const sets = calls.filter((c) => c.type === 'set');
    // whisker stroke + width applied (whisker block).
    expect(
      sets.some((c) => c.name === 'strokeStyle' && c.args[0] === '#789'),
    ).toBe(true);
    // median stroke + width applied (median block).
    expect(
      sets.some((c) => c.name === 'strokeStyle' && c.args[0] === '#456'),
    ).toBe(true);
    expect(sets.some((c) => c.name === 'lineWidth' && c.args[0] === 2)).toBe(
      true,
    );
  });

  it('skips a gap key entirely — no partial box', () => {
    const { ctx, calls } = recordingContext();
    // Two keys; key 0 has a NaN q3 (gap), key 1 is finite.
    const box = bx(
      [0, 10],
      {
        lower: [1, 1],
        q1: [2, 2],
        median: [3, 3],
        q3: [NaN, 4],
        upper: [5, 5],
      },
      [5, 15],
    );
    drawBox(ctx, box, identity, identity, style);
    // Exactly one box drawn → one fillRect / strokeRect.
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(1);
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
    // The drawn box is key 1 ([10,15] → x0=10).
    expect(calls.find((c) => c.name === 'fillRect')?.args[0]).toBe(10);
  });

  it('draws nothing when every key is a gap', () => {
    const { ctx, calls } = recordingContext();
    const box = bx([0, 1], {
      lower: [NaN, NaN],
      q1: [NaN, NaN],
      median: [NaN, NaN],
      q3: [NaN, NaN],
      upper: [NaN, NaN],
    });
    drawBox(ctx, box, identity, identity, style);
    expect(calls).toEqual([]);
  });

  it('insets the box by the gap and collapses a too-thin box to a min mark', () => {
    const { ctx, calls } = recordingContext();
    // begin=10, end=30 (span 20), gap=4 → inset 2 each side → [12,28].
    const flipY = (v: number) => 100 - v;
    drawBox(ctx, oneBox(), identity, flipY, style, 4);
    expect(calls.find((c) => c.name === 'fillRect')?.args).toEqual([
      12, 96, 16, 2,
    ]);

    // A zero-width point key (begin===end) collapses to the 1px min mark, centred.
    const { ctx: ctx2, calls: calls2 } = recordingContext();
    const point = bx([10], {
      lower: [1],
      q1: [2],
      median: [3],
      q3: [4],
      upper: [5],
    }); // xEnd defaults to x → span 0
    drawBox(ctx2, point, identity, identity, style, 0, 1);
    const rect = calls2.find((c) => c.name === 'fillRect');
    // 1px mark centred at x=10 → x0=9.5, width=1.
    expect(rect?.args[0]).toBeCloseTo(9.5);
    expect(rect?.args[2]).toBeCloseTo(1);
  });
});
