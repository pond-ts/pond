import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { HeatMap } from '../src/HeatMap.js';
import { XAxis } from '../src/XAxis.js';
import { YAxis } from '../src/YAxis.js';
import { RowContext, type RowFrame } from '../src/context.js';
import { recordingContext, stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * [PND-HEATMAP] — **`<HeatMap>`'s array props are compared by value.**
 *
 * `columns`, `colors` and `domain` are all arrays, and every natural way to
 * write them produces a fresh one per render: a JSX literal, a `.map()` over
 * the row names, or a theme hook like the docs site's `useSequentialRamp()`.
 * Keyed by identity each of those rebuilds the layer entry every render, hence
 * a `registerLayer` every render — a repaint treadmill, and on a chart that
 * re-renders from its own tracker state, an infinite update loop. `<BarChart
 * thresholds>` already learned this ([PND-BANDBAR2]); these pin the same
 * guarantee for the heat map, including the other half of it — that
 * value-comparing doesn't go so far as to miss a real change.
 */

const SERIES = TimeSeries.fromColumns({
  name: 'grid',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'a', kind: 'number' },
    { name: 'b', kind: 'number' },
  ] as const,
  columns: {
    time: [0, 1000, 2000],
    a: [1, 2, 3],
    b: [4, 5, 6],
  },
});

const RAMP = ['#111', '#555', '#999', '#ddd'];

/** Mount and draw once, returning the recorded canvas calls. */
function mount(node: React.ReactNode) {
  let rf: RowFrame | null = null;
  function Capture() {
    const r = useContext(RowContext);
    useEffect(() => {
      if (r) rf = r;
    });
    return null;
  }
  const stub = stubCanvasContext();
  try {
    render(
      <ChartContainer range={[0, 3000]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" />
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
  const r = rf!;
  const yScale = r.yScales.get('a')!;
  const entry = r.layers[0]!;
  const { ctx, calls } = recordingContext();
  // The x scale is only needed to place cells; the fills are what we compare.
  const xScale = ((x: number) => (x / 3000) * 300) as never;
  entry.layer.draw(ctx, xScale, yScale);
  return {
    entry,
    fills: calls
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .map((c) => c.args[0] as string),
  };
}

/**
 * Render five times and collect the layer object seen each time. `tree` is
 * handed the capture element so it can be mounted **inside** `<Layers>` — the
 * only place `RowContext` exists.
 */
function entriesAcrossRerenders(
  tree: (capture: React.ReactNode) => React.ReactElement,
): unknown[] {
  const seen: unknown[] = [];
  function CaptureEntry() {
    const r = useContext(RowContext);
    useEffect(() => {
      if (r && r.layers[0]) seen.push(r.layers[0].layer);
    });
    return null;
  }
  const stub = stubCanvasContext();
  try {
    const { rerender } = render(tree(<CaptureEntry />));
    for (let i = 0; i < 4; i += 1) rerender(tree(<CaptureEntry />));
  } finally {
    stub.restore();
  }
  return seen;
}

describe('inline array props do not churn the heat-map layer', () => {
  const treeWith = (capture: React.ReactNode) => (
    <ChartContainer range={[0, 3000]} width={300}>
      <ChartRow height={100}>
        <YAxis id="a" />
        <Layers>
          {/* Every one of these is a fresh array per render — deliberately. */}
          <HeatMap
            series={SERIES}
            columns={['a', 'b']}
            colors={['#111', '#555', '#999', '#ddd']}
            domain={[0, 6]}
            id="h"
          />
          {capture}
        </Layers>
      </ChartRow>
      <XAxis />
    </ChartContainer>
  );

  it('keeps one stable layer entry across re-renders', () => {
    const seen = entriesAcrossRerenders(treeWith);
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(1);
  });

  it('is stable with columns built by a fresh .map() each render', () => {
    const names = ['a', 'b'];
    const tree = (capture: React.ReactNode) => (
      <ChartContainer range={[0, 3000]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" />
          <Layers>
            <HeatMap
              series={SERIES}
              columns={names.map((n) => n)}
              colors={RAMP}
              id="h"
            />
            {capture}
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>
    );
    const seen = entriesAcrossRerenders(tree);
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(1);
  });
});

describe('value-comparing still notices a real change', () => {
  it('repaints in the new ramp when the colour VALUES change', () => {
    const dark = mount(
      <HeatMap series={SERIES} columns={['a', 'b']} colors={RAMP} id="h" />,
    );
    const other = mount(
      <HeatMap
        series={SERIES}
        columns={['a', 'b']}
        colors={['#f00', '#0f0', '#00f', '#ff0']}
        id="h"
      />,
    );
    expect(other.fills).not.toEqual(dark.fills);
    expect(dark.fills.some((f) => RAMP.includes(f))).toBe(true);
  });

  it('rebands when the domain VALUES change', () => {
    // The same cells against a wider domain fall into lower bands.
    const tight = mount(
      <HeatMap
        series={SERIES}
        columns={['a', 'b']}
        colors={RAMP}
        domain={[1, 6]}
        id="h"
      />,
    );
    const wide = mount(
      <HeatMap
        series={SERIES}
        columns={['a', 'b']}
        colors={RAMP}
        domain={[0, 60]}
        id="h"
      />,
    );
    expect(wide.fills).not.toEqual(tight.fills);
    // Everything is in the bottom band of a 10x-too-wide domain.
    expect(new Set(wide.fills.filter((f) => RAMP.includes(f)))).toEqual(
      new Set(['#111']),
    );
  });

  it('redraws with the new rows when the column VALUES change', () => {
    const both = mount(
      <HeatMap series={SERIES} columns={['a', 'b']} colors={RAMP} id="h" />,
    );
    const justA = mount(
      <HeatMap series={SERIES} columns={['a']} colors={RAMP} id="h" />,
    );
    expect(justA.fills.length).toBeLessThan(both.fills.length);
  });

  it('does not key ["a,b"] the same as ["a", "b"]', () => {
    // Both join to "a,b" under a comma joiner, so a comma-keyed memo would call
    // a one-row grid and a two-row grid the same entry and keep drawing the
    // stale one. Only a re-render of the SAME instance can catch that — a fresh
    // mount rebuilds the memo regardless — so this swaps the prop in place and
    // reads the row count off `yExtent`, which is `[0, rows]`.
    const commas = TimeSeries.fromColumns({
      name: 'commas',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'a,b', kind: 'number' },
        { name: 'a', kind: 'number' },
        { name: 'b', kind: 'number' },
      ] as const,
      columns: {
        time: [0, 1000, 2000],
        'a,b': [1, 2, 3],
        a: [4, 5, 6],
        b: [7, 8, 9],
      },
    });
    let rf: RowFrame | null = null;
    function Capture() {
      const r = useContext(RowContext);
      useEffect(() => {
        if (r) rf = r;
      });
      return null;
    }
    const tree = (cols: readonly string[]) => (
      <ChartContainer range={[0, 3000]} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" />
          <Layers>
            <HeatMap series={commas} columns={cols} colors={RAMP} id="h" />
            <Capture />
          </Layers>
        </ChartRow>
        <XAxis />
      </ChartContainer>
    );
    const rows = () => rf!.layers[0]!.layer.yExtent()![1];
    const stub = stubCanvasContext();
    try {
      const { rerender } = render(tree(['a,b']));
      expect(rows()).toBe(1);
      rerender(tree(['a', 'b']));
      expect(rows()).toBe(2);
      rerender(tree(['a,b']));
      expect(rows()).toBe(1);
    } finally {
      stub.restore();
    }
  });
});
