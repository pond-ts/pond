import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import { areaExtent, drawArea } from '../src/area.js';
import { resolveCurve } from '../src/curve.js';
import { recordingContext, type CtxCall } from './canvas-mock.js';
import type { ChartSeries } from '../src/data.js';
import type { AreaStyle } from '../src/theme.js';
import type { Scale } from '../src/line.js';

const cs = (x: number[], y: number[]): ChartSeries => ({
  x: Float64Array.from(x),
  y: Float64Array.from(y),
  length: x.length,
});
const identity = (v: number) => v;
const style: AreaStyle = {
  color: '#000',
  width: 1,
  fill: '#2563eb',
  fillOpacity: 0.3,
};

/** One recorded `addColorStop(offset, color)` on the gradient stub. */
interface Stop {
  offset: number;
  color: string;
}

/**
 * A recording context whose `createLinearGradient` returns a stub that records
 * its `addColorStop` calls (the shared mock returns `undefined` for any method,
 * which a real gradient isn't). `gradients` collects one stop-list per
 * `createLinearGradient` call so the gradient-anchoring logic is assertable.
 */
function areaContext(): {
  ctx: CanvasRenderingContext2D;
  calls: CtxCall[];
  gradients: Stop[][];
} {
  const { ctx, calls } = recordingContext();
  const gradients: Stop[][] = [];
  // Storing through the proxy: the set trap saves it, the get trap returns it,
  // so `ctx.createLinearGradient(...)` calls this and yields a recording stub.
  (
    ctx as unknown as { createLinearGradient: () => CanvasGradient }
  ).createLinearGradient = () => {
    const stops: Stop[] = [];
    gradients.push(stops);
    return {
      addColorStop: (offset: number, color: string) =>
        stops.push({ offset, color }),
    } as unknown as CanvasGradient;
  };
  return { ctx, calls, gradients };
}

describe('areaExtent', () => {
  it('returns [min, max] of finite values when baseline is undefined', () => {
    expect(areaExtent(cs([0, 1, 2], [10, 30, 20]), undefined)).toEqual([
      10, 30,
    ]);
  });
  it('ignores NaN gaps', () => {
    expect(areaExtent(cs([0, 1, 2, 3], [10, NaN, 30, 20]), undefined)).toEqual([
      10, 30,
    ]);
  });
  it('widens the extent to include a fixed baseline below the data', () => {
    // elevation-style: baseline 0 under all-positive data pulls the floor in.
    expect(areaExtent(cs([0, 1, 2], [10, 30, 20]), 0)).toEqual([0, 30]);
  });
  it('widens the extent to include a baseline above the data', () => {
    expect(areaExtent(cs([0, 1], [-5, -2]), 0)).toEqual([-5, 0]);
  });
  it('keeps a baseline that straddles the data (above/below axis)', () => {
    // signed series around 0: extent spans both signs, baseline already inside.
    expect(areaExtent(cs([0, 1, 2], [-4, 3, -1]), 0)).toEqual([-4, 3]);
  });
  it('returns null when nothing is finite', () => {
    expect(areaExtent(cs([0, 1], [NaN, NaN]), 0)).toBeNull();
  });
});

describe('drawArea', () => {
  it('fills then strokes the outline, each in its own save/restore', () => {
    const { ctx, calls } = areaContext();
    drawArea(ctx, cs([0, 1], [2, 2]), identity, identity, style, 0);
    const seq = calls.filter((c) => c.type === 'call').map((c) => c.name);
    // fill pass: save → beginPath → (area path) → fill → restore;
    // outline pass: save → beginPath → (line path) → stroke → restore.
    expect(seq.filter((n) => n === 'fill')).toHaveLength(1);
    expect(seq.filter((n) => n === 'stroke')).toHaveLength(1);
    expect(seq.filter((n) => n === 'save')).toHaveLength(2);
    expect(seq.filter((n) => n === 'restore')).toHaveLength(2);
    // fill comes before the outline stroke (outline sits on top).
    expect(seq.indexOf('fill')).toBeLessThan(seq.indexOf('stroke'));
  });

  it('breaks the fill and the outline at a gap — fresh subpath each run', () => {
    const { ctx, calls } = areaContext();
    // gap at index 2 → two runs: [0,1] and [3].
    drawArea(
      ctx,
      cs([0, 1, 2, 3], [2, 2, NaN, 5]),
      identity,
      identity,
      style,
      0,
    );
    // Each run is its own subpath, so the gap is never bridged: the area starts
    // a fresh subpath (moveTo) per run and closes the polygon (closePath) per
    // run — one closePath each. The outline line likewise re-moves per run.
    // 2 area moveTo + 2 outline moveTo = 4, and 2 area closePath = 2.
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(4);
    expect(
      calls.filter((c) => c.name === 'closePath').length,
    ).toBeGreaterThanOrEqual(2);
    expect(calls.filter((c) => c.name === 'fill')).toHaveLength(1);
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(1);
  });

  it('draws the fill down to the baseline pixel (y0 = baseline)', () => {
    const { ctx, calls } = areaContext();
    // yScale flips: pixel = 100 - value. baseline 0 → pixel 100. The area's
    // closing edge walks back along y0 = 100.
    drawArea(
      ctx,
      cs([0, 10], [40, 40]),
      (t) => t,
      (v) => 100 - v,
      style,
      0,
    );
    const lineTos = calls.filter((c) => c.name === 'lineTo').map((c) => c.args);
    // The lower edge (baseline) is traversed back at y = 100.
    expect(lineTos.some((a) => a[1] === 100)).toBe(true);
  });

  it('maps the value edge through the scales (top vertex)', () => {
    const { ctx, calls } = areaContext();
    drawArea(
      ctx,
      cs([0, 10], [1, 3]),
      (t) => t * 2,
      (v) => 100 - v,
      style,
      0,
    );
    // first vertex = value[0]: x = 0*2 = 0, y = 100 - 1 = 99.
    expect(calls.find((c) => c.name === 'moveTo')?.args).toEqual([0, 99]);
  });

  it('applies the outline stroke colour + width at full opacity', () => {
    const { ctx, calls } = areaContext();
    drawArea(
      ctx,
      cs([0, 1], [2, 2]),
      identity,
      identity,
      { color: '#abc', width: 2.5, fill: '#2563eb', fillOpacity: 0.4 },
      0,
    );
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'strokeStyle')?.args,
    ).toEqual(['#abc']);
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'lineWidth')?.args,
    ).toEqual([2.5]);
  });

  it('sets globalAlpha to fillOpacity for the fill (carried by the layer)', () => {
    const { ctx, calls } = areaContext();
    drawArea(
      ctx,
      cs([0, 1], [2, 2]),
      identity,
      identity,
      { ...style, fillOpacity: 0.42 },
      0,
    );
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'globalAlpha')?.args,
    ).toEqual([0.42]);
  });

  it('builds a two-stop grade for a one-sided area (elevation form)', () => {
    const { ctx, gradients } = areaContext();
    // A flipping yScale (range top→bottom, like a real axis): all-positive
    // values sit above baseline 0 → opaque at the line (top), transparent at
    // the baseline (bottom).
    const flip = (v: number) => 100 - v;
    drawArea(ctx, cs([0, 1, 2], [10, 20, 30]), identity, flip, style, 0);
    expect(gradients).toHaveLength(1);
    const stops = gradients[0]!;
    expect(stops).toHaveLength(2);
    expect(stops[0]!.offset).toBe(0); // line edge (top)
    expect(stops[1]!.offset).toBe(1); // baseline edge (bottom)
    // opaque stop is the style fill; the far stop is transparent (rgba alpha 0).
    expect(stops[0]!.color).toBe('#2563eb');
    expect(stops[1]!.color).toBe('rgba(37, 99, 235, 0)');
  });

  it('grades opaque-at-line for an all-below area (out channel)', () => {
    const { ctx, gradients } = areaContext();
    // A flipping yScale; all-negative values sit *below* baseline 0 (larger
    // pixels), so the line is at the bottom and the baseline at the top: opaque
    // at the bottom (the line), transparent at the top (the baseline). This is
    // the esnet `out` channel — the grade must fade toward the axis, not away.
    const flip = (v: number) => 100 - v;
    drawArea(ctx, cs([0, 1, 2], [-10, -20, -30]), identity, flip, style, 0);
    const stops = gradients[0]!;
    expect(stops).toHaveLength(2);
    expect(stops[0]!.offset).toBe(0); // baseline edge (top)
    expect(stops[1]!.offset).toBe(1); // line edge (bottom)
    expect(stops[0]!.color).toBe('rgba(37, 99, 235, 0)'); // baseline, transparent
    expect(stops[1]!.color).toBe('#2563eb'); // line, opaque
  });

  it('builds a three-stop grade for a straddling area (above/below axis)', () => {
    const { ctx, gradients } = areaContext();
    // A flipping yScale; values both sides of baseline 0 → opaque at both
    // extremes, transparent at the baseline pixel (the middle stop).
    const flip = (v: number) => 100 - v;
    drawArea(ctx, cs([0, 1, 2], [-20, 20, -10]), identity, flip, style, 0);
    const stops = gradients[0]!;
    expect(stops).toHaveLength(3);
    expect(stops[0]!.color).toBe('#2563eb'); // top, opaque
    expect(stops[2]!.color).toBe('#2563eb'); // bottom, opaque
    expect(stops[1]!.color).toBe('rgba(37, 99, 235, 0)'); // baseline, transparent
    // the transparent stop sits strictly inside the region.
    expect(stops[1]!.offset).toBeGreaterThan(0);
    expect(stops[1]!.offset).toBeLessThan(1);
  });

  it('falls back to a flat fill for a degenerate region (single point)', () => {
    const { ctx, calls, gradients } = areaContext();
    // one finite value equal to the baseline → zero-height region, no gradient.
    drawArea(ctx, cs([0], [0]), identity, identity, style, 0);
    expect(gradients).toHaveLength(0);
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'fillStyle')?.args,
    ).toEqual(['#2563eb']);
  });

  it('emits no path vertices when every value is a gap (still brackets)', () => {
    const { ctx, calls } = areaContext();
    drawArea(ctx, cs([0, 1], [NaN, NaN]), identity, identity, style, 0);
    expect(
      calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo'),
    ).toEqual([]);
    // both passes still bracket their (empty) paths.
    expect(calls.filter((c) => c.name === 'fill')).toHaveLength(1);
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(1);
  });

  it('draws a curved edge (bezier ops) when given a non-linear curve', () => {
    const { ctx, calls } = areaContext();
    drawArea(
      ctx,
      cs([0, 1, 2, 3], [10, 30, 10, 30]),
      identity,
      identity,
      style,
      0,
      resolveCurve('basis'),
    );
    const ops = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(ops).toContain('bezierCurveTo');
  });
});

/** A flipping y-scale with a domain, [0, 100] → floor pixel = y(0) = 100. */
function flipScale(): (v: number) => number {
  const f = (v: number) => 100 - v;
  (f as unknown as { domain: () => number[] }).domain = () => [0, 100];
  return f;
}

describe('drawArea gap modes', () => {
  // gap at index 2 → interior gap [1]→[3].
  const gapped = () => cs([0, 1, 2, 3], [20, 20, NaN, 40]);

  it("'empty' (default) breaks the fill — no bridge, no dash, no extra gradient", () => {
    const { ctx, calls, gradients } = areaContext();
    drawArea(
      ctx,
      gapped(),
      identity,
      flipScale(),
      style,
      0,
      undefined,
      'empty',
    );
    // Two fill subpaths (moveTo) + two outline subpaths = 4; one gradient (fill).
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(4);
    expect(gradients).toHaveLength(1); // just the fill gradient
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
    // one fill stroke for the outline (no bridge pass).
    expect(calls.filter((c) => c.name === 'stroke')).toHaveLength(1);
  });

  it("'none' bridges the fill + outline across the gap (one run each)", () => {
    const { ctx, calls } = areaContext();
    drawArea(ctx, gapped(), identity, flipScale(), style, 0, undefined, 'none');
    // The interior NaN is interpolated → one continuous fill run + one outline
    // run, so a single fill moveTo and a single outline moveTo = 2 (vs 4).
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(2);
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
  });

  it("'dashed' keeps the fill broken and adds a dashed outline bridge", () => {
    const { ctx, calls } = areaContext();
    drawArea(
      ctx,
      gapped(),
      identity,
      flipScale(),
      style,
      0,
      undefined,
      'dashed',
    );
    // fill still broken: two filled runs ⇒ two closePaths (the bridge pass adds
    // no closePath, so this isolates the fill from the overlay).
    expect(
      calls.filter((c) => c.name === 'closePath').length,
    ).toBeGreaterThanOrEqual(2);
    // plus a dashed bridge pass.
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(true);
    const dash = calls.find((c) => c.name === 'setLineDash');
    expect(dash?.args).toEqual([[4, 4]]);
    // bridge: last-good index1 (x=1, y(20)=80) → next-good index3 (x=3, y(40)=60).
    const lines = calls.filter((c) => c.name === 'lineTo').map((c) => c.args);
    expect(lines).toContainEqual([3, 60]);
  });

  it("'step' draws a faint flat dashed outline at the average of the two edge values", () => {
    const { ctx, calls } = areaContext();
    drawArea(
      ctx,
      gapped(),
      identity,
      flipScale(),
      style,
      0,
      undefined,
      'step',
      0.4,
    );
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(true);
    // gapped(): edges index1 (x=1,y(20)=80) → index3 (x=3,y(40)=60); avg pixel
    // = 70. A horizontal segment at y=70 from x=1 to x=3 (the fill only ever
    // touches the baseline pixel 100, never 70).
    const moves = calls.filter((c) => c.name === 'moveTo').map((c) => c.args);
    const lines = calls.filter((c) => c.name === 'lineTo').map((c) => c.args);
    expect(moves).toContainEqual([1, 70]); // average, left edge
    expect(lines).toContainEqual([3, 70]); // flat to the right edge
    expect(lines).not.toContainEqual([3, 60]); // no vertical correction
    // faint connector: globalAlpha set to the passed opacity, distinct from the
    // fill's own 0.3.
    expect(
      calls.some(
        (c) =>
          c.type === 'set' && c.name === 'globalAlpha' && c.args?.[0] === 0.4,
      ),
    ).toBe(true);
  });

  it("'fade' adds vertical gradient drops at the gap edges (fill stays broken)", () => {
    const { ctx, calls, gradients } = areaContext();
    drawArea(ctx, gapped(), identity, flipScale(), style, 0, undefined, 'fade');
    // gradients: 1 for the fill + 2 for the drops (the two gap edges) = 3.
    expect(gradients).toHaveLength(3);
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
    // fill still broken: two filled runs ⇒ two closePaths.
    expect(
      calls.filter((c) => c.name === 'closePath').length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('drawArea — viewport culling (Phase 2)', () => {
  const domainScale = (lo: number, hi: number): Scale =>
    scaleLinear().domain([lo, hi]).range([lo, hi]) as unknown as Scale;
  const ramp = (): ChartSeries =>
    cs(
      Array.from({ length: 10 }, (_, i) => i * 10),
      Array.from({ length: 10 }, (_, i) => i * 10),
    );

  it('fills only the visible slice + one entry/exit point', () => {
    const { ctx, calls, gradients } = areaContext();
    // view [25, 55] → in-range 30,40,50; entry 20 + exit 60 → 5 points.
    drawArea(ctx, ramp(), domainScale(25, 55), (v) => v, style, 0);
    // Per drawn point the area emits 3 pen ops: the fill polygon walks the top
    // edge forward + the baseline back (2N), then the outline re-walks the top
    // edge (N). 5 drawn points → 15 pen ops, vs 30 for the full 10-point series.
    const penOps = calls.filter(
      (c) => c.name === 'moveTo' || c.name === 'lineTo',
    );
    expect(penOps.length).toBe(15);
    // Fill still rendered (a gradient was built for it).
    expect(gradients.length).toBeGreaterThanOrEqual(1);
  });

  it('the fill gradient anchors to the FULL series, not the culled view', () => {
    // The gradient extent is behavior-neutral under culling: it must span the
    // whole data's pixel range so the visible fill shades identically. Capture
    // the createLinearGradient(x0,y0,x1,y1) anchor coords.
    const { ctx } = recordingContext();
    const anchors: number[][] = [];
    (
      ctx as unknown as { createLinearGradient: (...a: number[]) => unknown }
    ).createLinearGradient = (...args: number[]) => {
      anchors.push(args);
      return { addColorStop: () => {} };
    };
    // y = x, yScale = identity, baseline 0. Full series y spans 0..90 → the
    // gradient's vertical anchor must reach 90 even though the view is [25,55].
    drawArea(ctx, ramp(), domainScale(25, 55), (v) => v, style, 0);
    // First gradient is the fill; its y-anchors span the full [0, 90] extent.
    const [, y0, , y1] = anchors[0]!;
    expect(Math.max(y0!, y1!)).toBe(90);
    expect(Math.min(y0!, y1!)).toBe(0);
  });
});

describe('drawArea — M4 decimation (Phase 3)', () => {
  const pxScale = (lo: number, hi: number): Scale =>
    scaleLinear().domain([lo, hi]).range([lo, hi]) as unknown as Scale;
  const sizedCtx = (widthPx: number) => {
    const c = areaContext();
    (c.ctx as unknown as { canvas: { width: number } }).canvas = {
      width: widthPx,
    };
    return c;
  };
  const dense = (n: number): ChartSeries =>
    cs(
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => i),
    );
  const penCount = (calls: CtxCall[]) =>
    calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo').length;

  it('decimates the fill + outline of a dense area', () => {
    const { ctx, calls } = sizedCtx(10); // W=10
    // 5000 points → decimate; fill polygon + outline over ≤4·10 columns.
    drawArea(ctx, dense(5000), pxScale(0, 5000), (v) => v, style, 0);
    expect(penCount(calls)).toBeLessThan(200); // vs ~15000 full-res
    expect(penCount(calls)).toBeGreaterThan(0);
  });

  it('draws full-resolution when decimate is off', () => {
    const { ctx, calls } = sizedCtx(10);
    drawArea(
      ctx,
      dense(300),
      pxScale(0, 300),
      (v) => v,
      style,
      0,
      undefined,
      'empty',
      undefined,
      false,
    );
    // 300 points → full fill + outline (well over the decimated bound).
    expect(penCount(calls)).toBeGreaterThan(300);
  });
});
