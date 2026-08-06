import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { docsTheme } from '../src/docs-theme.fixture.js';
import { stubCanvasContext, type CtxCall } from './canvas-mock.js';

afterEach(cleanup);

/**
 * `<ChartContainer grid>` has to repaint when it *changes*, not only when
 * something else happens to move.
 *
 * `Layers`' `draw` callback reads `container.grid`, but `grid` was missing from
 * its dependency array — so flipping the prop produced a new context and no new
 * `draw`, the `Canvas` effect never re-fired, and the gridlines stayed on screen
 * until an unrelated dep (`container.timeRange`) changed. The symptom in the
 * wild: "the grid doesn't disappear until you pan/zoom a little to force an
 * update." Same omission covered `sessionDividers` and `xKind`.
 */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

// ONE series instance, reused across both renders. A fresh one per render
// would change `layers`' identity and rebuild `draw` on its own — which is
// exactly what hid this bug from a first attempt at this test. `grid` must be
// the only thing that differs between the two trees.
const SERIES = new TimeSeries({
  name: 's',
  schema,
  rows: [
    [0, 1],
    [1, 3],
    [2, 2],
  ] as [number, number][],
});
const RANGE: [number, number] = [0, 2];

const chart = (grid: boolean) => (
  <ChartContainer range={RANGE} width={300} theme={docsTheme} grid={grid}>
    <ChartRow height={100}>
      <YAxis id="a" min={0} max={4} />
      <Layers>
        <LineChart series={SERIES} column="v" axis="a" />
      </Layers>
    </ChartRow>
  </ChartContainer>
);

/** Strokes in the theme's gridline colour — the gridlines themselves. */
const gridStrokes = (calls: CtxCall[]) =>
  calls.filter(
    (c) =>
      c.type === 'set' &&
      c.name === 'strokeStyle' &&
      String(c.args[0]).toLowerCase() === docsTheme.axis.grid.toLowerCase(),
  ).length;

describe('grid toggles repaint immediately', () => {
  it('drops the gridlines on rerender, with nothing else changed', () => {
    const stub = stubCanvasContext();
    try {
      const { rerender } = render(chart(true));
      const on = gridStrokes(stub.calls);
      expect(on).toBeGreaterThan(0); // sanity: the grid drew at all

      const before = stub.calls.length;
      rerender(chart(false));
      const after = stub.calls.slice(before);

      // The repaint has to happen *now* — nothing else about the chart moved.
      expect(after.length).toBeGreaterThan(0);
      expect(gridStrokes(after)).toBe(0);
    } finally {
      stub.restore();
    }
  });
});
