import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
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
 * [PND-AXISHIDE] — `<YAxis hide>` keeps the scale and drops the gutter.
 *
 * The gap this closes is a **combination**, not a feature: a caller could get
 * "auto domain, no gutter" (omit the axis) or "explicit domain, with a gutter"
 * (`<YAxis min max />`), but the pairing a fixed-domain chart needs — explicit
 * domain, no gutter — was unreachable. So the tests that matter are the two
 * halves *together*: the domain must survive, and the width must go.
 */

const categories = [
  { label: 'a', value: 1 },
  { label: 'b', value: 2 },
];

/** Mount and hand back the row frame + the rendered container element. */
function mount(axis: React.ReactNode) {
  let rf: RowFrame | null = null;
  let cf: ContainerFrame | null = null;
  function Capture() {
    const r = useContext(RowContext);
    const c = useContext(ContainerContext);
    useEffect(() => {
      if (r) rf = r;
      if (c) cf = c;
    });
    return null;
  }
  const stub = stubCanvasContext();
  let dom: HTMLElement;
  try {
    const { container } = render(
      <ChartContainer width={300}>
        <ChartRow height={100}>
          {axis}
          <Layers>
            <BarChart categories={categories} axis="v" />
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    dom = container;
  } finally {
    stub.restore();
  }
  return { row: rf!, container: cf!, dom };
}

describe('<YAxis hide>', () => {
  it('keeps the scale — the explicit domain still resolves', () => {
    const { row } = mount(<YAxis id="v" min={-3.5} max={3.5} hide />);
    const scale = row.yScales.get('v');
    expect(scale).toBeDefined();
    expect(scale!.domain()).toEqual([-3.5, 3.5]);
  });

  it('gives the gutter width back to the plot', () => {
    const shown = mount(<YAxis id="v" min={-3.5} max={3.5} />);
    const hidden = mount(<YAxis id="v" min={-3.5} max={3.5} hide />);
    // The default gutter is 50px; hiding it must return exactly that, not
    // merely blank it (which is what `color` or `label=""` would do).
    expect(hidden.container.plotWidth).toBe(shown.container.plotWidth + 50);
  });

  it('renders no tick labels', () => {
    // Scoped to the axis's own numbers: the row still renders the category
    // names for the bar layer, which `hide` has nothing to do with.
    const shown = mount(<YAxis id="v" min={0} max={10} />);
    const hidden = mount(<YAxis id="v" min={0} max={10} hide />);
    expect(shown.dom.textContent).toContain('10');
    expect(hidden.dom.textContent).not.toContain('10');
  });

  it('is not the same as omitting the axis, which loses the domain', () => {
    // The distinction the prop exists for: an omitted axis gets an implicit
    // auto-domain, so the fixed [-3.5, 3.5] scale is gone.
    const hidden = mount(<YAxis id="v" min={-3.5} max={3.5} hide />);
    let rf: RowFrame | null = null;
    function Capture() {
      const r = useContext(RowContext);
      useEffect(() => {
        if (r) rf = r;
      });
      return null;
    }
    const stub = stubCanvasContext();
    try {
      render(
        <ChartContainer width={300}>
          <ChartRow height={100}>
            <Layers>
              <BarChart categories={categories} />
              <Capture />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    const implicit = [...rf!.yScales.values()][0]!;
    expect(implicit.domain()).not.toEqual([-3.5, 3.5]);
    expect(hidden.row.yScales.get('v')!.domain()).toEqual([-3.5, 3.5]);
  });

  it('still resolves an auto domain when min/max are omitted', () => {
    // `hide` is about the gutter, not the domain — auto-fit is untouched.
    const { row } = mount(<YAxis id="v" hide />);
    const [lo, hi] = row.yScales.get('v')!.domain();
    expect(lo).toBeLessThanOrEqual(0);
    expect(hi).toBeGreaterThanOrEqual(2);
  });

  it('leaves a visible axis unchanged when hide is false', () => {
    const a = mount(<YAxis id="v" min={0} max={10} />);
    const b = mount(<YAxis id="v" min={0} max={10} hide={false} />);
    expect(b.container.plotWidth).toBe(a.container.plotWidth);
    expect(b.dom.textContent).toBe(a.dom.textContent);
  });
});
