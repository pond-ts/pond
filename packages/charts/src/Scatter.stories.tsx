import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { ScatterChart } from './ScatterChart.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { defaultTheme, estelaTheme } from './theme.js';
import type { SelectInfo } from './context.js';

const N = 48;
/** Fixed base epoch (2026-01-01 12:00 UTC) + 1-minute step → deterministic. */
const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);
const STEP = 60_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/**
 * A deterministic "trades" scatter: a price that wanders (the y value), a
 * `volume` that swells and ebbs (drives point *radius*), a signed `change` (drives
 * point *colour*, red↔green), and a sparse `tag` column labelling a few notable
 * points. No RNG — every value is a closed-form function of the index, so the
 * visual baselines are reproducible.
 */
function trades() {
  const rows: Array<[number, number, number, number, string | undefined]> = [];
  for (let i = 0; i < N; i += 1) {
    const price = 100 + 18 * Math.sin(i / 6) + 6 * Math.sin(i / 1.7);
    // Volume swells toward the middle of the window, with a faster ripple.
    const volume =
      40 + 60 * Math.sin((i / (N - 1)) * Math.PI) + 18 * Math.sin(i / 2.3);
    // Signed bar-to-bar change → colour (negative red, positive green).
    const prev = 100 + 18 * Math.sin((i - 1) / 6) + 6 * Math.sin((i - 1) / 1.7);
    const change = i === 0 ? 0 : price - prev;
    // Tag the three local extrema-ish points so labels stay sparse.
    const tag =
      i === 8 ? 'open' : i === 24 ? 'peak' : i === 40 ? 'close' : undefined;
    rows.push([BASE + i * STEP, price, volume, change, tag]);
  }
  return new TimeSeries({
    name: 'trades',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'price', kind: 'number' },
      { name: 'volume', kind: 'number' },
      { name: 'change', kind: 'number' },
      { name: 'tag', kind: 'string', required: false },
    ] as const,
    rows: rows as never,
  });
}

const meta = {
  title: 'Charts/ScatterChart',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * **The signature scatter: data-driven radius + colour.** Each point sits at
 * `(time, price)`; `volume` drives the radius (a linear scale over its extent →
 * `[3, 16]` px) and the signed `change` drives the colour (warm → teal). The
 * base mark's style comes from `theme.scatter` (the single styling channel); the
 * size + colour are the deliberate, signed-off data-driven exception. Hover to
 * snap the tracker to the nearest point; click a point to select it (a highlight
 * ring), click empty space to clear.
 */
export const Encoded: Story = {
  render: () => {
    const t = trades();
    return (
      <ChartContainer range={TIME_RANGE} width={620} theme={estelaTheme}>
        <ChartRow height={300}>
          <YAxis id="price" label="price" />
          <Layers>
            <ScatterChart
              series={t}
              column="price"
              radius={{ column: 'volume', range: [3, 16] }}
              color={{ column: 'change', range: ['#E0B36A', '#15B3A6'] }}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **`cursor='flag'` — the point readout.** Hover: a flag rises from the nearest
 * point to a value chip near the top (the scatter flag is point-anchored, like
 * line/area). A per-point 2D-nearest `inline` readout and a staff from the dot's
 * top for large encoded marks are later refinements.
 */
export const CursorFlag: Story = {
  render: () => {
    const t = trades();
    return (
      <ChartContainer
        range={TIME_RANGE}
        width={620}
        theme={estelaTheme}
        cursor="flag"
      >
        <ChartRow height={300}>
          <YAxis id="price" label="price" />
          <Layers>
            <ScatterChart
              series={t}
              column="price"
              radius={{ column: 'volume', range: [3, 16] }}
              color={{ column: 'change', range: ['#E0B36A', '#15B3A6'] }}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Per-point labels.** The same scatter with `label="tag"` — the sparse `tag`
 * column annotates three called-out points (`open` / `peak` / `close`), drawn in
 * the theme's label colour just right of each mark. (Labels are for a handful of
 * notable points, not a dense plot.)
 */
export const Labelled: Story = {
  render: () => {
    const t = trades();
    return (
      <ChartContainer range={TIME_RANGE} width={620} theme={estelaTheme}>
        <ChartRow height={300}>
          <YAxis id="price" label="price" />
          <Layers>
            <ScatterChart
              series={t}
              column="price"
              radius={{ column: 'volume', range: [3, 16] }}
              color={{ column: 'change', range: ['#E0B36A', '#15B3A6'] }}
              label="tag"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Scatter over a line — shared identity via `as`.** A `price` line with the
 * scatter marks on top, both tagged `as="foam"` so they read as one series
 * (z-order = declaration order: line behind, points in front). Fixed-radius
 * points (the default) here — the encoding exception is opt-in.
 */
export const OverLine: Story = {
  render: () => {
    const t = trades();
    return (
      <ChartContainer range={TIME_RANGE} width={620} theme={estelaTheme}>
        <ChartRow height={260}>
          <YAxis id="price" label="price" />
          <Layers>
            <LineChart series={t} column="price" as="foam" curve="monotone" />
            <ScatterChart series={t} column="price" as="foam" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Controlled selection.** `selected` + `onSelect` drive a panel above the
 * chart: click a point to select it (the panel shows its time + price), click
 * empty space to clear. The selection highlight ring is pinned by the controlled
 * prop, not internal state.
 */
function ControlledSelectDemo() {
  const t = trades();
  const [sel, setSel] = useState<SelectInfo | null>(null);
  const clock =
    sel === null ? '' : new Date(sel.key).toISOString().slice(11, 16);
  return (
    <div>
      <div
        style={{
          height: '18px',
          marginBottom: '8px',
          fontFamily: defaultTheme.font.family,
          fontSize: '12px',
          color: defaultTheme.axis.label,
        }}
      >
        {sel === null ? (
          <span style={{ opacity: 0.5 }}>click a point…</span>
        ) : (
          <span style={{ color: sel.color }}>
            {clock} UTC · price {Math.round(sel.value * 100) / 100}
          </span>
        )}
      </div>
      <ChartContainer
        range={TIME_RANGE}
        width={620}
        selected={sel}
        onSelect={setSel}
      >
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <ScatterChart
              series={t}
              column="price"
              id="price"
              radius={{ column: 'volume', range: [3, 16] }}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}

export const ControlledSelect: Story = {
  render: () => <ControlledSelectDemo />,
};
