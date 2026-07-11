import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries, ValueSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { ScatterChart } from './ScatterChart.js';
import { LineChart } from './LineChart.js';
import { XAxis } from './XAxis.js';
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

// ---------------------------------------------------------------------------
// Value axis — scatter on a ValueSeries (strike / distance / frequency on x).
// ---------------------------------------------------------------------------

/**
 * A deterministic synthetic **vol smile**: one row per strike (a cross-section
 * — no row has a meaningful time), built through the direct value-land door
 * `ValueSeries.fromColumns`. `fair` is a skewed parabola (downside strikes
 * carry more vol), `bidIv`/`askIv` straddle it with a spread that widens in the
 * wings plus a small deterministic wiggle (market noise without RNG), and `oi`
 * humps at the money (drives point radius). `ivChg` is a signed
 * day-over-day-ish change (drives point colour).
 */
function smileChain() {
  const strikes: number[] = [];
  for (let k = 80; k <= 120; k += 2.5) strikes.push(k);
  const fair: number[] = [];
  const bidIv: number[] = [];
  const askIv: number[] = [];
  const oi: number[] = [];
  const ivChg: number[] = [];
  for (const k of strikes) {
    const m = k - 100; // distance from the money
    const f = 0.24 + 0.00042 * m * m - 0.0016 * m;
    const spread = 0.008 + 0.0006 * Math.abs(m);
    const wiggle = 0.002 * Math.sin(k / 3.1);
    fair.push(f);
    bidIv.push(f - spread / 2 + wiggle);
    askIv.push(f + spread / 2 + wiggle);
    oi.push(Math.round(150 + 850 * (1 - Math.min(1, Math.abs(m) / 22)) ** 2));
    ivChg.push(0.012 * Math.sin(m / 5.3));
  }
  return ValueSeries.fromColumns({
    name: 'smile',
    schema: [
      { name: 'strike', kind: 'value' },
      { name: 'fair', kind: 'number' },
      { name: 'bidIv', kind: 'number' },
      { name: 'askIv', kind: 'number' },
      { name: 'oi', kind: 'number' },
      { name: 'ivChg', kind: 'number' },
    ] as const,
    columns: { strike: strikes, fair, bidIv, askIv, oi, ivChg },
  });
}

/**
 * **Value axis.** The same `<ScatterChart>` consuming a `ValueSeries` — IV
 * marks keyed by **strike**, not time. The chart **infers** a value (linear) x
 * from the data (no axis-type prop) and auto-fits the domain; numeric tick
 * format via `timeFormat`.
 */
export const ValueAxis: Story = {
  render: () => (
    <ChartContainer timeFormat=",.0f" width={520}>
      <ChartRow height={220}>
        <YAxis id="iv" format=".0%" />
        <Layers>
          <ScatterChart series={smileChain()} column="fair" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Value axis + encodings.** The data-driven channels on a value axis: point
 * *radius* from open interest (`oi`, humped at the money) and point *colour*
 * from the signed IV change (`ivChg`, red↔green ramp). Same encoding contract
 * as the time axis — a column + range, not a callback.
 */
export const ValueAxisEncoded: Story = {
  render: () => (
    <ChartContainer timeFormat=",.0f" width={520}>
      <ChartRow height={220}>
        <YAxis id="iv" format=".0%" />
        <Layers>
          <ScatterChart
            series={smileChain()}
            column="fair"
            radius={{ column: 'oi', range: [2.5, 11] }}
            color={{ column: 'ivChg', range: ['#e8836b', '#15B3A6'] }}
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **Value axis, marks over a line — a vol smile.** The composition a smile
 * chart is made of: the fair-vol curve as a `<LineChart curve="natural">`, and
 * per-strike **bid / ask IV marks** as two scatters (`secondary` / `primary`
 * roles) straddling it. One shared strike axis, labelled via an explicit
 * `<XAxis>`; hover reads the nearest strike's values.
 */
export const ValueAxisSmile: Story = {
  render: () => {
    const chain = smileChain();
    return (
      <ChartContainer
        timeFormat=",.0f"
        cursor="crosshair"
        showAxis={false}
        width={620}
      >
        <ChartRow height={260}>
          <YAxis id="iv" label="implied vol" format=".1%" />
          <Layers>
            <LineChart series={chain} column="fair" curve="natural" />
            <ScatterChart
              series={chain}
              column="bidIv"
              as="secondary"
              id="bid"
            />
            <ScatterChart series={chain} column="askIv" as="primary" id="ask" />
          </Layers>
        </ChartRow>
        <XAxis label="Strike" format=",.0f" />
      </ChartContainer>
    );
  },
};

/**
 * **Value axis + flag cursor.** Scatter's `sampleAt` bisecting the **strike**
 * axis: hover and the staff snaps to the nearest drawn mark, the flag reading
 * its IV, `cursorTime` showing the strike. Proves the tracker readout follows
 * the pointer on a value axis, not just time.
 */
export const ValueAxisFlag: Story = {
  render: () => {
    const chain = smileChain();
    const lo = chain.axisAt(0);
    const hi = chain.axisAt(chain.length - 1);
    return (
      <ChartContainer
        range={[lo, hi]}
        timeFormat=",.0f"
        cursor="flag"
        cursorTime
        width={520}
      >
        <ChartRow height={220}>
          <YAxis id="iv" format=".1%" />
          <Layers>
            <ScatterChart series={chain} column="fair" id="fair" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
