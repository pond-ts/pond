/**
 * `xOffset` on `<LineChart>` / `<AreaChart>` / `<BandChart>` — each row is
 * drawn `xOffset` after its key. The layer moves its own copy of the key, so
 * everything it reports is in drawn time: the tracker's nearest row and dot,
 * and the span it asks the trading axis for session breaks over. The source
 * series is left alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { AreaChart } from '../src/AreaChart.js';
import { BandChart } from '../src/BandChart.js';
import { YAxis } from '../src/YAxis.js';
import type { TrackerInfo, TrackerSample } from '../src/context.js';
import type { DiscontinuityProvider } from '../src/tradingTimeScale.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

// Three 1s "bars" keyed at their open: v / lo / hi per row.
const bars = () =>
  new TimeSeries({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
      { name: 'lo', kind: 'number' },
      { name: 'hi', kind: 'number' },
    ] as const,
    rows: [
      [0, 5, 4, 6],
      [1000, 6, 5, 7],
      [2000, 7, 6, 8],
    ],
  });

/** Render under a controlled tracker; return the fanned-in samples. */
function samplesOf(
  child: React.ReactNode,
  trackerPosition: number,
): TrackerSample[] {
  const stub = stubCanvasContext();
  try {
    const seen: Array<TrackerInfo | null> = [];
    render(
      <ChartContainer
        range={[0, 3000]}
        width={400}
        trackerPosition={trackerPosition}
        onTrackerChanged={(info) => seen.push(info)}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={20} />
          <Layers>{child}</Layers>
        </ChartRow>
      </ChartContainer>,
    );
    return [...(seen.filter(Boolean).at(-1)?.values ?? [])];
  } finally {
    stub.restore();
  }
}

describe('xOffset — tracker reads in drawn time', () => {
  it('LineChart: the row drawn under the cursor, with the dot at its drawn x', () => {
    // Without an offset the cursor at 1000 is on row 1000 (v = 6).
    const [plain] = samplesOf(
      <LineChart series={bars()} column="v" axis="a" />,
      1000,
    );
    expect(plain).toMatchObject({ x: 1000, value: 6 });
    // Drawn 1s late, row 0 now sits at 1000.
    const [moved] = samplesOf(
      <LineChart series={bars()} column="v" axis="a" xOffset={1000} />,
      1000,
    );
    expect(moved).toMatchObject({ x: 1000, value: 5 });
  });

  it('accepts a duration string and a negative offset', () => {
    const [late] = samplesOf(
      <LineChart series={bars()} column="v" axis="a" xOffset="1s" />,
      3000,
    );
    // Row 2000 is drawn at 3000 — inside the drawn span, so it reads.
    expect(late).toMatchObject({ x: 3000, value: 7 });
    const [early] = samplesOf(
      <LineChart series={bars()} column="v" axis="a" xOffset={-1000} />,
      1000,
    );
    expect(early).toMatchObject({ x: 1000, value: 7 });
  });

  it('no readout past the drawn span (the moved series bounds the tracker)', () => {
    // Drawn span is [1000, 3000]; 500 is before it.
    expect(
      samplesOf(
        <LineChart series={bars()} column="v" axis="a" xOffset="1s" />,
        500,
      ),
    ).toEqual([]);
  });

  it('AreaChart moves the same way', () => {
    const [s] = samplesOf(
      <AreaChart series={bars()} column="v" axis="a" xOffset="1s" />,
      1000,
    );
    expect(s).toMatchObject({ x: 1000, value: 5 });
  });

  it('BandChart moves both edges together', () => {
    const samples = samplesOf(
      <BandChart series={bars()} lower="lo" upper="hi" axis="a" xOffset="1s" />,
      1000,
    );
    expect(samples.map((s) => [s.x, s.value])).toEqual([
      [1000, 4],
      [1000, 6],
    ]);
  });

  it('leaves the source series as it is', () => {
    const src = bars();
    samplesOf(<LineChart series={src} column="v" axis="a" xOffset="1s" />, 0);
    expect(Array.from(src.keyColumn().begin)).toEqual([0, 1000, 2000]);
  });

  it('throws on a value series, which has no time to move', () => {
    expect(() =>
      samplesOf(
        <LineChart
          series={bars().byValue('lo')}
          column="v"
          axis="a"
          xOffset="1s"
        />,
        0,
      ),
    ).toThrow(/xOffset moves a time axis/);
  });
});

describe('xOffset — session breaks are looked up over the drawn span', () => {
  function spyProvider(): {
    provider: DiscontinuityProvider;
    calls: Array<[number, number]>;
  } {
    const calls: Array<[number, number]> = [];
    const provider: DiscontinuityProvider = {
      distance: (a, b) => b - a,
      offset: (v, amt) => v + amt,
      clampUp: (t) => t,
      clampDown: (t) => t,
      copy: () => provider,
      boundaries: (from, to) => {
        calls.push([from, to]);
        return [];
      },
    };
    return { provider, calls };
  }

  it.each([
    [
      'LineChart',
      <LineChart
        key="l"
        series={bars()}
        column="v"
        axis="a"
        sessionBreaks
        xOffset="1s"
      />,
    ],
    [
      'BandChart',
      <BandChart
        key="b"
        series={bars()}
        lower="lo"
        upper="hi"
        axis="a"
        sessionBreaks
        xOffset="1s"
      />,
    ],
  ])('%s', (_name, layer) => {
    const stub = stubCanvasContext();
    const { provider, calls } = spyProvider();
    try {
      render(
        <ChartContainer
          range={[0, 4000]}
          width={320}
          discontinuities={provider}
        >
          <ChartRow height={120}>
            <YAxis id="a" min={0} max={20} />
            <Layers>{layer}</Layers>
          </ChartRow>
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    expect(calls).toContainEqual([1000, 3000]);
    expect(calls).not.toContainEqual([0, 2000]);
  });
});
