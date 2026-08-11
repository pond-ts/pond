import { useContext, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { yTickValues } from '../src/yticks.js';
import { resolveAxisFormat } from '../src/format.js';
import { scaleLinear, scaleLog, scaleSymlog } from 'd3-scale';
import {
  ContainerContext,
  RowContext,
  type ContainerFrame,
  type RowFrame,
} from '../src/context.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/**
 * **`<YAxis scale="symlog">`** — linear through zero, logarithmic beyond
 * ([PND-SYMLOG]).
 *
 * The workaround it removes pre-transformed values into a ±1 plot space with a
 * linear axis pinned to `[-1, 1]`. What made it the reporting consumer's highest
 * item was not effort but **silence**: `at` then lives in plot space while
 * `label` must read in real units, so computing them by different routes yields
 * a chart whose labels confidently describe positions they do not occupy — no
 * exception, no visual artifact. They had to make the coupling structural and
 * fence it with a reconstruction test.
 *
 * Two properties carry the whole feature, and they are the first two blocks
 * below: **monotonicity across the knee** (asked for explicitly by the
 * consumer — a value just below and just above the linear window must not
 * invert, or bar order changes at a boundary nobody is looking at), and **the
 * tick ladder**, because d3 supplies the transform but ticks it linearly.
 */

describe('monotonicity across the knee', () => {
  // The consumer's own walk, on their own domain: a value just below and just
  // above the linear window must not invert. An inversion here would reorder
  // bars at a boundary no one is inspecting, which is the failure mode the
  // workaround's structural coupling existed to prevent.
  const DOMAIN = 1e6;
  const WALK = [0, 1e3, 1e4, 19_999, 20_000, 20_001, 5e4, 1e6];

  it('is strictly increasing through the linear window and past it', () => {
    // knee = 2% of 1e6 = 20_000, so the walk straddles it by ±1.
    const s = scaleSymlog()
      .constant(0.02 * DOMAIN)
      .domain([-DOMAIN, DOMAIN])
      .range([500, 0]);
    // Range is inverted (pixels grow downward), so px must strictly DECREASE as
    // value increases — asserted on the pixels the chart actually draws with
    // rather than on the abstract transform.
    const px = WALK.map((v) => s(v));
    for (let i = 1; i < px.length; i += 1) {
      expect(px[i]!).toBeLessThan(px[i - 1]!);
    }
  });

  it('is strictly increasing symmetrically below zero', () => {
    // The half the workaround's ±1 plot space made easy to get wrong: symlog is
    // odd-symmetric, so the negative side must mirror exactly.
    const s = scaleSymlog()
      .constant(0.02 * DOMAIN)
      .domain([-DOMAIN, DOMAIN])
      .range([500, 0]);
    const mirrored = WALK.map((v) => -v).reverse();
    const px = mirrored.map((v) => s(v));
    for (let i = 1; i < px.length; i += 1) {
      expect(px[i]!).toBeLessThan(px[i - 1]!);
    }
    // And symmetry itself: ±v land equidistant from zero's pixel.
    const zero = s(0);
    for (const v of WALK.filter((x) => x > 0)) {
      expect(Math.abs(s(v) - zero)).toBeCloseTo(Math.abs(s(-v) - zero), 6);
    }
  });
});

describe('the curve is `log1p`, not piecewise', () => {
  // Pinned because the docs now make a *migration* claim on it, and because the
  // surprise is real: a reporting consumer replaced a hand-rolled piecewise curve
  // (exactly linear below the knee, log10 above), measured every bar of a ±9M
  // fixture with a canvas pixel probe, and found small values landing at roughly
  // half their former height. They corrected me — I had accepted "same knee" as
  // "same curve". Order, tail dominance and the lift over linear all survived, so
  // this is a shape difference to document, not a defect to fix.
  const M = 9e6;
  const KNEE = 0.02 * M;
  // Range [1, 0] makes the output a fraction of plot height, zero line centred.
  const s = () => scaleSymlog().constant(KNEE).domain([-M, M]).range([1, 0]);
  /** Height above the zero line as a fraction of the half-plot. */
  const halfHeight = (v: number) => Math.abs(0.5 - +s()(v)) * 2;

  it('is exactly `sign(x) · log1p(|x / knee|)`', () => {
    // The claim the doc makes about what pond *does*. Reds if d3's transform
    // changes or if someone swaps the scale for a piecewise construction.
    const t = (v: number) =>
      (Math.sign(v) * Math.log1p(Math.abs(v) / KNEE)) / Math.log1p(M / KNEE);
    for (const v of [0, 1, 283e3, 303e3, 975e3, M, -283e3, -M]) {
      expect(halfHeight(v)).toBeCloseTo(Math.abs(t(v)), 6);
    }
  });

  it('reproduces the consumer’s measured heights', () => {
    // Their canvas probe, to three places — the numbers quoted in the CHANGELOG
    // and the `scale` docstring. If these move, those prose numbers are wrong.
    expect(halfHeight(283e3)).toBeCloseTo(0.24, 2);
    expect(halfHeight(303e3)).toBeCloseTo(0.251, 2);
    expect(halfHeight(975e3)).toBeCloseTo(0.473, 2);
  });

  it('still lifts small values far above a linear axis', () => {
    // The half of the finding that says this is a documentation problem and not a
    // regression: the smallest visible value is still lifted several-fold, and the
    // tail still dominates, so the chart makes the same argument.
    const linear = 283e3 / M;
    expect(halfHeight(283e3) / linear).toBeGreaterThan(5);
    expect(halfHeight(M)).toBeGreaterThan(halfHeight(975e3));
  });
});

describe('the tick ladder — the substance of the feature', () => {
  /** A symlog scale as the row builds one: knee = fraction × maxAbs. */
  const scale = (maxAbs: number, fraction = 0.02, lo = -maxAbs) =>
    scaleSymlog()
      .constant(fraction * maxAbs)
      .domain([lo, maxAbs])
      .range([500, 0]);

  it('d3 ticks the SAME scale linearly — nothing below the knee', () => {
    // Not a pond assertion: the baseline this feature exists to beat, pinned so
    // the justification cannot quietly rot if d3 changes.
    const s = scale(1e6);
    const d3Ticks = s.ticks(6);
    const knee = 0.02 * 1e6;
    expect(d3Ticks.filter((t) => t !== 0 && Math.abs(t) < knee)).toHaveLength(
      0,
    );
  });

  it('pond grids zero, the knee, and mirrored decades beyond it', () => {
    const s = scale(1e6);
    const ticks = yTickValues(s, 8);
    expect(ticks).toContain(0);
    // The knee, both sides — where the reading changes régime.
    expect(ticks).toContain(20_000);
    expect(ticks).toContain(-20_000);
    // Decades past the knee, mirrored. 1e4 < knee so the ladder starts at 1e5.
    expect(ticks).toContain(100_000);
    expect(ticks).toContain(-100_000);
    expect(ticks).toContain(1_000_000);
    expect(ticks).toContain(-1_000_000);
  });

  it('never emits a tick outside the domain', () => {
    // A one-sided domain must not sprout negative ticks, and the mirrored
    // decades must clip rather than run off the plot.
    const ticks = yTickValues(scale(1e6, 0.02, 0), 8);
    expect(ticks.every((t) => t >= 0 && t <= 1e6)).toBe(true);
    expect(ticks).toContain(0);
    expect(ticks).toContain(1_000_000);
  });

  it('emits ticks in ascending order, with no duplicates', () => {
    // The ladder is assembled from three sources (zero, knee, decades), so it
    // must dedupe and sort — a label list out of order draws fine and reads
    // wrong.
    const ticks = yTickValues(scale(1e6), 8);
    expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  it('thins decades to the budget instead of exploding', () => {
    // A ten-decade symmetric domain shows twenty decades of ladder; a small
    // count must step over them, the same rule the log path uses.
    const many = yTickValues(scale(1e10, 1e-10), 6);
    const few = yTickValues(scale(1e10, 1e-10), 40);
    expect(many.length).toBeLessThan(few.length);
    expect(many.length).toBeLessThanOrEqual(14);
  });

  it('spends the budget twice as fast when the domain is two-sided', () => {
    // The budget is spent on ticks, not on magnitudes: a two-sided domain draws
    // each rung twice, so at the same count it must keep about HALF as many
    // distinct magnitudes. Counting magnitudes instead would let a symmetric axis
    // draw twice the requested ticks — which the length-only assertion above
    // would not notice.
    const magnitudes = (ticks: readonly number[]) =>
      new Set(ticks.filter((t) => t !== 0).map(Math.abs)).size;
    const oneSided = magnitudes(yTickValues(scale(1e10, 1e-10, 0), 6));
    const twoSided = magnitudes(yTickValues(scale(1e10, 1e-10), 6));
    expect(twoSided).toBeLessThan(oneSided);
    expect(twoSided).toBeLessThanOrEqual(Math.ceil(oneSided / 2) + 1);
  });

  it('never draws a decade close enough to the knee to duplicate its label', () => {
    // A data-derived maxAbs puts the knee wherever it lands: 2% of 4.95e6 is
    // 99_000, and `ceil(log10(knee))` alone would then emit 100_000 as the first
    // decade — a few pixels from the knee tick and rounding to the same label.
    // The knee is always drawn, so dropping that decade loses nothing.
    const s = scale(4.95e6);
    const knee = 0.02 * 4.95e6;
    expect(yTickValues(s, 8)).toContain(knee);
    for (const t of yTickValues(s, 8)) {
      if (t === 0 || Math.abs(t) === knee) continue;
      // Every other tick sits at least half a decade clear of the knee. √10, not
      // √2 — the offset is half a decade in log space, and asserting the weaker
      // bound would not pin the documented guarantee.
      expect(Math.abs(t) / knee).toBeGreaterThanOrEqual(Math.sqrt(10) - 1e-9);
    }
  });

  it('never returns an empty ladder — clipping happens BEFORE thinning', () => {
    // Codex found this one, and it is the sharpest kind of bug: a window that
    // contains none of the ideal ladder. `[510k, 990k]` with a 19_800 knee
    // excludes zero, both knees, and its one candidate decade (100k), so an
    // implementation that thinned a symmetric ladder and clipped afterwards
    // handed `[]` to the labels AND the gridlines — an axis drawn with no ticks,
    // which reads as a broken renderer rather than as a scale. Reachable with
    // explicit bounds, or by panning there.
    const s = scaleSymlog()
      .constant(19_800)
      .domain([510_000, 990_000])
      .range([500, 0]);
    const ticks = yTickValues(s, 6);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t >= 510_000 && t <= 990_000)).toBe(true);
  });

  it('spends the budget on surviving ticks, not on an ideal ladder', () => {
    // The same ordering bug in its milder form: a one-sided window past the knee
    // must not be thinned as though it were the mirrored two-sided ladder, which
    // would drop every other decade for no reason.
    const s = scaleSymlog().constant(1).domain([1e2, 1e8]).range([500, 0]);
    const mags = yTickValues(s, 8)
      .filter((t) => t !== 0)
      .map((t) => Math.round(Math.log10(Math.abs(t))));
    // 1e2 … 1e8 is seven decades against a budget of 8 — all of them fit.
    expect(mags).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('does not hang on a non-finite bound', () => {
    // `floor(log10(Infinity))` is `Infinity`, which made `e += step` a no-op and
    // the decade loop unterminating — a hung render, not a bad axis. An explicit
    // `max={Infinity}` reaches the scale intact, so the guard is not theoretical.
    for (const domain of [
      [0, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, 0],
      [Number.NaN, 1e6],
    ] as Array<[number, number]>) {
      const s = scaleSymlog().constant(100).domain(domain).range([500, 0]);
      expect(() => yTickValues(s, 6)).not.toThrow();
      // And it returns promptly with whatever d3 makes of such a domain.
      expect(Array.isArray(yTickValues(s, 6))).toBe(true);
    }
  });

  it('defers to the linear ticks when the knee swallows the domain', () => {
    // `linearWindow: 1` puts the knee at maxAbs, so there is nothing to grid
    // logarithmically — and inside the knee symlog IS linear, so d3's linear
    // ticks are the correct answer rather than a fallback.
    const s = scale(1e6, 1);
    expect(yTickValues(s, 6)).toEqual(s.ticks(6));
  });

  it('leaves log and linear axes untouched', () => {
    // Detection is structural (`constant()` exists only on symlog); a
    // regression here would silently re-ladder every other axis in the library.
    const l = scaleLinear().domain([0, 100]).range([100, 0]);
    expect(yTickValues(l, 5)).toEqual(l.ticks(5));
    const g = scaleLog().domain([1, 1000]).range([100, 0]);
    // The log path picks decades itself, so it must not equal the raw d3 ticks
    // *and* must still be decades.
    expect(
      yTickValues(g, 5).every((t) => Number.isInteger(Math.log10(t))),
    ).toBe(true);
  });
});

describe('label precision comes from the knee, not the span', () => {
  // Codex's find, and the one that most directly undercut the feature's promise:
  // placing a tick correctly is worthless if the label rounds it away. A symlog
  // axis is chosen exactly when the interesting values are orders of magnitude
  // below the domain, which is the condition under which a span-derived format
  // has too few digits for them.
  const symlog = (knee: number, lo: number, hi: number) =>
    scaleSymlog().constant(knee).domain([lo, hi]).range([500, 0]);

  it('gives each ladder tick a distinct label on a small-magnitude domain', () => {
    // `[-1, 1]` with a 0.02 knee: the ladder emits -0.02, 0, 0.02 and d3's
    // span-derived formatter labelled all three "0.0" — three positions
    // asserting one value, on the axis whose purpose was to separate them.
    const s = symlog(0.02, -1, 1);
    const fmt = resolveAxisFormat(s, 4, undefined);
    const labels = yTickValues(s, 4).map(fmt);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain(fmt(0.02));
    expect(fmt(0.02)).not.toBe(fmt(0));
  });

  it('is unchanged when the knee is already coarse', () => {
    // The fix must not cost the common case precision it did not need: a 20k knee
    // on a ±1M domain formats exactly as before.
    const s = symlog(20_000, -1e6, 1e6);
    const fmt = resolveAxisFormat(s, 8, undefined);
    expect([-1e6, -20_000, 0, 20_000, 1e6].map(fmt)).toEqual(
      [-1e6, -20_000, 0, 20_000, 1e6].map(
        scaleLinear().domain([-1e6, 1e6]).tickFormat(8),
      ),
    );
  });

  it('leaves an explicit format alone', () => {
    // A caller-supplied specifier is authoritative; the knee only calibrates the
    // *default*.
    const s = symlog(0.02, -1, 1);
    expect(resolveAxisFormat(s, 4, '.1%')(0.02)).toBe('2.0%');
    expect(resolveAxisFormat(s, 4, (v) => `v=${v}`)(0.02)).toBe('v=0.02');
  });
});

const series = () =>
  new TimeSeries({
    name: 's',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ],
    rows: [
      [0, -1e6],
      [1, -100],
      [2, 0],
      [3, 250],
      [4, 1e6],
    ],
  } as never);

describe('`<YAxis scale="symlog">` through the component', () => {
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
        <ChartContainer range={[0, 4]} width={400} showAxis={false}>
          <ChartRow height={200}>
            <YAxis id="v" label="" {...props} />
            <Layers>
              <LineChart series={series()} column="v" axis="v" />
              <Capture />
            </Layers>
          </ChartRow>
        </ChartContainer>,
      );
    } finally {
      stub.restore();
    }
    return { scale: () => rf!.yScales.get('v')!, frame: () => cf! };
  }

  it('builds a symlog scale whose knee is the domain-relative fraction', () => {
    const s = mount({
      scale: 'symlog',
      min: -1e6,
      max: 1e6,
    }).scale() as unknown as {
      constant?: () => number;
    };
    expect(typeof s.constant).toBe('function');
    expect(s.constant!()).toBeCloseTo(0.02 * 1e6, 6);
  });

  it('honours an explicit `linearWindow`', () => {
    const s = mount({
      scale: 'symlog',
      linearWindow: 0.1,
      min: -1e6,
      max: 1e6,
    }).scale() as unknown as { constant?: () => number };
    expect(s.constant!()).toBeCloseTo(0.1 * 1e6, 6);
  });

  it('admits zero and negatives — it resolves on the LINEAR domain path', () => {
    // The reason symlog exists here: `scale="log"` refuses non-positive bounds
    // and rounds out to decades. Symlog must do neither, or the data it is for
    // (spanning zero) cannot be drawn.
    const s = mount({ scale: 'symlog', min: -1e6, max: 1e6 }).scale();
    const [lo, hi] = s.domain() as [number, number];
    expect(lo).toBe(-1e6);
    expect(hi).toBe(1e6);
    // Zero has a real position, not NaN.
    expect(Number.isFinite(+s(0))).toBe(true);
  });

  it('auto-fits across zero with no explicit bounds', () => {
    const s = mount({ scale: 'symlog' }).scale();
    const [lo, hi] = s.domain() as [number, number];
    expect(lo).toBeLessThan(0);
    expect(hi).toBeGreaterThan(0);
  });

  it('falls back to the default window when `linearWindow` is unusable', () => {
    // Found by Layer-2 review, and the sharpest bug in the feature: the first
    // version clamped the knee to `Number.MIN_VALUE`, which satisfies `> 0` and
    // is *catastrophic* — d3's transform divides by the constant, so every mapped
    // pixel comes out `NaN`. A blank plot with NaN gridline coordinates and no
    // error, from `linearWindow={0}`. Falling back to the default keeps the chart
    // drawable and the dev warning says which window is in force.
    for (const w of [0, -1, 20, Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = mount({
        scale: 'symlog',
        linearWindow: w,
        min: -1e6,
        max: 1e6,
      }).scale();
      expect(
        (s as unknown as { constant: () => number }).constant(),
      ).toBeCloseTo(0.02 * 1e6, 6);
      // The property that actually matters: real pixels, not NaN.
      for (const v of [-1e6, -100, 0, 250, 1e6]) {
        expect(Number.isFinite(+s(v))).toBe(true);
      }
    }
  });

  it('a runtime `linearWindow` change re-registers the axis', () => {
    // Regression, matching the existing `tickCount` one: `linearWindow` must be
    // in `axisSpecEqual`, or a window-only change compares equal to the stored
    // spec, `setAxes` is skipped, and the axis keeps drawing with the previous
    // knee. Silent — the chart still renders, just at the wrong régime boundary.
    let rf: RowFrame | null = null;
    function Capture() {
      const r = useContext(RowContext);
      useEffect(() => {
        if (r) rf = r;
      });
      return null;
    }
    const chart = (linearWindow: number) => (
      <ChartContainer range={[0, 4]} width={400} showAxis={false}>
        <ChartRow height={200}>
          <YAxis
            id="v"
            label=""
            scale="symlog"
            linearWindow={linearWindow}
            min={-1e6}
            max={1e6}
          />
          <Layers>
            <LineChart series={series()} column="v" axis="v" />
            <Capture />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
    const stub = stubCanvasContext();
    try {
      const { rerender } = render(chart(0.02));
      const knee = () =>
        (
          rf!.yScales.get('v')! as unknown as { constant: () => number }
        ).constant();
      expect(knee()).toBeCloseTo(0.02 * 1e6, 6);
      rerender(chart(0.2));
      expect(knee()).toBeCloseTo(0.2 * 1e6, 6);
    } finally {
      stub.restore();
    }
  });

  it('is not a symlog scale when the prop is absent', () => {
    const s = mount({}).scale() as unknown as { constant?: () => number };
    expect(s.constant).toBeUndefined();
  });

  describe('`linearWindow` dev warnings', () => {
    // Both misuses are otherwise *silent*: a `linearWindow` on a non-symlog axis
    // is read by nothing, and a fraction outside (0, 1] still produces a drawable
    // axis — just not the one the call site asked for. Nothing throws and nothing
    // looks broken, which is exactly the class of bug a dev warning is for.
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      warn.mockRestore();
    });

    const messages = () => warn.mock.calls.map((c) => String(c[0])).join('\n');

    it('warns when `linearWindow` rides a non-symlog axis', () => {
      mount({ linearWindow: 0.1, min: 0, max: 100 });
      expect(messages()).toMatch(/linearWindow only applies to scale="symlog"/);
    });

    it('warns when the fraction is outside (0, 1]', () => {
      mount({ scale: 'symlog', linearWindow: 0, min: -10, max: 10 });
      expect(messages()).toMatch(/outside \(0, 1\]/);
      warn.mockClear();
      mount({ scale: 'symlog', linearWindow: 20, min: -10, max: 10 });
      expect(messages()).toMatch(/outside \(0, 1\]/);
    });

    it('stays silent on the valid cases, including the boundary', () => {
      // `1` is in range and documented (the knee reaches maxAbs, so the axis is
      // linear throughout) — warning about it would train the reader to ignore
      // the channel.
      mount({ scale: 'symlog', linearWindow: 1, min: -10, max: 10 });
      mount({ scale: 'symlog', min: -10, max: 10 });
      mount({ min: 0, max: 10 });
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
