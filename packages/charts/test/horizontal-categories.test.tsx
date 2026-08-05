import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { XAxis } from '../src/XAxis.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
} from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * [PND-HCAT] — **horizontal categorical bars**, the funnel / ranking shape.
 *
 * `<BarChart categories>` used to throw on `orientation="horizontal"`, so the
 * gallery funnel hand-converted its stages into ordinal bin records *and*
 * hand-built `i + 0.5` y-axis ticks. Now the categories land on y as unit
 * slots and the `<YAxis>` derives one label per category by itself.
 */

// Extra aggregate fields ride along structurally; an inline literal would
// trip excess-property checking, which is the `BinRecord` contract working.
const oneBin = [{ start: 0, end: 1, n: 5 }];

const stages = [
  { label: 'Visited', value: 1000 },
  { label: 'Signed up', value: 420 },
  { label: 'Activated', value: 180 },
  { label: 'Paid', value: 65 },
];

function mount(node: React.ReactNode) {
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
  let dom!: HTMLElement;
  try {
    const res = render(
      <ChartContainer width={400}>
        <ChartRow height={160}>
          <YAxis id="cat" />
          <Layers>
            {node}
            <Capture />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    dom = res.container;
  } finally {
    stub.restore();
  }
  return { container: cf!, row: rf!, dom };
}

describe('<BarChart categories orientation="horizontal">', () => {
  it('renders instead of throwing (the old vertical-only guard)', () => {
    expect(() =>
      mount(
        <BarChart categories={stages} orientation="horizontal" axis="cat" />,
      ),
    ).not.toThrow();
  });

  it('puts the VALUE on the shared x axis, categories on y', () => {
    const { container, row } = mount(
      <BarChart categories={stages} orientation="horizontal" axis="cat" />,
    );
    // A horizontal chart's shared x carries the value, so the container's
    // x-kind is 'value' — NOT the ordinal 'category' a vertical one infers.
    expect(container.xKind).toBe('value');
    // The y domain spans the unit slots, one per category.
    const yScale = row.yScales.get('cat')!;
    expect(yScale.domain()[0]).toBe(0);
    expect(yScale.domain()[1]).toBe(stages.length);
  });

  it('the <YAxis> labels one tick per category, no hand-built ticks', () => {
    const { dom } = mount(
      <BarChart categories={stages} orientation="horizontal" axis="cat" />,
    );
    const text = dom.textContent ?? '';
    for (const s of stages) expect(text).toContain(s.label);
  });

  it('an explicit <YAxis ticks> still wins over the derived labels', () => {
    let rf: RowFrame | null = null;
    function Capture() {
      const r = useContext(RowContext);
      useEffect(() => {
        if (r) rf = r;
      });
      return null;
    }
    const stub = stubCanvasContext();
    let dom!: HTMLElement;
    try {
      const res = render(
        <ChartContainer width={400}>
          <ChartRow height={160}>
            <YAxis id="cat" ticks={[{ at: 0.5, label: 'ONLY' }]} />
            <Layers>
              <BarChart
                categories={stages}
                orientation="horizontal"
                axis="cat"
              />
              <Capture />
            </Layers>
          </ChartRow>
          <XAxis />
        </ChartContainer>,
      );
      dom = res.container;
    } finally {
      stub.restore();
    }
    void rf;
    expect(dom.textContent).toContain('ONLY');
    expect(dom.textContent).not.toContain('Activated');
  });

  it('a VERTICAL categorical chart is unchanged (categories on x)', () => {
    const { container } = mount(<BarChart categories={stages} axis="cat" />);
    expect(container.xKind).toBe('category');
  });

  it('a non-categorical row keeps its numeric y ticks', () => {
    const { dom } = mount(
      <BarChart bins={oneBin} column="n" orientation="horizontal" axis="cat" />,
    );
    // No category names to derive from, so the axis labels numbers as before.
    expect(dom.textContent).not.toContain('Visited');
  });
});

describe('[PND-HCAT] gridlines follow the labels', () => {
  it('a horizontal categorical y axis draws no horizontal gridlines', () => {
    // The `<YAxis>` labels slot CENTRES (i + 0.5) while d3's auto ticks fall
    // on slot boundaries, so drawing them would mismatch the labels and
    // stripe every bar. Suppressed, exactly as the categorical x axis is.
    const { row } = mount(
      <BarChart categories={stages} orientation="horizontal" axis="cat" />,
    );
    // No explicit ticks were given, and the layer is categorical…
    expect(row.tickValues.get('cat')).toBeUndefined();
    expect(
      row.layers.some((e) => (e.layer.binCategories?.() ?? null) !== null),
    ).toBe(true);
  });

  it('an explicit <YAxis ticks> still drives gridlines (labels align)', () => {
    const stub = stubCanvasContext();
    let rf: RowFrame | null = null;
    function Capture() {
      const r = useContext(RowContext);
      useEffect(() => {
        if (r) rf = r;
      });
      return null;
    }
    try {
      render(
        <ChartContainer width={400}>
          <ChartRow height={160}>
            <YAxis id="cat" ticks={[{ at: 1, label: 'one' }]} />
            <Layers>
              <BarChart
                categories={stages}
                orientation="horizontal"
                axis="cat"
              />
              <Capture />
            </Layers>
          </ChartRow>
          <XAxis />
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    expect(rf!.tickValues.get('cat')).toEqual([1]);
  });
});
