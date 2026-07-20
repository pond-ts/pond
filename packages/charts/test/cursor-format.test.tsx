/**
 * `cursorFormat` — the independent readout channel (#485), extended to value
 * axes and given pill precedence over an explicit axis `format` (#508 item 1).
 *
 * The contract under test:
 * - `ContainerFrame.formatTime` is the **label** channel: `timeFormat`-shaped,
 *   never `cursorFormat` (a readout format can't move the tick labels).
 * - `ContainerFrame.formatReadout` is the **readout** channel: defined iff
 *   `cursorFormat` is set, on time AND value axes; readout consumers fall back
 *   to the label channel without it.
 * - Pill precedence is `cursorFormat → axis format → container`, so terse
 *   ticks (`+2.0σ`) pair with a precise readout (`+1.83σ`) — the Tidal
 *   vol-surface ask.
 */
import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { Marker } from '../src/annotations.js';
import { XAxis } from '../src/XAxis.js';
import { YAxis } from '../src/YAxis.js';
import { ContainerContext, type ContainerFrame } from '../src/context.js';

afterEach(cleanup);

function Capture({ sink }: { sink: (f: ContainerFrame) => void }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) sink(c);
  });
  return null;
}

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

function valueFrame(props: Record<string, unknown>): ContainerFrame {
  let frame: ContainerFrame | null = null;
  render(
    <ChartContainer range={[0, 2400]} width={480} {...props}>
      <ChartRow height={120}>
        <Layers>
          <LineChart series={rideByDistance()} column="hr" />
        </Layers>
      </ChartRow>
      <Capture sink={(f) => (frame = f)} />
    </ChartContainer>,
  );
  return frame!;
}

describe('cursorFormat on a value axis (#508 item 1)', () => {
  it('a string is a d3 number specifier: shapes formatReadout, never formatTime', () => {
    const f = valueFrame({ cursorFormat: '.2f' });
    expect(f.xKind).toBe('value');
    // The readout channel carries the precise format…
    expect(f.formatReadout!(1830.5)).toBe('1830.50');
    // …while the label channel keeps the scale default — ticks don't move.
    expect(f.formatTime(1830.5)).toBe('1,831');
  });

  it('without cursorFormat the readout channel is unset (readout = labels)', () => {
    const f = valueFrame({});
    expect(f.formatReadout).toBeUndefined();
  });

  it('a function gets grain: undefined + the axis-default text, in data units', () => {
    const seen: Array<{ grain: unknown; defaultText: string }> = [];
    const f = valueFrame({
      cursorFormat: (
        v: number,
        ctx: { grain: unknown; defaultText: string },
      ) => {
        seen.push(ctx);
        return `+${(v / 1000).toFixed(2)}σ`;
      },
    });
    expect(f.formatReadout!(1830.5)).toBe('+1.83σ');
    expect(seen[0]!.grain).toBeUndefined(); // no time grain on a value axis
    expect(seen[0]!.defaultText).toBe('1,831'); // the label formatter's text
  });

  it('timeFormat still shapes the value-axis labels; cursorFormat only the readout', () => {
    const f = valueFrame({ timeFormat: '.0f', cursorFormat: '.2f' });
    expect(f.formatTime(1830.5)).toBe('1831'); // timeFormat-shaped labels
    expect(f.formatReadout!(1830.5)).toBe('1830.50'); // independent readout
  });
});

describe('axis-strip pill precedence: cursorFormat → axis format → container', () => {
  /** Render a value-axis chart with a `<Marker indicator>` — its axis pill is
   *  formatted by the same readout formatter the crosshair pill uses, with no
   *  pointer simulation needed. Returns the render for text queries. */
  function markerPill(props: {
    containerFormat?: string;
    axisFormat?: string;
  }) {
    return render(
      <ChartContainer
        range={[0, 2400]}
        width={480}
        showAxis={false}
        {...(props.containerFormat !== undefined
          ? { cursorFormat: props.containerFormat }
          : {})}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={200} />
          <Layers>
            <LineChart series={rideByDistance()} column="hr" axis="a" />
            {/* 530 sits off the tick grid, so the pill text never collides
                with a tick label rendering the same value. */}
            <Marker at={530} label={false} indicator />
          </Layers>
        </ChartRow>
        <XAxis
          {...(props.axisFormat !== undefined
            ? { format: props.axisFormat }
            : {})}
        />
      </ChartContainer>,
    );
  }

  it('cursorFormat beats an explicit axis format for the pill (readout only)', () => {
    const { container } = markerPill({
      containerFormat: '+.2f',
      axisFormat: '+.1f',
    });
    // The pill reads the precise cursorFormat…
    expect(within(container).getByText('+530.00')).toBeTruthy();
    // …while the tick labels keep the terse axis format (unmoved by cursorFormat).
    expect(within(container).getByText('+1000.0')).toBeTruthy();
    expect(within(container).queryByText('+1000.00')).toBeNull();
  });

  it('without cursorFormat the pill follows the axis format (agree-by-default)', () => {
    const { container } = markerPill({ axisFormat: '+.1f' });
    expect(within(container).getByText('+530.0')).toBeTruthy();
  });
});

describe('annotation auto-labels read the readout channel', () => {
  it('a value-axis marker auto-label is cursorFormat-shaped', () => {
    const { container } = render(
      <ChartContainer
        range={[0, 2400]}
        width={480}
        showAxis={false}
        cursorFormat={(v: number) => `@${v.toFixed(1)}`}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={200} />
          <Layers>
            <LineChart series={rideByDistance()} column="hr" axis="a" />
            <Marker at={500} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(within(container).getByText('@500.0')).toBeTruthy();
  });
});

describe('the #508 leak: timeFormat + cursorFormat together', () => {
  it('tick labels follow timeFormat; cursorFormat never reaches them', () => {
    const day = 86400_000;
    const t = new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [Date.UTC(2026, 0, 1), 1],
        [Date.UTC(2026, 0, 20), 2],
      ],
    });
    const { container } = render(
      <ChartContainer
        range={[Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1) + 20 * day]}
        width={640}
        showAxis={false}
        timeFormat="%Y"
        cursorFormat="%Y-%m-%d"
      >
        <ChartRow height={120}>
          <Layers>
            <LineChart series={t} column="v" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    const labels = Array.from(container.querySelectorAll('div'))
      .filter((el) => el.childElementCount === 0)
      .map((el) => el.textContent ?? '')
      .filter((s) => s.length > 0);
    // Pre-fix these rendered as 2026-01-04, 2026-01-07, … (cursorFormat leaked
    // into the labels the moment timeFormat disqualified the ladder).
    expect(labels.some((l) => /^\d{4}-\d{2}-\d{2}$/.test(l))).toBe(false);
    expect(labels.some((l) => /^2026$/.test(l))).toBe(true);
  });
});
