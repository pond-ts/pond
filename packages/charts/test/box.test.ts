import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import {
  boxAt,
  boxExtent,
  boxIndexAtTime,
  drawBox,
  isFiniteBox,
} from '../src/box.js';
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

describe('boxIndexAtTime', () => {
  // Three contiguous boxes spanning [0,10], [10,20], [20,30].
  const cs = bx(
    [0, 10, 20],
    {
      lower: [1, 1, 1],
      q1: [2, 2, 2],
      median: [3, 3, 3],
      q3: [4, 4, 4],
      upper: [5, 5, 5],
    },
    [10, 20, 30],
  );

  it('returns the box whose span contains the time', () => {
    expect(boxIndexAtTime(cs, 5)).toBe(0);
    expect(boxIndexAtTime(cs, 15)).toBe(1);
    expect(boxIndexAtTime(cs, 25)).toBe(2);
  });

  it('stays on the same box past its midpoint (not nearest-by-begin)', () => {
    // 18 is in the right half of box 1 ([10,20]); nearest-by-begin would flip to
    // box 2. Containment keeps it on box 1.
    expect(boxIndexAtTime(cs, 18)).toBe(1);
  });

  it('returns the left box at a shared edge, and -1 outside every box', () => {
    expect(boxIndexAtTime(cs, 10)).toBe(0);
    expect(boxIndexAtTime(cs, -1)).toBe(-1);
    expect(boxIndexAtTime(cs, 31)).toBe(-1);
  });
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

describe('boxAt — selection hit-test (#508 item 5)', () => {
  // identity x; flipped y (top = small pixel), so [lower,upper]=[1,5] → py [95,99].
  const flipY = (v: number) => 100 - v;

  it('hits a point inside the box bounding rect → [index, begin, upper]', () => {
    const box = oneBox(); // x-span [10,30], lower1/upper5
    // Centre: px=20 (in [10,30]), py=97 (in [95,99]).
    expect(boxAt(box, 20, 97, identity, flipY, 0, 1)).toEqual([0, 10, 5]);
  });

  it('misses outside the x-span or the whisker extent → null', () => {
    const box = oneBox();
    expect(boxAt(box, 5, 97, identity, flipY, 0, 1)).toBeNull(); // left of span
    expect(boxAt(box, 20, 90, identity, flipY, 0, 1)).toBeNull(); // above upper
    expect(boxAt(box, 20, 99.9, identity, flipY, 0, 1)).toBeNull(); // below lower
  });

  it('hits a range-only box (bid→ask, no body) anywhere in lower→upper', () => {
    const box = rangeBox(); // see below: x-span, lower/upper only
    const hit = boxAt(
      box,
      box.x[0]!,
      flipY(box.upper[0]! - 0.5),
      identity,
      flipY,
      0,
      1,
    );
    expect(hit).not.toBeNull();
    expect(hit![0]).toBe(0);
  });

  it('skips a gap box (a present quantile non-finite)', () => {
    const box = bx([10], {
      lower: [1],
      q1: [2],
      median: [NaN],
      q3: [4],
      upper: [5],
    });
    expect(boxAt(box, 10, 97, identity, flipY, 0, 1)).toBeNull();
  });

  it('respects offsetPx (the paired-mark nudge), like the draw', () => {
    const box = oneBox();
    // With +8px offset the box x-span shifts to [18,38]; px=12 no longer hits.
    expect(boxAt(box, 12, 97, identity, flipY, 0, 1, 8)).toBeNull();
    expect(boxAt(box, 28, 97, identity, flipY, 0, 1, 8)).not.toBeNull();
  });
});

describe('drawBox — selection / hover outline (#508 item 5)', () => {
  it('outlines the box whose key matches selectedKey (range-only ⇒ only stroke)', () => {
    // A range-only box draws no body outline, so the ONLY strokeRect is the
    // selection highlight — a clean signal it fired.
    const sel = recordingContext();
    drawBox(
      sel.ctx,
      rangeBox(),
      identity,
      identity,
      style,
      0,
      1,
      'whisker',
      true,
      0,
      undefined,
      rangeBox().x[0]!,
      null,
    );
    expect(sel.calls.some((c) => c.name === 'strokeRect')).toBe(true);

    // No selection ⇒ no strokeRect on the range-only box.
    const none = recordingContext();
    drawBox(
      none.ctx,
      rangeBox(),
      identity,
      identity,
      style,
      0,
      1,
      'whisker',
      true,
      0,
      undefined,
      null,
      null,
    );
    expect(none.calls.some((c) => c.name === 'strokeRect')).toBe(false);
  });
});

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

  it('capWidth sets a fixed pixel cap (narrow T-bars for paired marks)', () => {
    const { ctx, calls } = recordingContext();
    // capWidth=6 → capHalf=3, so caps span [mid-3, mid+3] = [17, 23] (not the
    // half-box-width [15,25]); the stem stays centred on mid=20.
    drawBox(
      ctx,
      oneBox(),
      identity,
      identity,
      style,
      0,
      1,
      'whisker',
      true,
      0,
      6,
    );
    const moves = calls.filter((c) => c.name === 'moveTo');
    const lines = calls.filter((c) => c.name === 'lineTo');
    expect(moves[1]?.args).toEqual([17, 5]); // upper cap start
    expect(lines[1]?.args).toEqual([23, 5]); // upper cap end
    expect(moves[3]?.args).toEqual([17, 1]); // lower cap start
    expect(lines[3]?.args).toEqual([23, 1]);
  });

  it('capWidth is clamped to the box width', () => {
    const { ctx, calls } = recordingContext();
    // Box [10,30] is 20px wide; a 40px cap clamps to 20 → capHalf=10 → [10,30].
    drawBox(
      ctx,
      oneBox(),
      identity,
      identity,
      style,
      0,
      1,
      'whisker',
      true,
      0,
      40,
    );
    const moves = calls.filter((c) => c.name === 'moveTo');
    expect(moves[1]?.args).toEqual([10, 5]); // clamped to the box edges
    expect(calls.filter((c) => c.name === 'lineTo')[1]?.args).toEqual([30, 5]);
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

  it("shape='solid' draws two nested fills, no outline, no whisker stems", () => {
    const { ctx, calls } = recordingContext();
    const flipY = (v: number) => 100 - v;
    drawBox(ctx, oneBox(), identity, flipY, style, 0, 1, 'solid');
    // Outer bar (lower→upper) + inner box (q1→q3) = two fillRects.
    const fills = calls.filter((c) => c.name === 'fillRect');
    expect(fills).toHaveLength(2);
    // Outer spans upper(95)→lower(99): fillRect(10, 95, 20, 4).
    expect(fills[0]?.args).toEqual([10, 95, 20, 4]);
    // Inner spans q3(96)→q1(98): fillRect(10, 96, 20, 2).
    expect(fills[1]?.args).toEqual([10, 96, 20, 2]);
    // No outline, and no whisker stems/caps (only the median's single moveTo).
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(1);
  });

  it("shape='none' draws the box + outline but no whiskers", () => {
    const { ctx, calls } = recordingContext();
    drawBox(ctx, oneBox(), identity, identity, style, 0, 1, 'none');
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(1);
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
    // No whisker stems/caps — only the median's single moveTo remains.
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(1);
  });

  it('showMedian=false omits the median line', () => {
    const { ctx, calls } = recordingContext();
    drawBox(ctx, oneBox(), identity, identity, style, 0, 1, 'whisker', false);
    // Whiskers draw (4 moveTo: 2 stems + 2 caps); the median's 5th moveTo is gone.
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(4);
    // The median colour is never set.
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#456')).toBe(
      false,
    );
  });

  it('offset shifts the whole box in pixel space', () => {
    const { ctx, calls } = recordingContext();
    const flipY = (v: number) => 100 - v;
    // oneBox [10,30]; offset 8 → x-span [18,38]. q3=4→96, q1=2→98 (height 2).
    drawBox(ctx, oneBox(), identity, flipY, style, 0, 1, 'whisker', true, 8);
    expect(calls.find((c) => c.name === 'fillRect')?.args).toEqual([
      18, 96, 20, 2,
    ]);
    // The whisker stem rides the shifted mid (18+38)/2 = 28.
    expect(calls.filter((c) => c.name === 'moveTo')[0]?.args).toEqual([28, 96]);
  });
});

/** A range-only box (bid→ask segment): lower/upper only, no body / median. */
const rangeBox = (): BoxSeries => ({
  x: Float64Array.from([10]),
  xEnd: Float64Array.from([30]),
  lower: Float64Array.from([1]),
  q1: Float64Array.from([NaN]),
  median: Float64Array.from([NaN]),
  q3: Float64Array.from([NaN]),
  upper: Float64Array.from([5]),
  length: 1,
  hasBox: false,
  hasMedian: false,
});

describe('range-only box (hasBox / hasMedian false)', () => {
  it('isFiniteBox needs only lower/upper when there is no body/median', () => {
    expect(isFiniteBox(rangeBox(), 0)).toBe(true);
    // a NaN upper is still a gap
    expect(
      isFiniteBox({ ...rangeBox(), upper: Float64Array.from([NaN]) }, 0),
    ).toBe(false);
  });

  it('boxExtent spans lower→upper (q1/q3 absent, not counted)', () => {
    expect(boxExtent(rangeBox())).toEqual([1, 5]);
  });

  it('draws a single whisker lower→upper — no box fill/outline, no median', () => {
    const { ctx, calls } = recordingContext();
    drawBox(ctx, rangeBox(), identity, identity, style);
    const names = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(names).not.toContain('fillRect'); // no body
    expect(names).not.toContain('strokeRect'); // no outline
    const moves = calls.filter((c) => c.name === 'moveTo');
    const lines = calls.filter((c) => c.name === 'lineTo');
    // One full stem lower→upper + two caps = 3 moveTo / 3 lineTo (no median line).
    expect(moves).toHaveLength(3);
    expect(lines).toHaveLength(3);
    // Stem runs the full range: mid=20, lower=1 → upper=5.
    expect(moves[0]?.args).toEqual([20, 1]);
    expect(lines[0]?.args).toEqual([20, 5]);
    // The median colour is never set.
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#456')).toBe(
      false,
    );
  });
});

describe('drawBox — viewport culling (Phase 2)', () => {
  const scaleWithDomain = (lo: number, hi: number): ((v: number) => number) => {
    const f = (v: number) => v;
    (f as unknown as { domain: () => number[] }).domain = () => [lo, hi];
    return f;
  };
  // 6 contiguous boxes: x = 0,10,…,50; xEnd = x + 10.
  const ramp = () =>
    bx(
      [0, 10, 20, 30, 40, 50],
      {
        lower: [1, 1, 1, 1, 1, 1],
        q1: [2, 2, 2, 2, 2, 2],
        median: [3, 3, 3, 3, 3, 3],
        q3: [4, 4, 4, 4, 4, 4],
        upper: [5, 5, 5, 5, 5, 5],
      },
      [10, 20, 30, 40, 50, 60],
    );

  it('draws only boxes whose span overlaps the visible window (+1 each side)', () => {
    const { ctx, calls } = recordingContext();
    // view [22, 38] → +1 → [1,5) → 4 boxes. A full box strokes one body rect.
    drawBox(ctx, ramp(), scaleWithDomain(22, 38), identity, style);
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(4);
  });

  it('draws all boxes when the scale has no domain (test stub)', () => {
    const { ctx, calls } = recordingContext();
    drawBox(ctx, ramp(), identity, identity, style);
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(6);
  });
});

describe('drawBox — M4 decimation (Phase 5)', () => {
  const pxScale = (lo: number, hi: number) =>
    scaleLinear().domain([lo, hi]).range([lo, hi]) as unknown as (
      v: number,
    ) => number;
  const sizedCtx = (widthPx: number) => {
    const { ctx, calls } = recordingContext();
    (ctx as unknown as { canvas: { width: number } }).canvas = {
      width: widthPx,
    };
    return { ctx, calls };
  };
  // `n` contiguous boxes at x = 0..n-1 (xEnd = x+1).
  const dense = (n: number) =>
    bx(
      Array.from({ length: n }, (_, i) => i),
      {
        lower: Array.from({ length: n }, () => 0),
        q1: Array.from({ length: n }, () => 1),
        median: Array.from({ length: n }, () => 2),
        q3: Array.from({ length: n }, () => 3),
        upper: Array.from({ length: n }, () => 4),
      },
      Array.from({ length: n }, (_, i) => i + 1),
    );

  it('decimates dense boxes to ~one aggregate box per column', () => {
    const { ctx, calls } = sizedCtx(10); // W=10
    // 5000 boxes → decimate to ≤10 aggregate boxes → ≤10 body outlines.
    drawBox(ctx, dense(5000), pxScale(0, 5000), (v: number) => v, style);
    const rects = calls.filter((c) => c.name === 'strokeRect').length;
    expect(rects).toBeLessThanOrEqual(10);
    expect(rects).toBeGreaterThan(0);
  });

  it('draws every box when decimate is off', () => {
    const { ctx, calls } = sizedCtx(10);
    drawBox(
      ctx,
      dense(40),
      pxScale(0, 40),
      (v: number) => v,
      style,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
    // 40 boxes → 40 body outlines, not decimated.
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(40);
  });
});
