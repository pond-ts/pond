/**
 * The **bar interaction-state palette** on `defaultTheme`, and the drag band
 * that goes with it.
 *
 * Two things are pinned here, and the reason each is pinned differs:
 *
 * 1. **The palette values themselves.** `defaultTheme.bar.default` was the
 *    one part of the default theme nothing asserted — every bar test and every
 *    bar story themes off `docsTheme`, `estelaTheme`, or a locally-built
 *    override, so the values a consumer who passes *no* theme actually gets
 *    were unpinned. The palette's whole claim is a *semantic* one (rest is
 *    teal, selection is blue, hover is a brighter teal and deliberately not
 *    blue), and a claim that nothing asserts is a claim that drifts.
 * 2. **That the states resolve through the draw path**, not just that the
 *    theme object holds the right strings — including `emphasisOpacity`,
 *    which the palette relies on being `1` by default rather than setting.
 */
import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { defaultTheme } from '../src/theme.js';
import { renderBrushBand } from '../src/brush.js';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
  type SelectInfo,
} from '../src/context.js';
import { recordingContext, stubCanvasContext } from './canvas-mock.js';
import type { ChartTheme } from '../src/theme.js';
import type { ResolvedCursorFrame } from '../src/context.js';

afterEach(cleanup);

describe('defaultTheme.bar.default — the interaction-state palette', () => {
  const bar = defaultTheme.bar.default;

  it('encodes state as a hue difference: teal at rest, blue when selected', () => {
    // The semantic shift this palette exists for. Before it, `fill` and
    // `highlight` were two shades of one blue, so a selection read as "the
    // same bar, slightly darker" rather than as a different state.
    expect(bar.fill).toBe('#2A9D8F');
    expect(bar.highlight).toBe('#3F5BE0');
  });

  it('rests at full opacity — the emphasis is carried in hue, not alpha', () => {
    expect(bar.opacity).toBe(1);
  });

  it('hovers to a brighter TEAL — blue stays reserved for committed selection', () => {
    expect(bar.hover).toBe('#3FBFAE');
    // The load-bearing half of the rule: hover must not be the selection hue.
    expect(bar.hover).not.toBe(bar.highlight);
  });

  it('dims to the resting teal at 0.32 alpha', () => {
    expect(bar.dimmed).toBe('rgba(42,157,143,0.32)');
  });

  it('leaves emphasisOpacity unset, taking the `1` default rather than pinning it', () => {
    // "Selected: always full opacity" is already what `?? 1` gives, so the
    // palette adds nothing here. Verified rather than assumed — if the
    // fallback ever moved off 1, a resting opacity of 1 would mean a selected
    // bar got *fainter* than a resting one.
    expect(bar.emphasisOpacity).toBeUndefined();
  });

  it('starts its threshold ladder on the bar’s own teal, not the old blue', () => {
    // `bands[0]` is the in-range band — it has to be the resting fill, or a
    // bar under its first threshold changes colour for no reason.
    expect(bar.bands?.[0]).toBe(bar.fill);
    expect(bar.bands).toEqual(['#2A9D8F', '#e8a13c', '#d64545']);
  });

  it('leaves `secondary` on the warm accent — the palette is the default role only', () => {
    expect(defaultTheme.bar.secondary!.fill).toBe('#e8836b');
  });

  it('carries a four-hue stack ramp, and a receded counterpart per entry', () => {
    // Without this an unthemed multi-group stack painted every segment
    // `fill` — one solid teal column with hairline seams, which is not a
    // stack. The dimmed ramp is per-entry for the same reason: a receded bin
    // collapsed to one grey stops showing structure to compare against.
    expect(bar.groups).toEqual(['#4c9e8f', '#5379be', '#e2a54a', '#b5604e']);
    expect(bar.groupsDimmed).toHaveLength(bar.groups!.length);
    expect(bar.groupsDimmed).toEqual([
      '#c7cecd',
      '#ced1d6',
      '#dcd8d2',
      '#d3cdcc',
    ]);
  });

  it('starts the ramp near the resting fill, and keeps selection blue out of it', () => {
    // The ramp has to look like the rest of the palette, so entry 0 is a teal
    // close to `fill`. And no entry may be the selection blue — a resting
    // segment the same colour as a committed one is the exact confusion the
    // interaction palette exists to prevent.
    expect(bar.groups![0]).toMatch(/^#4c9e8f$/);
    expect(bar.groups).not.toContain(bar.highlight);
    expect(bar.groups).not.toContain(bar.hover);
  });
});

// ── the ramp through the draw path ──────────────────────────────────────────

/** Mount a chart and run one draw pass, returning every `fillStyle` set. */
function drawFills(
  node: React.ReactNode,
  props: Record<string, unknown> = {},
  /** A category axis derives its domain from the layer, so it must NOT be
   *  handed a `range` — that would resolve the axis as time instead. */
  opts: { categorical?: boolean } = {},
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
        {...(opts.categorical ? {} : { range: [0, 4] as [number, number] })}
        width={300}
        {...props}
      >
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={20} />
          <Layers>
            {node}
            <Capture />
          </Layers>
        </ChartRow>
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

/** Four bins × `n` groups, every segment a positive 2. */
const stack = (n: number) => {
  const cols = ['g0', 'g1', 'g2', 'g3'].slice(0, n);
  return new TimeSeries({
    name: 's',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      ...cols.map((c) => ({ name: c, kind: 'number' as const })),
    ],
    rows: Array.from({ length: 4 }, (_, i) => [
      [i, i + 1],
      ...cols.map(() => 2),
    ]),
  } as never);
};

describe('the stack group ramp resolves through the draw path', () => {
  const cols4 = ['g0', 'g1', 'g2', 'g3'];

  it('paints a multi-group stack from the ramp, one hue per group', () => {
    const fills = drawFills(
      <BarChart series={stack(4)} columns={cols4} axis="a" id="s" />,
    );
    // Every ramp entry is used, and nothing falls back to the flat `fill`.
    expect(new Set(fills)).toEqual(new Set(defaultTheme.bar.default.groups));
  });

  it('leaves a SINGLE-group stack on `fill` — a ramp needs groups to tell apart', () => {
    // The back-compat half, and the one that matters. Note it has to be a
    // **categorical** (or horizontal) chart: a one-column *vertical* series
    // normalizes to the single-series path and never reaches `stackStyle`, so
    // testing it there would pass whatever the gate did ([PND-BARSEM]).
    const fills = drawFills(
      <BarChart
        categories={[
          { label: 'a', value: 3 },
          { label: 'b', value: 7 },
        ]}
        axis="a"
        id="s"
      />,
      {},
      { categorical: true },
    );
    expect(fills.length).toBeGreaterThan(0);
    expect(new Set(fills)).toEqual(new Set([defaultTheme.bar.default.fill]));
  });

  it('recedes the unselected bins per group, keeping the bands distinct', () => {
    const selected: SelectInfo = {
      id: 's',
      key: 0,
      value: 2,
      color: '#000',
      label: 'g0',
    };
    const fills = drawFills(
      <BarChart series={stack(4)} columns={cols4} axis="a" id="s" />,
      { selected: [selected] },
    );
    // The three unselected bins recede through the *dimmed ramp* — all four
    // entries present, so a receded bin still reads as four bands.
    for (const d of defaultTheme.bar.default.groupsDimmed!) {
      expect(fills).toContain(d);
    }
    // …and the flat `dimmed` is not what painted them.
    expect(fills).not.toContain(defaultTheme.bar.default.dimmed);
  });

  it('keeps a selected segment its own ramp colour, not the flat highlight', () => {
    // A group ramp is meaning-carrying colour — the same exclusion `binFills`
    // gets. Repainting the selection blue would erase which group it is,
    // which is the one thing the selection is about.
    const selected: SelectInfo = {
      id: 's',
      key: 0,
      value: 2,
      color: '#000',
      label: 'g2',
    };
    const fills = drawFills(
      <BarChart series={stack(4)} columns={cols4} axis="a" id="s" />,
      { selected: [selected] },
    );
    expect(fills).toContain(defaultTheme.bar.default.groups![2]);
    expect(fills).not.toContain(defaultTheme.bar.default.highlight);
  });

  it('yields the whole ramp to `<BarChart colors>` — an override owns the scale', () => {
    // Half-honouring it would be worse than either: pairing the call site's
    // hue with the *ramp's* receded counterpart dims a colour to something
    // that belongs to a different colour entirely. So an override drops the
    // dimmed ramp too, back to the flat `dimmed`.
    const selected: SelectInfo = {
      id: 's',
      key: 0,
      value: 2,
      color: '#000',
      label: 'g0',
    };
    const overridden = (
      <BarChart
        series={stack(4)}
        columns={cols4}
        axis="a"
        id="s"
        colors={{ g0: '#111', g1: '#222', g2: '#333', g3: '#444' }}
      />
    );
    // At rest the override paints every segment — the ramp is out of it.
    expect(new Set(drawFills(overridden))).toEqual(
      new Set(['#111', '#222', '#333', '#444']),
    );
    // With a selection, the receded bins fall back to the flat `dimmed`
    // rather than to ramp entries that no longer correspond to anything.
    const fills = drawFills(overridden, { selected: [selected] });
    expect(fills).toContain(defaultTheme.bar.default.dimmed);
    for (const d of defaultTheme.bar.default.groupsDimmed!) {
      expect(fills).not.toContain(d);
    }
  });
});

// ── the drag band ───────────────────────────────────────────────────────────

/** The minimum `ResolvedCursorFrame` `renderBrushBand` reads. `dragging`
 *  defaults to true — the band's edged form is the one a theme is describing,
 *  and the resting form is the deliberate exception each caller opts into. */
function frame(
  theme: ChartTheme,
  band: { x0: number; x1: number } | null,
  dragging = true,
) {
  return {
    bandDragging: dragging,
    cursorX: 40,
    cursorY: null,
    rowKey: null,
    hoveredRowKey: null,
    samples: [],
    flags: [],
    pointer: null,
    band,
    bandLine: false,
    formattedTime: null,
    plotWidth: 200,
    rowHeight: 100,
    isFirstRow: true,
    theme,
    xAxis: null,
  } satisfies ResolvedCursorFrame;
}

describe('theme.brush — the drag band routes through the theme', () => {
  it('paints defaultTheme’s band in the SELECTION blue at 7%, with 1px edges', () => {
    // The coherence the palette asks for: a live sweep is a selection being
    // made, so the band is the selection hue — not the resting teal, and not
    // the neutral cursor ink it used to be.
    const { container } = render(
      <svg>{renderBrushBand(frame(defaultTheme, { x0: 20, x1: 80 }))}</svg>,
    );
    const rect = container.querySelector('rect')!;
    expect(rect.getAttribute('fill')).toBe('rgba(63,91,224,0.07)');
    // The alpha is baked into the colour, so the element is fully opaque —
    // otherwise 7% would be multiplied by the legacy 0.12 and vanish.
    expect(rect.getAttribute('opacity')).toBe('1');

    const edges = Array.from(container.querySelectorAll('line'));
    expect(edges).toHaveLength(2);
    expect(edges.map((l) => l.getAttribute('x1'))).toEqual(['20', '80']);
    for (const l of edges) {
      expect(l.getAttribute('stroke')).toBe('rgba(63,91,224,0.45)');
      expect(l.getAttribute('stroke-width')).toBe('1');
    }
  });

  it('falls back to the pre-token look when a theme sets no `brush`', () => {
    // Back-compat by construction: a hand-built theme's band must not shift.
    const { brush: _dropped, ...noBrush } = defaultTheme;
    const { container } = render(
      <svg>{renderBrushBand(frame(noBrush, { x0: 20, x1: 80 }))}</svg>,
    );
    const rect = container.querySelector('rect')!;
    expect(rect.getAttribute('fill')).toBe(defaultTheme.cursor);
    expect(rect.getAttribute('opacity')).toBe('0.12');
    // …and no edges, which is what it drew before the token existed.
    expect(container.querySelectorAll('line')).toHaveLength(0);
  });

  it('draws no edges with no band, however the theme is set', () => {
    const { container } = render(
      <svg>{renderBrushBand(frame(defaultTheme, null))}</svg>,
    );
    expect(container.querySelectorAll('rect')).toHaveLength(0);
    expect(container.querySelectorAll('line')).toHaveLength(0);
  });

  it('a RESTING band is the wash alone — the edges belong to the gesture', () => {
    // The band renders in two states: previewing the block a drag would
    // select, and tracking a drag in flight. The edges are what separate
    // them — they mark a boundary the pointer has actually grabbed, so
    // drawing them at rest would assert a range nobody has made.
    const { container } = render(
      <svg>
        {renderBrushBand(frame(defaultTheme, { x0: 20, x1: 80 }, false))}
      </svg>,
    );
    // The wash still paints, identically — only the edges are withheld.
    const rect = container.querySelector('rect')!;
    expect(rect.getAttribute('fill')).toBe('rgba(63,91,224,0.07)');
    expect(rect.getAttribute('opacity')).toBe('1');
    expect(container.querySelectorAll('line')).toHaveLength(0);
  });
});
