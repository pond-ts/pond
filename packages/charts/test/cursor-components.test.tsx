import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { Sequence, TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { XAxis } from '../src/XAxis.js';
import {
  LineCursor,
  PointCursor,
  InlineCursor,
  FlagCursor,
  CrosshairCursor,
  RangeCursor,
} from '../src/cursors.js';
import {
  ContainerContext,
  CursorContext,
  type ContainerFrame,
  type CursorFrame,
} from '../src/context.js';

afterEach(cleanup);

const series = new TimeSeries({
  name: 't',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number' },
  ] as const,
  rows: [
    [0, 1],
    [1, 5],
    [2, 9],
    [3, 4],
    [4, 7],
  ] as [number, number][],
});

const hr = new TimeSeries({
  name: 'hr',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'bpm', kind: 'number' },
  ] as const,
  rows: [
    [0, 60],
    [2, 80],
    [4, 70],
  ] as [number, number][],
});

/** Captures the latest container frame (for cursorBuckets / xScale asserts). */
function CaptureFrame({ sink }: { sink: (f: ContainerFrame) => void }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) sink(c);
  });
  return null;
}

/** Captures the per-move cursor frame (the shared, container-resolved cursorX). */
function CaptureCursor({ sink }: { sink: (f: CursorFrame) => void }) {
  const c = useContext(CursorContext);
  useEffect(() => {
    sink(c);
  });
  return null;
}

/** All axis-pill chips (`border-radius: 3px` absolute divs). */
const chipsIn = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('div')).filter(
    (d) => d.style.position === 'absolute' && d.style.borderRadius === '3px',
  );
/** The x-axis time pill is the chip centred by `translateX` (y pills use Y). */
const xPillIn = (c: HTMLElement) =>
  chipsIn(c).find((d) => (d.style.transform ?? '').includes('X'));

describe('cursor presets mounted at the container', () => {
  const pinned = (cursorEl: React.ReactNode) =>
    render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        trackerPosition={2}
        showAxis={false}
      >
        {cursorEl}
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} side="right" />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );

  it('<CrosshairCursor /> pins the series value to the y axis (parity with cursor="crosshair")', () => {
    // series at t=2 ⇒ v=9; the [0,100] axis has no "9" tick, so the pill is
    // the only "9" on screen — the same assertion the legacy mode passes.
    const { container } = pinned(<CrosshairCursor />);
    expect(within(container).queryByText('9')).not.toBeNull();
  });

  it('<LineCursor /> draws no value pill (control), and a mounted component overrides the legacy prop', () => {
    // The mounted <LineCursor> shadows the container-scope legacy shim, so
    // even an explicit legacy cursor="crosshair" yields no reticle pill.
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        cursor="crosshair"
        trackerPosition={2}
        showAxis={false}
      >
        <LineCursor />
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} side="right" />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(within(container).queryByText('9')).toBeNull();
    // …but the line still draws (a solid, non-dashed vertical).
    const lines = Array.from(container.querySelectorAll('svg line')).filter(
      (l) => !l.hasAttribute('stroke-dasharray'),
    );
    expect(lines.length).toBe(1);
  });

  it('<CrosshairCursor /> renders the x-axis time pill via its registered slot', () => {
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        trackerPosition={2}
        timeFormat={() => 'T!'}
      >
        <CrosshairCursor />
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} side="right" />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(xPillIn(container)?.textContent).toBe('T!');
  });

  it('<CrosshairCursor showTime={false} /> registers no x-axis slot — no time pill', () => {
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        trackerPosition={2}
        timeFormat={() => 'T!'}
      >
        <CrosshairCursor showTime={false} />
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} side="right" />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(xPillIn(container)).toBeUndefined();
    // The reticle itself still draws (its value pill is a translateY chip).
    expect(within(container).queryByText('9')).not.toBeNull();
  });

  it('<LineCursor showTime /> renders the in-plot time readout (cursorTime parity)', () => {
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        trackerPosition={2}
        timeFormat={() => 'TT'}
        showAxis={false}
      >
        <LineCursor showTime />
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} side="right" />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(within(container).queryByText('TT')).not.toBeNull();
  });

  it('render-only presets stack: <LineCursor /> + <PointCursor /> draw line AND dots', () => {
    const { container } = pinned(
      <>
        <LineCursor />
        <PointCursor />
      </>,
    );
    const lines = Array.from(container.querySelectorAll('svg line'));
    const dots = Array.from(container.querySelectorAll('svg circle'));
    expect(lines.length).toBe(1);
    expect(dots.length).toBe(1);
  });

  it('<InlineCursor /> and <FlagCursor /> render the formatted value chips', () => {
    const inline = pinned(<InlineCursor />);
    expect(within(inline.container).queryByText('9')).not.toBeNull();
    inline.unmount();
    const flag = pinned(<FlagCursor />);
    expect(within(flag.container).queryByText('9')).not.toBeNull();
  });
});

describe('the per-row override reaches the x axis (the string-gate bug fix)', () => {
  /** Two rows; the SECOND carries the crosshair (component or legacy prop).
   *  Returns the render plus the two plot surfaces for pointer simulation. */
  function twoRows(secondRow: 'component' | 'legacy') {
    const res = render(
      <ChartContainer range={[0, 4]} width={300} timeFormat={() => 'T!'}>
        <ChartRow height={100}>
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
          <YAxis id="a" min={0} max={100} side="right" />
        </ChartRow>
        {secondRow === 'component' ? (
          <ChartRow height={100}>
            <CrosshairCursor />
            <Layers>
              <LineChart series={hr} column="bpm" axis="b" />
            </Layers>
            <YAxis id="b" min={0} max={200} side="right" />
          </ChartRow>
        ) : (
          <ChartRow height={100} cursor="crosshair">
            <Layers>
              <LineChart series={hr} column="bpm" axis="b" />
            </Layers>
            <YAxis id="b" min={0} max={200} side="right" />
          </ChartRow>
        )}
      </ChartContainer>,
    );
    const surfaces = Array.from(res.container.querySelectorAll('canvas')).map(
      (c) => c.parentElement!,
    );
    return { ...res, top: surfaces[0]!, bottom: surfaces[1]! };
  }

  it('hovering the crosshair row shows the x-axis time pill (mounted component)', () => {
    const { container, bottom } = twoRows('component');
    expect(xPillIn(container)).toBeUndefined(); // nothing hovered yet
    fireEvent.pointerMove(bottom, { clientX: 150, clientY: 50 });
    expect(xPillIn(container)?.textContent).toBe('T!');
  });

  it('hovering the OTHER row (container-default line) shows no pill', () => {
    const { container, top } = twoRows('component');
    fireEvent.pointerMove(top, { clientX: 150, clientY: 50 });
    expect(xPillIn(container)).toBeUndefined();
  });

  it('the legacy <ChartRow cursor="crosshair"> shim gets the same fix', () => {
    // Before this wave the x pill was gated on the CONTAINER default
    // (`container.cursor === 'crosshair'`), which a per-row override never
    // reached — the code comment admitted a row-level crosshair had no time
    // pill. The mount-registered slot closes that seam for the shim too.
    const { container, bottom } = twoRows('legacy');
    fireEvent.pointerMove(bottom, { clientX: 150, clientY: 50 });
    expect(xPillIn(container)?.textContent).toBe('T!');
  });
});

describe('the container resolves the declared snapX', () => {
  function snapProbe(cursorEl: React.ReactNode) {
    let cur: CursorFrame | null = null;
    let frame: ContainerFrame | null = null;
    const res = render(
      <ChartContainer range={[0, 4]} width={300} showAxis={false}>
        <ChartRow height={100}>
          {cursorEl}
          <Layers>
            <LineChart series={series} column="v" />
          </Layers>
          <CaptureFrame sink={(f) => (frame = f)} />
          <CaptureCursor sink={(f) => (cur = f)} />
        </ChartRow>
      </ChartContainer>,
    );
    const surface = res.container.querySelector('canvas')!.parentElement!;
    fireEvent.pointerMove(surface, { clientX: 100, clientY: 50 });
    return { cursor: () => cur!, frame: () => frame! };
  }

  it("snapX: 'sample' (crosshair) snaps the shared cursorX to the nearest sample", () => {
    const p = snapProbe(<CrosshairCursor />);
    // clientX=100 ⇒ t≈1.33 ⇒ nearest sample t=1 ⇒ px = xScale(1) = 75.
    expect(p.cursor().cursorX).toBe(p.frame().xScale(1));
  });

  it("snapX: 'none' (line) keeps the raw pointer x", () => {
    const p = snapProbe(<LineCursor />);
    expect(p.cursor().cursorX).toBe(100);
  });
});

describe('<RangeCursor>', () => {
  const H = 3_600_000;
  const D0 = Date.UTC(2026, 0, 5);
  const D1 = Date.UTC(2026, 0, 12);

  it('its sequence feeds the shared snap buckets (the cursorSequence successor)', () => {
    let frame: ContainerFrame | null = null;
    render(
      <ChartContainer range={[D0, D1]} width={320} showAxis={false}>
        <RangeCursor sequence={Sequence.calendar('day')} />
        <ChartRow height={100}>
          <Layers>
            <LineChart
              series={
                new TimeSeries({
                  name: 'd',
                  schema: [
                    { name: 'time', kind: 'time' },
                    { name: 'v', kind: 'number' },
                  ] as const,
                  rows: [
                    [D0, 1],
                    [D0 + 24 * H, 2],
                  ] as [number, number][],
                })
              }
              column="v"
            />
          </Layers>
          <CaptureFrame sink={(f) => (frame = f)} />
        </ChartRow>
      </ChartContainer>,
    );
    const buckets = frame!.cursorBuckets;
    expect(buckets).toBeDefined();
    expect(buckets!.length).toBeGreaterThanOrEqual(7); // one per day in view
  });

  it('renders the hover band over the bucket under the pointer', () => {
    const { container } = render(
      <ChartContainer range={[D0, D1]} width={320} showAxis={false}>
        <RangeCursor sequence={Sequence.calendar('day')} />
        <ChartRow height={100}>
          <Layers>
            <LineChart
              series={
                new TimeSeries({
                  name: 'd',
                  schema: [
                    { name: 'time', kind: 'time' },
                    { name: 'v', kind: 'number' },
                  ] as const,
                  rows: [
                    [D0, 1],
                    [D0 + 24 * H, 2],
                  ] as [number, number][],
                })
              }
              column="v"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const surface = container.querySelector('canvas')!.parentElement!;
    expect(container.querySelector('svg rect')).toBeNull();
    fireEvent.pointerMove(surface, { clientX: 100, clientY: 50 });
    const band = container.querySelector('svg rect');
    expect(band).not.toBeNull();
    // One day of a 7-day view on a 320px plot ≈ 45.7px wide.
    expect(Number(band!.getAttribute('width'))).toBeCloseTo(320 / 7, 0);
  });

  it('with no sequence it degenerates to a plain line on hover', () => {
    const { container } = render(
      <ChartContainer range={[0, 4]} width={300} showAxis={false}>
        <RangeCursor />
        <ChartRow height={100}>
          <Layers>
            <LineChart series={series} column="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const surface = container.querySelector('canvas')!.parentElement!;
    fireEvent.pointerMove(surface, { clientX: 100, clientY: 50 });
    expect(container.querySelector('svg rect')).toBeNull();
    const lines = Array.from(container.querySelectorAll('svg line')).filter(
      (l) => !l.hasAttribute('stroke-dasharray'),
    );
    expect(lines.length).toBe(1);
  });
});

describe('deprecation + duplicate-gesture-owner dev warnings', () => {
  const chart = (
    props: Partial<Parameters<typeof ChartContainer>[0]>,
    cursorEl?: React.ReactNode,
  ) => (
    <ChartContainer range={[0, 4]} width={300} showAxis={false} {...props}>
      {cursorEl}
      <ChartRow height={100}>
        <YAxis id="a" min={0} max={100} />
        <Layers>
          <LineChart series={series} column="v" axis="a" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );

  it('an explicit legacy cursor prop warns once, naming the replacement', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(chart({ cursor: 'crosshair' }));
      const messages = warn.mock.calls.map((c) => String(c[0]));
      const dep = messages.filter((m) => m.includes('deprecated cursor props'));
      expect(dep.length).toBe(1);
      expect(dep[0]).toContain('<CrosshairCursor>');
    } finally {
      warn.mockRestore();
    }
  });

  it('crosshairSnap / cursorTime / cursorSequence / cursorFormat each warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(
        chart({
          crosshairSnap: false,
          cursorTime: true,
          cursorFormat: '.2f',
          cursorSequence: Sequence.every('1m'),
        }),
      );
      const dep = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('deprecated cursor props'));
      expect(dep.length).toBe(1);
      expect(dep[0]).toContain('crosshairSnap');
      expect(dep[0]).toContain('cursorTime');
      expect(dep[0]).toContain('cursorFormat');
      expect(dep[0]).toContain('cursorSequence');
    } finally {
      warn.mockRestore();
    }
  });

  it('the defaults (no legacy props) and mounted presets do NOT warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(chart({}, <CrosshairCursor />));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('<ChartRow cursor> warns, naming the in-row mount', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(
        <ChartContainer range={[0, 4]} width={300} showAxis={false}>
          <ChartRow height={100} cursor="point">
            <Layers>
              <LineChart series={series} column="v" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
      const dep = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('<ChartRow cursor="point">'));
      expect(dep.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('two gesture-owning cursors in one scope dev-warn (RFC A2.5)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(
        chart(
          {},
          <>
            <CrosshairCursor />
            <RangeCursor />
          </>,
        ),
      );
      const dup = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('gesture-owning'));
      expect(dup.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('render-only stacking does not trigger the gesture-owner warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(
        chart(
          {},
          <>
            <LineCursor />
            <PointCursor />
            <CrosshairCursor />
          </>,
        ),
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('a gesture owner per DIFFERENT scope is fine (container + row)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(
        <ChartContainer range={[0, 4]} width={300} showAxis={false}>
          <CrosshairCursor />
          <ChartRow height={100}>
            <RangeCursor />
            <Layers>
              <LineChart series={series} column="v" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
