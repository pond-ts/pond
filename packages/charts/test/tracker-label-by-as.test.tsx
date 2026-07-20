/**
 * Tracker labels key on the series' semantic `as`, not raw column names
 * (F-charts-8 §3 — the [PND-LEGEND] label-source prerequisite).
 *
 * The convention (shipped first by BoxPlot's qLabel, pinned here across the
 * multi-value marks): with an `as`, a multi-value mark's samples read
 * `"<as> <role>"` (`iv lower`, `SPY high`) so readout/legend merge keys are
 * the series identity; without one, the raw column (or role) name stands.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BandChart } from '../src/BandChart.js';
import { Candlestick } from '../src/Candlestick.js';
import { YAxis } from '../src/YAxis.js';
import type { TrackerInfo } from '../src/ChartContainer.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const bandSeries = () =>
  new TimeSeries({
    name: 'spread',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'p25', kind: 'number' },
      { name: 'p75', kind: 'number' },
    ] as const,
    rows: [
      [0, 1, 3],
      [1000, 2, 4],
      [2000, 1.5, 3.5],
    ],
  });

const ohlcSeries = () =>
  new TimeSeries({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'open', kind: 'number' },
      { name: 'high', kind: 'number' },
      { name: 'low', kind: 'number' },
      { name: 'close', kind: 'number' },
    ] as const,
    rows: [
      [0, 10, 12, 9, 11],
      [1000, 11, 13, 10, 12],
      [2000, 12, 14, 11, 13],
    ],
  });

/** Render `child` under a controlled tracker and return the fanned-in labels. */
function labelsOf(child: React.ReactNode): string[] {
  const stub = stubCanvasContext();
  try {
    const seen: Array<TrackerInfo | null> = [];
    render(
      <ChartContainer
        range={[0, 2000]}
        width={400}
        trackerPosition={1000}
        onTrackerChanged={(info) => seen.push(info)}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={20} />
          <Layers>{child}</Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const last = seen.filter(Boolean).at(-1);
    return (last?.values ?? []).map((v) => v.label);
  } finally {
    stub.restore();
  }
}

describe('BandChart tracker labels', () => {
  it('without `as`: raw column names (self-evident roles)', () => {
    expect(
      labelsOf(
        <BandChart series={bandSeries()} lower="p25" upper="p75" axis="a" />,
      ),
    ).toEqual(['p25', 'p75']);
  });

  it('with `as`: series name + role — `iv lower` / `iv upper`', () => {
    expect(
      labelsOf(
        <BandChart
          series={bandSeries()}
          lower="p25"
          upper="p75"
          as="iv"
          axis="a"
        />,
      ),
    ).toEqual(['iv lower', 'iv upper']);
  });
});

describe('Candlestick tracker labels', () => {
  it('primary readout keys on `as` (the close pill is "the price")', () => {
    expect(
      labelsOf(<Candlestick series={ohlcSeries()} as="SPY" axis="a" />),
    ).toEqual(['SPY']);
  });

  it('showOHLC without `as`: bare role words', () => {
    expect(
      labelsOf(<Candlestick series={ohlcSeries()} showOHLC axis="a" />),
    ).toEqual(['high', 'open', 'close', 'low']);
  });

  it('showOHLC with `as`: series name + role — `SPY high` …', () => {
    expect(
      labelsOf(
        <Candlestick series={ohlcSeries()} as="SPY" showOHLC axis="a" />,
      ),
    ).toEqual(['SPY high', 'SPY open', 'SPY close', 'SPY low']);
  });
});
