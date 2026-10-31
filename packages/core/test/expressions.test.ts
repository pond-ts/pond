/**
 * Column expressions ([PND-EXPR], docs/rfcs/expressions.md). The rule
 * pinned throughout: an expression gives the same answer as the
 * function it replaces, gaps included. Each case runs the function form
 * and the expression form on a series with gaps in every column, and on
 * the live layer, and compares.
 */
import { describe, expect, it } from 'vitest';
import { Expr, LiveSeries, TimeSeries, col, lit, when } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'w', kind: 'number', required: false },
  { name: 'host', kind: 'string', required: false },
  { name: 'up', kind: 'boolean', required: false },
] as const;

type Row = [number, number?, number?, string?, boolean?];
const rows: Row[] = [];
for (let i = 0; i < 40; i += 1) {
  rows.push([
    i * 1000,
    i % 5 === 0 ? undefined : (i % 7) - 3,
    i % 6 === 0 ? undefined : i % 4,
    i % 9 === 0 ? undefined : ['a', 'b', 'c'][i % 3],
    i % 8 === 0 ? undefined : i % 2 === 0,
  ]);
}
const series = new TimeSeries({ name: 's', schema, rows });
type E = { get(c: string): any };

const filterCases: Array<[string, Expr, (e: E) => boolean]> = [
  ['gt', col('v').gt(0), (e) => e.get('v') > 0],
  ['ge lit first', lit(1).le(col('v')), (e) => 1 <= e.get('v')],
  ['lt', col('v').lt(col('w')), (e) => e.get('v') < e.get('w')],
  ['eq text', col('host').eq('a'), (e) => e.get('host') === 'a'],
  ['ne text', col('host').ne('a'), (e) => e.get('host') !== 'a'],
  ['eq number', col('w').eq(2), (e) => e.get('w') === 2],
  ['ne number', col('w').ne(2), (e) => e.get('w') !== 2],
  ['text order', col('host').gt('a'), (e) => e.get('host') > 'a'],
  ['in', col('host').in(['a', 'c']), (e) => ['a', 'c'].includes(e.get('host'))],
  ['in numbers', col('v').in([1, -3]), (e) => [1, -3].includes(e.get('v'))],
  ['bare boolean column', col('up'), (e) => !!e.get('up')],
  ['eq boolean', col('up').eq(false), (e) => e.get('up') === false],
  [
    'and',
    col('v').gt(0).and(col('host').eq('b')),
    (e) => e.get('v') > 0 && e.get('host') === 'b',
  ],
  ['or', col('v').gt(1).or(col('up')), (e) => e.get('v') > 1 || !!e.get('up')],
  ['not keeps gaps', col('v').gt(0).not(), (e) => !(e.get('v') > 0)],
  ['not boolean column', col('up').not(), (e) => !e.get('up')],
  ['isMissing', col('v').isMissing(), (e) => e.get('v') === undefined],
  [
    'arith',
    col('v').mul(2).add(col('w')).gt(1),
    (e) => e.get('v') * 2 + e.get('w') > 1,
  ],
  ['neg abs', col('v').neg().abs().ge(2), (e) => Math.abs(-e.get('v')) >= 2],
  [
    'literal minus column',
    lit(10).sub(col('v')).gt(8),
    (e) => 10 - e.get('v') > 8,
  ],
  [
    'literal over column',
    lit(6).div(col('w')).ge(2),
    (e) => {
      const q = 6 / e.get('w');
      return Number.isFinite(q) && q >= 2;
    },
  ],
  [
    'same expression twice',
    ((d) => d.add(d).sub(d.mul(d)).lt(0))(col('v').mul(2)),
    (e) => {
      const d = e.get('v') * 2;
      return d + d - d * d < 0;
    },
  ],
  ['fill', col('v').fill(0).ge(0), (e) => (e.get('v') ?? 0) >= 0],
  [
    'fill from column',
    col('v').fill(col('w')).gt(1),
    (e) => (e.get('v') ?? e.get('w')) > 1,
  ],
  [
    'when',
    when(col('up'), col('v'), col('w')).gt(0),
    (e) => (e.get('up') ? e.get('v') : e.get('w')) > 0,
  ],
  [
    'when text',
    when(col('v').gt(0), 'pos', col('host')).eq('pos'),
    (e) => (e.get('v') > 0 ? 'pos' : e.get('host')) === 'pos',
  ],
];

describe('expressions give the same answer as the function they replace', () => {
  it.each(filterCases)('filter: %s', (_, expr, fn) => {
    const want = series.filter(fn as never).toJSON();
    expect(want.rows.length).toBeGreaterThan(0);
    expect(series.filter(expr).toJSON()).toEqual(want);
  });

  it.each(filterCases)('find / some / every: %s', (_, expr, fn) => {
    const f = fn as never;
    expect(series.find(expr)?.begin()).toBe(series.find(f)?.begin());
    expect(series.some(expr)).toBe(series.some(f));
    expect(series.every(expr)).toBe(series.every(f));
  });

  it.each(filterCases)('live filter: %s', (_, expr, fn) => {
    const live = new LiveSeries({ name: 'l', schema });
    const a = live.filter(expr);
    const b = live.filter(fn as never);
    live.push(...(rows as never[]));
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(a.at(i)!.begin()).toBe(b.at(i)!.begin());
    }
  });

  it('every on an all-true expression, some on an all-false one', () => {
    expect(series.every(col('w').isMissing().or(col('w').ge(0)))).toBe(true);
    expect(series.some(col('w').gt(100))).toBe(false);
    const empty = series.filter(col('w').gt(100));
    expect(empty.length).toBe(0);
    expect(empty.every(col('w').gt(100))).toBe(true);
    expect(empty.find(col('w').gt(100))).toBeUndefined();
  });
});

describe('text columns stored without a dictionary', () => {
  // 40 distinct values: stored as a plain list, not dictionary-coded,
  // so these take the general text path.
  const plain = series.mapColumns({
    host: (h: string) => `${h}-${Math.random().toString(36).slice(2)}`,
  });
  const first = plain.at(1)!.get('host') as string;
  it.each<[string, Expr, (e: E) => boolean]>([
    ['eq', col('host').eq(first), (e) => e.get('host') === first],
    ['ne', col('host').ne(first), (e) => e.get('host') !== first],
    ['in', col('host').in([first, 'x']), (e) => e.get('host') === first],
    ['gt', col('host').gt('b'), (e) => e.get('host') > 'b'],
  ])('%s', (_, expr, fn) => {
    const want = plain.filter(fn as never).toJSON();
    expect(want.rows.length).toBeGreaterThan(0);
    expect(plain.filter(expr).toJSON()).toEqual(want);
  });
});

describe('the two deliberate differences from a function', () => {
  it('division by zero is a gap at once (a function would see Infinity)', () => {
    const got = series.filter(col('v').div(col('w')).gt(0)).toJSON().rows;
    const want = series
      .filter((e) => {
        const q = (e.get('v') as number) / (e.get('w') as number);
        return Number.isFinite(q) && q > 0;
      })
      .toJSON().rows;
    expect(got).toEqual(want);
    expect(series.some(col('w').eq(0))).toBe(true);
    const live = new LiveSeries({ name: 'l', schema });
    const view = live.filter(col('v').div(col('w')).gt(0));
    live.push(...(rows as never[]));
    expect(view.length).toBe(want.length);
  });

  it('eq is false when both sides are gaps', () => {
    const both = series.filter(col('v').isMissing().and(col('w').isMissing()));
    expect(both.length).toBeGreaterThan(0);
    expect(both.some(col('v').eq(col('w')))).toBe(false);
    expect(both.every(col('v').ne(col('w')))).toBe(true);
  });
});

describe('mapColumns with expressions', () => {
  it('matches the function form; a gap stays a gap', () => {
    const want = series.mapColumns({ v: (x) => x * 1.8 + 32 }).toJSON();
    expect(
      series.mapColumns({ v: col('v').mul(1.8).add(32) }).toJSON(),
    ).toEqual(want);
    // fill cannot fill a gap here (the target's gap stays).
    expect(series.mapColumns({ v: col('v').fill(99) }).toJSON()).toEqual(
      series.toJSON(),
    );
  });

  it('reads other columns as they were before mapping', () => {
    const out = series.mapColumns({
      v: (x: number) => x + 100,
      w: col('w').add(col('v')),
    });
    const r = out.toJSON().rows;
    rows.forEach((row, i) => {
      const [, v, w] = row;
      const sum = v === undefined || w === undefined ? null : v + w;
      expect(r[i]![2] ?? null).toBe(w === undefined ? null : sum);
      expect(r[i]![1] ?? null).toBe(v === undefined ? null : v + 100);
    });
  });

  it('text and boolean columns', () => {
    const out = series.mapColumns({
      host: when(col('host').eq('a'), 'A', col('host')),
      up: col('up').not(),
    });
    const want = series.mapColumns({
      host: (h) => (h === 'a' ? 'A' : h),
      up: (u) => !u,
    });
    expect(out.toJSON()).toEqual(want.toJSON());
  });

  it('refuses an expression of the wrong kind', () => {
    expect(() => series.mapColumns({ v: col('host') })).toThrow(
      "mapColumns 'v': the expression gives string, the column is number",
    );
  });
});

describe('withColumn with expressions', () => {
  it('adds an optional column of the expression kind', () => {
    const out = series.withColumn('ratio', col('v').div(col('w')));
    expect(out.schema.at(-1)).toEqual({
      name: 'ratio',
      kind: 'number',
      required: false,
    });
    out.toJSON().rows.forEach((r, i) => {
      const [, v, w] = rows[i]!;
      const q = v === undefined || w === undefined ? NaN : v / w;
      expect(r.at(-1) ?? null).toBe(Number.isFinite(q) ? q : null); // x/0 is a gap
    });
    const flag = series.withColumn('pos', col('v').gt(0));
    expect(flag.schema.at(-1)).toEqual({
      name: 'pos',
      kind: 'boolean',
      required: false,
    });
    expect(flag.toJSON().rows.map((r) => r.at(-1))).toEqual(
      rows.map((r) => (r[1] ?? NaN) > 0),
    );
    const label = series.withColumn('label', when(col('up'), 'on', 'off'));
    expect(label.schema.at(-1)!.kind).toBe('string');
  });

  it('fill fills gaps here', () => {
    const out = series.withColumn('v0', col('v').fill(0));
    expect(out.toJSON().rows.map((r) => r.at(-1))).toEqual(
      rows.map((r) => r[1] ?? 0),
    );
  });
});

describe('checking', () => {
  it('names an unknown column and lists the real ones', () => {
    expect(() => series.filter(col('nope').gt(0))).toThrow(
      "filter: unknown column 'nope' (columns: v, w, host, up)",
    );
  });
  it('refuses wrong kinds', () => {
    expect(() => series.filter(col('host').gt(0))).toThrow(
      'gt needs two values of the same kind, got string and number',
    );
    expect(() => series.filter(col('v').add(1))).toThrow(
      'filter: needs a true/false expression, got number',
    );
    expect(() => series.filter(col('host').add(1))).toThrow(
      'add needs numbers',
    );
    expect(() => series.filter(col('v').and(true))).toThrow(
      'and needs true/false values',
    );
    expect(() => series.filter(col('host').in(['a', 1]))).toThrow(
      'in: 1 is not a string',
    );
    expect(() => series.filter(when(col('v'), 1, 2).gt(0))).toThrow(
      'when needs a true/false condition',
    );
    expect(() => series.filter(col('up').gt(true))).toThrow(
      'compares numbers or text',
    );
    const live = new LiveSeries({ name: 'l', schema });
    expect(() => live.filter(col('nope').gt(0))).toThrow(
      "unknown column 'nope'",
    );
  });
  it('refuses non-finite literals', () => {
    expect(() => lit(NaN)).toThrow('expected a finite number');
    expect(() => col('v').gt(Infinity as number)).not.toThrow(); // checked when applied
    expect(() => series.filter(col('v').gt(Infinity))).toThrow(
      'expected a finite number',
    );
  });
  it('array columns are refused', () => {
    const arr = new TimeSeries({
      name: 'a',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'tags', kind: 'array' },
      ] as const,
      rows: [[0, ['x']]],
    });
    expect(() => arr.filter(col('tags').isMissing())).toThrow(
      "column 'tags' is array",
    );
  });
});

describe('JSON form', () => {
  it('is a plain tree', () => {
    expect(
      JSON.parse(
        JSON.stringify(
          col('v')
            .gt(0)
            .and(col('host').in(['a'])),
        ),
      ),
    ).toEqual({
      op: 'and',
      args: [
        { op: 'gt', args: [{ col: 'v' }, { lit: 0 }] },
        { op: 'in', args: [{ col: 'host' }], values: ['a'] },
      ],
    });
    expect(when(col('up'), 1, lit(2)).toJSON()).toEqual({
      op: 'when',
      args: [{ col: 'up' }, { lit: 1 }, { lit: 2 }],
    });
  });
});
