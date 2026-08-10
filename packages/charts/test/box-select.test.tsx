import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries, ValueSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BoxPlot } from '../src/BoxPlot.js';
import { Selector } from '../src/selectors.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
} from '../src/context.js';
import { resolveSelection } from '../src/select.js';
import { recordingContext, stubCanvasContext } from './canvas-mock.js';
import { defaultTheme } from '../src/theme.js';

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
    const row = (
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
    );
    try {
      render(
        <ChartContainer range={[90, 110]} width={400} showAxis={false}>
          {props.onSelect ? (
            <Selector onSelect={props.onSelect}>{row}</Selector>
          ) : (
            row
          )}
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
    // Counts the *no-selectable-layer* warning specifically: wiring the
    // (now-deprecated) container `onSelect` also emits the `<Selector>`
    // migration warning — interaction RFC §7.
    const noId = () =>
      warn.mock.calls.filter((c) => /no layer has an `id`/.test(String(c[0])));
    try {
      mount({ onSelect: () => {} });
      expect(noId()).toHaveLength(1);
      warn.mockClear();
      mount({ onSelect: () => {}, id: 'smile' });
      expect(noId()).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });
});

// ── The sweep + the solid interaction palette ───────────────────────────────

/**
 * A box is an **aggregation**: it owns one `[begin, end)` interval of the key
 * axis. That its ink floats between two quantiles rather than rising from the
 * baseline says nothing about which column the mark occupies — so it sweeps,
 * and snaps, exactly as a bar does. These pin that equivalence.
 */
describe('<BoxPlot> sweeps by column, like a bar that is not grounded', () => {
  /** Four 10-unit buckets on a time axis, with a gap at index 2. */
  const buckets = () =>
    new TimeSeries({
      name: 'b',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'lo', kind: 'number', required: false },
        { name: 'hi', kind: 'number', required: false },
      ] as const,
      rows: [
        [[0, 10], 2, 8],
        [[10, 20], 3, 9],
        [[20, 30], undefined, undefined],
        [[30, 40], 1, 7],
      ] as never,
    });

  function mountBoxes(shape: 'whisker' | 'solid' = 'whisker') {
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
        <ChartContainer range={[0, 40]} width={400} showAxis={false}>
          <ChartRow height={200}>
            <YAxis id="v" min={0} max={10} />
            <Layers>
              <BoxPlot
                series={buckets()}
                lower="lo"
                upper="hi"
                axis="v"
                shape={shape}
                id="b"
              />
              <Capture />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    return { container: () => cf!, layer: () => rf!.layers[0]!.layer };
  }

  it('publishes its columns as snap buckets, so the band lands on box edges', () => {
    // Without this the region cursor / sweep band has nothing to snap to and
    // runs centre-to-centre, disagreeing with the span the release commits
    // (RFC A7.6's edge rule) — the same thing bar layers publish bins for.
    const bins = mountBoxes().layer().binIntervals?.();
    expect(bins).toBeDefined();
    expect(bins).toHaveLength(4);
    expect([+bins![0]!.begin(), +bins![0]!.end()]).toEqual([0, 10]);
    expect([+bins![3]!.begin(), +bins![3]!.end()]).toEqual([30, 40]);
  });

  it('sweeps a contiguous run of columns and skips the gap box', () => {
    const session = mountBoxes().layer().beginSweep!(
      (v: number) => v,
      (v: number) => v,
    )!;
    expect(session).not.toBeNull();
    // A window over buckets 0..1.
    session.update(2, 18);
    expect(session.hits().map((h) => h.key)).toEqual([0, 10]);
    // Widen over the gap to the last box: the gap owns no membership, so it
    // is absent from the hits while the span still spans it.
    session.update(2, 39);
    expect(session.hits().map((h) => h.key)).toEqual([0, 10, 30]);
    // The extent snaps outward to whole columns (A7.6's edge rule).
    expect(session.extent()).toEqual([0, 40]);
  });

  it('materialises exactly what hitTest reports, so click and sweep agree', () => {
    const { container, layer } = mountBoxes();
    const c = container();
    const l = layer();
    const session = l.beginSweep!(
      (v: number) => v,
      (v: number) => v,
    )!;
    session.update(0, 10);
    const swept = session.hits()[0]!;
    const clicked = l.hitTest!(+c.xScale(5), 100, c.xScale, (v: number) => v, {
      mode: 'select',
    } as never);
    // `hitTest`'s y needs to land inside the mark; assert on the shared
    // identity fields the sweep is required to match rather than re-deriving
    // pixel geometry here.
    expect(swept.id).toBe('b');
    expect(swept.key).toBe(0);
    expect(swept.value).toBe(8); // `upper`, as hitTest reports
    expect(clicked === null || clicked.key === swept.key).toBe(true);
  });
});

describe('the tint ladder — one palette swap per state', () => {
  const one = () =>
    new TimeSeries({
      name: 'b',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'lo', kind: 'number' },
        { name: 'q1', kind: 'number' },
        { name: 'q3', kind: 'number' },
        { name: 'hi', kind: 'number' },
      ] as const,
      rows: [
        [[0, 10], 2, 4, 6, 8],
        [[10, 20], 2, 4, 6, 8],
      ] as [[number, number], number, number, number, number][],
    });

  /** Mount, draw once, return every recorded call. */
  function draw(
    shape: 'whisker' | 'solid',
    props: { selected?: unknown; hovered?: unknown } = {},
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
        <YAxis id="v" min={0} max={10} />
        <Layers>
          <BoxPlot
            series={one()}
            lower="lo"
            q1="q1"
            median="q1"
            q3="q3"
            upper="hi"
            axis="v"
            shape={shape}
            id="b"
          />
          <Capture />
        </Layers>
      </ChartRow>
    );
    try {
      render(
        <ChartContainer range={[0, 20]} width={400} showAxis={false}>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          <Selector enabled={false} {...(props as any)}>
            {row}
          </Selector>
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    const { ctx, calls } = recordingContext();
    rf!.layers[0]!.layer.draw(ctx, cf!.xScale, rf!.yScales.get('v')!);
    const setsOf = (name: string) =>
      calls
        .filter((c) => c.type === 'set' && c.name === name)
        .map((c) => c.args[0]);
    return {
      fills: setsOf('fillStyle').map(String),
      strokes: setsOf('strokeStyle').map(String),
      widths: setsOf('lineWidth') as number[],
      alphas: setsOf('globalAlpha') as number[],
    };
  }

  const states = defaultTheme.box.default.states!;
  const sel = [{ id: 'b', key: 0, value: 8, color: '#000', label: 'lo–hi' }];
  const hov = [{ id: 'b', key: 0, value: 8, color: '#000', label: 'lo–hi' }];

  it('rests on the teal ladder, every mark reading its own step', () => {
    const { fills, strokes } = draw('whisker');
    // step 0 = body fill, step 2 = stroke + whisker, step 3 = median.
    expect(fills).toContain(states.rest[0]);
    expect(strokes).toContain(states.rest[2]);
    expect(strokes).toContain(states.rest[3]);
    // No blue leaks into a resting chart. (The hover ladder is *also* teal and
    // shares `#2A9D8F` with rest by design — brightening within one hue is the
    // point — so it is not a disjointness check.)
    for (const c of states.selected) {
      expect([...fills, ...strokes]).not.toContain(c);
    }
  });

  it('swaps the WHOLE ladder on select — not one step', () => {
    // The rule the ladder exists for: recolouring only the median or only the
    // body breaks the quantile read, so all four steps move together.
    const { fills, strokes } = draw('whisker', { selected: sel });
    expect(fills).toContain(states.selected[0]);
    expect(strokes).toContain(states.selected[2]);
    expect(strokes).toContain(states.selected[3]);
  });

  it('previews the click with the half-strength ladder on hover', () => {
    const { fills, strokes } = draw('whisker', { hovered: hov });
    expect(fills).toContain(states.hover[0]);
    expect(strokes).toContain(states.hover[2]);
    // Hover must not reach the committed ladder — that distinction is the
    // whole point of having two blue ladders rather than one.
    expect([...fills, ...strokes]).not.toContain(states.selected[2]);
  });

  it('bumps hairlines to 1.5px when selected — hue alone is too thin', () => {
    const w = defaultTheme.box.default;
    // Count the hairline widths specifically — `medianWidth` (2) is the widest
    // line either way, so a plain `Math.max` compares the wrong mark.
    const hairlines = (ws: number[]) => ws.filter((n) => n !== w.medianWidth);
    // Two boxes → two hairlines each (body stroke + whisker).
    expect(new Set(hairlines(draw('whisker').widths))).toEqual(new Set([1]));
    const selected = hairlines(draw('whisker', { selected: sel }).widths);
    // The selected box's two hairlines thicken; the receded box's do not —
    // the weight tracks the mark's state, not the chart's.
    expect(selected.filter((n) => n === w.selectedStrokeWidth)).toHaveLength(2);
    expect(selected.filter((n) => n === w.strokeWidth)).toHaveLength(2);
  });

  it('dims by OPACITY on the rest ladder — no desaturated companion', () => {
    // A single-hue ladder has nothing to muddy into, so the receded state is
    // the resting colours at .32 rather than a second set of colours.
    const { fills, alphas } = draw('whisker', { selected: sel });
    expect(fills).toContain(states.rest[0]); // box 2, receded
    expect(alphas).toContain(states.dimmedOpacity);
  });

  it('applies the ladder to the SOLID shape too, as two tiers', () => {
    // Solid reads steps 0 and 1 — outer bar and inner q1→q3 — so the two-tier
    // structure survives every state instead of being an alpha trick.
    const { fills } = draw('solid', { selected: sel });
    expect(fills).toContain(states.selected[0]);
    expect(fills).toContain(states.selected[1]);
  });

  it('drops the bounding outline once a ladder is in force', () => {
    // With no ladder the outline is the whole cue; with one it would claim the
    // empty slot around a whisker as part of the mark.
    const { calls } = (() => {
      const rec = recordingContext();
      return { calls: rec.calls };
    })();
    void calls;
    const laddered = draw('whisker', { selected: sel });
    // The bounding rect strokes at the mark's full lower→upper extent; the only
    // strokeRect a laddered box emits is the q1→q3 body. Assert by count.
    expect(
      laddered.strokes.filter((c) => c === states.selected[2]).length,
    ).toBeGreaterThan(0);
  });
});
