import { useContext, useEffect, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  type ContainerFrame,
  type TrackerInfo,
} from '../src/context.js';

afterEach(cleanup);

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;
const series = new TimeSeries({
  name: 's',
  schema,
  rows: [
    [0, 1],
    [50, 5],
    [100, 3],
  ] as [number, number][],
});

/** Grabs a container's frame so the test can call `setHoverX` — exactly what a
 *  row's pointer surface calls on hover — without a canvas hit-test. */
function Capture({ sink }: { sink: (f: ContainerFrame) => void }) {
  const c = useContext(ContainerContext);
  useEffect(() => {
    if (c) sink(c);
  });
  return null;
}

/**
 * Cross-chart cursor sync (the multi-chart dashboard pattern): two independent
 * `<ChartContainer>`s share one crosshair time in page state, wired through
 * `trackerPosition` (follow) + `onTrackerChanged` (report). A live local hover
 * wins over `trackerPosition` (the hovered chart is the source), so the pattern
 * needs no "which chart is active" bookkeeping. This pins that the wiring works
 * end-to-end — a hover on one chart drives the other's cursor.
 */
describe('cross-chart cursor sync via trackerPosition + onTrackerChanged', () => {
  function SyncHarness({
    spyA,
    spyB,
    sinkA,
  }: {
    spyA: (i: TrackerInfo | null) => void;
    spyB: (i: TrackerInfo | null) => void;
    sinkA: (f: ContainerFrame) => void;
  }) {
    const [shared, setShared] = useState<number | null>(null);
    return (
      <div onPointerLeave={() => setShared(null)}>
        <ChartContainer
          range={[0, 100]}
          width={200}
          trackerPosition={shared}
          onTrackerChanged={(i) => {
            setShared(i?.time ?? null);
            spyA(i);
          }}
        >
          <ChartRow height={80}>
            <YAxis id="a" min={0} max={10} />
            <Layers>
              <LineChart series={series} column="v" axis="a" />
            </Layers>
            <Capture sink={sinkA} />
          </ChartRow>
        </ChartContainer>
        <ChartContainer
          range={[0, 100]}
          width={200}
          trackerPosition={shared}
          onTrackerChanged={(i) => {
            setShared(i?.time ?? null);
            spyB(i);
          }}
        >
          <ChartRow height={80}>
            <YAxis id="b" min={0} max={10} />
            <Layers>
              <LineChart series={series} column="v" axis="b" />
            </Layers>
          </ChartRow>
        </ChartContainer>
      </div>
    );
  }

  it('hovering one chart drives the other chart to the same cursor time', () => {
    const spyA = vi.fn();
    const spyB = vi.fn();
    let frameA: ContainerFrame | null = null;
    render(<SyncHarness spyA={spyA} spyB={spyB} sinkA={(f) => (frameA = f)} />);

    // Hover chart A (only A) at a plot pixel — what its pointer surface calls.
    act(() => frameA!.setHoverX(50));

    // A reported a real (non-null) time out...
    expect(spyA).toHaveBeenCalled();
    const aTime = spyA.mock.calls.at(-1)![0]?.time ?? null;
    expect(aTime).not.toBeNull();

    // ...and chart B — never hovered — followed to the SAME time (sync).
    expect(spyB).toHaveBeenCalled();
    const bTime = spyB.mock.calls.at(-1)![0]?.time ?? null;
    expect(bTime).toBe(aTime);
  });

  it('a local hover wins over the followed position (the hovered chart is the source)', () => {
    // With a followed position already set, hovering a chart shows ITS pointer,
    // not the shared value — the property that makes the source/follower split
    // work without active-chart tracking.
    const spyA = vi.fn();
    const spyB = vi.fn();
    let frameA: ContainerFrame | null = null;
    render(<SyncHarness spyA={spyA} spyB={spyB} sinkA={(f) => (frameA = f)} />);
    act(() => frameA!.setHoverX(30)); // A hovers at pixel 30
    const first = spyA.mock.calls.at(-1)![0]?.time ?? null;
    act(() => frameA!.setHoverX(120)); // A moves — local hover keeps winning
    const second = spyA.mock.calls.at(-1)![0]?.time ?? null;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first); // A tracked its own pointer, not a pin
  });
});
