/**
 * `<ChartContainer height>` + `<ChartRow flex>` — container-owned vertical
 * layout ([PND-HEIGHT]).
 *
 * The design under test is "CSS does the subtraction": a managed container is
 * a flex column (rows block flexes, axis strip keeps natural height), a flex
 * row's box is `flex: n 1 0`, and the row reads back the height layout gave
 * it. happy-dom has no layout engine, so these tests split along that line:
 *
 * - **structural** assertions check the styles that *instruct* the browser —
 *   the flex column, the basis, the `minHeight: 0`s — which is the part pond
 *   owns;
 * - **behavioural** assertions stub `getBoundingClientRect` per element and
 *   check the read-back — measured height → y-scales, the latch, the gates
 *   and the warnings.
 *
 * The real flex arithmetic (does the strip subtraction actually happen) is
 * browser work, verified in Storybook; what CAN drift silently here is the
 * wiring these tests pin.
 */
import { Profiler, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { useChartFrame, type ChartFrame } from '../src/useChartFrame.js';
import { stubCanvasContext } from './canvas-mock.js';

const series = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 1],
      [1000, 5],
    ],
  });

/**
 * Per-element layout stub. happy-dom reports 0 for every rect, so tests
 * assign sizes by *role*, recognized from the styles the implementation sets:
 * the auto-size box is the `width: 100%` div; a flex row is the
 * `flexDirection: row` div with a `flex` shorthand.
 */
let boxSize = { width: 0, height: 0 };
let rowHeights: number[] = [];
let observers: Array<() => void> = [];
let realRO: typeof ResizeObserver | undefined;
let rectSpy: ReturnType<typeof vi.spyOn> | undefined;
const flexRowsSeen: HTMLElement[] = [];

const isAutoBox = (el: HTMLElement) => el.style.width === '100%';
const isFlexRow = (el: HTMLElement) =>
  el.style.flexDirection === 'row' && el.style.flex !== '';

beforeEach(() => {
  boxSize = { width: 0, height: 0 };
  rowHeights = [];
  observers = [];
  flexRowsSeen.length = 0;
  rectSpy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: Element) {
      const el = this as HTMLElement;
      if (isAutoBox(el)) {
        return { width: boxSize.width, height: boxSize.height } as DOMRect;
      }
      if (isFlexRow(el)) {
        let i = flexRowsSeen.indexOf(el);
        if (i === -1) {
          flexRowsSeen.push(el);
          i = flexRowsSeen.length - 1;
        }
        return { width: boxSize.width, height: rowHeights[i] ?? 0 } as DOMRect;
      }
      return { width: 0, height: 0 } as DOMRect;
    });
  realRO = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    #cb: () => void;
    constructor(cb: () => void) {
      this.#cb = cb;
    }
    observe() {
      observers.push(this.#cb);
    }
    disconnect() {
      observers = observers.filter((o) => o !== this.#cb);
    }
    unobserve() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  rectSpy?.mockRestore();
  if (realRO) globalThis.ResizeObserver = realRO;
  vi.restoreAllMocks();
});

const relayout = () =>
  act(() => {
    for (const cb of [...observers]) cb();
  });

function FrameProbe({ into }: { into: { frame: ChartFrame | null } }) {
  const frame = useChartFrame();
  into.frame = frame;
  useEffect(
    () => () => {
      into.frame = null;
    },
    [into],
  );
  return null;
}

function renderChart(ui: React.ReactElement) {
  const stub = stubCanvasContext();
  try {
    return render(ui);
  } finally {
    stub.restore();
  }
}

describe('<ChartContainer height> — the managed column (structure)', () => {
  it('renders a flex column with the rows block flexing and the axis outside it', () => {
    const { container } = renderChart(
      <ChartContainer width={600} height={400}>
        <ChartRow height={200}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const outer = Array.from(container.querySelectorAll('div')).find(
      (d) => d.style.height === '400px',
    )!;
    // The subtraction IS this structure: rows flex, strip doesn't.
    expect(outer.style.display).toBe('flex');
    expect(outer.style.flexDirection).toBe('column');
    const rowsBlock = outer.firstElementChild as HTMLElement;
    expect(rowsBlock.style.flex).toBe('1 1 0%');
    expect(rowsBlock.style.minHeight).toBe('0');
  });

  it('an unmanaged container keeps the classic markup exactly', () => {
    const { container } = renderChart(
      <ChartContainer width={600}>
        <ChartRow height={200}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const outer = Array.from(container.querySelectorAll('div')).find(
      (d) => d.style.width === '600px',
    )!;
    expect(outer.style.display).toBe('');
    expect(outer.style.height).toBe('');
    const rowsBlock = outer.firstElementChild as HTMLElement;
    expect(rowsBlock.style.flex).toBe('');
  });

  it('a fixed row keeps its pixels; a flex row gets a basis and minHeight 0', () => {
    boxSize = { width: 600, height: 400 };
    rowHeights = [220];
    const { container } = renderChart(
      <ChartContainer width={600} height={400}>
        <ChartRow flex={3}>
          <YAxis id="a" />
          <Layers>
            <LineChart series={series()} column="v" axis="a" />
          </Layers>
        </ChartRow>
        <ChartRow height={120}>
          <YAxis id="b" />
          <Layers>
            <LineChart series={series()} column="v" axis="b" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const rows = Array.from(container.querySelectorAll('div')).filter(
      (d) => d.style.flexDirection === 'row',
    );
    expect(rows.some((r) => r.style.flex === '3 1 0%')).toBe(true);
    expect(rows.find((r) => r.style.flex === '3 1 0%')!.style.minHeight).toBe(
      '0',
    );
    expect(rows.some((r) => r.style.height === '120px')).toBe(true);
  });
});

describe('<ChartRow flex> — the read-back (behaviour)', () => {
  it('builds its y-scales from the height layout gave it', () => {
    boxSize = { width: 600, height: 400 };
    rowHeights = [317];
    const got = { frame: null as ChartFrame | null };
    renderChart(
      <ChartContainer width={600} height={400}>
        <ChartRow>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
            <FrameProbe into={got} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    // A bare <ChartRow> is flex={1}; its measured 317 is the scale range.
    expect(got.frame!.row!.height).toBe(317);
    expect(got.frame!.row!.yScales.get('v')!.range()).toEqual([317, 0]);
  });

  it('re-derives the scales when the layout resizes the row', () => {
    boxSize = { width: 600, height: 400 };
    rowHeights = [300];
    const got = { frame: null as ChartFrame | null };
    renderChart(
      <ChartContainer width={600} height={400}>
        <ChartRow>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
            <FrameProbe into={got} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(got.frame!.row!.height).toBe(300);
    rowHeights = [180];
    relayout();
    expect(got.frame!.row!.height).toBe(180);
    expect(got.frame!.row!.yScales.get('v')!.range()).toEqual([180, 0]);
  });

  it('latches its last non-zero height while hidden', () => {
    boxSize = { width: 600, height: 400 };
    rowHeights = [250];
    const got = { frame: null as ChartFrame | null };
    renderChart(
      <ChartContainer width={600} height={400}>
        <ChartRow>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
            <FrameProbe into={got} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const scale = got.frame!.row!.yScales.get('v');
    rowHeights = [0]; // display: none somewhere above
    relayout();
    expect(got.frame!.row!.height).toBe(250);
    expect(got.frame!.row!.yScales.get('v')).toBe(scale);
  });

  it('warns once when a flex row sits in a container that never sizes it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderChart(
      <ChartContainer width={600}>
        <ChartRow flex={1}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const hits = warn.mock.calls.filter(([m]) =>
      String(m).includes('<ChartRow flex> needs a container that manages'),
    );
    expect(hits.length).toBe(1);
  });

  it('warns when both height and flex are given, and honours height', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const got = { frame: null as ChartFrame | null };
    renderChart(
      <ChartContainer width={600} height={400}>
        <ChartRow height={150} flex={2}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
            <FrameProbe into={got} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(
      warn.mock.calls.some(([m]) =>
        String(m).includes('both height={150} and flex={2}'),
      ),
    ).toBe(true);
    expect(got.frame!.row!.height).toBe(150);
  });
});

describe('<ChartContainer height="auto"> — the measure pass', () => {
  it('gates until BOTH needed dimensions exist', () => {
    boxSize = { width: 600, height: 0 };
    const got = { frame: null as ChartFrame | null };
    const { container } = renderChart(
      <ChartContainer width="auto" height="auto">
        <FrameProbe into={got} />
        <ChartRow>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    // Width alone is not enough — a height-managing container without a
    // height would mount every flex row at 0.
    expect(got.frame).toBeNull();
    boxSize = { width: 600, height: 400 };
    rowHeights = [320];
    relayout();
    expect(got.frame).not.toBeNull();
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('height="auto" claims the parent height; width-only auto does not', () => {
    boxSize = { width: 600, height: 400 };
    rowHeights = [300];
    const both = renderChart(
      <ChartContainer width="auto" height="auto">
        <ChartRow>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const box = Array.from(both.container.querySelectorAll('div')).find(
      (d) => d.style.width === '100%',
    )!;
    expect(box.style.height).toBe('100%');
    expect(box.style.minHeight).toBe('0');
    cleanup();

    // Width-only: the box must keep its intrinsic height, or every
    // pre-[PND-HEIGHT] auto-width consumer's layout changes underneath them.
    boxSize = { width: 600, height: 0 };
    const widthOnly = renderChart(
      <ChartContainer width="auto">
        <ChartRow height={200}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const wbox = Array.from(widthOnly.container.querySelectorAll('div')).find(
      (d) => d.style.width === '100%',
    )!;
    expect(wbox.style.height).toBe('');
  });

  it('a numeric width with height="auto" measures height only', () => {
    boxSize = { width: 0, height: 400 };
    rowHeights = [320];
    const got = { frame: null as ChartFrame | null };
    renderChart(
      <ChartContainer width={600} height="auto">
        <FrameProbe into={got} />
        <ChartRow>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(got.frame).not.toBeNull();
    expect(
      got.frame!.gutters.left +
        got.frame!.plot.width +
        got.frame!.gutters.right,
    ).toBe(600);
  });

  it('a width-only container ignores content-height changes (no re-render)', () => {
    // Layer-2 review find. `AutoSizeContainer` serves both dimensions, and an
    // early version stored height in state even when only width was needed —
    // so every *content*-height change (the classic splitter drag, an axis
    // strip growing a band row) re-committed the whole tree where the old
    // width-only measure bailed. Pin the bail with a Profiler (children are
    // referentially stable, so a render counter in JSX can't see this).
    boxSize = { width: 600, height: 300 };
    let commits = 0;
    renderChart(
      <Profiler id="chart" onRender={() => (commits += 1)}>
        <ChartContainer width="auto">
          <ChartRow height={200}>
            <YAxis id="v" />
            <Layers>
              <LineChart series={series()} column="v" axis="v" />
            </Layers>
          </ChartRow>
        </ChartContainer>
      </Profiler>,
    );
    const before = commits;
    boxSize = { width: 600, height: 700 }; // content height changed, width same
    relayout();
    expect(commits).toBe(before);
    // …while a real width change still commits.
    boxSize = { width: 480, height: 700 };
    relayout();
    expect(commits).toBeGreaterThan(before);
  });

  it('warns in dev when a measured dimension stays 0', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      boxSize = { width: 600, height: 0 };
      renderChart(
        <ChartContainer width="auto" height="auto">
          <ChartRow>
            <YAxis id="v" />
            <Layers>
              <LineChart series={series()} column="v" axis="v" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
      act(() => {
        vi.advanceTimersByTime(700);
      });
      const hits = warn.mock.calls.filter(([m]) =>
        String(m).includes('measured height of 0'),
      );
      expect(hits.length).toBe(1);
      // …and it names the deadlock, not just the symptom.
      expect(String(hits[0]![0])).toMatch(/parent needs a definite/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not warn when the size arrives in time', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      boxSize = { width: 600, height: 0 };
      renderChart(
        <ChartContainer width="auto" height="auto">
          <ChartRow>
            <YAxis id="v" />
            <Layers>
              <LineChart series={series()} column="v" axis="v" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
      boxSize = { width: 600, height: 400 };
      rowHeights = [320];
      relayout();
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(
        warn.mock.calls.some(([m]) => String(m).includes('measured height')),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
