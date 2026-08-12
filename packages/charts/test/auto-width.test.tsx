/**
 * `<ChartContainer width="auto">` — the responsive-width recipe moved inside
 * the library ([PND-WIDTH]; Theme C / PG-5 of the Ignite report, and the third
 * independent consumer to hit the explicit-pixel requirement).
 *
 * The behaviours worth pinning are the three the recipe had to spell out, plus
 * the one it could only warn about:
 *
 * - nothing paints until a real width exists (a zero-width chart is degenerate,
 *   not empty);
 * - the first width is read synchronously on mount, not awaited from
 *   `ResizeObserver`, whose first callback is not guaranteed to fire;
 * - a later resize re-renders at the new width;
 * - the measured box is the library's own plain `<div>`, so it can never be a
 *   caller's padded box — the recipe's sharpest edge, closed by construction.
 */
import { useEffect } from 'react';
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
 * happy-dom has no layout engine, so `getBoundingClientRect()` is always 0 —
 * exactly the pre-measurement state the gate exists for. Drive it explicitly:
 * `setWidth` decides what the box measures, and `resize()` fires the observers
 * the way a real browser would after a layout change.
 */
let boxWidth = 0;
let observers: Array<() => void> = [];
let realRO: typeof ResizeObserver | undefined;
let rectSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  boxWidth = 0;
  observers = [];
  rectSpy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockImplementation(() => ({ width: boxWidth, height: 100 }) as DOMRect);
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
});

const resize = (to: number) =>
  act(() => {
    boxWidth = to;
    for (const cb of [...observers]) cb();
  });

/**
 * Writes the frame during render, and **clears it on unmount** — without the
 * cleanup a probe keeps its last value after the chart goes away, so a test
 * asserting "still mounted" would pass against an unmounted chart. (That
 * exact hole made the latch test vacuous until a mutation run exposed it.)
 */
function Probe({ into }: { into: { frame: ChartFrame | null } }) {
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

function mount(width?: number | 'auto') {
  const got = { frame: null as ChartFrame | null };
  const stub = stubCanvasContext();
  try {
    const r = render(
      <ChartContainer {...(width === undefined ? {} : { width })}>
        <Probe into={got} />
        <ChartRow height={100}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    return { ...r, got };
  } finally {
    stub.restore();
  }
}

describe('<ChartContainer width="auto">', () => {
  it('paints nothing until a real width exists', () => {
    const { got, container } = mount('auto');
    // The gate: no chart, but the measured box is mounted so it *can* be
    // measured. A container that rendered nothing at all could never resolve.
    expect(got.frame).toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
    expect(container.querySelector('div')).not.toBeNull();
  });

  it('mounts at the width measured synchronously on mount', () => {
    boxWidth = 640;
    const { got } = mount('auto');
    // No ResizeObserver callback has fired — this width came from the
    // layout-effect's own getBoundingClientRect, which is the point.
    expect(got.frame).not.toBeNull();
    expect(
      got.frame!.gutters.left +
        got.frame!.plot.width +
        got.frame!.gutters.right,
    ).toBe(640);
  });

  it('an omitted width means auto', () => {
    boxWidth = 500;
    const { got } = mount(undefined);
    expect(got.frame).not.toBeNull();
    expect(
      got.frame!.gutters.left +
        got.frame!.plot.width +
        got.frame!.gutters.right,
    ).toBe(500);
  });

  it('re-renders at the new width when the box resizes', () => {
    boxWidth = 400;
    const { got } = mount('auto');
    const first = got.frame!.plot.width;
    resize(900);
    const second = got.frame!.plot.width;
    expect(second).toBeGreaterThan(first);
    expect(got.frame!.gutters.left + second + got.frame!.gutters.right).toBe(
      900,
    );
  });

  it('resolves from zero once the box gets a width', () => {
    const { got } = mount('auto');
    expect(got.frame).toBeNull();
    resize(700);
    expect(got.frame).not.toBeNull();
    expect(
      got.frame!.gutters.left +
        got.frame!.plot.width +
        got.frame!.gutters.right,
    ).toBe(700);
  });

  it('latches the last non-zero width when the box is hidden', () => {
    // Found by Layer-2 review. `display: none` on an ancestor measures 0, and
    // writing that through would unmount the resolved container — discarding
    // pan/zoom, selection, hover and every layer's memoized draw state, then
    // paying a full remount on the way back. A hidden chart is not a resized
    // one.
    boxWidth = 640;
    const { got, container } = mount('auto');
    const before = got.frame;
    expect(before).not.toBeNull();
    resize(0);
    // Both halves matter: the chart is still in the DOM, and it kept the width.
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(got.frame).not.toBeNull();
    expect(got.frame!.plot.width).toBe(before!.plot.width);
    // …and a real measurement still corrects it.
    resize(480);
    expect(
      got.frame!.gutters.left +
        got.frame!.plot.width +
        got.frame!.gutters.right,
    ).toBe(480);
  });

  it('keeps the chart mounted across a hide, not just the width', () => {
    // The point of the latch is state survival, so assert on identity rather
    // than on the number: a remount would give the row a fresh scale map.
    boxWidth = 500;
    const { got } = mount('auto');
    const scaleBefore = got.frame!.xScale;
    resize(0);
    resize(500);
    expect(got.frame!.xScale).toBe(scaleBefore);
  });

  it('rounds a fractional measurement', () => {
    boxWidth = 640.4;
    const { got } = mount('auto');
    expect(
      got.frame!.gutters.left +
        got.frame!.plot.width +
        got.frame!.gutters.right,
    ).toBe(640);
  });

  it('remounts when width flips between a number and auto', () => {
    // Documented behaviour, pinned: the two paths are different components, so
    // the switch is a remount. Rare (it is a layout change), and a remount is
    // the honest response to one — but it should not change silently.
    const seen: unknown[] = [];
    function Probe2() {
      const f = useChartFrame();
      seen.push(f.xScale);
      return null;
    }
    const tree = (w: number | 'auto') => (
      <ChartContainer width={w}>
        <Probe2 />
        <ChartRow height={100}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
    const stub = stubCanvasContext();
    try {
      boxWidth = 600;
      const { rerender } = render(tree(600));
      const fixed = seen[seen.length - 1];
      rerender(tree('auto'));
      expect(seen[seen.length - 1]).not.toBe(fixed);
    } finally {
      stub.restore();
    }
  });

  it('stops observing on unmount', () => {
    boxWidth = 400;
    const { unmount } = mount('auto');
    expect(observers.length).toBe(1);
    unmount();
    expect(observers.length).toBe(0);
  });

  it('measures once and does not throw where ResizeObserver is absent', () => {
    // SSR, or an older test DOM. A chart that measured once is a far better
    // failure than one that throws on mount.
    const saved = globalThis.ResizeObserver;
    // @ts-expect-error — deleting the global is the condition under test.
    delete globalThis.ResizeObserver;
    try {
      boxWidth = 320;
      const { got } = mount('auto');
      expect(got.frame).not.toBeNull();
      expect(
        got.frame!.gutters.left +
          got.frame!.plot.width +
          got.frame!.gutters.right,
      ).toBe(320);
    } finally {
      globalThis.ResizeObserver = saved;
    }
  });

  it('a numeric width skips the measure pass entirely', () => {
    // boxWidth stays 0: if a fixed container measured anything, it would gate.
    const { got } = mount(600);
    expect(got.frame).not.toBeNull();
    expect(observers.length).toBe(0);
    expect(
      got.frame!.gutters.left +
        got.frame!.plot.width +
        got.frame!.gutters.right,
    ).toBe(600);
  });
});
