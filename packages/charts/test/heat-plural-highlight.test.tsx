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

/** Nine bins × two rows — wide enough that a narrowed viewport genuinely
 *  culls, which the three-bin grid above never does (the culling window
 *  carries a ±1-bin margin of its own). */
const WIDE = TimeSeries.fromColumns({
  name: 'wide',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'lo', kind: 'number' },
    { name: 'hi', kind: 'number' },
  ] as const,
  columns: {
    time: Array.from({ length: 9 }, (_, i) => i * 1000),
    lo: Array.from({ length: 9 }, (_, i) => i + 1),
    hi: Array.from({ length: 9 }, (_, i) => i + 10),
  },
});
const WIDE_BEGINS = stacksFromColumns(WIDE, ['lo', 'hi']).begin;

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
function mountHeat(
  containerProps: Record<string, unknown>,
  /** Replay domain — narrow it to push bins outside the culling window. */
  domain: readonly [number, number] = [0, 3000],
  series: TimeSeries<never> | typeof SERIES = SERIES,
) {
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
              series={series}
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
  const xScale = scaleLinear()
    .domain([domain[0], domain[1]])
    .range([0, 300]) as never;
  r.layers[0]!.layer.draw(ctx, xScale, r.yScales.get('a')!);
  return { calls };
}

/** The heat states off the default theme the mount uses, so a theme change
 *  moves the expectations with it rather than silently passing. */
const ST = defaultTheme.heat!.default;

/**
 * The **live cells, in draw order** — `'selected'` or `'hover'` per cell.
 *
 * A live cell no longer strokes its own rect. A hovered one draws a double
 * ring (two `strokeRect`s, counted once here via the outer colour) and a
 * selected one contributes its share of the region perimeter as one stroked
 * path, so what identifies a state is now the **colour**, not a line weight.
 */
function liveCells(calls: readonly CtxCall[]): string[] {
  const out: string[] = [];
  let ink: unknown;
  for (const c of calls) {
    if (c.type === 'set' && c.name === 'strokeStyle') ink = c.args[0];
    else if (c.name === 'strokeRect' && ink === ST.hoverRing[0])
      out.push('hover');
    else if (c.name === 'stroke' && ink === ST.perimeter) out.push('selected');
  }
  return out;
}

/** One `lineTo` per cell edge the perimeter actually draws — the measure of
 *  "one outline around the union" rather than one per cell. */
const edges = (calls: readonly CtxCall[]) =>
  calls.filter((c) => c.name === 'lineTo').length;

const SEL = 'selected';
const HOV = 'hover';

describe('<HeatMap> — the whole selection / hover set reaches the draw', () => {
  it('the two live inks differ, so the assertions below can tell them apart', () => {
    // Guards every `toEqual([SEL, HOV])` below from passing on a theme where
    // the two states are indistinguishable.
    expect(ST.perimeter).not.toBe(ST.hoverRing[0]);
    expect(liveCells(mountHeat({ selected: cell(0, 'lo') }).calls)).toEqual([
      SEL,
    ]);
    expect(liveCells(mountHeat({ hovered: cell(0, 'lo') }).calls)).toEqual([
      HOV,
    ]);
  });

  it('a selected BLOCK draws its union perimeter, not one outline per cell', () => {
    // The whole grid: 3 bins × 2 rows. Per cell that is 24 edges; the union's
    // perimeter is 2·3 + 2·2 = 10, and every one of the 14 suppressed edges
    // was interior to the selection and said nothing.
    const { calls } = mountHeat({
      selected: [
        cell(0, 'lo'),
        cell(1, 'lo'),
        cell(2, 'lo'),
        cell(0, 'hi'),
        cell(1, 'hi'),
        cell(2, 'hi'),
      ],
    });
    expect(liveCells(calls)).toEqual(Array(6).fill(SEL));
    expect(edges(calls)).toBe(10);
  });

  it('a selection running OFF-SCREEN grows no edge at the viewport boundary', () => {
    // Nine bins, all selected, with the viewport over the middle few. The
    // cells at the ends of the DRAWN window have selected neighbours just
    // outside it, so those vertical edges must stay suppressed — the outline
    // belongs to the region, not to the part of it that happens to be on
    // screen.
    //
    // This is what the one-column pad on the neighbour grid buys. Without it
    // an off-window neighbour reads as "not selected" and a pan drags a false
    // vertical rule down each side of the plot.
    const all = ['lo', 'hi'].flatMap((row) =>
      Array.from(WIDE_BEGINS).map((key) => ({
        id: 'temp',
        key,
        value: 0,
        color: '#abc',
        label: row,
      })),
    );
    // The container range must cover the whole grid — the layer narrows to
    // it before registering, and the culling under test is the REPLAY scale's.
    const { calls } = mountHeat(
      { selected: all, range: [-500, 8500] },
      [3500, 5500],
      WIDE,
    );
    const lit = liveCells(calls).length;
    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThan(all.length); // genuinely culled
    // Every drawn cell contributes exactly ONE edge — its top or its bottom.
    // Nothing vertical: neither the interior seams nor the window's own two
    // ends, which is the case the pad exists for.
    expect(edges(calls)).toBe(lit);
  });

  it('a boxed SPAN running off-screen keeps its sides off the viewport edge', () => {
    // The box is one outline for the whole span, so a span wider than the
    // viewport must drop the two sides that fall outside it and draw only
    // top and bottom — the same rule the leftover perimeter gets from its
    // padded neighbour grid, applied to a shape that has no neighbours.
    const span = {
      kind: 'span' as const,
      id: 'temp',
      x: [WIDE_BEGINS[0]!, WIDE_BEGINS[8]! + 1000] as [number, number],
    };
    const wide = mountHeat({ selected: [span] }, [3500, 5500], WIDE).calls;
    expect(edges(wide)).toBe(2); // top + bottom, no sides
    // …and the same span with the whole grid in view draws all four.
    const all = mountHeat({ selected: [span] }, [-500, 8500], WIDE).calls;
    expect(edges(all)).toBe(4);
  });

  it('two disconnected blocks get one outline each — no connectivity pass', () => {
    // Bins 0 and 2, both rows: two 1×2 columns with an unselected column
    // between them. 2·(2·1 + 2·2) = 12 edges — each block closed on all four
    // sides, which is what falls out of suppressing only SHARED edges.
    const { calls } = mountHeat({
      selected: [cell(0, 'lo'), cell(0, 'hi'), cell(2, 'lo'), cell(2, 'hi')],
    });
    expect(edges(calls)).toBe(12);
  });

  it('the unselected field recedes under a flat veil, not an alpha', () => {
    // Alpha and value are the same channel on a ramp — fading a cell slides
    // it along the scale. The veil is composited over the cell instead, so
    // the ramp's order survives inside the receded set.
    const { calls } = mountHeat({ selected: cell(0, 'lo') });
    const veils = calls.filter(
      (c, i) =>
        c.type === 'set' &&
        c.name === 'fillStyle' &&
        c.args[0] === ST.veil &&
        i >= 0,
    );
    expect(veils.length).toBeGreaterThan(0);
    // …and nothing recedes while the selection is empty.
    const rest = mountHeat({}).calls;
    expect(
      rest.some((c) => c.name === 'fillStyle' && c.args[0] === ST.veil),
    ).toBe(false);
  });

  it('outlines every member of a multi-cell `selected`', () => {
    const { calls } = mountHeat({
      selected: [cell(0, 'lo'), cell(2, 'hi')],
    });
    expect(liveCells(calls)).toEqual([SEL, SEL]);
  });

  it('outlines a three-cell selection — no cap at one', () => {
    const { calls } = mountHeat({
      selected: [cell(0, 'lo'), cell(1, 'hi'), cell(2, 'lo')],
    });
    expect(liveCells(calls)).toEqual([SEL, SEL, SEL]);
  });

  it('outlines both rows of one bin — a cell identity is bin AND row', () => {
    // The pair a click on a stripe pair produces, and the case a bin-keyed
    // narrowing would collapse to one.
    const { calls } = mountHeat({
      selected: [cell(1, 'lo'), cell(1, 'hi')],
    });
    expect(liveCells(calls)).toEqual([SEL, SEL]);
    // One bin, both rows: a 1-wide, 2-tall block — six edges, not eight.
    expect(edges(calls)).toBe(6);
  });

  it('still outlines exactly one for a single-mark selection (unchanged)', () => {
    // `selected` accepts a lone `SelectInfo` too, which is what every shipped
    // caller passes; widening the reader must not change what they see.
    const { calls } = mountHeat({ selected: cell(0, 'lo') });
    expect(liveCells(calls)).toEqual([SEL]);
  });

  it('the hover ring is a PAIR, one inside the other', () => {
    // A single ring cannot work against a ramp: a light one vanishes at the
    // pale end and a dark one at the dark end, and a cell can sit anywhere on
    // the scale. Two concentric rings guarantee one of them reads — so this
    // pins both colours AND that the second is inset by a full ring width,
    // which is what keeps them distinguishable rather than overdrawn.
    let ink: unknown;
    const drawn: Array<[unknown, number, number]> = [];
    for (const c of mountHeat({ hovered: cell(0, 'lo') }).calls) {
      if (c.type === 'set' && c.name === 'strokeStyle') ink = c.args[0];
      else if (c.name === 'strokeRect')
        drawn.push([ink, c.args[0] as number, c.args[1] as number]);
    }
    expect(drawn.map(([i]) => i)).toEqual([ST.hoverRing[0], ST.hoverRing[1]]);
    expect(drawn[1]![1] - drawn[0]![1]).toBeCloseTo(ST.ringWidth);
    expect(drawn[1]![2] - drawn[0]![2]).toBeCloseTo(ST.ringWidth);
  });

  it('outlines every member of a multi-cell `hovered`, at the hover weight', () => {
    const { calls } = mountHeat({
      hovered: [cell(0, 'hi'), cell(1, 'hi'), cell(2, 'hi')],
    });
    expect(liveCells(calls)).toEqual([HOV, HOV, HOV]);
  });

  it('outlines selection and hover together, selection winning the overlap', () => {
    const { calls } = mountHeat({
      selected: [cell(0, 'lo'), cell(1, 'lo')],
      hovered: [cell(1, 'lo'), cell(2, 'lo')],
    });
    // Three distinct live cells, not four strokes: the cell in both sets takes
    // the selected treatment only.
    expect(liveCells(calls)).toEqual([SEL, SEL, HOV]);
  });

  it('ignores set members naming another layer', () => {
    const { calls } = mountHeat({
      selected: [cell(0, 'lo', 'elsewhere'), cell(2, 'lo')],
      hovered: [cell(1, 'lo', 'elsewhere')],
    });
    expect(liveCells(calls)).toEqual([SEL]);
  });

  it('outlines nothing when both sets are empty', () => {
    expect(liveCells(mountHeat({}).calls)).toEqual([]);
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
