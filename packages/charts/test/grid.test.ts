import { describe, expect, it } from 'vitest';
import {
  drawGrid,
  drawDividers,
  dividerAlphas,
  thinPixels,
} from '../src/grid.js';
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

  it('with xAlphas: full-alpha lines batch into the main path, faded ones stroke per-line, near-zero skipped', () => {
    const { ctx, calls } = recordingContext();
    drawGrid(
      ctx,
      [10, 30, 50, 70],
      [20],
      100,
      80,
      '#ccc',
      [],
      [1, 0.5, 0.01, 1],
    );
    // Main path: the two alpha-1 verticals + the horizontal = 3 segments,
    // then one per-line path for the 0.5 line; the 0.01 line never draws.
    const strokes = calls.filter((c) => c.name === 'stroke').length;
    expect(strokes).toBe(2);
    const moves = calls.filter((c) => c.name === 'moveTo').map((c) => c.args);
    expect(moves).toEqual([
      [10.5, 0],
      [70.5, 0],
      [0, 20.5],
      [30.5, 0],
    ]);
    const alphaSets = calls
      .filter((c) => c.type === 'set' && c.name === 'globalAlpha')
      .map((c) => c.args[0]);
    expect(alphaSets).toEqual([0.5]);
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

describe('thinPixels', () => {
  it('keeps the first of each cluster closer than minGap', () => {
    expect(thinPixels([0, 10, 25, 30, 60], 20)).toEqual([0, 25, 60]);
  });
  it('keeps every position when all are far enough apart', () => {
    expect(thinPixels([0, 40, 80], 20)).toEqual([0, 40, 80]);
  });
  it('handles empty input', () => {
    expect(thinPixels([], 20)).toEqual([]);
  });
});

describe('drawDividers', () => {
  it('strokes one solid vertical per x, full height', () => {
    const { ctx, calls } = recordingContext();
    drawDividers(ctx, [30, 90], 200, '#999');
    const pen = calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .map((c) => c.args);
    // Two verticals, each moveTo(x,0) → lineTo(x,height).
    expect(pen).toEqual([
      [30.5, 0],
      [30.5, 200],
      [90.5, 0],
      [90.5, 200],
    ]);
    expect(calls.find((c) => c.name === 'setLineDash')?.args).toEqual([[]]); // solid
  });
  it('draws nothing for an empty list', () => {
    const { ctx, calls } = recordingContext();
    drawDividers(ctx, [], 200, '#999');
    expect(calls.filter((c) => c.type === 'call')).toEqual([]);
  });

  it('with alphas, draws a separate path per line and skips near-zero', () => {
    const { ctx, calls } = recordingContext();
    // Middle line's alpha is ~0 → skipped; the other two draw.
    drawDividers(ctx, [10, 20, 30], 100, '#999', [1, 0, 0.5]);
    const xs = calls
      .filter((c) => c.name === 'moveTo')
      .map((c) => (c.args as number[])[0]);
    expect(xs).toEqual([10.5, 30.5]); // the alpha-0 line at 20 is skipped
    // Per-line globalAlpha set for the drawn lines (base 1 × line alpha).
    const alphaSets = calls
      .filter((c) => c.type === 'set' && c.name === 'globalAlpha')
      .map((c) => c.args[0]);
    expect(alphaSets).toContain(0.5);
  });
});

describe('dividerAlphas', () => {
  it('is full at fullPx+ gaps, zero at gonePx and below, ramping between', () => {
    // gone 6 / full 26: gaps ≥ 26 → 1; gaps ≤ 6 → 0; 16px (midpoint) → 0.25 (t²).
    expect(dividerAlphas([0, 40, 80], 6, 26)).toEqual([1, 1, 1]);
    expect(dividerAlphas([0, 6, 12], 6, 26)).toEqual([0, 0, 0]);
    expect(dividerAlphas([0, 16, 32], 6, 26)).toEqual([0.25, 0.25, 0.25]);
  });

  it('keys each line off its NEAREST neighbour (min of both gaps)', () => {
    // Middle line is 8px from its left neighbour, 40 from its right → 8 wins.
    const [, mid] = dividerAlphas([0, 8, 48], 4, 12);
    expect(mid).toBeCloseTo(0.25, 5); // t = (8-4)/8 = 0.5 → t² = 0.25
  });

  it('an isolated single line is full opacity', () => {
    expect(dividerAlphas([50], 6, 26)).toEqual([1]);
  });

  it('total ink (alpha × density) falls toward 0 as uniform lines crowd — the plot clears instead of holding a gray wash', () => {
    // The regression this curve exists for: with the old linear ramp,
    // alpha/gap was CONSTANT below the threshold, so zooming out left a
    // permanent veil. Halve the gap repeatedly; the summed alpha over a fixed
    // width must strictly fall once inside the fade window, and reach 0.
    const width = 640;
    const ink = (gap: number): number => {
      const xs = [];
      for (let x = 0; x <= width; x += gap) xs.push(x);
      return dividerAlphas(xs, 6, 26).reduce((s, a) => s + a, 0);
    };
    const washes = [24, 16, 10, 6].map((g) => ink(g));
    for (let i = 1; i < washes.length; i++) {
      expect(washes[i]!).toBeLessThan(washes[i - 1]!);
    }
    expect(washes[washes.length - 1]).toBe(0); // fully clean, not just dimmer
  });
});
