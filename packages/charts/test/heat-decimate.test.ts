import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import { decimateHeat } from '../src/decimate.js';
import { drawHeat, bandedColor } from '../src/heat.js';
import type { StackedBarSeries } from '../src/data.js';
import { recordingContext } from './canvas-mock.js';

/**
 * [PND-HEATMAP] — **viewport decimation for the grid.**
 *
 * Once the visible cells are denser than ~2 per device pixel, `barSpanPx`
 * widens each sub-pixel cell to `minWidth` about its midpoint, so cells overlap
 * and later draws overpaint earlier ones. The undecimated picture is therefore
 * *already* a reduction — one source cell per column, chosen by loop order.
 *
 * These pin that the replacement is the honest one: the **mean** per pixel
 * column, which is what the overdrawn picture resolves to at that size. That is
 * a resampling answer rather than a statistical one, which is why the layer may
 * take it without the caller naming a reducer — see `decimateHeat`'s doc for
 * why a per-bar-coloured `<BarChart>` cannot make the same move.
 */

const RAMP = ['#a', '#b', '#c', '#d'];

/** `bins × rows` on a unit key axis; `fill(b, g)` supplies each value. */
function grid(
  bins: number,
  rows: number,
  fill: (b: number, g: number) => number,
): StackedBarSeries {
  const begin = new Float64Array(bins);
  const end = new Float64Array(bins);
  const values = new Float64Array(bins * rows);
  for (let b = 0; b < bins; b += 1) {
    begin[b] = b;
    end[b] = b + 1;
    for (let g = 0; g < rows; g += 1) values[b * rows + g] = fill(b, g);
  }
  return {
    begin,
    end,
    values,
    groups: Array.from({ length: rows }, (_, g) => `r${g}`),
    length: bins,
  };
}

/** A context reporting a backing-buffer width, which is what sets the column
 *  count — `deviceBucketCount` reads `ctx.canvas.width`. */
function ctxOfWidth(width: number) {
  const { ctx, calls } = recordingContext();
  (ctx as unknown as { canvas: { width: number } }).canvas = { width };
  return { ctx, calls };
}

const xOver = (bins: number, px: number) =>
  scaleLinear().domain([0, bins]).range([0, px]);

describe('decimateHeat', () => {
  it('declines below the density gate', () => {
    // 100 bins into a 400-column buffer is well under 2 cells per pixel, so the
    // full-resolution draw is both correct and cheaper than the bin walk.
    const ss = grid(100, 4, (b) => b);
    const { ctx } = ctxOfWidth(400);
    expect(decimateHeat(ss, xOver(100, 200), ctx, 2)).toBeNull();
  });

  it('declines when the context has no measurable width', () => {
    // A headless test ctx — decimating would divide by a zero column count.
    const ss = grid(10_000, 4, (b) => b);
    const { ctx } = recordingContext();
    expect(decimateHeat(ss, xOver(10_000, 200), ctx, 2)).toBeNull();
  });

  it('reduces to one column per device pixel, keeping every row', () => {
    const ss = grid(10_000, 5, (b) => b);
    const { ctx } = ctxOfWidth(100);
    const out = decimateHeat(ss, xOver(10_000, 100), ctx, 2)!;
    expect(out).not.toBeNull();
    expect(out.length).toBe(100);
    expect(out.groups).toEqual(ss.groups);
    expect(out.values.length).toBe(100 * 5);
  });

  it('takes the MEAN of the cells in a column, not one of them', () => {
    // 400 bins into 4 columns ⇒ 100 source bins each. Row g holds `b`, so
    // column 0 averages 0..99 = 49.5, column 1 averages 100..199 = 149.5, …
    // Last-wins would give 99 / 199 / …; first-wins 0 / 100 / …; max 99 / 199.
    // Only the mean lands on these numbers.
    const ss = grid(400, 2, (b) => b);
    const { ctx } = ctxOfWidth(4);
    const out = decimateHeat(ss, xOver(400, 4), ctx, 2)!;
    const row0 = [0, 1, 2, 3].map((c) => out.values[c * 2]);
    expect(row0).toEqual([49.5, 149.5, 249.5, 349.5]);
  });

  it('averages each row independently', () => {
    // Row 1 is row 0 plus 1000, so the rows must not bleed into each other.
    const ss = grid(400, 2, (b, g) => b + g * 1000);
    const { ctx } = ctxOfWidth(4);
    const out = decimateHeat(ss, xOver(400, 4), ctx, 2)!;
    expect(out.values[0]).toBe(49.5);
    expect(out.values[1]).toBe(1049.5);
  });

  it('lets holes contribute nothing rather than dragging the mean down', () => {
    // Half the cells are holes. Treating a hole as 0 would halve the mean; the
    // right answer is the mean of the values that exist.
    const ss = grid(400, 1, (b) => (b % 2 === 0 ? NaN : 10));
    const { ctx } = ctxOfWidth(4);
    const out = decimateHeat(ss, xOver(400, 4), ctx, 2)!;
    expect([...out.values]).toEqual([10, 10, 10, 10]);
  });

  it('keeps a column of nothing but holes a hole', () => {
    // Otherwise 0/0 would surface as a drawn cell in the ramp's bottom band —
    // a hole in the record reading as a real low value.
    const ss = grid(400, 1, (b) => (b < 100 ? NaN : 10));
    const { ctx } = ctxOfWidth(4);
    const out = decimateHeat(ss, xOver(400, 4), ctx, 2)!;
    expect(Number.isNaN(out.values[0]!)).toBe(true);
    expect(out.values[1]).toBe(10);
  });

  it('carries no marks — a pixel column has no source-bin identity', () => {
    const ss = grid(10_000, 3, (b) => b);
    const { ctx } = ctxOfWidth(100);
    expect(decimateHeat(ss, xOver(10_000, 100), ctx, 2)!.marks).toBeUndefined();
  });
});

describe('drawHeat with decimation', () => {
  const draw = (ss: StackedBarSeries, width: number, decimate = true) => {
    const { ctx, calls } = ctxOfWidth(width);
    drawHeat(
      ctx,
      ss,
      xOver(ss.length, width / 2),
      scaleLinear().domain([0, ss.groups.length]).range([100, 0]),
      { opacity: 1, highlight: '#fff', outlineWidth: 1, gap: 0, minWidth: 1 },
      (v: number) => bandedColor(v, RAMP, 0, 400),
      'heat',
      null,
      { id: 'heat', key: 0, label: 'r0' },
      decimate,
    );
    return calls;
  };

  it('draws one rect per column per row instead of one per source cell', () => {
    const ss = grid(4000, 3, (b) => b);
    const thinned = draw(ss, 100).filter((c) => c.name === 'fillRect').length;
    const full = draw(ss, 100, false).filter(
      (c) => c.name === 'fillRect',
    ).length;
    expect(thinned).toBe(100 * 3);
    expect(full).toBe(4000 * 3);
  });

  it('suppresses the live-cell outline while decimated', () => {
    // A hovered mark is passed in both cases. Undecimated it outlines a cell;
    // decimated there is no per-bin identity to match, and a sub-pixel ring
    // would not be visible anyway.
    const ss = grid(4000, 3, (b) => b);
    expect(draw(ss, 100).filter((c) => c.name === 'strokeRect')).toHaveLength(
      0,
    );
    expect(
      draw(ss, 100, false).filter((c) => c.name === 'strokeRect').length,
    ).toBeGreaterThan(0);
  });

  it('leaves a sparse grid completely alone', () => {
    // Below the gate, `decimate: true` must be byte-identical to `false` —
    // the default cannot quietly change what an ordinary chart draws.
    const ss = grid(20, 3, (b) => b * 20);
    expect(draw(ss, 400)).toEqual(draw(ss, 400, false));
  });
});
