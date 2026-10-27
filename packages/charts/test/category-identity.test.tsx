import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartContainer, type CategoryEntry } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { CategoryAxis } from '../src/CategoryAxis.js';
import { Selector } from '../src/selectors.js';
import { YAxis } from '../src/YAxis.js';
import { scaleBand } from '../src/bandScale.js';
import { sameMark, selectionContains } from '../src/span.js';
import { useChartFrame, type ChartBands } from '../src/useChartFrame.js';
import {
  categoryStack,
  categoryStacks,
  type CategoryDatum,
} from '../src/data.js';
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
 * [PND-CATID] — a category's `key` is its identity, its `label` is what is
 * drawn. Before the split, the label was both, so two categories rendering
 * the same string merged into one mark (SPARC hit this twice in a week).
 */

// Two categories that RENDER the same string — the case that used to merge.
const DUP: CategoryDatum[] = [
  { key: 'q1-2025', label: 'Q1', value: 3 },
  { key: 'q1-2026', label: 'Q1', value: 5 },
  { key: 'q2-2026', label: 'Q2', value: 4 },
];

describe('the reader', () => {
  it('puts keys in `marks` and labels in `markLabels`', () => {
    const ss = categoryStack(DUP);
    expect(ss.marks).toEqual(['q1-2025', 'q1-2026', 'q2-2026']);
    expect(ss.markLabels).toEqual(['Q1', 'Q1', 'Q2']);
  });

  it('builds the very same series for a list without keys', () => {
    // `key` defaults to `label`, and an unkeyed list gains no field — every
    // existing caller's series is unchanged, not merely equivalent.
    const ss = categoryStack([
      { label: 'a', value: 1 },
      { label: 'b', value: 2 },
    ]);
    expect(ss.marks).toEqual(['a', 'b']);
    expect('markLabels' in ss).toBe(false);
  });

  it('the stacked reader builds the same series for a list without keys', () => {
    const ss = categoryStacks([{ label: 'a', values: { x: 1 } }], ['x']);
    expect(ss.marks).toEqual(['a']);
    expect('markLabels' in ss).toBe(false);
  });

  it('the stacked reader splits the same way', () => {
    const ss = categoryStacks(
      [
        { key: 'x1', label: 'X', values: { a: 1 } },
        { key: 'x2', label: 'X', values: { a: 2 } },
      ],
      ['a'],
    );
    expect(ss.marks).toEqual(['x1', 'x2']);
    expect(ss.markLabels).toEqual(['X', 'X']);
  });

  it('the band scale names a slot by label and identifies it by key', () => {
    const s = scaleBand(['k1', 'k2'], ['Same', 'Same']).domain([0, 2]);
    expect([s.label(0.5), s.label(1.5)]).toEqual(['Same', 'Same']);
    expect([s.key(0.5), s.key(1.5)]).toEqual(['k1', 'k2']);
    // Labels omitted: each key is its own label, as before.
    const plain = scaleBand(['a']).domain([0, 1]);
    expect([plain.label(0.5), plain.key(0.5)]).toEqual(['a', 'a']);
    // `copy` keeps the labels.
    expect(s.copy().label(1.5)).toBe('Same');
  });
});

function mount(
  node: React.ReactNode,
  options: { categories?: readonly (string | CategoryEntry)[] } = {},
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
  let root: ReturnType<typeof render>;
  try {
    root = render(
      <ChartContainer
        width={400}
        showAxis={false}
        {...(options.categories ? { categories: options.categories } : {})}
      >
        {node}
        <ChartRow height={160}>
          <YAxis id="v" min={0} max={10} label="" />
          <Layers>
            <BarChart
              categories={DUP}
              axis="v"
              id="q"
              colors={{ value: '#aa0000' }}
            />
            <Capture />
          </Layers>
          <CategoryAxis />
        </ChartRow>
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  return {
    text: () => root.container.textContent ?? '',
    frame: () => cf!,
    row: () => rf!,
    fills(): string[] {
      const { ctx, calls } = recordingContext();
      rf!.layers[0]!.layer.draw(ctx, cf!.xScale, rf!.yScales.get('v')!);
      return calls
        .filter((c) => c.type === 'set' && c.name === 'fillStyle')
        .map((c) => String(c.args[0]));
    },
  };
}

const pick = (mark: string): SelectInfo => ({
  id: 'q',
  key: 0,
  value: 0,
  color: '#000',
  label: '',
  mark,
});

describe('the chart', () => {
  it('the axis draws labels, never keys', () => {
    const m = mount(null);
    expect(m.text()).toContain('Q1');
    expect(m.text()).toContain('Q2');
    expect(m.text()).not.toContain('q1-2025');
  });

  it('two categories sharing a label select independently', () => {
    // Selecting the 2026 Q1 bar recedes the other two — including the 2025
    // Q1 bar that draws the same string. Keyed on the label, both Q1 bars
    // would have lit and only Q2 receded.
    const m = mount(<Selector enabled={false} selected={[pick('q1-2026')]} />);
    const dim = defaultTheme.bar.default.dimmed!;
    expect(m.fills().filter((f) => f === dim)).toHaveLength(2);
  });

  it('a hit reports the key as `mark` and the label as `label`', () => {
    const m = mount(null);
    const cf = m.frame();
    const layer = m.row().layers[0]!.layer;
    const y = m.row().yScales.get('v')!;
    // Centre of slot 1, a little above the baseline — inside the bar.
    const hit = layer.hitTest!(cf.xScale(1.5), y(1), cf.xScale, y, 'select');
    expect(hit?.mark).toBe('q1-2026');
    expect(hit?.label).toBe('Q1');
  });

  it('`useChartFrame().bands` exposes both, slot-aligned', () => {
    let bands: ChartBands | null = null;
    function Probe() {
      const f = useChartFrame();
      useEffect(() => {
        bands = f.bands;
      });
      return null;
    }
    mount(<Probe />);
    expect(bands!.keys).toEqual(['q1-2025', 'q1-2026', 'q2-2026']);
    expect(bands!.labels).toEqual(['Q1', 'Q1', 'Q2']);
    expect(bands!.at(1)).toMatchObject({ key: 'q1-2026', label: 'Q1' });
  });

  it('the container declares `{ key, label }` slots, agreeing on keys', () => {
    const m = mount(null, {
      categories: [
        { key: 'q1-2025', label: 'Q1 ’25' },
        { key: 'q1-2026', label: 'Q1 ’26' },
        'q2-2026',
      ],
    });
    // The container's labels win where it declares them; a bare-string entry
    // declares only the slot, so that one keeps the bar's own label.
    expect(m.text()).toContain('Q1 ’25');
    expect(m.text()).toContain('Q2');
    expect(m.text()).not.toContain('q2-2026');
  });

  it('a container list that disagrees on keys still throws', () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(() => mount(null, { categories: ['Q1', 'Q1', 'Q2'] })).toThrow(
        /disagree/,
      );
    } finally {
      console.error = quiet;
    }
  });

  it('a hit-built entry round-trips through `selectionContains`', () => {
    // The toggle recipe: an entry built from a hit must be found by the next
    // hit on the same bar, and NOT by a hit on the other bar drawing 'Q1'.
    const m = mount(null);
    const cf = m.frame();
    const layer = m.row().layers[0]!.layer;
    const y = m.row().yScales.get('v')!;
    const hitAt = (slot: number) =>
      layer.hitTest!(cf.xScale(slot + 0.5), y(1), cf.xScale, y, 'select')!;
    const sel = [hitAt(1)];
    expect(selectionContains(sel, hitAt(1))).toBe(true);
    expect(selectionContains(sel, hitAt(0))).toBe(false);
    expect(sameMark(hitAt(0), hitAt(1))).toBe(false);
  });
});

describe('the stacked chart', () => {
  it('a keyed stack selects the whole bar by key, not by label', () => {
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
        <ChartContainer width={400} showAxis={false}>
          <Selector enabled={false} selected={[pick('b')]} />
          <ChartRow height={160}>
            <YAxis id="v" min={0} max={10} label="" />
            <Layers>
              <BarChart
                categories={[
                  { key: 'a', label: 'Same', values: { x: 1, y: 2 } },
                  { key: 'b', label: 'Same', values: { x: 2, y: 1 } },
                ]}
                columns={['x', 'y']}
                colors={{ x: '#aa0000', y: '#0000aa' }}
                axis="v"
                id="q"
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
    rf!.layers[0]!.layer.draw(ctx, cf!.xScale, rf!.yScales.get('v')!);
    const dim = defaultTheme.bar.default.dimmed!;
    // Bar 'a' (two segments) recedes; bar 'b', which draws the same label,
    // does not.
    expect(
      calls.filter(
        (c) => c.type === 'set' && c.name === 'fillStyle' && c.args[0] === dim,
      ),
    ).toHaveLength(2);
  });
});
