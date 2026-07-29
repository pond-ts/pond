import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import { appendColumn, columnBytes, packColumn } from '../src/index.js';

/**
 * Reads a dynamically-named column off a loosely-typed series.
 *
 * `appendColumn` returns `TimeSeries<SeriesSchema>` because the plan
 * layer names columns after `specId`s computed at runtime, so there is no
 * literal type to narrow with. That is inherent to plans-as-data rather
 * than a gap in the helper — noted here because a reader will reach for
 * `out.column('sma').at(0)` and find it typed `never`.
 */
function cell(s: unknown, name: string, i: number): number | undefined {
  return (s as { column(n: string): { at(i: number): number | undefined } })
    .column(name)
    .at(i);
}

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

function series(values: readonly (number | undefined)[]) {
  return TimeSeries.fromJSON({
    name: 'x',
    schema,
    rows: values.map((v, i) => [i * 1000, v ?? 0]),
  });
}

describe('packColumn', () => {
  it('packs a gapless run with no bitmap', () => {
    const c = packColumn([1, 2, 3]);
    expect(c.length).toBe(3);
    expect(c.validity).toBeUndefined();
    expect([c.at(0), c.at(1), c.at(2)]).toEqual([1, 2, 3]);
  });

  it('treats undefined, null and NaN alike as missing', () => {
    const c = packColumn([undefined, 1, null, 2, NaN]);
    expect(c.length).toBe(5);
    expect(c.validity?.definedCount).toBe(2);
    expect([c.at(0), c.at(1), c.at(2), c.at(3), c.at(4)]).toEqual([
      undefined,
      1,
      undefined,
      2,
      undefined,
    ]);
  });

  it('models a study warm-up — leading gap, then values', () => {
    const warm = [undefined, undefined, 3, 4, 5];
    const c = packColumn(warm);
    expect(c.validity?.definedCount).toBe(3);
    // `scan` is the columns-not-events read path; it must see only the
    // defined cells and report their true indices.
    const seen: [number, number][] = [];
    c.scan((v, i) => seen.push([i, v]));
    expect(seen).toEqual([
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
  });

  it('sets allFinite only when every defined cell is finite', () => {
    // A wrongly-true flag makes core's reducers take an unguarded path
    // and silently return a wrong result, so this is correctness, not
    // optimisation.
    expect(packColumn([1, 2, 3]).allFinite).toBe(true);
    expect(packColumn([1, undefined, 3]).allFinite).toBe(true);
    expect(packColumn([1, Infinity, 3]).allFinite).toBe(false);
    expect(packColumn([1, -Infinity]).allFinite).toBe(false);
    // NaN is missing rather than non-finite, so it does not clear the flag.
    expect(packColumn([1, NaN, 3]).allFinite).toBe(true);
  });

  it('round-trips through a bitmap boundary', () => {
    // Exercise more than one bitmap byte, and both edges of a byte.
    const values = Array.from({ length: 20 }, (_, i) =>
      i % 3 === 0 ? undefined : i,
    );
    const c = packColumn(values);
    for (let i = 0; i < 20; i += 1) expect(c.at(i)).toBe(values[i]);
    expect(c.validity?.countInRange(0, 8)).toBe(5);
    expect(c.validity?.countInRange(8, 20)).toBe(8);
  });
});

describe('columnBytes', () => {
  it('sizes a packed column by its buffers', () => {
    const gapless = packColumn(Array.from({ length: 1000 }, (_, i) => i));
    // 1000 * 8, no bitmap.
    expect(columnBytes(gapless)).toBe(8000);

    const gapped = packColumn(
      Array.from({ length: 1000 }, (_, i) => (i < 10 ? undefined : i)),
    );
    // 1000 * 8 + ceil(1000/8) validity bytes.
    expect(columnBytes(gapped)).toBe(8000 + 125);
  });

  it('scales with length, which is the point for a byte budget', () => {
    const small = packColumn(Array.from({ length: 100 }, (_, i) => i));
    const large = packColumn(Array.from({ length: 100_000 }, (_, i) => i));
    expect(columnBytes(large) / columnBytes(small)).toBe(1000);
  });
});

describe('appendColumn', () => {
  it('round-trips a gapless column without boxing', () => {
    const s = series([1, 2, 3]);
    const c = packColumn([10, 20, 30]);
    const out = appendColumn(s, 'derived', c);
    expect(out.length).toBe(3);
    expect(cell(out, 'derived', 0)).toBe(10);
    expect(cell(out, 'derived', 2)).toBe(30);
  });

  it('preserves gaps through the boxed fallback', () => {
    const s = series([1, 2, 3, 4]);
    const c = packColumn([undefined, undefined, 30, 40]);
    const out = appendColumn(s, 'sma', c);
    expect(cell(out, 'sma', 0)).toBeUndefined();
    expect(cell(out, 'sma', 1)).toBeUndefined();
    expect(cell(out, 'sma', 2)).toBe(30);
    expect(cell(out, 'sma', 3)).toBe(40);
  });

  it('survives a real study column taken straight off a series', () => {
    // The path the plan layer actually takes: an op returns a widened
    // series, the node value is that series' column, and assembly puts
    // it onto a different series.
    const s = series([1, 2, 3, 4, 5]);
    const widened = s.withColumn('study', [undefined, 2, 3, 4, 5]);
    const taken = widened.column('study');
    const out = appendColumn(series([9, 9, 9, 9, 9]), 'copied', taken);
    expect(cell(out, 'copied', 0)).toBeUndefined();
    expect(cell(out, 'copied', 4)).toBe(5);
  });

  it('rejects a length mismatch rather than truncating', () => {
    expect(() =>
      appendColumn(series([1, 2, 3]), 'bad', packColumn([1, 2])),
    ).toThrow(/does not match series length/);
  });
});
