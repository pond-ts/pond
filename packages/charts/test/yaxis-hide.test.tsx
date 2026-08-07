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

describe('a hidden axis still holds its column in a multi-row container', () => {
  /**
   * Found by the Codex adversarial pass. The container reserves each axis
   * *column* at the widest across rows (`maxSlotWidths`), so a hidden axis
   * sharing a column with a visible one is still allotted that column's width
   * — but returning `null` rendered no box for it, so the row's plot slid left
   * and stopped lining up with its siblings and the shared x-axis. A hidden
   * axis must reserve nothing *of its own* while still honouring a column
   * another row is paying for.
   */
  function renderTwoRows() {
    const stub = stubCanvasContext();
    try {
      const { container } = render(
        <ChartContainer width={400}>
          <ChartRow height={80}>
            <YAxis id="a" min={0} max={10} label="" />
            <Layers>
              <BarChart categories={categories} axis="a" />
            </Layers>
          </ChartRow>
          <ChartRow height={80}>
            <YAxis id="b" min={0} max={10} label="" hide />
            <Layers>
              <BarChart categories={categories} axis="b" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
      return container;
    } finally {
      stub.restore();
    }
  }

  /** Every `flex: 0 0 Npx` reservation in the tree, in document order. */
  const flexBasisPx = (root: HTMLElement): number[] =>
    Array.from(root.querySelectorAll<HTMLElement>('div'))
      .map((d) => /^0 0 ([\d.]+)px$/.exec(d.style.flex ?? '')?.[1])
      .filter((v): v is string => v !== undefined)
      .map(Number);

  it('reserves the shared column width rather than collapsing it', () => {
    const reservations = flexBasisPx(renderTwoRows());
    // Two rows, one axis column of 50px: both rows must reserve 50, or their
    // plots do not start at the same x.
    const fifties = reservations.filter((w) => w === 50);
    expect(fifties).toHaveLength(2);
  });

  it('still reclaims the width when no other row needs the column', () => {
    // The single-row case must be unaffected — this is the whole point of the
    // prop, and the multi-row fix must not quietly undo it.
    const shown = mount(<YAxis id="v" min={0} max={10} />);
    const hidden = mount(<YAxis id="v" min={0} max={10} hide />);
    expect(hidden.container.plotWidth).toBe(shown.container.plotWidth + 50);
  });
});
