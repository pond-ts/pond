import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { BarChart } from './BarChart.js';
import { XAxis } from './XAxis.js';
import { YAxis } from './YAxis.js';

/**
 * Axis pan/zoom — the strips are grabbable, and double-click puts one back.
 * Turned on by `<ChartContainer axisPanZoom>` (`'x'` / `'y'` / `'xy'`), which is
 * **separate from `panZoom`**: the plot's gestures and the axes' are independent
 * opt-ins, so no chart grows axis gestures it didn't ask for. One story per
 * surface the gestures behave differently on.
 *
 * **Every strip is the canvas gesture**: drag pans, wheel zooms — the same
 * vocabulary as dragging the plot itself, so there is one model to learn. A y
 * gutter's pan moves only *that* axis, which is the thing the plot cannot do
 * per axis (its vertical drag, where enabled, scales every axis in the row at
 * once).
 */
const N = 240;
const BASE = Date.UTC(2026, 2, 2, 9, 30, 0);
const STEP = 60_000;
const RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];
const W = 560;

function demo() {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([
      BASE + i * STEP,
      185 + 30 * Math.sin(i / 30) + 4 * Math.sin(i / 3),
      40 + 25 * Math.cos(i / 20),
    ]);
  }
  return new TimeSeries({
    name: 'demo',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'price', kind: 'number' },
      { name: 'flow', kind: 'number' },
    ] as const,
    rows,
  });
}

const DESKS = ['EMEA', 'APAC', 'AMER', 'LATAM', 'MEA'];
const desks = DESKS.map((label, i) => ({ label, value: 12 + i * 7 }));

const meta = {
  title: 'Axes/PanZoom',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * `panZoom="panZoom"` — the x strip, behaving as the canvas does: **drag pans**
 * (the span holds, the window slides), **wheel zooms** about the pointer,
 * double-click returns to the declared range.
 */
export const XStripPanAndZoom: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      showAxis={false}
      panZoom="panZoom"
      axisPanZoom="x"
    >
      <ChartRow height={200}>
        <YAxis id="price" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="price" axis="price" />
        </Layers>
      </ChartRow>
      <XAxis label="drag to pan · wheel to zoom · double-click to reset" />
    </ChartContainer>
  ),
};

/**
 * `axisPanZoom="y"` — each gutter scales **itself**. Drag the left one and
 * watch the right one hold still: the per-axis transform is the whole point.
 */
export const YGutterPerAxis: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W + 60} axisPanZoom="y">
      <ChartRow height={220}>
        <YAxis id="price" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="price" axis="price" />
          <LineChart series={demo()} column="flow" axis="flow" />
        </Layers>
        <YAxis id="flow" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * `axisPanZoom="xy"` — every strip is live, and `panZoom="panZoomXY"` keeps the
 * plot's own 2-D gesture alongside. The plot's vertical gesture
 * still scales both axes **together** (the uniform transform, which is what fixes
 * the aspect ratio — it's what you want on a scatter or heat map); a gutter drag
 * scales just the one you grabbed.
 */
export const BothAxes: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W + 60}
      showAxis={false}
      panZoom="panZoomXY"
      axisPanZoom="xy"
    >
      <ChartRow height={220}>
        <YAxis id="price" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="price" axis="price" />
          <LineChart series={demo()} column="flow" axis="flow" />
        </Layers>
        <YAxis id="flow" side="right" format=",.0f" />
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

/**
 * Two rows, one shared x. A gutter drag is scoped to its own row's axis — the
 * lower row doesn't move — while the x strip moves both rows at once, because
 * the x view is the container's.
 */
export const StackedRows: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      showAxis={false}
      panZoom="panZoomXY"
      axisPanZoom="xy"
    >
      <ChartRow height={140}>
        <YAxis id="price" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="price" axis="price" />
        </Layers>
      </ChartRow>
      <ChartRow height={100}>
        <YAxis id="flow" format=",.0f" />
        <Layers>
          <LineChart series={demo()} column="flow" axis="flow" />
        </Layers>
      </ChartRow>
      <XAxis />
    </ChartContainer>
  ),
};

/**
 * `minDuration` is the zoom-in floor for the strip exactly as for the plot —
 * wheel in as hard as you like, the view stops at 30 minutes. (The drag pans, so
 * it never meets this floor.)
 */
export const ZoomInFloor: Story = {
  render: () => (
    <ChartContainer
      range={RANGE}
      width={W}
      showAxis={false}
      panZoom="panZoom"
      axisPanZoom="x"
      minDuration={30 * 60_000}
    >
      <ChartRow height={200}>
        <YAxis id="price" format="$,.0f" />
        <Layers>
          <LineChart series={demo()} column="price" axis="price" />
        </Layers>
      </ChartRow>
      <XAxis label="wheel in — floors at 30 minutes" />
    </ChartContainer>
  ),
};

/**
 * A **category** x axis has no continuous domain to pan or zoom, so its strip
 * stays inert (no grab cursor) even under `panZoomXY` — the y gutter still zooms.
 */
export const CategoryStripInert: Story = {
  render: () => (
    <ChartContainer
      width={W}
      categories={DESKS}
      showAxis={false}
      panZoom="panZoomXY"
      axisPanZoom="xy"
    >
      <ChartRow height={200}>
        <YAxis id="flow" format=",.0f" />
        <Layers>
          <BarChart categories={desks} axis="flow" />
        </Layers>
      </ChartRow>
      <XAxis label="inert — categories don't pan or zoom" />
    </ChartContainer>
  ),
};

/**
 * **The common setup, end to end.** An auto-fitting y axis on a chart whose x is
 * panned and zoomed — and the moment you scroll or drag the y gutter, the fit is
 * overridden: `onBoundsChange` reports the `[min, max]` the gesture reached, the
 * panel below flips to **manual** and shows them, and the axis draws what the
 * panel feeds back. Put it back with the toggle or by double-clicking the gutter;
 * while it is auto, the min/max are the fit's and not yours to set.
 *
 * Note `axisPanZoom="y"` alongside a plain `panZoom` — scaling y does not require
 * opting the plot into vertical gestures.
 */
export const AutoOrManualYScale: Story = {
  render: function Render() {
    const [domain, setDomain] = useState<readonly [number, number] | null>(
      null,
    );
    const manual = domain !== null;
    const fmt = (v: number) => `$${v.toFixed(2)}`;
    return (
      <div style={{ width: W }}>
        <ChartContainer
          range={RANGE}
          width={W}
          panZoom="panZoom"
          axisPanZoom="y"
        >
          <ChartRow height={200}>
            <YAxis
              id="price"
              format="$,.0f"
              {...(domain ? { min: domain[0], max: domain[1] } : {})}
              onBoundsChange={setDomain}
            />
            <Layers>
              <LineChart series={demo()} column="price" axis="price" />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <div
          style={{
            marginTop: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            fontSize: 13,
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <button
            type="button"
            onClick={() => setDomain(null)}
            disabled={!manual}
            style={{ padding: '4px 10px' }}
          >
            {manual ? 'manual → auto' : 'auto'}
          </button>
          <span style={{ opacity: manual ? 1 : 0.55 }}>
            {manual
              ? `min ${fmt(domain[0])} · max ${fmt(domain[1])}`
              : 'min / max follow the data (scroll or drag the y axis to override)'}
          </span>
        </div>
      </div>
    );
  },
};
