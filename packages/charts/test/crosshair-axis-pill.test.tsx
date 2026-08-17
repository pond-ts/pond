import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { CrosshairCursor } from '../src/cursors.js';
import { defaultTheme } from '../src/theme.js';

afterEach(cleanup);

/**
 * The crosshair's value pill is an **axis indicator**, so it must land on the
 * axis whose scale produced the number and wear that axis's ink. With one axis
 * per side both were free: the pill hugged the plot edge in the cursor's colour
 * and that *was* the only axis. With two axes on a side it read as a value on a
 * ruler that never measured it — an inner `usd` axis carrying a `bpm` reading.
 */

/** Values 0..100 — read on the `v` axis. */
const price = new TimeSeries({
  name: 'p',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number' },
  ] as const,
  rows: [
    [0, 10],
    [2, 90],
    [4, 40],
  ] as [number, number][],
});

/** Values 100..200 — read on a *second* axis, so no tick or pill text collides
 *  with the price series' formatted values. */
const hr = new TimeSeries({
  name: 'hr',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'bpm', kind: 'number' },
  ] as const,
  rows: [
    [0, 111],
    [2, 177],
    [4, 133],
  ] as [number, number][],
});

const WIDTH = 300;
const AXIS_W = 40;
/** Default gutter widths: `<YAxis width>` is explicit below, so the plot is
 *  whatever is left of the container after the axes on each side. */
const plotFor = (axes: number) => WIDTH - axes * AXIS_W;

/** The axis-value pills — absolute `border-radius: 3px` divs centred on their
 *  value (`translateY`), which excludes the x-axis time pill (`translateX`). */
const yPills = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('div')).filter(
    (d) =>
      d.style.position === 'absolute' &&
      d.style.borderRadius === '3px' &&
      (d.style.transform ?? '').includes('Y'),
  );

/** The single reticle pill (there is exactly one per row). */
function pill(c: HTMLElement): HTMLElement {
  const found = yPills(c);
  expect(found.length).toBe(1);
  return found[0]!;
}

describe('the crosshair value pill sits on the reticle axis', () => {
  it('one axis: hugs the plot edge (offset 0 — the pre-existing placement)', () => {
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={WIDTH}
        trackerPosition={2}
        showAxis={false}
      >
        <CrosshairCursor />
        <ChartRow height={120}>
          <Layers>
            <LineChart series={price} column="v" axis="usd" />
          </Layers>
          <YAxis id="usd" side="right" width={AXIS_W} min={0} max={100} />
        </ChartRow>
      </ChartContainer>,
    );
    const p = pill(container);
    expect(p.textContent).toBe('90');
    expect(p.style.left).toBe(`${plotFor(1)}px`);
  });

  it('two right axes: the pill lands on the OUTER axis when the reticle reads it', () => {
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={WIDTH}
        trackerPosition={2}
        showAxis={false}
      >
        <CrosshairCursor />
        <ChartRow height={120}>
          <Layers>
            {/* First-registered layer = the pinned (unhovered) reticle's pick,
                and it is bound to the outer axis. */}
            <LineChart series={hr} column="bpm" axis="bpm" />
            <LineChart series={price} column="v" axis="usd" />
          </Layers>
          {/* Right axes are authored inner→outer. */}
          <YAxis id="usd" side="right" width={AXIS_W} min={0} max={100} />
          <YAxis id="bpm" side="right" width={AXIS_W} min={100} max={200} />
        </ChartRow>
      </ChartContainer>,
    );
    const p = pill(container);
    expect(p.textContent).toBe('177');
    // Past the inner axis's reserved column, not against the plot.
    expect(p.style.left).toBe(`${plotFor(2) + AXIS_W}px`);
  });

  it('two right axes: the pill hugs the plot when the reticle reads the INNER axis', () => {
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={WIDTH}
        trackerPosition={2}
        showAxis={false}
      >
        <CrosshairCursor />
        <ChartRow height={120}>
          <Layers>
            <LineChart series={price} column="v" axis="usd" />
            <LineChart series={hr} column="bpm" axis="bpm" />
          </Layers>
          <YAxis id="usd" side="right" width={AXIS_W} min={0} max={100} />
          <YAxis id="bpm" side="right" width={AXIS_W} min={100} max={200} />
        </ChartRow>
      </ChartContainer>,
    );
    const p = pill(container);
    expect(p.textContent).toBe('90');
    expect(p.style.left).toBe(`${plotFor(2)}px`);
  });

  it('two left axes: the offset runs out the LEFT gutter (mirrored)', () => {
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={WIDTH}
        trackerPosition={2}
        showAxis={false}
      >
        <CrosshairCursor />
        <ChartRow height={120}>
          {/* Left axes are authored outer→inner: `bpm` outer, `usd` inner. */}
          <YAxis id="bpm" side="left" width={AXIS_W} min={100} max={200} />
          <YAxis id="usd" side="left" width={AXIS_W} min={0} max={100} />
          <Layers>
            <LineChart series={hr} column="bpm" axis="bpm" />
            <LineChart series={price} column="v" axis="usd" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const p = pill(container);
    expect(p.textContent).toBe('177');
    expect(p.style.right).toBe(`${plotFor(2) + AXIS_W}px`);
    expect(p.style.left).toBe('');
  });

  it("a row's axes are reserved per column, so a wider sibling row pushes the offset out", () => {
    // The container reserves each slot at its widest across rows, and every row
    // renders its axis boxes at that reservation — so the offset must come from
    // the *reserved* column width, not the axis's own `width`.
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={WIDTH}
        trackerPosition={2}
        showAxis={false}
      >
        <CrosshairCursor />
        <ChartRow height={80}>
          <Layers>
            <LineChart series={hr} column="bpm" axis="bpm" />
            <LineChart series={price} column="v" axis="usd" />
          </Layers>
          <YAxis id="usd" side="right" width={AXIS_W} min={0} max={100} />
          <YAxis id="bpm" side="right" width={AXIS_W} min={100} max={200} />
        </ChartRow>
        <ChartRow height={80}>
          <Layers>
            <LineChart series={price} column="v" axis="wide" />
          </Layers>
          {/* Widest in the inner column — every row's inner column is now 70. */}
          <YAxis id="wide" side="right" width={70} min={0} max={100} />
        </ChartRow>
      </ChartContainer>,
    );
    // Row 1's outer pill clears the *reserved* 70px inner column.
    const first = yPills(container).find((d) => d.textContent === '177');
    expect(first).toBeDefined();
    expect(first!.style.left).toBe(`${WIDTH - 70 - AXIS_W + 70}px`);
  });
});

describe('the crosshair value pill wears the reticle axis ink', () => {
  const twoAxes = (colors: { usd?: string; bpm?: string }) =>
    render(
      <ChartContainer
        range={[0, 4]}
        width={WIDTH}
        trackerPosition={2}
        showAxis={false}
      >
        <CrosshairCursor />
        <ChartRow height={120}>
          <Layers>
            <LineChart series={hr} column="bpm" axis="bpm" />
            <LineChart series={price} column="v" axis="usd" />
          </Layers>
          {/* Spread rather than `color={colors.usd}`: an explicit `undefined`
              is not assignable under `exactOptionalPropertyTypes`. */}
          <YAxis
            id="usd"
            side="right"
            width={AXIS_W}
            min={0}
            max={100}
            {...(colors.usd !== undefined ? { color: colors.usd } : {})}
          />
          <YAxis
            id="bpm"
            side="right"
            width={AXIS_W}
            min={100}
            max={200}
            {...(colors.bpm !== undefined ? { color: colors.bpm } : {})}
          />
        </ChartRow>
      </ChartContainer>,
    );

  it("takes the reticle axis's <YAxis color>", () => {
    const { container } = twoAxes({ usd: '#4a90d9', bpm: '#d97a4a' });
    // The reticle reads `bpm` (first layer), so the pill is the bpm axis's ink —
    // NOT the inner axis's, which is the one it used to sit on.
    expect(pill(container).style.background).toBe('#d97a4a');
  });

  it('falls back to the theme cursor ink when that axis sets no colour', () => {
    const { container } = twoAxes({ usd: '#4a90d9' });
    expect(pill(container).style.background).toBe(defaultTheme.cursor);
  });

  it('a free reticle (snap={false}) takes the default axis placement + ink', () => {
    const { container } = render(
      <ChartContainer range={[0, 4]} width={WIDTH} showAxis={false}>
        <CrosshairCursor snap={false} />
        <ChartRow height={120}>
          {/* Left axes are authored outer→inner, and the FIRST declared axis is
              the row default — so the free reticle's axis is the outer one. */}
          <YAxis
            id="bpm"
            side="left"
            width={AXIS_W}
            min={100}
            max={200}
            color="#d97a4a"
          />
          <YAxis id="usd" side="left" width={AXIS_W} min={0} max={100} />
          <Layers>
            <LineChart series={hr} column="bpm" axis="bpm" />
            <LineChart series={price} column="v" axis="usd" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    // The free reticle needs a live pointer (it reads the raw pointer y).
    const surface = container.querySelector('canvas')!.parentElement!;
    fireEvent.pointerMove(surface, { clientX: 100, clientY: 60 });
    const p = pill(container);
    expect(p.style.right).toBe(`${plotFor(2) + AXIS_W}px`);
    expect(p.style.background).toBe('#d97a4a');
  });
});
