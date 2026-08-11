import { useContext, useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import { barSpanPx } from '../src/range.js';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
} from '../src/context.js';
import { recordingContext, stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * **`maxBarWidth`** ([PND-BARWIDTH]) — the *absolute* half of the bar-width
 * vocabulary, alongside `gap`'s *relative* inset.
 *
 * The workaround it removes: with only `gap`, bar width is always `slot - gap`
 * and fattens as the plot widens, so pinning the ink meant computing `gap` from
 * the band width you predicted the library would choose — a re-derivation of
 * pond's own layout arithmetic in consumer code, which goes silently wrong the
 * moment that rule changes on either side of the boundary.
 *
 * The unit tests come first because the geometry is where the bugs would be; the
 * component tests then confirm the prop actually reaches the ink, and — the part
 * most easily got wrong — that it does **not** reach the hit region.
 */

const identity = (v: number) => v;

describe('barSpanPx — the cap, and how it composes with gap / minWidth', () => {
  it('caps the ink and centres it in the slot', () => {
    // A 100px slot, capped to 20: the bar keeps the slot's centre (50) rather
    // than hugging an edge, so a row of capped bars stays evenly pitched.
    expect(barSpanPx(0, 100, identity, 0, 1, 20)).toEqual([40, 60]);
  });

  it('does nothing when the slot is already narrower than the cap', () => {
    // The cap is a ceiling, not a target — a 10px slot does not grow to 20.
    expect(barSpanPx(0, 10, identity, 0, 1, 20)).toEqual([0, 10]);
  });

  it('reads on the INSET span, so `gap` keeps its meaning', () => {
    // gap 10 → [5, 95] (90 wide); cap 20 then centres → [40, 60]. The bar is
    // never wider than the gap allows *and* never wider than the cap, whichever
    // binds first — so adding a cap can only ever narrow a bar.
    expect(barSpanPx(0, 100, identity, 10, 1, 20)).toEqual([40, 60]);
    // And with the gap binding tighter than the cap, the gap wins.
    expect(barSpanPx(0, 100, identity, 90, 1, 50)).toEqual([45, 55]);
  });

  it('`minWidthPx` still wins — the bounds can never invert the rect', () => {
    // A cap below the floor yields the floor, centred. Without this a
    // `maxBarWidth: 0.5` would produce a sub-pixel or inverted rect.
    const [x0, x1] = barSpanPx(0, 100, identity, 0, 4, 1);
    expect(x1 - x0).toBe(4);
    expect((x0 + x1) / 2).toBe(50);
  });

  it('ignores a non-positive cap rather than collapsing the bar', () => {
    // `0` and negatives read as "no cap", matching how `maxBandWidth > 0` is
    // gated — a mis-computed 0 should not silently erase every bar.
    expect(barSpanPx(0, 100, identity, 0, 1, 0)).toEqual([0, 100]);
    expect(barSpanPx(0, 100, identity, 0, 1, -5)).toEqual([0, 100]);
  });

  it('is a no-op when omitted — the shipped geometry is untouched', () => {
    expect(barSpanPx(0, 100, identity, 10, 1)).toEqual([5, 95]);
  });
});

const series = () =>
  new TimeSeries({
    name: 'b',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ],
    rows: [
      [[0, 100], 5],
      [[100, 200], 8],
    ],
  } as never);

/** Mount a bar chart and hand back the drawn rects plus the hit-tester. */
function mount(props: Record<string, unknown>) {
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
      <ChartContainer range={[0, 200]} width={400} showAxis={false}>
        <ChartRow height={120}>
          <YAxis id="v" min={0} max={10} label="" />
          <Layers>
            <BarChart
              series={series()}
              column="v"
              axis="v"
              id="b"
              gap={0}
              {...props}
            />
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  const layer = () => rf!.layers[0]!.layer;
  return {
    /** Widths of every filled rect the draw emitted. */
    widths(): number[] {
      const { ctx, calls } = recordingContext();
      layer().draw(ctx, cf!.xScale, rf!.yScales.get('v')!);
      return calls
        .filter((c) => c.type === 'call' && c.name === 'fillRect')
        .map((c) => Number(c.args[2]));
    },
    hitAt(px: number, py: number) {
      const yScale = rf!.yScales.get('v')!;
      return layer().hitTest?.(px, py, cf!.xScale, yScale) ?? null;
    },
    /** The plot's own width — NOT the container's, which includes the y gutter. */
    plotWidth(): number {
      return cf!.plotWidth;
    },
  };
}

/**
 * The horizontal twin of `mount`. Bins run down the **y** axis, so the value axis
 * is x — and this arrangement routes through the oriented/transposed path a stack
 * uses, which is what made the hit-target guarantee orientation-dependent.
 */
function mountHorizontal(props: Record<string, unknown>) {
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
      <ChartContainer range={[0, 200]} width={400} showAxis={false}>
        <ChartRow height={200}>
          <YAxis id="v" label="" />
          <Layers>
            <BarChart
              series={series()}
              column="v"
              axis="v"
              id="b"
              orientation="horizontal"
              gap={0}
              {...props}
            />
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
  } finally {
    stub.restore();
  }
  const layer = () => rf!.layers[0]!.layer;
  return {
    hitAt(px: number, py: number) {
      return (
        layer().hitTest?.(px, py, cf!.xScale, rf!.yScales.get('v')!) ?? null
      );
    },
    /** Heights of every filled rect the draw emitted — the bin-axis thickness. */
    heights(): number[] {
      const { ctx, calls } = recordingContext();
      layer().draw(ctx, cf!.xScale, rf!.yScales.get('v')!);
      return calls
        .filter((c) => c.type === 'call' && c.name === 'fillRect')
        .map((c) => Number(c.args[3]));
    },
  };
}

describe('`<BarChart maxBarWidth>` — the prop reaches the ink', () => {
  it('caps the drawn bar width', () => {
    // 200 units over 400px, two bars ⇒ 200px slots. Uncapped they draw 200 wide.
    const uncapped = mount({}).widths();
    expect(Math.max(...uncapped)).toBeGreaterThan(100);
    const capped = mount({ maxBarWidth: 24 }).widths();
    expect(Math.max(...capped)).toBeCloseTo(24, 5);
  });

  it('does NOT narrow the hit target — the ink/hit split is deliberate', () => {
    // A single-series bar hit-tests its whole slot (`barSlotRect`, no gap
    // inset), precisely so a visual affordance never carves a dead channel out
    // of the target. A 24px bar in a wide slot must still be selectable across
    // the slot — otherwise pinning the ink would silently make the chart harder
    // to use, which is the opposite of the point.
    //
    // **Scope note, corrected after review.** On *this* (vertical) path the leak
    // is prevented structurally: `barSlotRect` takes no cap, so wiring one in does
    // not compile. That made this test look like it pinned the whole guarantee —
    // it pinned one orientation. A single-series *horizontal* chart routes through
    // the stacked path instead, where nothing structural stopped the cap, and the
    // guarantee was simply false; see the horizontal test below, which is load-
    // bearing where this one is documentation.
    const m = mount({ maxBarWidth: 24 });
    const slot = m.plotWidth() / 2; // two bars over the plot
    // Points inside the first slot but far outside the 24px ink centred on it.
    expect(m.hitAt(slot * 0.1, 60)).not.toBeNull();
    expect(m.hitAt(slot * 0.9, 60)).not.toBeNull();
  });

  it('is uncapped when omitted, and the theme token is the fallback', () => {
    const uncapped = Math.max(...mount({}).widths());
    // The prop wins over the token; with neither, nothing caps.
    const viaProp = Math.max(...mount({ maxBarWidth: 12 }).widths());
    expect(viaProp).toBeCloseTo(12, 5);
    expect(uncapped).toBeGreaterThan(viaProp);
  });

  it("does NOT narrow a single-series HORIZONTAL bar's hit target either", () => {
    // **Layer-2 review's find.** A single-series *horizontal* chart does not use
    // the vertical single-series path — it routes through the same oriented,
    // transposed path a stack uses (`stackAt`), which is handed the cap so its
    // rect matches the drawn segment. That made the prop's documented guarantee —
    // "a single-series bar hit-tests its whole slot" — true only of vertical
    // charts, and the doc said it without qualification.
    //
    // Fixed by making the guarantee orientation-independent rather than narrowing
    // the claim: the cap reaches the hit rect only for a real *stack*, because the
    // reason for the split is resolving WHICH SEGMENT was hit, and a single-series
    // chart has one segment per slot and nothing to disambiguate.
    const m = mountHorizontal({ maxBarWidth: 8 });
    // Bins run down y: bin 0 occupies the slot y∈[100, 200] of a 200px row, and
    // the cap makes its ink 8px — y∈[146, 154]. Confirm the cap did reach the
    // DRAW first, so this test cannot pass by the prop being ignored outright.
    expect(Math.max(...m.heights())).toBeCloseTo(8, 5);
    // `px` must sit inside the bar's value extent (bar 0 spans x 0…8.75), so
    // these probe the bin axis only — the slot, far outside the 8px ink.
    for (const py of [105, 130, 170, 195]) {
      expect(m.hitAt(4, py)).not.toBeNull();
    }
  });

  it('composes with `gap` — whichever binds tighter wins', () => {
    // Derived from the real slot width rather than assumed: the container's
    // `width` includes the y-axis gutter, so hard-coding pixels here would test
    // the gutter's size as much as the cap.
    const slot = mount({}).plotWidth() / 2;
    const gap = slot - 20; // leaves 20px of ink — tighter than the 50px cap
    const w = Math.max(...mount({ gap, maxBarWidth: 50 }).widths());
    expect(w).toBeCloseTo(20, 4);
  });
});
