import { describe, expect, it } from 'vitest';
import { scaleLinear, scaleLog } from 'd3-scale';
import { buildBandGradient, drawArea } from '../src/area.js';
import type { BandLadder } from '../src/bars.js';
import { recordingContext, type CtxCall } from './canvas-mock.js';
import type { ChartSeries } from '../src/data.js';
import type { AreaStyle } from '../src/theme.js';
import type { Scale } from '../src/line.js';

/**
 * `<AreaChart thresholds>` ([PND-BANDAREA]) — the band gradient. One vertical
 * hard-stop gradient in pixel space carries the whole ladder for the fill and
 * the outline; these tests pin the stop construction (the observable the mock
 * can see), the magnitude mirroring, and the off-plot clamp honesty.
 */

const cs = (x: number[], y: number[]): ChartSeries => ({
  x: Float64Array.from(x),
  y: Float64Array.from(y),
  length: x.length,
});

const style: AreaStyle = {
  color: '#000',
  width: 1,
  fill: '#2563eb',
  fillOpacity: 0.3,
};

const LADDER: BandLadder = {
  thresholds: [1, 2],
  colors: ['#g0', '#a1', '#r2'], // low, mid, high — placeholder ink, not parsed
};

/** One recorded `addColorStop(offset, color)` on the gradient stub. */
interface Stop {
  offset: number;
  color: string;
}

/**
 * A recording context whose `createLinearGradient` returns a stub recording
 * its stops (the shared mock's generic method returns `undefined`, which a
 * real gradient isn't) — plus the stub objects themselves, so a test can
 * assert `strokeStyle` was handed the *same* gradient the fill used.
 */
function gradientContext(): {
  ctx: CanvasRenderingContext2D;
  calls: CtxCall[];
  gradients: Stop[][];
  gradientObjects: unknown[];
  gradientGeom: number[][];
} {
  const { ctx, calls } = recordingContext();
  const gradients: Stop[][] = [];
  const gradientObjects: unknown[] = [];
  const gradientGeom: number[][] = [];
  (
    ctx as unknown as {
      createLinearGradient: (...args: number[]) => CanvasGradient;
    }
  ).createLinearGradient = (...args: number[]) => {
    gradientGeom.push(args);
    const stops: Stop[] = [];
    gradients.push(stops);
    const stub = {
      addColorStop: (offset: number, color: string) => {
        if (!Number.isFinite(offset) || offset < 0 || offset > 1) {
          throw new Error(`addColorStop: offset ${offset} out of range`);
        }
        stops.push({ offset, color });
      },
    };
    gradientObjects.push(stub);
    return stub as unknown as CanvasGradient;
  };
  return { ctx, calls, gradients, gradientObjects, gradientGeom };
}

describe('buildBandGradient — stop construction', () => {
  it('hard-stops at every crossing, mirrored below zero', () => {
    // Domain [-3, 3] over 300px: +2 at 50, +1 at 100, -1 at 200, -2 at 250.
    // Expected offsets go through the same scale arithmetic as the code under
    // test, so the comparison is exact rather than float-adjacent.
    const y = scaleLinear([-3, 3], [300, 0]);
    const off = (v: number) => y(v) / 300;
    const { ctx, gradients } = gradientContext();
    buildBandGradient(ctx, y as Scale, 300, LADDER);
    expect(gradients).toHaveLength(1);
    expect(gradients[0]).toEqual([
      { offset: 0, color: '#r2' }, // top region: |v| beyond the last breakpoint
      { offset: off(2), color: '#r2' },
      { offset: off(2), color: '#a1' }, // hard stop at +2
      { offset: off(1), color: '#a1' },
      { offset: off(1), color: '#g0' }, // hard stop at +1
      { offset: off(-1), color: '#g0' }, // band 0 spans −1…+1, no stop at 0
      { offset: off(-1), color: '#a1' }, // hard stop at −1
      { offset: off(-2), color: '#a1' },
      { offset: off(-2), color: '#r2' }, // hard stop at −2
      { offset: 1, color: '#r2' },
    ]);
  });

  it('spans the gradient over the full plot height in pixel space', () => {
    const y = scaleLinear([-3, 3], [300, 0]);
    const { ctx, gradientGeom } = gradientContext();
    buildBandGradient(ctx, y as Scale, 300, LADDER);
    expect(gradientGeom).toEqual([[0, 0, 0, 300]]);
  });

  it('clamps off-plot crossings to the ends (positive-only domain)', () => {
    // Domain [0, 3]: the negative mirrors land below the plot and clamp to 1,
    // degenerating to zero-height regions — the visible span stays honest.
    const y = scaleLinear([0, 3], [300, 0]);
    const off = (v: number) => y(v) / 300;
    const { ctx, gradients } = gradientContext();
    buildBandGradient(ctx, y as Scale, 300, LADDER);
    const stops = gradients[0]!;
    for (const s of stops) {
      expect(s.offset).toBeGreaterThanOrEqual(0);
      expect(s.offset).toBeLessThanOrEqual(1);
    }
    // The visible ordering is still high → mid → low, top to bottom.
    expect(stops.slice(0, 5)).toEqual([
      { offset: 0, color: '#r2' },
      { offset: off(2), color: '#r2' },
      { offset: off(2), color: '#a1' },
      { offset: off(1), color: '#a1' },
      { offset: off(1), color: '#g0' },
    ]);
  });

  it('paints the whole plot in one band when zoomed inside it', () => {
    // Domain [1.2, 1.8] sits entirely inside band 1: every crossing is off
    // the plot, clamped to an end, and the interior region is mid throughout.
    const y = scaleLinear([1.2, 1.8], [300, 0]);
    const { ctx, gradients } = gradientContext();
    buildBandGradient(ctx, y as Scale, 300, LADDER);
    const stops = gradients[0]!;
    const interiorEdges = [
      stops.filter((s) => s.offset === 0).at(-1)!.color,
      stops.filter((s) => s.offset === 1)[0]!.color,
    ];
    expect(interiorEdges).toEqual(['#a1', '#a1']);
  });

  it('drops the negative mirrors on a log axis instead of inventing them', () => {
    // `yScale(-t)` has no position on a log axis; only the two positive
    // crossings exist. 1 seed + 2×2 hard stops + 1 tail = 6 stops.
    const y = scaleLog([0.5, 10], [300, 0]);
    const { ctx, gradients } = gradientContext();
    buildBandGradient(ctx, y as Scale, 300, LADDER);
    const stops = gradients[0]!;
    expect(stops).toHaveLength(6);
    expect(stops[0]!.color).toBe('#r2');
    expect(stops.at(-1)!.color).toBe('#g0');
  });

  it('bands a flipped axis correctly (value increasing downward)', () => {
    // Same domain as the first case with the range reversed. The resulting
    // stop list is *identical*: the ladder is symmetric in |v|, so flipping
    // the axis maps each crossing onto its mirror's pixel — high ink at both
    // value extremes, low ink through the middle, wherever the canvas puts
    // them. The direction probe is what keeps the colours attached to the
    // right side of each crossing.
    const y = scaleLinear([-3, 3], [0, 300]);
    const off = (v: number) => y(v) / 300;
    const { ctx, gradients } = gradientContext();
    buildBandGradient(ctx, y as Scale, 300, LADDER);
    expect(gradients[0]).toEqual([
      { offset: 0, color: '#r2' },
      { offset: off(-2), color: '#r2' },
      { offset: off(-2), color: '#a1' },
      { offset: off(-1), color: '#a1' },
      { offset: off(-1), color: '#g0' },
      { offset: off(1), color: '#g0' },
      { offset: off(1), color: '#a1' },
      { offset: off(2), color: '#a1' },
      { offset: off(2), color: '#r2' },
      { offset: 1, color: '#r2' },
    ]);
  });

  it('falls back to the top band flat colour with no height to anchor on', () => {
    const y = scaleLinear([0, 3], [300, 0]);
    const { ctx, gradients } = gradientContext();
    expect(buildBandGradient(ctx, y as Scale, 0, LADDER)).toBe('#r2');
    expect(buildBandGradient(ctx, y as Scale, NaN, LADDER)).toBe('#r2');
    expect(gradients).toHaveLength(0);
  });
});

describe('drawArea with a band ladder', () => {
  const xs = [0, 1, 2, 3];
  const ys = [0.5, 2.5, 1.5, 3];
  const x = scaleLinear([0, 3], [0, 300]);
  const y = scaleLinear([0, 3], [300, 0]);

  it('builds ONE gradient and hands it to the fill AND the outline', () => {
    const { ctx, calls, gradientObjects } = gradientContext();
    drawArea(
      ctx,
      cs(xs, ys),
      x as Scale,
      y as Scale,
      style,
      0,
      undefined,
      'empty',
      undefined,
      true,
      LADDER,
    );
    // One gradient total: the banded fill replaces the grade, it doesn't add
    // to it — and the outline strokes with the same object, which is what
    // makes the value line switch hue exactly at a crossing.
    expect(gradientObjects).toHaveLength(1);
    const sets = (name: string) =>
      calls.filter((c) => c.type === 'set' && c.name === name);
    expect(sets('fillStyle').at(-1)!.args[0]).toBe(gradientObjects[0]);
    expect(sets('strokeStyle').at(-1)!.args[0]).toBe(gradientObjects[0]);
  });

  it('keeps the un-banded grade when no ladder is passed', () => {
    const { ctx, calls, gradientObjects } = gradientContext();
    drawArea(ctx, cs(xs, ys), x as Scale, y as Scale, style, 0);
    expect(gradientObjects).toHaveLength(1); // the grade
    const stroke = calls
      .filter((c) => c.type === 'set' && c.name === 'strokeStyle')
      .at(-1)!;
    expect(stroke.args[0]).toBe(style.color); // outline keeps the role colour
  });

  it('keeps the role colour for inferred gap connectors', () => {
    // A dashed bridge is a guess about absent data; zone ink would over-claim
    // exactly where nothing was measured.
    const { ctx, calls } = gradientContext();
    drawArea(
      ctx,
      cs([0, 1, 2, 3], [0.5, NaN, NaN, 3]),
      x as Scale,
      y as Scale,
      style,
      0,
      undefined,
      'dashed',
      0.4,
      true,
      LADDER,
    );
    const strokes = calls
      .filter((c) => c.type === 'set' && c.name === 'strokeStyle')
      .map((c) => c.args[0]);
    expect(strokes).toContain(style.color); // the connector pass
  });

  it('reports the same draw stats as the un-banded draw', () => {
    const { ctx } = gradientContext();
    const banded = drawArea(
      ctx,
      cs(xs, ys),
      x as Scale,
      y as Scale,
      style,
      0,
      undefined,
      'empty',
      undefined,
      true,
      LADDER,
    );
    const plain = drawArea(ctx, cs(xs, ys), x as Scale, y as Scale, style, 0);
    expect(banded).toEqual(plain);
  });
});
