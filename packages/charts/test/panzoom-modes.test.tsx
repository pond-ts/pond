import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { TimeSeries } from 'pond-ts';
import { ContainerContext, type ContainerFrame } from '../src/context.js';

afterEach(cleanup);

const series = new TimeSeries({
  name: 's',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number' },
  ] as const,
  rows: [
    [0, 1],
    [500, 5],
    [1000, 3],
  ] as [number, number][],
});

function Capture({ sink }: { sink: (f: ContainerFrame) => void }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) sink(c);
  });
  return null;
}

function tree(props: Partial<Parameters<typeof ChartContainer>[0]>) {
  let frame: ContainerFrame | null = null;
  render(
    <ChartContainer range={[0, 1000]} width={300} {...props}>
      <ChartRow height={100}>
        <YAxis id="a" min={0} max={10} />
        <Layers>
          <LineChart series={series} column="v" axis="a" />
        </Layers>
        <Capture sink={(f) => (frame = f)} />
      </ChartRow>
    </ChartContainer>,
  );
  return () => frame!;
}

describe('panZoom modes → panEnabled / zoomEnabled', () => {
  it.each([
    ['none (default)', undefined, false, false],
    ['false', false, false, false],
    ["'none'", 'none', false, false],
    ["'pan'", 'pan', true, false],
    ["'panZoom'", 'panZoom', true, true],
    ['true', true, true, true],
  ] as const)('panZoom=%s → pan %s, zoom %s', (_label, value, pan, zoom) => {
    const get = tree(value === undefined ? {} : { panZoom: value });
    expect(get().panEnabled).toBe(pan);
    expect(get().zoomEnabled).toBe(zoom);
  });
});

describe('bounds clamps the range through applyRange', () => {
  it('slides a panned-past-edge range back inside, preserving span (controlled)', () => {
    const onTimeRangeChange = vi.fn();
    const get = tree({
      panZoom: 'panZoom',
      bounds: [0, 1000],
      onTimeRangeChange,
    });
    act(() => get().applyRange([-200, 300])); // span 500, past the left edge
    expect(onTimeRangeChange).toHaveBeenLastCalledWith([0, 500]);
  });

  it('caps a wider-than-extent range to the full bounds (zoom-out ceiling)', () => {
    const onTimeRangeChange = vi.fn();
    const get = tree({
      panZoom: 'panZoom',
      bounds: [0, 1000],
      onTimeRangeChange,
    });
    act(() => get().applyRange([-500, 1500])); // span 2000 > extent
    expect(onTimeRangeChange).toHaveBeenLastCalledWith([0, 1000]);
  });

  it('passes the range through unchanged when no bounds are given', () => {
    const onTimeRangeChange = vi.fn();
    const get = tree({ panZoom: 'panZoom', onTimeRangeChange });
    act(() => get().applyRange([-200, 300]));
    expect(onTimeRangeChange).toHaveBeenLastCalledWith([-200, 300]);
  });
});
