import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, within } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { Baseline, Marker } from '../src/annotations.js';
import { XAxis } from '../src/XAxis.js';
import { YAxisIndicator, createLiveValue } from '../src/indicators.js';
import { contrastText } from '../src/chip.js';

afterEach(cleanup);

const series = new TimeSeries({
  name: 't',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number' },
  ] as const,
  rows: [
    [0, 1],
    [1, 5],
    [2, 9],
    [3, 4],
    [4, 7],
  ] as [number, number][],
});

function renderInd(child: ReactNode) {
  return render(
    <ChartContainer range={[0, 4]} width={300} showAxis={false}>
      <ChartRow height={120}>
        <YAxis id="a" min={0} max={100} />
        <Layers>
          <LineChart series={series} column="v" axis="a" />
          {child}
        </Layers>
      </ChartRow>
    </ChartContainer>,
  );
}

/** Render an indicator in a `[0,100]` axis and query its pill by text. */
function pillText(child: ReactNode, text: string): boolean {
  const { container, unmount } = renderInd(child);
  const found = within(container).queryByText(text) !== null;
  unmount();
  return found;
}

/** Count rendered pill chips (the only `border-radius:3px` absolute divs in this
 *  minimal render — no annotations present). `0` ⇒ the indicator drew nothing. */
function pillCount(child: ReactNode): number {
  const { container, unmount } = renderInd(child);
  const n = Array.from(container.querySelectorAll('div')).filter(
    (d) => d.style.position === 'absolute' && d.style.borderRadius === '3px',
  ).length;
  unmount();
  return n;
}

describe('createLiveValue', () => {
  it('seeds, reports, and updates via set()', () => {
    const lv = createLiveValue(42);
    expect(lv.getSnapshot()).toBe(42);
    lv.set(99);
    expect(lv.getSnapshot()).toBe(99);
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const lv = createLiveValue(0);
    const cb = vi.fn();
    const unsub = lv.subscribe(cb);
    lv.set(1);
    lv.set(2);
    expect(cb).toHaveBeenCalledTimes(2);
    unsub();
    lv.set(3);
    expect(cb).toHaveBeenCalledTimes(2); // no further notifies
    expect(lv.getSnapshot()).toBe(3); // …but the value still advances
  });

  it('skips a redundant notify when the value is unchanged', () => {
    const lv = createLiveValue(5);
    const cb = vi.fn();
    lv.subscribe(cb);
    lv.set(5); // same value → no notify
    expect(cb).not.toHaveBeenCalled();
    lv.set(6);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('contrastText', () => {
  it('picks white on saturated hues, dark on pale ones', () => {
    expect(contrastText('#4a90e2')).toBe('#ffffff'); // blue
    expect(contrastText('#e5534b')).toBe('#ffffff'); // red
    expect(contrastText('#0d9488')).toBe('#ffffff'); // teal
    expect(contrastText('#7FE2D2')).toBe('#0b1220'); // pale turquoise → dark
    expect(contrastText('#ffffff')).toBe('#0b1220'); // white → dark
  });

  it('falls back to white for a non-hex colour', () => {
    expect(contrastText('rebeccapurple')).toBe('#ffffff');
  });
});

describe('YAxisIndicator', () => {
  it('renders a pill labelled with the static value (axis formatter)', () => {
    // Axis [0,100], value 37 → the axis default formats it to "37".
    expect(pillText(<YAxisIndicator value={37} axis="a" />, '37')).toBe(true);
  });

  it('applies a custom d3 format specifier', () => {
    expect(
      pillText(<YAxisIndicator value={37} axis="a" format=",.2f" />, '37.00'),
    ).toBe(true);
  });

  it('reads from a LiveValue source', () => {
    const lv = createLiveValue(63);
    expect(pillText(<YAxisIndicator source={lv} axis="a" />, '63')).toBe(true);
  });

  it('renders a solid pill: background = color, auto-contrast text', () => {
    const { container, unmount } = renderInd(
      <YAxisIndicator value={37} axis="a" color="#4a90e2" />,
    );
    const pill = Array.from(container.querySelectorAll('div')).find(
      (d) => d.style.borderRadius === '3px' && d.textContent === '37',
    ) as HTMLElement;
    // solid colour fill (not the theme chip background) + white text on the
    // saturated blue (luminance < 0.6).
    expect(pill.style.background).toBe('#4a90e2');
    expect(pill.style.color).toBe('#ffffff');
    unmount();
  });

  it('renders nothing when no value and no source is given', () => {
    // NaN snapshot ⇒ non-finite ⇒ null render (no pill, no crash).
    expect(pillCount(<YAxisIndicator axis="a" />)).toBe(0);
  });

  it('renders nothing for a non-finite value', () => {
    expect(pillCount(<YAxisIndicator value={NaN} axis="a" />)).toBe(0);
  });

  it('renders exactly one pill for a finite value', () => {
    expect(pillCount(<YAxisIndicator value={37} axis="a" />)).toBe(1);
  });

  it('source takes precedence over value when both are given', () => {
    const lv = createLiveValue(63);
    // value=37 present, but source (63) wins.
    expect(
      pillText(<YAxisIndicator value={37} source={lv} axis="a" />, '63'),
    ).toBe(true);
    expect(
      pillText(<YAxisIndicator value={37} source={lv} axis="a" />, '37'),
    ).toBe(false);
  });

  const chipPos = (child: ReactNode) => {
    const { container, unmount } = renderInd(child);
    const el = Array.from(container.querySelectorAll('div')).find(
      (d) => d.style.position === 'absolute' && d.style.borderRadius === '3px',
    ) as HTMLElement | undefined;
    const pos = {
      left: el?.style.left ?? '',
      right: el?.style.right ?? '',
      zIndex: el?.style.zIndex ?? '',
    };
    unmount();
    return pos;
  };

  it('is always on-axis: anchors at the plot edge and lifts over the gutter', () => {
    // renderInd: one left YAxis width 50 in a width-300 container ⇒ plotWidth 250.
    // (Indicators are always on the axis — there is no `inside` placement.)
    expect(
      chipPos(<YAxisIndicator value={37} axis="a" side="right" />),
    ).toEqual({
      left: '250px',
      right: '',
      zIndex: '3',
    });
    expect(chipPos(<YAxisIndicator value={37} axis="a" side="left" />)).toEqual(
      {
        left: '',
        right: '250px',
        zIndex: '3',
      },
    );
  });
});

/**
 * The load-bearing guarantee: a `source.set()` re-renders **only the subscribed
 * pill**, never the chart tree. A `RenderProbe` sibling counts chart-subtree
 * renders; after mount, a `set()` moves the pill (text changes) while the probe's
 * count stays flat — proving no ancestor re-render path. (StrictMode would
 * inflate the absolute count, but the delta across `set()` is what's asserted, so
 * it holds regardless.)
 */
describe('YAxisIndicator isolation', () => {
  it('a source update repaints only the pill, not the chart subtree', () => {
    const lv = createLiveValue(37);
    let chartRenders = 0;
    function RenderProbe() {
      chartRenders += 1;
      return null;
    }
    const { container } = render(
      <ChartContainer range={[0, 4]} width={300} showAxis={false}>
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
            <RenderProbe />
            <YAxisIndicator source={lv} axis="a" format=",.0f" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );

    expect(within(container).queryByText('37')).not.toBeNull();
    const rendersAfterMount = chartRenders;

    act(() => {
      lv.set(63);
    });

    // The pill moved…
    expect(within(container).queryByText('63')).not.toBeNull();
    expect(within(container).queryByText('37')).toBeNull();
    // …but the chart subtree did not re-render.
    expect(chartRenders).toBe(rendersAfterMount);
  });
});

/**
 * The crosshair CursorMode pins each series' value to its y-axis (an on-axis
 * pill). Driven by a controlled `trackerPosition` (a time) so the cursor is
 * deterministic — no fragile pointer-event / layout simulation.
 */
describe("cursor='crosshair'", () => {
  const crosshairAt = (mode: 'crosshair' | 'line') =>
    render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        cursor={mode}
        trackerPosition={2}
        showAxis={false}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} side="right" />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );

  it('pins the series value at the cursor to the y-axis', () => {
    // series at t=2 ⇒ v=9; axis [0,100] has no "9" tick, so the pill is the
    // only "9" on screen.
    const { container } = crosshairAt('crosshair');
    expect(within(container).queryByText('9')).not.toBeNull();
  });

  it("'line' mode draws no value pill (control)", () => {
    const { container } = crosshairAt('line');
    expect(within(container).queryByText('9')).toBeNull();
  });

  it('renders the x-axis time pill (with <XAxis> present)', () => {
    // A sentinel timeFormat so the x-pill text is deterministic; the x-pill is
    // the chip with a `translateX` transform (y-pills use `translateY`).
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        cursor="crosshair"
        trackerPosition={2}
        timeFormat={() => 'T!'}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} side="right" />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const chips = Array.from(container.querySelectorAll('div')).filter(
      (d) => d.style.position === 'absolute' && d.style.borderRadius === '3px',
    );
    const xPill = chips.find((d) => (d.style.transform ?? '').includes('X'));
    expect(xPill?.textContent).toBe('T!');
  });

  it('places each series value pill on its own axis side (dual axis)', () => {
    const two = new TimeSeries({
      name: 'two',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'l', kind: 'number' },
        { name: 'r', kind: 'number' },
      ] as const,
      rows: [
        [0, 10, 80],
        [2, 30, 60],
        [4, 20, 90],
      ] as [number, number, number][],
    });
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        cursor="crosshair"
        trackerPosition={2}
        showAxis={false}
      >
        <ChartRow height={120}>
          <YAxis id="L" min={0} max={100} side="left" />
          <Layers>
            <LineChart series={two} column="l" axis="L" />
            <LineChart series={two} column="r" axis="R" />
          </Layers>
          <YAxis id="R" min={0} max={100} side="right" />
        </ChartRow>
      </ChartContainer>,
    );
    // Left-axis series (l=30) pill hugs the left edge (`right:` set); right-axis
    // series (r=60) pill hugs the right edge (`left:` set).
    const chipFor = (text: string) =>
      Array.from(container.querySelectorAll('div')).find(
        (d) => d.style.borderRadius === '3px' && d.textContent === text,
      ) as HTMLElement | undefined;
    const lPill = chipFor('30');
    const rPill = chipFor('60');
    expect(lPill?.style.right).not.toBe('');
    expect(lPill?.style.left).toBe('');
    expect(rPill?.style.left).not.toBe('');
    expect(rPill?.style.right).toBe('');
  });

  const chipsIn = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('div')).filter(
      (d) => d.style.position === 'absolute' && d.style.borderRadius === '3px',
    );

  it('does not also draw a per-row time chip — the time lives only on the x-axis pill', () => {
    // Regression: `cursorTime` + crosshair once double-showed the time — a
    // per-row flag chip atop the row *and* the x-axis pill. The per-row chip
    // (flag/line modes' readout) must be suppressed for crosshair.
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        cursor="crosshair"
        cursorTime
        trackerPosition={2}
        timeFormat={() => 'TT'}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} side="right" />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const timeChips = chipsIn(container).filter((d) => d.textContent === 'TT');
    // Exactly one — the x-axis pill (a `translateX` chip), no per-row chip.
    expect(timeChips.length).toBe(1);
    expect(timeChips[0]!.style.transform).toContain('X');
  });

  it('the x-axis pill uses the axis format, not the container time formatter', () => {
    // Regression: the crosshair x-pill hardcoded the container `formatTime`, so a
    // value axis (or a custom `<XAxis format>`) showed the wrong text (e.g. a raw
    // number). It must use the same resolved formatter as the ticks.
    const { container } = render(
      <ChartContainer
        range={[0, 4]}
        width={300}
        cursor="crosshair"
        trackerPosition={2}
        timeFormat={() => 'CONTAINER'}
        showAxis={false}
      >
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} side="right" />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
          </Layers>
        </ChartRow>
        <XAxis format={() => 'AXISFMT'} />
      </ChartContainer>,
    );
    const xPill = chipsIn(container).find((d) =>
      (d.style.transform ?? '').includes('X'),
    );
    expect(xPill?.textContent).toBe('AXISFMT');
  });
});

/** Item 3: an `indicator` opt-in on Baseline (y-axis pill) and Marker (x-axis
 *  pill), reusing the same on-axis placement. */
describe('annotation indicators', () => {
  const chips = (c: HTMLElement) =>
    Array.from(c.querySelectorAll('div')).filter(
      (d) => d.style.position === 'absolute' && d.style.borderRadius === '3px',
    );

  it('Baseline indicator draws an on-axis y-pill; without it, none', () => {
    // label={false} suppresses the near-line chip, so the only chip is the pill.
    const withInd = renderInd(
      <Baseline value={37} axis="a" indicator label={false} />,
    );
    const pill = chips(withInd.container).find((d) => d.textContent === '37');
    expect(pill).toBeDefined();
    expect(pill!.style.zIndex).toBe('3'); // on-axis (lifted over the gutter)
    withInd.unmount();

    const without = renderInd(<Baseline value={37} axis="a" label={false} />);
    expect(chips(without.container).length).toBe(0);
    without.unmount();
  });

  it('Marker indicator draws an x-axis pill on <XAxis>', () => {
    // Sentinel timeFormat ⇒ deterministic text; the x-pill is the chip with a
    // translateX transform (showAxis default true renders the time axis).
    const { container } = render(
      <ChartContainer range={[0, 4]} width={300} timeFormat={() => 'M!'}>
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
            <Marker at={2} indicator label={false} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const xPill = chips(container).find((d) =>
      (d.style.transform ?? '').includes('X'),
    );
    expect(xPill?.textContent).toBe('M!');
  });

  it('Marker without indicator draws no x-axis pill', () => {
    const { container } = render(
      <ChartContainer range={[0, 4]} width={300} timeFormat={() => 'M!'}>
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
            <Marker at={2} label={false} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(chips(container).length).toBe(0);
  });

  it('the axis pill always shows the formatted value, never the custom label', () => {
    // An indicator reads like a tick: even with a custom `label` (the in-plot
    // chip), the x-axis pill shows the formatted time (sentinel `VAL`).
    const { container } = render(
      <ChartContainer range={[0, 4]} width={300} timeFormat={() => 'VAL'}>
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
            <Marker at={2} label="Lap 3" indicator />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const pill = chips(container).find((d) =>
      (d.style.transform ?? '').includes('X'),
    );
    expect(pill?.textContent).toBe('VAL'); // the value, not "Lap 3"
  });

  it('an off-plot marker draws no x-axis pill', () => {
    const { container } = render(
      <ChartContainer range={[0, 4]} width={300} timeFormat={() => 'M!'}>
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
            {/* at=99 is far past the [0,4] range ⇒ x > plotWidth ⇒ filtered out */}
            <Marker at={99} indicator label={false} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(chips(container).length).toBe(0);
  });
});
