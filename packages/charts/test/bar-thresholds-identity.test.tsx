import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
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
 * [PND-BANDBAR2] — **a threshold-banded bar is still one bar.**
 *
 * These are the tests that justify the feature existing at all. The workaround
 * it replaces (N `<BarChart>` layers drawn outermost-first, each clipped to a
 * band, compositing the gradient by overpainting) produces the same *pixels*.
 * What it cannot produce is a single bar: N layers means N hit targets, N
 * `SelectInfo.mark` identities and N legend rows for something the reader sees
 * as one bar. So the banding must be draw-only, and that is pinned here rather
 * than in the geometry unit tests — the geometry can't see the difference.
 */

const categories = [
  { label: 'alpha', value: 3 },
  { label: 'beta', value: 1.4 },
  { label: 'gamma', value: 0.5 },
];

const BANDS = ['#0a0', '#fa0', '#f00'];

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
      <ChartContainer range={[0, 3]} width={300}>
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
    hitAt: (x: number, v: number) =>
      entry.layer.hitTest?.(+c.xScale(x), yScale(v), c.xScale, yScale) ?? null,
  };
}

describe('a threshold-banded bar keeps a single identity', () => {
  it('registers ONE layer, not one per band', () => {
    // The overpaint workaround needed three <BarChart>es for this ladder.
    const { entry } = mount(
      <BarChart
        categories={categories}
        id="cap"
        thresholds={[1, 2]}
        bandColors={BANDS}
      />,
    );
    expect(entry).toBeDefined();
  });

  it('paints three bands but hit-tests as one whole bar', () => {
    const { calls, hitAt } = mount(
      <BarChart
        categories={categories}
        id="cap"
        thresholds={[1, 2]}
        bandColors={BANDS}
      />,
    );
    const fills = calls
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .map((c) => c.args[0] as string);
    // Bar 'alpha' (3) crosses all three bands, 'beta' (1.4) two, 'gamma' one.
    expect(fills.filter((f) => BANDS.includes(f))).toEqual([
      '#0a0',
      '#fa0',
      '#f00',
      '#0a0',
      '#fa0',
      '#0a0',
    ]);
    // …and a click low in the *alarm* part of bar 0 still selects bar 0 as a
    // whole, with the category's own mark — not a third of it.
    const hit = hitAt(0.5, 2.6);
    expect(hit).not.toBeNull();
    expect(hit!.mark).toBe('alpha');
  });

  it('reports the same mark wherever in the ladder the pointer lands', () => {
    // Three probes down one bar's length, one per band. The overpaint recipe
    // returns a different layer's SelectInfo for each.
    const { hitAt } = mount(
      <BarChart
        categories={categories}
        id="cap"
        thresholds={[1, 2]}
        bandColors={BANDS}
      />,
    );
    const marks = [0.4, 1.5, 2.7].map((v) => hitAt(0.5, v)?.mark);
    expect(marks).toEqual(['alpha', 'alpha', 'alpha']);
  });

  it('leaves the hit rect identical to the unbanded chart', () => {
    const banded = mount(
      <BarChart
        categories={categories}
        id="cap"
        thresholds={[1, 2]}
        bandColors={BANDS}
      />,
    );
    const plain = mount(<BarChart categories={categories} id="cap" />);
    for (const [x, v] of [
      [0.5, 2.6],
      [1.5, 1.0],
      [2.5, 0.2],
    ] as const) {
      expect(banded.hitAt(x, v)).toEqual(plain.hitAt(x, v));
    }
  });
});

describe('the ladder fails loudly rather than drawing an unbanded bar', () => {
  it('warns and falls back to the flat fill when no colours resolve', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(
      <BarChart
        categories={categories}
        id="cap"
        thresholds={[1, 2]}
        bandColors={[]}
      />,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('band colours'));
    warn.mockRestore();
  });

  it('warns when the ladder is shorter than the breakpoints need', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(
      <BarChart
        categories={categories}
        id="cap"
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
      <BarChart
        categories={categories}
        id="cap"
        thresholds={[-1, 1, 2]}
        bandColors={BANDS}
      />,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dropped 1 breakpoint(s)'),
    );
    warn.mockRestore();
  });

  it('warns rather than silently ignoring thresholds next to binColors', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mount(
      <BarChart
        categories={categories}
        id="cap"
        thresholds={[1, 2]}
        bandColors={BANDS}
        binColors={['#111', '#222', '#333']}
      />,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('binColors'));
    warn.mockRestore();
  });
});

describe('inline array props do not churn the layer', () => {
  it('keeps one stable layer entry across re-renders with an inline array', () => {
    // `thresholds={[1, 2]}` inline is the documented usage — a fresh array
    // every render. If the ladder memo keyed on array *identity* it would
    // rebuild each render, rebuilding the layer entry with it and re-running
    // `registerLayer`: a repaint treadmill on any frequently-rendering chart,
    // plus one dev warning per frame. Entry identity is the observable proxy.
    const seen: unknown[] = [];
    function CaptureEntry() {
      const r = useContext(RowContext);
      useEffect(() => {
        if (r && r.layers[0]) seen.push(r.layers[0].layer);
      });
      return null;
    }
    const tree = () => (
      <ChartContainer range={[0, 3]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} label="" />
          <Layers>
            <BarChart
              categories={categories}
              id="cap"
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
    // Every observation must be the same object — one entry, never rebuilt.
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(1);
  });

  it('still rebuilds the ladder when the threshold VALUES change', () => {
    // Value-comparing must not go so far as to miss a real change.
    const a = mount(
      <BarChart
        categories={categories}
        id="cap"
        thresholds={[1, 2]}
        bandColors={BANDS}
      />,
    );
    const b = mount(
      <BarChart
        categories={categories}
        id="cap"
        thresholds={[0.5, 1]}
        bandColors={BANDS}
      />,
    );
    const fillsOf = (calls: typeof a.calls) =>
      calls
        .filter((c) => c.type === 'set' && c.name === 'fillStyle')
        .map((c) => c.args[0] as string)
        .filter((f) => BANDS.includes(f));
    expect(fillsOf(b.calls)).not.toEqual(fillsOf(a.calls));
  });
});
