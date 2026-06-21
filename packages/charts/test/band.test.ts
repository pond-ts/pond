import { describe, expect, it } from 'vitest';
import { bandExtent, drawBand } from '../src/band.js';
import { recordingContext, type CtxCall } from './canvas-mock.js';
import type { BandSeries } from '../src/data.js';

const bs = (x: number[], lower: number[], upper: number[]): BandSeries => ({
  x: Float64Array.from(x),
  lower: Float64Array.from(lower),
  upper: Float64Array.from(upper),
  length: x.length,
});
const identity = (v: number) => v;
const style = { fill: '#abc', opacity: 0.2 };

/**
 * A recording context whose `createLinearGradient` returns a recording stub, so
 * the band's `fade` gap mode (which strokes gradient drops) doesn't blow up on
 * the plain mock's `undefined` return. `gradients` counts the calls.
 */
function gradientContext(): {
  ctx: CanvasRenderingContext2D;
  calls: CtxCall[];
  gradients: number[][];
} {
  const { ctx, calls } = recordingContext();
  const gradients: number[][] = [];
  (
    ctx as unknown as {
      createLinearGradient: (...a: number[]) => CanvasGradient;
    }
  ).createLinearGradient = (...args: number[]) => {
    gradients.push(args);
    return { addColorStop: () => {} } as unknown as CanvasGradient;
  };
  return { ctx, calls, gradients };
}

/** A flipping y-scale with a domain, [0, 100] → axis floor pixel = y(0) = 100. */
function flipScale(): (v: number) => number {
  const f = (v: number) => 100 - v;
  (f as unknown as { domain: () => number[] }).domain = () => [0, 100];
  return f;
}

describe('bandExtent', () => {
  it('returns [min lower, max upper] over finite-pair samples', () => {
    expect(bandExtent(bs([0, 1, 2], [1, 2, 3], [5, 6, 7]))).toEqual([1, 7]);
  });
  it('excludes gap samples (either edge NaN) from the extent', () => {
    // sample 1 has a NaN lower → not part of the band, ignored.
    expect(bandExtent(bs([0, 1, 2], [1, NaN, 3], [5, 6, 7]))).toEqual([1, 7]);
  });
  it('returns null when no sample has both edges finite', () => {
    expect(bandExtent(bs([0, 1], [NaN, NaN], [NaN, NaN]))).toBeNull();
  });
});

describe('drawBand', () => {
  it('fills one closed polygon (upper forward, lower back) for a contiguous run', () => {
    const { ctx, calls } = recordingContext();
    drawBand(ctx, bs([0, 1], [0, 0], [2, 2]), identity, identity, style);
    const seq = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(seq).toEqual([
      'save',
      'beginPath',
      'moveTo', // upper[0]
      'lineTo', // upper[1]
      'lineTo', // lower[1]
      'lineTo', // lower[0]
      'closePath',
      'fill',
      'restore',
    ]);
  });

  it('breaks the envelope at a gap — a fresh subpath each side, one fill', () => {
    const { ctx, calls } = recordingContext();
    // gap at index 2 → two runs: [0,1] and [3]
    drawBand(
      ctx,
      bs([0, 1, 2, 3], [0, 0, NaN, 5], [2, 2, NaN, 7]),
      identity,
      identity,
      style,
    );
    // d3-shape fills one path; each run is its own subpath (a fresh moveTo), so
    // the gap is a break, not a fill bridging it.
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(2);
    expect(calls.filter((c) => c.name === 'fill')).toHaveLength(1);
  });

  it('maps edges through the scales', () => {
    const { ctx, calls } = recordingContext();
    drawBand(
      ctx,
      bs([0, 10], [1, 1], [3, 3]),
      (t) => t * 2,
      (v) => 100 - v,
      style,
    );
    // first vertex = upper[0]: x=0*2=0, y=100-3=97
    expect(calls.find((c) => c.name === 'moveTo')?.args).toEqual([0, 97]);
  });

  it('applies fill + opacity and brackets state with save/restore', () => {
    const { ctx, calls } = recordingContext();
    drawBand(ctx, bs([0, 1], [0, 0], [2, 2]), identity, identity, {
      fill: '#123',
      opacity: 0.35,
    });
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'fillStyle')?.args,
    ).toEqual(['#123']);
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'globalAlpha')?.args,
    ).toEqual([0.35]);
    const names = calls.map((c) => c.name);
    expect(names[0]).toBe('save');
    expect(names[names.length - 1]).toBe('restore');
  });

  it('emits no path when no sample is finite (still brackets)', () => {
    const { ctx, calls } = recordingContext();
    drawBand(
      ctx,
      bs([0, 1], [NaN, NaN], [NaN, NaN]),
      identity,
      identity,
      style,
    );
    // Empty path: no vertices. The fill runs on an empty path → paints nothing.
    expect(
      calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo'),
    ).toEqual([]);
    expect(calls.filter((c) => c.type === 'call').map((c) => c.name)).toEqual([
      'save',
      'beginPath',
      'fill',
      'restore',
    ]);
  });
});

describe('drawBand gap modes', () => {
  // gap at index 2 (both edges NaN) → interior gap [1]→[3].
  const gapped = () => bs([0, 1, 2, 3], [0, 0, NaN, 5], [2, 2, NaN, 7]);

  it("'empty' (default) breaks the fill — two subpaths, no bridge", () => {
    const { ctx, calls } = recordingContext();
    drawBand(ctx, gapped(), identity, identity, style, undefined, 'empty');
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(2);
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
    expect(calls.filter((c) => c.name === 'fill')).toHaveLength(1);
  });

  it("'none' bridges the envelope across the gap (single subpath)", () => {
    const { ctx, calls } = recordingContext();
    drawBand(ctx, gapped(), identity, identity, style, undefined, 'none');
    // Both edges interpolated → one continuous filled polygon (one moveTo).
    expect(calls.filter((c) => c.name === 'moveTo')).toHaveLength(1);
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
  });

  it("'dashed' keeps the fill broken and bridges BOTH edges, dashed", () => {
    const { ctx, calls } = recordingContext();
    drawBand(ctx, gapped(), identity, identity, style, undefined, 'dashed');
    // fill still two subpaths.
    expect(
      calls.filter((c) => c.name === 'moveTo').length,
    ).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(true);
    // two connectors (lower + upper edge): lower index1 (x=1,y=0)→index3 (x=3,y=5)
    // and upper index1 (x=1,y=2)→index3 (x=3,y=7).
    const lines = calls.filter((c) => c.name === 'lineTo').map((c) => c.args);
    expect(lines).toContainEqual([3, 5]); // lower-edge bridge end
    expect(lines).toContainEqual([3, 7]); // upper-edge bridge end
  });

  it("'step' bridges both edges down-across-up to the axis floor", () => {
    const { ctx, calls } = recordingContext();
    // identity y-scale with a domain ⇒ floor = y(0) = 0 here; use a scale whose
    // domain[0] gives a distinct floor pixel.
    const y = flipScale(); // floor pixel = y(0) = 100
    drawBand(ctx, gapped(), identity, y, style, undefined, 'step');
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(true);
    const lines = calls.filter((c) => c.name === 'lineTo').map((c) => c.args);
    // both edges drop to the floor at the gap's x endpoints (x=1 and x=3).
    expect(lines).toContainEqual([1, 100]);
    expect(lines).toContainEqual([3, 100]);
  });

  it("'fade' adds gradient drops at both edges' gap endpoints (fill broken)", () => {
    const { ctx, calls, gradients } = gradientContext();
    // edges all clear of the floor (y(0)=100) so no drop is skipped as degenerate.
    const off = bs([0, 1, 2, 3], [10, 10, NaN, 15], [20, 20, NaN, 27]);
    drawBand(ctx, off, identity, flipScale(), style, undefined, 'fade');
    // one interior gap × two edges × two endpoints = 4 drops → 4 gradients.
    expect(gradients).toHaveLength(4);
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
    // fill still broken (two subpaths).
    expect(
      calls.filter((c) => c.name === 'moveTo').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('a leading / trailing band gap is not bridged', () => {
    const { ctx, calls } = recordingContext();
    drawBand(
      ctx,
      bs([0, 1, 2, 3], [NaN, 0, 1, NaN], [NaN, 2, 3, NaN]),
      identity,
      identity,
      style,
      undefined,
      'dashed',
    );
    // interior is fully finite (1,2) → no interior gap → no dashed connector.
    expect(calls.some((c) => c.name === 'setLineDash')).toBe(false);
  });
});
