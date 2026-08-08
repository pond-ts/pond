import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries, ValueSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { ScatterChart } from '../src/ScatterChart.js';
import { BoxPlot } from '../src/BoxPlot.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
  type SelectInfo,
} from '../src/context.js';
import { recordingContext, stubCanvasContext } from './canvas-mock.js';
import type { CtxCall } from './canvas-mock.js';

afterEach(cleanup);

/**
 * **The container's `selected` / `hovered` sets reach the mark, whole.**
 *
 * `ContainerFrame.selected` became `readonly SelectInfo[]` in #606 and
 * `hovered` in #616, but two layers kept narrowing the set to one member on the
 * way into their draw — `<ScatterChart>` with `selected[0]`, `<BoxPlot>` with a
 * `find` on its own series id. Both then lit exactly one mark however many the
 * consumer pinned, with no warning and no error.
 *
 * The draw functions themselves are unit-tested in `scatter.test.ts` /
 * `box.test.ts`. **These tests exist because that wasn't enough**: the bug was
 * never in the draw, it was in the two lines of component wiring above it, and
 * a green `drawScatter([a, b], …)` says nothing about what `<ScatterChart>`
 * hands it. This file drives the real component and reads the canvas ops the
 * registered layer emits, so the wiring is what's under test.
 */

/** Mount `children` in a container/row and return the captured frames. */
function mountRow(
  containerProps: Record<string, unknown>,
  children: React.ReactNode,
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
          <YAxis id="a" min={0} max={10} label="" />
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
  return { calls };
}

const count = (calls: readonly CtxCall[], name: string) =>
  calls.filter((c) => c.name === name).length;

/** Every `strokeRect`'s live `globalAlpha` — 1 selected, 0.5 hovered. */
function alphaPerStrokeRect(calls: readonly CtxCall[]): unknown[] {
  const out: unknown[] = [];
  let alpha: unknown;
  for (const c of calls) {
    if (c.type === 'set' && c.name === 'globalAlpha') alpha = c.args[0];
    if (c.name === 'strokeRect') out.push(alpha);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// <ScatterChart>
// ─────────────────────────────────────────────────────────────────────────────

const BASE = Date.UTC(2026, 0, 1);
const STEP = 60_000;
/** Four points, one per minute, keyed by their event `begin`. */
const points = () =>
  new TimeSeries({
    name: 'pts',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'price', kind: 'number' },
    ] as const,
    rows: [
      [BASE, 2],
      [BASE + STEP, 4],
      [BASE + 2 * STEP, 6],
      [BASE + 3 * STEP, 8],
    ],
  });

const point = (i: number, id = 'pts'): SelectInfo => ({
  id,
  key: BASE + i * STEP,
  value: 2 + 2 * i,
  color: '#abc',
  label: 'price',
});

function mountScatter(props: Record<string, unknown>) {
  return mountRow(
    { range: [BASE, BASE + 3 * STEP], ...props },
    <ScatterChart series={points()} column="price" id="pts" axis="a" />,
  );
}

describe('<ScatterChart> — the whole selection / hover set reaches the draw', () => {
  // One `arc` per point in the base pass, one more per highlight ring, so the
  // ring count reads straight off the op log.
  const RINGS = (calls: readonly CtxCall[]) => count(calls, 'arc') - 4;

  it('rings every member of a multi-mark `selected`', () => {
    const { calls } = mountScatter({ selected: [point(0), point(2)] });
    expect(RINGS(calls)).toBe(2);
  });

  it('rings a three-mark selection — no cap at one', () => {
    const { calls } = mountScatter({
      selected: [point(0), point(1), point(3)],
    });
    expect(RINGS(calls)).toBe(3);
  });

  it('still rings exactly one for a single-mark selection (unchanged)', () => {
    // The union `selected` accepts means every shipped caller passes one mark;
    // widening the reader must not change what they see.
    const { calls } = mountScatter({ selected: point(1) });
    expect(RINGS(calls)).toBe(1);
  });

  it('rings every member of a multi-mark `hovered`', () => {
    const { calls } = mountScatter({ hovered: [point(1), point(2)] });
    expect(RINGS(calls)).toBe(2);
    const alphas = calls
      .filter((c) => c.type === 'set' && c.name === 'globalAlpha')
      .map((c) => c.args[0]);
    expect(alphas).toContain(0.5); // the fainter hover ring
  });

  it('rings selection and hover together, selection winning the overlap', () => {
    const { calls } = mountScatter({
      selected: [point(0), point(1)],
      hovered: [point(1), point(3)],
    });
    // Three distinct live points (0, 1, 3) — point 1 is in both sets and rings
    // once, as selected.
    expect(RINGS(calls)).toBe(3);
  });

  it('ignores set members naming another layer', () => {
    const { calls } = mountScatter({
      selected: [point(0, 'elsewhere'), point(2)],
      hovered: [point(1, 'elsewhere')],
    });
    expect(RINGS(calls)).toBe(1);
  });

  it('rings nothing when both sets are empty', () => {
    expect(RINGS(mountScatter({}).calls)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// <BoxPlot>
// ─────────────────────────────────────────────────────────────────────────────

/** A range-only vol smile on a value (strike) axis — bid→ask per strike, no
 *  body, so the only `strokeRect` a draw emits is a selection / hover outline. */
const smile = () =>
  ValueSeries.fromColumns({
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

/**
 * A box's key is its **x** — the neighbour-spaced span begin, i.e. halfway back
 * to the previous strike (the `<BoxPlot>` `Selectable` story documents the same
 * 95-for-strike-100 mapping). So strikes 100 / 110 / 120 key at 95 / 105 / 115.
 */
const box = (key: number, id = 'smile'): SelectInfo => ({
  id,
  key,
  value: 0,
  color: '#abc',
  label: 'iv',
});

function mountBox(props: Record<string, unknown>) {
  return mountRow(
    { range: [90, 120], showAxis: false, ...props },
    <BoxPlot series={smile()} lower="bid" upper="ask" as="iv" id="smile" />,
  );
}

describe('<BoxPlot> — the whole selection / hover set reaches the draw', () => {
  it('outlines every member of a multi-mark `selected`', () => {
    const { calls } = mountBox({ selected: [box(95), box(115)] });
    expect(alphaPerStrokeRect(calls)).toEqual([1, 1]);
  });

  it('outlines a three-box selection — no cap at one', () => {
    const { calls } = mountBox({
      selected: [box(95), box(105), box(115)],
    });
    expect(count(calls, 'strokeRect')).toBe(3);
  });

  it('still outlines exactly one for a single-mark selection (unchanged)', () => {
    const { calls } = mountBox({ selected: box(95) });
    expect(alphaPerStrokeRect(calls)).toEqual([1]);
  });

  it('outlines every member of a multi-mark `hovered`, faintly', () => {
    const { calls } = mountBox({ hovered: [box(95), box(105)] });
    expect(alphaPerStrokeRect(calls)).toEqual([0.5, 0.5]);
  });

  it('outlines selection and hover together, selection winning the overlap', () => {
    const { calls } = mountBox({
      selected: [box(95)],
      hovered: [box(95), box(115)],
    });
    // Two lit boxes: 95 selected (full strength, not double-stroked) and 115
    // hovered.
    expect(alphaPerStrokeRect(calls)).toEqual([1, 0.5]);
  });

  it('ignores set members naming another layer', () => {
    const { calls } = mountBox({
      selected: [box(95, 'elsewhere'), box(105)],
      hovered: [box(115, 'elsewhere')],
    });
    expect(alphaPerStrokeRect(calls)).toEqual([1]);
  });

  it('outlines nothing when both sets are empty', () => {
    expect(count(mountBox({}).calls, 'strokeRect')).toBe(0);
  });
});
