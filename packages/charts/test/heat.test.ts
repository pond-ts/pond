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
import type { BarSeries } from '../src/data.js';

/** Cells from parallel begin/end/value arrays. */
const cells = (begin: number[], end: number[], v: number[]): BarSeries => ({
  begin: Float64Array.from(begin),
  end: Float64Array.from(end),
  y: Float64Array.from(v),
  length: begin.length,
});

const identity = (v: number) => v;

/** A y scale that reports a plot band, as a real row's scale does. */
function yBand(lo: number, hi: number): (v: number) => number {
  const f = (v: number) => v;
  (f as unknown as { domain: () => number[] }).domain = () => [lo, hi];
  return f;
}

const style: HeatStyle = {
  opacity: 0.9,
  highlight: '#fff',
  outlineWidth: 2,
  gap: 0,
  minWidth: 1,
};

const RAMP = ['#a', '#b', '#c', '#d'];

describe('bandedColor', () => {
  it('splits the domain into equal bands, one per ramp stop', () => {
    // domain [0,4] over 4 colours → each band is 1 wide.
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
    // A pinned domain is narrower than the data on purpose; out-of-range
    // values must still read, at the extreme, rather than vanish.
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
  it('spans the finite values and does NOT widen to zero', () => {
    // Unlike barExtent: a cell's colour is read against the data's own range,
    // so pulling 0 in would waste half the ramp on an all-positive series.
    expect(heatValueExtent(cells([0, 1], [1, 2], [5, 9]))).toEqual([5, 9]);
  });

  it('ignores gaps', () => {
    expect(heatValueExtent(cells([0, 1, 2], [1, 2, 3], [5, NaN, 9]))).toEqual([
      5, 9,
    ]);
  });

  it('returns null when nothing is finite', () => {
    expect(heatValueExtent(cells([0], [1], [NaN]))).toBeNull();
  });
});

describe('cellRect', () => {
  it('fills the row band in y, whatever the value is', () => {
    // The defining difference from a bar: height carries no information.
    const a = cellRect(cells([0], [10], [1]), 0, identity, 0, 100, 0, 1);
    const b = cellRect(cells([0], [10], [99]), 0, identity, 0, 100, 0, 1);
    expect(a).toEqual([0, 10, 0, 100]);
    expect(b).toEqual(a); // same rect — only the colour differs
  });

  it('returns null for a gap, so a hole reads as a hole', () => {
    expect(
      cellRect(cells([0], [10], [NaN]), 0, identity, 0, 100, 0, 1),
    ).toBeNull();
  });

  it('insets by the gap', () => {
    const r = cellRect(cells([0], [10], [1]), 0, identity, 0, 100, 4, 1);
    expect([r?.[0], r?.[1]]).toEqual([2, 8]);
  });
});

describe('drawHeat', () => {
  const three = () => cells([0, 10, 20], [10, 20, 30], [0, 2, 4]);
  const draw = (
    cs: BarSeries,
    selection: { id: string; key: number } | null = null,
    hovered: { id: string; key: number } | null = null,
  ) => {
    const { ctx, calls } = recordingContext();
    drawHeat(
      ctx,
      cs,
      identity,
      yBand(0, 100),
      style,
      (i) => bandedColor(cs.y[i]!, RAMP, 0, 4),
      'heat',
      selection,
      hovered,
    );
    return calls;
  };

  it('fills one cell per value, banded across the ramp', () => {
    const fills = draw(three())
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .map((c) => c.args[0]);
    expect(fills).toEqual(['#a', '#c', '#d']);
  });

  it('skips a gap cell entirely — no fill, no zero-size rect', () => {
    const calls = draw(cells([0, 10, 20], [10, 20, 30], [0, NaN, 4]));
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(2);
  });

  it('cells tile the full plot height', () => {
    const rect = draw(three()).find((c) => c.name === 'fillRect');
    expect(rect?.args).toEqual([0, 0, 10, 100]); // y 0..100, the whole band
  });

  it('outlines the selected cell but keeps its own colour', () => {
    // The colour IS the datum — swapping it for a highlight would erase the
    // reading, so selection is signalled by the outline and full opacity.
    const calls = draw(three(), { id: 'heat', key: 10 });
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
    const fills = calls
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .map((c) => c.args[0]);
    expect(fills).toEqual(['#a', '#c', '#d']); // unchanged by the selection
  });

  it('pops the live cell to full opacity and restores the rest', () => {
    const alphas = draw(three(), null, { id: 'heat', key: 10 })
      .filter((c) => c.type === 'set' && c.name === 'globalAlpha')
      .map((c) => c.args[0]);
    expect(alphas).toEqual([style.opacity, style.opacity, 1, style.opacity]);
  });

  it('does not light a cell belonging to another layer id', () => {
    const calls = draw(three(), { id: 'other', key: 10 });
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
  });
});

describe('heatAt', () => {
  const three = () => cells([0, 10, 20], [10, 20, 30], [5, 6, 7]);

  it('reports the cell’s own value — the thing the bar workaround could not', () => {
    // A constant-height bar carries no value, so the stripes card looks the
    // number up out-of-band. A cell answers directly.
    expect(heatAt(three(), 15, 50, identity, yBand(0, 100), 0, 1)).toEqual([
      1, 10, 6,
    ]);
  });

  it('hits anywhere in the column, since the cell is the full height', () => {
    for (const py of [0, 1, 50, 99, 100]) {
      expect(heatAt(three(), 15, py, identity, yBand(0, 100), 0, 1)?.[0]).toBe(
        1,
      );
    }
  });

  it('gives a shared edge to the left cell', () => {
    expect(heatAt(three(), 10, 50, identity, yBand(0, 100), 0, 1)?.[0]).toBe(0);
  });

  it('misses outside the record', () => {
    expect(heatAt(three(), 31, 50, identity, yBand(0, 100), 0, 1)).toBeNull();
  });

  it('a gap cell owns no hit region', () => {
    const g = cells([0, 10, 20], [10, 20, 30], [5, NaN, 7]);
    expect(heatAt(g, 15, 50, identity, yBand(0, 100), 0, 1)).toBeNull();
    expect(heatAt(g, 5, 50, identity, yBand(0, 100), 0, 1)?.[0]).toBe(0);
  });
});
