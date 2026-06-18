import { describe, expect, it } from 'vitest';
import { drawGrid } from '../src/grid.js';
import { recordingContext } from './canvas-mock.js';

describe('drawGrid', () => {
  it('draws one vertical line per x-tick and one horizontal per y-tick', () => {
    const { ctx, calls } = recordingContext();
    drawGrid(ctx, [10, 50, 90], [20, 60], 100, 80, '#ccc', [2, 2]);
    const pen = calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .map((c) => c.name);
    // 3 verticals + 2 horizontals = 5 segments, each a moveTo + lineTo.
    expect(pen).toEqual(Array(5).fill(['moveTo', 'lineTo']).flat());
  });

  it('snaps each stroke to a crisp half-pixel (round + 0.5) at the tick', () => {
    const { ctx, calls } = recordingContext();
    drawGrid(ctx, [10.4], [20.6], 100, 50, '#ccc', []);
    const moves = calls.filter((c) => c.name === 'moveTo').map((c) => c.args);
    const lines = calls.filter((c) => c.name === 'lineTo').map((c) => c.args);
    // vertical at x=round(10.4)+0.5=10.5 spanning full height
    expect(moves[0]).toEqual([10.5, 0]);
    expect(lines[0]).toEqual([10.5, 50]);
    // horizontal at y=round(20.6)+0.5=21.5 spanning full width
    expect(moves[1]).toEqual([0, 21.5]);
    expect(lines[1]).toEqual([100, 21.5]);
  });

  it('applies the grid colour + dash and brackets state with save/restore', () => {
    const { ctx, calls } = recordingContext();
    drawGrid(ctx, [10], [20], 100, 50, '#abc', [3, 1]);
    const names = calls.map((c) => c.name);
    expect(names[0]).toBe('save');
    expect(names[names.length - 1]).toBe('restore');
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'strokeStyle')?.args,
    ).toEqual(['#abc']);
    expect(calls.find((c) => c.name === 'setLineDash')?.args).toEqual([[3, 1]]);
  });

  it('still strokes (no segments) when there are no ticks', () => {
    const { ctx, calls } = recordingContext();
    drawGrid(ctx, [], [], 100, 50, '#ccc', [2, 2]);
    expect(
      calls.filter((c) => c.name === 'moveTo' || c.name === 'lineTo'),
    ).toEqual([]);
    const seq = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(seq).toEqual([
      'save',
      'setLineDash',
      'beginPath',
      'stroke',
      'restore',
    ]);
  });
});
