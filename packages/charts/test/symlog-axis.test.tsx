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
