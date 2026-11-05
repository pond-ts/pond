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
    expect(series([]).rolling('5s', { v: 'avg' }).length).toBe(0);
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
