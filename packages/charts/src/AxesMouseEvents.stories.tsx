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
import type { AxisMouseEvent } from './axis-events.js';

/**
 * `onMouseEvent` on `<XAxis>` / `<YAxis>` — every mouse event on an axis strip,
 * carrying the **axis value under the pointer**. One story per surface the
 * payload changes on: the time strip, the y gutter, a category axis, the
 * every-event routing, and one handler shared across several axes.
 *
 * Each story prints the last payload under the chart — click the axes.
 */
const N = 60;
const BASE = Date.UTC(2026, 2, 2, 9, 30, 0);
const STEP = 60_000;
const RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];
const W = 560;

function demo() {
  const rows: Array<[number, number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([
      BASE + i * STEP,
      185 + 30 * Math.sin(i / 8),
      40 + 25 * Math.cos(i / 5),
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

/** The last payload, printed as the story's proof. */
function Readout({ log }: { log: readonly string[] }) {
  return (
    <pre
      style={{
        marginTop: 12,
        padding: '8px 10px',
        minHeight: 54,
        fontSize: 12,
        lineHeight: 1.5,
        background: 'rgba(127,127,127,0.10)',
        borderRadius: 6,
      }}
    >
      {log.length === 0 ? 'click (or hover) an axis…' : log.join('\n')}
    </pre>
  );
}

/** Formats a payload for the readout — the fields, in payload order. */
const line = (i: AxisMouseEvent) =>
  `${i.event.type.padEnd(12)} axis=${i.axis} id=${i.id ?? '—'} value=${
    Number.isInteger(i.value) ? i.value : i.value.toFixed(2)
  } label=${i.label}`;

/** Keeps the last `keep` payloads. */
function useLog(keep = 1) {
  const [log, setLog] = useState<readonly string[]>([]);
  return [
    log,
    (info: AxisMouseEvent) =>
      setLog((prev) => [...prev, line(info)].slice(-keep)),
  ] as const;
}

const meta = {
  title: 'Axes/MouseEvents',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** X axis: a click reports the instant it landed on. `id` is `—` (x has none). */
export const XAxisClick: Story = {
  render: function Render() {
    const [log, push] = useLog();
    return (
      <div style={{ width: W }}>
        <ChartContainer range={RANGE} width={W} showAxis={false}>
          <ChartRow height={180}>
            <YAxis id="price" format="$,.0f" />
            <Layers>
              <LineChart series={demo()} column="price" axis="price" />
            </Layers>
          </ChartRow>
          <XAxis
            label="click me"
            onMouseEvent={(i) => i.event.type === 'click' && push(i)}
          />
        </ChartContainer>
        <Readout log={log} />
      </div>
    );
  },
};

/** Y axis: a click reports the value **and** the axis's `id`. */
export const YAxisClick: Story = {
  render: function Render() {
    const [log, push] = useLog();
    return (
      <div style={{ width: W }}>
        <ChartContainer range={RANGE} width={W}>
          <ChartRow height={180}>
            <YAxis
              id="price"
              format="$,.0f"
              onMouseEvent={(i) => i.event.type === 'click' && push(i)}
            />
            <Layers>
              <LineChart series={demo()} column="price" axis="price" />
            </Layers>
          </ChartRow>
        </ChartContainer>
        <Readout log={log} />
      </div>
    );
  },
};

/** Category axis: the value snaps to the band centre, the label names it. */
export const CategoryAxisClick: Story = {
  render: function Render() {
    const [log, push] = useLog();
    return (
      <div style={{ width: W }}>
        <ChartContainer width={W} categories={DESKS} showAxis={false}>
          <ChartRow height={180}>
            <YAxis id="flow" format=",.0f" />
            <Layers>
              <BarChart categories={desks} axis="flow" />
            </Layers>
          </ChartRow>
          <XAxis onMouseEvent={(i) => i.event.type === 'click' && push(i)} />
        </ChartContainer>
        <Readout log={log} />
      </div>
    );
  },
};

/**
 * Every mouse event goes to the one handler — hover, press, right-click and
 * double-click the strip and watch `type` change. The last six are kept.
 */
export const EveryEventType: Story = {
  render: function Render() {
    const [log, push] = useLog(6);
    return (
      <div style={{ width: W }}>
        <ChartContainer range={RANGE} width={W} showAxis={false}>
          <ChartRow height={180}>
            <YAxis id="price" format="$,.0f" />
            <Layers>
              <LineChart series={demo()} column="price" axis="price" />
            </Layers>
          </ChartRow>
          <XAxis label="hover / press / right-click" onMouseEvent={push} />
        </ChartContainer>
        <Readout log={log} />
      </div>
    );
  },
};

/**
 * One handler across three axes: `axis` separates x from y, `id` separates the
 * two y gutters. The x strip reports `id=—`, which is why a stacked-x consumer
 * closes over its own name instead.
 */
export const OneHandlerManyAxes: Story = {
  render: function Render() {
    const [log, push] = useLog(3);
    return (
      <div style={{ width: W }}>
        <ChartContainer range={RANGE} width={W} showAxis={false}>
          <ChartRow height={180}>
            <YAxis
              id="price"
              format="$,.0f"
              onMouseEvent={(i) => i.event.type === 'click' && push(i)}
            />
            <Layers>
              <LineChart series={demo()} column="price" axis="price" />
              <LineChart series={demo()} column="flow" axis="flow" />
            </Layers>
            <YAxis
              id="flow"
              side="right"
              format=",.0f"
              onMouseEvent={(i) => i.event.type === 'click' && push(i)}
            />
          </ChartRow>
          <XAxis onMouseEvent={(i) => i.event.type === 'click' && push(i)} />
        </ChartContainer>
        <Readout log={log} />
      </div>
    );
  },
};
