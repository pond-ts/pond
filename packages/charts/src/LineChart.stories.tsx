import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import type { ChartTheme } from './theme.js';

const N = 60;

/** A deterministic sine wave with a coast (gap) from index 25–31. */
function sineWithGap() {
  const rows: Array<[number, number | undefined]> = [];
  for (let i = 0; i < N; i += 1) {
    const inGap = i >= 25 && i < 32;
    rows.push([i, inGap ? undefined : 50 + 40 * Math.sin(i / 5)]);
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
  for (let i = 0; i < N; i += 1) rows.push([i, 42]);
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
      <ChartContainer timeRange={[0, N - 1]} width={480}>
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
      <ChartContainer timeRange={[0, N - 1]} width={480}>
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
  font: { family: 'system-ui, sans-serif', size: 11 },
};

export const Themed: Story = {
  render: () => {
    const series = sineWithGap();
    return (
      <ChartContainer timeRange={[0, N - 1]} width={480} theme={darkTheme}>
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
  font: { family: 'system-ui, sans-serif', size: 11 },
};

export const SemanticFoam: Story = {
  render: () => {
    const series = sineWithGap();
    return (
      <ChartContainer timeRange={[0, N - 1]} width={480} theme={foamTheme}>
        <ChartRow height={200}>
          <Layers>
            <LineChart series={series} column="v" as="foam" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
