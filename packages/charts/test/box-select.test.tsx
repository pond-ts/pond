import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ValueSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BoxPlot } from '../src/BoxPlot.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
} from '../src/context.js';
import { resolveSelection } from '../src/select.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/** A range-only vol smile on a value (strike) axis: bid→ask per strike, no body. */
const smile = () =>
  ValueSeries.fromColumns({
    name: 'smile',
    schema: [
      { name: 'strike', kind: 'value' },
      { name: 'bid', kind: 'number' },
      { name: 'ask', kind: 'number' },
    ] as const,
    columns: {
      strike: [90, 100, 110],
      bid: [0.18, 0.15, 0.19],
      ask: [0.2, 0.17, 0.21],
    },
  });

describe('<BoxPlot id> — selection (#508 item 5)', () => {
  // Render helper that also mounts a context capture inside the row.
  function mount(props: { id?: string; onSelect?: (s: unknown) => void }) {
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
        <ChartContainer
          range={[90, 110]}
          width={400}
          showAxis={false}
          {...(props.onSelect ? { onSelect: props.onSelect } : {})}
        >
          <ChartRow height={200}>
            <YAxis id="iv" min={0.1} max={0.25} />
            <Layers>
              <BoxPlot
                series={smile()}
                lower="bid"
                upper="ask"
                as="iv"
                axis="iv"
                {...(props.id !== undefined ? { id: props.id } : {})}
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

  it('wires a hitTest only when `id` is given', () => {
    const withId = mount({ id: 'smile' });
    const boxLayer = withId.row().layers.find((l) => l.layer.hitTest);
    expect(boxLayer).toBeDefined();

    const noId = mount({});
    expect(noId.row().layers.find((l) => l.layer.hitTest)).toBeUndefined();
  });

  it('a click inside a box resolves to its SelectInfo (id + key + label)', () => {
    const { container, row } = mount({ id: 'smile' });
    const c = container();
    const r = row();
    const yScale = r.yScales.get('iv')!;
    // The 100-strike box: x at strike 100 (centre of the [90,110] range), y at
    // the midpoint of its bid/ask (0.15–0.17).
    const px = +c.xScale(100);
    const py = yScale((0.15 + 0.17) / 2);
    const hit = resolveSelection(r.layers, px, py, c.xScale, (axisId) =>
      r.yScales.get(axisId ?? r.defaultAxisId),
    );
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe('smile');
    expect(hit!.label).toBe('iv'); // the `as` role
    // value = the box's `upper` (the 100-strike ask) — proves the right box.
    expect(hit!.value).toBeCloseTo(0.17, 6);
    // key = the box's `x` (its neighbour-span begin, 95 — between the 90 and
    // 100 strikes) — provenance, mirroring `barAt`'s `begin`.
    expect(hit!.key).toBeCloseTo(95, 6);
  });

  it('a click in empty space resolves to null (deselect)', () => {
    const { container, row } = mount({ id: 'smile' });
    const c = container();
    const r = row();
    const yScale = r.yScales.get('iv')!;
    // Well above every ask (0.24 is above the 0.1–0.25 data band's marks).
    const hit = resolveSelection(
      r.layers,
      +c.xScale(100),
      yScale(0.245),
      c.xScale,
      (axisId) => r.yScales.get(axisId ?? r.defaultAxisId),
    );
    expect(hit).toBeNull();
  });

  it('dev-warns when onSelect is wired but the box has no id; not when it does', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mount({ onSelect: () => {} });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/no layer has an `id`/);
      warn.mockClear();
      mount({ onSelect: () => {}, id: 'smile' });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
