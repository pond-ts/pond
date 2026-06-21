import { describe, expect, it } from 'vitest';
import { drawLine, yExtent } from '../src/line.js';
import { resolveCurve } from '../src/curve.js';
import { recordingContext, type CtxCall } from './canvas-mock.js';
import type { ChartSeries } from '../src/data.js';

const cs = (x: number[], y: number[]): ChartSeries => ({
  x: Float64Array.from(x),
  y: Float64Array.from(y),
  length: x.length,
});
const identity = (v: number) => v;
const style = { color: '#000', width: 1 };

/** One recorded `addColorStop(offset, color)` on the gradient stub. */
interface Stop {
  offset: number;
  color: string;
}

/**
 * A recording context whose `createLinearGradient` returns a stub recording its
 * stops + the anchor coords (`createLinearGradient(x0,y0,x1,y1)`), so the `fade`
 * mode's gradient is assertable. `gradients` is one entry per call.
 */
function gradientContext(): {
  ctx: CanvasRenderingContext2D;
  calls: CtxCall[];
  gradients: Array<{ args: number[]; stops: Stop[] }>;
} {
  const { ctx, calls } = recordingContext();
  const gradients: Array<{ args: number[]; stops: Stop[] }> = [];
  (
    ctx as unknown as {
      createLinearGradient: (...a: number[]) => CanvasGradient;
    }
  ).createLinearGradient = (...args: number[]) => {
    const stops: Stop[] = [];
    gradients.push({ args, stops });
    return {
      addColorStop: (offset: number, color: string) =>
        stops.push({ offset, color }),
    } as unknown as CanvasGradient;
  };
  return { ctx, calls, gradients };
}

/** A flipping y-scale (range top→bottom, like a real axis), domain [0, 100]. */
function flipScale(): (v: number) => number {
  const f = (v: number) => 100 - v;
  // The draw layer reads `.domain()[0]` for the step/fade baseline floor.
  (f as unknown as { domain: () => number[] }).domain = () => [0, 100];
  return f;
}

describe('yExtent', () => {
  it('returns [min, max] of finite values, ignoring NaN gaps', () => {
    expect(yExtent(cs([0, 1, 2, 3], [10, NaN, 30, 20]))).toEqual([10, 30]);
  });
  it('returns null when nothing is finite', () => {
    expect(yExtent(cs([0, 1], [NaN, NaN]))).toBeNull();
  });
});

describe('drawLine', () => {
  it('moves once, then lines through contiguous points', () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, cs([0, 1, 2], [5, 6, 7]), identity, identity, style);
    const seq = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(seq).toEqual(['beginPath', 'moveTo', 'lineTo', 'lineTo', 'stroke']);
  });

  it('breaks the path at a NaN gap — re-moves after it, never lineTo across', () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, cs([0, 1, 2, 3], [5, NaN, 7, 8]), identity, identity, style);
    const pen = calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .map((c) => c.name);
    // 5 → moveTo; NaN → skip (pen up); 7 → moveTo (re-pen); 8 → lineTo
    expect(pen).toEqual(['moveTo', 'moveTo', 'lineTo']);
  });

  it('handles a leading gap (first finite point moves, not lines)', () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, cs([0, 1, 2], [NaN, 6, 7]), identity, identity, style);
    const pen = calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .map((c) => c.name);
    expect(pen).toEqual(['moveTo', 'lineTo']);
  });

  it('handles a trailing gap (no segment drawn into the gap)', () => {
    const { ctx, calls } = recordingContext();
    drawLine(
      ctx,
      cs([0, 1, 2, 3], [5, 6, NaN, NaN]),
      identity,
      identity,
      style,
    );
    const pen = calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .map((c) => c.name);
    expect(pen).toEqual(['moveTo', 'lineTo']); // 5→move, 6→line, then nothing
  });

  it('draws no path ops when every value is a gap', () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, cs([0, 1, 2], [NaN, NaN, NaN]), identity, identity, style);
    expect(
      calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo'),
    ).toEqual([]);
    // still brackets the (empty) path so canvas state stays consistent
    const seq = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(seq).toEqual(['beginPath', 'stroke']);
  });

  it('maps points through the provided scales', () => {
    const { ctx, calls } = recordingContext();
    drawLine(
      ctx,
      cs([0, 10], [1, 2]),
      (t) => t * 2,
      (v) => 100 - v,
      style,
    );
    expect(calls.find((c) => c.name === 'moveTo')?.args).toEqual([0, 99]);
    expect(calls.find((c) => c.name === 'lineTo')?.args).toEqual([20, 98]);
  });

  it('applies stroke colour + width', () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, cs([0, 1], [1, 2]), identity, identity, {
      color: '#abc',
      width: 2.5,
    });
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'strokeStyle')?.args,
    ).toEqual(['#abc']);
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'lineWidth')?.args,
    ).toEqual([2.5]);
  });

  it('draws a curved path (bezier ops) when given a non-linear curve', () => {
    const { ctx, calls } = recordingContext();
    drawLine(
      ctx,
      cs([0, 1, 2, 3], [1, 3, 1, 3]),
      identity,
      identity,
      style,
      resolveCurve('basis'),
    );
    const ops = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(ops).toContain('bezierCurveTo'); // smooth, not straight lineTo
  });
});

describe('drawLine gap modes', () => {
  const gapped = () => cs([0, 1, 2, 3], [5, NaN, 7, 8]);

  it("'empty' (default) breaks at the gap — re-moves, no bridge", () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, gapped(), identity, identity, style, undefined, 'empty');
    const pen = calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .map((c) => c.name);
    // 5→move; NaN→pen up; 7→re-move; 8→line. No dash, no gradient overlay.
    expect(pen).toEqual(['moveTo', 'moveTo', 'lineTo']);
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
    expect(calls.some((c) => c.name === 'createLinearGradient')).toBe(false);
  });

  it("'none' bridges straight across the gap (interpolated, one subpath)", () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, gapped(), identity, identity, style, undefined, 'none');
    const pen = calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .map((c) => c.name);
    // The interior NaN is interpolated (5→7 ⇒ 6), so one continuous subpath:
    // moveTo(5) then lineTo through the filled 6, 7, 8 — never a second moveTo.
    expect(pen).toEqual(['moveTo', 'lineTo', 'lineTo', 'lineTo']);
    // the filled value is the midpoint 6 at x=1.
    const lines = calls.filter((c) => c.name === 'lineTo').map((c) => c.args);
    expect(lines[0]).toEqual([1, 6]); // interpolated gap point
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
  });

  it("'none' leaves a leading gap broken (no anchor to interpolate from)", () => {
    const { ctx, calls } = recordingContext();
    // leading NaN has no left anchor → stays NaN → the first finite point moves.
    drawLine(
      ctx,
      cs([0, 1, 2], [NaN, 6, 7]),
      identity,
      identity,
      style,
      undefined,
      'none',
    );
    const pen = calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .map((c) => c.name);
    expect(pen).toEqual(['moveTo', 'lineTo']); // 6→move, 7→line; no NaN bridge
  });

  it("'dashed' keeps the solid break and adds a dashed straight bridge", () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, gapped(), identity, identity, style, undefined, 'dashed');
    // The solid pass still breaks (two moveTos for the solid runs), then a
    // dashed bridge pass: setLineDash([4,4]) + its own moveTo→lineTo (5→7).
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(true);
    const dash = calls.find((c) => c.name === 'setLineDash');
    expect(dash?.args).toEqual([[4, 4]]);
    // bridge runs last-good (index 0: x=0,y=5) → next-good (index 2: x=2,y=7).
    const moves = calls.filter((c) => c.name === 'moveTo').map((c) => c.args);
    expect(moves).toContainEqual([0, 5]); // bridge start = last good point
    const lines = calls.filter((c) => c.name === 'lineTo').map((c) => c.args);
    expect(lines).toContainEqual([2, 7]); // bridge end = next good point
    // two strokes: the solid line + the dashed bridge.
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(2);
  });

  it("'step' holds the last value across the gap, then corrects to the resumed value, dashed", () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, gapped(), identity, identity, style, undefined, 'step');
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(true);
    // gapped(): last-good index0 (x=0,y=5), gap index1, next-good index2 (x=2,y=7).
    // step: moveTo(0,5) → hold across at the last value (2,5) → correct to the
    // resumed value (2,7). No drop to the axis floor.
    const moves = calls.filter((c) => c.name === 'moveTo').map((c) => c.args);
    const lines = calls.filter((c) => c.name === 'lineTo').map((c) => c.args);
    expect(moves).toContainEqual([0, 5]); // start at the last-good point
    expect(lines).toContainEqual([2, 5]); // hold the last value across the gap
    expect(lines).toContainEqual([2, 7]); // step to the resumed value
  });

  it("'fade' draws a vertical gradient drop to the floor at each gap edge", () => {
    const { ctx, calls, gradients } = gradientContext();
    const y = flipScale(); // floor pixel = 100
    drawLine(ctx, gapped(), identity, y, style, undefined, 'fade');
    // Two drops (last-good + next-good edge) → two gradients, each anchored
    // line→floor (y at the point, then 100), opaque at the line, transparent at
    // the floor.
    expect(gradients).toHaveLength(2);
    // last-good point index 0 → y(5)=95; gradient from (0,95)→(0,100).
    expect(gradients[0]!.args).toEqual([0, 95, 0, 100]);
    expect(gradients[0]!.stops[0]).toEqual({ offset: 0, color: '#000' });
    expect(gradients[0]!.stops[1]!.offset).toBe(1);
    // '#000' is valid hex → transparent stop is its rgba at alpha 0.
    expect(gradients[0]!.stops[1]!.color).toBe('rgba(0, 0, 0, 0)');
    // no dashing for fade.
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
  });

  it("'fade' with a hex colour yields an rgba(...,0) transparent stop", () => {
    const { ctx, gradients } = gradientContext();
    const y = flipScale();
    drawLine(
      ctx,
      gapped(),
      identity,
      y,
      { color: '#2563eb', width: 1 },
      undefined,
      'fade',
    );
    expect(gradients[0]!.stops[0]!.color).toBe('#2563eb');
    expect(gradients[0]!.stops[1]!.color).toBe('rgba(37, 99, 235, 0)');
  });

  it("'fade' falls back to the `transparent` keyword for a non-hex colour", () => {
    const { ctx, gradients } = gradientContext();
    const y = flipScale();
    drawLine(
      ctx,
      gapped(),
      identity,
      y,
      { color: 'teal', width: 1 }, // named colour — can't derive an rgba
      undefined,
      'fade',
    );
    expect(gradients[0]!.stops[0]!.color).toBe('teal'); // opaque end unchanged
    expect(gradients[0]!.stops[1]!.color).toBe('transparent'); // fallback
  });

  it('a leading / trailing gap is not bridged (no interior edge)', () => {
    const { ctx, calls } = recordingContext();
    // leading gap (index 0) + trailing gap (index 3): no interior gap to bridge.
    drawLine(
      ctx,
      cs([0, 1, 2, 3], [NaN, 6, 7, NaN]),
      identity,
      identity,
      style,
      undefined,
      'dashed',
    );
    // The solid line draws (6→7), but there's no dashed bridge pass.
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(1);
  });
});
