import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { Selector } from '../src/selectors.js';
import { YAxis } from '../src/YAxis.js';
import { categoryStacks } from '../src/data.js';
import { defaultTheme, estelaTheme, type ChartTheme } from '../src/theme.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
  type SelectInfo,
} from '../src/context.js';
import { recordingContext, stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * **A first-class stacked category chart** ([PND-CATSTACK]) — `categories` +
 * `columns`, the same relationship `series` + `columns` already has.
 *
 * It replaces a real consumer workaround: one `<BarChart categories>` layer per
 * *cumulative total*, drawn outermost-first so each overpaints the one beneath.
 * That cost a hand-assembled legend, label thinning blind to the other layers,
 * and — once selection landed — a controlled set replicated across every segment
 * layer, where missing one made a selected bar recede **from the waist up**.
 *
 * The tests below are ordered by what they protect: the geometry, then the two
 * selection properties the consumer's migration depends on, then the gap and
 * validation rules.
 */

const CATS = [
  { label: 'alpha', values: { hits: 3, misses: 2 } },
  { label: 'beta', values: { hits: 1, misses: 5 } },
  { label: 'gamma', values: { hits: 4, misses: 1 } },
];
const COLS = ['hits', 'misses'];

/** Mount a category stack and hand back the frames plus a draw replay. */
function mount(
  node: React.ReactNode,
  colors?: Readonly<Record<string, string>>,
  theme?: ChartTheme,
) {
  let cf: ContainerFrame | null = null;
  let rf: RowFrame | null = null;
  function Capture() {
    const c = useContext(ContainerContext);
    const r = useContext(RowContext);
    useEffect(() => {
      if (c) cf = c;
      if (r) rf = r;
    });
    return null;
  }
  const stub = stubCanvasContext();
  try {
    render(
      <ChartContainer
        width={400}
        showAxis={false}
        {...(theme ? { theme } : {})}
      >
        {node}
        <ChartRow height={160}>
          <YAxis id="v" min={0} max={10} label="" />
          <Layers>
            <BarChart
              categories={CATS}
              columns={COLS}
              axis="v"
              id="cap"
              {...(colors ? { colors } : {})}
            />
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  return {
    frame: () => cf!,
    row: () => rf!,
    /** Every `fillStyle` the layer's draw sets, in order. */
    fills(): string[] {
      const { ctx, calls } = recordingContext();
      const r = rf!;
      r.layers[0]!.layer.draw(ctx, cf!.xScale, r.yScales.get('v')!);
      return calls
        .filter((c) => c.type === 'set' && c.name === 'fillStyle')
        .map((c) => String(c.args[0]));
    },
  };
}

describe('the reader — geometry and layout', () => {
  it('lays values out bin-major, matching `stacksFromColumns`', () => {
    // `values[i * G + g]`. Getting this transposed would draw a plausible chart
    // with every segment on the wrong bar, which no visual check reliably
    // catches — hence an explicit assertion on the buffer.
    const ss = categoryStacks(CATS, COLS);
    expect(ss.groups).toEqual(COLS);
    expect(ss.length).toBe(3);
    expect([...ss.values]).toEqual([3, 2, 1, 5, 4, 1]);
  });

  it('keeps the single-value geometry — unit slots and per-bin `marks`', () => {
    // The categorical axis derives its ordered labels from `marks`, and a
    // pinned selection keys on the name rather than the slot index, so both
    // must survive the move to G > 1 unchanged.
    const ss = categoryStacks(CATS, COLS);
    expect([...ss.begin]).toEqual([0, 1, 2]);
    expect([...ss.end]).toEqual([1, 2, 3]);
    expect(ss.marks).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('`marks` is indexed by BIN, not by segment', () => {
    // The property every selection guarantee below rests on: one mark per bar,
    // not one per segment. If this ever became per-segment, "one entry lights
    // the whole bar" would silently become "lights one segment".
    const ss = categoryStacks(CATS, COLS);
    expect(ss.marks).toHaveLength(CATS.length);
    expect(ss.marks).toHaveLength(ss.length);
  });

  it('reads a missing or non-finite group as a gap, not a zero', () => {
    // A group absent from one category is a hole — the rule every other reader
    // applies. Zero would draw a real segment of no height and put it in the
    // legend as present.
    const ss = categoryStacks(
      [
        { label: 'a', values: { x: 1 } },
        { label: 'b', values: { x: 2, y: Number.NaN } },
      ],
      ['x', 'y'],
    );
    expect(ss.values[0]).toBe(1);
    expect(Number.isNaN(ss.values[1]!)).toBe(true);
    expect(Number.isNaN(ss.values[3]!)).toBe(true);
  });

  it('draws one segment per group per category', () => {
    // 3 categories × 2 groups, and the ramp gives the groups distinct hues, so
    // the count of distinct fills confirms the stack is grouped rather than
    // collapsed to one.
    const m = mount(null);
    expect(m.row().layers[0]).toBeDefined();
    expect(new Set(m.fills()).size).toBeGreaterThan(1);
  });
});

describe('selection — one entry lights the whole bar', () => {
  /** Names a bar by its stable category name, carrying no group. */
  const bar = (label: string): SelectInfo => ({
    id: 'cap',
    key: 0,
    value: 0,
    color: '#000',
    label,
    mark: label,
  });

  /** Call-site segment colours — the shape a consumer with spec-supplied
   *  colours passes, and the one that opts out of the theme ramp's derived
   *  companions (`groupsDimmed` / `groupsHover`). */
  const COLORS = { hits: '#aa0000', misses: '#0000aa' } as const;

  it('a single entry naming `(id, mark)` selects EVERY segment of that bar', () => {
    // **The property the consumer's migration turns on.** Their composed stack
    // was N layers, so a controlled set had to be replicated per segment layer;
    // miss one and the bar receded from the waist up. With one layer and one
    // `mark` per bar, a single entry covers every segment — the replication is
    // unnecessary and that failure is not expressible.
    //
    // Asserted on the `colors` path, where recede is the flat `dimmed`: two
    // unselected categories × two groups = four receded segments, and the
    // selected bar contributes none.
    const m = mount(
      <Selector enabled={false} selected={[bar('beta')]} />,
      COLORS,
    );
    const dim = defaultTheme.bar.default.dimmed!;
    expect(m.fills().filter((f) => f === dim)).toHaveLength(4);
  });

  it('selecting every category dims nothing — no segment left behind', () => {
    // The complement, and the direct inverse of the waist-up bug: were matching
    // per-segment rather than per-bin, naming all three categories would still
    // leave segments receded.
    const m = mount(
      <Selector
        enabled={false}
        selected={[bar('alpha'), bar('beta'), bar('gamma')]}
      />,
      COLORS,
    );
    const dim = defaultTheme.bar.default.dimmed!;
    expect(m.fills().filter((f) => f === dim)).toHaveLength(0);
  });

  it('the entry needs no group — `label` is ignored on the marks path', () => {
    // `drawStacks` matches `m.mark === marks[b]` when the series carries marks,
    // ignoring `label` entirely. An entry whose `label` names no group at all
    // still selects, which is what lets a consumer commit `(id, mark)` and stop
    // thinking about segments.
    const odd: SelectInfo = { ...bar('beta'), label: 'not-a-group-name' };
    const m = mount(<Selector enabled={false} selected={[odd]} />, COLORS);
    const dim = defaultTheme.bar.default.dimmed!;
    expect(m.fills().filter((f) => f === dim)).toHaveLength(4);
  });

  it('a SELECTED segment keeps its own colour — it does not collapse to `highlight`', () => {
    // Found building this feature, and it is the reason `groupColored` no longer
    // gates on the theme ramp. With the old gate, a stack carrying `colors`
    // painted BOTH segments of a selected bar in the one flat `highlight` blue —
    // losing the segment distinction exactly where the reader is looking, and
    // making the first-class stack render *worse* under selection than the
    // hand-composed workaround it replaces (whose `binFills` has the same
    // exclusion). A meaning-carrying colour survives emphasis; that is the
    // channel rule, and a `colors` map is meaning-carrying by construction.
    const m = mount(
      <Selector enabled={false} selected={[bar('beta')]} />,
      COLORS,
    );
    const fills = m.fills();
    expect(fills).toContain(COLORS.hits);
    expect(fills).toContain(COLORS.misses);
    expect(fills).not.toContain(defaultTheme.bar.default.highlight);
  });

  it('takes the themed `highlight` when the theme gives groups NO distinct colours', () => {
    // **Layer-2 review's find, and the reason it could only come from review.**
    // `groupColored` says "this segment's colour carries meaning, so emphasis
    // must not overwrite it". Gating it on `groups.length > 1` claims that of any
    // multi-group stack — including one under a theme with no group ramp, no
    // `colors` and no per-group roles, where every fill resolves to `base.fill`.
    // Suppressing the highlight there leaves *nothing*: selection becomes
    // invisible.
    //
    // `estelaTheme` is exactly that theme and it SHIPS. Every story and test
    // renders `defaultTheme`, whose ramp makes the two gates indistinguishable —
    // so no amount of the existing suite could have caught this. The gate now
    // reads the resolved `fills`, which is the honest question.
    const m = mount(
      <Selector enabled={false} selected={[bar('beta')]} />,
      undefined,
      estelaTheme,
    );
    const fills = m.fills();
    expect(fills).toContain(estelaTheme.bar.default.highlight);
  });

  it('a degenerate `colors` map that paints every group alike also keeps the highlight', () => {
    // The same rule from the other side: `colors` is not automatically
    // meaning-carrying — it is meaning-carrying when it distinguishes something.
    // One colour for every group distinguishes nothing, so emphasis applies.
    const flat = { hits: '#777777', misses: '#777777' } as const;
    const m = mount(
      <Selector enabled={false} selected={[bar('beta')]} />,
      flat,
    );
    expect(m.fills()).toContain(defaultTheme.bar.default.highlight);
  });

  it('on the THEME RAMP, recede is per-group rather than flat', () => {
    // The other colour source, asserted so the difference is documented rather
    // than discovered. With no `colors` the ramp paints the stack, so its
    // derived companion `groupsDimmed` applies and each receded segment keeps
    // its group's identity. Flat `dimmed` never appears.
    const m = mount(<Selector enabled={false} selected={[bar('beta')]} />);
    const fills = m.fills();
    const perGroup = defaultTheme.bar.default.groupsDimmed!;
    expect(fills).toContain(perGroup[0]);
    expect(fills).toContain(perGroup[1]);
    expect(fills).not.toContain(defaultTheme.bar.default.dimmed);
  });
});

describe('validation', () => {
  const box = (node: React.ReactNode) => (
    <ChartContainer width={400} showAxis={false}>
      <ChartRow height={120}>
        <YAxis id="v" min={0} max={10} label="" />
        <Layers>{node}</Layers>
      </ChartRow>
    </ChartContainer>
  );

  it('rejects `column` on a category chart, naming both spellings', () => {
    expect(() =>
      render(
        box(
          // @ts-expect-error — `column` is not a member of either category mode
          <BarChart categories={CATS} column="hits" axis="v" />,
        ),
      ),
    ).toThrow(/takes no `column`/);
  });

  it('rejects an empty `columns`', () => {
    // An empty group list would render nothing and read as a data problem.
    expect(() =>
      render(box(<BarChart categories={CATS} columns={[]} axis="v" />)),
    ).toThrow(/at least one group name/);
  });

  it('still accepts the single-value shape unchanged', () => {
    // The back-compat half: `{ label, value }` with no `columns` keeps working
    // exactly as it did, on the same one-group path.
    expect(() =>
      render(
        box(
          <BarChart
            categories={[
              { label: 'a', value: 3 },
              { label: 'b', value: 7 },
            ]}
            axis="v"
          />,
        ),
      ),
    ).not.toThrow();
  });
});
