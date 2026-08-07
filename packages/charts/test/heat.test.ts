import { describe, expect, it } from 'vitest';
import {
  bandedColor,
  cellRect,
  drawHeat,
  heatAt,
  heatValueExtent,
  type HeatStyle,
} from '../src/heat.js';
import { recordingContext } from './canvas-mock.js';
import type { StackedBarSeries } from '../src/data.js';

/**
 * A grid from bin spans, row names and a row-major value block. This is
 * `stacksFromColumns`' output shape — the heat map adds no reader, so the tests
 * build the same thing by hand.
 */
const grid = (
  begin: number[],
  end: number[],
  groups: string[],
  values: number[],
): StackedBarSeries => ({
  begin: Float64Array.from(begin),
  end: Float64Array.from(end),
  groups,
  values: Float64Array.from(values),
  length: begin.length,
});

const identity = (v: number) => v;

const style: HeatStyle = {
  opacity: 0.9,
  highlight: '#fff',
  outlineWidth: 2,
  gap: 0,
  minWidth: 1,
};

const RAMP = ['#a', '#b', '#c', '#d'];

/** Two bins × three rows. values[b * 3 + g]. */
const two3 = () =>
  grid([0, 10], [10, 20], ['lo', 'mid', 'hi'], [0, 2, 4, 1, 3, 4]);

describe('bandedColor', () => {
  it('splits the domain into equal bands, one per ramp stop', () => {
    expect(bandedColor(0.5, RAMP, 0, 4)).toBe('#a');
    expect(bandedColor(1.5, RAMP, 0, 4)).toBe('#b');
    expect(bandedColor(2.5, RAMP, 0, 4)).toBe('#c');
    expect(bandedColor(3.5, RAMP, 0, 4)).toBe('#d');
  });

  it('puts both domain endpoints inside the ramp, not past it', () => {
    // The top endpoint is the trap: t === 1 indexes one past the last stop.
    expect(bandedColor(0, RAMP, 0, 4)).toBe('#a');
    expect(bandedColor(4, RAMP, 0, 4)).toBe('#d');
  });

  it('clamps values outside a pinned domain to the end bands', () => {
    // A pinned domain is often narrower than the data; out-of-range values
    // must read at the extreme rather than vanish.
    expect(bandedColor(-99, RAMP, 0, 4)).toBe('#a');
    expect(bandedColor(99, RAMP, 0, 4)).toBe('#d');
  });

  it('collapses a degenerate domain to a single band', () => {
    expect(bandedColor(7, RAMP, 7, 7)).toBe('#d');
  });

  it('yields undefined for a gap or an empty ramp', () => {
    expect(bandedColor(NaN, RAMP, 0, 4)).toBeUndefined();
    expect(bandedColor(1, [], 0, 4)).toBeUndefined();
  });
});

describe('heatValueExtent', () => {
  it('spans the whole grid, so every row shares one scale', () => {
    // Not per-row: rows are only comparable to each other if one domain
    // covers them all.
    expect(heatValueExtent(two3())).toEqual([0, 4]);
  });

  it('does NOT widen to zero, unlike a bar extent', () => {
    // A cell's colour is read against the data's own range; pulling 0 in
    // would waste part of the ramp on an all-positive grid.
    expect(heatValueExtent(grid([0], [1], ['r'], [5]))).toEqual([5, 5]);
  });

  it('ignores gaps, and is null when nothing is finite', () => {
    expect(heatValueExtent(grid([0, 1], [1, 2], ['r'], [5, NaN]))).toEqual([
      5, 5,
    ]);
    expect(heatValueExtent(grid([0], [1], ['r'], [NaN]))).toBeNull();
  });
});

describe('cellRect', () => {
  it('gives each row its own unit slot in y', () => {
    const ss = two3();
    // Row g occupies [g, g+1] through the y scale.
    expect(cellRect(ss, 0, 0, identity, identity, 0, 1)).toEqual([0, 10, 0, 1]);
    expect(cellRect(ss, 0, 1, identity, identity, 0, 1)).toEqual([0, 10, 1, 2]);
    expect(cellRect(ss, 0, 2, identity, identity, 0, 1)).toEqual([0, 10, 2, 3]);
  });

  it('shares the bin span across every row', () => {
    const ss = two3();
    const a = cellRect(ss, 1, 0, identity, identity, 0, 1);
    const b = cellRect(ss, 1, 2, identity, identity, 0, 1);
    expect([a?.[0], a?.[1]]).toEqual([10, 20]);
    expect([b?.[0], b?.[1]]).toEqual([a?.[0], a?.[1]]); // same column
  });

  it('returns null for a gap, so a hole reads as a hole', () => {
    const ss = grid([0], [10], ['r'], [NaN]);
    expect(cellRect(ss, 0, 0, identity, identity, 0, 1)).toBeNull();
  });

  it('insets by the gap in both axes', () => {
    // A realistic y scale: one unit slot per row, 100px tall. (With a 1:1
    // scale a row is a single pixel and the floor below refuses to inset it.)
    const tall = (v: number) => v * 100;
    const ss = grid([0], [100], ['r'], [1]);
    const r = cellRect(ss, 0, 0, identity, tall, 20, 1);
    expect([r?.[0], r?.[1]]).toEqual([10, 90]); // x span inset 10 each side
    expect([r?.[2], r?.[3]]).toEqual([10, 90]); // row band likewise
  });

  it('refuses to inset a row thinner than a pixel', () => {
    // The floor that made the test above need a real scale: a 1px row keeps
    // its pixel rather than vanishing into the gap.
    const ss = grid([0], [10], ['r'], [1]);
    expect(cellRect(ss, 0, 0, identity, identity, 4, 1)?.slice(2)).toEqual([
      0, 1,
    ]);
  });

  it('never lets the y gap collapse a row to nothing', () => {
    // A gap wider than the row would invert the rect; it clamps instead.
    const ss = grid([0], [10], ['r'], [1]);
    const r = cellRect(ss, 0, 0, identity, identity, 50, 1);
    expect(r![3]).toBeGreaterThan(r![2]);
  });
});

describe('drawHeat', () => {
  const draw = (
    ss: StackedBarSeries,
    selection: { id: string; key: number; label: string } | null = null,
    hovered: { id: string; key: number; label: string } | null = null,
  ) => {
    const { ctx, calls } = recordingContext();
    drawHeat(
      ctx,
      ss,
      identity,
      identity,
      style,
      (b, g) => bandedColor(ss.values[b * ss.groups.length + g]!, RAMP, 0, 4),
      'heat',
      selection,
      hovered,
    );
    return calls;
  };

  it('fills every cell of the grid, banded across the ramp', () => {
    const fills = draw(two3())
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .map((c) => c.args[0]);
    // bin0: 0,2,4 → a,c,d ; bin1: 1,3,4 → b,d,d
    expect(fills).toEqual(['#a', '#c', '#d', '#b', '#d', '#d']);
  });

  it('skips gap cells without disturbing their neighbours', () => {
    const ss = grid([0, 10], [10, 20], ['lo', 'hi'], [0, NaN, 4, 4]);
    expect(draw(ss).filter((c) => c.name === 'fillRect')).toHaveLength(3);
  });

  it('outlines the selected cell and keeps its own colour', () => {
    // The colour is the datum — swapping it would erase the reading.
    const calls = draw(two3(), { id: 'heat', key: 0, label: 'mid' });
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
    const fills = calls
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .map((c) => c.args[0]);
    expect(fills).toEqual(['#a', '#c', '#d', '#b', '#d', '#d']);
  });

  it('outlines the HOVERED cell too, more lightly than a selected one', () => {
    // A bar says "live" by popping alpha; a heat cell cannot, because its fill
    // is the datum. Without a stroke, hover on a full-opacity ramp is invisible
    // — which is what the Nino 3.4 grid surfaced. Weight is what separates the
    // two states, since they share `highlight` (see #577).
    const hov = draw(two3(), null, { id: 'heat', key: 0, label: 'mid' });
    const hovStrokes = hov.filter((c) => c.name === 'strokeRect');
    expect(hovStrokes).toHaveLength(1);

    const sel = draw(two3(), { id: 'heat', key: 0, label: 'mid' });
    const selStrokes = sel.filter((c) => c.name === 'strokeRect');
    expect(selStrokes).toHaveLength(1);

    const widthOf = (calls: ReturnType<typeof draw>) =>
      calls.filter((c) => c.type === 'set' && c.name === 'lineWidth').pop()
        ?.args[0] as number;
    expect(widthOf(hov)).toBe(style.outlineWidth);
    expect(widthOf(sel)).toBe(style.outlineWidth * 2);
  });

  it('insets the outline so it cannot bleed onto the neighbouring cell', () => {
    // On a flush grid (`gap: 0`) a centred stroke would straddle the shared
    // edge and paint over half of the next cell — misreporting its colour.
    const w = style.outlineWidth;
    const stroke = draw(two3(), null, { id: 'heat', key: 0, label: 'lo' })
      .filter((c) => c.name === 'strokeRect')
      .pop()!;
    const cell = draw(two3())
      .filter((c) => c.name === 'fillRect')
      .find((c) => c.args[1] === stroke.args[1] - w / 2)!;
    const [fx, fy, fw, fh] = cell.args as number[];
    expect(stroke.args).toEqual([fx + w / 2, fy + w / 2, fw - w, fh - w]);
  });

  it('identifies a cell by bin AND row, not bin alone', () => {
    // Same key, different row → a different cell. This is what makes the
    // grid's selection two-dimensional.
    expect(
      draw(two3(), { id: 'heat', key: 0, label: 'nope' }).filter(
        (c) => c.name === 'strokeRect',
      ),
    ).toHaveLength(0);
  });

  it('pops only the live cell to full opacity', () => {
    const alphas = draw(two3(), null, { id: 'heat', key: 10, label: 'lo' })
      .filter((c) => c.type === 'set' && c.name === 'globalAlpha')
      .map((c) => c.args[0]);
    // Leading save-bracket alpha, then one per cell; bin1/'lo' is cell index 3.
    expect(alphas).toEqual([
      style.opacity,
      style.opacity,
      style.opacity,
      style.opacity,
      1,
      style.opacity,
      style.opacity,
    ]);
  });

  it('does not light a cell belonging to another layer id', () => {
    const calls = draw(two3(), { id: 'other', key: 0, label: 'mid' });
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
  });
});

describe('heatAt', () => {
  it('reports the cell’s bin, row, name and value', () => {
    // The value is the whole point: a constant-height bar carries none, which
    // is why the stripes workaround looks its number up out-of-band.
    expect(heatAt(two3(), 5, 1.5, identity, identity, 0, 1)).toEqual([
      0,
      1,
      0,
      'mid',
      2,
    ]);
  });

  it('distinguishes rows within one column', () => {
    const ss = two3();
    expect(heatAt(ss, 5, 0.5, identity, identity, 0, 1)?.[3]).toBe('lo');
    expect(heatAt(ss, 5, 2.5, identity, identity, 0, 1)?.[3]).toBe('hi');
  });

  it('misses outside the grid on either axis', () => {
    const ss = two3();
    expect(heatAt(ss, 25, 1.5, identity, identity, 0, 1)).toBeNull(); // past x
    expect(heatAt(ss, 5, 3.5, identity, identity, 0, 1)).toBeNull(); // past y
  });

  it('a gap cell owns no hit region, but its neighbours do', () => {
    const ss = grid([0], [10], ['lo', 'hi'], [NaN, 4]);
    expect(heatAt(ss, 5, 0.5, identity, identity, 0, 1)).toBeNull();
    expect(heatAt(ss, 5, 1.5, identity, identity, 0, 1)?.[3]).toBe('hi');
  });

  it('a single-column grid is just a stripe', () => {
    // G === 1 is the same path, not a special case.
    const ss = grid([0, 10], [10, 20], ['v'], [3, 7]);
    expect(heatAt(ss, 15, 0.5, identity, identity, 0, 1)).toEqual([
      1,
      0,
      10,
      'v',
      7,
    ]);
  });
});
