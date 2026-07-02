import { useEffect, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { Baseline, Marker } from './annotations.js';
import { defaultTheme } from './theme.js';
import { YAxisIndicator, createLiveValue } from './indicators.js';

/**
 * Axis **value indicators** — a pill pinned to an axis edge at a value (the
 * ChartIQ / Yahoo-Finance live price tag). The value is decoupled from the
 * series' last point; a {@link createLiveValue} source updates the pill at high
 * frequency without re-rendering the chart.
 */
const N = 90;
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

function priceSeries() {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([BASE + i * STEP, 185 + 30 * Math.sin(i / 10)]);
  }
  return new TimeSeries({
    name: 'price',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'price', kind: 'number' },
    ] as const,
    rows,
  });
}

const meta = {
  title: 'Charts/Indicators',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const W = 620;

/** A static value pill (declarative `value` prop), default `placement="axis"`
 *  so the pill sits **on the axis gutter** (covering the tick at 207.40) — the
 *  ChartIQ live-tag look — with the dashed guide line across the plot. */
export const StaticValue: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator
            value={207.4}
            axis="usd"
            color="#4a90e2"
            format=",.2f"
            line
          />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** `placement="inside"` — the pill hugs the plot's inner edge, clear of the axis
 *  chrome (the ticks stay fully visible). The alternative to the default
 *  on-axis placement. */
export const InsidePlacement: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator
            value={207.4}
            axis="usd"
            color="#4a90e2"
            format=",.2f"
            placement="inside"
            line
          />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** Logs once per render — placed beside the live indicator to prove isolation:
 *  the pill ticks ~10×/s but this logs a single time (the chart tree never
 *  re-renders; only the subscribed pill does). Renders nothing. */
function RenderProbe({ label }: { label: string }) {
  const n = useRef(0);
  n.current += 1;
  // eslint-disable-next-line no-console
  console.log(`[isolation] ${label} render #${n.current}`);
  return null;
}

function LiveDemo() {
  // The live value — driven imperatively from an interval, outside React state.
  const live = useRef(createLiveValue(200)).current;
  useEffect(() => {
    let v = 200;
    const id = setInterval(() => {
      v += (Math.random() - 0.5) * 6;
      v = Math.max(160, Math.min(212, v));
      live.set(v); // no setState — only the subscribed pill repaints
    }, 100);
    return () => clearInterval(id);
  }, [live]);

  return (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <RenderProbe label="chart-subtree" />
          <YAxisIndicator
            source={live}
            axis="usd"
            color="#3fb950"
            format=",.2f"
            line
          />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  );
}

/** A **live** value pill: `createLiveValue` + `.set()` at 10Hz. The pill moves
 *  and relabels every tick; the `[isolation]` console line proves the chart tree
 *  renders only once. */
export const LiveValueTag: Story = {
  render: () => <LiveDemo />,
};

/** Two live tags on the same axis (a bid/ask pair), each its own source. */
export const DualLiveTags: Story = {
  render: () => {
    function Pair() {
      const bid = useRef(createLiveValue(198)).current;
      const ask = useRef(createLiveValue(202)).current;
      useEffect(() => {
        let b = 198;
        let a = 202;
        const id = setInterval(() => {
          b = Math.max(160, Math.min(210, b + (Math.random() - 0.5) * 4));
          a = Math.max(b + 1, Math.min(212, a + (Math.random() - 0.5) * 4));
          bid.set(b);
          ask.set(a);
        }, 120);
        return () => clearInterval(id);
      }, [bid, ask]);
      return (
        <ChartContainer range={RANGE} width={W}>
          <ChartRow height={220}>
            <Layers>
              <LineChart series={priceSeries()} column="price" axis="usd" />
              <YAxisIndicator
                source={bid}
                axis="usd"
                color="#3fb950"
                format=",.2f"
              />
              <YAxisIndicator
                source={ask}
                axis="usd"
                color="#e5534b"
                format=",.2f"
              />
            </Layers>
            <YAxis id="usd" side="right" format=",.0f" />
          </ChartRow>
        </ChartContainer>
      );
    }
    return <Pair />;
  },
};

/** Two series with a fast + slow line, for the crosshair. */
function twoSeries() {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([
      BASE + i * STEP,
      185 + 30 * Math.sin(i / 10),
      190 + 18 * Math.sin(i / 6 + 1),
    ]);
  }
  return new TimeSeries({
    name: 'pair',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'fast', kind: 'number' },
      { name: 'slow', kind: 'number' },
    ] as const,
    rows,
  });
}

/** `cursor="crosshair"` — hover the plot: the synced vertical line + a dot on
 *  each series, each series' value pinned to the y-axis (an on-axis pill in the
 *  series colour) and the hovered time pinned to the x-axis. The trading-terminal
 *  readout. */
const twoColorTheme = {
  ...defaultTheme,
  line: {
    ...defaultTheme.line,
    fast: { ...defaultTheme.line.default, color: '#4a90e2' },
    slow: { ...defaultTheme.line.default, color: '#e5534b' },
  },
};

export const Crosshair: Story = {
  render: () => {
    const s = twoSeries();
    return (
      <ChartContainer
        range={RANGE}
        width={W}
        cursor="crosshair"
        theme={twoColorTheme}
      >
        <ChartRow height={240}>
          <Layers>
            <LineChart series={s} column="fast" as="fast" axis="usd" />
            <LineChart series={s} column="slow" as="slow" axis="usd" />
          </Layers>
          <YAxis id="usd" side="right" format=",.0f" />
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** Crosshair across **two stacked rows** sharing the time axis, `cursorTime` on.
 *  The time shows once — on the shared x-axis pill at the bottom — not repeated
 *  as a per-row chip on each row. `trackerPosition` pins it for a static shot. */
export const MultiRowCrosshair: Story = {
  render: () => {
    const s = twoSeries();
    return (
      <ChartContainer
        range={RANGE}
        width={W}
        cursor="crosshair"
        cursorTime
        trackerPosition={BASE + 40 * STEP}
        theme={twoColorTheme}
      >
        <ChartRow height={160}>
          <Layers>
            <LineChart series={s} column="fast" as="fast" axis="a" />
          </Layers>
          <YAxis id="a" side="right" format=",.0f" />
        </ChartRow>
        <ChartRow height={160}>
          <Layers>
            <LineChart series={s} column="slow" as="slow" axis="b" />
          </Layers>
          <YAxis id="b" side="right" format=",.0f" />
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** `<Baseline indicator>` pins its value to the y-axis; `<Marker indicator>`
 *  pins its time to the x-axis — both as on-axis pills in the annotation colour
 *  (here with `label={false}` so only the axis pill shows, no in-plot chip). */
export const AnnotationIndicators: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <Baseline value={200} axis="usd" indicator label={false} />
          <Marker at={BASE + 45 * STEP} indicator label={false} />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};
