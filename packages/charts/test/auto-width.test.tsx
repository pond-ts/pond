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

function Probe({ into }: { into: { frame: ChartFrame | null } }) {
  const frame = useChartFrame();
  into.frame = frame;
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
