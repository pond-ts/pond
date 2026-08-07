import { describe, expect, it } from 'vitest';
import { scaleLinear } from 'd3-scale';
import {
  barAt,
  barExtent,
  barIndexAtTime,
  barRect,
  drawBars,
  drawStacks,
  resolveBarBaseline,
} from '../src/bars.js';
import { recordingContext, type CtxCall } from './canvas-mock.js';
import type { BarSeries, StackedBarSeries } from '../src/data.js';
import type { BarStyle } from '../src/theme.js';

/** A bar series from parallel begin/end/value arrays. */
const bars = (begin: number[], end: number[], y: number[]): BarSeries => ({
  begin: Float64Array.from(begin),
  end: Float64Array.from(end),
  y: Float64Array.from(y),
  length: begin.length,
});

const identity = (v: number) => v;
const style: BarStyle = {
  fill: '#abc',
  opacity: 0.85,
  highlight: '#fff',
  gap: 0,
  minWidth: 1,
  outlineWidth: 2,
};

/** A scale carrying a d3-style `.domain()`, for resolveBarBaseline. */
function scaleWithDomain(lo: number, hi: number): (v: number) => number {
  const f = (v: number) => v;
  (f as unknown as { domain: () => number[] }).domain = () => [lo, hi];
  return f;
}

describe('barExtent', () => {
  it('widens the value extent to include 0 (the baseline)', () => {
    // all-positive values → extent floored at 0 so bars rest on a visible line.
    expect(barExtent(bars([0, 1, 2], [1, 2, 3], [10, 20, 30]))).toEqual([
      0, 30,
    ]);
  });

  it('keeps a negative floor / positive ceiling when the data straddles 0', () => {
    expect(barExtent(bars([0, 1], [1, 2], [-5, 8]))).toEqual([-5, 8]);
  });

  it('floors an all-negative series at 0 (the baseline above it)', () => {
    expect(barExtent(bars([0, 1], [1, 2], [-30, -10]))).toEqual([-30, 0]);
  });

  it('ignores NaN (gap) values', () => {
    expect(barExtent(bars([0, 1, 2], [1, 2, 3], [10, NaN, 30]))).toEqual([
      0, 30,
    ]);
  });

  it('returns null when no value is finite', () => {
    expect(barExtent(bars([0, 1], [1, 2], [NaN, NaN]))).toBeNull();
  });
});

describe('resolveBarBaseline', () => {
  it('rests on the zero line when the domain spans 0', () => {
    expect(resolveBarBaseline(scaleWithDomain(0, 100))).toBe(0);
    expect(resolveBarBaseline(scaleWithDomain(-50, 50))).toBe(0);
  });

  it('rests on the axis floor when the domain sits above 0', () => {
    // explicit <YAxis min={10}> → no zero line in view; rest on the floor.
    expect(resolveBarBaseline(scaleWithDomain(10, 100))).toBe(10);
  });

  it('hangs from the axis top when the domain sits below 0', () => {
    expect(resolveBarBaseline(scaleWithDomain(-100, -10))).toBe(-10);
  });

  it('reads a descending [hi, lo] domain (range-flipped scale) the same way', () => {
    // a y pixel scale's domain is conventionally [lo, hi] with range [h,0]; guard
    // the normalization anyway so an inverted domain still clamps correctly.
    expect(resolveBarBaseline(scaleWithDomain(100, 10))).toBe(10);
  });

  it('falls back to 0 with no domain accessor', () => {
    expect(resolveBarBaseline(identity)).toBe(0);
  });
});

describe('barRect', () => {
  it('spans the key [begin,end] in x and value→baseline in y', () => {
    // value 30 with baseline 0, identity scales → rect x[0,2], y top=value(=30
    // here, identity) is below base(0) on screen? identity makes larger y lower,
    // so yTop = min(30, 0) = 0, yBottom = max = 30.
    const rect = barRect(bars([0], [2], [30]), 0, identity, identity, 0, 0, 1);
    expect(rect).toEqual([0, 2, 0, 30]);
  });

  it('normalizes y for a value below the baseline (negative bar)', () => {
    // value -10, baseline 0 → yTop=min(-10,0)=-10, yBottom=max=0.
    const rect = barRect(bars([0], [2], [-10]), 0, identity, identity, 0, 0, 1);
    expect(rect).toEqual([0, 2, -10, 0]);
  });

  it('insets the x-span by the gap', () => {
    const rect = barRect(bars([0], [10], [5]), 0, identity, identity, 0, 4, 1);
    expect(rect?.[0]).toBe(2);
    expect(rect?.[1]).toBe(8);
  });

  it('returns null for a gap (non-finite value)', () => {
    expect(
      barRect(bars([0], [2], [NaN]), 0, identity, identity, 0, 0, 1),
    ).toBeNull();
  });
});

describe('drawBars', () => {
  it('fills one rect per finite bar, skipping gaps', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1, 2], [1, 2, 3], [10, NaN, 30]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [],
      null,
    );
    // two finite bars → two fillRect; the NaN bar is skipped.
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(2);
    // bracketed by save/restore so the alpha doesn't leak.
    const names = calls.filter((c) => c.type === 'call').map((c) => c.name);
    expect(names[0]).toBe('save');
    expect(names[names.length - 1]).toBe('restore');
  });

  it('applies the fill colour + opacity', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0], [1], [10]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [],
      null,
    );
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'globalAlpha')?.args,
    ).toEqual([0.85]);
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'fillStyle')?.args,
    ).toEqual(['#abc']);
  });

  it('maps the rect through the scales (x*2, y flipped)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0], [10], [40]),
      (t) => t * 2,
      (v) => 100 - v,
      style,
      0, // baseline
      0,
      'count',
      [],
      null,
    );
    // x: [0*2, 10*2] = [0,20] → x0=0, width=20. y: value=100-40=60, base=100-0=100
    // → yTop=60, height=40.
    const fill = calls.find((c) => c.name === 'fillRect');
    expect(fill?.args).toEqual([0, 60, 20, 40]);
  });

  it('highlights + outlines the bar matching BOTH the series id and key', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1], [1, 2], [10, 20]),
      identity,
      identity,
      style,
      0,
      0,
      'count', // this layer's series id
      [{ key: 1, id: 'count' }], // selects the second bar of this series
      null,
    );
    // the highlighted bar fills with the highlight colour and gets a strokeRect.
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      true,
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
  });

  it('does NOT highlight a key match with a different series id (other series)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1], [1, 2], [10, 20]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [{ key: 1, id: 'other' }], // same key, different series id → no highlight
      null,
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      false,
    );
  });

  it('never highlights when the layer has no series id (display-only)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1], [1, 2], [10, 20]),
      identity,
      identity,
      style,
      0,
      0,
      undefined, // no id → not selectable
      [{ key: 1, id: 'count' }], // a selection exists, but this layer can't match
      { key: 1, id: 'count' },
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      false,
    );
  });

  it('highlights a hovered bar with fill only — no outline (that is select)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1], [1, 2], [10, 20]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [], // nothing selected
      { key: 1, id: 'count' }, // hover the second bar
    );
    // hovered bar fills with the highlight colour...
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      true,
    );
    // ...but is NOT outlined — the outline is reserved for the committed select.
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
  });

  it('outlines a bar that is both selected and hovered (select wins)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1], [1, 2], [10, 20]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [{ key: 1, id: 'count' }], // selected...
      { key: 1, id: 'count' }, // ...and hovered — the same bar
    );
    // highlight fill + the select outline (the select branch still draws it).
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      true,
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
  });
});

/**
 * The stable per-bar identity ({@link BarSeries.marks}) mirrored from the
 * stacked path onto single-series bars: a selection carrying a `mark` matches
 * on that name rather than on the bar's `begin` edge — which on a point-keyed
 * series is derived geometry, not the sample's own key.
 */
describe('drawBars — stable per-bar mark selection', () => {
  /** Three neighbour-spanned bars whose marks are the sample keys they came
   *  from (centres 100/200/300, edges 50/150/250 — as the reader derives them). */
  const marked = (): BarSeries => ({
    ...bars([50, 150, 250], [150, 250, 350], [10, 20, 30]),
    marks: ['100', '200', '300'],
  });

  /** Outline count = the number of bars drawn as *selected*. */
  const outlines = (calls: readonly CtxCall[]) =>
    calls.filter((c) => c.name === 'strokeRect').length;

  const draw = (
    cs: BarSeries,
    selection: { id: string; key: number; mark?: string } | null,
    hovered: { id: string; key: number; mark?: string } | null = null,
  ) => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      cs,
      identity,
      identity,
      style,
      0,
      0,
      'count',
      selection === null ? [] : [selection],
      hovered,
      false, // no decimation — the per-bar highlight path
    );
    return calls;
  };

  it('outlines the bar whose mark matches — the centre, not the begin edge', () => {
    // key 200 is the sample's own timestamp; the bar's `begin` there is 150.
    const calls = draw(marked(), { id: 'count', key: -1, mark: '200' });
    expect(outlines(calls)).toBe(1);
  });

  it('does not match a mark that is not present', () => {
    expect(
      outlines(draw(marked(), { id: 'count', key: -1, mark: '250' })),
    ).toBe(0);
  });

  it('does not match a mark from a different series id', () => {
    expect(
      outlines(draw(marked(), { id: 'other', key: -1, mark: '200' })),
    ).toBe(0);
  });

  it('follows the sample across a reorder of the underlying bars', () => {
    // The same selection {mark:'200'} lights exactly one bar wherever it sits —
    // it tracks the sample key, not the slot (the categorical stack's win).
    const reordered: BarSeries = {
      ...bars([250, 50, 150], [350, 150, 250], [30, 10, 20]),
      marks: ['300', '100', '200'],
    };
    expect(
      outlines(draw(reordered, { id: 'count', key: -1, mark: '200' })),
    ).toBe(1);
  });

  it('highlights a hovered mark with fill only — no outline', () => {
    const calls = draw(marked(), null, { id: 'count', key: -1, mark: '200' });
    expect(calls.some((c) => c.type === 'set' && c.args[0] === '#fff')).toBe(
      true,
    );
    expect(outlines(calls)).toBe(0);
  });

  it('falls back to the key when the selection carries NO mark (shipped path)', () => {
    // A controlled `selected={{ id, key }}` predates marks and must keep
    // matching on the bar's `begin`, even though the series now has marks.
    expect(outlines(draw(marked(), { id: 'count', key: 150 }))).toBe(1);
    expect(outlines(draw(marked(), { id: 'count', key: 200 }))).toBe(0);
  });

  it('does not touch `marks` when neither selection nor hover carries one', () => {
    // The laziness contract: the readers build the mark strings on first read,
    // so the draw must not read them on the key-pinned / unselected path (see
    // BarSeries.marks). A throwing getter stands in for "was this read?".
    let reads = 0;
    const spy: BarSeries = {
      ...bars([50, 150, 250], [150, 250, 350], [10, 20, 30]),
      get marks(): readonly string[] {
        reads += 1;
        return ['100', '200', '300'];
      },
    };
    draw(spy, null, null);
    draw(spy, { id: 'count', key: 150 }, null);
    expect(reads).toBe(0);
    // …and exactly once (hoisted out of the per-bar loop) when one does.
    draw(spy, { id: 'count', key: -1, mark: '200' }, null);
    expect(reads).toBe(1);
  });

  it('falls back to the key when the SERIES carries no marks (hand-built view)', () => {
    // A mark-carrying selection against a marks-free series can't match by
    // name; the key still decides, so nothing silently stops highlighting.
    const plain = bars([50, 150, 250], [150, 250, 350], [10, 20, 30]);
    expect(outlines(draw(plain, { id: 'count', key: 150, mark: '200' }))).toBe(
      1,
    );
  });

  it('mixes channels: a marked selection with a key-only hover', () => {
    const calls = draw(
      marked(),
      { id: 'count', key: -1, mark: '100' }, // selected by mark (bar 0)
      { id: 'count', key: 250 }, // hovered by key, no mark (bar 2)
    );
    expect(outlines(calls)).toBe(1); // only the selected bar is outlined…
    // …and two bars fill with the highlight: the selected one and the hovered one.
    expect(
      calls.filter(
        (c) =>
          c.type === 'set' && c.name === 'fillStyle' && c.args[0] === '#fff',
      ).length,
    ).toBe(2);
  });
});

/**
 * #576 — the single-series highlight **fill** pops to full opacity, as the
 * per-bar-fills branch and `drawStacks` already did. It used to draw at the
 * resting `style.opacity`, so on an alpha'd theme a hovered bar (which has no
 * outline) barely changed, and a selected one read only by its outline.
 */
describe('drawBars — highlight fill alpha (single series)', () => {
  const three = () => bars([0, 1, 2], [1, 2, 3], [10, 20, 30]);

  const draw = (
    selection: { id: string; key: number } | null,
    hovered: { id: string; key: number } | null = null,
  ) => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      three(),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      selection === null ? [] : [selection],
      hovered,
      false, // no decimation — the per-bar highlight path
    );
    return calls;
  };

  const alphasOf = (calls: readonly CtxCall[]) =>
    calls
      .filter((c) => c.type === 'set' && c.name === 'globalAlpha')
      .map((c) => c.args[0]);

  /** The `globalAlpha` in effect when call `index` was issued. */
  const alphaAt = (calls: readonly CtxCall[], index: number) => {
    let a: unknown;
    for (let i = 0; i < index; i += 1) {
      const c = calls[i]!;
      if (c.type === 'set' && c.name === 'globalAlpha') a = c.args[0];
    }
    return a;
  };

  it('pops the hovered bar to alpha 1 and drops back for the rest', () => {
    // Leading set is drawBars' save-bracket opacity, then one set per bar.
    expect(alphasOf(draw(null, { key: 1, id: 'count' }))).toEqual([
      style.opacity,
      style.opacity,
      1,
      style.opacity,
    ]);
  });

  it('fills the hovered bar with the highlight colour AT alpha 1', () => {
    // The colour and the alpha have to land together — asserting the colour
    // alone is what let the dim-highlight bug through.
    const calls = draw(null, { key: 1, id: 'count' });
    const fills = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.name === 'fillRect');
    expect(fills).toHaveLength(3);
    expect(alphaAt(calls, fills[1]!.i)).toBe(1);
    expect(alphaAt(calls, fills[0]!.i)).toBe(style.opacity);
    expect(alphaAt(calls, fills[2]!.i)).toBe(style.opacity);
    // …and the colour half of the claim, which the name makes and the
    // assertions above did not (L2 review of #580).
    const colourAt = (index: number) => {
      let c: unknown;
      for (let i = 0; i < index; i += 1) {
        const call = calls[i]!;
        if (call.type === 'set' && call.name === 'fillStyle') c = call.args[0];
      }
      return c;
    };
    expect(colourAt(fills[1]!.i)).toBe(style.highlight);
    expect(colourAt(fills[0]!.i)).toBe(style.fill);
  });

  it('a gap bar next to a highlighted one cannot mis-alpha either (leak guard)', () => {
    // Both `continue` paths — a gap bar (rect === null) and the binFills
    // branch — skip the alpha set entirely, so the guarantee that every fill
    // is preceded by its own set is what rules a leak out. Bar 1 is a gap,
    // sitting between a hovered bar 0 and a resting bar 2.
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1, 2], [1, 2, 3], [10, NaN, 30]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [],
      { key: 0, id: 'count' },
      false,
    );
    const fills = calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.name === 'fillRect');
    expect(fills).toHaveLength(2); // the gap draws nothing
    expect(alphaAt(calls, fills[0]!.i)).toBe(1); // hovered
    expect(alphaAt(calls, fills[1]!.i)).toBe(style.opacity); // past the gap
  });

  it('pops the selected bar too, and still strokes its outline at alpha 1', () => {
    const calls = draw({ key: 1, id: 'count' });
    expect(alphasOf(calls)).toEqual([
      style.opacity,
      style.opacity,
      1,
      style.opacity,
    ]);
    const stroke = calls.findIndex((c) => c.name === 'strokeRect');
    expect(stroke).toBeGreaterThan(-1);
    // The outline no longer sets alpha itself — it inherits the fill's pop.
    expect(alphaAt(calls, stroke)).toBe(1);
  });

  it('leaves every bar at the resting opacity when nothing is live', () => {
    expect(alphasOf(draw(null, null))).toEqual([
      style.opacity,
      style.opacity,
      style.opacity,
      style.opacity,
    ]);
  });

  it('restores the resting opacity after a selected bar (no leak onward)', () => {
    // Bar 0 selected: bar 1 and 2 must be back at the flat opacity.
    const calls = draw({ key: 0, id: 'count' });
    expect(alphasOf(calls)).toEqual([
      style.opacity,
      1,
      style.opacity,
      style.opacity,
    ]);
  });
});

/**
 * #577 — an optional `hover` colour on `BarStyle`, so a bar can carry the same
 * three-step emphasis a consumer's list does (rest → hover → selected) instead
 * of one `highlight` for both live states. Omitted, everything renders exactly
 * as before.
 */
describe('drawBars — distinct hover colour (BarStyle.hover)', () => {
  const threeStep: BarStyle = { ...style, hover: '#0ff' };

  const draw = (
    s: BarStyle,
    selection: { id: string; key: number } | null,
    hovered: { id: string; key: number } | null = null,
  ) => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1, 2], [1, 2, 3], [10, 20, 30]),
      identity,
      identity,
      s,
      0,
      0,
      'count',
      selection === null ? [] : [selection],
      hovered,
      false,
    );
    return calls
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .map((c) => c.args[0]);
  };

  it('fills a hovered bar with `hover` when the theme sets one', () => {
    expect(draw(threeStep, null, { key: 1, id: 'count' })).toEqual([
      style.fill,
      '#0ff',
      style.fill,
    ]);
  });

  it('still fills a selected bar with `highlight`, not `hover`', () => {
    expect(draw(threeStep, { key: 1, id: 'count' })).toEqual([
      style.fill,
      style.highlight,
      style.fill,
    ]);
  });

  it('selection outranks hover on a bar that is both', () => {
    const both = { key: 1, id: 'count' };
    expect(draw(threeStep, both, both)).toEqual([
      style.fill,
      style.highlight,
      style.fill,
    ]);
  });

  it('renders three distinct colours across rest / hover / selected', () => {
    // The point of the feature: one draw showing all three steps at once.
    const fills = draw(
      threeStep,
      { key: 0, id: 'count' },
      { key: 2, id: 'count' },
    );
    expect(fills).toEqual([style.highlight, style.fill, '#0ff']);
    expect(new Set(fills).size).toBe(3);
  });

  it('falls back to `highlight` for hover when no `hover` is set (unchanged)', () => {
    expect(draw(style, null, { key: 1, id: 'count' })).toEqual([
      style.fill,
      style.highlight,
      style.fill,
    ]);
  });

  it('is ignored on the per-bar-colours path (binColors keeps its own fill)', () => {
    // Not an oversight — a per-bar-coloured bar pops its OWN colour for both
    // states so a red/green volume bar keeps its meaning while live. Pinned so
    // that stays a decision rather than drifting.
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1, 2], [1, 2, 3], [10, 20, 30]),
      identity,
      identity,
      threeStep,
      0,
      0,
      'count',
      [],
      { key: 1, id: 'count' },
      false,
      ['#r', '#g', '#b'],
    );
    const fills = calls
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .map((c) => c.args[0]);
    expect(fills).toEqual(['#r', '#g', '#b']); // never '#0ff'
  });
});

/**
 * The other half of the scope: `drawStacks` has no hover channel at all, so
 * every `<BarChart>` shape routed through it ignores `BarStyle.hover` —
 * including a *single-column* histogram and a single-series **horizontal**
 * chart, which `<BarChart>` builds as one-group stacks. Pinned because
 * `BarStyle.hover`'s first draft claimed "single-series only", which reads as
 * though those two would honour it (Layer-2 review of #581).
 */
describe('drawStacks — no hover channel (the BarStyle.hover exclusion)', () => {
  it('fills a hovered one-group stack with its own group fill', () => {
    const ss: StackedBarSeries = {
      begin: Float64Array.from([0, 1, 2]),
      end: Float64Array.from([1, 2, 3]),
      groups: ['value'],
      values: Float64Array.from([10, 20, 30]),
      length: 3,
    };
    const { ctx, calls } = recordingContext();
    drawStacks(
      ctx,
      ss,
      'vertical',
      identity,
      identity,
      { fills: ['#0a0'], opacity: 0.85, outlineWidth: 2 },
      0,
      1,
      'count',
      [],
      { id: 'count', key: 1, label: 'value' },
    );
    const fills = calls
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .map((c) => c.args[0]);
    // Every bin — hovered included — uses the group fill; the hovered one is
    // distinguished by alpha alone, which is the stacked convention.
    expect(fills).toEqual(['#0a0', '#0a0', '#0a0']);
    const alphas = calls
      .filter((c) => c.type === 'set' && c.name === 'globalAlpha')
      .map((c) => c.args[0]);
    expect(alphas).toContain(1); // the hovered bin still pops
  });
});

describe('barIndexAtTime', () => {
  // Three contiguous bars: [0,10], [10,20], [20,30].
  const cs = bars([0, 10, 20], [10, 20, 30], [5, 6, 7]);

  it('returns the bar whose span contains the time', () => {
    expect(barIndexAtTime(cs, 5)).toBe(0);
    expect(barIndexAtTime(cs, 15)).toBe(1);
    expect(barIndexAtTime(cs, 25)).toBe(2);
  });

  it('stays on the same bar past its midpoint (not nearest-by-begin)', () => {
    // 18 is in the right half of bar 1 ([10,20]); nearest-by-begin would flip to
    // bar 2 (begin 20 nearer than begin 10). Containment keeps it on bar 1 — the
    // flag-on-the-wrong-bar fix.
    expect(barIndexAtTime(cs, 18)).toBe(1);
  });

  it('returns the left bar at a shared edge (end[i] === begin[i+1])', () => {
    expect(barIndexAtTime(cs, 10)).toBe(0);
    expect(barIndexAtTime(cs, 20)).toBe(1);
  });

  it('returns -1 outside every bar span', () => {
    expect(barIndexAtTime(cs, -1)).toBe(-1);
    expect(barIndexAtTime(cs, 31)).toBe(-1);
  });
});

describe('barAt', () => {
  // Non-contiguous keys: spans [0,5], [10,15], [20,25] with REAL holes between
  // them — axis space no bar's interval covers.
  const cs = bars([0, 10, 20], [5, 15, 25], [30, 50, 20]);

  it('returns [index, begin, value] for a click inside a bar', () => {
    expect(barAt(cs, 12, 25, identity, identity, 0, 1)).toEqual([1, 10, 50]);
  });

  it('hits the first bar', () => {
    expect(barAt(cs, 2, 10, identity, identity, 0, 1)).toEqual([0, 0, 30]);
  });

  it('still misses a genuine hole between non-contiguous intervals', () => {
    // x=7 is inside no key's span. Widening the hit region to the slot makes
    // the *drawing* gap hittable; it does not invent coverage where the data
    // has none.
    expect(barAt(cs, 7, 10, identity, identity, 0, 1)).toBeNull();
  });

  it('falls back to the drawn y-span when the scale has no domain', () => {
    // A bare stub can't report the plot height, so barSlotRect keeps the
    // value→baseline span rather than an unbounded region: bar 1 reaches 50,
    // and y=60 is past it.
    expect(barAt(cs, 12, 60, identity, identity, 0, 1)).toBeNull();
  });

  it('skips a gap bar (non-finite value)', () => {
    const g = bars([0, 10], [5, 15], [NaN, 50]);
    expect(barAt(g, 2, 10, identity, identity, 0, 1)).toBeNull();
    expect(barAt(g, 12, 25, identity, identity, 0, 1)).toEqual([1, 10, 50]);
  });
});

/**
 * A bar *is* the full width of its interval; the drawing gap is a display
 * affordance so adjacent columns read as discrete. Hit-testing the drawn rect
 * made that affordance interactive — the gap became a dead channel, and so did
 * the empty plot space above a short bar, even though the x-scrub cursor
 * (`barIndexAtTime`) happily reported the bar at that same x. `barAt` now tests
 * the **slot**: full interval width, full plot height.
 */
describe('barAt — slot hit-testing', () => {
  // Contiguous keys, so the slots tile: [0,10], [10,20], [20,30].
  const cs = bars([0, 10, 20], [10, 20, 30], [30, 50, 20]);
  // A y scale that CAN report the plot height (0..100 in identity pixels).
  const yScale = scaleWithDomain(0, 100);

  it('hits well above a short bar — the whole column is its slot', () => {
    // Bar 2's value is 20, so the drawn rect is y [0,20]; y=90 is far above it
    // and used to miss entirely.
    expect(barAt(cs, 25, 90, identity, yScale, 0, 1)).toEqual([2, 20, 20]);
  });

  it('hits inside what the drawing gap would carve out', () => {
    // x=19.8 sits where a gapPx inset would have removed the bar's ink.
    expect(barAt(cs, 19.8, 5, identity, yScale, 0, 1)).toEqual([1, 10, 50]);
  });

  it('gives a shared edge to the LEFT bar, as barIndexAtTime does', () => {
    // x=10 is bar 0's end and bar 1's begin; first match wins.
    expect(barAt(cs, 10, 5, identity, yScale, 0, 1)?.[0]).toBe(0);
    expect(barIndexAtTime(cs, 10)).toBe(0); // the two agree
  });

  it('agrees with the x-scrub cursor across the whole data range', () => {
    // The property that motivated the change: for any x inside the range, the
    // bar you hover is the bar the cursor reads out.
    for (const x of [0, 3, 9.9, 10, 14, 20, 27, 30]) {
      expect(barAt(cs, x, 50, identity, yScale, 0, 1)?.[0]).toBe(
        barIndexAtTime(cs, x),
      );
    }
  });

  it('still misses outside the data range', () => {
    expect(barAt(cs, -1, 50, identity, yScale, 0, 1)).toBeNull();
    expect(barAt(cs, 31, 50, identity, yScale, 0, 1)).toBeNull();
  });

  it('still misses outside the plot height', () => {
    expect(barAt(cs, 15, 101, identity, yScale, 0, 1)).toBeNull();
  });

  it('treats a one-element domain as unusable, not as a zero-height slot', () => {
    // Both endpoints would be the same value, collapsing the slot to zero
    // height and making the bar unhittable — so the guard is `< 2`, not
    // `=== 0`, and this falls back to the drawn y-span (L2 review of #584).
    const degenerate = (v: number) => v;
    (degenerate as unknown as { domain: () => number[] }).domain = () => [0];
    // Bar 1 draws y [0,50] under the fallback, so a mid-bar point hits…
    expect(barAt(cs, 15, 25, identity, degenerate, 0, 1)).toEqual([1, 10, 50]);
    // …and one above its value misses, as the no-domain stub does.
    expect(barAt(cs, 15, 80, identity, degenerate, 0, 1)).toBeNull();
  });

  it('a gap bar owns no slot — its column selects nothing', () => {
    const g = bars([0, 10, 20], [10, 20, 30], [30, NaN, 20]);
    expect(barAt(g, 15, 50, identity, yScale, 0, 1)).toBeNull();
    expect(barAt(g, 5, 50, identity, yScale, 0, 1)?.[0]).toBe(0);
  });
});

describe('drawBars — viewport culling (Phase 2)', () => {
  // 6 contiguous unit bars: begin 0,10,…,50; end = begin+10.
  const ramp = () =>
    bars([0, 10, 20, 30, 40, 50], [10, 20, 30, 40, 50, 60], [1, 2, 3, 4, 5, 6]);

  it('fills only the bars whose span overlaps the visible window (+1 each side)', () => {
    const { ctx, calls } = recordingContext();
    // view [22, 38] → spans [20,30] and [30,40] overlap; +1 margin → indices [1,5)
    // → 4 bars of 6.
    drawBars(
      ctx,
      ramp(),
      scaleWithDomain(22, 38),
      identity,
      style,
      0,
      0,
      'count',
      [],
      null,
    );
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(4);
  });

  it('matches selection by the original begin key after culling', () => {
    const { ctx, calls } = recordingContext();
    // Select the bar at begin=30 (index 3). Within the culled window it must
    // still light up (highlight fill + outline stroke), keyed on its real begin.
    drawBars(
      ctx,
      ramp(),
      scaleWithDomain(22, 55),
      identity,
      style,
      0,
      0,
      'count',
      [{ key: 30, id: 'count' }],
      null,
    );
    // The selected bar strokes an outline; a mis-keyed cull would miss it.
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
  });

  it('fills all bars when the scale has no domain (test stub)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(ctx, ramp(), identity, identity, style, 0, 0, 'count', [], null);
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(6);
  });
});

/**
 * `drawBars` M4 column decimation ([PND-MARKDEC]): once the visible bars are
 * denser than ~2 per device pixel, they're drawn as one envelope rect per pixel
 * column instead of every bar. Needs a real invertible scale + a sized ctx (a
 * bare scale / unsized ctx never decimates — the other bars tests stay full-res).
 */
describe('drawBars — M4 column decimation', () => {
  const pxScale = (lo: number, hi: number, widthCss = hi - lo) =>
    scaleLinear().domain([lo, hi]).range([0, widthCss]) as unknown as (
      v: number,
    ) => number;
  // A recording ctx with a device-pixel backing width so decimation can fire.
  const sizedCtx = (widthPx: number) => {
    const rec = recordingContext();
    (rec.ctx as unknown as { canvas: { width: number } }).canvas = {
      width: widthPx,
    };
    return rec;
  };
  // `n` unit bars over [0, n], value = index (all positive).
  const dense = (n: number): BarSeries =>
    bars(
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => i + 1),
      Array.from({ length: n }, (_, i) => i),
    );

  it('draws one envelope rect per non-empty column when dense', () => {
    const { ctx, calls } = sizedCtx(4); // W=4
    // 100 bars ≫ 2×4 → decimate to ≤4 column rects.
    const stats = drawBars(
      ctx,
      dense(100),
      pxScale(0, 100),
      (v) => v,
      style,
      0,
      0,
      'count',
      [],
      null,
    );
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(4);
    expect(stats).toEqual({ sourceCount: 100, drawnCount: 4, decimated: true });
  });

  it('draws every bar full-resolution below the density threshold', () => {
    const { ctx, calls } = sizedCtx(800); // W=800; 100 bars < 2×800
    const stats = drawBars(
      ctx,
      dense(100),
      pxScale(0, 100),
      (v) => v,
      style,
      0,
      0,
      'count',
      [],
      null,
    );
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(100);
    expect(stats).toEqual({
      sourceCount: 100,
      drawnCount: 100,
      decimated: false,
    });
  });

  it('threads { threshold } through to the decimation gate', () => {
    const { ctx, calls } = sizedCtx(4); // W=4
    // 100 bars: default (k=2) decimates (100 > 8); a high threshold (k=30, 100 <
    // 120) draws full-resolution — proving the prop is wired, not hardcoded.
    const stats = drawBars(
      ctx,
      dense(100),
      pxScale(0, 100),
      (v) => v,
      style,
      0,
      0,
      'count',
      [],
      null,
      { threshold: 30 },
    );
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(100);
    expect(stats.decimated).toBe(false);
  });

  it('draws every bar when decimate is off, even at density', () => {
    const { ctx, calls } = sizedCtx(4);
    const stats = drawBars(
      ctx,
      dense(100),
      pxScale(0, 100),
      (v) => v,
      style,
      0,
      0,
      'count',
      [],
      null,
      false, // decimate off
    );
    expect(calls.filter((c) => c.name === 'fillRect')).toHaveLength(100);
    expect(stats.decimated).toBe(false);
  });

  it('suppresses the per-bar selection highlight when decimated', () => {
    const { ctx, calls } = sizedCtx(4);
    // A selection matching a source bar: at full res it would strokeRect; when
    // decimated the aggregate columns aren't individually selectable, so no stroke.
    drawBars(
      ctx,
      dense(100),
      pxScale(0, 100),
      (v) => v,
      style,
      0,
      0,
      'count',
      [{ key: 42, id: 'count' }],
      null,
    );
    expect(calls.some((c) => c.name === 'strokeRect')).toBe(false);
    // The envelope fill uses the flat `fill`, never the `highlight`.
    expect(
      calls.some(
        (c) =>
          c.type === 'set' &&
          c.name === 'fillStyle' &&
          c.args?.[0] === style.highlight,
      ),
    ).toBe(false);
  });
});

/**
 * `drawBars` per-bar fills (`binColors` on a single-series `<BarChart>`): bar
 * `i` fills with `binFills[i]` (falling back to the flat `fill`), the highlight
 * pops opacity instead of swapping the colour (the drawStacks binFills
 * convention — a direction-coloured volume bar stays red / green while live),
 * and the dense-bar envelope pass is skipped (one rect can't carry many
 * colours).
 */
describe('drawBars — per-bar fills (binFills)', () => {
  /** The fillStyle in effect at each fillRect, in draw order. */
  const fillsAtRects = (calls: readonly CtxCall[]): unknown[] => {
    let fill: unknown;
    const out: unknown[] = [];
    for (const c of calls) {
      if (c.type === 'set' && c.name === 'fillStyle') fill = c.args[0];
      else if (c.name === 'fillRect') out.push(fill);
    }
    return out;
  };

  it('fills each bar with its own binFills entry, in order', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1, 2], [1, 2, 3], [10, 20, 30]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [],
      null,
      true,
      ['#r', '#g', '#b'],
    );
    expect(fillsAtRects(calls)).toEqual(['#r', '#g', '#b']);
  });

  it('an undefined / out-of-range entry falls back to the flat fill', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1, 2], [1, 2, 3], [10, 20, 30]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [],
      null,
      true,
      ['#r', undefined], // bar 1 explicit undefined; bar 2 beyond the array
    );
    expect(fillsAtRects(calls)).toEqual(['#r', style.fill, style.fill]);
  });

  it('stays index-aligned across a gap bar (the gap consumes its slot)', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1, 2], [1, 2, 3], [10, NaN, 30]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [],
      null,
      true,
      ['#r', '#g', '#b'],
    );
    // Bar 1 is a gap (no rect) but bar 2 still takes ITS colour, not '#g'.
    expect(fillsAtRects(calls)).toEqual(['#r', '#b']);
  });

  it('a hovered bar keeps its own colour — alpha pops to 1, no fill swap', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1, 2], [1, 2, 3], [10, 20, 30]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [],
      { key: 1, id: 'count' }, // hover the middle bar
      true,
      ['#r', '#g', '#b'],
    );
    // The highlight colour is never used; the hovered bar still fills '#g'.
    expect(fillsAtRects(calls)).toEqual(['#r', '#g', '#b']);
    expect(
      calls.some(
        (c) =>
          c.type === 'set' &&
          c.name === 'fillStyle' &&
          c.args[0] === style.highlight,
      ),
    ).toBe(false);
    // Alpha per bar: opacity, then 1 for the hovered bar, then opacity again
    // (the leading set is drawBars' save-bracket initial opacity).
    const alphas = calls
      .filter((c) => c.type === 'set' && c.name === 'globalAlpha')
      .map((c) => c.args[0]);
    expect(alphas).toEqual([style.opacity, style.opacity, 1, style.opacity]);
    // Hover alone never outlines.
    expect(calls.some((c) => c.name === 'strokeRect')).toBe(false);
  });

  it('a selected bar outlines in its own fill, not the highlight colour', () => {
    const { ctx, calls } = recordingContext();
    drawBars(
      ctx,
      bars([0, 1, 2], [1, 2, 3], [10, 20, 30]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [{ key: 1, id: 'count' }], // select the middle bar
      null,
      true,
      ['#r', '#g', '#b'],
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(1);
    expect(
      calls.find((c) => c.type === 'set' && c.name === 'strokeStyle')?.args,
    ).toEqual(['#g']);
    expect(
      calls.some(
        (c) =>
          c.type === 'set' &&
          c.name === 'fillStyle' &&
          c.args[0] === style.highlight,
      ),
    ).toBe(false);
  });

  it('skips the dense-bar envelope — per-bar colours draw every visible bar', () => {
    const pxScale = scaleLinear()
      .domain([0, 100])
      .range([0, 100]) as unknown as (v: number) => number;
    const sizedCtx = () => {
      const rec = recordingContext();
      (rec.ctx as unknown as { canvas: { width: number } }).canvas = {
        width: 4,
      };
      return rec;
    };
    const n = 100;
    const dense = bars(
      Array.from({ length: n }, (_, i) => i),
      Array.from({ length: n }, (_, i) => i + 1),
      Array.from({ length: n }, (_, i) => i),
    );
    // Control: without binFills the same setup decimates to W=4 column rects.
    const control = sizedCtx();
    const cStats = drawBars(
      control.ctx,
      dense,
      pxScale,
      identity,
      style,
      0,
      0,
      'count',
      [],
      null,
    );
    expect(cStats.decimated).toBe(true);
    expect(control.calls.filter((c) => c.name === 'fillRect')).toHaveLength(4);
    // With binFills: every visible bar draws, each with its own colour.
    const fills = Array.from({ length: n }, (_, i) =>
      i % 2 === 0 ? '#up' : '#dn',
    );
    const rec = sizedCtx();
    const stats = drawBars(
      rec.ctx,
      dense,
      pxScale,
      identity,
      style,
      0,
      0,
      'count',
      [],
      null,
      true,
      fills,
    );
    expect(stats.decimated).toBe(false);
    expect(rec.calls.filter((c) => c.name === 'fillRect')).toHaveLength(n);
  });
  it('stays source-aligned under viewport culling (vStart > 0)', () => {
    const { ctx, calls } = recordingContext();
    // 6 contiguous unit bars; view [22, 38] culls to indices [1, 5) (the two
    // overlapping spans +1 margin each side — the pinned culling case above).
    drawBars(
      ctx,
      bars(
        [0, 10, 20, 30, 40, 50],
        [10, 20, 30, 40, 50, 60],
        [1, 2, 3, 4, 5, 6],
      ),
      scaleWithDomain(22, 38),
      identity,
      style,
      0,
      0,
      'count',
      [],
      null,
      true,
      ['#0', '#1', '#2', '#3', '#4', '#5'],
    );
    // The culled window draws bars 1..4 — each with its OWN colour (an
    // index-zip against the culled slice would show '#0'..'#3').
    expect(fillsAtRects(calls)).toEqual(['#1', '#2', '#3', '#4']);
  });

  it('an EMPTY binFills array stays on the legacy path end-to-end', () => {
    // Dense: an empty array means "no colours", so the envelope pass still
    // fires (presence alone must not disable the perf path — L2 review).
    const pxScale = scaleLinear()
      .domain([0, 100])
      .range([0, 100]) as unknown as (v: number) => number;
    const rec = recordingContext();
    (rec.ctx as unknown as { canvas: { width: number } }).canvas = {
      width: 4,
    };
    const n = 100;
    const stats = drawBars(
      rec.ctx,
      bars(
        Array.from({ length: n }, (_, i) => i),
        Array.from({ length: n }, (_, i) => i + 1),
        Array.from({ length: n }, (_, i) => i),
      ),
      pxScale,
      identity,
      style,
      0,
      0,
      'count',
      [],
      null,
      true,
      [],
    );
    expect(stats.decimated).toBe(true);
    expect(rec.calls.filter((c) => c.name === 'fillRect')).toHaveLength(4);
    // Sparse: the legacy highlight convention also applies (fill swaps to the
    // highlight colour), exactly as if binFills were omitted.
    const sparse = recordingContext();
    drawBars(
      sparse.ctx,
      bars([0, 1], [1, 2], [10, 20]),
      identity,
      identity,
      style,
      0,
      0,
      'count',
      [],
      { key: 1, id: 'count' },
      true,
      [],
    );
    expect(
      sparse.calls.some(
        (c) =>
          c.type === 'set' &&
          c.name === 'fillStyle' &&
          c.args[0] === style.highlight,
      ),
    ).toBe(true);
  });
});
