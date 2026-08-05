import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { BarChart } from '../src/BarChart.js';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { scaleLinear, scaleLog } from 'd3-scale';
import { logAxisWarning, needsExtents, resolveYDomain } from '../src/domain.js';
import { resolveAxisFormat } from '../src/format.js';
import { yTickValues } from '../src/yticks.js';
import { resolveAreaBaseline } from '../src/AreaChart.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

/** Extents as `resolveYDomain` takes them — one `[min, max]` per linked layer. */
const ex = (...pairs: Array<readonly [number, number]>) => pairs;

describe('resolveYDomain — log', () => {
  it('auto-fits to the data, not to zero', () => {
    expect(
      resolveYDomain(undefined, undefined, ex([100, 100_000]), 0, 'log'),
    ).toEqual([100, 100_000]);
  });

  it('takes the smallest POSITIVE extent, so one zero sample cannot collapse the axis', () => {
    // A bar layer widens its own extent to include 0 (see `barExtent`), so this
    // is the ordinary case whenever a bar shares a log axis — not a pathology.
    // 50 is the smallest positive floor on offer; `.nice()` then rounds the
    // fully-auto domain out to whole decades (see the `.nice()` block below).
    const [lo, hi] = resolveYDomain(
      undefined,
      undefined,
      ex([0, 1_000], [50, 800]),
      0,
      'log',
    );
    expect([lo, hi]).toEqual([10, 1_000]);
    expect(lo).toBeGreaterThan(0);
    // The zero did not become the floor — that is the property under test.
    expect(lo).toBeLessThanOrEqual(50);
  });

  it('falls back to the layer max when an extent offers nothing else positive', () => {
    const [lo, hi] = resolveYDomain(
      undefined,
      undefined,
      ex([-5, 200]),
      0,
      'log',
    );
    // 200 is the only positive value on offer, so it is both ends of a flat
    // extent: opened half a decade each way, then nice'd to whole decades.
    expect([lo, hi]).toEqual([10, 1_000]);
    expect(lo).toBeGreaterThan(0);
    expect(lo).toBeLessThan(200);
    expect(hi).toBeGreaterThan(200);
  });

  it('refuses a non-positive explicit min rather than handing NaN to the scale', () => {
    // `scaleLog()(0)` is NaN — not -Infinity, which is what the first round of
    // docs claimed throughout. Pinned here so the prose can't drift back.
    expect(scaleLog().domain([1, 100]).range([100, 0])(0)).toBeNaN();
    const [lo] = resolveYDomain(0, 10_000, ex([10, 5_000]), 0, 'log');
    expect(lo).toBe(10); // the data's floor, not the requested 0
  });

  it('never discards an explicit bound to keep the domain ascending', () => {
    // The auto side moves, exactly as the linear path does — the log path used
    // to move the *explicit* side, so this returned [1000, 10000] and put the
    // axis three decades from where the caller asked for it.
    expect(
      resolveYDomain(undefined, 100, ex([1_000, 2_000]), 0, 'log'),
    ).toEqual([10, 100]);
    // Mirror case: an explicit min above all the data keeps the min.
    expect(resolveYDomain(5_000, undefined, ex([10, 20]), 0, 'log')).toEqual([
      5_000, 50_000,
    ]);
    // And linear behaves the same way, which is the point of the change.
    expect(resolveYDomain(undefined, 100, ex([1_000, 2_000]), 0)).toEqual([
      99, 100,
    ]);
  });

  it('honours a positive explicit max over the data', () => {
    expect(resolveYDomain(undefined, 5_000, ex([10, 2_000]), 0, 'log')).toEqual(
      [10, 5_000],
    );
  });

  it('takes two explicit positive bounds verbatim, including a flip', () => {
    expect(resolveYDomain(10, 1_000, ex([1, 2]), 0, 'log')).toEqual([
      10, 1_000,
    ]);
    // An inverted explicit domain is a deliberate axis flip on linear; log
    // does not second-guess it either.
    expect(resolveYDomain(1_000, 10, ex([1, 2]), 0, 'log')).toEqual([
      1_000, 10,
    ]);
  });

  it('rounds a FULLY auto-fit domain out to whole decades, and leaves an explicit one exact', () => {
    // `resolveYDomain`'s contract already promised this ("rounded out to nice
    // boundaries... an explicit bound is left exact"); the log path did not
    // honour it, so an extreme sat clipped against the plot edge.
    expect(
      resolveYDomain(undefined, undefined, ex([1.9e10, 2.6e17]), 0, 'log'),
    ).toEqual([1e10, 1e18]);
    expect(
      resolveYDomain(undefined, undefined, ex([3, 700]), 0, 'log'),
    ).toEqual([1, 1_000]);
    // One explicit bound ⇒ neither side is nice'd.
    expect(resolveYDomain(3, undefined, ex([3, 700]), 0, 'log')).toEqual([
      3, 700,
    ]);
    expect(resolveYDomain(undefined, 700, ex([3, 700]), 0, 'log')).toEqual([
      3, 700,
    ]);
  });

  it('gives a flat positive extent room on both sides', () => {
    // The linear path gives a constant line ±1 so it sits mid-row; the ratio
    // analog is half a decade each way (then nice'd).
    const [lo, hi] = resolveYDomain(
      undefined,
      undefined,
      ex([500, 500]),
      0,
      'log',
    );
    expect(lo).toBeLessThan(500);
    expect(hi).toBeGreaterThan(500);
    expect(lo).toBeGreaterThan(0);
  });

  it('gives empty data a positive placeholder domain', () => {
    expect(resolveYDomain(undefined, undefined, [], 0, 'log')).toEqual([1, 10]);
  });

  it('pads multiplicatively — the same fraction of a decade at both ends', () => {
    // 1 → 1000 is three decades; pad 1/3 adds one decade each side.
    const [lo, hi] = resolveYDomain(
      undefined,
      undefined,
      ex([1, 1_000]),
      1 / 3,
      'log',
    );
    expect(lo).toBeCloseTo(0.1, 10);
    expect(hi).toBeCloseTo(10_000, 6);
    // The ratio is what's symmetric, not the difference — an additive pad would
    // have made `lo` negative and left `hi` barely changed.
    expect(lo).toBeGreaterThan(0);
  });

  it('leaves the linear path untouched', () => {
    expect(resolveYDomain(undefined, undefined, ex([0, 100]), 0)).toEqual([
      0, 100,
    ]);
    expect(
      resolveYDomain(undefined, undefined, ex([0, 100]), 0, 'linear'),
    ).toEqual([0, 100]);
  });
});

describe('resolveAreaBaseline', () => {
  const linear = (v: number) => v; // finite everywhere
  // Matches d3: a value with no position comes back `NaN`, not `-Infinity`.
  const log = (v: number) => (v > 0 ? Math.log10(v) : NaN);
  // `domainFloor` reads `.domain()` off the scale object.
  const withDomain = <T extends (v: number) => number>(f: T, d: number[]) =>
    Object.assign(f, { domain: () => d });

  it('keeps a baseline that has a finite position', () => {
    expect(resolveAreaBaseline(0, withDomain(linear, [0, 100]))).toBe(0);
  });

  it('falls back to the axis floor when the baseline is off a log scale', () => {
    // `baseline={0}` is the natural thing to write and is right on a linear
    // axis; on log it has no position at all, and one non-finite coordinate
    // drops the whole filled path.
    expect(resolveAreaBaseline(0, withDomain(log, [10, 1_000]))).toBe(10);
  });

  it('resolves an omitted baseline to the floor on either scale', () => {
    expect(resolveAreaBaseline(undefined, withDomain(log, [10, 1_000]))).toBe(
      10,
    );
    expect(resolveAreaBaseline(undefined, withDomain(linear, [0, 100]))).toBe(
      0,
    );
  });
});

const decades = () =>
  new TimeSeries({
    name: 't',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: [
      [0, 1],
      [1, 100],
      [2, 10_000],
    ],
  });

describe('<YAxis scale="log"> — rendered', () => {
  it('spaces the axis by ratio, not by difference', () => {
    stubCanvasContext();
    const { container } = render(
      <ChartContainer range={[0, 2]} width={400}>
        <ChartRow height={300}>
          <YAxis id="v" scale="log" />
          <Layers>
            <LineChart series={decades()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    // Tick labels come out of the scale, so their *values* are the observable
    // proof of the mapping: a log axis over 1..10000 ticks the decades, where a
    // linear one over the same domain would tick evenly in thousands. The
    // gutter renders them as leaf <div>s.
    const labels = Array.from(container.querySelectorAll('div'))
      .filter((el) => el.childElementCount === 0)
      .map((el) => el.textContent ?? '')
      .filter((t) => /[0-9]/.test(t));
    expect(labels.length).toBeGreaterThan(0);
    // Every label is a power of ten (allowing d3's SI/grouped formatting).
    const asNumber = (t: string) => Number(t.replace(/[, ]/g, ''));
    const powersOfTen = labels
      .map(asNumber)
      .filter((n) => Number.isFinite(n) && n > 0);
    expect(powersOfTen.length).toBeGreaterThan(0);
    for (const n of powersOfTen) {
      const exp = Math.log10(n);
      expect(Math.abs(exp - Math.round(exp))).toBeLessThan(1e-9);
    }
    // A linear scale over 1..10000 would tick evenly in thousands; none of
    // those values can appear here.
    expect(powersOfTen.some((n) => n === 2000 || n === 4000)).toBe(false);
  });

  it('warns about a refused explicit bound', () => {
    stubCanvasContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <ChartContainer range={[0, 2]} width={400}>
        <ChartRow height={200}>
          <YAxis id="v" scale="log" min={0} />
          <Layers>
            <LineChart series={decades()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scale="log"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('min={0}'));
    warn.mockRestore();
  });

  it('says nothing for all-positive data', () => {
    stubCanvasContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <ChartContainer range={[0, 2]} width={400}>
        <ChartRow height={200}>
          <YAxis id="v" scale="log" />
          <Layers>
            <LineChart series={decades()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('says nothing for a BAR layer on strictly positive data', () => {
    // `barExtent` always widens its low end to 0 so a bar can reach its
    // baseline. The first warning keyed off exactly that, so every BarChart on
    // a log axis warned — including the `WithBars` story — with text asserting
    // the data reached zero when it does not. A warning that cries wolf is
    // worse than none: it trains the reader to mute the channel.
    stubCanvasContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(
      <ChartContainer range={[0, 2]} width={400}>
        <ChartRow height={200}>
          <YAxis id="v" scale="log" />
          <Layers>
            <BarChart series={decades()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns once, not once per repaint', () => {
    // The original comment claimed "warn once per offending axis" and nothing
    // implemented it; the warning sat inside a `useMemo` keyed on `layerList`
    // and `height`, so a live chart re-warned on every appended sample and a
    // drag-resize emitted a line per frame.
    stubCanvasContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tree = (h: number) => (
      <ChartContainer range={[0, 2]} width={400}>
        <ChartRow height={h}>
          <YAxis id="v" scale="log" min={-1} />
          <Layers>
            <LineChart series={decades()} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
    const { rerender } = render(tree(200));
    expect(warn).toHaveBeenCalledTimes(1);
    rerender(tree(240)); // a resize
    rerender(tree(260)); // another
    rerender(tree(260)); // a repaint with nothing changed
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('logAxisWarning', () => {
  // The policy, tested directly — a console spy through a rendered tree can
  // only say "something was logged", not which of the cases fired.
  const axis = (over: Partial<Parameters<typeof logAxisWarning>[0]> = {}) => ({
    id: 'v',
    scale: 'log' as const,
    min: undefined,
    max: undefined,
    ...over,
  });

  it('says nothing about a linear axis, whatever the data', () => {
    expect(
      logAxisWarning(axis({ scale: 'linear', min: -5 }), [[-100, 0]]),
    ).toBeNull();
  });

  it('says nothing about a healthy log axis', () => {
    expect(logAxisWarning(axis(), [[10, 1_000]])).toBeNull();
    expect(
      logAxisWarning(axis({ min: 1, max: 1e6 }), [[10, 1_000]]),
    ).toBeNull();
    expect(logAxisWarning(axis(), [])).toBeNull();
    expect(logAxisWarning(axis(), [null])).toBeNull(); // data not loaded yet
  });

  it('reports a refused min AND a refused max', () => {
    // A non-positive `max` was refused with no warning at all — the axis simply
    // ignored what it was asked for.
    const m = logAxisWarning(axis({ min: 0, max: -10 }), []);
    expect(m).toContain('min={0}');
    expect(m).toContain('max={-10}');
    expect(logAxisWarning(axis({ max: 0 }), [[1, 2]])).toContain('max={0}');
  });

  it('catches a NaN bound, which is just as invisible', () => {
    expect(logAxisWarning(axis({ min: NaN }), [[1, 2]])).toContain('min={NaN}');
  });

  it('reports negative data, which no baseline widening can explain', () => {
    // `barExtent` only ever widens to exactly 0, so a strictly negative low end
    // is always real data.
    expect(logAxisWarning(axis(), [[-4, 100]])).toContain('negative values');
  });

  it('reports an axis with no positive data at all', () => {
    // Nothing to draw against, and the domain is a placeholder — the case that
    // most needs explaining, since the plot is simply empty.
    expect(logAxisWarning(axis(), [[0, 0]])).toContain('fell back to');
    // Negative-only data is both facts at once, and says both.
    const m = logAxisWarning(axis(), [[-10, -1]]);
    expect(m).toContain('negative values');
    expect(m).toContain('fell back to');
  });

  it('does NOT report an extent of exactly [0, hi] — the ambiguous shape', () => {
    // A line touching zero and a bar layer on positive data report the same
    // thing here, and there is no way to tell them apart from the extent alone.
    // Warning would fire on every bar chart; the zero is instead visible as a
    // gap in the drawn line (see the `gapUnscalable` tests).
    expect(logAxisWarning(axis(), [[0, 1_000]])).toBeNull();
  });

  it('says which axis, and what a reader should do about it', () => {
    const m = logAxisWarning(axis({ id: 'traffic', min: 0 }), []);
    expect(m).toContain('id="traffic"');
    expect(m).toContain('NaN'); // not -Infinity: that is what d3 actually returns
    expect(m).not.toContain('-Infinity');
  });
});

describe('needsExtents', () => {
  it('walks the layers only when a side auto-fits, on a linear axis', () => {
    const lin = { scale: 'linear' as const, min: undefined, max: undefined };
    expect(needsExtents(lin)).toBe(true);
    expect(needsExtents({ ...lin, min: 0 })).toBe(true);
    expect(needsExtents({ ...lin, min: 0, max: 10 })).toBe(false);
  });

  it('treats a REFUSED log bound as absent, so the data still supplies that side', () => {
    // `<YAxis scale="log" min={0} max={1e6}>` looked fully explicit, so no
    // extents were gathered — and the refused floor then fell back to the
    // empty-data placeholder instead of the data's own floor. The unit tests
    // for `resolveLogDomain` never caught it: they hand it the extents, which
    // is exactly what the component was not doing.
    const log = { scale: 'log' as const, min: 0, max: 1e6 };
    expect(needsExtents(log)).toBe(true);
    expect(needsExtents({ ...log, min: 1 })).toBe(false);
    expect(needsExtents({ ...log, max: 0 })).toBe(true);
  });
});

describe('log axis — formatter and tick selection', () => {
  // Both of these were shipped broken and both were caught by review, not by
  // the suite. The assertions are written to fail loudly if either regresses.

  it('formats arbitrary values on a log axis, not just significant ticks', () => {
    // `scaleLog.tickFormat` returns '' for anything it doesn't consider a
    // tick, which blanks the cursor readout, `YAxisIndicator` and `Baseline`
    // chips — they all share this formatter and ask it about real values.
    const log = scaleLog().domain([1.9e10, 2.6e17]);
    expect(log.tickFormat(6, '.3s')(1.97e17)).toBe(''); // d3's behaviour

    const fmt = resolveAxisFormat(log, 6, '.3s');
    expect(fmt(1.97e17)).not.toBe('');
    // d3's linear tickFormat calibrates precision from the domain + count, so
    // the exact digits are its business; what matters is that a real value
    // formats to something at all, with the SI prefix the specifier asked for.
    expect(fmt(1.97e17)).toMatch(/^197(\.0+)?P$/);
  });

  it('passes a format FUNCTION through untouched on a log axis', () => {
    const log = scaleLog().domain([1, 1e6]);
    const fmt = resolveAxisFormat(log, 5, (v) => `${v} bytes`);
    expect(fmt(1234)).toBe('1234 bytes');
  });

  it('picks decades, and never d3’s 3-or-64 cliff', () => {
    // The ESnet domain: seven decades. d3 returns 3 values at count 4 (every
    // OTHER decade) and 64 at count 8 — from a count that is height-derived,
    // so a 40px resize flips between them.
    const log = scaleLog().domain([1.9e10, 2.6e17]);
    expect(log.ticks(4).length).toBe(3); // d3's behaviour
    expect(log.ticks(8).length).toBe(64); // d3's behaviour

    for (const count of [4, 6, 8, 12]) {
      const ticks = yTickValues(log, count);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(Math.max(2, count));
      // Every tick is a power of ten.
      for (const t of ticks) {
        const exp = Math.log10(t);
        expect(Math.abs(exp - Math.round(exp))).toBeLessThan(1e-9);
      }
    }
    // A roomy row gets one line per decade; a cramped one thins by whole
    // decades rather than skipping to every other one at random.
    expect(yTickValues(log, 8)).toEqual([
      1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17,
    ]);
    expect(yTickValues(log, 4)).toEqual([1e11, 1e13, 1e15, 1e17]);
  });

  it('defers to the scale below two decades, where d3 is well behaved', () => {
    const log = scaleLog().domain([200, 900]);
    expect(yTickValues(log, 5)).toEqual(log.ticks(5));
  });

  it('leaves a linear scale entirely alone', () => {
    const lin = scaleLinear().domain([0, 100]);
    expect(yTickValues(lin, 5)).toEqual(lin.ticks(5));
  });
});
