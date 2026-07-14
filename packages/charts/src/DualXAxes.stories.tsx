import type { Meta, StoryObj } from '@storybook/react-vite';
import { ValueSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { ScatterChart } from './ScatterChart.js';
import { XAxis } from './XAxis.js';
import { YAxis } from './YAxis.js';
import { docsTheme } from './docs-theme.fixture.js';

/**
 * **Dual x-axes** — two tick layouts on **one shared scale** (never two
 * scales: one pixel mapping). The `<XAxis transform>` prop relabels an axis
 * into a derived unit — a nonlinear BS-delta strip under a std-moneyness
 * chart, a linear moneyness axis over a strike chart. Declaration order
 * stacks the strips (before the row → above the plot, after → below, in
 * order); gridlines always follow the container's own (primary) ticks.
 */

const meta = {
  title: 'Axes/DualX',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf approximation). */
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** Standard normal inverse CDF (Beasley–Springer–Moro). */
function normInv(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
        c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p <= 1 - pl) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r +
        a[5]!) *
        q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(
    (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q +
      c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  );
}

/** σ ↔ BS-delta-like transform: delta = Φ(σ) − ½ ∈ (−½, ½), the reference
 *  axis's nonlinear relabeling (delta compresses toward ±0.5 at the wings —
 *  i.e. σ-space *stretches* delta there, so the strip earns finer ticks). */
const sigmaToDelta = {
  to: (s: number) => normCdf(s) - 0.5,
  from: (dl: number) => normInv(dl + 0.5),
};

/** A skew/smile IV curve keyed by std moneyness σ (the reference shape:
 *  falling put wing, shallow smile on the call side). */
function sigmaSmile() {
  const sigmas: number[] = [];
  const iv: number[] = [];
  for (let s = -3; s <= 3.0001; s += 0.25) {
    sigmas.push(s);
    iv.push(
      13.9 +
        (s < 0 ? 3.1 * s * s * 0.32 - 0.4 * s : 0.35 * (s - 1.3) ** 2 - 0.6),
    );
  }
  return ValueSeries.fromColumns({
    name: 'skew',
    schema: [
      { name: 'sigma', kind: 'value' },
      { name: 'iv', kind: 'number' },
    ] as const,
    columns: { sigma: sigmas, iv },
  });
}

/**
 * The reference look (legacy ChartTool): primary axis in **std moneyness σ**
 * (evenly spaced — it drives the grid), a second strip below it relabelling
 * the same positions into **BS delta** via the nonlinear `transform`. Mid-axis
 * the delta strip ticks on coarse steps; out in the wings — where σ-space
 * stretches delta pixels apart — it picks up finer values (±0.45, ±0.49).
 * The shared title rides the bottom strip.
 */
export const SigmaWithDeltaStrip: Story = {
  render: () => {
    const series = sigmaSmile();
    return (
      <ChartContainer showAxis={false} width={1100} theme={docsTheme}>
        <ChartRow height={260}>
          <YAxis id="iv" label="Volatility" format=".1f" />
          <Layers>
            <LineChart series={series} column="iv" axis="iv" curve="natural" />
          </Layers>
        </ChartRow>
        <XAxis format={(s) => `${s > 0 ? '+' : ''}${s.toFixed(1)}σ`} />
        <XAxis
          transform={sigmaToDelta}
          format="+.2f"
          label="Std Moneyness · BS xDe"
          color="#4c8fbd"
        />
      </ChartContainer>
    );
  },
};

/** The multi-axis convention: each **y axis coloured to match its series**
 *  (`<YAxis color>` — busy, but standard on dual-axis charts), with the
 *  derived x strip coloured too. Every axis instance takes its own `color`. */
export const SeriesColoredAxes: Story = {
  render: () => {
    const series = sigmaSmile();
    return (
      <ChartContainer showAxis={false} width={700} theme={docsTheme}>
        <ChartRow height={220}>
          {/* Each y axis takes its series' colour — the theme's primary /
              secondary role colours, matched by hand. */}
          <YAxis id="iv" label="Volatility" format=".1f" color="#0e8f86" />
          <YAxis
            id="iv2"
            side="right"
            label="IV (again)"
            format=".2f"
            color="#3d6fd9"
          />
          <Layers>
            <LineChart series={series} column="iv" axis="iv" as="primary" />
            <LineChart series={series} column="iv" axis="iv2" as="secondary" />
          </Layers>
        </ChartRow>
        <XAxis format={(s) => `${s.toFixed(1)}σ`} />
        <XAxis transform={sigmaToDelta} format="+.2f" color="#4c8fbd" />
      </ChartContainer>
    );
  },
};

/** The same strike smile as `Scatter/ValueAxisSmile`, with a **linear**
 *  moneyness relabeling (`strike / spot`) on a **top** axis — the transform's
 *  degenerate case: evenly spaced nice ticks in the derived unit. */
export const MoneynessTopAxis: Story = {
  render: () => {
    const spot = 100;
    const strikes: number[] = [];
    const fair: number[] = [];
    for (let k = 80; k <= 120; k += 2.5) {
      strikes.push(k);
      const m = k - 100;
      fair.push(0.24 + 0.00042 * m * m - 0.0016 * m);
    }
    const chain = ValueSeries.fromColumns({
      name: 'smile',
      schema: [
        { name: 'strike', kind: 'value' },
        { name: 'fair', kind: 'number' },
      ] as const,
      columns: { strike: strikes, fair },
    });
    return (
      <ChartContainer showAxis={false} width={620} theme={docsTheme}>
        <XAxis
          side="top"
          transform={{ to: (k) => k / spot, from: (m) => m * spot }}
          format=".2f"
          label="Moneyness"
        />
        <ChartRow height={220}>
          <YAxis id="iv" label="implied vol" format=".1%" />
          <Layers>
            <LineChart series={chain} column="fair" curve="natural" />
            <ScatterChart series={chain} column="fair" id="fair" />
          </Layers>
        </ChartRow>
        <XAxis label="Strike" format=",.0f" />
      </ChartContainer>
    );
  },
};
