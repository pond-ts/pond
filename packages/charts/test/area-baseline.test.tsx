import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useContext, useEffect } from 'react';
import { scaleLinear, scaleLog } from 'd3-scale';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { AreaChart } from '../src/AreaChart.js';
import { YAxis } from '../src/YAxis.js';
import { areaHitIndex } from '../src/area.js';
import { RowContext, type RowFrame } from '../src/context.js';
import type { ChartSeries } from '../src/data.js';
import { stubCanvasContext, type CtxCall } from './canvas-mock.js';

afterEach(cleanup);

/**
 * **Where an area's fill stops.** An area encodes size, and size is measured
 * from zero — so the fill rests on `0` unless the caller names another level,
 * and the bottom of the plot is an explicit opt-in (`baseline="floor"`), not
 * the default. Before this, an omitted `baseline` filled to the plot's bottom,
 * which on auto-fit data like 50–90 is ~50 — so a value of 60 drew as a sliver
 * and 90 as a slab four times its size.
 */

const T = (i: number) => i * 1000;
/** Five points, 50…90 — positive, and nowhere near zero. */
const high = () =>
  new TimeSeries({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 5 }, (_, i) => [T(i), 50 + i * 10]) as [
      number,
      number,
    ][],
  });

/** Render one area, returning the row's resolved y scale and the draw log. */
function mount(
  node: React.ReactNode,
  axis: { min?: number; max?: number } = {},
) {
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
      <ChartContainer range={[0, 4000]} width={320}>
        <ChartRow height={120}>
          <YAxis id="a" {...axis} />
          <Layers>
            {node}
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  const y = (rf as RowFrame | null)!.yScales.get('a')!;
  return { y, domain: y.domain() as [number, number], calls: stub.calls };
}

/** Every y a **filled** path visited — the `moveTo` / `lineTo` ops between a
 *  `beginPath` and the `fill` that paints it. Strokes (the outline, grid lines,
 *  ticks) are left out, since a grid line at the bottom of the plot says
 *  nothing about where the area stops. */
function fillYs(calls: readonly CtxCall[]): number[] {
  const out: number[] = [];
  let path: number[] = [];
  for (const c of calls) {
    if (c.type !== 'call') continue;
    if (c.name === 'beginPath') path = [];
    else if (c.name === 'moveTo' || c.name === 'lineTo')
      path.push(c.args[1] as number);
    else if (c.name === 'fill') out.push(...path);
  }
  return out;
}

describe('`<AreaChart baseline>` — auto-fit domain', () => {
  it('omitted ⇒ 0: zero is pulled into the domain', () => {
    const { domain } = mount(<AreaChart series={high()} column="v" axis="a" />);
    expect(domain[0]).toBeLessThanOrEqual(0);
    expect(domain[1]).toBeGreaterThanOrEqual(90);
  });

  it("'floor' ⇒ nothing is added: the domain hugs the data", () => {
    const { domain } = mount(
      <AreaChart series={high()} column="v" axis="a" baseline="floor" />,
    );
    expect(domain[0]).toBeGreaterThan(0);
    expect(domain[0]).toBeLessThanOrEqual(50);
  });

  it('a number ⇒ that level is pulled in, even above the data', () => {
    const { domain } = mount(
      <AreaChart series={high()} column="v" axis="a" baseline={100} />,
    );
    expect(domain[0]).toBeGreaterThan(0);
    expect(domain[1]).toBeGreaterThanOrEqual(100);
  });
});

describe('`<AreaChart baseline>` — where the fill is drawn', () => {
  // A fixed axis that runs *below* zero, so "the bottom of the plot" and
  // "zero" are different pixels and the two forms can be told apart.
  const axis = { min: -50, max: 100 };

  it('omitted ⇒ the fill closes on the zero pixel, not the bottom', () => {
    const { y, calls } = mount(
      <AreaChart series={high()} column="v" axis="a" />,
      axis,
    );
    const ys = fillYs(calls);
    expect(ys).toContain(y(0));
    expect(ys).not.toContain(y(-50));
  });

  it("'floor' ⇒ the fill closes on the bottom of the plot", () => {
    const { y, calls } = mount(
      <AreaChart series={high()} column="v" axis="a" baseline="floor" />,
      axis,
    );
    const ys = fillYs(calls);
    expect(ys).toContain(y(-50));
    expect(ys).not.toContain(y(0));
  });

  it('a number ⇒ the fill closes on that level', () => {
    const { y, calls } = mount(
      <AreaChart series={high()} column="v" axis="a" baseline={25} />,
      axis,
    );
    expect(fillYs(calls)).toContain(y(25));
  });
});

describe('`areaHitIndex` with a baseline that has no position', () => {
  // Zero on a log axis maps to NaN. The hit test used to take that pixel
  // as-is, and a NaN bound makes both range checks false — so every point
  // over the series' x span counted as inside the fill. With 0 now the
  // default, that would have been every selectable area on a log axis.
  const cs: ChartSeries = {
    x: Float64Array.from([0, 100]),
    y: Float64Array.from([100, 100]),
    length: 2,
  };
  const xs = scaleLinear().domain([0, 100]).range([0, 100]);
  const logY = scaleLog().domain([1, 1e4]).range([300, 0]);

  it('falls back to the axis floor, like the draw does', () => {
    // The trace is at v=100 (py 150); the floor is at py 300.
    expect(areaHitIndex(cs, 0, 50, 200, xs, logY)).not.toBeNull();
    expect(areaHitIndex(cs, 0, 50, 20, xs, logY)).toBeNull();
  });
});
