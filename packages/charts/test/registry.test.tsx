import { useContext } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { BoxPlot } from '../src/BoxPlot.js';
import { YAxis } from '../src/YAxis.js';
import { RowContext } from '../src/context.js';

afterEach(cleanup);

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;
const mk = (vals: number[]) =>
  new TimeSeries({
    name: 't',
    schema,
    rows: vals.map((v, i) => [i, v] as [number, number]),
  });

/** Reads the row frame each render so a test can assert the *last* settled state. */
function Probe({
  spy,
}: {
  spy: (frame: {
    defaultAxisId: string;
    order: (string | undefined)[];
  }) => void;
}) {
  const row = useContext(RowContext);
  if (row)
    spy({
      defaultAxisId: row.defaultAxisId,
      order: row.layers.map((e) => e.axisId),
    });
  return null;
}
const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0];

/**
 * Regression tests for the registry order-stability fix (Codex finding):
 * re-registering on a prop change must update an entry *in place*, not
 * unregister-and-append — otherwise a normal `min`/`max` change rebinds the
 * default axis and a series change reorders the z-stack.
 */
describe('registry order stability', () => {
  it('keeps the default axis stable when the first axis updates', () => {
    const spy = vi.fn();
    const tree = (aMin: number) => (
      <ChartContainer timeRange={[0, 3]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" min={aMin} max={100} />
          <YAxis id="b" min={0} max={10} />
          <Probe spy={spy} />
        </ChartRow>
      </ChartContainer>
    );
    const { rerender } = render(tree(0));
    expect(last(spy).defaultAxisId).toBe('a'); // first declared = default

    spy.mockClear();
    rerender(tree(-100)); // change ONLY the first axis's min
    expect(last(spy).defaultAxisId).toBe('a'); // did not jump to 'b'
  });

  it('keeps layer z-order stable when one layer updates', () => {
    const spy = vi.fn();
    const seriesB = mk([1, 2, 3]); // stable across rerenders
    const tree = (seriesA: ReturnType<typeof mk>) => (
      <ChartContainer timeRange={[0, 3]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" />
          <YAxis id="b" side="right" />
          <Layers>
            <LineChart series={seriesA} column="v" axis="a" />
            <LineChart series={seriesB} column="v" axis="b" />
          </Layers>
          <Probe spy={spy} />
        </ChartRow>
      </ChartContainer>
    );
    const { rerender } = render(tree(mk([3, 2, 1])));
    expect(last(spy).order).toEqual(['a', 'b']); // declaration order

    spy.mockClear();
    rerender(tree(mk([5, 6, 7]))); // new series object for the FIRST layer only
    expect(last(spy).order).toEqual(['a', 'b']); // z-order held (not ['b','a'])
  });

  it('orders layers by declaration position, not mount order', () => {
    const spy = vi.fn();
    const sA = mk([1, 2, 3]);
    const sM = mk([4, 5, 6]);
    const sB = mk([7, 8, 9]);
    const tree = (showMiddle: boolean) => (
      <ChartContainer timeRange={[0, 3]} width={300}>
        <ChartRow height={100}>
          <Layers>
            <LineChart series={sA} column="v" axis="a" />
            {showMiddle && <LineChart series={sM} column="v" axis="m" />}
            <LineChart series={sB} column="v" axis="b" />
          </Layers>
          <Probe spy={spy} />
        </ChartRow>
      </ChartContainer>
    );
    const { rerender } = render(tree(false));
    expect(last(spy).order).toEqual(['a', 'b']);

    spy.mockClear();
    rerender(tree(true)); // 'm' mounts LAST but is declared between a and b
    // Slots into its JSX position, not appended on top (which mount order gives).
    expect(last(spy).order).toEqual(['a', 'm', 'b']);
  });
});

/**
 * Placement follows `side`, not JSX author order — so a `side="right"` axis
 * renders right of the plot even when authored before `<Layers>`, keeping the
 * DOM position consistent with the side-based gutter reservation.
 */
describe('axis placement by side', () => {
  const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

  it('renders a side="right" axis after the plot even when authored before <Layers>', () => {
    const { container, getByText } = render(
      <ChartContainer timeRange={[0, 3]} width={400}>
        <ChartRow height={100}>
          <YAxis id="L" label="left-axis" min={0} max={10} />
          {/* authored BEFORE <Layers>, but side="right" must win */}
          <YAxis id="R" side="right" label="right-axis" min={0} max={10} />
          <Layers>
            <LineChart series={mk([1, 2, 3])} column="v" axis="L" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const canvas = container.querySelector('canvas')!;
    const leftLabel = getByText('left-axis');
    const rightLabel = getByText('right-axis');
    // left axis precedes the plot; right axis follows it (DOM order = visual L→R).
    expect(leftLabel.compareDocumentPosition(canvas) & FOLLOWING).toBeTruthy(); // canvas follows the left axis
    expect(canvas.compareDocumentPosition(rightLabel) & FOLLOWING).toBeTruthy(); // right axis follows the canvas
  });
});

/**
 * The cursor renders as a DOM/SVG overlay (no second canvas): an SVG holds the
 * dots + flag staffs, the value flag is a DOM chip. A controlled `trackerPosition`
 * drives it without a pointer. (Also a no-throw guard — the tracker reads
 * `sampleAt`, the path that once crashed on a detached `Event.get`.)
 */
describe('cursor overlay (flag, DOM/SVG)', () => {
  it('renders the SVG dot + staff and the DOM value flag at a controlled cursor', () => {
    const { container, getByText } = render(
      <ChartContainer
        timeRange={[0, 4]}
        width={300}
        cursor="flag"
        trackerPosition={2}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={10} />
          <Layers>
            {/* value 5 at t=2 — not a tick of [0,10] (0,2,4,6,8,10), so the chip
                text is unambiguous. */}
            <LineChart series={mk([1, 3, 5, 7, 9])} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    // SVG marks (no cursor canvas): a dot + a staff for the single series.
    expect(
      container.querySelectorAll('svg circle').length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      container.querySelectorAll('svg line').length,
    ).toBeGreaterThanOrEqual(1);
    // The value flag (DOM chip) reads the sampled value at t=2.
    expect(getByText('5')).toBeTruthy();
  });
});

/**
 * The cursor-time chip is shared across rows (one cursor, one time), so it
 * renders **once — atop the first (topmost) row** — not repeated per row. A
 * sentinel `timeFormat` fn makes the assertion timezone-independent. (Pins the
 * mount-order `registerRow` → `firstRowKey` → `isFirstRow` path.)
 */
describe('cursor-time renders on the first row only', () => {
  it('shows the time chip once across two rows, with a flag on each', () => {
    const { getByText, getAllByText } = render(
      <ChartContainer
        timeRange={[0, 4]}
        width={300}
        cursor="flag"
        cursorTime
        timeFormat={() => 'TIME'}
        trackerPosition={2}
        // No time axis, so the sentinel 'TIME' comes only from the cursor chip
        // (the formatter is shared with the axis ticks by design — #269).
        timeAxis={false}
      >
        <ChartRow height={100}>
          {/* value 3 at t=2 — not a tick of [0,10] (0,2,4,6,8,10). */}
          <YAxis id="a" min={0} max={10} />
          <Layers>
            <LineChart series={mk([1, 2, 3, 4, 5])} column="v" axis="a" />
          </Layers>
        </ChartRow>
        <ChartRow height={100}>
          {/* value 7 at t=2 — not a tick of [0,20] (0,5,10,15,20) or [0,10]. */}
          <YAxis id="b" min={0} max={20} />
          <Layers>
            <LineChart series={mk([5, 6, 7, 8, 9])} column="v" axis="b" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    // Both rows draw a value flag at t=2 — so both have an active cursor...
    expect(getByText('3')).toBeTruthy();
    expect(getByText('7')).toBeTruthy();
    // ...but the shared time chip renders exactly once (the first row).
    expect(getAllByText('TIME')).toHaveLength(1);
  });
});

/**
 * The box cursor's `flag` is a **consolidated** flag — all five quantiles on one
 * chip at the box's top-centre (`RowLayer.cursorFlag`), each value coloured to
 * its piece, with a single staff. Unlike the per-sample flag (a chip per series),
 * the box draws no per-quantile dots.
 */
describe('box cursor — consolidated flag (all values, one chip)', () => {
  const boxSeries = new TimeSeries({
    name: 'b',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'lo', kind: 'number' },
      { name: 'q1', kind: 'number' },
      { name: 'med', kind: 'number' },
      { name: 'q3', kind: 'number' },
      { name: 'hi', kind: 'number' },
    ] as const,
    rows: [
      // box 0 spans [0,10] — quantiles chosen to miss the [0,100] axis ticks.
      [[0, 10], 11, 22, 33, 37, 44],
      [[10, 20], 1, 2, 3, 4, 5],
    ] as never,
  });

  it('renders one multi-line flag at a controlled cursor, no per-quantile dots', () => {
    const { container, getByText } = render(
      <ChartContainer
        timeRange={[0, 20]}
        width={300}
        cursor="flag"
        trackerPosition={5} // inside box 0 ([0,10])
      >
        <ChartRow height={200}>
          <YAxis id="a" min={0} max={100} />
          <Layers>
            <BoxPlot
              series={boxSeries}
              lower="lo"
              q1="q1"
              median="med"
              q3="q3"
              upper="hi"
              axis="a"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    // All five of box 0's values on one flag (box 1's values don't appear).
    for (const v of ['11', '22', '33', '37', '44']) {
      expect(getByText(v)).toBeTruthy();
    }
    // A staff (SVG line) rises to the flag; the box draws no per-quantile dots.
    expect(
      container.querySelectorAll('svg line').length,
    ).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('svg circle').length).toBe(0);
  });
});
