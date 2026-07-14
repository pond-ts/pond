import { useEffect, useRef } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { YAxisIndicator, createLiveValue } from './indicators.js';
import { priceSeries, RANGE } from './story-data.fixture.js';
import { docsTheme } from './docs-theme.fixture.js';

/**
 * `<YAxisIndicator>` — a value pill pinned to a y-axis edge (the ChartIQ /
 * Yahoo-Finance live price tag). The value is **decoupled from the series' last
 * point**: a static `value`, or a `createLiveValue` `source` that updates the
 * pill at high frequency **without re-rendering the chart**. It always shows the
 * axis value (no label — a name belongs on a Baseline's near-line chip). These
 * stories fan out one prop / combination at a time: `side`, `format`, `line`,
 * `pointer`, `color`, a live `source`, and multiple simultaneous tags.
 */
const W = 620;

const meta = {
  title: 'Indicators/Y Axis',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** **Static value** — a declarative `value`; default `placement="axis"` sits the
 *  pill on the gutter (covering the tick), with the dashed `line` across the plot. */
export const StaticValue: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
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

/** **Pointer** — `pointer` adds a small triangle on the pill's plot-facing edge,
 *  pointing into the plot at the value (a callout tab). */
export const Pointer: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator
            value={207.4}
            axis="usd"
            color="#4a90e2"
            format=",.2f"
            pointer
            line
          />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **side="right"** — the pill hugs the plot's right edge, matching a right-side
 *  `<YAxis>` (the conventional pairing — the pill sits on top of that gutter). */
export const SideRight: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator
            value={207.4}
            axis="usd"
            side="right"
            color="#4a90e2"
            format=",.2f"
          />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **side="left"** — the pill hugs the plot's left edge instead; pair it with a
 *  left-side `<YAxis>` so it lands on that gutter rather than floating over the plot. */
export const SideLeft: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator
            value={207.4}
            axis="usd"
            side="left"
            color="#4a90e2"
            format=",.2f"
          />
        </Layers>
        <YAxis id="usd" side="left" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Default format** — omit `format` and the pill borrows the linked axis's own
 *  formatter, so it reads exactly like a tick (coarse, `,.0f` here). */
export const DefaultFormat: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator value={207.4} axis="usd" color="#4a90e2" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Custom format** — a `format` specifier finer than the axis's own tick
 *  rounding (`,.2f` cents vs the axis's whole-dollar `,.0f` ticks). */
export const CustomFormat: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator
            value={207.4}
            axis="usd"
            color="#4a90e2"
            format=",.2f"
          />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **format as a function** — `format` also accepts `(value) => string`, for a
 *  label the d3 mini-language can't express (a `$` prefix here). */
export const FunctionFormat: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator
            value={207.4}
            axis="usd"
            color="#4a90e2"
            format={(v) => `$${v.toFixed(2)}`}
          />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **line={false} (default)** — no guide line, just the pill; the plot stays
 *  uncluttered when the eye only needs the edge value. */
export const LineOff: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator
            value={207.4}
            axis="usd"
            color="#4a90e2"
            format=",.2f"
          />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **line** — a dashed guide line traces the value across the full plot width
 *  (the ChartIQ "price line"), tying the pill back to the series it tracks. */
export const LineOn: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
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

/** **Default color** — omit `color` and the pill falls back to the axis label
 *  colour (`theme.axis.label`), so it reads as neutral axis chrome. */
export const DefaultColor: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator value={207.4} axis="usd" format=",.2f" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Custom color** — `color` ties the pill's hue to the series it tracks,
 *  independent of the axis's own (neutral) label colour. */
export const CustomColor: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator
            value={207.4}
            axis="usd"
            color="#e5534b"
            format=",.2f"
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
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
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

/** **Live source** — `createLiveValue` + `.set()` at 10Hz. The pill moves and
 *  relabels every tick; the `[isolation]` console line proves the chart tree
 *  (and the canvas underneath it) renders exactly once. */
export const LiveValueTag: Story = {
  render: () => <LiveDemo />,
};

/** **source overrides value** — passing both, `source` wins: the pill tracks the
 *  live feed while the stale `value` is ignored outright. */
function SourceOverridesValueDemo() {
  const live = useRef(createLiveValue(180)).current;
  useEffect(() => {
    let v = 180;
    const id = setInterval(() => {
      v += (Math.random() - 0.5) * 5;
      v = Math.max(160, Math.min(212, v));
      live.set(v);
    }, 100);
    return () => clearInterval(id);
  }, [live]);
  return (
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="usd" />
          <YAxisIndicator
            value={207.4}
            source={live}
            axis="usd"
            color="#3fb950"
            format=",.2f"
          />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  );
}

export const SourceOverridesValue: Story = {
  render: () => <SourceOverridesValueDemo />,
};

/** **Multiple live tags** — a bid/ask pair on one axis, each its own live
 *  `source`, colour-coded and updating independently. */
function DualLiveDemo() {
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
    <ChartContainer range={RANGE} width={W} theme={docsTheme}>
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

export const DualLiveTags: Story = {
  render: () => <DualLiveDemo />,
};
