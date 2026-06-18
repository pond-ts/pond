import { describe, expect, it } from 'vitest';
import { bandExtent, drawBand } from '../src/band.js';
import { recordingContext } from './canvas-mock.js';
import type { BandSeries } from '../src/data.js';

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

  it('breaks into a separate fill per contiguous run, not across the gap', () => {
    const { ctx, calls } = recordingContext();
    // gap at index 2 → two runs: [0,1] and [3]
    drawBand(
      ctx,
      bs([0, 1, 2, 3], [0, 0, NaN, 5], [2, 2, NaN, 7]),
      identity,
      identity,
      style,
    );
    expect(calls.filter((c) => c.name === 'fill')).toHaveLength(2);
    expect(calls.filter((c) => c.name === 'beginPath')).toHaveLength(2);
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

  it('fills nothing (but still brackets) when no sample is finite', () => {
    const { ctx, calls } = recordingContext();
    drawBand(
      ctx,
      bs([0, 1], [NaN, NaN], [NaN, NaN]),
      identity,
      identity,
      style,
    );
    expect(calls.filter((c) => c.name === 'fill')).toHaveLength(0);
    expect(calls.filter((c) => c.type === 'call').map((c) => c.name)).toEqual([
      'save',
      'restore',
    ]);
  });
});
