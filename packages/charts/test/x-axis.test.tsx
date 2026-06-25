import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { XAxis } from '../src/XAxis.js';

afterEach(cleanup);

/** A ride re-keyed onto cumulative distance — a value (non-time) x axis. */
const rideByDistance = () =>
  new TimeSeries({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'cumDist', kind: 'number' },
      { name: 'hr', kind: 'number' },
    ] as const,
    rows: [
      [0, 0, 120],
      [1000, 500, 130],
      [2000, 1200, 140],
      [3000, 2400, 150],
    ],
  }).byValue('cumDist');

/** A plain time-keyed series. */
const timeSeries = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  });

describe('<XAxis> — the placeable x axis', () => {
  it('renders explicit ticks verbatim (the lap-markers lever) + a centred label', () => {
    const { getByText } = render(
      <ChartContainer range={[0, 2400]} width={480} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis
          label="Distance (m)"
          ticks={[
            { at: 500, label: 'Lap 1' },
            { at: 1800, label: 'Lap 2' },
          ]}
        />
      </ChartContainer>,
    );
    // Custom tick labels render as-is — the scale's auto ticks are bypassed.
    expect(getByText('Lap 1')).toBeTruthy();
    expect(getByText('Lap 2')).toBeTruthy();
    expect(getByText('Distance (m)')).toBeTruthy();
  });

  it('formats value-axis ticks with the given d3 number specifier', () => {
    const { getByText } = render(
      <ChartContainer range={[0, 5000]} width={480} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis format=",.0f" />
      </ChartContainer>,
    );
    // The value scale ([0,5000]) auto-ticks at 1000s; `,.0f` adds the comma.
    expect(getByText('1,000')).toBeTruthy();
    expect(getByText('2,000')).toBeTruthy();
  });

  it('rules its plot-facing edge per `side` (a top axis rules its bottom)', () => {
    const { getByText } = render(
      <ChartContainer range={[0, 2400]} width={480} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis side="top" label="top-axis" />
      </ChartContainer>,
    );
    // The label sits in the strip div; a `side="top"` axis carries its 1px rule
    // on the bottom (plot-facing) edge, not the top.
    const strip = getByText('top-axis').parentElement!;
    expect(strip.style.borderBottom).toBeTruthy();
    expect(strip.style.borderTop).toBeFalsy();
  });
});

describe('x-axis kind inference', () => {
  it('plots a ValueSeries row against a numeric (value) axis — auto-fit, no range', () => {
    // No `range`: the container auto-fits to the data's cumDist extent [0,2400].
    // The auto ticks land on 0/500/1000/… — proof the inferred scale is linear
    // (a time scale would render wall-clock labels instead).
    const { getByText } = render(
      <ChartContainer width={480}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(getByText('500')).toBeTruthy();
    expect(getByText('1,000')).toBeTruthy();
  });

  it('throws a hard error when a container mixes time and value rows', () => {
    // The throw fires from the kind-resolve useMemo once both layers have
    // registered (the two-pass), surfacing as a render error. Silence React's
    // expected console.error so the run output stays clean.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <ChartContainer width={400}>
          <ChartRow height={100}>
            <Layers>
              <LineChart series={timeSeries()} column="v" />
              <LineChart series={rideByDistance()} column="hr" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      ),
    ).toThrow(/mix x-axis kinds/);
    spy.mockRestore();
  });
});
