/**
 * `useChartFrame()` — the resolved plot geometry, published (Theme A of the
 * Ignite friction report: PG-1, PG-9, PG-24, PG-27).
 *
 * What these pin is not "the hook returns numbers" but **the numbers are the
 * ones the plot actually used**. The workaround this replaces re-derived the
 * plot rect by mirroring the library's gutter arithmetic, and its failure mode
 * was silent: chrome slides out of alignment with no type error and no failing
 * test. So the load-bearing assertions here cross-check the frame against an
 * independent source of the same geometry — the container frame the draw
 * layers read, and `useChartLegend`'s gutters — rather than against a constant
 * this file also chose.
 */
import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import { useChartFrame, type ChartFrame } from '../src/useChartFrame.js';
import { useChartLegend } from '../src/useChartLegend.js';
import { ContainerContext, type ContainerFrame } from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const WIDTH = 600;

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
      [2000, 9],
    ],
  });

const cats = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ label: `c${i}`, value: i + 1 }));

/** Capture the frame from wherever it is mounted (scope follows placement). */
function Probe({ into }: { into: { frame: ChartFrame | null } }) {
  const frame = useChartFrame();
  useEffect(() => {
    into.frame = frame;
  });
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

describe('useChartFrame — placement and guards', () => {
  it('throws outside a <ChartContainer>', () => {
    function Bare() {
      useChartFrame();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(
      /must be used inside a <ChartContainer>/,
    );
  });

  it('at the container level publishes x geometry and no row half', () => {
    const got = { frame: null as ChartFrame | null };
    renderChart(
      <ChartContainer width={WIDTH}>
        <Probe into={got} />
        <ChartRow height={100}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const f = got.frame!;
    expect(f.row).toBeNull();
    expect(f.xKind).toBe('time');
    expect(f.plot.width).toBeGreaterThan(0);
  });

  it('inside a <ChartRow> additionally publishes that row’s y scales', () => {
    const got = { frame: null as ChartFrame | null };
    renderChart(
      <ChartContainer width={WIDTH}>
        <ChartRow height={100}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
            <Probe into={got} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const f = got.frame!;
    expect(f.row).not.toBeNull();
    expect(f.row!.yScales.has('v')).toBe(true);
  });
});

describe('useChartFrame — the plot rect is the one the plot used', () => {
  it('agrees with the container frame the draw layers read', () => {
    const got = { frame: null as ChartFrame | null };
    let cf: ContainerFrame | null = null;
    function CaptureContainer() {
      const c = useContext(ContainerContext);
      useEffect(() => {
        if (c) cf = c;
      });
      return null;
    }
    renderChart(
      <ChartContainer width={WIDTH}>
        <Probe into={got} />
        <ChartRow height={100}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
            <CaptureContainer />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const f = got.frame!;
    // The whole point of the hook: these cannot disagree, because a consumer
    // that re-derived them could.
    expect(f.plot.x).toBe(cf!.leftGutter);
    expect(f.plot.width).toBe(cf!.plotWidth);
    expect(f.gutters.left).toBe(cf!.leftGutter);
    expect(f.gutters.right).toBe(cf!.rightGutter);
    // …and the rect closes over the container's own width.
    expect(f.gutters.left + f.plot.width + f.gutters.right).toBe(WIDTH);
  });

  it('publishes the same gutters as useChartLegend', () => {
    const got = { frame: null as ChartFrame | null };
    const seen = { gutters: null as { left: number; right: number } | null };
    function LegendProbe() {
      const { gutters } = useChartLegend();
      useEffect(() => {
        seen.gutters = gutters;
      });
      return null;
    }
    renderChart(
      <ChartContainer width={WIDTH}>
        <Probe into={got} />
        <LegendProbe />
        <ChartRow height={100}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(got.frame!.gutters).toEqual(seen.gutters);
  });

  it('reserves a top inset for a labelPlacement="top" axis, and 0 without one', () => {
    const bare = { frame: null as ChartFrame | null };
    renderChart(
      <ChartContainer width={WIDTH}>
        <ChartRow height={100}>
          <YAxis id="v" label="V" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
            <Probe into={bare} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(bare.frame!.row!.topInset).toBe(0);
    expect(bare.frame!.row!.height).toBe(100);
    cleanup();

    const topped = { frame: null as ChartFrame | null };
    renderChart(
      <ChartContainer width={WIDTH}>
        <ChartRow height={100}>
          <YAxis id="v" label="V" labelPlacement="top" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
            <Probe into={topped} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const row = topped.frame!.row!;
    // The inset is real drawable space, not decoration: an overlay that used
    // the row's own `height` would sit under the title.
    expect(row.topInset).toBeGreaterThan(0);
    expect(row.topInset + row.height).toBe(100);
    // …and it is exactly where the y scale starts.
    expect(row.yScales.get('v')!.range()).toEqual([100, row.topInset]);
  });
});

describe('useChartFrame — band geometry', () => {
  const mountCats = (n: number, props: Record<string, unknown> = {}) => {
    const got = { frame: null as ChartFrame | null };
    renderChart(
      <ChartContainer width={WIDTH} {...props}>
        <Probe into={got} />
        <ChartRow height={100}>
          <YAxis id="v" label="" />
          <Layers>
            <BarChart categories={cats(n)} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    return got.frame!;
  };

  it('is null on a time axis', () => {
    const got = { frame: null as ChartFrame | null };
    renderChart(
      <ChartContainer width={WIDTH}>
        <Probe into={got} />
        <ChartRow height={100}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(got.frame!.bands).toBeNull();
    expect(got.frame!.xKind).toBe('time');
  });

  it('reports one contiguous slot per category, in order', () => {
    const f = mountCats(4);
    expect(f.xKind).toBe('category');
    const b = f.bands!;
    expect(b.count).toBe(4);
    expect(b.labels).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(b.pitch).toBeCloseTo(f.plot.width / 4, 6);
    for (let i = 0; i < 4; i++) {
      const slot = b.at(i)!;
      expect(slot.label).toBe(`c${i}`);
      expect(slot.x1 - slot.x0).toBeCloseTo(b.pitch, 6);
      expect(slot.center).toBeCloseTo((slot.x0 + slot.x1) / 2, 6);
      // Contiguous: each slot starts where the previous ended.
      if (i > 0) expect(slot.x0).toBeCloseTo(b.at(i - 1)!.x1, 6);
    }
    // The run fills the plot.
    expect(b.at(0)!.x0).toBeCloseTo(0, 6);
    expect(b.at(3)!.x1).toBeCloseTo(f.plot.width, 6);
  });

  it('returns null for an index that is not a real slot', () => {
    const b = mountCats(3).bands!;
    expect(b.at(-1)).toBeNull();
    expect(b.at(3)).toBeNull();
    expect(b.at(1.5)).toBeNull();
  });

  it('tracks maxBandWidth + bandAlign rather than plot.width / count', () => {
    // This is the assertion that earns the API. `plot.width / count` is the
    // obvious re-derivation, and it is wrong the moment the pitch is capped —
    // which is exactly the drift the consumer could not have detected.
    const f = mountCats(4, { maxBandWidth: 40, bandAlign: 'center' });
    const b = f.bands!;
    expect(b.pitch).toBeCloseTo(40, 6);
    expect(b.pitch).not.toBeCloseTo(f.plot.width / 4, 1);
    const packed = 40 * 4;
    const slack = f.plot.width - packed;
    expect(b.at(0)!.x0).toBeCloseTo(slack / 2, 6);
    expect(b.at(3)!.x1).toBeCloseTo(slack / 2 + packed, 6);
  });

  it('places slots where the shared xScale places them', () => {
    const f = mountCats(5, { maxBandWidth: 60, bandAlign: 'end' });
    const b = f.bands!;
    for (let i = 0; i < b.count; i++) {
      // The scale is the authority; `bands` is a reading of it, not a parallel
      // computation that could drift from it.
      expect(b.at(i)!.x0).toBeCloseTo(f.xScale(i) as number, 6);
      expect(b.at(i)!.center).toBeCloseTo(f.xScale(i + 0.5) as number, 6);
    }
  });
});
