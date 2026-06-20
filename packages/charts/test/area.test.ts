import { describe, expect, it } from 'vitest';
import { areaExtent, drawArea } from '../src/area.js';
import { resolveCurve } from '../src/curve.js';
import { recordingContext, type CtxCall } from './canvas-mock.js';
import type { ChartSeries } from '../src/data.js';
import type { AreaStyle } from '../src/theme.js';

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
