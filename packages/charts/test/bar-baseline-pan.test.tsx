import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import { RowContext, type RowFrame } from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

function Capture({ into }: { into: { r?: RowFrame } }) {
  const r = useContext(RowContext);
  useEffect(() => {
    if (r) into.r = r;
  });
  return null;
}

const desks = [
  { label: 'EMEA', value: 12 },
  { label: 'APAC', value: 19 },
  { label: 'AMER', value: 26 },
  { label: 'LATAM', value: 33 },
  { label: 'MEA', value: 40 },
];

/**
 * `resolveBarBaseline` used to read the axis's LIVE (panned/zoomed) domain to
 * decide where a bar's baseline sits — designed for a deliberate `<YAxis
 * min>` that excludes zero, but indistinguishable from a transient gutter pan
 * that scrolls zero out of the visible window. Once a pan pushed the domain
 * floor above a bar's own value, the baseline (not the value) landed at the
 * bar's drawn top, so the bar read as whatever the pan happened to leave at
 * the floor — not its actual data.
 */
describe('bar baseline survives a y-axis pan', () => {
  it('a bar shorter than the panned-away floor still draws at its true value, not the floor', () => {
    const stub = stubCanvasContext();
    const into: { r?: RowFrame } = {};
    try {
      const dom = render(
        <ChartContainer
          width={560}
          categories={desks.map((d) => d.label)}
          panZoom="panZoomXY"
          axisPanZoom="xy"
        >
          <ChartRow height={200}>
            <YAxis id="flow" format=",.0f" />
            <Layers>
              <BarChart categories={desks} axis="flow" />
            </Layers>
            <Capture into={into} />
          </ChartRow>
        </ChartContainer>,
      ).container;

      const gutter = Array.from(dom.querySelectorAll('div')).find((d) =>
        (d.getAttribute('style') || '').includes('touch-action: none'),
      )!;

      // Auto-fit domain is [0, 40]. Drag the gutter down far enough that the
      // panned domain's floor rises well above EMEA's value (12) — the
      // regime the old code corrupted.
      act(() => {
        fireEvent.pointerDown(gutter, {
          clientX: 5,
          clientY: 90,
          button: 0,
          pointerId: 1,
        });
        fireEvent.pointerMove(gutter, {
          clientX: 5,
          clientY: 150,
          pointerId: 1,
        });
        fireEvent.pointerUp(gutter, {
          clientX: 5,
          clientY: 150,
          pointerId: 1,
        });
      });

      const yScale = into.r!.yScales.get('flow')!;
      const [d0, d1] = yScale.domain() as [number, number];
      const floor = Math.min(d0, d1);
      // Sanity check this test actually reached the corrupting regime.
      expect(floor).toBeGreaterThan(12);

      const fillRects = stub.calls.filter(
        (c) => c.type === 'call' && c.name === 'fillRect',
      );
      // Five bars drawn left to right, one `fillRect` per bar; EMEA is the
      // first of the LATEST (post-drag) draw pass, not the mount-time one.
      const latest = fillRects.slice(-5);
      const [, emeaTop] = latest[0]!.args as [number, number, number, number];

      // The bar's drawn top must invert (through the CURRENT, panned scale)
      // to its true value, 12 — never to the panned domain floor.
      expect(yScale.invert(emeaTop)).toBeCloseTo(12, 5);
    } finally {
      stub.restore();
    }
  });
});
