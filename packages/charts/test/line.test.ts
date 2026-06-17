import { describe, expect, it } from 'vitest';
import { drawLine, yExtent } from '../src/line.js';
import { recordingContext } from './canvas-mock.js';
import type { ChartSeries } from '../src/data.js';

const cs = (x: number[], y: number[]): ChartSeries => ({
  x: Float64Array.from(x),
  y: Float64Array.from(y),
  length: x.length,
});
const identity = (v: number) => v;
const style = { color: '#000', width: 1 };

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
});
