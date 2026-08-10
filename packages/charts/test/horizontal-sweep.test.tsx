/**
 * **A horizontal `<BarChart>` sweeps — on the y axis** ([PND-HSWEEP]).
 *
 * `beginSweep` was wired vertical-only on every bar path, on the reasoning
 * that "the pointer sweeps in x-axis units and a horizontal chart's x is the
 * value axis". True, and the conclusion drawn from it — that this needed 2-D
 * machinery — was not: a vertical bar's sweep ignores the value axis
 * completely, so its transpose ignores it too. The cut is 1-D on the *other*
 * axis, and `sweep1D` is reused verbatim.
 *
 * So what these tests pin is not the session (which is the same object a
 * vertical chart builds, already covered) but the **gesture wiring around
 * it**, which is where all three of the wave's bugs lived (RFC A8.5): which
 * pointer coordinate reaches `update`, which axis the drag slop measures, and
 * which way the band is drawn.
 */
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import { MultiSelector } from '../src/selectors.js';
import type {
  SelectInfo,
  SelectModifiers,
  SpanSelection,
} from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const ROW_H = 200;
const PLOT_W = 320;
const T = (i: number) => i * 1000;

/** Five bars on a 1s grid — bins `[0,1000) … [4000,5000)`. */
const bars = () =>
  new TimeSeries({
    name: 'x',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: Array.from({ length: 5 }, (_, i) => [[T(i), T(i + 1)], i + 1]) as [
      [number, number],
      number,
    ][],
  });

/**
 * Mount a bar chart in the given orientation under a `<MultiSelector>`, and
 * hand back a pointer driver plus the last release payload.
 *
 * The **bin** axis is what the y scale has to carry on a horizontal chart, so
 * `<YAxis>` is pinned to the bin range rather than the value range — that is
 * genuinely what `<BarChart orientation="horizontal">` puts there.
 */
function mount(orientation: 'vertical' | 'horizontal') {
  const seen: Array<{
    hits: readonly SelectInfo[];
    mods: SelectModifiers | undefined;
    span: SpanSelection | null;
  }> = [];
  const stub = stubCanvasContext();
  let dom: HTMLElement;
  try {
    dom = render(
      <ChartContainer range={[0, 5000]} width={PLOT_W}>
        <MultiSelector
          onSelect={(hits, mods, spans) =>
            seen.push({ hits, mods, span: spans[0] ?? null })
          }
        />
        <ChartRow height={ROW_H}>
          <YAxis
            id="a"
            min={0}
            max={orientation === 'horizontal' ? 5000 : 10}
          />
          <Layers>
            <BarChart
              series={bars()}
              column="v"
              axis="a"
              id="s"
              orientation={orientation}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    ).container;
  } finally {
    stub.restore();
  }
  const surface = dom.querySelector('canvas')!.parentElement!;
  const ev = (
    type: string,
    x: number,
    y: number,
    buttons: number,
    meta = false,
  ) =>
    act(() => {
      surface.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          buttons,
          metaKey: meta,
          pointerId: 1,
        }),
      );
    });
  return {
    dom,
    seen,
    /** Press at `a`, move to `b`, release — one whole gesture. */
    drag(
      a: readonly [number, number],
      b: readonly [number, number],
      meta = false,
    ) {
      ev('pointerdown', a[0], a[1], 1, meta);
      ev('pointermove', b[0], b[1], 1, meta);
      ev('pointerup', b[0], b[1], 0, meta);
    },
    /** Press, move, and stop — the drag still held, so the band is live. */
    hold(a: readonly [number, number], b: readonly [number, number]) {
      ev('pointerdown', a[0], a[1], 1);
      ev('pointermove', b[0], b[1], 1);
    },
    /** Every plot `<rect>`, as `x,y,w,h`. */
    rects: () =>
      Array.from(dom.querySelectorAll('svg rect')).map((r) => ({
        x: Number(r.getAttribute('x')),
        y: Number(r.getAttribute('y')),
        w: Number(r.getAttribute('width')),
        h: Number(r.getAttribute('height')),
      })),
  };
}

describe('the cut comes from the pointer’s y', () => {
  it('a vertical drag over a horizontal chart commits a multi-bin span', () => {
    const t = mount('horizontal');
    // Down the middle of the plot: on a horizontal chart the x here is the
    // VALUE axis, and it is deliberately doing no work — every bin is
    // captured or not by its y alone.
    t.drag([160, 20], [160, 120]);
    expect(t.seen).toHaveLength(1);
    const { hits, span } = t.seen[0]!;
    expect(span).not.toBeNull();
    expect(span!.id).toBe('s');
    // The span is in BIN-axis units whatever the orientation
    // (`SpanSelection.x`'s own contract), so it reads as a key interval, not
    // as pixels and not as the value axis.
    expect(span!.x[0]).toBeLessThan(span!.x[1]);
    expect(span!.x[0]).toBeGreaterThanOrEqual(0);
    expect(span!.x[1]).toBeLessThanOrEqual(5000);
    // A y window of half the row over a 5-bin axis takes more than one bin —
    // the point of a sweep. Each hit's key must sit inside the span, or the
    // committed descriptor doesn't reproduce the set it was built from.
    expect(hits.length).toBeGreaterThan(1);
    for (const h of hits) {
      expect(h.key).toBeGreaterThanOrEqual(span!.x[0]);
      expect(h.key).toBeLessThan(span!.x[1]);
    }
    // 1-D: no second dimension is claimed. A rect here would be
    // value-filtering, which the vertical chart has never had.
    expect(span!.y).toBeUndefined();
    expect(span!.rows).toBeUndefined();
  });

  it('a longer drag takes strictly more bins — the y window is doing the work', () => {
    // The assertion above passes for a wiring that captures a fixed set and
    // ignores the pointer entirely. This one cannot: it compares two drags
    // that differ only in how far down they go.
    const near = mount('horizontal');
    near.drag([160, 20], [160, 60]);
    const far = mount('horizontal');
    far.drag([160, 20], [160, 180]);
    expect(far.seen[0]!.hits.length).toBeGreaterThan(near.seen[0]!.hits.length);
  });

  it('modifiers reach the transposed release', () => {
    // Everything a consumer builds on top — additive selections, the
    // demote-on-edit toggle — reads `modifiers` off the release. It travels
    // the same path either orientation, and the whole point of the
    // transposed cut being the SAME gesture is that a consumer's handling is
    // the same code; a `modifiers` that arrived `undefined` here would make
    // that quietly false and only show up in a story.
    const plain = mount('horizontal');
    plain.drag([160, 20], [160, 120]);
    expect(plain.seen[0]!.mods?.additive ?? false).toBe(false);

    const additive = mount('horizontal');
    additive.drag([160, 20], [160, 120], true);
    expect(additive.seen[0]!.mods?.additive).toBe(true);
    // …and the modifier changes nothing about WHAT was captured — it is the
    // consumer's business, not the session's.
    expect(additive.seen[0]!.span).toEqual(plain.seen[0]!.span);
  });

  it('a drag UPWARD captures the same bins as the same drag downward', () => {
    // The window arrives unordered — `yScale.invert` on a descending axis
    // hands back the larger number first — and the session's cut is
    // half-open, so an unsorted pair silently captures nothing.
    const down = mount('horizontal');
    down.drag([160, 40], [160, 160]);
    const up = mount('horizontal');
    up.drag([160, 160], [160, 40]);
    expect(up.seen[0]!.hits.map((h) => h.key)).toEqual(
      down.seen[0]!.hits.map((h) => h.key),
    );
  });
});

describe('the slop is on the axis the gesture cuts', () => {
  it('a purely HORIZONTAL drag over a horizontal chart never sweeps', () => {
    // The mirror of the rule a vertical chart has always had (a vertical
    // wobble under a still x stays a click). Measuring |dx| on a transposed
    // row would arm the sweep on exactly the movement that means nothing
    // there — and, worse, leave the real gesture unstartable.
    const t = mount('horizontal');
    t.drag([40, 100], [280, 100]);
    // No sweep committed. (A click may still select one mark through the
    // click path; what must not happen is a swept span.)
    expect(t.seen.filter((s) => s.span !== null)).toHaveLength(0);
  });

  it('…and a purely VERTICAL drag over a VERTICAL chart still never sweeps', () => {
    // The pair, kept so the change reads as a transposition rather than a
    // loosening: the x rule is untouched.
    const t = mount('vertical');
    t.drag([160, 20], [160, 180]);
    expect(t.seen.filter((s) => s.span !== null)).toHaveLength(0);
  });

  it('a vertical chart still sweeps on x', () => {
    const t = mount('vertical');
    t.drag([40, 180], [280, 180]);
    expect(t.seen).toHaveLength(1);
    expect(t.seen[0]!.span).not.toBeNull();
    // Only that a horizontal drag commits a span is asserted — how MANY bins
    // it takes under jsdom's zero-sized rects is a harness artefact (`main`
    // captures the same single bin here), and pinning it would pin that.
    expect(t.seen[0]!.hits.length).toBeGreaterThan(0);
  });
});

describe('the band is drawn transposed, and the x band is suppressed', () => {
  it('a live y sweep paints a full-WIDTH band bounded on y', () => {
    const t = mount('horizontal');
    t.hold([160, 30], [160, 130]);
    const rs = t.rects();
    // Spans the plot from x=0, shorter than the row — the transpose of the x
    // band's full-height-narrow-width. A wrong-axis band is exactly the other
    // shape, so the two assertions together cannot both pass on the old
    // renderer. (Width is compared against the PLOT, which is narrower than
    // the container by the y-axis gutter — hence `x === 0` plus a floor
    // rather than an equality against `PLOT_W`.)
    const band = rs.filter((r) => r.x === 0 && r.h > 0 && r.h < ROW_H);
    expect(band).toHaveLength(1);
    expect(band[0]!.w).toBeGreaterThan(PLOT_W / 2);
    // …and nothing full-height: `sweeping` alone used to resolve an x band
    // from the pointer's bucket, which would lay a column across the very
    // band the drag is drawing.
    expect(rs.filter((r) => r.h === ROW_H)).toHaveLength(0);
  });

  it('the band tracks the cut, not the raw pointer — it snaps to bin edges', () => {
    // The y band takes its geometry from `SweepSession.extent()`, so it shows
    // the snapped-outward run the release will actually deliver. Two drags
    // whose endpoints differ by a sub-bin nudge therefore paint the SAME
    // band; a band drawn from raw pixels would differ by that nudge.
    const bandOf = (y1: number) => {
      const t = mount('horizontal');
      t.hold([160, 30], [160, y1]);
      const b = t.rects().filter((r) => r.x === 0 && r.h > 0 && r.h < ROW_H);
      cleanup();
      return b.map((r) => `${r.y}+${r.h}`);
    };
    const a = bandOf(100);
    const b = bandOf(103);
    expect(a).toHaveLength(1);
    expect(a).toEqual(b);
  });
});

/** The funnel shape — categories on y as unit slots `[i, i+1)`. */
const STAGES = [
  { label: 'Visited', value: 12400 },
  { label: 'Signed up', value: 5200 },
  { label: 'Activated', value: 2100 },
  { label: 'Subscribed', value: 780 },
  { label: 'Renewed', value: 410 },
];

/**
 * The categorical twin of {@link mount}: a horizontal `<BarChart categories>`,
 * whose bin axis is **ordinal slots** rather than a continuous key range.
 *
 * The y axis is left to auto-fit — a horizontal categorical chart derives its
 * slot domain `[0, N]` from the layer, and pinning it here would test the
 * harness rather than the chart.
 */
function mountCategorical() {
  const seen: Array<{
    hits: readonly SelectInfo[];
    mods: SelectModifiers | undefined;
    span: SpanSelection | null;
  }> = [];
  const stub = stubCanvasContext();
  let dom: HTMLElement;
  try {
    dom = render(
      <ChartContainer width={PLOT_W}>
        <MultiSelector
          onSelect={(hits, mods, spans) =>
            seen.push({ hits, mods, span: spans[0] ?? null })
          }
        />
        <ChartRow height={ROW_H}>
          <YAxis id="stage" width={96} />
          <Layers>
            <BarChart
              categories={STAGES}
              orientation="horizontal"
              axis="stage"
              id="funnel"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    ).container;
  } finally {
    stub.restore();
  }
  const surface = dom.querySelector('canvas')!.parentElement!;
  const ev = (type: string, x: number, y: number, buttons: number) =>
    act(() => {
      surface.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          buttons,
          pointerId: 1,
        }),
      );
    });
  return {
    dom,
    seen,
    drag(y0: number, y1: number) {
      ev('pointerdown', 160, y0, 1);
      ev('pointermove', 160, y1, 1);
      ev('pointerup', 160, y1, 0);
    },
    hold(y0: number, y1: number) {
      ev('pointerdown', 160, y0, 1);
      ev('pointermove', 160, y1, 1);
    },
    bandRect: () =>
      Array.from(dom.querySelectorAll('svg rect'))
        .map((r) => ({
          x: Number(r.getAttribute('x')),
          y: Number(r.getAttribute('y')),
          h: Number(r.getAttribute('height')),
        }))
        .filter((r) => r.x === 0 && r.h > 0 && r.h < ROW_H),
  };
}

describe('a CATEGORICAL y axis sweeps the same way', () => {
  // The one combination the transposed cut could plausibly have got wrong.
  // On a *vertical* categorical chart the bin axis is a d3 **band** scale,
  // whose `invert` snaps a pixel to the slot CENTRE — which is why the
  // vertical path publishes `binIntervals` so its band can still snap
  // outward to slot edges (see `BarChart`'s `binBuckets`). Transposed, the
  // bins land on y as a plain **linear** scale over `[0, N]` and only the
  // TICKS are categorical (`binCategories`, consumed by `<YAxis>`), so
  // `yScale.invert` is continuous and no such correction is needed. These
  // pin that reading rather than trusting it.

  it('a vertical drag takes whole slots, and names the categories', () => {
    const t = mountCategorical();
    // Slot 0 sits at the BOTTOM (value 0..1 on an ascending axis), so a drag
    // across the middle of the plot takes the middle of the funnel.
    t.drag(50, 130);
    expect(t.seen).toHaveLength(1);
    const { hits, span } = t.seen[0]!;
    expect(span).not.toBeNull();
    expect(span!.id).toBe('funnel');
    // Slot units, and snapped to whole slots — integers, not the fractional
    // positions the pointer actually landed on.
    expect(span!.x[0]).toBe(Math.round(span!.x[0]));
    expect(span!.x[1]).toBe(Math.round(span!.x[1]));
    expect(span!.x[1] - span!.x[0]).toBe(hits.length);
    // Each hit names its category, and the run is CONTIGUOUS in the declared
    // order — a sweep that cut on the wrong axis, or read slot positions as
    // values, would still produce labels but not an unbroken run of them.
    const idx = hits.map((h) => STAGES.findIndex((c) => c.label === h.label));
    expect(idx.every((i) => i >= 0)).toBe(true);
    const sorted = [...idx].sort((a, b) => a - b);
    expect(sorted[sorted.length - 1]! - sorted[0]!).toBe(sorted.length - 1);
    expect(hits.length).toBeGreaterThan(1);
    expect(hits.length).toBeLessThan(STAGES.length);
  });

  it('the band lands on slot EDGES, not on the pointer', () => {
    // The band is derived from `SweepSession.extent()`, so on a 5-slot axis
    // over a 200px row every edge must fall on a 40px boundary however
    // untidily the drag ended.
    const t = mountCategorical();
    t.hold(50, 133);
    const band = t.bandRect();
    expect(band).toHaveLength(1);
    const slotPx = ROW_H / STAGES.length;
    // A multiple of the slot height — not `% slotPx === 0`, which a pixel
    // that arrives as 39.99999999999999 fails while sitting exactly on the
    // edge it is supposed to.
    const slots = (v: number) => v / slotPx;
    expect(slots(band[0]!.y)).toBeCloseTo(Math.round(slots(band[0]!.y)), 6);
    expect(slots(band[0]!.h)).toBeCloseTo(Math.round(slots(band[0]!.h)), 6);
    // …and it is a real span of slots, not a degenerate zero-height one that
    // would satisfy the two assertions above for free.
    expect(Math.round(slots(band[0]!.h))).toBeGreaterThan(0);
  });

  it('a whole-plot drag takes every category', () => {
    const t = mountCategorical();
    t.drag(2, ROW_H - 2);
    expect(t.seen[0]!.hits).toHaveLength(STAGES.length);
    expect(t.seen[0]!.span!.x).toEqual([0, STAGES.length]);
  });

  it('a horizontal drag still never sweeps a categorical row either', () => {
    const t = mountCategorical();
    t.drag(100, 100);
    expect(t.seen.filter((s) => s.span !== null)).toHaveLength(0);
  });
});

describe('the committed span replays', () => {
  it('feeding the span back as `selected` re-selects the swept bars', () => {
    // The whole point of the span currency: a consumer stashes it and hands
    // it back. If the span's units were pixels or the value axis, this is
    // where it would show up — the chart would light nothing.
    let captured: SpanSelection | null = null;
    function Harness() {
      const [sel, setSel] = useState<readonly SpanSelection[]>([]);
      useEffect(() => {
        captured = sel[0] ?? null;
      }, [sel]);
      return (
        <ChartContainer range={[0, 5000]} width={PLOT_W} selected={sel}>
          <MultiSelector onSelect={(_h, _m, spans) => setSel([...spans])} />
          <ChartRow height={ROW_H}>
            <YAxis id="a" min={0} max={5000} />
            <Layers>
              <BarChart
                series={bars()}
                column="v"
                axis="a"
                id="s"
                orientation="horizontal"
              />
            </Layers>
          </ChartRow>
        </ChartContainer>
      );
    }
    const stub = stubCanvasContext();
    let dom: HTMLElement;
    try {
      dom = render(<Harness />).container;
    } finally {
      stub.restore();
    }
    const surface = dom.querySelector('canvas')!.parentElement!;
    const ev = (type: string, y: number, buttons: number) =>
      act(() => {
        surface.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: 160,
            clientY: y,
            buttons,
            pointerId: 1,
          }),
        );
      });
    ev('pointerdown', 30, 1);
    ev('pointermove', 150, 1);
    ev('pointerup', 150, 0);
    expect(captured).not.toBeNull();
    expect(captured!.x[1]).toBeGreaterThan(captured!.x[0]);
  });
});
