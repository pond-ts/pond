import type { Meta, StoryObj } from '@storybook/react-vite';
import { Sequence, TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { Candlestick } from './Candlestick.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { cssVarTheme } from './css-theme.js';
import { defaultTheme, estelaTheme } from './theme.js';

const BASE = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;

const ohlcSchema = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'volume', kind: 'number' },
] as const;

/**
 * Deterministic daily OHLCV — a **point-keyed** `time` series (raw bars, no
 * `aggregate`). Each day opens at the prior close, drifts on a couple of sines,
 * and gets a symmetric wick; volume tracks the move. This is the raw feed a
 * financial consumer holds, fed straight to `<Candlestick>`.
 */
function dailyOHLC(n = 60) {
  const rows: Array<[number, number, number, number, number, number]> = [];
  let close = 100;
  for (let i = 0; i < n; i += 1) {
    const open = close;
    const drift = 6 * Math.sin(i / 9) + 2.2 * Math.sin(i / 2.3);
    close = open + drift;
    const wick = 1.5 + 1.3 * Math.abs(Math.sin(i * 1.7));
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;
    const volume = Math.round(1000 + 500 * Math.abs(Math.sin(i / 3)));
    rows.push([BASE + i * DAY, open, high, low, close, volume]);
  }
  return new TimeSeries({ name: 'daily', schema: ohlcSchema, rows });
}

/** Roll the daily bars up to **weekly** OHLC — the identical `<Candlestick>` call
 *  on a coarser, **interval-keyed** series (open=first, high=max, low=min,
 *  close=last). */
function weeklyOHLC(daily: TimeSeries<typeof ohlcSchema>) {
  return daily.aggregate(Sequence.every('7d'), {
    open: { from: 'open', using: 'first' },
    high: { from: 'high', using: 'max' },
    low: { from: 'low', using: 'min' },
    close: { from: 'close', using: 'last' },
  });
}

/** A window that pads half a day each side so the first / last candle's slot is
 *  fully in view (point-keyed slots reach halfway to a notional neighbour). */
function dayRange(n: number): [number, number] {
  return [BASE - DAY / 2, BASE + (n - 1) * DAY + DAY / 2];
}

const meta = {
  title: 'Charts/Candlestick',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

const N = 60;

// ── Variants ────────────────────────────────────────────────────────────────

/** **`variant='candle'` (default).** Filled `open→close` body + `high–low` wick,
 *  direction-coloured off the neutral default theme (rising blue / falling clay —
 *  *not* market green/red; a consumer supplies that). */
export const Candle: Story = {
  render: () => {
    const d = dailyOHLC(N);
    return (
      <ChartContainer range={dayRange(N)} width={640} theme={defaultTheme}>
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **`variant='bar'`.** OHLC tick bars: a high–low stem with a left tick at open
 *  and a right tick at close. No body. */
export const Bar: Story = {
  render: () => {
    const d = dailyOHLC(N);
    return (
      <ChartContainer range={dayRange(N)} width={640} theme={defaultTheme}>
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" variant="bar" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **`variant='hollow'`.** A rising candle is hollow (outlined body), a falling
 *  one filled — the direction reads from the fill, not just the hue. */
export const Hollow: Story = {
  render: () => {
    const d = dailyOHLC(N);
    return (
      <ChartContainer range={dayRange(N)} width={640} theme={defaultTheme}>
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" variant="hollow" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Colour ──────────────────────────────────────────────────────────────────

/** **`colorBy='series'`.** The rising/falling split is bypassed — every candle
 *  draws in the one series colour, so it reads as "one series" beside coloured
 *  lines rather than a second green/red encoding. */
export const ColorBySeries: Story = {
  render: () => {
    const d = dailyOHLC(N);
    return (
      <ChartContainer range={dayRange(N)} width={640} theme={defaultTheme}>
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" colorBy="series" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **Market colours via `cssVarTheme`.** Tidal's path: overlay green/red onto the
 *  neutral default from CSS tokens (fallbacks shown here). The library ships no
 *  brand palette — the consumer owns green/red. */
export const MarketColors: Story = {
  render: () => {
    const d = dailyOHLC(N);
    const theme = cssVarTheme(defaultTheme, (v) => ({
      candle: {
        default: {
          rising: {
            body: v('--mkt-up', '#16a34a'),
            wick: v('--mkt-up-wick', '#15803d'),
          },
          falling: {
            body: v('--mkt-down', '#dc2626'),
            wick: v('--mkt-down-wick', '#b91c1c'),
          },
        },
      },
    }));
    return (
      <ChartContainer range={dayRange(N)} width={640} theme={theme}>
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **Doji.** A day whose open equals its close draws a minimum-height body in the
 *  `neutral` style, so a flat session stays visible (index 20 is forced flat). */
export const Doji: Story = {
  render: () => {
    const rows: Array<[number, number, number, number, number, number]> = [];
    let close = 100;
    for (let i = 0; i < 24; i += 1) {
      const open = close;
      const flat = i === 12;
      close = flat ? open : open + 5 * Math.sin(i / 3);
      const wick = 2;
      rows.push([
        BASE + i * DAY,
        open,
        Math.max(open, close) + wick,
        Math.min(open, close) - wick,
        close,
        1000,
      ]);
    }
    const d = new TimeSeries({ name: 'doji', schema: ohlcSchema, rows });
    return (
      <ChartContainer range={dayRange(24)} width={560} theme={defaultTheme}>
        <ChartRow height={260}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Geometry ──────────────────────────────────────────────────────────────────

/** **`gap`.** A px inset between adjacent candles (on top of the body's slot
 *  fraction), so dense series breathe. */
export const Gap: Story = {
  render: () => {
    const d = dailyOHLC(N);
    return (
      <ChartContainer range={dayRange(N)} width={640} theme={defaultTheme}>
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" gap={4} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Keying ────────────────────────────────────────────────────────────────────

/** **Point-keyed (raw daily).** The raw `time` series feeds straight in — the
 *  slot is neighbour-derived, no `aggregate` pass. (Same as `Candle`, named for
 *  the keying axis.) */
export const PointKeyed: Story = {
  render: () => {
    const d = dailyOHLC(N);
    return (
      <ChartContainer range={dayRange(N)} width={640} theme={defaultTheme}>
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **Interval-keyed (weekly rollup).** The identical call on an
 *  `aggregate(Sequence.every('7d'), …)` series — each candle spans its bucket's
 *  `[begin, end)`. */
export const IntervalKeyed: Story = {
  render: () => {
    const w = weeklyOHLC(dailyOHLC(N));
    const k = w.keyColumn();
    return (
      <ChartContainer
        range={[k.begin[0]!, k.end[w.length - 1]!]}
        width={640}
        theme={defaultTheme}
      >
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={w} as="ACME" gap={6} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Cursor / readout ──────────────────────────────────────────────────────────

/** **`cursor='crosshair'`.** The reticle **snaps to candles** (a candle exposes
 *  plain `sampleAt`, so it joins the x-snap that `BoxPlot` opts out of). The
 *  default readout pins one value — `close`, keyed on `as`. */
export const Crosshair: Story = {
  render: () => {
    const d = dailyOHLC(N);
    return (
      <ChartContainer
        range={dayRange(N)}
        width={640}
        theme={estelaTheme}
        cursor="crosshair"
      >
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/** **`showOHLC` — the full quote.** Hover fans four value pills (O/H/L/C) instead
 *  of the single close, for a dense readout. */
export const ShowOHLC: Story = {
  render: () => {
    const d = dailyOHLC(N);
    return (
      <ChartContainer
        range={dayRange(N)}
        width={640}
        theme={estelaTheme}
        cursor="crosshair"
      >
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" showOHLC />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Theme ─────────────────────────────────────────────────────────────────────

/** The estela dark theme's neutral candle pair (teal rising / filament falling). */
export const Estela: Story = {
  render: () => {
    const d = dailyOHLC(N);
    return (
      <ChartContainer range={dayRange(N)} width={640} theme={estelaTheme}>
        <ChartRow height={280}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

// ── Scenarios ─────────────────────────────────────────────────────────────────

/** **Price + volume, two panels.** The canonical financial layout: candles on a
 *  price row, volume as a `<BarChart>` sub-panel sharing the time axis (the
 *  library doesn't fuse panels — the consumer composes rows). */
export const ScenarioPriceVolume: Story = {
  render: () => {
    const d = dailyOHLC(N);
    return (
      <ChartContainer range={dayRange(N)} width={720} theme={estelaTheme}>
        <ChartRow height={260}>
          <YAxis id="price" label="price" />
          <Layers>
            <Candlestick series={d} as="ACME" />
          </Layers>
        </ChartRow>
        <ChartRow height={110}>
          <YAxis id="vol" label="vol" />
          <Layers>
            <BarChart series={d} column="volume" axis="vol" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};
