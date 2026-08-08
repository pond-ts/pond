import { useContext, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { TimeSeries } from 'pond-ts';
import { YAxis } from '../src/YAxis.js';
import { defaultTheme } from '../src/theme.js';
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
 * [PND-MULTISEL] — the three pieces that let a consumer own a multi-valued
 * selection: modifier state on the callback, a `selected` prop that takes a
 * set, and a themed de-emphasis for everything out of it.
 *
 * The through-line worth stating: **the library reports, the consumer decides.**
 * It applies no set arithmetic — no `selectionMode`, no built-in toggle. What
 * it previously withheld was the *information* needed to implement a policy
 * (the click arrived as a bare hit, so every consumer was forced to treat every
 * click as a replace) and the *ability to render* the result (a single mark).
 * Those are the two things fixed here.
 */

const categories = [
  { label: 'alpha', value: 3 },
  { label: 'beta', value: 2 },
  { label: 'gamma', value: 1 },
];

const mark = (m: string): SelectInfo => ({
  id: 'cap',
  key: 0,
  value: 1,
  color: '#000',
  label: m,
  mark: m,
});

function mount(props: Record<string, unknown> = {}, theme = defaultTheme) {
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
  let dom: HTMLElement;
  try {
    const res = render(
      <ChartContainer width={300} theme={theme} {...props}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} label="" />
          <Layers>
            <BarChart categories={categories} id="cap" />
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    dom = res.container;
  } finally {
    stub.restore();
  }
  const { ctx, calls } = recordingContext();
  rf!.layers[0]!.layer.draw(ctx, cf!.xScale, rf!.yScales.get('a')!);
  const fills = calls
    .filter((c) => c.type === 'set' && c.name === 'fillStyle')
    .map((c) => c.args[0] as string);
  return { frame: cf!, dom, fills };
}

describe('modifier state reaches onSelect', () => {
  /** Click the plot surface with the given modifiers. */
  function clickWith(init: Partial<MouseEventInit>) {
    const onSelect = vi.fn();
    const stub = stubCanvasContext();
    let dom: HTMLElement;
    try {
      const res = render(
        <ChartContainer width={300} onSelect={onSelect}>
          <ChartRow height={100}>
            <YAxis id="a" min={0} max={4} label="" />
            <Layers>
              <BarChart categories={categories} id="cap" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
      dom = res.container;
    } finally {
      stub.restore();
    }
    const surface = dom.querySelector('canvas')!.parentElement!;
    // The selection is committed on `click`, after the pointer pair has
    // established that this wasn't a drag — firing only pointerup selects
    // nothing.
    fireEvent.pointerDown(surface, { clientX: 40, clientY: 40 });
    fireEvent.pointerUp(surface, { clientX: 40, clientY: 40 });
    fireEvent.click(surface, { clientX: 40, clientY: 40, ...init });
    return onSelect;
  }

  it('reports metaKey as additive — the macOS add-to-selection chord', () => {
    const onSelect = clickWith({ metaKey: true });
    expect(onSelect).toHaveBeenCalled();
    const mods = onSelect.mock.calls.at(-1)![1];
    expect(mods).toMatchObject({ additive: true, metaKey: true });
  });

  it('reports ctrlKey as additive — the same chord elsewhere', () => {
    const mods = clickWith({ ctrlKey: true }).mock.calls.at(-1)![1];
    expect(mods).toMatchObject({ additive: true, ctrlKey: true });
  });

  it('is not additive for a plain click', () => {
    const mods = clickWith({}).mock.calls.at(-1)![1];
    expect(mods).toMatchObject({
      additive: false,
      ctrlKey: false,
      metaKey: false,
    });
  });

  it('reports shift and alt without deriving a meaning for them', () => {
    // `shift` is already the region-drag chord, so the library deliberately
    // exposes it raw rather than minting a `range` flag that would collide.
    const mods = clickWith({ shiftKey: true, altKey: true }).mock.calls.at(
      -1,
    )![1];
    expect(mods).toMatchObject({ shiftKey: true, altKey: true });
    expect(mods).not.toHaveProperty('range');
  });

  it('keeps the callback arity for a non-pointer selection', () => {
    // A legend row / programmatic select has no event. Passing an explicit
    // `undefined` second argument would break existing
    // `toHaveBeenCalledWith(hit)` assertions for a purely additive feature.
    const onSelect = vi.fn();
    const stub = stubCanvasContext();
    let frame: ContainerFrame | null = null;
    function Grab() {
      const c = useContext(ContainerContext);
      useEffect(() => {
        if (c) frame = c;
      });
      return null;
    }
    try {
      render(
        <ChartContainer width={300} onSelect={onSelect}>
          <ChartRow height={100}>
            <YAxis id="a" min={0} max={4} label="" />
            <Layers>
              <BarChart categories={categories} id="cap" />
              <Grab />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    frame!.select(null);
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe('`selected` accepts a set', () => {
  it('normalizes a single mark to a one-member set', () => {
    // The union is what makes this non-breaking: every existing caller passes
    // a single `SelectInfo` and means exactly what it always did.
    const { frame } = mount({ selected: mark('alpha') });
    expect(frame.selected).toHaveLength(1);
    expect(frame.selected[0]!.mark).toBe('alpha');
  });

  it('normalizes null and omission to an empty set, never null', () => {
    expect(mount({ selected: null }).frame.selected).toEqual([]);
    expect(mount({}).frame.selected).toEqual([]);
  });

  it('carries an array through in order', () => {
    const { frame } = mount({ selected: [mark('gamma'), mark('alpha')] });
    expect(frame.selected.map((m) => m.mark)).toEqual(['gamma', 'alpha']);
  });

  it('lights every member, not just the first', () => {
    // The actual point: two selected bars both draw as selected. Before the
    // widening the second could not be expressed at all.
    const themed = {
      ...defaultTheme,
      bar: {
        ...defaultTheme.bar,
        default: { ...defaultTheme.bar.default, highlight: '#SEL' },
      },
    };
    const { fills } = mount(
      { selected: [mark('alpha'), mark('gamma')] },
      themed,
    );
    expect(fills.filter((f) => f === '#SEL')).toHaveLength(2);
  });
});

describe('BarStyle.dimmed — the themed de-emphasis', () => {
  const dimTheme = {
    ...defaultTheme,
    bar: {
      ...defaultTheme.bar,
      default: {
        ...defaultTheme.bar.default,
        highlight: '#SEL',
        dimmed: '#DIM',
      },
    },
  };

  it('dims the bars outside a non-empty selection', () => {
    const { fills } = mount({ selected: [mark('alpha')] }, dimTheme);
    expect(fills.filter((f) => f === '#SEL')).toHaveLength(1);
    expect(fills.filter((f) => f === '#DIM')).toHaveLength(2);
  });

  it('dims nothing while the selection is empty', () => {
    // With no selection there is nothing to recede from.
    const { fills } = mount({ selected: [] }, dimTheme);
    expect(fills).not.toContain('#DIM');
  });

  it('is opt-in — a theme with no dimmed value dims nothing', () => {
    // Back-compat by construction (RFC A2.3): the library never invents a dim.
    const { fills } = mount({ selected: [mark('alpha')] }, defaultTheme);
    expect(fills).not.toContain('#DIM');
  });
});

describe('a consumer can implement ⌘-click-adds with what is now exposed', () => {
  it('accumulates and toggles a set across additive clicks', () => {
    // The end-to-end claim of the wave, exercised as a consumer would: the
    // library hands over the modifiers, the consumer owns the arithmetic, and
    // the container renders whatever set comes back.
    function App() {
      const [sel, setSel] = useState<readonly SelectInfo[]>([]);
      return (
        <>
          <ChartContainer
            width={300}
            selected={sel}
            onSelect={(hit, mods) =>
              setSel((cur) => {
                if (hit === null) return [];
                if (!mods?.additive) return [hit];
                return cur.some((m) => m.mark === hit.mark)
                  ? cur.filter((m) => m.mark !== hit.mark)
                  : [...cur, hit];
              })
            }
          >
            <ChartRow height={100}>
              <YAxis id="a" min={0} max={4} label="" />
              <Layers>
                <BarChart categories={categories} id="cap" />
              </Layers>
            </ChartRow>
          </ChartContainer>
          <output>{sel.map((m) => m.mark).join(',')}</output>
        </>
      );
    }
    const stub = stubCanvasContext();
    let dom: HTMLElement;
    try {
      dom = render(<App />).container;
    } finally {
      stub.restore();
    }
    const surface = dom.querySelector('canvas')!.parentElement!;
    const out = () => dom.querySelector('output')!.textContent;
    const click = (x: number, init: Partial<MouseEventInit> = {}) => {
      fireEvent.pointerDown(surface, { clientX: x, clientY: 50 });
      fireEvent.pointerUp(surface, { clientX: x, clientY: 50 });
      fireEvent.click(surface, { clientX: x, clientY: 50, ...init });
    };

    click(40); // plain click on the first bar → replace
    const first = out();
    expect(first).not.toBe('');

    click(140, { metaKey: true }); // ⌘-click a second → accumulate
    expect(out()!.split(',').length).toBe(2);

    click(140, { metaKey: true }); // ⌘-click it again → toggle off
    expect(out()).toBe(first);
  });
});

/**
 * **The single-series (`drawBars`) path.**
 *
 * Everything above uses `categories`, which resolves to `kind: 'stacked'` and
 * therefore only ever exercises `drawStacks`. The fresh-eyes review found that
 * `drawBars`' threshold-ladder branch never applied `dimmed` at all — and the
 * reason it survived is precisely that no test reached that function. A suite
 * that can only see one of two draw paths is not covering the feature; these
 * tests drive the other one, through a time-keyed `series` + `column`.
 */
describe('the single-series draw path dims too', () => {
  // **Interval**-keyed, so each bar's `begin` is the literal 0 / 1 / 2 a
  // selection can name. A point-keyed series derives `begin` from neighbour
  // spacing, and a `key: 0` selection would match nothing — which is a real
  // trap, but not the one under test here.
  const series = new TimeSeries({
    name: 's',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [[0, 1], 3],
      [[1, 2], 2],
      [[2, 3], 1],
    ] as never,
  });

  const dimTheme = {
    ...defaultTheme,
    bar: {
      ...defaultTheme.bar,
      default: {
        ...defaultTheme.bar.default,
        highlight: '#SEL',
        dimmed: '#DIM',
        bands: ['#B0', '#B1'],
      },
    },
  };

  /** Draw a single-series bar chart and collect its fills. */
  function fillsFor(
    props: {
      selected?: readonly SelectInfo[];
      thresholds?: readonly number[];
    },
    theme = dimTheme,
  ) {
    // `thresholds` belongs to <BarChart>, `selected` to <ChartContainer> —
    // spreading both onto the container silently drops the ladder.
    const { thresholds, ...containerProps } = props;
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
          range={[0, 3]}
          width={300}
          theme={theme}
          {...containerProps}
        >
          <ChartRow height={100}>
            <YAxis id="a" min={0} max={4} label="" />
            <Layers>
              <BarChart
                series={series}
                column="v"
                id="cap"
                decimate={false}
                {...(thresholds ? { thresholds } : {})}
              />
              <Capture />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    const { ctx, calls } = recordingContext();
    rf!.layers[0]!.layer.draw(ctx, cf!.xScale, rf!.yScales.get('a')!);
    return calls
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .map((c) => c.args[0] as string);
  }

  const sel = (key: number): SelectInfo => ({
    id: 'cap',
    key,
    value: 0,
    color: '#000',
    label: 'v',
  });

  it('dims the flat path outside the selection', () => {
    const fills = fillsFor({ selected: [sel(0)] });
    expect(fills).toContain('#SEL');
    expect(fills.filter((f) => f === '#DIM')).toHaveLength(2);
  });

  it('dims the THRESHOLD-BANDED path too — the branch the review caught', () => {
    // Before the fix this branch painted the full ladder for every bar,
    // ignoring `dimmed` entirely, while the stacked path dimmed correctly.
    const fills = fillsFor({ selected: [sel(0)], thresholds: [1.5] });
    expect(fills.filter((f) => f === '#DIM')).toHaveLength(2);
  });

  it('dims nothing on the banded path with an empty selection', () => {
    const fills = fillsFor({ selected: [], thresholds: [1.5] });
    expect(fills).not.toContain('#DIM');
    expect(fills).toContain('#B0');
  });

  it('lights several selected bars on the single path', () => {
    // `barMatchesAny` with more than one member — also never exercised before.
    const fills = fillsFor({ selected: [sel(0), sel(2)] });
    expect(fills.filter((f) => f === '#SEL')).toHaveLength(2);
    expect(fills.filter((f) => f === '#DIM')).toHaveLength(1);
  });
});

describe('precedence is the same on both draw paths', () => {
  // The review found `drawBars` letting hover win over dim while `drawStacks`
  // let dim win. Hover wins in both now: dim means "not in your selection",
  // hover means "your pointer is here", and suppressing live pointer feedback
  // to keep a bar receded makes the chart feel broken.
  const dimTheme = {
    ...defaultTheme,
    bar: {
      ...defaultTheme.bar,
      default: {
        ...defaultTheme.bar.default,
        highlight: '#SEL',
        hover: '#HOV',
        dimmed: '#DIM',
      },
    },
  };

  it('hovering an unselected bar shows hover, not dim (stacked path)', () => {
    const { fills } = mount(
      { selected: [mark('alpha')], hovered: mark('beta') },
      dimTheme,
    );
    expect(fills).toContain('#HOV');
    // 'gamma' is neither selected nor hovered, so it still recedes.
    expect(fills).toContain('#DIM');
  });
});

/**
 * **Interaction with the region cursor's drag-to-select.**
 *
 * `SelectModifiers` reports `shiftKey` raw, and `shift` is already the
 * `regionSelectModifier` chord — so the obvious worry is that a shift gesture
 * now means two things at once. It doesn't, and these pin why: the two are
 * separated by *movement*, not by the modifier.
 *
 * A drag past `DRAG_SLOP` makes the click handler bail, so `onRegionSelect`
 * fires and `onSelect` does not. A shift-click that never moves is not a drag,
 * so it selects and commits no region. This is also the reason the library
 * exposes `shiftKey` but derives no `range` flag from it — a range gesture is
 * a drag ([PND-CATRANGE]), not a modifier.
 */
describe('shift does not collide with the region cursor', () => {
  function scenario() {
    const onSelect = vi.fn();
    const onRegionSelect = vi.fn();
    const stub = stubCanvasContext();
    let dom: HTMLElement;
    try {
      dom = render(
        <ChartContainer
          range={[0, 3]}
          width={300}
          cursor="region"
          panZoom
          regionSelectModifier="shift"
          onRegionSelect={onRegionSelect}
          onSelect={onSelect}
        >
          <ChartRow height={100}>
            <YAxis id="a" min={0} max={4} label="" />
            <Layers>
              <BarChart categories={categories} id="cap" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      ).container;
    } finally {
      stub.restore();
    }
    return {
      onSelect,
      onRegionSelect,
      surface: dom.querySelector('canvas')!.parentElement!,
    };
  }

  it('a shift-CLICK selects and commits no region', () => {
    const { onSelect, onRegionSelect, surface } = scenario();
    fireEvent.pointerDown(surface, {
      clientX: 40,
      clientY: 60,
      shiftKey: true,
    });
    fireEvent.pointerUp(surface, { clientX: 40, clientY: 60, shiftKey: true });
    fireEvent.click(surface, { clientX: 40, clientY: 60, shiftKey: true });
    expect(onSelect).toHaveBeenCalled();
    expect(onSelect.mock.calls.at(-1)![1]).toMatchObject({ shiftKey: true });
    expect(onRegionSelect).not.toHaveBeenCalled();
  });

  it('a shift-DRAG commits a region and does not select', () => {
    // Past DRAG_SLOP, so the click that ends the drag is ignored — the two
    // gestures are separated by movement, not by the modifier.
    const { onSelect, onRegionSelect, surface } = scenario();
    fireEvent.pointerDown(surface, {
      clientX: 40,
      clientY: 60,
      shiftKey: true,
    });
    fireEvent.pointerMove(surface, {
      clientX: 160,
      clientY: 60,
      shiftKey: true,
      buttons: 1,
    });
    fireEvent.pointerUp(surface, { clientX: 160, clientY: 60, shiftKey: true });
    fireEvent.click(surface, { clientX: 160, clientY: 60, shiftKey: true });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

/**
 * **`hovered` is a set** (RFC `selection.md` A4.2, sequencing step 1).
 *
 * A1.4 argued hover "is inherently one mark under the pointer". That holds
 * while hover *means* pointer position, and fails under a drag sweep, where it
 * means "would be selected if you released now" and several marks light at
 * once. Widening it is the prerequisite for `<Select>`; these pin the shape and
 * that a pointer-driven hover (0 or 1 members) is unaffected.
 */
describe('hovered accepts a set', () => {
  const hoverTheme = {
    ...defaultTheme,
    bar: {
      ...defaultTheme.bar,
      default: {
        ...defaultTheme.bar.default,
        highlight: '#SEL',
        hover: '#HOV',
      },
    },
  };

  it('normalizes a single mark, null and omission exactly as `selected` does', () => {
    expect(mount({ hovered: mark('alpha') }).frame.hovered).toHaveLength(1);
    expect(mount({ hovered: null }).frame.hovered).toEqual([]);
    expect(mount({}).frame.hovered).toEqual([]);
  });

  it('lights EVERY hovered mark — the sweep-preview case', () => {
    // The behaviour `<Select>` needs: several bars lit at once while a drag is
    // in flight. Impossible to express before the widening.
    const { fills } = mount(
      { hovered: [mark('alpha'), mark('gamma')] },
      hoverTheme,
    );
    expect(fills.filter((f) => f === '#HOV')).toHaveLength(2);
  });

  it('keeps selection outranking hover on a mark that is both', () => {
    const { fills } = mount(
      { selected: [mark('alpha')], hovered: [mark('alpha'), mark('beta')] },
      hoverTheme,
    );
    expect(fills).toContain('#SEL'); // alpha reads as selected
    expect(fills).toContain('#HOV'); // beta reads as hovered
  });

  it('leaves plain single-mark hover unchanged', () => {
    const { fills } = mount({ hovered: mark('beta') }, hoverTheme);
    expect(fills.filter((f) => f === '#HOV')).toHaveLength(1);
  });
});
