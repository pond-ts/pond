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
  gridColor: '#ccc',
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
    selection: readonly { id: string; key: number; label: string }[] = [],
    hovered: readonly { id: string; key: number; label: string }[] = [],
  ) => {
    const { ctx, calls } = recordingContext();
    drawHeat(
      ctx,
      ss,
      identity,
      identity,
      style,
      (value: number) => bandedColor(value, RAMP, 0, 4),
      'heat',
      selection,
      hovered,
      // These fixtures are two bins wide against a headless ctx with no canvas
      // width, so decimation never engages — but pin it off so a future change
      // to the gate cannot quietly rewrite what these assertions are reading.
      false,
    );
    return calls;
  };

  /**
   * The fill **in effect** at each `fillRect`, by replaying the call stream.
   *
   * Not `calls.filter(fillStyle).map(...)`: `drawHeat` sets `fillStyle` only
   * when it changes, since a real canvas parses the CSS colour on every
   * assignment and a banded ramp emits long runs of one string. Counting writes
   * would pin that optimization rather than the guarantee, which is that every
   * cell is painted in its own band's colour.
   */
  const fillsDrawn = (calls: ReturnType<typeof draw>): string[] => {
    let current: string | undefined;
    const out: string[] = [];
    for (const c of calls) {
      if (c.type === 'set' && c.name === 'fillStyle')
        current = c.args[0] as string;
      else if (c.name === 'fillRect' && current !== undefined)
        out.push(current);
    }
    return out;
  };

  it('fills every cell of the grid, banded across the ramp', () => {
    // bin0: 0,2,4 → a,c,d ; bin1: 1,3,4 → b,d,d
    expect(fillsDrawn(draw(two3()))).toEqual([
      '#a',
      '#c',
      '#d',
      '#b',
      '#d',
      '#d',
    ]);
  });

  it('skips gap cells without disturbing their neighbours', () => {
    const ss = grid([0, 10], [10, 20], ['lo', 'hi'], [0, NaN, 4, 4]);
    expect(draw(ss).filter((c) => c.name === 'fillRect')).toHaveLength(3);
  });

  it('outlines the selected cell and keeps its own colour', () => {
    // The colour is the datum — swapping it would erase the reading.
    const calls = draw(two3(), [{ id: 'heat', key: 0, label: 'mid' }]);
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
    expect(fillsDrawn(calls)).toEqual(['#a', '#c', '#d', '#b', '#d', '#d']);
  });

  it('outlines the HOVERED cell too, more lightly than a selected one', () => {
    // A bar says "live" by popping alpha; a heat cell cannot, because its fill
    // is the datum. Without a stroke, hover on a full-opacity ramp is invisible
    // — which is what the Nino 3.4 grid surfaced. Weight is what separates the
    // two states, since they share `highlight` (see #577).
    const hov = draw(two3(), [], [{ id: 'heat', key: 0, label: 'mid' }]);
    const hovStrokes = hov.filter((c) => c.name === 'strokeRect');
    expect(hovStrokes).toHaveLength(1);

    const sel = draw(two3(), [{ id: 'heat', key: 0, label: 'mid' }]);
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
    // A rect call's four args, as a tuple — `args` is `unknown[]`, and a plain
    // `as number[]` still indexes to `number | undefined` under
    // `noUncheckedIndexedAccess`, which will not take arithmetic.
    const rectOf = (c: { args: unknown[] }) =>
      c.args as [number, number, number, number];

    const w = style.outlineWidth;
    const stroke = rectOf(
      draw(two3(), [], [{ id: 'heat', key: 0, label: 'lo' }])
        .filter((c) => c.name === 'strokeRect')
        .pop()!,
    );
    const [fx, fy, fw, fh] = rectOf(
      draw(two3())
        .filter((c) => c.name === 'fillRect')
        .find((c) => rectOf(c)[1] === stroke[1] - w / 2)!,
    );
    expect(stroke).toEqual([fx + w / 2, fy + w / 2, fw - w, fh - w]);
  });

  it('identifies a cell by bin AND row, not bin alone', () => {
    // Same key, different row → a different cell. This is what makes the
    // grid's selection two-dimensional.
    expect(
      draw(two3(), [{ id: 'heat', key: 0, label: 'nope' }]).filter(
        (c) => c.name === 'strokeRect',
      ),
    ).toHaveLength(0);
  });

  it('pops only the live cell to full opacity', () => {
    const alphas = draw(two3(), [], [{ id: 'heat', key: 10, label: 'lo' }])
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
    const calls = draw(two3(), [{ id: 'other', key: 0, label: 'mid' }]);
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
  });

  // ── Plural selection / hover ([PND-MULTISEL] / RFC A4.3) ──
  //
  // `ContainerFrame.selected` has been a set since #606 and `hovered` since
  // #616, and `drawHeat` took a single mark of each until #620 — so every
  // member past the first was silently dropped. `strokeRect` is emitted only
  // for a live cell, so its count is exactly "how many cells lit", and the live
  // `lineWidth` says which state each one is in (`outlineWidth` hovered, twice
  // that selected).
  /** The `lineWidth` in effect at each `strokeRect`, by replaying the stream. */
  const outlineWidths = (calls: ReturnType<typeof draw>): unknown[] => {
    const out: unknown[] = [];
    let w: unknown;
    for (const c of calls) {
      if (c.type === 'set' && c.name === 'lineWidth') w = c.args[0];
      else if (c.name === 'strokeRect') out.push(w);
    }
    return out;
  };

  it('outlines EVERY selected cell, not just the first', () => {
    const calls = draw(two3(), [
      { id: 'heat', key: 0, label: 'lo' },
      { id: 'heat', key: 0, label: 'hi' },
      { id: 'heat', key: 10, label: 'mid' },
    ]);
    expect(outlineWidths(calls)).toEqual([
      style.outlineWidth * 2,
      style.outlineWidth * 2,
      style.outlineWidth * 2,
    ]);
  });

  it('outlines EVERY hovered cell, at the lighter hover weight', () => {
    const calls = draw(
      two3(),
      [],
      [
        { id: 'heat', key: 0, label: 'mid' },
        { id: 'heat', key: 10, label: 'mid' },
      ],
    );
    expect(outlineWidths(calls)).toEqual([
      style.outlineWidth,
      style.outlineWidth,
    ]);
  });

  it('draws one outline for a cell in BOTH sets — selected outranks hovered', () => {
    const calls = draw(
      two3(),
      [{ id: 'heat', key: 0, label: 'mid' }],
      [
        { id: 'heat', key: 0, label: 'mid' },
        { id: 'heat', key: 10, label: 'hi' },
      ],
    );
    // Two lit cells, not three strokes: the doubly-live cell takes the selected
    // weight once rather than stacking a hover stroke under it.
    expect(outlineWidths(calls)).toEqual([
      style.outlineWidth * 2,
      style.outlineWidth,
    ]);
  });

  it('ignores members of either set that name another layer', () => {
    const calls = draw(
      two3(),
      [
        { id: 'other', key: 0, label: 'lo' },
        { id: 'heat', key: 0, label: 'hi' },
      ],
      [{ id: 'other', key: 10, label: 'mid' }],
    );
    // A mixed-layer set must not leak across layers just because a key and a
    // row name happen to coincide.
    expect(outlineWidths(calls)).toEqual([style.outlineWidth * 2]);
  });

  it('pops every live cell to full opacity, not only the first', () => {
    const alphas = draw(
      two3(),
      [{ id: 'heat', key: 0, label: 'lo' }],
      [{ id: 'heat', key: 10, label: 'hi' }],
    )
      .filter((c) => c.type === 'set' && c.name === 'globalAlpha')
      .map((c) => c.args[0]);
    // Leading save-bracket alpha, then one per cell: bin0/'lo' is cell 0 and
    // bin1/'hi' cell 5.
    expect(alphas).toEqual([
      style.opacity,
      1,
      style.opacity,
      style.opacity,
      style.opacity,
      style.opacity,
      1,
    ]);
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

describe('orientation="horizontal" transposes and nothing else', () => {
  // A heat map has two POSITION axes and no value axis, which is what makes its
  // transpose a relabelling rather than a reworking: the same bin span and the
  // same unit slots, swapped over which one runs across the canvas.
  const twoBinsThreeRows = () =>
    grid([0, 10], [10, 20], ['lo', 'mid', 'hi'], [0, 2, 4, 1, 3, 4]);

  const rectsOf = (orientation: 'vertical' | 'horizontal') => {
    const { ctx, calls } = recordingContext();
    drawHeat(
      ctx,
      twoBinsThreeRows(),
      identity,
      identity,
      style,
      (v: number) => bandedColor(v, RAMP, 0, 4),
      'heat',
      [],
      [],
      false,
      orientation,
    );
    return calls
      .filter((c) => c.name === 'fillRect')
      .map((c) => c.args as unknown as [number, number, number, number]);
  };

  it('swaps each cell rect across the diagonal', () => {
    const v = rectsOf('vertical');
    const h = rectsOf('horizontal');
    expect(h).toHaveLength(v.length);
    for (let i = 0; i < v.length; i += 1) {
      const [x, y, w, hh] = v[i]!;
      expect(h[i]).toEqual([y, x, hh, w]);
    }
  });

  it('draws exactly the same cells, in the same order', () => {
    // The transpose is geometry only — the value grid is not re-walked, so a
    // gap stays a gap and the fills are identical.
    const fills = (orientation: 'vertical' | 'horizontal') => {
      const { ctx, calls } = recordingContext();
      drawHeat(
        ctx,
        twoBinsThreeRows(),
        identity,
        identity,
        style,
        (v: number) => bandedColor(v, RAMP, 0, 4),
        'heat',
        [],
        [],
        false,
        orientation,
      );
      return calls
        .filter((c) => c.type === 'set' && c.name === 'fillStyle')
        .map((c) => c.args[0]);
    };
    expect(fills('horizontal')).toEqual(fills('vertical'));
  });

  it('hit-tests the transposed geometry', () => {
    const ss = twoBinsThreeRows();
    // Vertical: x is the bin (5 -> bin 0), y is the row slot (2.5 -> 'hi').
    expect(heatAt(ss, 5, 2.5, identity, identity, 0, 1)?.[3]).toBe('hi');
    // Horizontal: the same cell is found with the coordinates swapped.
    expect(
      heatAt(ss, 2.5, 5, identity, identity, 0, 1, 'horizontal')?.[3],
    ).toBe('hi');
    // …and the un-swapped point now misses, since 5 is past three unit slots.
    expect(
      heatAt(ss, 5, 2.5, identity, identity, 0, 1, 'horizontal'),
    ).toBeNull();
  });
});

describe('scale="log" — equal-ratio bands', () => {
  // The case this exists for: incidence spanning ~2900 down to 0. Linear
  // banding over 4 colours puts everything below 725 in one band, which on the
  // measles grid is the entire post-1965 record.
  const RAMP4 = ['#a', '#b', '#c', '#d'];
  const band = (v: number, scale?: 'linear' | 'log') =>
    bandedColor(v, RAMP4, 0, 2900, scale);

  it('linear banding collapses four orders of magnitude into one band', () => {
    expect([0, 1, 10, 100, 700].map((v) => band(v))).toEqual([
      '#a',
      '#a',
      '#a',
      '#a',
      '#a',
    ]);
  });

  it('log banding separates them', () => {
    const got = [0, 1, 10, 100, 700].map((v) => band(v, 'log'));
    expect(new Set(got).size).toBeGreaterThan(1);
    // Monotonic: a bigger value never lands in an earlier band.
    const idx = got.map((c) => RAMP4.indexOf(c!));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it('puts a value AT the floor in a real band, not off the scale', () => {
    // `log(0)` is -Infinity; banding on `log1p` of the offset is what keeps the
    // zeros — which on an eliminated-disease grid are most of the cells.
    expect(band(0, 'log')).toBe('#a');
  });

  it('still clamps past either end of a pinned domain', () => {
    expect(band(-50, 'log')).toBe('#a');
    expect(band(99999, 'log')).toBe('#d');
  });

  it('agrees with linear at the domain endpoints', () => {
    for (const v of [0, 2900]) expect(band(v, 'log')).toBe(band(v));
  });
});

describe('noData="hatch"', () => {
  const holed = () => grid([0, 10], [10, 20], ['lo', 'hi'], [NaN, 4, 1, 2]);
  const draw = (noData: 'blank' | 'hatch') => {
    const { ctx, calls } = recordingContext();
    drawHeat(
      ctx,
      holed(),
      identity,
      identity,
      style,
      (v: number) => bandedColor(v, RAMP, 0, 4),
      'heat',
      [],
      [],
      false,
      'vertical',
      noData,
    );
    return calls;
  };

  it('draws nothing for a hole by default', () => {
    const c = draw('blank');
    expect(c.filter((x) => x.name === 'fillRect')).toHaveLength(3);
    expect(c.filter((x) => x.name === 'stroke')).toHaveLength(0);
  });

  it('strokes the hole when asked, without filling it', () => {
    // Filling would put a colour on the cell, and any colour can be read as a
    // value. Hatching cannot.
    const c = draw('hatch');
    expect(c.filter((x) => x.name === 'fillRect')).toHaveLength(3);
    expect(c.filter((x) => x.name === 'stroke').length).toBeGreaterThan(0);
    expect(c.filter((x) => x.name === 'clip').length).toBe(1);
  });

  it('hatches in the grid colour, not the ramp', () => {
    const strokes = draw('hatch')
      .filter((x) => x.type === 'set' && x.name === 'strokeStyle')
      .map((x) => x.args[0]);
    expect(strokes).toContain(style.gridColor);
    expect(strokes.some((s) => RAMP.includes(s as string))).toBe(false);
  });
});
