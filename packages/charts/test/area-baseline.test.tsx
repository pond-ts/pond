import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useContext, useEffect } from 'react';
import { scaleLinear, scaleLog } from 'd3-scale';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { AreaChart } from '../src/AreaChart.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { areaHitIndex } from '../src/area.js';
import { RowContext, type RowFrame } from '../src/context.js';
import type { ChartSeries } from '../src/data.js';
import { stubCanvasContext, type CtxCall } from './canvas-mock.js';

afterEach(cleanup);

/**
 * **Where an area's fill stops — and what it does not do.** The fill rests on
 * `0` unless the caller names another level or the bottom of the plot
 * (`baseline="floor"`). The baseline never moves the axis: the axis fits the
 * data, as a line's does, so switching `baseline` changes where the fill stops
 * and nothing else. A baseline the axis doesn't reach is clamped to its nearest
 * edge, which is why the default looks like `'floor'` on data that never
 * crosses zero; `<YAxis min={0}>` is how a chart puts zero on screen.
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
  axis: {
    min?: number;
    max?: number;
    scale?: 'linear' | 'log' | 'symlog';
  } = {},
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

/** Five points, 50 … -100 — crosses zero, and no point sits exactly on it. */
const signed = () =>
  new TimeSeries({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [50, 20, -10, -60, -100].map((v, i) => [T(i), v]) as [
      number,
      number,
    ][],
  });

/** The domain a `<LineChart>` of the same column fits — what an area's must
 *  match. (A fully auto-fit domain is `.nice()`d, so this, not the raw data
 *  extent, is the reference.) */
function lineDomain(series: ReturnType<typeof high>): [number, number] {
  const { domain } = mount(<LineChart series={series} column="v" axis="a" />);
  cleanup();
  return domain;
}

/** Method calls only — a `fillStyle` set carries a gradient object, which
 *  `toEqual` would compare by identity. */
const ops = (calls: readonly CtxCall[]) =>
  calls.filter((c) => c.type === 'call');

describe('`<AreaChart baseline>` — never changes the auto-fit domain', () => {
  it.each([
    ['omitted (0)', undefined],
    ["'floor'", 'floor' as const],
    ['0', 0],
    ['inside the data (70)', 70],
    ['above the data (100)', 100],
    ['far below the data (-1000)', -1000],
  ])("baseline %s ⇒ the line's domain", (_, baseline) => {
    const expected = lineDomain(high());
    const { domain } = mount(
      <AreaChart
        series={high()}
        column="v"
        axis="a"
        {...(baseline === undefined ? {} : { baseline })}
      />,
    );
    expect(domain).toEqual(expected);
    expect(domain[0]).toBeGreaterThan(0);
  });

  it('data that never reaches 0 ⇒ the default draws exactly what floor does', () => {
    // Zero is below the axis, so the fill is clamped to the bottom edge — the
    // same path and the same gradient span as `baseline="floor"`.
    const byDefault = mount(
      <AreaChart series={high()} column="v" axis="a" />,
    ).calls;
    cleanup();
    const floor = mount(
      <AreaChart series={high()} column="v" axis="a" baseline="floor" />,
    ).calls;
    expect(ops(byDefault)).toEqual(ops(floor));
    expect(ops(floor).some((c) => c.name === 'createLinearGradient')).toBe(
      true,
    );
  });

  it('a baseline above the data clamps the fill to the top edge', () => {
    const { y, domain, calls } = mount(
      <AreaChart series={high()} column="v" axis="a" baseline={100} />,
    );
    const ys = fillYs(calls);
    expect(ys).not.toContain(y(100));
    expect(Math.min(...ys)).toBe(y(domain[1]));
  });

  it('data that crosses 0 ⇒ same domain either way; only the fill moves', () => {
    const expected = lineDomain(signed());
    const byDefault = mount(
      <AreaChart series={signed()} column="v" axis="a" />,
    );
    expect(byDefault.domain).toEqual(expected);
    expect(fillYs(byDefault.calls)).toContain(byDefault.y(0));
    cleanup();
    const floor = mount(
      <AreaChart series={signed()} column="v" axis="a" baseline="floor" />,
    );
    expect(floor.domain).toEqual(expected);
    expect(fillYs(floor.calls)).not.toContain(floor.y(0));
    expect(fillYs(floor.calls)).toContain(floor.y(expected[0]));
  });

  it('`<YAxis min={0}>` is how a chart puts the fill back on zero', () => {
    const { y, domain, calls } = mount(
      <AreaChart series={high()} column="v" axis="a" />,
      { min: 0 },
    );
    expect(domain[0]).toBe(0);
    expect(fillYs(calls)).toContain(y(0));
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

describe('`<AreaChart baseline>` — non-linear and pinned axes', () => {
  /** Five points spanning four decades, 10…1e5. */
  const decades = () =>
    new TimeSeries({
      name: 'x',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: Array.from({ length: 5 }, (_, i) => [T(i), 10 ** (i + 1)]) as [
        number,
        number,
      ][],
    });

  it('a log axis fits the data, not the default 0', () => {
    // Zero has no position on a log axis. When the baseline was pulled into
    // the extent it left the log fit with `[0, 1e5]`, no positive low end,
    // and a domain collapsed onto the max (`[1e4, 1e6]`) that clipped most of
    // the series.
    const log = { scale: 'log' as const };
    const byDefault = mount(
      <AreaChart series={decades()} column="v" axis="a" />,
      log,
    ).domain;
    cleanup();
    const floor = mount(
      <AreaChart series={decades()} column="v" axis="a" baseline="floor" />,
      log,
    ).domain;
    expect(byDefault).toEqual(floor);
    expect(byDefault[0]).toBeLessThanOrEqual(10);
  });

  it('a symlog axis fits the data too, though zero has a position there', () => {
    const { domain } = mount(
      <AreaChart series={high()} column="v" axis="a" />,
      { scale: 'symlog' },
    );
    expect(domain).toEqual([50, 90]);
  });

  it('a pinned axis above 0 clamps the fill to its floor, as a bar does', () => {
    // Off the plot, the fill would clip the same but anchor its fade below it.
    const { y, calls } = mount(
      <AreaChart series={high()} column="v" axis="a" />,
      { min: 40, max: 100 },
    );
    const ys = fillYs(calls);
    expect(ys).toContain(y(40));
    expect(ys).not.toContain(y(0));
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
