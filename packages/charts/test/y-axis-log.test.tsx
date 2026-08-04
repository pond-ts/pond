import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { resolveYDomain } from '../src/domain.js';
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
    const [lo, hi] = resolveYDomain(
      undefined,
      undefined,
      ex([0, 1_000], [50, 800]),
      0,
      'log',
    );
    expect(lo).toBe(50);
    expect(hi).toBe(1_000);
    expect(lo).toBeGreaterThan(0);
  });

  it('falls back to the layer max when an extent offers nothing else positive', () => {
    const [lo, hi] = resolveYDomain(
      undefined,
      undefined,
      ex([-5, 200]),
      0,
      'log',
    );
    expect(lo).toBe(200);
    expect(hi).toBe(2_000); // hi <= lo ⇒ opened out by a decade
    expect(lo).toBeGreaterThan(0);
  });

  it('refuses a non-positive explicit min rather than handing -Infinity to the scale', () => {
    const [lo] = resolveYDomain(0, 10_000, ex([10, 5_000]), 0, 'log');
    expect(lo).toBe(10); // the data's floor, not the requested 0
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
  const log = (v: number) => (v > 0 ? Math.log10(v) : -Infinity);
  // `domainFloor` reads `.domain()` off the scale object.
  const withDomain = <T extends (v: number) => number>(f: T, d: number[]) =>
    Object.assign(f, { domain: () => d });

  it('keeps a baseline that has a finite position', () => {
    expect(resolveAreaBaseline(0, withDomain(linear, [0, 100]))).toBe(0);
  });

  it('falls back to the axis floor when the baseline is off a log scale', () => {
    // `baseline={0}` is the natural thing to write and is right on a linear
    // axis; on log it is -Infinity, and one non-finite coordinate drops the
    // whole filled path.
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

  it('warns when data on a log axis reaches zero', () => {
    stubCanvasContext();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const withZero = new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [0, 0],
        [1, 100],
      ],
    });
    render(
      <ChartContainer range={[0, 1]} width={400}>
        <ChartRow height={200}>
          <YAxis id="v" scale="log" />
          <Layers>
            <LineChart series={withZero} column="v" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('scale="log"'));
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
});
