import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { AreaChart } from '../src/AreaChart.js';
import { XAxis } from '../src/XAxis.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
} from '../src/context.js';
import { recordingContext, stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * [PND-BANDAREA] — **a threshold-banded area is still one area.** The bar
 * suite's identity tests, transposed: banding must be draw-only (one layer,
 * one hit region, one readout identity), the ladder must resolve through the
 * same shared contract (`useBandLadder`, warnings included), and the inline
 * `thresholds={[1, 2]}` shape must not churn the layer registration.
 */

const BANDS = ['#0a0', '#fa0', '#f00'];

const series = () =>
  new TimeSeries({
    name: 'load',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 0.5],
      [1000, 2.5],
      [2000, 1.2],
      [3000, 3.0],
    ],
  });

function mount(node: React.ReactNode) {
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
      <ChartContainer range={[0, 3000]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} label="" />
          <Layers>
            {node}
            <Capture />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  const c = cf!;
  const r = rf!;
  const yScale = r.yScales.get('a')!;
  const entry = r.layers[0]!;
  const { ctx, calls } = recordingContext();
  entry.layer.draw(ctx, c.xScale, yScale);
  return {
    entry,
    calls,
    layerCount: r.layers.length,
    hitAt: (t: number, v: number) =>
      entry.layer.hitTest?.(+c.xScale(t), yScale(v), c.xScale, yScale) ?? null,
  };
}

describe('a threshold-banded area keeps a single identity', () => {
  it('registers ONE layer, not one per band', () => {
    const { layerCount } = mount(
      <AreaChart
        series={series()}
        column="v"
        id="load"
        thresholds={[1, 2]}
        bandColors={BANDS}
      />,
    );
    expect(layerCount).toBe(1);
  });

  it('hit-tests as one whole area, wherever in the ladder the pointer lands', () => {
    const { hitAt } = mount(
      <AreaChart
        series={series()}
        column="v"
        id="load"
        thresholds={[1, 2]}
        bandColors={BANDS}
      />,
    );
    // Three probes down one x, one per band: same series-scoped identity.
    const marks = [0.4, 1.5, 2.4].map((v) => hitAt(3000, v)?.mark);
    expect(marks).toEqual(['v', 'v', 'v']);
  });

  it('leaves the hit region identical to the unbanded chart', () => {
    const banded = mount(
      <AreaChart
        series={series()}
        column="v"
        id="load"
        thresholds={[1, 2]}
        bandColors={BANDS}
      />,
    );
    const plain = mount(<AreaChart series={series()} column="v" id="load" />);
    for (const [t, v] of [
      [1000, 2.0],
      [2000, 0.4],
      [2000, 3.9], // above the trace — outside both
    ] as const) {
      expect(banded.hitAt(t, v)).toEqual(plain.hitAt(t, v));
    }
  });

  it('strokes the outline with the banded fill, not the role colour', () => {
    // The observable that banding reached the draw: fill and outline share
    // one gradient object (the mock records the assignment).
    const { calls } = mount(
      <AreaChart
        series={series()}
        column="v"
        id="load"
        thresholds={[1, 2]}
        bandColors={BANDS}
      />,
    );
    const sets = (name: string) =>
      calls.filter((c) => c.type === 'set' && c.name === name);
    const lastFill = sets('fillStyle').at(-1)!.args[0];
    const lastStroke = sets('strokeStyle').at(-1)!.args[0];
    expect(lastStroke).toBe(lastFill);
    expect(typeof lastStroke).not.toBe('string');
  });

  it('resolves the ladder from the theme role when bandColors is omitted', () => {
    // `defaultTheme.area.default.bands` is the design-system path — the exact
    // `<AreaChart thresholds={[1, 2]} />` call from the docs must band out of
    // the box, which is the reason the default theme carries an area ladder.
    const { calls } = mount(
      <AreaChart series={series()} column="v" id="load" thresholds={[1, 2]} />,
    );
    const lastFill = calls
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .at(-1)!.args[0];
    const lastStroke = calls
      .filter((c) => c.type === 'set' && c.name === 'strokeStyle')
      .at(-1)!.args[0];
    expect(lastStroke).toBe(lastFill);
    expect(typeof lastStroke).not.toBe('string');
  });
});

describe('the ladder fails loudly rather than drawing an unbanded area', () => {
  it('warns and falls back to the flat fill when no colours resolve', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(
      <AreaChart
        series={series()}
        column="v"
        id="load"
        thresholds={[1, 2]}
        bandColors={[]}
      />,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('<AreaChart thresholds>'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('band colours'));
    warn.mockRestore();
  });

  it('warns when the ladder is shorter than the breakpoints need', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(
      <AreaChart
        series={series()}
        column="v"
        id="load"
        thresholds={[1, 2]}
        bandColors={['#0a0']}
      />,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('only 1 were supplied'),
    );
    warn.mockRestore();
  });

  it('warns when a breakpoint is dropped rather than banding on a subset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(
      <AreaChart
        series={series()}
        column="v"
        id="load"
        thresholds={[-1, 1, 2]}
        bandColors={BANDS}
      />,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped 1 breakpoint(s)'),
    );
    warn.mockRestore();
  });

  it('warns when no breakpoint is usable and keeps the flat path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls } = mount(
      <AreaChart
        series={series()}
        column="v"
        id="load"
        thresholds={[-1, 0]}
        bandColors={BANDS}
      />,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no usable breakpoints'),
    );
    // Unbanded: the outline keeps the role's line colour (a string).
    const lastStroke = calls
      .filter((c) => c.type === 'set' && c.name === 'strokeStyle')
      .at(-1)!.args[0];
    expect(typeof lastStroke).toBe('string');
    warn.mockRestore();
  });
});

describe('inline array props do not churn the layer', () => {
  it('keeps one stable layer entry across re-renders with an inline array', () => {
    const seen: unknown[] = [];
    function CaptureEntry() {
      const r = useContext(RowContext);
      useEffect(() => {
        if (r && r.layers[0]) seen.push(r.layers[0].layer);
      });
      return null;
    }
    const s = series();
    const tree = () => (
      <ChartContainer range={[0, 3000]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} label="" />
          <Layers>
            <AreaChart
              series={s}
              column="v"
              id="load"
              thresholds={[1, 2]}
              bandColors={['#0a0', '#fa0', '#f00']}
            />
            <CaptureEntry />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>
    );
    const stub = stubCanvasContext();
    try {
      const { rerender } = render(tree());
      for (let i = 0; i < 4; i += 1) rerender(tree());
    } finally {
      stub.restore();
    }
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(1);
  });
});
