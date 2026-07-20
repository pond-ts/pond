/**
 * First mount at an **async-arrived width** — the ParentSize pattern: the
 * parent measures via ResizeObserver AFTER paint, so the chart mounts in a
 * second render pass at the freshly-measured width.
 *
 * Pins that the full draw chain (layer registration → extent settle → Canvas
 * layout-effect draw) fires on such a mount exactly as on a fixed-width mount,
 * plain and under StrictMode. Context: #508 item 6 reports an empty first
 * paint in this scenario in a real browser; it does NOT reproduce at the
 * React/jsdom level (these tests), and the library draw path takes no
 * dependency on browser layout (no getBoundingClientRect / ResizeObserver /
 * rAF outside pointer handlers) — so if the report is confirmed, the cause is
 * below React (browser paint/DPR timing) or consumer-side. These tests guard
 * the part the library CAN guarantee.
 */
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
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
      [0, 1],
      [500, 5],
      [1000, 9],
    ],
  });

function Chart({ width }: { width: number }) {
  return (
    <ChartContainer range={[0, 1000]} width={width}>
      <ChartRow height={120}>
        <YAxis id="a" min={0} max={10} />
        <Layers>
          <LineChart series={series()} column="v" axis="a" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}

/** ParentSize analogue: renders nothing until a post-paint effect delivers the
 *  measured width (ResizeObserver fires after layout/paint), then mounts the
 *  chart at that width in a second render pass. */
function Measured({ children }: { children: (w: number) => ReactNode }) {
  const [w, setW] = useState(0);
  useEffect(() => {
    setW(960);
  }, []);
  return <>{w > 0 ? children(w) : null}</>;
}

function drawOps(calls: Array<{ name: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of calls) counts[c.name] = (counts[c.name] ?? 0) + 1;
  return counts;
}

describe('first mount at async width (ParentSize pattern)', () => {
  it('control: fixed-width mount draws the line', () => {
    const stub = stubCanvasContext();
    try {
      render(<Chart width={960} />);
      const ops = drawOps(stub.calls);
      expect((ops['lineTo'] ?? 0) + (ops['moveTo'] ?? 0)).toBeGreaterThan(0);
      expect(ops['stroke'] ?? 0).toBeGreaterThan(0);
    } finally {
      stub.restore();
    }
  });

  it('async-width mount: does the first paint draw?', () => {
    const stub = stubCanvasContext();
    try {
      act(() => {
        render(<Measured>{(w) => <Chart width={w} />}</Measured>);
      });
      const ops = drawOps(stub.calls);
      expect((ops['lineTo'] ?? 0) + (ops['moveTo'] ?? 0)).toBeGreaterThan(0);
      expect(ops['stroke'] ?? 0).toBeGreaterThan(0);
    } finally {
      stub.restore();
    }
  });

  it('async-width mount under StrictMode: does the first paint draw?', () => {
    const stub = stubCanvasContext();
    try {
      act(() => {
        render(
          <StrictMode>
            <Measured>{(w) => <Chart width={w} />}</Measured>
          </StrictMode>,
        );
      });
      const ops = drawOps(stub.calls);
      expect((ops['lineTo'] ?? 0) + (ops['moveTo'] ?? 0)).toBeGreaterThan(0);
      expect(ops['stroke'] ?? 0).toBeGreaterThan(0);
    } finally {
      stub.restore();
    }
  });
});
