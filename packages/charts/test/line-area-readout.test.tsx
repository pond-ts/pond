/**
 * `<LineChart readout>` / `<AreaChart readout>` — the tracker reports a **source**
 * value from a second column while the layer keeps plotting `column`, so an
 * off-chart readout can show the raw value behind a smoothed / transformed line
 * (estela plots pace-space + Gaussian-smoothed, reads the native m/s). The
 * plotted `value` (hence the in-chart dot) is unchanged; `readout` rides
 * alongside on {@link TrackerSample.readout}.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { AreaChart } from '../src/AreaChart.js';
import { YAxis } from '../src/YAxis.js';
import type { TrackerInfo, TrackerSample } from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

// time, dist, `sm` (the plotted, "smoothed/transformed" column), `raw` (native).
const series = () =>
  new TimeSeries({
    name: 's',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'dist', kind: 'number' },
      { name: 'sm', kind: 'number' },
      { name: 'raw', kind: 'number' },
    ] as const,
    rows: [
      [0, 0, 5, 50],
      [1000, 100, 6, 60],
      [2000, 200, 7, 70],
    ],
  });

/** Render `child` under a controlled tracker and return the fanned-in samples. */
function samplesOf(
  child: React.ReactNode,
  range: [number, number],
  trackerPosition: number,
): TrackerSample[] {
  const stub = stubCanvasContext();
  try {
    const seen: Array<TrackerInfo | null> = [];
    render(
      <ChartContainer
        range={range}
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

describe('LineChart readout — time axis', () => {
  it('reports the readout column as `readout`, keeping the plotted value', () => {
    const [s] = samplesOf(
      <LineChart series={series()} column="sm" readout="raw" axis="a" />,
      [0, 2000],
      1000,
    );
    expect(s?.value).toBe(6); // plotted column (dot position) unchanged
    expect(s?.readout).toBe(60); // source column, alongside
  });

  it('omits `readout` when no readout column is given', () => {
    const [s] = samplesOf(
      <LineChart series={series()} column="sm" axis="a" />,
      [0, 2000],
      1000,
    );
    expect(s?.value).toBe(6);
    expect(s?.readout).toBeUndefined();
  });
});

describe('LineChart readout — value axis (byValue, estela’s case)', () => {
  it('reads the readout column at the nearest axis value', () => {
    const [s] = samplesOf(
      <LineChart
        series={series().byValue('dist')}
        column="sm"
        readout="raw"
        axis="a"
      />,
      [0, 200],
      100,
    );
    expect(s?.value).toBe(6);
    expect(s?.readout).toBe(60);
  });
});

describe('AreaChart readout', () => {
  it('carries the source value on the area’s tracker sample too', () => {
    const [s] = samplesOf(
      <AreaChart series={series()} column="sm" readout="raw" axis="a" />,
      [0, 2000],
      2000,
    );
    expect(s?.value).toBe(7);
    expect(s?.readout).toBe(70);
  });
});
