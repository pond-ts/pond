/**
 * Maths in expressions: `sqrt`, `sin`, `cos`, `asin`, `atan2`, `pow`. Same
 * gap rule as arithmetic: a gap in is a gap out, and a result that is not
 * a finite number is a gap.
 */
import { describe, expect, it } from 'vitest';
import { LiveSeries, TimeSeries, col, lit, when } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'x', kind: 'number', required: false },
  { name: 'y', kind: 'number', required: false },
] as const;

type Row = [number, number | undefined, number | undefined];

function series(rows: Array<[number | undefined, number | undefined]>) {
  return new TimeSeries({
    name: 's',
    schema,
    rows: rows.map(([x, y], i): Row => [i * 1000, x, y]),
  });
}

function out(s: TimeSeries<any>, name = 'o'): Array<number | undefined> {
  return [...s.column(name).toFloat64Array()].map((v) =>
    Number.isNaN(v) ? undefined : v,
  );
}

describe('maths in expressions', () => {
  const s = series([
    [4, 2],
    [-1, 0.5],
    [0, -3],
    [undefined, 2],
    [2, undefined],
    [1e200, 2],
  ]);

  it('sqrt: a negative or a gap gives a gap', () => {
    expect(out(s.withColumn('o', col('x').sqrt()))).toEqual([
      2,
      undefined,
      0,
      undefined,
      Math.SQRT2,
      1e100,
    ]);
  });

  it('sin, cos, asin match Math, with gaps carried', () => {
    const got = s
      .withColumn('a', col('x').sin())
      .withColumn('b', col('x').cos());
    expect(out(got, 'a')).toEqual(
      [4, -1, 0, undefined, 2, 1e200].map((v) =>
        v === undefined ? undefined : Math.sin(v),
      ),
    );
    expect(out(got, 'b')).toEqual(
      [4, -1, 0, undefined, 2, 1e200].map((v) =>
        v === undefined ? undefined : Math.cos(v),
      ),
    );
    expect(out(s.withColumn('o', col('y').asin()))).toEqual([
      undefined, // asin(2) is not a number
      Math.asin(0.5),
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('atan2(y, x) reads this as y', () => {
    expect(out(s.withColumn('o', col('y').atan2(col('x'))))).toEqual([
      Math.atan2(2, 4),
      Math.atan2(0.5, -1),
      Math.atan2(-3, 0),
      undefined,
      undefined,
      Math.atan2(2, 1e200),
    ]);
  });

  it('pow: overflow and a gap on either side give a gap', () => {
    expect(out(s.withColumn('o', col('x').pow(col('y'))))).toEqual([
      16,
      undefined, // (-1) ** 0.5 is not a number
      undefined, // 0 ** -3 is Infinity
      undefined, // a gap ** 2
      undefined, // 2 ** a gap
      undefined, // 1e400 overflows
    ]);
    // `NaN ** 0` is 1 in JavaScript; a gap stays a gap here.
    expect(out(s.withColumn('o', col('x').pow(0)))).toEqual([
      1,
      1,
      1,
      undefined,
      1,
      1,
    ]);
    expect(out(s.withColumn('o', lit(2).pow(col('y'))))).toEqual([
      4,
      Math.SQRT2,
      0.125,
      4,
      undefined,
      4,
    ]);
  });

  it('a number on either side of pow / atan2 gives the same answers', () => {
    const xs = [4, -1, 0, undefined, 2, 1e200];
    const gapOr = (v: number) => (Number.isFinite(v) ? v : undefined);
    for (const k of [2, 3, 0.5, -1]) {
      expect(out(s.withColumn('o', col('x').pow(k)))).toEqual(
        xs.map((v) => (v === undefined ? undefined : gapOr(v ** k))),
      );
      expect(out(s.withColumn('o', lit(k).pow(col('x'))))).toEqual(
        xs.map((v) => (v === undefined ? undefined : gapOr(k ** v))),
      );
    }
    expect(out(s.withColumn('o', col('x').atan2(-2)))).toEqual(
      xs.map((v) => (v === undefined ? undefined : Math.atan2(v, -2))),
    );
    expect(out(s.withColumn('o', lit(-2).atan2(col('x'))))).toEqual(
      xs.map((v) => (v === undefined ? undefined : Math.atan2(-2, v))),
    );
    // Squaring takes `x * x`; same bits as `x ** 2` across magnitudes.
    const wide = series(
      Array.from({ length: 2000 }, (_, i): [number, number] => [
        (i % 2 ? -1 : 1) * Math.sin(i) * 2 ** ((i % 200) - 100),
        0,
      ]),
    );
    const sq = out(wide.withColumn('o', col('x').pow(2)));
    const x = [...wide.column('x').toFloat64Array()];
    expect(sq.every((v, i) => Object.is(v, gapOr(x[i]! ** 2)))).toBe(true);
  });

  it('refuses non-number operands', () => {
    const t = new TimeSeries({
      name: 't',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 's', kind: 'string' },
      ] as const,
      rows: [[0, 'a']],
    });
    expect(() => t.withColumn('o', col('s').sqrt())).toThrow(
      /sqrt needs numbers/,
    );
    expect(() => s.withColumn('o', col('x').pow('2' as any))).toThrow(
      /pow needs numbers/,
    );
  });

  it('gives the same values live (row by row) as in batch', () => {
    const live = new LiveSeries({ name: 's', schema });
    const keep = live.filter(
      col('x').pow(2).add(col('y').pow(2)).sqrt().gt(2.5),
    );
    const rows: Row[] = [
      [0, 3, 4],
      [1000, 1, 1],
      [2000, undefined, 9],
      [3000, 2, 2],
    ];
    rows.forEach((r) => live.push(r));
    expect(keep.toTimeSeries().length).toBe(2); // 5 and 2.83
  });

  it('writes haversine distance with the same bits as a plain loop', () => {
    const DEG = Math.PI / 180;
    const R = 6_371_008.8;
    const haversine = (la1: number, lo1: number, la2: number, lo2: number) => {
      const dLat = (la2 - la1) * DEG;
      const dLng = (lo2 - lo1) * DEG;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(la1 * DEG) * Math.cos(la2 * DEG) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    };
    const track = new TimeSeries({
      name: 'track',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'lat', kind: 'number' },
        { name: 'lng', kind: 'number' },
      ] as const,
      rows: Array.from({ length: 200 }, (_, i) => [
        i * 1000,
        37.8 + Math.sin(i / 20) * 0.01,
        -122.4 + i * 0.0001,
      ]),
    });
    const prev = track
      .withColumn('lat0', col('lat'))
      .withColumn('lng0', col('lng'))
      .shift(['lat0', 'lng0'], 1);
    const dLat = col('lat').sub(col('lat0')).mul(DEG);
    const dLng = col('lng').sub(col('lng0')).mul(DEG);
    const a = dLat
      .div(2)
      .sin()
      .pow(2)
      .add(
        col('lat0')
          .mul(DEG)
          .cos()
          .mul(col('lat').mul(DEG).cos())
          .mul(dLng.div(2).sin().pow(2)),
      );
    const root = a.sqrt();
    // Math.min(1, root) as an expression.
    const step = lit(2 * R).mul(when(root.gt(1), 1, root).asin());
    const got = out(prev.withColumn('d', step), 'd');
    const lat = [...track.column('lat').toFloat64Array()];
    const lng = [...track.column('lng').toFloat64Array()];
    expect(got[0]).toBeUndefined();
    for (let i = 1; i < 200; i++) {
      expect(
        Object.is(
          got[i],
          haversine(lat[i - 1]!, lng[i - 1]!, lat[i]!, lng[i]!),
        ),
      ).toBe(true);
    }
  });
});
