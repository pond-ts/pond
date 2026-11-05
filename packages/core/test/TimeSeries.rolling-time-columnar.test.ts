/**
 * Tests for the **duration-window columnar fast path** on `TimeSeries.rolling`
 * (`tryRollingTimeColumnarNumeric`, [PND-ROLLTIME]): an all-built-in numeric
 * mapping over packed sources finds each row's window once from the keys
 * and sweeps each column with its reducer state.
 *
 * The guarantee is that it is plumbing only: the same states, fed the same
 * values in the same order and read at the same rows, so the output is
 * identical to the generic sweep. Each test runs a mapping twice, once as is
 * (fast path) and once with a custom-function column added (which sends the
 * whole call down the generic sweep), and compares cells with `Object.is`.
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
] as const;

type Row = [number, number | undefined];

function series(rows: Row[]) {
  return new TimeSeries({ name: 's', schema, rows });
}

const REDUCERS = [
  'sum',
  'avg',
  'min',
  'max',
  'count',
  'median',
  'p10',
  'stdev',
  'first',
  'last',
  'difference',
  'keep',
] as const;

/** Every built-in reducer as its own output column. */
const allBuiltIns = Object.fromEntries(
  REDUCERS.map((r) => [`o_${r}`, { from: 'v', using: r }]),
);

/** A custom reducer: adding it sends the whole call down the generic sweep. */
const customCount = {
  from: 'v',
  using: (vals: ReadonlyArray<unknown>) => vals.length,
} as const;

function cells(s: TimeSeries<any>, name: string): number[] {
  return [...s.column(name).toFloat64Array()];
}

function expectSameAsGeneric(
  s: TimeSeries<any>,
  window: string,
  options: {
    alignment?: 'trailing' | 'leading' | 'centered';
    minSamples?: number;
  } = {},
) {
  const fast = s.rolling(window, allBuiltIns, options);
  const generic = s.rolling(
    window,
    { ...allBuiltIns, z: customCount },
    options,
  );
  for (const r of REDUCERS) {
    const a = cells(fast, `o_${r}`);
    const b = cells(generic, `o_${r}`);
    expect(a.length).toBe(b.length);
    a.forEach((v, i) => {
      if (!Object.is(v, b[i]))
        throw new Error(`${r} row ${i}: fast ${v}, generic ${b[i]}`);
    });
  }
}

const ALIGNMENTS = ['trailing', 'leading', 'centered'] as const;

describe('rolling: duration-window fast path matches the generic sweep', () => {
  it.each(ALIGNMENTS)('on an even grid with gaps (%s)', (alignment) => {
    const rows: Row[] = Array.from({ length: 60 }, (_, i) => [
      i * 1000,
      i % 7 === 3 ? undefined : Math.sin(i) * 50,
    ]);
    expectSameAsGeneric(series(rows), '5s', { alignment });
  });

  it.each(ALIGNMENTS)('with duplicate keys (%s)', (alignment) => {
    // Rows sharing a key share one window, read once: a stdev read can move
    // its internal shift, so a second read could differ in the last bits.
    const rows: Row[] = Array.from({ length: 90 }, (_, i) => [
      Math.floor(i / 2) * 700,
      i % 11 === 0 ? undefined : ((i * 37) % 23) - 11.5,
    ]);
    expectSameAsGeneric(series(rows), '20s', { alignment });
  });

  it.each(ALIGNMENTS)('across long gaps in time (%s)', (alignment) => {
    // Gaps longer than the window leave leading and centered windows empty,
    // which steps past rows that never entered ([PND-ROLLEMPTY]).
    const rows: Row[] = [];
    let t = 0;
    for (let i = 0; i < 50; i++) {
      t += i % 10 === 0 ? 60_000 : 1000;
      rows.push([t, i % 4 === 0 ? -0 : i * 1.5]);
    }
    expectSameAsGeneric(series(rows), '3s', { alignment });
  });

  it.each(ALIGNMENTS)('with minSamples (%s)', (alignment) => {
    const rows: Row[] = Array.from({ length: 40 }, (_, i) => [
      i * 1500,
      i % 5 === 0 ? undefined : i,
    ]);
    expectSameAsGeneric(series(rows), '4s', { alignment, minSamples: 3 });
  });

  it.each(ALIGNMENTS)(
    'with values big enough for the overflow lanes (%s)',
    (alignment) => {
      // 1e300 is past the stdev lane split (2^480) and sum's (2^960): the
      // column runs the laned states from the start, as the generic sweep.
      const rows: Row[] = Array.from({ length: 40 }, (_, i) => [
        i * 1000,
        i === 12 ? 1e300 : i === 20 ? -1e300 : i * 0.1,
      ]);
      expectSameAsGeneric(series(rows), '5s', { alignment });
    },
  );

  it('on a one-row window and an empty series', () => {
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => [i * 1000, i]);
    expectSameAsGeneric(series(rows), '1ms');
    const empty = series([]).rolling('5s', { v: 'avg' });
    expect(empty.length).toBe(0);
    expect(empty.schema.map((c) => c.name)).toEqual(['time', 'v']);
  });

  it('gives the expected trailing average', () => {
    const s = series([
      [0, 1],
      [1000, 2],
      [2000, undefined],
      [3000, 4],
    ]);
    // trailing (t - 2s, t]
    expect(cells(s.rolling('2s', { v: 'avg' }), 'v')).toEqual([1, 1.5, 2, 4]);
  });
});

describe('rolling: seeded random cases match the generic sweep', () => {
  // A fixed-seed generator, so a failure names a case that can be re-run.
  let seed = 20261105;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;

  const value = (): number | undefined => {
    const r = rnd();
    if (r < 0.1) return undefined;
    if (r < 0.13) return -0;
    if (r < 0.14) return rnd() < 0.5 ? 1e300 : -1e300;
    return (rnd() - 0.5) * 100;
  };

  /** Keys on a grid, with jitter, repeats and long gaps mixed in. */
  function times(n: number): number[] {
    const out: number[] = [];
    let t = Math.floor(rnd() * 1000);
    const style = pick(['grid', 'jitter', 'dupes', 'gaps'] as const);
    for (let i = 0; i < n; i++) {
      if (style === 'grid') t += 1000;
      else if (style === 'jitter') t += Math.floor(rnd() * 2000);
      else if (style === 'dupes') t += rnd() < 0.4 ? 0 : 700;
      else t += rnd() < 0.05 ? 60_000 : 1000;
      out.push(t);
    }
    return out;
  }

  const WINDOWS = ['0ms', '1ms', '500ms', '1401ms', '5s', '1h', 999.9];

  function expectSame(
    fast: TimeSeries<any>,
    generic: TimeSeries<any>,
    tag: string,
  ) {
    for (const r of REDUCERS) {
      const a = cells(fast, `o_${r}`);
      const b = cells(generic, `o_${r}`);
      expect(a.length).toBe(b.length);
      a.forEach((v, i) => {
        if (!Object.is(v, b[i]))
          throw new Error(`${tag} ${r} row ${i}: fast ${v}, generic ${b[i]}`);
      });
    }
  }

  it('on time keys', () => {
    for (let k = 0; k < 150; k++) {
      const n = 1 + Math.floor(rnd() * 300);
      const s = series(times(n).map((t): Row => [t, value()]));
      const window = pick(WINDOWS);
      const options = {
        alignment: pick(ALIGNMENTS),
        ...(rnd() < 0.3 ? { minSamples: Math.floor(rnd() * 5) } : {}),
      };
      expectSame(
        s.rolling(window, allBuiltIns, options),
        s.rolling(window, { ...allBuiltIns, z: customCount }, options),
        `case ${k} (${n} rows, ${window}, ${JSON.stringify(options)})`,
      );
    }
  });

  it('on interval keys, partitioned, and with append', () => {
    const ivSchema = [
      { name: 'interval', kind: 'interval' },
      { name: 'v', kind: 'number', required: false },
      { name: 'g', kind: 'string' },
    ] as const;
    for (let k = 0; k < 40; k++) {
      const n = 1 + Math.floor(rnd() * 200);
      const rows = times(n).map(
        (t, i) =>
          [[`k${i}`, t, t + 500], value(), pick(['a', 'b'])] as [
            [string, number, number],
            number | undefined,
            string,
          ],
      );
      const s = new TimeSeries({ name: 's', schema: ivSchema, rows });
      const window = pick(WINDOWS);
      const alignment = pick(ALIGNMENTS);
      const tag = `case ${k} (${n} rows, ${window}, ${alignment})`;
      expectSame(
        s.rolling(window, allBuiltIns, { alignment }),
        s.rolling(window, { ...allBuiltIns, z: customCount }, { alignment }),
        `${tag} interval`,
      );
      expectSame(
        s
          .partitionBy('g')
          .rolling(window, allBuiltIns, { alignment })
          .collect(),
        s
          .partitionBy('g')
          .rolling(window, { ...allBuiltIns, z: customCount }, { alignment })
          .collect(),
        `${tag} partitioned`,
      );
      expectSame(
        s.rolling(window, allBuiltIns, { alignment, append: true }),
        s.rolling(
          window,
          { ...allBuiltIns, z: customCount },
          { alignment, append: true },
        ),
        `${tag} append`,
      );
    }
  });
});

describe('scan: typed path over a packed column', () => {
  const rows: Row[] = [
    [0, undefined],
    [1000, 1],
    [2000, undefined],
    [3000, 2],
    [4000, -0],
  ];

  it('carries over gaps and is missing before the first value', () => {
    const out = series(rows).scan('v', (a, v) => [a + v, a + v], 0);
    expect(cells(out, 'v')).toEqual([NaN, 1, 1, 3, 3]);
    expect(out.column('v').hasMissing()).toBe(true);
  });

  it('stores a non-finite step output as missing, and keeps -0', () => {
    const out = series(rows).scan(
      'v',
      (a, v) => [a, v === 2 ? Infinity : v === 1 ? -0 : v],
      0,
      { output: 'o' },
    );
    const o = cells(out, 'o');
    expect(o[1]).toBe(-0);
    expect(Object.is(o[1], -0)).toBe(true);
    expect(Number.isNaN(o[3]!)).toBe(true);
    expect(out.at(3)!.get('o')).toBeUndefined();
  });

  it('matches a plain reference fold', () => {
    const values = Array.from({ length: 200 }, (_, i) =>
      i % 9 === 0 ? undefined : ((i * 31) % 17) - 8,
    );
    const s = series(values.map((v, i): Row => [i * 1000, v]));
    const step = (a: number, v: number) =>
      [a + v, v === 0 ? NaN : a * 0.5 + v] as const;
    // reference: missing cells carry the last output; NaN output is a gap
    const want: number[] = [];
    let acc = 0;
    let last = NaN;
    for (const v of values) {
      if (v !== undefined) {
        const [next, out] = step(acc, v);
        acc = next;
        last = out;
      }
      want.push(last);
    }
    const got = cells(s.scan('v', step, 0), 'v');
    got.forEach((v, i) => expect(Object.is(v, want[i])).toBe(true));
  });
});
