import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
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
import { defaultTheme, type ChartTheme } from '../src/theme.js';
import type { SelectInfo } from '../src/context.js';

afterEach(cleanup);

/**
 * [PND-BARSEM] — **capabilities follow the drawn mark, not the input prop.**
 *
 * A one-column vertical histogram draws exactly the mark a `series`+`column`
 * chart draws, but it used to route through the stacked path purely because
 * `bins` fed it — and so lost whole-slot hit-testing, the hover colour, the
 * cursor readout and per-bar decimation. These tests pin the normalization:
 * one segment + vertical ⇒ the single-series path, whatever produced it.
 */

const bins = [
  { start: 0, end: 10, seconds: 4 },
  { start: 10, end: 20, seconds: 9 },
  { start: 20, end: 30, seconds: 2 },
];

const wide = new TimeSeries({
  name: 'w',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'a', kind: 'number' },
    { name: 'b', kind: 'number' },
  ] as const,
  rows: [
    [0, 3, 1],
    [1, 5, 2],
  ] as Array<[number, number, number]>,
});

/** Mount a chart and hand back its registered layer + the row's scales. */
function mount(node: React.ReactNode, range: [number, number] = [0, 30]) {
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
      <ChartContainer range={range} width={300}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
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
  const entry = r.layers[0]!.layer;
  return {
    layer: entry,
    hitAt: (x: number, v: number) =>
      entry.hitTest?.(+c.xScale(x), yScale(v), c.xScale, yScale) ?? null,
    sampleAt: (x: number) => entry.sampleAt?.(x) ?? [],
  };
}

/**
 * Mount with a theme + a hovered mark, run **one** draw pass, and return every
 * `fillStyle` the layer set — the only way to observe `BarStyle.hover`, which
 * lives inside `drawBars` rather than on any prop.
 */
function fillsWithHover(
  node: React.ReactNode,
  theme: ChartTheme,
  hovered: SelectInfo,
): string[] {
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
        range={[0, 30]}
        width={300}
        theme={theme}
        hovered={hovered}
      >
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={10} />
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
  const { ctx, calls } = recordingContext();
  rf!.layers[0]!.layer.draw(ctx, cf!.xScale, rf!.yScales.get('a')!);
  return calls
    .filter((c) => c.type === 'set' && c.name === 'fillStyle')
    .map((c) => String(c.args[0]));
}

describe('[PND-BARSEM] one-column vertical bins take the single-series path', () => {
  it('hit-tests the whole slot — including above a short bar', () => {
    const { hitAt } = mount(
      <BarChart bins={bins} column="seconds" axis="a" id="h" />,
    );
    // Bin 2 (value 2) is short; a point high above it is still inside the
    // slot, which is exactly what the stacked path used to miss (#584's
    // whole-slot rule reached only the direct-series path).
    const hit = hitAt(25, 9);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe('h');
    // …and a point inside the drawn bar hits the same bin.
    expect(hitAt(25, 1)!.key).toBe(hit!.key);
  });

  it('reads out under the cursor (the stacked path had no sampleAt value)', () => {
    const { sampleAt } = mount(
      <BarChart bins={bins} column="seconds" axis="a" id="h" />,
    );
    const samples = sampleAt(15);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]!.value).toBe(9); // the bin the cursor is over
  });

  it('paints the theme hover colour, which StackStyle has no channel for', () => {
    // `BarStyle.hover` is read by `drawBars` only — the whole reason its doc
    // needed a scope warning. Drive one draw with this bin hovered and read
    // back the fill actually used.
    const hoverTheme: ChartTheme = {
      ...defaultTheme,
      bar: {
        ...defaultTheme.bar,
        default: { ...defaultTheme.bar.default, hover: '#ff00ff' },
      },
    };
    const fills = fillsWithHover(
      <BarChart bins={bins} column="seconds" axis="a" id="h" />,
      hoverTheme,
      { id: 'h', key: 10, value: 9, color: '#000', label: 'h' },
    );
    expect(fills).toContain('#ff00ff');
  });

  it('a one-entry `columns` normalizes the same way', () => {
    const { layer, sampleAt } = mount(
      <BarChart series={wide} columns={['a']} axis="a" id="w" />,
      [0, 2],
    );
    expect(layer.hitTest).toBeDefined();
    expect(sampleAt(0).length).toBeGreaterThan(0);
  });
});

describe('[PND-BARSEM] genuinely multi-segment shapes stay stacked', () => {
  it('two bin columns keep the stacked path', () => {
    const twoCol = bins.map((b) => ({ ...b, other: 1 }));
    const { sampleAt } = mount(
      <BarChart bins={twoCol} columns={['seconds', 'other']} axis="a" id="h" />,
    );
    // The stacked path's readout is the (empty) fan-in, not a bar value —
    // the marker that this did NOT take the single path.
    expect(sampleAt(15)).toHaveLength(0);
  });

  it('a two-column wide series keeps the stacked path', () => {
    const { sampleAt } = mount(
      <BarChart series={wide} columns={['a', 'b']} axis="a" id="w" />,
      [0, 2],
    );
    expect(sampleAt(0)).toHaveLength(0);
  });
});

describe('[PND-BARSEM] the reroute preserves the channels it inherited', () => {
  // Both regressions below were found in review of #593: the normalized path
  // must keep the styling and identity a one-group stack already had.

  it('still honours `colors` — the stacked channel a one-column shape used', () => {
    const fills = fillsWithHover(
      <BarChart
        bins={bins}
        column="seconds"
        axis="a"
        id="h"
        colors={{ seconds: '#0000ff' }}
      />,
      defaultTheme,
      { id: 'none', key: -1, value: 0, color: '#000', label: 'x' },
    );
    expect(fills).toContain('#0000ff');
  });

  it('still honours a `theme.bar[<column>]` role', () => {
    const roleTheme: ChartTheme = {
      ...defaultTheme,
      bar: {
        ...defaultTheme.bar,
        seconds: { ...defaultTheme.bar.default, fill: '#00aa00' },
      },
    };
    const fills = fillsWithHover(
      <BarChart bins={bins} column="seconds" axis="a" id="h" />,
      roleTheme,
      { id: 'none', key: -1, value: 0, color: '#000', label: 'x' },
    );
    expect(fills).toContain('#00aa00');
  });

  it('`columns={[c]}` and `column=c` report the same selection label', () => {
    const one = mount(
      <BarChart series={wide} columns={['a']} axis="a" id="w" />,
      [0, 2],
    );
    const direct = mount(
      <BarChart series={wide} column="a" axis="a" id="w" />,
      [0, 2],
    );
    const hitOne = one.hitAt(0, 1);
    const hitDirect = direct.hitAt(0, 1);
    expect(hitOne).not.toBeNull();
    expect(hitOne!.label).toBe(hitDirect!.label);
  });

  it('horizontal one-column bins keep the transposed stacked path', () => {
    // The other half of the dispatch condition, previously untested: the
    // transposed geometry needs the stacked draw, so orientation gates it.
    const { sampleAt } = mount(
      <BarChart
        bins={bins}
        column="seconds"
        axis="a"
        id="h"
        orientation="horizontal"
      />,
    );
    expect(sampleAt(15)).toHaveLength(0);
  });
});
