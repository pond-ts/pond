import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { HeatMap } from './HeatMap.js';
import { YAxis } from './YAxis.js';
import { sanFranciscoTemperatures } from './sf-temperatures.fixture.js';
import { docsTheme } from './docs-theme.fixture.js';
import type { SelectInfo } from './context.js';

const sf = sanFranciscoTemperatures();
const begins = sf.keyColumn().begin;
const RANGE: readonly [number, number] = [begins[0]!, begins[sf.length - 1]!];

/** A sequential ramp, cool → warm, in the docs palette's own family. The rule
 *  here is one hue family rather than competing hues, so this steps lightness
 *  rather than running blue-to-red. */
const RAMP = [
  '#0b3d3a',
  '#125e57',
  '#1a8078',
  '#27a396',
  '#4cc0b0',
  '#82d6c7',
  '#b6e7dd',
  '#e2f5f0',
];

const meta = {
  title: 'Charts/HeatMap',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * **The stripes case.** One cell per day, tiling the axis, colour carrying the
 * daily high. No baseline, no bar heights — the whole plot is one row and the
 * colour *is* the value.
 *
 * Compare the workaround this replaces: the Gallery's climate-stripes card
 * builds the same picture from a `<BarChart>` with a constant column (so every
 * bar is full height) plus a caller-computed `binColors` array. Both go away.
 */
export const Stripes: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={720} theme={docsTheme}>
      <ChartRow height={96}>
        <YAxis id="v" min={0} max={1} ticks={[]} label="°F" />
        <Layers>
          <HeatMap series={sf} column="high" colors={RAMP} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **The reason the layer exists.** Hover or click a cell and the readout shows
 * the temperature — read straight off the cell.
 *
 * The bar-based workaround cannot do this at all: its bars are a constant
 * height, so they carry no value, and the climate-stripes card looks the number
 * up out-of-band keyed by the year the tracker reports. Here `hitTest` and
 * `sampleAt` both return the cell's own value, and the readout pill takes the
 * cell's own colour.
 */
function SelectableDemo() {
  const [sel, setSel] = useState<SelectInfo | null>(null);
  return (
    <div>
      <div
        style={{
          height: 18,
          marginBottom: 8,
          fontFamily: docsTheme.font.family,
          fontSize: 12,
          color: docsTheme.axis.label,
        }}
      >
        {sel === null ? (
          <span style={{ opacity: 0.5 }}>hover or click a day…</span>
        ) : (
          <span style={{ color: sel.color }}>
            {new Date(sel.key).toISOString().slice(0, 10)} · {sel.label}{' '}
            {sel.value.toFixed(1)}°F
          </span>
        )}
      </div>
      <ChartContainer
        range={RANGE}
        width={720}
        theme={docsTheme}
        onSelect={setSel}
        onHover={(h) => h && setSel(h)}
      >
        <ChartRow height={96}>
          <YAxis id="v" min={0} max={1} ticks={[]} label="°F" />
          <Layers>
            <HeatMap
              series={sf}
              column="high"
              colors={RAMP}
              id="high"
              as="high"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}

export const Selectable: Story = { render: () => <SelectableDemo /> };

/**
 * **A pinned colour domain.** By default the ramp spans the column's own finite
 * extent, so it always uses the full palette. Pin `domain` when two heat maps
 * must be read against each other, or when the window is a slice of a longer
 * record and the colours should not re-mean themselves as it moves.
 *
 * Here the domain is pinned wider than the data (40–100°F), so the record uses
 * only the middle of the ramp — the same reading you would get if this were one
 * city among several on a shared scale.
 */
export const PinnedDomain: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={720} theme={docsTheme}>
      <ChartRow height={96}>
        <YAxis id="v" min={0} max={1} ticks={[]} label="°F" />
        <Layers>
          <HeatMap series={sf} column="high" colors={RAMP} domain={[40, 100]} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Two rows, composed.** The prototype draws a single row, so a second
 * measurement is a second `<ChartRow>` rather than a second row *inside* one
 * heat map. Stacking them reads correctly and is genuinely useful — but it is
 * the workaround for the missing y dimension, not the design.
 *
 * This is the open question in [PND-HEATMAP]: a real grid puts the second
 * dimension (calendar position, category, value bucket) inside one layer, on
 * one axis, with one colour domain across both. Here each row auto-fits its own
 * domain, so the two are **not** comparable by colour — low and high use the
 * same palette for different ranges. Pin `domain` on both to fix that, which is
 * itself an argument for the grid owning the scale.
 */
export const TwoRowsComposed: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={720} theme={docsTheme}>
      <ChartRow height={64}>
        <YAxis id="hi" min={0} max={1} ticks={[]} label="high" />
        <Layers>
          <HeatMap series={sf} column="high" colors={RAMP} domain={[40, 100]} />
        </Layers>
      </ChartRow>
      <ChartRow height={64}>
        <YAxis id="lo" min={0} max={1} ticks={[]} label="low" />
        <Layers>
          <HeatMap series={sf} column="low" colors={RAMP} domain={[40, 100]} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};
