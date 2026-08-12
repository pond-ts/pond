/**
 * `<ChartContainer categories>` — the ordinal axis as a **container-level**
 * choice ([PND-IGNITECAT]; Theme B of the Ignite report: PG-2, PG-3, and
 * downstream PG-7 / PG-21).
 *
 * Before this, the band scale was reachable only through a layer: `<BarChart
 * categories>` and the heat map reported `xKind: 'category'`, everything else
 * reported `'time'` or `'value'`, and the container throws on a mix — so a
 * line, a point or an envelope over categorical bars was not expressible.
 *
 * The two things worth pinning hardest are the ones the workaround forfeited,
 * because they are why this is a container prop rather than advice to key
 * layers to integers: **`<XAxis>` label thinning** and the **`maxBandWidth` /
 * `bandAlign` slot packing** must both survive, and a hand-supplied tick list
 * loses them.
 */
import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries, ValueSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { ScatterChart } from '../src/ScatterChart.js';
import { BandChart } from '../src/BandChart.js';
import { BarChart } from '../src/BarChart.js';
import { HeatMap } from '../src/HeatMap.js';
import { XAxis } from '../src/XAxis.js';
import { YAxis } from '../src/YAxis.js';
import { ContainerContext, type ContainerFrame } from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const WIDTH = 600;
const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META'];

/** Bars for the same slots, in the same order. */
const bars = (labels: readonly string[] = TICKERS) =>
  labels.map((label, i) => ({ label, value: 10 + i * 5 }));

/**
 * An overlay keyed to **slot coordinates**: slot `i`'s centre is `i + 0.5`,
 * which is also where `ScaleBand.ticks()` puts the tick.
 */
const overlay = (labels: readonly string[] = TICKERS) =>
  ValueSeries.fromColumns({
    name: 'target',
    schema: [
      { name: 'slot', kind: 'value' },
      { name: 'target', kind: 'number' },
      { name: 'lo', kind: 'number' },
      { name: 'hi', kind: 'number' },
    ] as const,
    columns: {
      slot: labels.map((_, i) => i + 0.5),
      target: labels.map((_, i) => 12 + i * 4),
      lo: labels.map((_, i) => 8 + i * 4),
      hi: labels.map((_, i) => 16 + i * 4),
    },
  });

/**
 * A **vertical** heat map on a `ValueSeries`: bins along x at slot
 * coordinates, two named rows down y. It reports `xKind: 'value'` and sets
 * `binCategories` for its rows — the combination a `binCategories`-based guard
 * misread as a horizontal bar chart.
 */
const grid = () =>
  ValueSeries.fromColumns({
    name: 'grid',
    schema: [
      { name: 'slot', kind: 'value' },
      { name: 'lit', kind: 'number' },
      { name: 'dark', kind: 'number' },
    ] as const,
    columns: {
      slot: TICKERS.map((_, i) => i + 0.5),
      lit: [1, 4, 9, 3, 6],
      dark: [7, 2, 5, 8, 1],
    },
  });

const timeSeries = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 1],
      [1000, 5],
    ],
  });

function Capture({ into }: { into: { cf: ContainerFrame | null } }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) into.cf = c;
  });
  return null;
}

function renderChart(ui: React.ReactElement) {
  const stub = stubCanvasContext();
  try {
    return render(ui);
  } finally {
    stub.restore();
  }
}

function mount(ui: React.ReactElement) {
  const into = { cf: null as ContainerFrame | null };
  const r = renderChart(
    <>
      {ui}
      <div />
    </>,
  );
  return { ...r, into };
}

describe('<ChartContainer categories> — declaring the ordinal axis', () => {
  it('resolves a category axis with no category layer at all', () => {
    const into = { cf: null as ContainerFrame | null };
    renderChart(
      <ChartContainer width={WIDTH} categories={TICKERS}>
        <Capture into={into} />
        <ChartRow height={120}>
          <YAxis id="v" />
          <Layers>
            <LineChart series={overlay()} column="target" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    // The whole point: a value-keyed line, and the axis is ordinal anyway.
    expect(into.cf!.xKind).toBe('category');
    expect(into.cf!.xScale.ticks()).toHaveLength(TICKERS.length);
  });

  it('lets a value-keyed layer share a plot with categorical bars', () => {
    const into = { cf: null as ContainerFrame | null };
    expect(() =>
      renderChart(
        <ChartContainer width={WIDTH} categories={TICKERS}>
          <Capture into={into} />
          <ChartRow height={160}>
            <YAxis id="v" />
            <Layers>
              <BarChart categories={bars()} />
              <BandChart series={overlay()} lower="lo" upper="hi" axis="v" />
              <LineChart series={overlay()} column="target" axis="v" />
              <ScatterChart series={overlay()} column="target" axis="v" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      ),
    ).not.toThrow();
    expect(into.cf!.xKind).toBe('category');
  });

  it('puts a slot-keyed mark exactly on the slot centre the bars use', () => {
    const into = { cf: null as ContainerFrame | null };
    renderChart(
      <ChartContainer width={WIDTH} categories={TICKERS}>
        <Capture into={into} />
        <ChartRow height={160}>
          <YAxis id="v" />
          <Layers>
            <BarChart categories={bars()} />
            <LineChart series={overlay()} column="target" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const x = into.cf!.xScale;
    // `i + 0.5` is the documented keying convention, the tick position, and
    // the midpoint of the slot the bar fills — all three must be one number,
    // or an overlay silently sits off-centre.
    const ticks = x.ticks();
    for (let i = 0; i < TICKERS.length; i++) {
      expect(x(i + 0.5)).toBeCloseTo((x(i) + x(i + 1)) / 2, 6);
      expect(ticks[i]).toBeCloseTo(i + 0.5, 6);
    }
  });

  it('an empty list is still an ordinal axis, not a fallback to time', () => {
    // The loading state. Declaring zero slots must not resolve to a *time*
    // axis, because the kind would then flip when the data arrives — and a
    // scale-kind flip rebuilds every scale mid-session. "Ordinal with nothing
    // in it yet" is the honest reading of `categories={[]}`.
    const into = { cf: null as ContainerFrame | null };
    renderChart(
      <ChartContainer width={WIDTH} categories={[]}>
        <Capture into={into} />
        <ChartRow height={120}>
          <YAxis id="v" />
          <Layers />
        </ChartRow>
      </ChartContainer>,
    );
    expect(into.cf!.xKind).toBe('category');
    expect(into.cf!.xScale.ticks()).toHaveLength(0);
  });

  it('is authoritative over a category layer that agrees', () => {
    const into = { cf: null as ContainerFrame | null };
    renderChart(
      <ChartContainer width={WIDTH} categories={TICKERS}>
        <Capture into={into} />
        <ChartRow height={120}>
          <YAxis id="v" />
          <Layers>
            <BarChart categories={bars()} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(into.cf!.xScale.ticks()).toHaveLength(5);
  });
});

describe('<ChartContainer categories> — what still errors', () => {
  it('rejects a time-keyed layer, naming the fix', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        renderChart(
          <ChartContainer width={WIDTH} categories={TICKERS}>
            <ChartRow height={120}>
              <YAxis id="v" />
              <Layers>
                <LineChart series={timeSeries()} column="v" axis="v" />
              </Layers>
            </ChartRow>
          </ChartContainer>,
        ),
      ).toThrow(/time-keyed layer cannot plot on a category axis/);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a category layer whose columns disagree with the prop', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        renderChart(
          <ChartContainer width={WIDTH} categories={TICKERS}>
            <ChartRow height={120}>
              <YAxis id="v" />
              <Layers>
                <BarChart categories={bars(['AAPL', 'MSFT'])} />
              </Layers>
            </ChartRow>
          </ChartContainer>,
        ),
      ).toThrow(/disagree with the container's `categories`/);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a reordered category layer, not just a different-length one', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const swapped = [TICKERS[1]!, TICKERS[0]!, ...TICKERS.slice(2)];
      expect(() =>
        renderChart(
          <ChartContainer width={WIDTH} categories={TICKERS}>
            <ChartRow height={120}>
              <YAxis id="v" />
              <Layers>
                <BarChart categories={bars(swapped)} />
              </Layers>
            </ChartRow>
          </ChartContainer>,
        ),
      ).toThrow(/disagree with the container's `categories`/);
    } finally {
      spy.mockRestore();
    }
  });

  it('allows a value-keyed vertical heat map — ordinal rows AND ordinal columns', () => {
    // Found by Layer-2 review. A guard here once tested `binCategories` to
    // reject a *horizontal* categorical <BarChart>, whose x is bar length. But
    // `binCategories` is the generic "my y is ordinal" channel, and a vertical
    // heat map sets it for its rows — so the guard rejected a slot-keyed grid
    // with named columns on x, which is a wanted layout, with an error naming
    // a <BarChart> that wasn't in the tree. Ordinal rows plus ordinal columns
    // is a 2-D grid, not a contradiction.
    const into = { cf: null as ContainerFrame | null };
    expect(() =>
      renderChart(
        <ChartContainer width={WIDTH} categories={TICKERS}>
          <Capture into={into} />
          <ChartRow height={160}>
            <YAxis id="v" />
            <Layers>
              <HeatMap
                series={grid()}
                columns={['lit', 'dark']}
                colors={['#eef', '#88a', '#225']}
              />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      ),
    ).not.toThrow();
    expect(into.cf!.xKind).toBe('category');
    expect(into.cf!.xScale.ticks()).toHaveLength(TICKERS.length);
  });

  it('still rejects a mixed x-kind without the prop, and now names the prop', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        renderChart(
          <ChartContainer width={WIDTH}>
            <ChartRow height={120}>
              <YAxis id="v" />
              <Layers>
                <BarChart categories={bars()} />
                <LineChart series={overlay()} column="target" axis="v" />
              </Layers>
            </ChartRow>
          </ChartContainer>,
        ),
      ).toThrow(/<ChartContainer categories=/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('<ChartContainer categories> — the features the workaround forfeited', () => {
  it('keeps maxBandWidth / bandAlign packing (PG-21)', () => {
    const into = { cf: null as ContainerFrame | null };
    renderChart(
      <ChartContainer
        width={WIDTH}
        categories={TICKERS}
        maxBandWidth={40}
        bandAlign="center"
      >
        <Capture into={into} />
        <ChartRow height={120}>
          <YAxis id="v" label="" />
          <Layers>
            <LineChart series={overlay()} column="target" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const x = into.cf!.xScale;
    // The cap binds: a slot is 40px, not plotWidth / 5.
    expect(x(1) - x(0)).toBeCloseTo(40, 6);
    const packed = 40 * 5;
    const slack = into.cf!.plotWidth - packed;
    expect(x(0)).toBeCloseTo(slack / 2, 6);
  });

  it('keeps <XAxis> category label thinning (PG-7)', () => {
    // The thinning path is gated on a category axis with no custom ticks. A
    // container-declared ordinal axis must take that path, because the
    // integer-index workaround (explicit ticks) is exactly what loses it.
    const many = Array.from({ length: 40 }, (_, i) => `category-name-${i}`);
    const { container } = renderChart(
      <ChartContainer width={320} categories={many}>
        <ChartRow height={100}>
          <YAxis id="v" label="" />
          <Layers>
            <LineChart
              series={ValueSeries.fromColumns({
                name: 'o',
                schema: [
                  { name: 'slot', kind: 'value' },
                  { name: 'v', kind: 'number' },
                ] as const,
                columns: {
                  slot: many.map((_, i) => i + 0.5),
                  v: many.map((_, i) => i),
                },
              })}
              column="v"
              axis="v"
            />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
    const labels = Array.from(container.querySelectorAll('div'))
      .map((d) => d.textContent ?? '')
      .filter((t) => /^category-n?a?m?e?-?\d*…?$/.test(t) && t.length > 0);
    // Thinned *and* truncated: 40 fifteen-character names cannot all print in
    // 320px. The exact stride is the axis's business; that the container-
    // declared axis took the thinning path at all is the guarantee — the
    // integer-index workaround (explicit ticks) skips it entirely.
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThan(many.length);
    expect(labels.some((t) => t.endsWith('…'))).toBe(true);
  });
});

describe('<ChartContainer categories> — identity', () => {
  it('an inline array literal does not re-identify the scale each render', () => {
    // A fresh `categories={[…]}` array every render must not rebuild the band
    // scale, or every parent render repaints every row.
    const seen: unknown[] = [];
    function Probe() {
      const c = useContext(ContainerContext);
      if (c) seen.push(c.xScale);
      return null;
    }
    function App({ tick }: { tick: number }) {
      return (
        <ChartContainer width={WIDTH} categories={['a', 'b', 'c']}>
          <Probe />
          <ChartRow height={100}>
            <YAxis id="v" label={`${tick}`} />
            <Layers>
              <LineChart
                series={ValueSeries.fromColumns({
                  name: 'o',
                  schema: [
                    { name: 'slot', kind: 'value' },
                    { name: 'v', kind: 'number' },
                  ] as const,
                  columns: { slot: [0.5, 1.5, 2.5], v: [1, 2, 3] },
                })}
                column="v"
                axis="v"
              />
            </Layers>
          </ChartRow>
        </ChartContainer>
      );
    }
    const stub = stubCanvasContext();
    try {
      const { rerender } = render(<App tick={0} />);
      const before = seen[seen.length - 1];
      rerender(<App tick={0} />);
      expect(seen[seen.length - 1]).toBe(before);
    } finally {
      stub.restore();
    }
  });
});
