import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import type { ChartTheme } from './theme.js';

const N = 60;
/** Fixed base epoch (2026-01-01 12:00 UTC) + 1-minute step, so the time axis
 *  shows wall-clock labels and the visual baselines stay deterministic. */
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/** A deterministic sine wave with a coast (gap) from index 25–31. */
function sineWithGap() {
  const rows: Array<[number, number | undefined]> = [];
  for (let i = 0; i < N; i += 1) {
    const inGap = i >= 25 && i < 32;
    rows.push([BASE + i * STEP, inGap ? undefined : 50 + 40 * Math.sin(i / 5)]);
  }
  return new TimeSeries({
    name: 'demo',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
  });
}

/** A flat constant series — exercises the `min === max` y-domain headroom. */
function flat() {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) rows.push([BASE + i * STEP, 42]);
  return new TimeSeries({
    name: 'flat',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows,
  });
}

const meta = {
  title: 'Charts/LineChart',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/** Line with a gap — the coast must read as a break, not a drop to zero. */
export const WithGap: Story = {
  render: () => {
    const series = sineWithGap();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={480}>
        <ChartRow height={200}>
          <Layers>
            <LineChart series={series} column="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** Flat line — sits mid-row thanks to the auto-domain's ±1 headroom. */
export const Flat: Story = {
  render: () => {
    const series = flat();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={480}>
        <ChartRow height={200}>
          <Layers>
            <LineChart series={series} column="v" as="context" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** A custom dark theme — line colour + background come from the theme object,
 *  no per-component style overrides. Demonstrates the single styling channel. */
const darkTheme: ChartTheme = {
  background: '#0f172a',
  line: {
    default: { color: '#f59e0b', width: 1.5 },
    context: { color: '#5eb5a6', width: 1.5 },
  },
  band: { default: { fill: '#f59e0b', opacity: 0.15 } },
  area: {
    default: {
      color: '#f59e0b',
      width: 1.5,
      fill: '#f59e0b',
      fillOpacity: 0.3,
    },
  },
  bar: {
    default: {
      fill: '#f59e0b',
      opacity: 0.85,
      highlight: '#d97706',
      gap: 1,
      minWidth: 1,
      outlineWidth: 1.5,
    },
  },
  axis: { label: '#94a3b8', grid: '#1e293b', gridDash: [2, 2] },
  font: { family: 'system-ui, sans-serif', size: 11 },
};

export const Themed: Story = {
  render: () => {
    const series = sineWithGap();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={480} theme={darkTheme}>
        <ChartRow height={200}>
          <Layers>
            <LineChart series={series} column="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * The full pipeline with real names. The column `v` is the *data*; `semantic`
 * tags it as `foam` (what it *is*); the theme maps the identifier `foam` to a
 * concrete style — white, 2 px. Nothing about the colour or width lives at the
 * call site.
 *
 *   column "v"  →  semantic "foam"  →  theme.line.foam = { color: white, width: 2 }
 */
const foamTheme: ChartTheme = {
  background: '#0f172a',
  line: {
    default: { color: '#64748b', width: 1.5 },
    foam: { color: '#ffffff', width: 2 },
  },
  band: { default: { fill: '#64748b', opacity: 0.15 } },
  area: {
    default: {
      color: '#64748b',
      width: 1.5,
      fill: '#64748b',
      fillOpacity: 0.3,
    },
  },
  bar: {
    default: {
      fill: '#64748b',
      opacity: 0.85,
      highlight: '#475569',
      gap: 1,
      minWidth: 1,
      outlineWidth: 1.5,
    },
  },
  axis: { label: '#94a3b8', grid: '#1e293b', gridDash: [2, 2] },
  font: { family: 'system-ui, sans-serif', size: 11 },
};

export const SemanticFoam: Story = {
  render: () => {
    const series = sineWithGap();
    return (
      <ChartContainer timeRange={TIME_RANGE} width={480} theme={foamTheme}>
        <ChartRow height={200}>
          <Layers>
            <LineChart series={series} column="v" as="foam" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** A noisy signal with a coast (gap, indices 25–31) — raw material for smoothing. */
function noisy() {
  const rows: Array<[number, number | undefined]> = [];
  for (let i = 0; i < N; i += 1) {
    const inGap = i >= 25 && i < 32;
    const base = 50 + 24 * Math.sin(i / 9);
    const wobble = 9 * Math.sin(i * 1.7) + 5 * Math.sin(i * 3.1);
    rows.push([BASE + i * STEP, inGap ? undefined : base + wobble]);
  }
  return new TimeSeries({
    name: 'noisy',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
  });
}

/**
 * Gap-aware data smoothing — and how it differs from `curve`. The faint line is
 * the raw noisy signal (with a coast); the bright line is
 * `smooth('v', 'movingAverage', { window: '5m', missing: 'skip' })` — denoised
 * **in the data**, then rendered *linear* (the smoothness is the values, not the
 * path). `missing:'skip'` keeps the coast a break instead of fabricating across
 * it (`'bridge'`, the default, would join it). So: `curve` shapes the path,
 * `smooth` reshapes the values — this is the latter, the RFC's "gap-aware
 * smooth" (it applies the same way to a band's edges).
 */
export const GapAwareSmooth: Story = {
  render: () => {
    const sm = noisy().smooth('v', 'movingAverage', {
      window: '5m',
      alignment: 'centered',
      missing: 'skip',
      output: 'vSmooth',
    });
    return (
      <ChartContainer timeRange={TIME_RANGE} width={520} theme={foamTheme}>
        <ChartRow height={220}>
          <Layers>
            <LineChart series={sm} column="v" />
            <LineChart series={sm} column="vSmooth" as="foam" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
