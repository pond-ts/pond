import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
} from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;
const series = () =>
  new TimeSeries({
    name: 'b',
    schema,
    rows: [
      [0, 1],
      [1, 2],
      [2, 3],
    ] as [number, number][],
  });

/**
 * `binColors` on the single-series **vertical** `<BarChart>` (the
 * direction-coloured financial volume row): the hover / click readout must
 * report the bar's **own** colour — matching the pixels — with an `undefined`
 * entry falling back to the theme fill, exactly as the stacked path's
 * `binFills` readout does.
 */
describe('<BarChart binColors> — single-series readout colour', () => {
  function mount(binColors?: readonly (string | undefined)[]) {
    let cf: ContainerFrame | null = null;
    let rf: RowFrame | null = null;
    function Capture() {
      const c = useContext(ContainerContext);
      const r = useContext(RowContext);
      useEffect(() => {
        if (c) cf = c;
        if (r) rf = r;
      });
      return null;
    }
    const stub = stubCanvasContext();
    try {
      render(
        <ChartContainer range={[0, 3]} width={300}>
          <ChartRow height={100}>
            <YAxis id="a" min={0} max={5} />
            <Layers>
              <BarChart
                series={series()}
                column="v"
                axis="a"
                id="v"
                {...(binColors !== undefined ? { binColors } : {})}
              />
              <Capture />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    return { container: () => cf!, row: () => rf! };
  }

  const colors = ['#e00', undefined, '#0a0'] as const;

  it('hitTest reports the bar’s own colour; undefined falls back to theme', () => {
    const { container, row } = mount(colors);
    const c = container();
    const r = row();
    const layer = r.layers.find((l) => l.layer.hitTest !== undefined)!.layer;
    const yScale = r.yScales.get('a')!;
    // Bar 0 (t=0, v=1): its own colour.
    const hit0 = layer.hitTest!(+c.xScale(0), yScale(0.5), c.xScale, yScale);
    expect(hit0?.color).toBe('#e00');
    // Bar 1 (t=1, v=2): undefined entry → the theme's flat bar fill.
    const hit1 = layer.hitTest!(+c.xScale(1), yScale(1), c.xScale, yScale);
    expect(hit1?.color).toBe(c.theme.bar.default.fill);
    // Bar 2 (t=2, v=3): its own colour.
    const hit2 = layer.hitTest!(+c.xScale(2), yScale(1.5), c.xScale, yScale);
    expect(hit2?.color).toBe('#0a0');
  });

  it('sampleAt (the x-scrub readout) reports the bar’s own colour too', () => {
    const { container, row } = mount(colors);
    const layer = row().layers.find(
      (l) => l.layer.hitTest !== undefined,
    )!.layer;
    expect(layer.sampleAt(2)[0]?.color).toBe('#0a0');
    expect(layer.sampleAt(1)[0]?.color).toBe(
      container().theme.bar.default.fill,
    );
  });

  it('without binColors the readout stays the flat theme fill (regression)', () => {
    const { container, row } = mount();
    const c = container();
    const r = row();
    const layer = r.layers.find((l) => l.layer.hitTest !== undefined)!.layer;
    const yScale = r.yScales.get('a')!;
    const hit = layer.hitTest!(+c.xScale(2), yScale(1.5), c.xScale, yScale);
    expect(hit?.color).toBe(c.theme.bar.default.fill);
  });
});
