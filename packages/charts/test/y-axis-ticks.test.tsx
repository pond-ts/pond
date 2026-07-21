import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const series = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 0],
      [1, 50],
      [2, 100],
    ],
  });

describe('<YAxis ticks> — explicit y ticks', () => {
  it('renders the explicit {at,label} ticks verbatim, bypassing the auto ones', () => {
    const { getByText, queryByText } = render(
      <ChartContainer range={[0, 2]} width={400} showAxis={false}>
        <ChartRow height={200}>
          <YAxis
            id="v"
            min={0}
            max={100}
            ticks={[
              { at: 10, label: 'ten' },
              { at: 90, label: 'ninety' },
            ]}
          />
          <Layers>
            <LineChart series={series()} column="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    // The custom labels render as-is …
    expect(getByText('ten')).toBeTruthy();
    expect(getByText('ninety')).toBeTruthy();
    // … and the scale's auto ticks (0/20/40/…) are bypassed entirely.
    expect(queryByText('20')).toBeNull();
    expect(queryByText('40')).toBeNull();
  });

  it('places custom-labelled ticks at non-round positions (the pace lever)', () => {
    // A pace axis: y is negated sec/km, ticks at round paces with m:ss labels —
    // positions that never fall on the scale's "nice" numbers.
    const { getByText } = render(
      <ChartContainer range={[0, 2]} width={400} showAxis={false}>
        <ChartRow height={200}>
          <YAxis
            id="pace"
            min={-360}
            max={-240}
            ticks={[
              { at: -300, label: '5:00' },
              { at: -270, label: '4:30' },
            ]}
          />
          <Layers>
            <LineChart series={series()} column="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(getByText('5:00')).toBeTruthy();
    expect(getByText('4:30')).toBeTruthy();
  });

  it('draws the gridlines at the explicit tick positions, not the auto ones', () => {
    const stub = stubCanvasContext();
    try {
      render(
        <ChartContainer range={[0, 2]} width={400} showAxis={false}>
          <ChartRow height={200}>
            <YAxis
              id="v"
              min={0}
              max={100}
              ticks={[{ at: 50, label: 'mid' }]}
            />
            <Layers>
              <LineChart series={series()} column="v" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
      // The y-domain [0,100] maps to the row range [200,0], so the lone tick at
      // 50 sits at y=100, half-pixel-snapped to 100.5 — a full-width horizontal
      // gridline starting at x=0. (The auto ticks would add 0/20/40/60/80/100.)
      // The mock accumulates every frame; the axis registers its spec via an
      // effect, so early frames (before it lands) still draw auto gridlines.
      // Inspect only the FINAL frame — calls after the last clearRect (each
      // Canvas frame is transform → clearRect → draw).
      const lastClear = stub.calls.map((c) => c.name).lastIndexOf('clearRect');
      // gridline horizontals start at x=0 (drawGrid: moveTo(0,y) → lineTo(w,y)).
      const horizontalYs = stub.calls
        .slice(lastClear)
        .filter((c) => c.name === 'moveTo')
        .map((c) => c.args as [number, number])
        .filter(([x]) => x === 0)
        .map(([, y]) => y);
      // the explicit tick at 50 → gridline at y=100.5 …
      expect(horizontalYs).toContain(100.5);
      // … and the auto ticks (20→160.5, 40→120.5, …) are NOT drawn — proving the
      // override reaches the gridlines, not just the labels.
      expect(horizontalYs).not.toContain(160.5);
      expect(horizontalYs).not.toContain(120.5);
    } finally {
      stub.restore();
    }
  });
});

describe('<YAxis color> — per-instance axis colour', () => {
  it('colours the tick labels and the title, overriding the theme', () => {
    const stub = stubCanvasContext();
    try {
      const { getByText } = render(
        <ChartContainer range={[0, 2]} width={480} showAxis={false}>
          <ChartRow height={120}>
            <YAxis
              id="v"
              min={0}
              max={100}
              label="Value"
              labelPlacement="top"
              color="rgb(225, 29, 72)"
              tickCount={5}
            />
            <Layers>
              <LineChart series={series()} column="v" axis="v" />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
      // The strip (tick labels inherit from it) and the title both take it.
      const title = getByText('Value') as HTMLElement;
      expect(title.style.color).toBe('rgb(225, 29, 72)');
      const tick = getByText('40').parentElement as HTMLElement;
      expect(tick.style.color).toBe('rgb(225, 29, 72)');
    } finally {
      stub.restore();
    }
  });
});

describe('<YAxis tickCount> + height-derived density (#508 item 4)', () => {
  // Count the numeric auto-tick labels the axis rendered (the gutter tick
  // <div>s hold the formatted numbers; boundary labels included).
  const autoTickLabels = (container: HTMLElement): string[] =>
    Array.from(container.querySelectorAll('div'))
      .filter((el) => el.childElementCount === 0)
      .map((el) => el.textContent ?? '')
      .filter((t) => /^\d+$/.test(t));

  const chart = (props: { height: number; tickCount?: number }) => (
    <ChartContainer range={[0, 2]} width={400} showAxis={false}>
      <ChartRow height={props.height}>
        <YAxis
          id="v"
          min={0}
          max={100}
          {...(props.tickCount !== undefined
            ? { tickCount: props.tickCount }
            : {})}
        />
        <Layers>
          <LineChart series={series()} column="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );

  it('a short row gets fewer auto ticks than a tall one (height-derived)', () => {
    const short = render(chart({ height: 72 }));
    const shortN = new Set(autoTickLabels(short.container)).size;
    cleanup();
    const tall = render(chart({ height: 380 }));
    const tallN = new Set(autoTickLabels(tall.container)).size;
    // The 72px strip that used to crush 5 labels now shows materially fewer
    // than the 380px row.
    expect(shortN).toBeLessThan(tallN);
    expect(shortN).toBeGreaterThanOrEqual(2); // still drawable
  });

  it('explicit tickCount overrides the height-derived default', () => {
    // A tall row that would auto-pick many ticks, pinned to ~3.
    const { container } = render(chart({ height: 380, tickCount: 3 }));
    const labels = new Set(autoTickLabels(container));
    // d3 ticks(3) over [0,100] → 0/50/100 (a few nice values), far fewer than
    // the ~7 a 380px row derives.
    expect(labels.size).toBeLessThanOrEqual(4);
    expect(labels.has('50')).toBe(true);
  });

  it('a runtime tickCount change re-registers the axis (guard includes it)', () => {
    // Regression: tickCount must be in axisSpecEqual, or a tickCount-only
    // change compares equal to the stored spec and setAxes is skipped —
    // leaving the axis stuck on its first count.
    const { container, rerender } = render(
      chart({ height: 300, tickCount: 8 }),
    );
    const before = new Set(autoTickLabels(container)).size;
    rerender(chart({ height: 300, tickCount: 2 }));
    const after = new Set(autoTickLabels(container)).size;
    expect(after).toBeLessThan(before);
  });

  it('explicit ticks still win over tickCount', () => {
    const { getByText, queryByText } = render(
      <ChartContainer range={[0, 2]} width={400} showAxis={false}>
        <ChartRow height={380}>
          <YAxis
            id="v"
            min={0}
            max={100}
            tickCount={9}
            ticks={[{ at: 42, label: 'only' }]}
          />
          <Layers>
            <LineChart series={series()} column="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(getByText('only')).toBeTruthy();
    expect(queryByText('50')).toBeNull(); // no auto ticks at all
  });
});
