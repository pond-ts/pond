import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { HeatMap } from '../src/HeatMap.js';
import { YAxis } from '../src/YAxis.js';
import { RowContext, type RowFrame, type SelectInfo } from '../src/context.js';
import { defaultTheme } from '../src/theme.js';
import { stacksFromColumns } from '../src/data.js';
import { scaleLinear } from 'd3-scale';
import { recordingContext, stubCanvasContext } from './canvas-mock.js';
import type { CtxCall } from './canvas-mock.js';

afterEach(cleanup);

/**
 * **The container's `selected` / `hovered` sets reach the cells, whole.**
 *
 * `ContainerFrame.selected` became `readonly SelectInfo[]` in #606 and
 * `hovered` in #616. `<HeatMap>` mapped *both* into memoized plural arrays —
 * which is exactly what made it read as already-fixed — and then handed
 * `drawHeat` `selection[0] ?? null` / `hover[0] ?? null`. A consumer pinning
 * three cells got one outline, with no warning and no error.
 *
 * `drawHeat` itself is unit-tested in `heat.test.ts`. **These tests exist
 * because that wasn't enough**: the same defect in `<ScatterChart>` /
 * `<BoxPlot>` (#619) survived three reviews because everyone verified the
 * plural memo and nobody checked the call site, and a green
 * `drawHeat(ss, …, [a, b, c], …)` says nothing about what the component hands
 * it. This file drives the real component and reads the ops its registered
 * layer emits, so the **wiring** is what's under test.
 */

/** Three bins × two rows on a 1s grid. */
const SERIES = TimeSeries.fromColumns({
  name: 'grid',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'lo', kind: 'number' },
    { name: 'hi', kind: 'number' },
  ] as const,
  columns: {
    time: [0, 1000, 2000],
    lo: [1, 2, 3],
    hi: [4, 5, 6],
  },
});

/**
 * The cell keys, which are the **bin begins**. On a point-keyed series those are
 * neighbour-spaced edges (`t − halfGap`), *not* the sample times — the same trap
 * `<BoxPlot>`'s `Selectable` story documents — so they come from the very reader
 * the layer uses rather than being assumed.
 */
const BEGINS = stacksFromColumns(SERIES, ['lo', 'hi']).begin;

const RAMP = ['#111', '#555', '#999', '#ddd'];

/** A `SelectInfo` naming the cell in bin `b`, row `label`. */
const cell = (b: number, label: 'lo' | 'hi', id = 'temp'): SelectInfo => ({
  id,
  key: BEGINS[b]!,
  value: 0,
  color: '#abc',
  label,
});

/**
 * Mount a `<HeatMap>` under `containerProps`, then replay its registered draw
 * against a recording context — the same call the row's canvas makes, so what
 * is asserted is what would be painted.
 */
function mountHeat(containerProps: Record<string, unknown>) {
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
      <ChartContainer range={[0, 3000]} width={300} {...containerProps}>
        <ChartRow height={100}>
          <YAxis id="a" />
          <Layers>
            <HeatMap
              series={SERIES}
              columns={['lo', 'hi']}
              colors={RAMP}
              id="temp"
              // Off explicitly: a reduced grid suppresses every outline by
              // design, which is its own test below — these must read the
              // undecimated path.
              decimate={false}
            />
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  const r = rf!;
  const { ctx, calls } = recordingContext();
  const xScale = scaleLinear().domain([0, 3000]).range([0, 300]) as never;
  r.layers[0]!.layer.draw(ctx, xScale, r.yScales.get('a')!);
  return { calls };
}

/**
 * The `lineWidth` in effect at each `strokeRect`. A heat cell only strokes when
 * it is live, so this is one entry per lit cell — the hover weight is the
 * theme's `outlineWidth`, selection twice it, which is how the two states are
 * told apart without a second theme token (#577).
 */
function outlineWidths(calls: readonly CtxCall[]): number[] {
  const out: number[] = [];
  let w: unknown;
  for (const c of calls) {
    if (c.type === 'set' && c.name === 'lineWidth') w = c.args[0];
    else if (c.name === 'strokeRect') out.push(w as number);
  }
  return out;
}

/** The two live weights, off the default theme the mount uses — `outlineWidth`
 *  for hover, twice it for selection. Read from the theme rather than hard-coded
 *  so a theme change moves the expectations with it. */
const HOVER_W = defaultTheme.bar.default.outlineWidth;
const SELECTED_W = HOVER_W * 2;

describe('<HeatMap> — the whole selection / hover set reaches the draw', () => {
  it('the two live weights differ, so the assertions below can tell them apart', () => {
    // Guards every `toEqual([SELECTED_W, HOVER_W])` below from passing on a
    // theme where the two states are indistinguishable.
    expect(SELECTED_W).not.toBe(HOVER_W);
    expect(outlineWidths(mountHeat({ selected: cell(0, 'lo') }).calls)).toEqual(
      [SELECTED_W],
    );
    expect(outlineWidths(mountHeat({ hovered: cell(0, 'lo') }).calls)).toEqual([
      HOVER_W,
    ]);
  });

  it('outlines every member of a multi-cell `selected`', () => {
    const { calls } = mountHeat({
      selected: [cell(0, 'lo'), cell(2, 'hi')],
    });
    expect(outlineWidths(calls)).toEqual([SELECTED_W, SELECTED_W]);
  });

  it('outlines a three-cell selection — no cap at one', () => {
    const { calls } = mountHeat({
      selected: [cell(0, 'lo'), cell(1, 'hi'), cell(2, 'lo')],
    });
    expect(outlineWidths(calls)).toEqual([SELECTED_W, SELECTED_W, SELECTED_W]);
  });

  it('outlines both rows of one bin — a cell identity is bin AND row', () => {
    // The pair a click on a stripe pair produces, and the case a bin-keyed
    // narrowing would collapse to one.
    const { calls } = mountHeat({
      selected: [cell(1, 'lo'), cell(1, 'hi')],
    });
    expect(outlineWidths(calls)).toEqual([SELECTED_W, SELECTED_W]);
  });

  it('still outlines exactly one for a single-mark selection (unchanged)', () => {
    // `selected` accepts a lone `SelectInfo` too, which is what every shipped
    // caller passes; widening the reader must not change what they see.
    const { calls } = mountHeat({ selected: cell(0, 'lo') });
    expect(outlineWidths(calls)).toEqual([SELECTED_W]);
  });

  it('outlines every member of a multi-cell `hovered`, at the hover weight', () => {
    const { calls } = mountHeat({
      hovered: [cell(0, 'hi'), cell(1, 'hi'), cell(2, 'hi')],
    });
    expect(outlineWidths(calls)).toEqual([HOVER_W, HOVER_W, HOVER_W]);
  });

  it('outlines selection and hover together, selection winning the overlap', () => {
    const { calls } = mountHeat({
      selected: [cell(0, 'lo'), cell(1, 'lo')],
      hovered: [cell(1, 'lo'), cell(2, 'lo')],
    });
    // Three distinct live cells, not four strokes: the cell in both sets takes
    // its selected weight only.
    expect(outlineWidths(calls)).toEqual([SELECTED_W, SELECTED_W, HOVER_W]);
  });

  it('ignores set members naming another layer', () => {
    const { calls } = mountHeat({
      selected: [cell(0, 'lo', 'elsewhere'), cell(2, 'lo')],
      hovered: [cell(1, 'lo', 'elsewhere')],
    });
    expect(outlineWidths(calls)).toEqual([SELECTED_W]);
  });

  it('outlines nothing when both sets are empty', () => {
    expect(outlineWidths(mountHeat({}).calls)).toEqual([]);
  });

  it('outlines nothing while decimated, however many cells are pinned', () => {
    // The suppression `<HeatMap decimate>` documents, under a *set*: an
    // aggregated column has no per-cell identity to match and a sub-pixel ring
    // would not be visible, so a plural pin must be dropped whole rather than
    // partially honoured. (`decimate` defaults to `true`; the 300px-wide plot
    // is fed a grid far denser than the gate.)
    let rf: RowFrame | null = null;
    function Capture() {
      const r = useContext(RowContext);
      useEffect(() => {
        if (r) rf = r;
      });
      return null;
    }
    const N = 4000;
    const dense = TimeSeries.fromColumns({
      name: 'dense',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'lo', kind: 'number' },
        { name: 'hi', kind: 'number' },
      ] as const,
      columns: {
        time: Array.from({ length: N }, (_, i) => i * 1000),
        lo: Array.from({ length: N }, (_, i) => i % 7),
        hi: Array.from({ length: N }, (_, i) => i % 5),
      },
    });
    const begins = dense.keyColumn().begin;
    const pinned = [0, 1, 2, 3].map((b) => ({
      id: 'temp',
      key: begins[b]!,
      value: 0,
      color: '#abc',
      label: 'lo',
    }));
    const stub = stubCanvasContext();
    try {
      render(
        <ChartContainer
          range={[0, N * 1000]}
          width={300}
          selected={pinned}
          hovered={pinned}
        >
          <ChartRow height={100}>
            <YAxis id="a" />
            <Layers>
              <HeatMap
                series={dense}
                columns={['lo', 'hi']}
                colors={RAMP}
                id="temp"
              />
              <Capture />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    const { ctx, calls } = recordingContext();
    // A backing-buffer width is what makes the density gate engage — it reads
    // `ctx.canvas.width`.
    (ctx as unknown as { canvas: { width: number } }).canvas = { width: 600 };
    const xScale = scaleLinear()
      .domain([0, N * 1000])
      .range([0, 300]) as never;
    rf!.layers[0]!.layer.draw(ctx, xScale, rf!.yScales.get('a')!);
    // Decimation ran (far fewer rects than source cells) and not one outline
    // got through.
    expect(calls.filter((c) => c.name === 'fillRect').length).toBeLessThan(
      N * 2,
    );
    expect(calls.filter((c) => c.name === 'strokeRect')).toHaveLength(0);
  });
});
