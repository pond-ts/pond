import type { Meta, StoryObj } from '@storybook/react-vite';
import { Sequence, TimeSeries, ValueSeries, type SeriesSchema } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BoxPlot } from './BoxPlot.js';
import { YAxis } from './YAxis.js';
import { defaultTheme, estelaTheme } from './theme.js';

const BASE = Date.UTC(2026, 0, 1, 12, 0, 0);

/**
 * The real pond pipeline: deterministic raw samples rolled up into per-bucket
 * percentiles by `aggregate`, then fed straight to `<BoxPlot>` — no hand-rolled
 * quantiles. `aggregate` returns an **interval-keyed** series (`[begin, end)`
 * buckets), so each box gets real horizontal width from its bucket span; the
 * reducers (p5…p95) live in pond, the view just reads the columns.
 */
function percentileBuckets() {
  const N = 600;
  const STEP = 5_000; // one raw sample / 5s
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    // Deterministic "noise": a slow trend + faster wiggles so each bucket has
    // real spread (→ a visible box + whiskers).
    const slow = 60 + 18 * Math.sin(i / 70);
    const fast =
      9 * Math.sin(i * 1.3) + 5 * Math.sin(i * 2.7) + 3 * Math.sin(i * 0.7);
    rows.push([BASE + i * STEP, slow + fast]);
  }
  const raw = new TimeSeries({
    name: 'raw',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'latency', kind: 'number' },
    ] as const,
    rows,
  });
  // 10-minute buckets over the 50-minute window → ~5 boxes, each with spread.
  return raw.aggregate(Sequence.every('10m'), {
    p5: { from: 'latency', using: 'p5' },
    p25: { from: 'latency', using: 'p25' },
    p50: { from: 'latency', using: 'p50' },
    p75: { from: 'latency', using: 'p75' },
    p95: { from: 'latency', using: 'p95' },
  });
}

/**
 * An interval-keyed series with explicit `[begin, end)` buckets and a missing
 * bucket (index 3) — the box there must draw nothing (gap-aware), like a band
 * gap. Built directly (not via `aggregate`) so the hole is exact.
 */
function bucketsWithGap() {
  const STEP = 60_000;
  type Row = [
    [number, number],
    number | undefined,
    number | undefined,
    number | undefined,
    number | undefined,
    number | undefined,
  ];
  const rows: Row[] = [];
  for (let i = 0; i < 7; i += 1) {
    const begin = BASE + i * STEP;
    const inGap = i === 3;
    const mid = 50 + 14 * Math.sin(i / 1.5);
    const spread = 10 + 4 * Math.cos(i);
    rows.push([
      [begin, begin + STEP],
      inGap ? undefined : mid - spread,
      inGap ? undefined : mid - spread / 2,
      inGap ? undefined : mid,
      inGap ? undefined : mid + spread / 2,
      inGap ? undefined : mid + spread,
    ]);
  }
  return new TimeSeries({
    name: 'gap',
    // The key column's name must equal its kind (`timeRange`); value columns
    // take any name.
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'p5', kind: 'number', required: false },
      { name: 'p25', kind: 'number', required: false },
      { name: 'p50', kind: 'number', required: false },
      { name: 'p75', kind: 'number', required: false },
      { name: 'p95', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
  });
}

/** Time range spanning a series' interval keys (begin of the first → end of the
 *  last). Generic over the key kind so it serves both the aggregate (interval)
 *  and the direct timeRange series. */
function rangeOf<S extends SeriesSchema>(
  series: TimeSeries<S>,
): [number, number] {
  const k = series.keyColumn();
  return [k.begin[0]!, k.end[series.length - 1]!];
}

const meta = {
  title: 'Charts/BoxPlot',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * The headline: per-bucket latency percentiles as boxes on the estela theme.
 * Five columns (`p5`/`p25`/`p50`/`p75`/`p95`) map to the lower whisker / box /
 * median / box / upper whisker. `gap` insets adjacent boxes so they breathe.
 */
export const Percentiles: Story = {
  render: () => {
    const q = percentileBuckets();
    return (
      <ChartContainer range={rangeOf(q)} width={620} theme={estelaTheme}>
        <ChartRow height={260}>
          <YAxis id="ms" label="ms" />
          <Layers>
            <BoxPlot
              series={q}
              lower="p5"
              q1="p25"
              median="p50"
              q3="p75"
              upper="p95"
              as="latency"
              gap={14}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **`cursor='flag'` — the box readout.** Hover a box: a single flag rises from
 * its top-centre listing **all five values** (low / q1 / median / q3 / high),
 * each coloured to its box piece. Unlike line/bar, the box flag is one
 * consolidated chip (no per-quantile dots), with one staff.
 */
export const CursorFlag: Story = {
  render: () => {
    const q = percentileBuckets();
    return (
      <ChartContainer
        range={rangeOf(q)}
        width={620}
        theme={estelaTheme}
        cursor="flag"
      >
        <ChartRow height={260}>
          <YAxis id="ms" label="ms" />
          <Layers>
            <BoxPlot
              series={q}
              lower="p5"
              q1="p25"
              median="p50"
              q3="p75"
              upper="p95"
              as="latency"
              gap={14}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **`shape='solid'` — the candlestick look** (pjm17971's alternative style). A
 * light outer bar spans the full `p5→p95` range; a darker inner box is `p25→p75`
 * (same hue, rising opacity). No thin whiskers. The median (centre) line is
 * optional — off here for the simplified read (`showMedian={false}`).
 */
export const Solid: Story = {
  render: () => {
    const q = percentileBuckets();
    return (
      <ChartContainer range={rangeOf(q)} width={620} theme={estelaTheme}>
        <ChartRow height={260}>
          <YAxis id="ms" label="ms" />
          <Layers>
            <BoxPlot
              series={q}
              lower="p5"
              q1="p25"
              median="p50"
              q3="p75"
              upper="p95"
              as="latency"
              gap={14}
              shape="solid"
              showMedian={false}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** A box series that breaks at a missing bucket — the gap box must not draw. */
export const WithGap: Story = {
  render: () => {
    const g = bucketsWithGap();
    return (
      <ChartContainer range={rangeOf(g)} width={520}>
        <ChartRow height={220}>
          <YAxis id="v" label="v" min={0} max={80} />
          <Layers>
            <BoxPlot
              series={g}
              lower="p5"
              q1="p25"
              median="p50"
              q3="p75"
              upper="p95"
              gap={8}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** The same percentile pipeline on the neutral default theme (the `box.default`
 *  token) — the light-ground baseline. */
export const Themed: Story = {
  render: () => {
    const q = percentileBuckets();
    return (
      <ChartContainer range={rangeOf(q)} width={620} theme={defaultTheme}>
        <ChartRow height={260}>
          <YAxis id="ms" label="ms" />
          <Layers>
            <BoxPlot
              series={q}
              lower="p5"
              q1="p25"
              median="p50"
              q3="p75"
              upper="p95"
              gap={14}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Value axis: a volatility smile keyed by strike ──

/** A vol smile: bid/ask/mid IV per strike, natively value-keyed (strike on x). */
function smile() {
  const strike = [80, 90, 100, 110, 120, 130];
  const mid = [0.34, 0.29, 0.25, 0.26, 0.3, 0.36];
  return ValueSeries.fromColumns({
    name: 'smile',
    schema: [
      { name: 'strike', kind: 'value' },
      { name: 'bid', kind: 'number' },
      { name: 'ask', kind: 'number' },
      { name: 'mid', kind: 'number' },
    ] as const,
    columns: {
      strike,
      bid: mid.map((v) => v - 0.012),
      ask: mid.map((v) => v + 0.012),
      mid,
    },
  });
}

/**
 * **Range-only box on a value axis (the vol smile).** A `ValueSeries` keyed by
 * **strike** (x is strike, not time). Omitting `q1`/`q3`/`median` makes each box a
 * **bid→ask IV segment** — whiskers only, no body — a degenerate box that reads as
 * a market range mark. The box width is neighbour-spacing derived (each strike
 * halfway to its neighbours), so the segments don't collapse.
 */
export const VolSmile: Story = {
  render: () => {
    const s = smile();
    return (
      <ChartContainer width={620} theme={estelaTheme}>
        <ChartRow height={260}>
          <YAxis id="iv" label="IV" />
          <Layers>
            <BoxPlot series={s} lower="bid" upper="ask" as="iv" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Range-only + median (bid / mid / ask).** The same smile, now naming `median`
 * (the mid IV) — a centre tick on each bid→ask segment. Still no box body
 * (`q1`/`q3` omitted); `median` is independent of the body.
 */
export const VolSmileWithMid: Story = {
  render: () => {
    const s = smile();
    return (
      <ChartContainer width={620} theme={estelaTheme}>
        <ChartRow height={260}>
          <YAxis id="iv" label="IV" />
          <Layers>
            <BoxPlot series={s} lower="bid" median="mid" upper="ask" as="iv" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **`offset` — call / put pairing at one strike.** Calls and puts sit at the same
 * strike; a pixel `offset` nudges each side of the pair apart so both bid→ask
 * segments read without overlap (the react-timeseries-charts side-by-side
 * precedent). Zoom-stable — the nudge is in pixels, not strike units.
 */
export const CallPutPair: Story = {
  render: () => {
    const strike = [80, 90, 100, 110, 120, 130];
    const call = smile();
    const put = ValueSeries.fromColumns({
      name: 'put',
      schema: [
        { name: 'strike', kind: 'value' },
        { name: 'bid', kind: 'number' },
        { name: 'ask', kind: 'number' },
      ] as const,
      columns: {
        strike,
        bid: [0.36, 0.31, 0.27, 0.28, 0.32, 0.38].map((v) => v - 0.012),
        ask: [0.36, 0.31, 0.27, 0.28, 0.32, 0.38].map((v) => v + 0.012),
      },
    });
    return (
      <ChartContainer width={620} theme={estelaTheme}>
        <ChartRow height={260}>
          <YAxis id="iv" label="IV" />
          <Layers>
            <BoxPlot
              series={call}
              lower="bid"
              upper="ask"
              as="iv"
              offset={-5}
            />
            <BoxPlot series={put} lower="bid" upper="ask" offset={5} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
