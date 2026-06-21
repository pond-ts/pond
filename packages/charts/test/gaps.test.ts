import { describe, expect, it } from 'vitest';
import { bridgeGaps, collectGapEdges, withAlpha } from '../src/gaps.js';

const f64 = (xs: number[]) => Float64Array.from(xs);
const identity = (v: number) => v;

describe('bridgeGaps', () => {
  it('linearly interpolates an interior gap', () => {
    // 10 → __ → __ → 40 fills the two interior NaNs at 20, 30.
    expect([...bridgeGaps(f64([10, NaN, NaN, 40]), 4)]).toEqual([
      10, 20, 30, 40,
    ]);
  });

  it('handles a single-sample interior gap', () => {
    expect([...bridgeGaps(f64([0, NaN, 10]), 3)]).toEqual([0, 5, 10]);
  });

  it('leaves a leading gap as NaN (no left anchor)', () => {
    const out = bridgeGaps(f64([NaN, NaN, 6, 8]), 4);
    expect(Number.isNaN(out[0]!)).toBe(true);
    expect(Number.isNaN(out[1]!)).toBe(true);
    expect([out[2], out[3]]).toEqual([6, 8]);
  });

  it('leaves a trailing gap as NaN (no right anchor)', () => {
    const out = bridgeGaps(f64([2, 4, NaN, NaN]), 4);
    expect([out[0], out[1]]).toEqual([2, 4]);
    expect(Number.isNaN(out[2]!)).toBe(true);
    expect(Number.isNaN(out[3]!)).toBe(true);
  });

  it('returns a copy — does not mutate the input', () => {
    const src = f64([1, NaN, 3]);
    bridgeGaps(src, 3);
    expect(Number.isNaN(src[1]!)).toBe(true); // input untouched
  });

  it('passes finite data through unchanged', () => {
    expect([...bridgeGaps(f64([1, 2, 3]), 3)]).toEqual([1, 2, 3]);
  });
});

describe('collectGapEdges', () => {
  it('collects one interior gap with resolved pixel coords', () => {
    const x = f64([0, 1, 2, 3]);
    const y = [5, NaN, NaN, 8];
    const edges = collectGapEdges(
      4,
      x,
      (i) => y[i]!,
      identity,
      (i) => y[i]!,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromIndex: 0,
      toIndex: 3,
      fromX: 0,
      fromY: 5,
      toX: 3,
      toY: 8,
    });
  });

  it('collects multiple interior gaps', () => {
    const x = f64([0, 1, 2, 3, 4]);
    const y = [1, NaN, 3, NaN, 5];
    const edges = collectGapEdges(
      5,
      x,
      (i) => y[i]!,
      identity,
      (i) => y[i]!,
    );
    expect(edges.map((e) => [e.fromIndex, e.toIndex])).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('skips leading and trailing gaps (nothing to bridge)', () => {
    const x = f64([0, 1, 2, 3]);
    const y = [NaN, 6, 7, NaN];
    const edges = collectGapEdges(
      4,
      x,
      (i) => y[i]!,
      identity,
      (i) => y[i]!,
    );
    expect(edges).toHaveLength(0);
  });

  it('resolves x through xScale and y through lineY', () => {
    const vals = [1, NaN, 2];
    const edges = collectGapEdges(
      3,
      f64([0, 5, 10]),
      (i) => vals[i]!,
      (t) => t * 2, // xScale
      (i) => 100 - vals[i]!, // lineY (a flip)
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]!.fromX).toBe(0); // 0 * 2
    expect(edges[0]!.toX).toBe(20); // 10 * 2
    expect(edges[0]!.fromY).toBe(99); // 100 - 1
    expect(edges[0]!.toY).toBe(98); // 100 - 2
  });
});

describe('withAlpha', () => {
  it('expands #rrggbb to rgba', () => {
    expect(withAlpha('#2563eb', 0)).toBe('rgba(37, 99, 235, 0)');
  });
  it('expands #rgb shorthand to rgba', () => {
    expect(withAlpha('#abc', 0)).toBe('rgba(170, 187, 204, 0)');
  });
  it('falls back to the `transparent` keyword for a non-hex colour at alpha 0', () => {
    expect(withAlpha('teal', 0)).toBe('transparent');
  });
  it('returns a non-hex colour unchanged at a non-zero alpha', () => {
    expect(withAlpha('teal', 0.5)).toBe('teal');
  });
});
