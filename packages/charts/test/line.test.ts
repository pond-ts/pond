import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import { drawLine, sessionRuns, yExtent } from '../src/line.js';
import { resolveCurve } from '../src/curve.js';
import { recordingContext, type CtxCall } from './canvas-mock.js';
import type { ChartSeries } from '../src/data.js';
import type { Scale } from '../src/line.js';

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

  it('leaves the stroke solid — never touches setLineDash — for a style without a dash', () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, cs([0, 1, 2], [5, 6, 7]), identity, identity, style);
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
  });

  it('dashes the stroke with the style pattern, then resets to solid', () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, cs([0, 1, 2], [5, 6, 7]), identity, identity, {
      color: '#000',
      width: 1,
      dash: [6, 4],
    });
    const dashCalls = calls.filter((c) => c.name === 'setLineDash');
    // set the pattern for the stroke, then reset to [] so it can't leak on.
    expect(dashCalls.map((c) => c.args)).toEqual([[[6, 4]], [[]]]);
    // the pattern is applied before the stroke, the reset after it.
    const order = calls
      .filter((c) => c.name === 'setLineDash' || c.name === 'stroke')
      .map((c) => c.name);
    expect(order).toEqual(['setLineDash', 'stroke', 'setLineDash']);
  });

  it('does not treat an empty dash array as a dash (stays solid)', () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, cs([0, 1], [1, 2]), identity, identity, {
      color: '#000',
      width: 1,
      dash: [],
    });
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
  });

  it('resets the series dash before the gap-bridge overlay runs (dash + gaps:dashed)', () => {
    const { ctx, calls } = recordingContext();
    // A dashed series style AND an inferred dashed gap bridge over an interior
    // gap — the exact interaction the post-stroke reset guards. The series dash
    // ([6,4]) must be reset ([]) *before* the bridge sets its own dash ([4,4]),
    // so the two dashings don't bleed together and nothing leaks past the layer.
    drawLine(
      ctx,
      cs([0, 1, 2, 3], [5, 6, NaN, 8]),
      identity,
      flipScale(),
      { color: '#000', width: 1, dash: [6, 4] },
      resolveCurve('linear'),
      'dashed',
    );
    const dashSeq = calls
      .filter((c) => c.name === 'setLineDash')
      .map((c) => c.args[0]);
    expect(dashSeq).toEqual([[6, 4], [], [4, 4]]);
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
    // the bridge is faint by default (DEFAULT_GAP_CONNECTOR_OPACITY = 0.5).
    expect(
      calls.some(
        (c) =>
          c.type === 'set' && c.name === 'globalAlpha' && c.args?.[0] === 0.5,
      ),
    ).toBe(true);
  });

  it("'step' draws a faint flat dashed line at the average of the two edge values", () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, gapped(), identity, identity, style, undefined, 'step', 0.4);
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(true);
    // gapped(): edges index0 (x=0,y=5) → index2 (x=2,y=7); avg = 6. A horizontal
    // segment at y=6 across the gap — no vertical step.
    const moves = calls.filter((c) => c.name === 'moveTo').map((c) => c.args);
    const lines = calls.filter((c) => c.name === 'lineTo').map((c) => c.args);
    expect(moves).toContainEqual([0, 6]); // average, left edge
    expect(lines).toContainEqual([2, 6]); // flat to the right edge
    expect(lines).not.toContainEqual([2, 5]); // not the old hold-then-correct shape
    expect(lines).not.toContainEqual([2, 7]);
    // faint: the connector pass set globalAlpha to the passed opacity.
    expect(
      calls.some(
        (c) =>
          c.type === 'set' && c.name === 'globalAlpha' && c.args?.[0] === 0.4,
      ),
    ).toBe(true);
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

/**
 * `sessionRuns` cuts the index space wherever a boundary lands in `(x[i-1],
 * x[i]]` — the pure geometry behind `<LineChart sessionBreaks>` (a trading-axis
 * session close→open). A point exactly on a boundary starts the new run.
 */
describe('sessionRuns', () => {
  const x = (...v: number[]) => Float64Array.from(v);

  it('one run over the whole series when no boundary falls inside', () => {
    expect(sessionRuns(x(0, 1, 2, 3), 4, [])).toEqual([[0, 4]]);
    expect(sessionRuns(x(0, 1, 2, 3), 4, [100])).toEqual([[0, 4]]);
  });

  it('breaks between the two points a boundary sits between', () => {
    // boundary 1.5 ∈ (1, 2] → cut before index 2.
    expect(sessionRuns(x(0, 1, 2, 3), 4, [1.5])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('a point exactly on a boundary starts the new run (the open)', () => {
    // boundary == x[2] → x[2] begins the next run.
    expect(sessionRuns(x(0, 1, 2, 3), 4, [2])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('collapses several boundaries between one pair into a single break', () => {
    // a whole weekend (3 boundaries) between Fri-close (x=1) and Mon-open (x=10).
    expect(sessionRuns(x(0, 1, 10, 11), 4, [3, 5, 7])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('handles three sessions → three runs', () => {
    expect(sessionRuns(x(0, 1, 2, 3, 4, 5), 6, [1.5, 3.5])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ]);
  });

  it('sorts unordered boundaries defensively (no silently-dropped break)', () => {
    // The provider contract does not guarantee ascending order; an unsorted
    // list must still cut every break, not skip the out-of-order one.
    expect(sessionRuns(x(0, 1, 2, 3, 4, 5), 6, [3.5, 1.5])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ]);
  });
});

/**
 * `sessionBreaks` (the `boundaries` arg to `drawLine`) breaks the solid path at
 * a trading-axis discontinuity even though a point sits on each side — the line
 * ends at the close and re-starts at the open. A *scale* break, composable with
 * the NaN *data* gaps, and it suppresses any inferred bridge across it.
 */
describe('drawLine sessionBreaks (boundaries)', () => {
  const pen = (calls: CtxCall[]) =>
    calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .map((c) => c.name);

  it('breaks the line at a boundary between two finite points (re-moves)', () => {
    const { ctx, calls } = recordingContext();
    // 4 points, boundary 1.5 → run [0,2) then run [2,4): two moveTos.
    drawLine(
      ctx,
      cs([0, 1, 2, 3], [5, 6, 7, 8]),
      identity,
      identity,
      style,
      undefined,
      'empty',
      undefined,
      [1.5],
    );
    expect(pen(calls)).toEqual(['moveTo', 'lineTo', 'moveTo', 'lineTo']);
    // the break is a pen-up, not a lineTo across the collapsed gap.
    const lines = calls.filter((c) => c.name === 'lineTo').map((c) => c.args);
    expect(lines).not.toContainEqual([2, 7]); // no close(1,6)→open(2,7) connector
  });

  it('no boundary in range ⇒ identical to a plain single-pass draw', () => {
    const { ctx, calls } = recordingContext();
    drawLine(
      ctx,
      cs([0, 1, 2], [5, 6, 7]),
      identity,
      identity,
      style,
      undefined,
      'empty',
      undefined,
      [100],
    );
    const seq = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(seq).toEqual(['beginPath', 'moveTo', 'lineTo', 'lineTo', 'stroke']);
  });

  it('composes with a NaN data gap inside a run', () => {
    const { ctx, calls } = recordingContext();
    // NaN at index 1 (data gap) AND a session break at 2.5 (scale gap).
    drawLine(
      ctx,
      cs([0, 1, 2, 3], [5, NaN, 7, 8]),
      identity,
      identity,
      style,
      undefined,
      'empty',
      undefined,
      [2.5],
    );
    // 5→move; NaN→pen up; 7→re-move (data gap); 8 in its own run→re-move.
    expect(pen(calls)).toEqual(['moveTo', 'moveTo', 'moveTo']);
  });

  it('suppresses an inferred bridge that would span a session break', () => {
    const { ctx, calls } = recordingContext();
    // A NaN run (index 1,2) straddling the boundary 1.5 → split into a trailing
    // gap in run [0,2) and a leading gap in run [2,4): neither is an interior
    // gap, so `dashed` draws no bridge across the break.
    drawLine(
      ctx,
      cs([0, 1, 2, 3], [5, NaN, NaN, 8]),
      identity,
      identity,
      style,
      undefined,
      'dashed',
      undefined,
      [1.5],
    );
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(1);
  });
});

describe('drawLine — viewport culling (Phase 2)', () => {
  // A d3 linear scale carries `.domain()`, so drawLine culls against it (a bare
  // `identity` function has none, so the other tests draw the whole series).
  const domainScale = (lo: number, hi: number): Scale =>
    scaleLinear().domain([lo, hi]).range([lo, hi]) as unknown as Scale;
  // x = 0,10,…,90 (10 points), y = the same x so pixels are assertable.
  const ramp = (): ChartSeries =>
    cs(
      Array.from({ length: 10 }, (_, i) => i * 10),
      Array.from({ length: 10 }, (_, i) => i * 10),
    );
  const penOps = (calls: CtxCall[]) =>
    calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo');

  it('strokes only the visible slice + one entry/exit point', () => {
    const { ctx, calls } = recordingContext();
    // view [25, 55] → in-range 30,40,50; entry 20 + exit 60 → 5 points drawn.
    drawLine(ctx, ramp(), domainScale(25, 55), (v) => v, style);
    // 1 moveTo + 4 lineTo for 5 contiguous points.
    expect(penOps(calls).map((c) => c.name)).toEqual([
      'moveTo',
      'lineTo',
      'lineTo',
      'lineTo',
      'lineTo',
    ]);
    // The entry point (20) is the first stroked — off the left edge, so the
    // crossing segment still draws.
    expect(calls.find((c) => c.name === 'moveTo')?.args).toEqual([20, 20]);
  });

  it('draws every point when the view covers the whole series', () => {
    const { ctx, calls } = recordingContext();
    drawLine(ctx, ramp(), domainScale(-100, 1000), (v) => v, style);
    // 10 points → 1 moveTo + 9 lineTo, none culled.
    expect(penOps(calls)).toHaveLength(10);
  });

  it('interaction reads the source, not the culled view (§2.3 invariant)', () => {
    // The cull is internal to drawLine; the ChartSeries the caller holds — the
    // one sampleAt/hitTest read — is never mutated by a draw.
    const series = ramp();
    const before = Array.from(series.x);
    const { ctx } = recordingContext();
    drawLine(ctx, series, domainScale(25, 55), (v) => v, style);
    expect(Array.from(series.x)).toEqual(before);
    expect(series.length).toBe(10);
  });

  // Gap-mode neutrality (the Layer-2 finding): a gap WIDER than the margin
  // straddling a plot edge must stay an *interior* gap in the slice, so 'none'
  // bridges it and 'dashed' draws its connector exactly as un-culled. Series:
  // finite 0/10, a 3-wide NaN run at 20/30/40, finite from 50 on. The left
  // anchor (x=10) sits 3 points off-screen of a left edge at x=35, so a bare
  // margin=1 cull would drop it and break the bridge.
  const leftEdgeGap = (): ChartSeries =>
    cs(
      [0, 10, 20, 30, 40, 50, 60, 70, 80],
      [0, 10, NaN, NaN, NaN, 50, 60, 70, 80],
    );

  it("'none' bridges a gap straddling the left edge — anchor re-included", () => {
    const { ctx, calls } = recordingContext();
    // View [35, 75] → bisect starts the slice at x=30 (NaN); the fix walks back
    // to the finite anchor x=10 so 20/30/40 is interior and bridgeGaps spans it.
    drawLine(
      ctx,
      leftEdgeGap(),
      domainScale(35, 75),
      (v) => v,
      style,
      undefined,
      'none',
    );
    // First point stroked is the re-included anchor (x=10), and the bridge makes
    // one continuous subpath. Bare margin=1 would start at x=50 instead (a notch).
    expect(calls.find((c) => c.name === 'moveTo')?.args).toEqual([10, 10]);
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(1);
  });

  it("'dashed' keeps a left-edge gap's connector after culling", () => {
    const { ctx, calls } = recordingContext();
    drawLine(
      ctx,
      leftEdgeGap(),
      domainScale(35, 75),
      (v) => v,
      style,
      undefined,
      'dashed',
    );
    // The inferred dashed bridge draws only for an interior gap — its presence
    // proves the left anchor survived the cull (setLineDash on the bridge pass).
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(true);
  });

  it("'none' bridges a gap straddling the right edge — anchor re-included", () => {
    // Mirror: finite 0/10/20/30, NaN at 40/50/60, finite 70/80. Right edge at
    // x=45 → the right anchor (x=70) is >1 point out; the fix walks end forward.
    const rightEdgeGap = cs(
      [0, 10, 20, 30, 40, 50, 60, 70, 80],
      [0, 10, 20, 30, NaN, NaN, NaN, 70, 80],
    );
    const { ctx, calls } = recordingContext();
    drawLine(
      ctx,
      rightEdgeGap,
      domainScale(-5, 45),
      (v) => v,
      style,
      undefined,
      'none',
    );
    // The bridge reaches the re-included right anchor at x=70 (bare margin=1
    // would end the line at x=30, a right-edge notch).
    expect(calls.some((c) => c.name === 'lineTo' && c.args[0] === 70)).toBe(
      true,
    );
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(1);
  });
});

describe('drawLine — M4 decimation (Phase 3)', () => {
  const domainScale = (lo: number, hi: number): Scale =>
    scaleLinear().domain([lo, hi]).range([lo, hi]) as unknown as Scale;
  // A recording ctx with a sized backing buffer (device px) + DPR transform, so
  // drawLine's decimation gate fires (a bare recordingContext has no canvas).
  const sizedCtx = (widthPx: number, dpr = 1) => {
    const { ctx, calls } = recordingContext();
    (ctx as unknown as { canvas: { width: number } }).canvas = {
      width: widthPx,
    };
    (ctx as unknown as { getTransform: () => { a: number } }).getTransform =
      () => ({ a: dpr });
    return { ctx, calls };
  };
  // A dense ramp: `n` points, value = index.
  const dense = (n: number): ChartSeries =>
    cs(
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => i),
    );
  const penCount = (calls: CtxCall[]) =>
    calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo').length;

  it('decimates a dense series to ~4 points per device column', () => {
    const { ctx, calls } = sizedCtx(10); // W=10 columns
    // 5000 points ≫ 2×10 → decimate; ≤ 4·10 = 40 pen ops (vs 5000 full-res).
    drawLine(ctx, dense(5000), domainScale(0, 5000), (v) => v, style);
    expect(penCount(calls)).toBeLessThanOrEqual(40);
    expect(penCount(calls)).toBeGreaterThan(0);
  });

  it('draws full-resolution when decimate is off', () => {
    const { ctx, calls } = sizedCtx(10);
    drawLine(
      ctx,
      dense(200),
      domainScale(0, 200),
      (v) => v,
      style,
      undefined,
      'empty',
      undefined,
      [],
      false,
    );
    // 200 contiguous points → 1 moveTo + 199 lineTo, not decimated.
    expect(penCount(calls)).toBe(200);
  });

  it('does not decimate below the ~2 samples/pixel threshold', () => {
    const { ctx, calls } = sizedCtx(800); // W=800; 1000 pts < 2×800
    drawLine(ctx, dense(1000), domainScale(0, 1000), (v) => v, style);
    expect(penCount(calls)).toBe(1000);
  });

  it('decimates a non-empty gap mode too, preserving the connector (§2.2 union)', () => {
    const { ctx, calls } = sizedCtx(10); // W=10, column width 500 over [0,5000]
    // Dense 5000 with a ~700-wide gap (> 1 column) at index 2000..2699, so the
    // gap-edge union isolates it into empty buckets.
    const x = Array.from({ length: 5000 }, (_, i) => i);
    const y = x.map((i) => (i >= 2000 && i < 2700 ? NaN : i));
    drawLine(
      ctx,
      cs(x, y),
      domainScale(0, 5000),
      (v) => v,
      style,
      undefined,
      'dashed',
    );
    // Decimated: far fewer than the 5000-point full-res draw.
    expect(penCount(calls)).toBeLessThan(100);
    expect(penCount(calls)).toBeGreaterThan(0);
    // The gap survived the union (its own empty bucket) → the inferred dashed
    // connector still draws (setLineDash on the bridge pass).
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(true);
  });

  it('skips decimation when session breaks split the line', () => {
    const { ctx, calls } = sizedCtx(10);
    drawLine(
      ctx,
      dense(5000),
      domainScale(0, 5000),
      (v) => v,
      style,
      undefined,
      'empty',
      undefined,
      [2500],
    );
    expect(penCount(calls)).toBeGreaterThan(4000);
  });
});
