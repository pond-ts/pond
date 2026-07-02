import { useEffect, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { YAxisIndicator, createLiveValue } from './indicators.js';
import { priceSeries, RANGE } from './story-data.fixture.js';

/**
 * `<YAxisIndicator>` — a value pill pinned to a y-axis edge (the ChartIQ /
 * Yahoo-Finance live price tag). The value is **decoupled from the series' last
 * point**: a static `value`, or a `createLiveValue` `source` that updates the
 * pill at high frequency **without re-rendering the chart**. These stories fan
 * out: static vs live, `placement` (axis vs inside), and multiple tags.
 */
const W = 620;

const meta = {
  title: 'Charts/Indicators/Y Axis',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Static value** — a declarative `value`; default `placement="axis"` sits the
 *  pill on the gutter (covering the tick), with the dashed `line` across the plot. */
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

/** **placement="inside"** — the pill hugs the plot's inner edge, clear of the
 *  axis chrome (the ticks stay fully visible). */
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

/** Logs once per render — beside the live indicator to prove isolation: the pill
 *  ticks ~10×/s but this logs a single time (only the subscribed pill repaints). */
function RenderProbe({ label }: { label: string }) {
  const n = useRef(0);
  n.current += 1;
  // eslint-disable-next-line no-console
  console.log(`[isolation] ${label} render #${n.current}`);
  return null;
}

function LiveDemo() {
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

/** **Live** — `createLiveValue` + `.set()` at 10Hz. The pill moves and relabels
 *  every tick; the `[isolation]` console line proves the chart tree renders once. */
export const LiveValueTag: Story = {
  render: () => <LiveDemo />,
};

/** **Multiple tags** — a bid/ask pair on one axis, each its own live source. */
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
