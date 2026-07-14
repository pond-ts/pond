import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { XAxis } from '../src/XAxis.js';

afterEach(cleanup);

/** A ride re-keyed onto cumulative distance — a value (non-time) x axis. */
const rideByDistance = () =>
  new TimeSeries({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'cumDist', kind: 'number' },
      { name: 'hr', kind: 'number' },
    ] as const,
    rows: [
      [0, 0, 120],
      [1000, 500, 130],
      [2000, 1200, 140],
      [3000, 2400, 150],
    ],
  }).byValue('cumDist');

/** A plain time-keyed series. */
const timeSeries = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  });

describe('<XAxis> — the placeable x axis', () => {
  it('renders explicit ticks verbatim (the lap-markers lever) + a centred label', () => {
    const { getByText } = render(
      <ChartContainer range={[0, 2400]} width={480} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis
          label="Distance (m)"
          ticks={[
            { at: 500, label: 'Lap 1' },
            { at: 1800, label: 'Lap 2' },
          ]}
        />
      </ChartContainer>,
    );
    // Custom tick labels render as-is — the scale's auto ticks are bypassed.
    expect(getByText('Lap 1')).toBeTruthy();
    expect(getByText('Lap 2')).toBeTruthy();
    expect(getByText('Distance (m)')).toBeTruthy();
  });

  it('formats value-axis ticks with the given d3 number specifier', () => {
    const { getByText } = render(
      <ChartContainer range={[0, 5000]} width={480} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis format=",.0f" />
      </ChartContainer>,
    );
    // The value scale ([0,5000]) auto-ticks at 1000s; `,.0f` adds the comma.
    expect(getByText('1,000')).toBeTruthy();
    expect(getByText('2,000')).toBeTruthy();
  });

  it('two x axes stack by declaration order — one shared scale, two layouts', () => {
    // Primary strike axis after the row, moneyness transform after it (both
    // below the plot, stacked) — plus a third on top. All read one xScale.
    const { container } = render(
      <ChartContainer range={[80, 120]} width={620} showAxis={false}>
        <XAxis side="top" format=",.0f" />
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis format=",.0f" label="Strike" />
        <XAxis
          transform={{ to: (k) => k / 100, from: (m) => m * 100 }}
          format=".2f"
          label="Moneyness"
        />
      </ChartContainer>,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Strike');
    expect(text).toContain('Moneyness');
    // Derived nice ticks in moneyness space (0.85 … 1.15 by 0.05-ish steps).
    expect(text).toContain('1.00');
    expect(text).toContain('0.90');
    // Both raw-strike layouts tick at round strikes.
    expect(text).toContain('100');
  });

  it('transform lays nice ticks in the derived unit at xScale(from(u))', () => {
    // Strike domain [80,120], spot 100 → moneyness [0.8,1.2]; 620px & 56px/tick
    // admit the 0.05 grid: 0.80, 0.85, …, 1.20 (or a nice subset), each placed
    // at the strike pixel of m*100.
    const { container } = render(
      <ChartContainer range={[80, 120]} width={620} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis
          transform={{ to: (k) => k / 100, from: (m) => m * 100 }}
          format=".2f"
        />
      </ChartContainer>,
    );
    const labels = Array.from(container.querySelectorAll('div'))
      .filter((el) => el.childElementCount === 0)
      .map((el) => el.textContent ?? '')
      .filter((t) => /^\d\.\d{2}$/.test(t));
    expect(labels).toContain('1.00');
    expect(labels.length).toBeGreaterThanOrEqual(5);
    // Every derived label is a clean 1-2-5 nice value in moneyness space.
    for (const l of labels) {
      const cents = Math.round(Number(l) * 100);
      expect(cents % 5).toBe(0);
    }
  });

  it('a nonlinear transform fills stretched spans finer, never collides', () => {
    // to = cbrt compresses the middle of a symmetric domain and stretches the
    // wings in u-space→pixel terms; whatever the shape, no two derived ticks
    // may sit closer than the pixel budget.
    const to = (v: number) => Math.cbrt(v);
    const from = (u: number) => u ** 3;
    const { container } = render(
      <ChartContainer range={[-1000, 1000]} width={620} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis transform={{ to, from }} format=".1f" />
      </ChartContainer>,
    );
    const xs = Array.from(container.querySelectorAll('div'))
      .filter(
        (el) =>
          el.childElementCount === 0 &&
          /^[-\u2212]?\d+\.\d$/.test(el.textContent ?? '') &&
          (el as HTMLElement).style.left !== '',
      )
      .map((el) => parseFloat((el as HTMLElement).style.left));
    expect(xs.length).toBeGreaterThanOrEqual(3);
    const sorted = [...xs].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(48);
    }
  });

  it('derived labels are honest: unique, and each parses back to its own pixel', () => {
    // tanh compresses toward an asymptote like BS delta: the fill descends to
    // fine steps in the wings, where sub-precision values would round to lying
    // labels ("+1.00" for u = 0.995). The honesty filter must drop those.
    const to = (v: number) => Math.tanh(v);
    const from = (u: number) => Math.atanh(u);
    const width = 1100;
    const { container } = render(
      <ChartContainer range={[-3, 3]} width={width} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis transform={{ to, from }} format="+.2f" />
      </ChartContainer>,
    );
    const ticks = Array.from(container.querySelectorAll('div'))
      .filter(
        (el) =>
          el.childElementCount === 0 &&
          /^[+\-\u2212]\d\.\d{2}$/.test(el.textContent ?? '') &&
          (el as HTMLElement).style.left !== '',
      )
      .map((el) => ({
        label: (el.textContent ?? '').replace(/\u2212/g, '-'),
        x: parseFloat((el as HTMLElement).style.left),
      }));
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    // No duplicate labels.
    expect(new Set(ticks.map((t) => t.label)).size).toBe(ticks.length);
    // The wings picked up finer honest values than the middle's coarse grid.
    expect(ticks.some((t) => Math.abs(parseFloat(t.label)) > 0.9)).toBe(true);
    // Every label parses back to (about) its own pixel — no rounded lies.
    for (const t of ticks) {
      const u = parseFloat(t.label);
      const expectedX = ((from(u) + 3) / 6) * (width as number);
      expect(Math.abs(expectedX - t.x)).toBeLessThanOrEqual(1.5);
    }
  });

  it('a per-axis color overrides the theme for labels, ticks, rule, and title', () => {
    const { container, getByText } = render(
      <ChartContainer range={[0, 5000]} width={480} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis format=",.0f" label="Distance" color="rgb(76, 143, 189)" />
      </ChartContainer>,
    );
    const strip = getByText('Distance').parentElement as HTMLElement;
    expect(strip.style.color).toBe('rgb(76, 143, 189)');
    expect(strip.style.borderTop).toContain('rgb(76, 143, 189)');
    expect((getByText('Distance') as HTMLElement).style.color).toBe(
      'rgb(76, 143, 189)',
    );
    // Tick marks (1px-wide divs) take it too.
    const mark = Array.from(container.querySelectorAll('div')).find(
      (el) => (el as HTMLElement).style.width === '1px',
    ) as HTMLElement;
    expect(mark.style.background).toBe('rgb(76, 143, 189)');
  });

  it('the boundary context pins to the left edge; an approaching crossing pushes it off', () => {
    // Mid-day window: context "Jan 05" pinned at 0 (no crossing in view).
    const midday = render(
      <ChartContainer
        range={[
          new Date(2026, 0, 5, 9, 0).getTime(),
          new Date(2026, 0, 5, 15, 0).getTime(),
        ]}
        width={480}
        showAxis={false}
      >
        <ChartRow height={120}>
          <Layers>
            <LineChart series={timeSeries()} column="v" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    const ctx1 = midday.container.querySelector(
      '[data-boundary-context]',
    ) as HTMLElement;
    expect(ctx1.textContent).toBe('Jan 05');
    expect(ctx1.style.left).toBe('0px');
    midday.unmount();
    // Window straddling midnight with the crossing tick near the left edge:
    // the crossing's "Jan 06" label pushes the pinned "Jan 05" context off.
    const straddle = render(
      <ChartContainer
        range={[
          new Date(2026, 0, 5, 23, 55).getTime(),
          new Date(2026, 0, 6, 4, 0).getTime(),
        ]}
        width={480}
        showAxis={false}
      >
        <ChartRow height={120}>
          <Layers>
            <LineChart series={timeSeries()} column="v" />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    const ctx2 = straddle.container.querySelector(
      '[data-boundary-context]',
    ) as HTMLElement;
    expect(ctx2.textContent).toBe('Jan 05');
    expect(parseFloat(ctx2.style.left)).toBeLessThan(0); // pushed off
    const crossing = Array.from(
      straddle.container.querySelectorAll('[data-boundary-label]'),
    ).find((el) => !el.hasAttribute('data-boundary-context')) as HTMLElement;
    expect(crossing.textContent).toBe('Jan 06');
    straddle.unmount();
  });

  it('a decreasing transform still places ticks left-to-right', () => {
    const { container } = render(
      <ChartContainer range={[0, 100]} width={480} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis
          transform={{ to: (v) => 100 - v, from: (u) => 100 - u }}
          format=",.0f"
        />
      </ChartContainer>,
    );
    const ticks = Array.from(container.querySelectorAll('div'))
      .filter(
        (el) =>
          el.childElementCount === 0 &&
          /^\d+$/.test(el.textContent ?? '') &&
          (el as HTMLElement).style.left !== '',
      )
      .map((el) => ({
        u: Number(el.textContent),
        x: parseFloat((el as HTMLElement).style.left),
      }))
      .sort((a, b) => a.x - b.x);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    // Pixel-ascending order is derived-unit *descending* for this transform.
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.u).toBeLessThan(ticks[i - 1]!.u);
    }
  });

  it('explicit ticks beat transform', () => {
    const { getByText, queryByText } = render(
      <ChartContainer range={[80, 120]} width={480} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis
          transform={{ to: (k) => k / 100, from: (m) => m * 100 }}
          ticks={[{ at: 100, label: 'ATM' }]}
        />
      </ChartContainer>,
    );
    expect(getByText('ATM')).toBeTruthy();
    expect(queryByText('1.00')).toBeNull();
  });

  it('rules its plot-facing edge per `side` (a top axis rules its bottom)', () => {
    const { getByText } = render(
      <ChartContainer range={[0, 2400]} width={480} showAxis={false}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
        <XAxis side="top" label="top-axis" />
      </ChartContainer>,
    );
    // The label sits in the strip div; a `side="top"` axis carries its 1px rule
    // on the bottom (plot-facing) edge, not the top.
    const strip = getByText('top-axis').parentElement!;
    expect(strip.style.borderBottom).toBeTruthy();
    expect(strip.style.borderTop).toBeFalsy();
  });
});

describe('x-axis kind inference', () => {
  it('plots a ValueSeries row against a numeric (value) axis — auto-fit, no range', () => {
    // No `range`: the container auto-fits to the data's cumDist extent [0,2400].
    // The auto ticks land on 0/500/1000/… — proof the inferred scale is linear
    // (a time scale would render wall-clock labels instead).
    const { getByText } = render(
      <ChartContainer width={480}>
        <ChartRow height={120}>
          <Layers>
            <LineChart series={rideByDistance()} column="hr" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(getByText('500')).toBeTruthy();
    expect(getByText('1,000')).toBeTruthy();
  });

  it('throws a hard error when a container mixes time and value rows', () => {
    // The throw fires from the kind-resolve useMemo once both layers have
    // registered (the two-pass), surfacing as a render error. Silence React's
    // expected console.error so the run output stays clean.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      render(
        <ChartContainer width={400}>
          <ChartRow height={100}>
            <Layers>
              <LineChart series={timeSeries()} column="v" />
              <LineChart series={rideByDistance()} column="hr" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      ),
    ).toThrow(/mix x-axis kinds/);
    spy.mockRestore();
  });
});
