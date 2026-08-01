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

describe('readout — gaps and bad column names', () => {
  /** The plotted column is finite everywhere; `raw` is missing at t=1000. */
  const gappy = () =>
    new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'sm', kind: 'number' },
        { name: 'raw', kind: 'number', required: false },
      ] as const,
      rows: [
        [0, 5, 50],
        [1000, 6, undefined],
        [2000, 7, 70],
      ] as never,
    });

  it('drops a non-finite readout but keeps the plotted sample', () => {
    // The readout is a *second* channel: losing it must not lose the sample,
    // or the cursor would blank wherever the source column has a hole.
    const [s] = samplesOf(
      <LineChart series={gappy()} column="sm" readout="raw" axis="a" />,
      [0, 2000],
      1000,
    );
    expect(s?.value).toBe(6); // the plotted sample survives…
    expect(s?.readout).toBeUndefined(); // …without a readout
  });

  // A mistyped `readout` used to throw on a value axis (via the reader) but
  // silently produce nothing on a time axis. Both now reject it the same way.
  it('throws on an unknown readout column — time axis', () => {
    expect(() =>
      samplesOf(
        <LineChart series={series()} column="sm" readout="nope" axis="a" />,
        [0, 2000],
        1000,
      ),
    ).toThrow(/unknown column/);
  });

  it('throws on an unknown readout column — value axis', () => {
    expect(() =>
      samplesOf(
        <LineChart
          series={series().byValue('dist')}
          column="sm"
          readout="nope"
          axis="a"
        />,
        [0, 200],
        100,
      ),
    ).toThrow(/unknown column/);
  });

  it('throws on a non-numeric readout column — time axis', () => {
    const withText = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'sm', kind: 'number' },
        { name: 'note', kind: 'string' },
      ] as const,
      rows: [[0, 5, 'a']],
    });
    expect(() =>
      samplesOf(
        <LineChart series={withText} column="sm" readout="note" axis="a" />,
        [0, 2000],
        0,
      ),
    ).toThrow(/must be numeric/);
  });

  it('AreaChart rejects a bad readout column the same way', () => {
    expect(() =>
      samplesOf(
        <AreaChart series={series()} column="sm" readout="nope" axis="a" />,
        [0, 2000],
        1000,
      ),
    ).toThrow(/unknown column/);
  });
});
