import { useContext } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries, ValueSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { ScatterChart } from '../src/ScatterChart.js';
import { YAxis } from '../src/YAxis.js';
import { ContainerContext } from '../src/context.js';

afterEach(cleanup);

/**
 * `<ScatterChart>` on a `ValueSeries` — the value-axis widening (mirrors
 * `<LineChart>`'s instanceof-branched adapter). A smile-shaped fixture: IV
 * marks keyed by strike, built through the direct door
 * (`ValueSeries.fromColumns`).
 */
const smile = () =>
  ValueSeries.fromColumns({
    name: 'smile',
    schema: [
      { name: 'strike', kind: 'value' },
      { name: 'iv', kind: 'number' },
      { name: 'oi', kind: 'number' },
    ] as const,
    columns: {
      strike: [90, 95, 100, 105, 110],
      iv: [0.31, 0.27, 0.25, 0.26, 0.29],
      oi: [120, 340, 900, 410, 150],
    },
  });

const timeSeries = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 1],
      [1000, 2],
    ],
  });

/** Reads the container frame each render; assert on the last settled state. */
function Probe({
  spy,
}: {
  spy: (frame: { xKind: string; domain: [number, number] }) => void;
}) {
  const c = useContext(ContainerContext);
  if (c) {
    const d = c.xScale.domain() as unknown as [number, number];
    spy({ xKind: c.xKind, domain: [Number(d[0]), Number(d[1])] });
  }
  return null;
}
const last = (spy: ReturnType<typeof vi.fn>) => spy.mock.calls.at(-1)?.[0];

describe('ScatterChart on a ValueSeries', () => {
  it('registers a value x-kind and auto-fits the domain to the axis extent', () => {
    const spy = vi.fn();
    render(
      <ChartContainer width={400} showAxis={false}>
        <ChartRow height={120}>
          <YAxis id="iv" />
          <Layers>
            <ScatterChart series={smile()} column="iv" id="iv" />
          </Layers>
          <Probe spy={spy} />
        </ChartRow>
      </ChartContainer>,
    );
    expect(last(spy)).toEqual({ xKind: 'value', domain: [90, 110] });
  });

  it('data-driven radius + colour encodings resolve against the ValueSeries', () => {
    // resolveEncoding reads the encoding columns eagerly through the branched
    // reader (fromValueSeries), so a working render pins the reader; a typo'd
    // column must still throw rather than silently render base-styled points.
    expect(() =>
      render(
        <ChartContainer width={400} showAxis={false}>
          <ChartRow height={120}>
            <YAxis id="iv" />
            <Layers>
              <ScatterChart
                series={smile()}
                column="iv"
                radius={{ column: 'oi', range: [3, 12] }}
                color={{ column: 'oi', range: ['#e8836b', '#15B3A6'] }}
                label="oi"
              />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      ),
    ).not.toThrow();
    expect(() =>
      render(
        <ChartContainer width={400} showAxis={false}>
          <ChartRow height={120}>
            <YAxis id="iv" />
            <Layers>
              <ScatterChart
                series={smile()}
                column="iv"
                radius={{ column: 'nope', range: [3, 12] }}
              />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      ),
    ).toThrow();
  });

  it('a ValueSeries scatter overlays a ValueSeries line on one shared value axis', () => {
    const spy = vi.fn();
    render(
      <ChartContainer width={400} showAxis={false}>
        <ChartRow height={120}>
          <YAxis id="iv" />
          <Layers>
            <LineChart series={smile()} column="iv" />
            <ScatterChart series={smile()} column="iv" id="marks" />
          </Layers>
          <Probe spy={spy} />
        </ChartRow>
      </ChartContainer>,
    );
    expect(last(spy)?.xKind).toBe('value');
  });

  it('mixing a ValueSeries scatter with a TimeSeries layer is a hard error', () => {
    // React logs the thrown render error; keep the test output clean.
    const muted = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        render(
          <ChartContainer width={400} showAxis={false}>
            <ChartRow height={120}>
              <YAxis id="v" />
              <Layers>
                <LineChart series={timeSeries()} column="v" />
                <ScatterChart series={smile()} column="iv" />
              </Layers>
            </ChartRow>
          </ChartContainer>,
        ),
      ).toThrow(/mix x-axis kinds/);
    } finally {
      muted.mockRestore();
    }
  });
});
