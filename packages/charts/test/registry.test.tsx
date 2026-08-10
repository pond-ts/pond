import { useContext } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { BoxPlot } from '../src/BoxPlot.js';
import { Selector } from '../src/selectors.js';
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
      <ChartContainer range={[0, 3]} width={300}>
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
      <ChartContainer range={[0, 3]} width={300}>
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
      <ChartContainer range={[0, 3]} width={300}>
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
 * A `<Fragment>` child of `<Layers>` takes no props, so the injected z-order
 * index dies on it and every layer inside falls back to `index = 0`. The sort
 * is stable, so the tie resolves to *mount* order — which for a synchronous
 * tree matches declaration order, and that is what makes this silent: the stack
 * looks correct right up to the moment mount order and declaration order
 * disagree.
 *
 * Found by the React console warning (`Invalid prop 'index' supplied to
 * React.Fragment`) while walking the interaction stories, and it had already
 * reached two places that *demonstrate* ordering: the `LineSweep` story and the
 * reviewer-mandated `spans[0]` ordering test in `trace-selection.test.tsx`.
 */
describe('a fragment child of <Layers> swallows the injected index', () => {
  /** The toggle from the test above — the only probe that separates the two. */
  const slotting = (wrap: (kids: React.ReactNode[]) => React.ReactNode) => {
    const spy = vi.fn();
    const sA = mk([1, 2, 3]);
    const sM = mk([4, 5, 6]);
    const sB = mk([7, 8, 9]);
    const tree = (showMiddle: boolean) => (
      <ChartContainer range={[0, 3]} width={300}>
        <ChartRow height={100}>
          <Layers>
            {wrap([
              <LineChart key="a" series={sA} column="v" axis="a" />,
              showMiddle ? (
                <LineChart key="m" series={sM} column="v" axis="m" />
              ) : null,
              <LineChart key="b" series={sB} column="v" axis="b" />,
            ])}
          </Layers>
          <Probe spy={spy} />
        </ChartRow>
      </ChartContainer>
    );
    const { rerender } = render(tree(false));
    rerender(tree(true)); // 'm' mounts LAST, declared in the MIDDLE
    return last(spy).order as (string | undefined)[];
  };

  it('a keyed array keeps the slotting guarantee', () => {
    expect(slotting((kids) => kids)).toEqual(['a', 'm', 'b']);
  });

  it('a fragment loses it — the late layer lands on top', () => {
    // The failure the warning exists to name. Not an assertion of desired
    // behaviour: it pins that the fragment path really does degrade to mount
    // order, which is why listing layers directly is a documented requirement
    // rather than a style preference.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(slotting((kids) => <>{kids}</>)).toEqual(['a', 'b', 'm']);
    } finally {
      warn.mockRestore();
    }
  });

  it('warns once per <Layers>, naming the consequence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      slotting((kids) => <>{kids}</>);
      const hits = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('swallows the injected declaration index'));
      // One `<Layers>`, one warning — the re-render that mounts 'm' must not
      // add a second (the ref guard), or a live chart would spam the console.
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('mount order');
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing when the layers are direct children', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      slotting((kids) => kids);
      expect(
        warn.mock.calls.filter((c) =>
          String(c[0]).includes('swallows the injected declaration index'),
        ),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * `<ChartRow>` injects the same index into its axes, and a fragment there costs
 * **more** than in `<Layers>`: the axes lose their declaration order *and* the
 * `child.type === YAxis` side-sort cannot see through the fragment, so they land
 * in the plot column instead of a gutter. Reviewer finding on the `<Layers>`
 * fix — one bug class, two injection sites, and only one had been fixed.
 */
describe('a fragment child of <ChartRow> swallows the injected index', () => {
  /** Labelled so `getByText` can locate each axis for a placement assertion. */
  const labelledRow = (wrap: (kids: React.ReactNode[]) => React.ReactNode) => (
    <ChartContainer range={[0, 3]} width={400}>
      <ChartRow height={100}>
        {wrap([
          <YAxis key="a" id="a" label="left-axis" min={0} max={10} />,
          <YAxis
            key="b"
            id="b"
            side="right"
            label="right-axis"
            min={0}
            max={10}
          />,
        ])}
        <Layers>
          <LineChart series={mk([1, 2, 3])} column="v" axis="a" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );

  it('warns, naming the placement consequence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(labelledRow((kids) => <>{kids}</>));
      const hits = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('<ChartRow>'));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('gutter');
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing when the axes are direct children', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(labelledRow((kids) => kids));
      expect(
        warn.mock.calls.filter((c) => String(c[0]).includes('<ChartRow>')),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('a fragment really does misplace the axes', () => {
    // The consequence the message claims, pinned rather than asserted in prose:
    // a right-side axis wrapped in a fragment renders *before* the plot instead
    // of after it, because the side sort never sees a `<YAxis>` to sort.
    // Same `compareDocumentPosition` idiom as `axis placement by side` below,
    // which is the reliable way to read placement out of this row.
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const direct = render(labelledRow((kids) => kids));
      const canvasD = direct.container.querySelector('canvas')!;
      // Direct children: the right axis follows the plot, as `side` promises.
      expect(
        canvasD.compareDocumentPosition(direct.getByText('right-axis')) &
          FOLLOWING,
      ).toBeTruthy();
      cleanup();

      const wrapped = render(labelledRow((kids) => <>{kids}</>));
      const canvasW = wrapped.container.querySelector('canvas')!;
      // Wrapped: it precedes the plot — never sorted into the right gutter.
      expect(
        canvasW.compareDocumentPosition(wrapped.getByText('right-axis')) &
          FOLLOWING,
      ).toBeFalsy();
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * The registration value-equality guard (F-charts-axis-reregister): a `<YAxis>`
 * / draw layer re-fires its register effect whenever its memoized spec yields a
 * fresh object — which an inline `ticks={[]}` / `format` or a re-rendered parent
 * does every render. The setters must **no-op when the spec is value-equal** to
 * the stored one, so registration can't spin `register → setState → re-render →
 * register` into a "Maximum update depth exceeded" loop on a scrub-heavy chart.
 * We observe the guard through the row's derived `yScales` / `layers`: a no-op'd
 * register preserves the registry map identity, so those memos keep the same
 * reference across a value-equal re-render.
 */
describe('registration value-equality guard', () => {
  function FrameProbe({
    spy,
  }: {
    spy: (frame: { yScales: unknown; layers: unknown }) => void;
  }) {
    const row = useContext(RowContext);
    if (row) spy({ yScales: row.yScales, layers: row.layers });
    return null;
  }

  it('does not re-register an axis when a fresh but value-equal ticks/format is passed', () => {
    const spy = vi.fn();
    const seriesA = mk([1, 2, 3]); // stable ref across rerenders
    // Fresh `ticks={[]}` array + inline string `format` each render — both
    // value-equal, the common live-chart footgun.
    const tree = () => (
      <ChartContainer range={[0, 3]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} format=".0f" ticks={[]} />
          <Layers>
            <LineChart series={seriesA} column="v" axis="a" />
          </Layers>
          <FrameProbe spy={spy} />
        </ChartRow>
      </ChartContainer>
    );
    const { rerender } = render(tree());
    const before = last(spy) as { yScales: unknown; layers: unknown };
    rerender(tree()); // fresh [] + fresh element props, value-equal
    const after = last(spy) as { yScales: unknown; layers: unknown };
    // The guard no-op'd both setters, so the derived scale/layer maps kept
    // identity — no registry churn from the value-equal re-render.
    expect(after.yScales).toBe(before.yScales);
    expect(after.layers).toBe(before.layers);
  });

  it('DOES re-register when tick contents genuinely change', () => {
    const spy = vi.fn();
    const seriesA = mk([1, 2, 3]);
    const tree = (ticks: { at: number; label: string }[]) => (
      <ChartContainer range={[0, 3]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} ticks={ticks} />
          <Layers>
            <LineChart series={seriesA} column="v" axis="a" />
          </Layers>
          <FrameProbe spy={spy} />
        </ChartRow>
      </ChartContainer>
    );
    const { rerender } = render(tree([{ at: 2, label: '2' }]));
    const before = last(spy) as { yScales: unknown };
    rerender(tree([{ at: 5, label: '5' }])); // different tick position
    const after = last(spy) as { yScales: unknown };
    expect(after.yScales).not.toBe(before.yScales); // the real change registered
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
      <ChartContainer range={[0, 3]} width={400}>
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
        range={[0, 4]}
        width={300}
        cursor="flag"
        trackerPosition={2}
      >
        <ChartRow height={120}>
          {/* tickCount=5 ⇒ ticks 0/2/4/6/8/10 — so the sampled value 5 is not a
              tick label and the chip text below is unambiguous. */}
          <YAxis id="a" min={0} max={10} tickCount={5} />
          <Layers>
            {/* value 5 at t=2 — not a tick, so the chip text is unambiguous. */}
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
        range={[0, 4]}
        width={300}
        cursor="flag"
        cursorTime
        timeFormat={() => 'TIME'}
        trackerPosition={2}
        // No time axis, so the sentinel 'TIME' comes only from the cursor chip
        // (the formatter is shared with the axis ticks by design — #269).
        showAxis={false}
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
        range={[0, 20]}
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

/**
 * `<Selector>` became a legitimate `<ChartRow>` child when it gained `children`
 * (RFC A10.1) — and immediately became a new way to trip the same trap the
 * fragment guard exists for: `<ChartRow>` places axes by matching
 * `child.type === YAxis`, so an axis nested inside ANY wrapper is invisible to
 * that sort and lands in the plot column. The fragment warning cannot catch it
 * (a selector is a real element), and the failure is silent. Reviewer finding
 * on #638.
 */
describe('a <YAxis> nested inside a row-child wrapper', () => {
  const wrapped = (
    <ChartContainer range={[0, 3]} width={400}>
      <ChartRow height={100}>
        <Selector>
          <YAxis id="a" label="left-axis" min={0} max={10} />
          <Layers>
            <LineChart series={mk([1, 2, 3])} column="v" axis="a" />
          </Layers>
        </Selector>
      </ChartRow>
    </ChartContainer>
  );

  const direct = (
    <ChartContainer range={[0, 3]} width={400}>
      <ChartRow height={100}>
        <YAxis id="a" label="left-axis" min={0} max={10} />
        <Selector>
          <Layers>
            <LineChart series={mk([1, 2, 3])} column="v" axis="a" />
          </Layers>
        </Selector>
      </ChartRow>
    </ChartContainer>
  );

  it('warns, naming the gutter consequence', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(wrapped);
      const hits = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('nested inside another element'));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain('gutter');
      expect(hits[0]).toContain('<Layers>');
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing when the selector wraps only <Layers> — the correct shape', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(direct);
      expect(
        warn.mock.calls.filter((c) =>
          String(c[0]).includes('nested inside another element'),
        ),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});
