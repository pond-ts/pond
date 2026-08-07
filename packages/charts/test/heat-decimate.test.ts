import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import { decimateHeat, decimateHeatRows } from '../src/decimate.js';
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
      {
        opacity: 1,
        highlight: '#fff',
        outlineWidth: 1,
        gap: 0,
        minWidth: 1,
        gridColor: '#ccc',
      },
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

describe('decimateHeatRows — the y half', () => {
  /** `bins × rows` row-major, value = the row index, so a mean over a stride is
   *  the mean of the row indices it covers and nothing else can fake it. */
  const byRow = (bins: number, rows: number) => {
    const v = new Float64Array(bins * rows);
    for (let b = 0; b < bins; b += 1)
      for (let g = 0; g < rows; g += 1) v[b * rows + g] = g;
    return v;
  };

  it('declines when there is a device row per source row', () => {
    expect(decimateHeatRows(byRow(4, 100), 4, 100, 600, 2)).toBeNull();
    expect(decimateHeatRows(byRow(4, 100), 4, 100, 100, 2)).toBeNull();
  });

  it('fires once a device row holds k source rows', () => {
    expect(decimateHeatRows(byRow(4, 100), 4, 100, 50, 2)).not.toBeNull();
  });

  it('averages the rows in each stride', () => {
    // 100 rows into 10 device rows ⇒ stride 10. Row 0 covers source 0..9 (mean
    // 4.5), row 1 covers 10..19 (14.5). First-wins would give 0/10, last 9/19.
    const out = decimateHeatRows(byRow(2, 100), 2, 100, 10, 2)!;
    expect(out.stride).toBe(10);
    expect(out.rows).toBe(10);
    expect(out.values[0]).toBe(4.5);
    expect(out.values[1]).toBe(14.5);
  });

  it('keeps bins independent', () => {
    const v = byRow(2, 100);
    for (let g = 0; g < 100; g += 1) v[100 + g] = 1000 + g;
    const out = decimateHeatRows(v, 2, 100, 10, 2)!;
    expect(out.values[0]).toBe(4.5);
    expect(out.values[out.rows]).toBe(1004.5);
  });

  it('averages a short final run over what is actually there', () => {
    // Averaging the tail over a full stride would drag it toward zero.
    const out = decimateHeatRows(byRow(1, 25), 1, 25, 3, 2)!;
    expect(out.rows).toBe(Math.ceil(25 / out.stride));
    const g0 = (out.rows - 1) * out.stride;
    let sum = 0;
    for (let g = g0; g < 25; g += 1) sum += g;
    expect(out.values[out.rows - 1]).toBeCloseTo(sum / (25 - g0), 10);
  });

  it('lets holes contribute nothing, and keeps an all-hole run a hole', () => {
    const v = new Float64Array(20);
    for (let g = 0; g < 20; g += 1) v[g] = g < 10 ? NaN : 7;
    const out = decimateHeatRows(v, 1, 20, 2, 2)!;
    expect(Number.isNaN(out.values[0]!)).toBe(true);
    expect(out.values[1]).toBe(7);
  });
});

describe('y decimation leaves the coordinate space alone', () => {
  // The guarantee that matters most. `<YAxis>` scales over `[0, G]` and explicit
  // `{ at, label }` ticks are in those units, so a reduction that rewrote the row
  // bands the way the x half rewrites bin spans would slide every axis label.
  const drawRows = (rows: number, decimate: boolean) => {
    const ss = grid(4, rows, (_b, g) => g);
    const { ctx, calls } = ctxOfWidth(8);
    drawHeat(
      ctx,
      ss,
      xOver(4, 4),
      scaleLinear().domain([0, rows]).range([300, 0]),
      {
        opacity: 1,
        highlight: '#fff',
        outlineWidth: 1,
        gap: 0,
        minWidth: 1,
        gridColor: '#ccc',
      },
      (v: number) => bandedColor(v, RAMP, 0, rows),
      'heat',
      null,
      null,
      decimate,
    );
    const rects = calls
      .filter((c) => c.name === 'fillRect')
      .map((c) => c.args as unknown as [number, number, number, number]);
    return {
      n: rects.length,
      top: Math.min(...rects.map((r) => r[1])),
      bottom: Math.max(...rects.map((r) => r[1] + r[3])),
    };
  };

  it('spans exactly the same pixels, with far fewer rects', () => {
    const thin = drawRows(2000, true);
    const full = drawRows(2000, false);
    expect(thin.n).toBeLessThan(full.n / 2);
    expect(thin.top).toBeCloseTo(full.top, 6);
    expect(thin.bottom).toBeCloseTo(full.bottom, 6);
  });

  it('tiles without gaps or overlaps between reduced rows', () => {
    // Each band must start where the previous ended, or the grid grows hairlines
    // the source data does not have.
    const ss = grid(1, 2000, (_b, g) => g);
    const { ctx, calls } = ctxOfWidth(8);
    drawHeat(
      ctx,
      ss,
      xOver(1, 4),
      scaleLinear().domain([0, 2000]).range([300, 0]),
      {
        opacity: 1,
        highlight: '#fff',
        outlineWidth: 1,
        gap: 0,
        minWidth: 1,
        gridColor: '#ccc',
      },
      () => '#a',
      'heat',
      null,
      null,
      true,
    );
    const rects = calls
      .filter((c) => c.name === 'fillRect')
      .map((c) => c.args as unknown as [number, number, number, number])
      .sort((a, b) => a[1] - b[1]);
    expect(rects.length).toBeGreaterThan(1);
    for (let i = 1; i < rects.length; i += 1) {
      expect(rects[i]![1]).toBeCloseTo(rects[i - 1]![1] + rects[i - 1]![3], 6);
    }
  });
});
