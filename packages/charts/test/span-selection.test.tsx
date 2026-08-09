import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries, ValueSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { ScatterChart } from '../src/ScatterChart.js';
import { BoxPlot } from '../src/BoxPlot.js';
import { defaultTheme } from '../src/theme.js';
import { HeatMap } from '../src/HeatMap.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
  type SelectInfo,
  type SpanSelection,
} from '../src/context.js';
import { barsFromTimeSeries, stacksFromColumns } from '../src/data.js';
import { scaleLinear } from 'd3-scale';
import {
  arcsFilled,
  recordingContext,
  stubCanvasContext,
} from './canvas-mock.js';
import type { CtxCall } from './canvas-mock.js';

afterEach(cleanup);

/**
 * **Span selections reach the canvas through the real components** (interaction
 * RFC A5.2/A5.5): a `SpanSelection` passed through the controlled `selected`
 * prop must light exactly the marks its half-open extent covers, in every
 * layer that tests selection — and a plain `SelectInfo` / `SelectInfo[]` must
 * keep meaning exactly what it did.
 *
 * The predicates are unit-tested in `span.test.ts`; **these tests exist
 * because that is not enough**. Twice this wave a defect sat in the component
 * wiring above a green pure function (RFC A6.5 — `selected.slice(0, 1)` in
 * `<ScatterChart>`, `selection[0]` in `<HeatMap>`), so this file drives
 * `<ChartContainer selected>` end-to-end — the normalization split, the
 * per-layer narrowing, and the draw — and reads the ops off the canvas.
 */

/** Mount `children` in a container/row and return the captured frames + ops. */
function mountRow(
  containerProps: Record<string, unknown>,
  children: React.ReactNode,
  yAxis: React.ReactNode = <YAxis id="a" min={0} max={10} label="" />,
) {
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
      <ChartContainer width={400} {...containerProps}>
        <ChartRow height={200}>
          {yAxis}
          <Layers>
            {children}
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  // Replay the registered layer's draw against a recording context — the same
  // call the row's canvas makes, so what's asserted is what would be painted.
  const { ctx, calls } = recordingContext();
  rf!.layers[0]!.layer.draw(ctx, cf!.xScale, rf!.yScales.get('a')!);
  return { calls, frame: cf! };
}

const count = (calls: readonly CtxCall[], name: string) =>
  calls.filter((c) => c.name === name).length;

// ─────────────────────────────────────────────────────────────────────────────
// <BarChart series column> — the single-series path (drawBars)
// ─────────────────────────────────────────────────────────────────────────────

const BASE = Date.UTC(2026, 0, 1);
const STEP = 60_000;
const BAR_SERIES = TimeSeries.fromColumns({
  name: 'vol',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
  ] as const,
  columns: {
    time: [BASE, BASE + STEP, BASE + 2 * STEP, BASE + 3 * STEP],
    value: [2, 4, 6, 8],
  },
});

/**
 * The bars' key spans, from the very reader the layer uses — on a point-keyed
 * series the begins are synthesized neighbour-spaced edges (`t − halfGap`),
 * not the sample times, so they are read rather than assumed.
 */
const BARS = barsFromTimeSeries(BAR_SERIES, 'value');

function mountBars(props: Record<string, unknown>) {
  return mountRow(
    { range: [BASE - STEP, BASE + 4 * STEP], ...props },
    <BarChart series={BAR_SERIES} column="value" id="vol" axis="a" />,
  );
}

/** A `SelectInfo` naming bar `i`, keyed by its begin (no `mark`, the
 *  pre-marks controlled shape every shipped caller has). */
const barInfo = (i: number, id = 'vol'): SelectInfo => ({
  id,
  key: BARS.begin[i]!,
  value: BARS.y[i]!,
  color: '#abc',
  label: 'value',
});

// A selected bar is the only thing drawBars outlines, so `strokeRect` counts
// selected bars directly.
describe('<BarChart> single-series — spans through the controlled `selected`', () => {
  it('a span selects the bars inside it and no others', () => {
    const { calls } = mountBars({
      selected: [
        {
          kind: 'span',
          id: 'vol',
          x: [BARS.begin[1]!, BARS.end[2]!],
        } satisfies SpanSelection,
      ],
    });
    expect(count(calls, 'strokeRect')).toBe(2); // bars 1 and 2
  });

  it('the edge rule: snapped-outward edges, half-open — the shared edge is out', () => {
    // Bars are contiguous (`end[i] === begin[i+1]`), so a span storing the
    // snapped-outward edges of a sweep over bars 0‥1 ends exactly ON bar 2's
    // begin. Half-open containment must exclude it (RFC A7.6), or every sweep
    // lights one extra bar at its right edge.
    expect(BARS.end[1]).toBe(BARS.begin[2]); // the trap exists
    const { calls } = mountBars({
      selected: [
        {
          kind: 'span',
          id: 'vol',
          x: [BARS.begin[0]!, BARS.end[1]!],
        } satisfies SpanSelection,
      ],
    });
    expect(count(calls, 'strokeRect')).toBe(2); // bars 0 and 1 — never bar 2
  });

  it('a span naming another layer selects nothing here', () => {
    const { calls } = mountBars({
      selected: [
        {
          kind: 'span',
          id: 'elsewhere',
          x: [BARS.begin[0]!, BARS.end[3]!],
        } satisfies SpanSelection,
      ],
    });
    expect(count(calls, 'strokeRect')).toBe(0);
  });

  it('a mixed [SelectInfo, SpanSelection] array is the union', () => {
    const { calls } = mountBars({
      selected: [
        barInfo(3),
        {
          kind: 'span',
          id: 'vol',
          x: [BARS.begin[0]!, BARS.end[0]!],
        } satisfies SpanSelection,
      ],
    });
    expect(count(calls, 'strokeRect')).toBe(2); // bar 0 (span) + bar 3 (mark)
  });

  it('a bare SelectInfo still means exactly what it did', () => {
    const { calls } = mountBars({ selected: barInfo(2) });
    expect(count(calls, 'strokeRect')).toBe(1);
  });

  it('a plain SelectInfo[] still means exactly what it did', () => {
    const { calls } = mountBars({ selected: [barInfo(0), barInfo(2)] });
    expect(count(calls, 'strokeRect')).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// <BarChart categories> — the stacked path (drawStacks, stable marks)
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = [
  { label: 'alpha', value: 3 },
  { label: 'beta', value: 2 },
  { label: 'gamma', value: 1 },
];

function mountCategories(props: Record<string, unknown>) {
  // Categorical bars sit on unit slots (begin 0, 1, 2) — handy exact edges.
  return mountRow(
    props,
    <BarChart categories={CATEGORIES} id="cap" axis="a" />,
    <YAxis id="a" min={0} max={4} label="" />,
  );
}

describe('<BarChart categories> — spans reach drawStacks (the sibling path)', () => {
  it('a span selects the category bars inside its slot interval', () => {
    const { calls } = mountCategories({
      selected: [
        { kind: 'span', id: 'cap', x: [0, 2] } satisfies SpanSelection,
      ],
    });
    expect(count(calls, 'strokeRect')).toBe(2); // alpha (0), beta (1) — not gamma (2)
  });

  it('the shared-edge rule holds on unit slots too', () => {
    const { calls } = mountCategories({
      selected: [
        { kind: 'span', id: 'cap', x: [1, 2] } satisfies SpanSelection,
      ],
    });
    expect(count(calls, 'strokeRect')).toBe(1); // beta only — gamma begins AT 2
  });

  it('rows gates by the category name — the label the hit reports', () => {
    // A categorical bar's `SelectInfo.label` is its category name (the stable
    // mark), so a span's `rows` must test the same channel or the canvas and
    // `selectionContains` disagree on every categorical bar.
    const { calls } = mountCategories({
      selected: [
        {
          kind: 'span',
          id: 'cap',
          x: [0, 3],
          rows: ['beta'],
        } satisfies SpanSelection,
      ],
    });
    expect(count(calls, 'strokeRect')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// <ScatterChart> — the continuous × continuous layer (x AND y intervals)
// ─────────────────────────────────────────────────────────────────────────────

const POINTS = TimeSeries.fromColumns({
  name: 'pts',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'price', kind: 'number' },
  ] as const,
  columns: {
    time: [BASE, BASE + STEP, BASE + 2 * STEP, BASE + 3 * STEP],
    price: [2, 4, 6, 8],
  },
});

function mountScatter(props: Record<string, unknown>) {
  return mountRow(
    { range: [BASE, BASE + 3 * STEP], ...props },
    <ScatterChart series={POINTS} column="price" id="pts" axis="a" />,
  );
}

// `defaultTheme.scatter` carries a `states` ladder, so a selected point is
// recoloured rather than given a second arc — the count is of marks drawn in
// the selection blue, not of extra arcs.
const SELECTED = (calls: readonly CtxCall[]) =>
  arcsFilled(calls, defaultTheme.scatter.default.states!.selected).length;

describe('<ScatterChart> — a scatter span uses `y` (RFC A3.3/A5.3)', () => {
  it('an x-only span selects every point in the interval', () => {
    const { calls } = mountScatter({
      selected: [
        {
          kind: 'span',
          id: 'pts',
          x: [BASE + STEP, BASE + 3 * STEP],
        } satisfies SpanSelection,
      ],
    });
    expect(SELECTED(calls)).toBe(2); // points 1, 2 — 3 sits ON the open edge
  });

  it('y narrows it to the 2-D rectangle, half-open on both axes', () => {
    const { calls } = mountScatter({
      selected: [
        {
          kind: 'span',
          id: 'pts',
          x: [BASE, BASE + 4 * STEP],
          y: [4, 8], // values 4, 6 in; 8 sits on the open edge; 2 below
        } satisfies SpanSelection,
      ],
    });
    expect(SELECTED(calls)).toBe(2);
  });

  it('a span plus a mark select their union, one mark per point', () => {
    const { calls } = mountScatter({
      selected: [
        {
          id: 'pts',
          key: BASE + 3 * STEP,
          value: 8,
          color: '#abc',
          label: 'price',
        },
        {
          kind: 'span',
          id: 'pts',
          x: [BASE, BASE + 2 * STEP],
        } satisfies SpanSelection,
      ],
    });
    expect(SELECTED(calls)).toBe(3); // points 0, 1 (span) + 3 (mark)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// <BoxPlot> — interval marks on a value axis
// ─────────────────────────────────────────────────────────────────────────────

const SMILE = ValueSeries.fromColumns({
  name: 'smile',
  schema: [
    { name: 'strike', kind: 'value' },
    { name: 'bid', kind: 'number' },
    { name: 'ask', kind: 'number' },
  ] as const,
  columns: {
    strike: [90, 100, 110, 120],
    bid: [2, 3, 4, 5],
    ask: [3, 4, 5, 6],
  },
});

function mountBox(props: Record<string, unknown>) {
  return mountRow(
    { range: [90, 120], showAxis: false, ...props },
    <BoxPlot series={SMILE} lower="bid" upper="ask" as="iv" id="smile" />,
  );
}

/** Every `strokeRect`'s live `globalAlpha` — 1 selected, 0.5 hovered. A
 *  range-only box has no body, so highlights are the only strokes. */
function alphaPerStrokeRect(calls: readonly CtxCall[]): unknown[] {
  const out: unknown[] = [];
  let alpha: unknown;
  for (const c of calls) {
    if (c.type === 'set' && c.name === 'globalAlpha') alpha = c.args[0];
    if (c.name === 'strokeRect') out.push(alpha);
  }
  return out;
}

describe('<BoxPlot> — spans select boxes by their key span', () => {
  it('a span outlines every box whose key falls inside it', () => {
    // Box keys are neighbour-spaced begins (95/105/115 for strikes
    // 100/110/120 — the `Selectable` story's mapping).
    const { calls } = mountBox({
      selected: [
        { kind: 'span', id: 'smile', x: [95, 115] } satisfies SpanSelection,
      ],
    });
    // The cue is the **tint ladder**, not a bounding outline: with a laddered
    // theme a span-covered box paints from the selected ladder and the rest
    // recede. Half-open `[95, 115)` covers keys 95 and 105, not 115.
    const L = defaultTheme.box.default.states!;
    const strokes = calls
      .filter((c) => c.type === 'set' && c.name === 'strokeStyle')
      .map((c) => String(c.args[0]));
    expect(strokes.filter((c) => c === L.selected[2])).toHaveLength(2);
    expect(strokes.filter((c) => c === L.rest[2]).length).toBeGreaterThan(0);
  });

  it('a span naming another layer outlines nothing', () => {
    const { calls } = mountBox({
      selected: [
        { kind: 'span', id: 'other', x: [0, 999] } satisfies SpanSelection,
      ],
    });
    expect(alphaPerStrokeRect(calls)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// <HeatMap> — the continuous × ordinal layer (`rows`, never a y interval)
// ─────────────────────────────────────────────────────────────────────────────

const GRID = TimeSeries.fromColumns({
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

/** Bin begins from the reader the layer uses (neighbour-spaced edges). */
const HEAT_BEGINS = stacksFromColumns(GRID, ['lo', 'hi']).begin;

const RAMP = ['#111', '#555', '#999', '#ddd'];

function mountHeat(
  containerProps: Record<string, unknown>,
  columns: readonly ['lo', 'hi'] | readonly ['hi', 'lo'] = ['lo', 'hi'],
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
              series={GRID}
              columns={columns as ['lo', 'hi']}
              colors={RAMP}
              id="temp"
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

/** The rect (x, y) of every `strokeRect` — a heat cell only strokes when live. */
function strokeRects(calls: readonly CtxCall[]): Array<[number, number]> {
  return calls
    .filter((c) => c.name === 'strokeRect')
    .map((c) => [c.args[0] as number, c.args[1] as number]);
}

const heatSpan = (over: Partial<SpanSelection> = {}): SpanSelection => ({
  kind: 'span',
  id: 'temp',
  x: [HEAT_BEGINS[0]!, HEAT_BEGINS[2]!], // bins 0 and 1 (bin 2 begins AT x[1])
  ...over,
});

describe('<HeatMap> — a heat-map span uses `rows` (RFC A5.3)', () => {
  it('a rows-less span selects every row of the covered bins', () => {
    const { calls } = mountHeat({ selected: [heatSpan()] });
    expect(strokeRects(calls)).toHaveLength(4); // 2 bins × 2 rows
  });

  it('rows narrows to the named rows — a label set, not an interval', () => {
    const { calls } = mountHeat({
      selected: [heatSpan({ rows: ['hi'] })],
    });
    expect(strokeRects(calls)).toHaveLength(2); // (0, hi), (1, hi)
  });

  it('the selection survives a row reorder — it names rows, not slots', () => {
    // Same span, same data, rows in the opposite order. The `hi` row moves to
    // the other band of the plot; the SAME cells must light. A numeric
    // y-interval (A3.3's rejected shape) would keep the old band instead —
    // which is exactly why the descriptor carries labels.
    const before = strokeRects(
      mountHeat({ selected: [heatSpan({ rows: ['hi'] })] }, ['lo', 'hi']).calls,
    );
    const after = strokeRects(
      mountHeat({ selected: [heatSpan({ rows: ['hi'] })] }, ['hi', 'lo']).calls,
    );
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    // The lit band MOVED with its row: same x columns, different y band.
    expect(after.map(([x]) => x)).toEqual(before.map(([x]) => x));
    expect(after.map(([, y]) => y)).not.toEqual(before.map(([, y]) => y));
  });

  it('a span naming another layer lights nothing', () => {
    const { calls } = mountHeat({
      selected: [heatSpan({ id: 'other' })],
    });
    expect(strokeRects(calls)).toHaveLength(0);
  });

  it('a span and a cell mark light their union', () => {
    const { calls } = mountHeat({
      selected: [
        heatSpan({ x: [HEAT_BEGINS[0]!, HEAT_BEGINS[1]!], rows: ['lo'] }),
        {
          id: 'temp',
          key: HEAT_BEGINS[2]!,
          value: 0,
          color: '#abc',
          label: 'hi',
        },
      ],
    });
    expect(strokeRects(calls)).toHaveLength(2); // (0, lo) + (2, hi)
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The container's normalization split
// ─────────────────────────────────────────────────────────────────────────────

describe('<ChartContainer selected> — the SelectionEntry normalization', () => {
  it('splits a mixed array into frame marks + frame spans', () => {
    const mark = barInfo(0);
    const span: SpanSelection = { kind: 'span', id: 'vol', x: [0, 1] };
    const { frame } = mountBars({ selected: [mark, span] });
    expect(frame.selected).toEqual([mark]);
    expect(frame.selectedSpans).toEqual([span]);
  });

  it('a spanless array passes through by reference — no copy, no spans', () => {
    const sel = [barInfo(0), barInfo(1)];
    const { frame } = mountBars({ selected: sel });
    expect(frame.selected).toBe(sel);
    expect(frame.selectedSpans).toHaveLength(0);
  });

  it('a bare SelectInfo and null keep their shipped meaning', () => {
    const one = barInfo(1);
    expect(mountBars({ selected: one }).frame.selected).toEqual([one]);
    const cleared = mountBars({ selected: null }).frame;
    expect(cleared.selected).toHaveLength(0);
    expect(cleared.selectedSpans).toHaveLength(0);
  });

  it('spanless renders share one stable empty-spans identity', () => {
    // Two mounts, no spans anywhere: both frames hold the module constant, so
    // a spanless consumer's layers never see a fresh array (no re-register,
    // no repaint, for a feature they don't use).
    const a = mountBars({}).frame.selectedSpans;
    const b = mountBars({ selected: [barInfo(0)] }).frame.selectedSpans;
    expect(a).toBe(b);
  });
});
