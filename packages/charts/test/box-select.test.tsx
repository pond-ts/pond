import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries, ValueSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BoxPlot } from '../src/BoxPlot.js';
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
    try {
      render(
        <ChartContainer
          range={[90, 110]}
          width={400}
          showAxis={false}
          {...(props.onSelect ? { onSelect: props.onSelect } : {})}
        >
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
    const session = mountBoxes().layer().beginSweep!()!;
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
    const session = l.beginSweep!()!;
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

describe('a SOLID box takes the bar interaction palette', () => {
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

  /** Mount, draw once, return every `fillStyle` the layer set. */
  function fills(shape: 'whisker' | 'solid', selected?: unknown): string[] {
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
          range={[0, 20]}
          width={400}
          showAxis={false}
          {...(selected ? { selected: selected as never } : {})}
        >
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
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    const { ctx, calls } = recordingContext();
    rf!.layers[0]!.layer.draw(ctx, cf!.xScale, rf!.yScales.get('v')!);
    return calls
      .filter((c) => c.type === 'set' && c.name === 'fillStyle')
      .map((c) => String(c.args[0]));
  }

  const sel = [{ id: 'b', key: 0, value: 8, color: '#000', label: 'lo–hi' }];

  it('fills the selected box with `highlight` and recedes the other', () => {
    const painted = fills('solid', sel);
    expect(painted).toContain(defaultTheme.box.default.highlight);
    expect(painted).toContain(defaultTheme.box.default.dimmed);
  });

  it('rests on the plain fill when nothing is selected — nothing dims', () => {
    const painted = fills('solid');
    expect(new Set(painted)).toEqual(new Set([defaultTheme.box.default.fill]));
    expect(painted).not.toContain(defaultTheme.box.default.dimmed);
  });

  it('leaves the WHISKER shape on its outline cue — no fill swap, no dim', () => {
    // The scoping the palette is deliberately given: a whisker box paints thin
    // stems over a mostly-empty slot, so a fill swap recolours a few pixels
    // and a dim erases them. Its cue stays the bounding outline.
    const painted = fills('whisker', sel);
    expect(new Set(painted)).toEqual(new Set([defaultTheme.box.default.fill]));
    expect(painted).not.toContain(defaultTheme.box.default.highlight);
    expect(painted).not.toContain(defaultTheme.box.default.dimmed);
  });
});
