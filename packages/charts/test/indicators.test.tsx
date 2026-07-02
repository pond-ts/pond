import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { YAxisIndicator, createLiveValue } from '../src/indicators.js';

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
});
