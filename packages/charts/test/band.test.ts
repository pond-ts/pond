import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import { bandExtent, drawBand } from '../src/band.js';
import { recordingContext } from './canvas-mock.js';
import type { BandSeries } from '../src/data.js';
import type { Scale } from '../src/line.js';

const bs = (x: number[], lower: number[], upper: number[]): BandSeries => ({
  x: Float64Array.from(x),
  lower: Float64Array.from(lower),
  upper: Float64Array.from(upper),
  length: x.length,
});
const identity = (v: number) => v;
const style = { fill: '#abc', opacity: 0.2 };

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

describe('drawBand — viewport culling (Phase 2)', () => {
  const domainScale = (lo: number, hi: number): Scale =>
    scaleLinear().domain([lo, hi]).range([lo, hi]) as unknown as Scale;
  // 10 samples at x = 0,10,…,90.
  const ramp = (): BandSeries =>
    bs(
      Array.from({ length: 10 }, (_, i) => i * 10),
      Array.from({ length: 10 }, (_, i) => i),
      Array.from({ length: 10 }, (_, i) => i + 5),
    );

  it('fills only the visible slice + one entry/exit point', () => {
    const { ctx, calls } = recordingContext();
    // view [25, 55] → 5 samples (entry 20 … exit 60). d3 area on 5 samples
    // draws the upper edge (5 pen ops) + the lower edge back — far fewer than
    // the 10-sample full band.
    drawBand(ctx, ramp(), domainScale(25, 55), (v) => v, style);
    const pen = calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo');
    // Upper edge: 1 moveTo + 4 lineTo = 5; lower edge back: 5 lineTo; = 10 total
    // for 5 samples, vs 20 for the full 10-sample band.
    expect(pen.length).toBe(10);
  });

  it('draws the whole band when the view covers it', () => {
    const { ctx, calls } = recordingContext();
    drawBand(ctx, ramp(), domainScale(-100, 1000), (v) => v, style);
    const pen = calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo');
    expect(pen.length).toBe(20); // 10 samples, both edges
  });
});

describe('drawBand — M4 decimation (Phase 3)', () => {
  const pxScale = (lo: number, hi: number): Scale =>
    scaleLinear().domain([lo, hi]).range([lo, hi]) as unknown as Scale;
  const sizedCtx = (widthPx: number) => {
    const { ctx, calls } = recordingContext();
    (ctx as unknown as { canvas: { width: number } }).canvas = {
      width: widthPx,
    };
    return { ctx, calls };
  };
  const denseBand = (n: number): BandSeries =>
    bs(
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => i + 100),
    );
  const penCount = (calls: { name: string }[]) =>
    calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo').length;

  it('decimates a dense envelope to one point per column', () => {
    const { ctx, calls } = sizedCtx(10); // W=10 → 10 upper + 10 lower verts
    drawBand(ctx, denseBand(5000), pxScale(0, 5000), (v) => v, style);
    // W points per edge → ~20 pen ops, vs ~10000 full-res.
    expect(penCount(calls)).toBeLessThanOrEqual(20);
    expect(penCount(calls)).toBeGreaterThan(0);
  });

  it('fills every sample when decimate is off', () => {
    const { ctx, calls } = sizedCtx(10);
    drawBand(
      ctx,
      denseBand(300),
      pxScale(0, 300),
      (v) => v,
      style,
      undefined,
      false,
    );
    // 300 samples × 2 edges = 600 verts, not decimated.
    expect(penCount(calls)).toBe(600);
  });
});
