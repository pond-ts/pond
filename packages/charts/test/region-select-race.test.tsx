/**
 * Region-select drag under a **batched** pointer stream (#508 item 7).
 *
 * The drag anchor used to live only in container state (`regionAnchor`), which
 * the up-handler read back through the rendered frame. A batched / untrusted
 * pointer stream (automation, jsdom — plausibly a very fast flick under load)
 * delivers down→move→up before the down's setState commits, so the up saw
 * `regionAnchor === null`: the select was silently dropped, and the
 * late-committing anchor then leaked, leaving the band stuck. Human-paced
 * trusted input hid this (React flushes trusted discrete events synchronously).
 *
 * The fix mirrors the anchor into a ref for gesture logic (the same
 * ref+state discipline `drawFromRef` already uses); state stays paint-only.
 */
import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { ContainerContext, type ContainerFrame } from '../src/context.js';

afterEach(cleanup);

function Capture({ sink }: { sink: (f: ContainerFrame) => void }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) sink(c);
  });
  return null;
}

const series = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 1],
      [500, 5],
      [1000, 9],
    ],
  });

function pointer(type: string, x: number, buttons: number): Event {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: 40,
    buttons,
  });
}

function mount(onRegionSelect: (r: readonly [number, number]) => void) {
  let frame: ContainerFrame | null = null;
  const { container } = render(
    <ChartContainer
      range={[0, 1000]}
      width={320}
      cursor="region"
      onRegionSelect={onRegionSelect}
    >
      <ChartRow height={120}>
        <YAxis id="a" min={0} max={10} />
        <Layers>
          <LineChart series={series()} column="v" axis="a" />
        </Layers>
      </ChartRow>
      <Capture sink={(f) => (frame = f)} />
    </ChartContainer>,
  );
  const surface = container.querySelector('canvas')!.parentElement!;
  return { surface, frame: () => frame! };
}

describe('region drag-select vs the pointer stream', () => {
  it('a batched down→move→up (no flush between events) still commits the span and clears the anchor', () => {
    const onRegionSelect = vi.fn();
    const { surface, frame } = mount(onRegionSelect);
    const plotWidth = frame().plotWidth; // px → time: t = px / plotWidth * 1000

    // One act(): the three events run back-to-back with NO state flush between
    // them — the automation / fast-flick stream. Pre-fix the up saw a null
    // anchor: no onRegionSelect call, and the anchor stuck (band leaked).
    act(() => {
      surface.dispatchEvent(pointer('pointerdown', 60, 1));
      surface.dispatchEvent(pointer('pointermove', 200, 1));
      surface.dispatchEvent(pointer('pointerup', 200, 0));
    });

    expect(onRegionSelect).toHaveBeenCalledTimes(1);
    const [t0, t1] = onRegionSelect.mock.calls[0]![0] as [number, number];
    expect(t0).toBeCloseTo((60 / plotWidth) * 1000, 6);
    expect(t1).toBeCloseTo((200 / plotWidth) * 1000, 6);
    // No leak: the anchor is fully cleared once the gesture ends.
    expect(frame().regionAnchor).toBeNull();
  });

  it('a paced gesture (flush between events — human-like) behaves identically', () => {
    const onRegionSelect = vi.fn();
    const { surface, frame } = mount(onRegionSelect);
    const plotWidth = frame().plotWidth;

    act(() => surface.dispatchEvent(pointer('pointerdown', 50, 1)));
    // Mid-drag, the paint mirror is live (the band can draw)…
    expect(frame().regionAnchor).toBeCloseTo((50 / plotWidth) * 1000, 6);
    act(() => surface.dispatchEvent(pointer('pointermove', 120, 1)));
    act(() => surface.dispatchEvent(pointer('pointerup', 120, 0)));

    expect(onRegionSelect).toHaveBeenCalledTimes(1);
    const [t0, t1] = onRegionSelect.mock.calls[0]![0] as [number, number];
    expect(t0).toBeCloseTo((50 / plotWidth) * 1000, 6);
    expect(t1).toBeCloseTo((120 / plotWidth) * 1000, 6);
    expect(frame().regionAnchor).toBeNull();
  });
});
