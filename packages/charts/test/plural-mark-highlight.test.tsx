import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries, ValueSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { ScatterChart } from '../src/ScatterChart.js';
import { BoxPlot } from '../src/BoxPlot.js';
import { Selector } from '../src/selectors.js';
import { defaultTheme } from '../src/theme.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
  type SelectInfo,
} from '../src/context.js';
import {
  arcsFilled,
  recordingContext,
  stubCanvasContext,
} from './canvas-mock.js';
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
  const row = (
    <ChartRow height={200}>
      <YAxis id="a" min={0} max={10} label="" />
      <Layers>
        {children}
        <Capture />
      </Layers>
    </ChartRow>
  );
  try {
    render(
      <ChartContainer width={400}>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <Selector enabled={false} {...(containerProps as any)}>
          {row}
        </Selector>
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
  // `defaultTheme.scatter` carries a `states` ladder, so a live point is not
  // "the base mark plus a highlight ring" — it is ONE mark drawn in the
  // state's colour at the state's size. The arc total is therefore the same
  // whatever is selected, and what counts a state is its **fill**.
  const S = defaultTheme.scatter.default;
  const SELECTED = (calls: readonly CtxCall[]) =>
    arcsFilled(calls, S.states!.selected).length;
  const HOVERED = (calls: readonly CtxCall[]) =>
    arcsFilled(calls, S.states!.hover);
  // Every point still draws exactly once, live or not — the state moved the
  // mark rather than adding one.
  const TOTAL_ARCS = 4;

  it('recolours every member of a multi-mark `selected`', () => {
    const { calls } = mountScatter({ selected: [point(0), point(2)] });
    expect(SELECTED(calls)).toBe(2);
    expect(count(calls, 'arc')).toBe(TOTAL_ARCS);
  });

  it('recolours a three-mark selection — no cap at one', () => {
    const { calls } = mountScatter({
      selected: [point(0), point(1), point(3)],
    });
    expect(SELECTED(calls)).toBe(3);
  });

  it('still lights exactly one for a single-mark selection (unchanged)', () => {
    // The union `selected` accepts means every shipped caller passes one mark;
    // widening the reader must not change what they see.
    const { calls } = mountScatter({ selected: point(1) });
    expect(SELECTED(calls)).toBe(1);
  });

  it('recolours every member of a multi-mark `hovered`, and grows them', () => {
    const { calls } = mountScatter({ hovered: [point(1), point(2)] });
    const hov = HOVERED(calls);
    expect(hov).toHaveLength(2);
    // Hover is the state that spends SIZE — the radii are the grown ones, not
    // the resting radius with a ring around it.
    expect(hov).toEqual([S.states!.hoverRadius, S.states!.hoverRadius]);
    expect(count(calls, 'arc')).toBe(TOTAL_ARCS);
  });

  it('lights selection and hover together, selection winning the overlap', () => {
    const { calls } = mountScatter({
      selected: [point(0), point(1)],
      hovered: [point(1), point(3)],
    });
    // Three distinct live points (0, 1, 3) — point 1 is in both sets and
    // draws once, as selected. The precedence is visible in the fills, which
    // is stronger than the old ring count: it says WHICH state won.
    expect(SELECTED(calls)).toBe(2);
    expect(HOVERED(calls)).toHaveLength(1);
    expect(count(calls, 'arc')).toBe(TOTAL_ARCS);
  });

  it('ignores set members naming another layer', () => {
    const { calls } = mountScatter({
      selected: [point(0, 'elsewhere'), point(2)],
      hovered: [point(1, 'elsewhere')],
    });
    expect(SELECTED(calls)).toBe(1);
    expect(HOVERED(calls)).toHaveLength(0);
  });

  it('lights nothing when both sets are empty — and dims nothing either', () => {
    const { calls } = mountScatter({});
    expect(SELECTED(calls)).toBe(0);
    expect(HOVERED(calls)).toHaveLength(0);
    // The resting field is the resting field: an empty selection must not
    // recede the plot, which is what `selectionActive` gates.
    expect(arcsFilled(calls, S.color)).toEqual(
      Array(TOTAL_ARCS).fill(S.radius),
    );
  });

  it('recedes the unselected field — shrunk AND faded, not one or the other', () => {
    const { calls } = mountScatter({ selected: [point(0)] });
    const rest = arcsFilled(calls, S.color);
    expect(rest).toEqual(Array(3).fill(S.states!.dimmedRadius));
    const alphas = calls
      .filter((c) => c.type === 'set' && c.name === 'globalAlpha')
      .map((c) => c.args[0]);
    expect(alphas).toContain(S.states!.dimmedOpacity);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// <BoxPlot>
// ─────────────────────────────────────────────────────────────────────────────

/** A range-only vol smile on a value (strike) axis — bid→ask per strike, no
 *  body and no median, so each box's *whisker stroke* is the only mark it
 *  draws, and its ladder step is the whole state signal. */
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

/**
 * The state each of the four boxes drew, read off its whisker's ladder step.
 * `defaultTheme.box.default` carries a tint ladder, so a box announces its
 * state by *which ladder* it painted from — the bounding outline that used to
 * carry it is superseded (a rect around a whisker claims the empty slot
 * either side of it as part of the mark).
 */
function statePerBox(calls: readonly CtxCall[]): string[] {
  const L = defaultTheme.box.default.states!;
  const step2 = {
    [L.rest[2]]: 'rest',
    [L.hover[2]]: 'hover',
    [L.selected[2]]: 'selected',
  };
  const out: string[] = [];
  let alpha = 1;
  for (const c of calls) {
    if (c.type === 'set' && c.name === 'globalAlpha')
      alpha = c.args[0] as number;
    if (c.type !== 'set' || c.name !== 'strokeStyle') continue;
    const state = step2[String(c.args[0])];
    if (state === undefined) continue;
    out.push(state === 'rest' && alpha === L.dimmedOpacity ? 'dimmed' : state);
  }
  return out;
}

describe('<BoxPlot> — the whole selection / hover set reaches the draw', () => {
  it('lights every member of a multi-mark `selected`', () => {
    const { calls } = mountBox({ selected: [box(95), box(115)] });
    // Four strikes → four boxes; keys 95 / 105 / 115 are indices 1 / 2 / 3
    // (a box keys at its neighbour-spaced span begin). 95 and 115 select; the
    // other two recede.
    expect(statePerBox(calls)).toEqual([
      'dimmed',
      'selected',
      'dimmed',
      'selected',
    ]);
  });

  it('lights a three-box selection — no cap at one', () => {
    const { calls } = mountBox({
      selected: [box(95), box(105), box(115)],
    });
    expect(statePerBox(calls).filter((s) => s === 'selected')).toHaveLength(3);
  });

  it('still lights exactly one for a single-mark selection (unchanged)', () => {
    const { calls } = mountBox({ selected: box(95) });
    expect(statePerBox(calls).filter((s) => s === 'selected')).toHaveLength(1);
  });

  it('lights every member of a multi-mark `hovered`', () => {
    const { calls } = mountBox({ hovered: [box(95), box(105)] });
    // Hover does not dim the field — only a selection does.
    expect(statePerBox(calls)).toEqual(['rest', 'hover', 'hover', 'rest']);
  });

  it('lights selection and hover together, selection winning the overlap', () => {
    const { calls } = mountBox({
      selected: [box(95)],
      hovered: [box(95), box(115)],
    });
    // 95 is in both and reads as selected; 115 hovers; the rest recede.
    expect(statePerBox(calls)).toEqual([
      'dimmed',
      'selected',
      'dimmed',
      'hover',
    ]);
  });

  it('ignores set members naming another layer', () => {
    const { calls } = mountBox({
      selected: [box(95, 'elsewhere'), box(105)],
      hovered: [box(115, 'elsewhere')],
    });
    expect(statePerBox(calls).filter((s) => s === 'selected')).toHaveLength(1);
  });

  it('leaves every box at rest when both sets are empty', () => {
    expect(new Set(statePerBox(mountBox({}).calls))).toEqual(new Set(['rest']));
    expect(count(mountBox({}).calls, 'strokeRect')).toBe(0);
  });
});
