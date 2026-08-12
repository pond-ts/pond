import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { scaleLog } from 'd3-scale';
import { tickValues } from '../src/yticks.js';
import { useContext, useEffect } from 'react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { XAxis } from '../src/XAxis.js';
import { YAxis } from '../src/YAxis.js';
import { LineChart } from '../src/LineChart.js';
import { ValueSeries } from 'pond-ts';
import { ContainerContext, type ContainerFrame } from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * [PND-XLOG] — **`<ChartContainer xScale="log">`**, the x half of the log axis.
 *
 * The prop lives on the container and not on `<XAxis scale>` (where the
 * `<YAxis scale>` mirror would put it) because there is **one** x scale shared
 * by every row and the container builds it, while every `<XAxis>` prop is
 * presentational. `<YAxis>` is the opposite — one scale per axis per row,
 * declared by the axis.
 */
function mount(
  build: (capture: React.ReactNode) => React.ReactElement,
): () => ContainerFrame {
  let cf: ContainerFrame | null = null;
  function Capture() {
    const c = useContext(ContainerContext);
    useEffect(() => {
      if (c) cf = c;
    });
    return null;
  }
  const stub = stubCanvasContext();
  try {
    render(build(<Capture />));
  } finally {
    stub.restore();
  }
  return () => cf!;
}

/** A value-kind x axis. `xScale` only applies there — a log *time* axis is
 *  meaningless, so the container ignores it on time and category. */
const curve = ValueSeries.fromColumns({
  name: 'pd',
  schema: [
    { name: 'secs', kind: 'value' },
    { name: 'watts', kind: 'number' },
  ] as const,
  columns: { secs: [1, 100, 10000], watts: [9, 5, 2] },
});

const chart = (
  props: Partial<React.ComponentProps<typeof ChartContainer>> = {},
  capture?: React.ReactNode,
) => (
  <ChartContainer range={[1, 10000]} width={400} {...props}>
    <ChartRow height={100}>
      <YAxis id="v" min={0} max={10} label="" />
      <Layers>
        <LineChart series={curve} column="watts" axis="v" />
        {capture}
      </Layers>
    </ChartRow>
    <XAxis />
  </ChartContainer>
);

describe('<ChartContainer xScale>', () => {
  it('maps the domain logarithmically, not linearly', () => {
    const get = mount((cap) => chart({ xScale: 'log' }, cap));
    const s = get().xScale;
    // The geometric midpoint of [1, 10000] is 100, and on a log scale it lands
    // at the halfway pixel. On a linear scale it would sit at ~1% of the width.
    const mid = +s(100);
    const full = +s(10000) - +s(1);
    expect(mid / full).toBeCloseTo(0.5, 6);
  });

  it('is linear by default, so nothing existing moves', () => {
    const get = mount((cap) => chart({}, cap));
    const s = get().xScale;
    // Linear position of 100 in [1, 10000] is (100-1)/(10000-1), not 100/10000.
    expect(+s(100) / (+s(10000) - +s(1))).toBeCloseTo(99 / 9999, 6);
  });

  it('reports `xIsLog` structurally for the gestures to read', () => {
    expect(mount((cap) => chart({ xScale: 'log' }, cap))().xIsLog).toBe(true);
    expect(mount((cap) => chart({}, cap))().xIsLog).toBe(false);
    expect(mount((cap) => chart({ xScale: 'symlog' }, cap))().xIsLog).toBe(
      true,
    );
  });

  it('falls back to linear — loudly — when the domain reaches zero', () => {
    // `log(0)` is undefined, and silently clamping would invent a view the
    // caller never asked for.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const get = mount((cap) => chart({ xScale: 'log', range: [0, 100] }, cap));
    expect(get().xIsLog).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('symlog'));
    warn.mockRestore();
  });

  it('accepts a zero-crossing domain under symlog without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const get = mount((cap) =>
      chart({ xScale: 'symlog', range: [-100, 100] }, cap),
    );
    expect(get().xIsLog).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('gets a decade ladder, not d3 scaleLog raw ticks', () => {
    // `<XAxis>` renders to canvas, so assert the ladder itself — the shared
    // `tickValues` the y axis already uses, which is the whole of the change
    // at the tick site.
    const s = scaleLog().domain([1, 10000]).range([0, 400]);
    const ticks = tickValues(s as Parameters<typeof tickValues>[0], 5);
    expect(ticks).toContain(1);
    expect(ticks).toContain(10000);
    // Decades, evenly spaced in log space — which raw `scaleLog.ticks()` is
    // not (it returns a near-step function of every 1..9 mantissa).
    expect(ticks.filter((v) => Math.log10(v) % 1 === 0).length).toBeGreaterThan(
      2,
    );
  });
});
