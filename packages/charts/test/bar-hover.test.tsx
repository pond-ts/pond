import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import { ContainerContext, type ContainerFrame } from '../src/context.js';

afterEach(cleanup);

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;
const bars = new TimeSeries({
  name: 'b',
  schema,
  rows: [
    [0, 1],
    [1, 2],
    [2, 3],
  ] as [number, number][],
});

/** Captures the latest container frame so a test can drive `setHovered` (the
 *  call the row's pointer surface makes) and read back the controlled/derived
 *  `hovered` value — without a canvas hit-test. */
function Capture({ sink }: { sink: (f: ContainerFrame) => void }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) sink(c);
  });
  return null;
}

const hitA = { key: 0, value: 1, color: '#fff', label: 'v' };
const hitB = { key: 1, value: 2, color: '#fff', label: 'v' };

/**
 * The hover half of the selection pair (F-charts-bar-interaction): a controlled
 * `hovered` prop + `onHover` callback on `ChartContainer`, symmetric with
 * `selected`/`onSelect`, keyed by the same `SelectInfo`. Drives the container's
 * `setHovered` directly (what `Layers`' pointer-move surface calls after a bar
 * hit-test).
 */
describe('controlled bar hover (hovered / onHover)', () => {
  const tree = (props: Partial<Parameters<typeof ChartContainer>[0]>) => {
    let frame: ContainerFrame | null = null;
    const ui = (
      <ChartContainer range={[0, 3]} width={300} {...props}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={5} />
          <Layers>
            <BarChart series={bars} column="v" axis="a" />
          </Layers>
          <Capture sink={(f) => (frame = f)} />
        </ChartRow>
      </ChartContainer>
    );
    return { ui, get: () => frame! };
  };

  it('uncontrolled: setHovered updates the frame and notifies onHover', () => {
    const onHover = vi.fn();
    const { ui, get } = tree({ onHover });
    render(ui);
    expect(get().hovered).toBeNull();

    act(() => get().setHovered(hitA));
    expect(onHover).toHaveBeenCalledWith(hitA);
    expect(get().hovered).toEqual(hitA); // internal state reflects it
  });

  it('deduped: an unchanged mark (same key+label) does not re-fire onHover', () => {
    const onHover = vi.fn();
    const { ui, get } = tree({ onHover });
    render(ui);
    act(() => get().setHovered(hitA));
    act(() => get().setHovered({ ...hitA })); // fresh object, same key+label
    expect(onHover).toHaveBeenCalledTimes(1);
    act(() => get().setHovered(hitB)); // a genuine transition
    expect(onHover).toHaveBeenCalledTimes(2);
    act(() => get().setHovered(null)); // and clearing
    expect(onHover).toHaveBeenCalledTimes(3);
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('controlled: the prop pins hovered; setHovered notifies but does not override', () => {
    const onHover = vi.fn();
    // `hovered` prop pins bar B (e.g. a legend row is hovered).
    const { ui, get } = tree({ hovered: hitB, onHover });
    render(ui);
    expect(get().hovered).toEqual(hitB);

    // A bar-originated hover fires the callback but doesn't move the displayed
    // highlight — the controlling parent decides what to pin.
    act(() => get().setHovered(hitA));
    expect(onHover).toHaveBeenCalledWith(hitA);
    expect(get().hovered).toEqual(hitB); // still the pinned prop

    // Dedup holds in controlled mode too (via lastHoverRef, since there's no
    // internal state to diff against): the same mark again is a no-op.
    act(() => get().setHovered({ ...hitA }));
    expect(onHover).toHaveBeenCalledTimes(1);
  });
});
