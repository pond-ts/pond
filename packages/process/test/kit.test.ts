import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  BASIC_OPS,
  SUMMARY_FOLDS,
  createHost,
  createRegistry,
  requiredHistory,
  type Fact,
  type Registry,
  type Spec,
} from '../src/index.js';

// The basic steps and summary folds, driven the way an MCP server drives
// them: a JSON request through a host, facts read back by name.

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);
const schema = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number', required: false },
  { name: 'other', kind: 'number', required: false },
] as const;

/** Rows are `[close, other]`; `undefined` is a gap. */
function series(
  rows: [number | undefined, number | undefined][],
  step = DAY,
  start = T0,
) {
  return TimeSeries.fromJSON({
    name: 'px',
    schema,
    rows: rows.map(([c, o], i) => [start + i * step, c ?? null, o ?? null]),
  } as never);
}

function kit(): Registry {
  let registry: Registry = createRegistry();
  for (const def of [...BASIC_OPS, ...SUMMARY_FOLDS])
    registry = registry.define(def);
  return registry;
}

type Nodes = Record<
  string,
  Spec | { op: string; in: string[]; params?: object }
>;

/** Runs a slot request and returns the named facts and columns. */
function ask(data: ReturnType<typeof series>, nodes: Nodes, outputs: string[]) {
  const host = createHost({ registry: kit(), units: { close: 'USD' } }).add(
    'px',
    data,
  );
  const result = host.run({
    from: 'px',
    nodes: nodes as never,
    outputs: Object.fromEntries(outputs.map((o) => [o, { on: o }])),
    onError: 'throw',
  });
  const facts: Record<string, Fact> = {};
  for (const f of result.facts) facts[f.name!] = f;
  return { result, facts };
}

/** A column's cells as numbers, gaps as `undefined`. */
function cells(
  result: ReturnType<typeof ask>['result'],
  name: string,
): (number | undefined)[] {
  const info = Object.values(result.outputs)
    .flat()
    .find((o) => o.name === name)!;
  const col = result.columns![info.column]! as unknown as {
    length: number;
    read(i: number): unknown;
  };
  return Array.from({ length: col.length }, (_, i) => {
    const v = col.read(i);
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  });
}

const unitOf = (result: ReturnType<typeof ask>['result'], name: string) =>
  Object.values(result.outputs)
    .flat()
    .find((o) => o.name === name)!.unit;

const rows: [number | undefined, number | undefined][] = [
  [10, 5],
  [12, 4],
  [undefined, 3],
  [9, 0],
  [15, 5],
];

describe('basic steps', () => {
  it('arithmetic is row by row, and a gap on either side is a gap', () => {
    const { result } = ask(
      series(rows),
      {
        a: { op: 'add', in: ['close', 'other'] },
        s: { op: 'subtract', in: ['close', 'other'] },
        m: { op: 'multiply', in: ['close', 'other'] },
        d: { op: 'divide', in: ['close', 'other'] },
      },
      ['a', 's', 'm', 'd'],
    );
    expect(cells(result, 'a')).toEqual([15, 16, undefined, 9, 20]);
    expect(cells(result, 's')).toEqual([5, 8, undefined, 9, 10]);
    expect(cells(result, 'm')).toEqual([50, 48, undefined, 0, 75]);
    // 9 / 0 is Infinity, which a column cannot hold: a gap, not a number.
    expect(cells(result, 'd')).toEqual([2, 3, undefined, undefined, 3]);
  });

  it('units: subtract keeps the left unit, divide is a ratio, compare a signal', () => {
    const { result } = ask(
      series(rows),
      {
        s: { op: 'subtract', in: ['close', 'other'] },
        d: { op: 'divide', in: ['close', 'other'] },
        c: { op: 'compare', in: ['close'] },
      },
      ['s', 'd', 'c'],
    );
    expect(unitOf(result, 's')).toBe('USD');
    expect(unitOf(result, 'd')).toBe('ratio');
    expect(unitOf(result, 'c')).toBe('signal');
  });

  it('scale is x × factor + offset', () => {
    const { result } = ask(
      series(rows),
      { k: { op: 'scale', params: { factor: 2, offset: -1 }, in: ['close'] } },
      ['k'],
    );
    expect(cells(result, 'k')).toEqual([19, 23, undefined, 17, 29]);
  });

  it('shift reads the past for positive periods and the future for negative', () => {
    const { result } = ask(
      series(rows),
      {
        back: { op: 'shift', params: { periods: 1 }, in: ['close'] },
        ahead: { op: 'shift', params: { periods: -2 }, in: ['close'] },
      },
      ['back', 'ahead'],
    );
    expect(cells(result, 'back')).toEqual([undefined, 10, 12, undefined, 9]);
    expect(cells(result, 'ahead')).toEqual([
      undefined,
      9,
      15,
      undefined,
      undefined,
    ]);
  });

  it('compare and compareColumns write 1/0, every test', () => {
    const tests = ['above', 'below', 'atLeast', 'atMost', 'equal'] as const;
    const nodes: Nodes = {};
    for (const t of tests) {
      nodes[`c_${t}`] = {
        op: 'compare',
        params: { test: t, value: 12 },
        in: ['close'],
      };
      nodes[`cc_${t}`] = {
        op: 'compareColumns',
        params: { test: t },
        in: ['close', 'other'],
      };
    }
    const data = series([
      [10, 10],
      [12, 11],
      [14, 20],
      [undefined, 1],
    ]);
    const { result } = ask(data, nodes, Object.keys(nodes));
    expect(cells(result, 'c_above')).toEqual([0, 0, 1, undefined]);
    expect(cells(result, 'c_below')).toEqual([1, 0, 0, undefined]);
    expect(cells(result, 'c_atLeast')).toEqual([0, 1, 1, undefined]);
    expect(cells(result, 'c_atMost')).toEqual([1, 1, 0, undefined]);
    expect(cells(result, 'c_equal')).toEqual([0, 1, 0, undefined]);
    expect(cells(result, 'cc_above')).toEqual([0, 1, 0, undefined]);
    expect(cells(result, 'cc_below')).toEqual([0, 0, 1, undefined]);
    expect(cells(result, 'cc_atLeast')).toEqual([1, 1, 0, undefined]);
    expect(cells(result, 'cc_atMost')).toEqual([1, 0, 1, undefined]);
    expect(cells(result, 'cc_equal')).toEqual([1, 0, 0, undefined]);
  });

  it('and / or treat any non-zero value as true', () => {
    const data = series([
      [0, 0],
      [2, 0],
      [0, -1],
      [3, 4],
      [undefined, 1],
    ]);
    const { result } = ask(
      data,
      {
        both: { op: 'and', in: ['close', 'other'] },
        either: { op: 'or', in: ['close', 'other'] },
      },
      ['both', 'either'],
    );
    expect(cells(result, 'both')).toEqual([0, 0, 0, 1, undefined]);
    expect(cells(result, 'either')).toEqual([0, 1, 1, 1, undefined]);
  });

  it('cumulative runs through gaps without resetting', () => {
    const data = series([
      [2, 0],
      [3, 0],
      [undefined, 0],
      [1, 0],
      [5, 0],
    ]);
    const { result } = ask(
      data,
      {
        sum: { op: 'cumulative', params: { how: 'sum' }, in: ['close'] },
        prod: { op: 'cumulative', params: { how: 'product' }, in: ['close'] },
        max: { op: 'cumulative', params: { how: 'max' }, in: ['close'] },
        min: { op: 'cumulative', params: { how: 'min' }, in: ['close'] },
      },
      ['sum', 'prod', 'max', 'min'],
    );
    expect(cells(result, 'sum')).toEqual([2, 5, undefined, 6, 11]);
    expect(cells(result, 'prod')).toEqual([2, 6, undefined, 6, 30]);
    expect(cells(result, 'max')).toEqual([2, 3, undefined, 3, 5]);
    expect(cells(result, 'min')).toEqual([2, 2, undefined, 1, 1]);
  });

  it('hold carries the last non-zero value forward over zeros and gaps', () => {
    const data = series([
      [0, 0],
      [undefined, 0],
      [1, 0],
      [0, 0],
      [undefined, 0],
      [-1, 0],
      [0, 0],
    ]);
    const { result } = ask(data, { h: { op: 'hold', in: ['close'] } }, ['h']);
    expect(cells(result, 'h')).toEqual([0, undefined, 1, 1, 1, -1, -1]);
  });

  it('requiredHistory: shift declares its backward reach; cumulative and hold are unknown', () => {
    const registry = kit();
    const shifted: Spec = {
      op: 'shift',
      params: { periods: 5 },
      inputs: ['close'],
    };
    const ahead: Spec = {
      op: 'shift',
      params: { periods: -5 },
      inputs: ['close'],
    };
    expect(requiredHistory(registry, [shifted])).toMatchObject({
      known: true,
      rows: 5,
    });
    expect(requiredHistory(registry, [ahead])).toMatchObject({
      known: true,
      rows: 0,
    });
    const running: Spec = { op: 'cumulative', inputs: ['close'] };
    expect(requiredHistory(registry, [running]).known).toBe(false);
    expect(
      requiredHistory(registry, [{ op: 'hold', inputs: ['close'] }]).known,
    ).toBe(false);
  });
});

describe('summary folds', () => {
  const data = series([
    [1, 1],
    [2, 0],
    [undefined, 1],
    [4, 1],
    [3, 0],
  ]);

  it('mean, stdev (population), sum and count', () => {
    const { facts } = ask(
      data,
      {
        m: { op: 'mean', in: ['close'] },
        sd: { op: 'stdev', in: ['close'] },
        s: { op: 'sum', in: ['close'] },
        n: { op: 'count', in: ['close'] },
      },
      ['m', 'sd', 's', 'n'],
    );
    expect(facts['m']).toMatchObject({ value: 2.5, count: 4, unit: 'USD' });
    // Values 1,2,4,3: population variance 1.25.
    expect(facts['sd']).toMatchObject({ value: 1.118034, count: 4 });
    expect(facts['s']).toMatchObject({ value: 10, count: 4 });
    expect(facts['n']).toMatchObject({ value: 4, rows: 5, unit: 'rows' });
  });

  it('percentile interpolates linearly, q in 0–100', () => {
    const { facts } = ask(
      data,
      {
        p0: { op: 'percentile', params: { q: 0 }, in: ['close'] },
        p50: { op: 'percentile', in: ['close'] },
        p90: { op: 'percentile', params: { q: 90 }, in: ['close'] },
        p100: { op: 'percentile', params: { q: 100 }, in: ['close'] },
      },
      ['p0', 'p50', 'p90', 'p100'],
    );
    // Sorted 1,2,3,4: rank (q/100)·3.
    expect(facts['p0']!['value']).toBe(1);
    expect(facts['p50']!['value']).toBe(2.5);
    expect(facts['p90']!['value']).toBe(3.7);
    expect(facts['p100']!['value']).toBe(4);
  });

  it('percentile matches a full sort on ties, runs, gaps and signed zeros', () => {
    // It selects two order statistics instead of sorting; these are the
    // inputs that break a careless partition.
    let seed = 11;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const shapes: ((i: number, n: number) => number | undefined)[] = [
      () => Math.floor(rnd() * 3), // heavy ties
      (i) => i, // already sorted
      (i, n) => n - i, // reversed
      () => (rnd() < 0.3 ? undefined : rnd() * 10 - 5), // gaps
      () => (rnd() < 0.5 ? 0 : -0), // only zeros
    ];
    for (const [s, shape] of shapes.entries()) {
      const n = 257;
      const xs = Array.from({ length: n }, (_, i) => shape(i, n));
      const sorted = xs
        .filter((x): x is number => x !== undefined)
        .sort((a, b) => a - b);
      for (const q of [0, 5, 37.5, 50, 95, 100]) {
        const { facts } = ask(
          series(xs.map((x) => [x, undefined])),
          { p: { op: 'percentile', params: { q }, in: ['close'] } },
          ['p'],
        );
        const rank = (q / 100) * (sorted.length - 1);
        const lo = Math.floor(rank);
        const hi = Math.ceil(rank);
        const want = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
        const got = facts['p']!['value'] as number;
        expect(got, `shape ${s} q ${q}`).toBeCloseTo(want, 5);
        expect(Object.is(got, -0), `shape ${s} q ${q} gives -0`).toBe(false);
      }
    }
  });

  it('shareTrue, lastTrue and events read a signal as defined-and-non-zero', () => {
    const { facts } = ask(
      data,
      {
        share: { op: 'shareTrue', in: ['other'] },
        last: { op: 'lastTrue', in: ['other'] },
        all: { op: 'events', in: ['other'] },
        two: { op: 'events', params: { limit: 2 }, in: ['other'] },
      },
      ['share', 'last', 'all', 'two'],
    );
    expect(facts['share']).toMatchObject({ value: 0.6, true: 3, of: 5 });
    expect(facts['last']).toMatchObject({ value: 1, at: '2026-01-08' });
    expect(facts['all']).toMatchObject({
      count: 3,
      shown: 3,
      at: ['2026-01-05', '2026-01-07', '2026-01-08'],
    });
    // The newest two, still oldest first.
    expect(facts['two']).toMatchObject({
      count: 3,
      shown: 2,
      at: ['2026-01-07', '2026-01-08'],
    });
  });

  it('lastChange names the current value, since when, and what came before', () => {
    const d = series([
      [1, 0],
      [1, 0],
      [-1, 0],
      [undefined, 0],
      [-1, 0],
    ]);
    const { facts } = ask(
      d,
      {
        lc: { op: 'lastChange', in: ['close'] },
        flat: { op: 'lastChange', in: ['other'] },
      },
      ['lc', 'flat'],
    );
    expect(facts['lc']).toMatchObject({
      value: -1,
      since: '2026-01-07',
      previous: 1,
    });
    expect(facts['flat']).toMatchObject({
      value: 0,
      since: '2026-01-05',
      previous: null,
    });
  });

  it('meanWhere averages source where the signal is true, counting missing outcomes apart', () => {
    const d = series([
      [5, 1],
      [7, 0],
      [undefined, 1],
      [9, 1],
      [1, 0],
    ]);
    const { facts } = ask(
      d,
      { mw: { op: 'meanWhere', in: ['close', 'other'] } },
      ['mw'],
    );
    expect(facts['mw']).toMatchObject({ value: 7, count: 2, signals: 3 });
  });

  it('change gives first, last, the difference and the percent', () => {
    const { facts } = ask(data, { c: { op: 'change', in: ['close'] } }, ['c']);
    expect(facts['c']).toMatchObject({
      first: { value: 1, at: '2026-01-05' },
      last: { value: 3, at: '2026-01-09' },
      change: 2,
      percent: 200,
    });
  });

  it('every fold answers an all-gap column without throwing', () => {
    const empty = series([
      [undefined, undefined],
      [undefined, undefined],
    ]);
    const nodes: Nodes = {};
    for (const f of SUMMARY_FOLDS) {
      nodes[f.name] = {
        op: f.name,
        in: f.inputs.map((_, i) => (i === 0 ? 'close' : 'other')),
      };
    }
    const { facts } = ask(empty, nodes, Object.keys(nodes));
    expect(facts['mean']!['value']).toBeNull();
    expect(facts['stdev']!['value']).toBeNull();
    expect(facts['percentile']!['value']).toBeNull();
    expect(facts['shareTrue']!['value']).toBeNull();
    expect(facts['lastTrue']!['value']).toBeNull();
    expect(facts['lastChange']!['value']).toBeNull();
    expect(facts['events']).toMatchObject({ count: 0, at: [] });
    expect(facts['meanWhere']!['value']).toBeNull();
    expect(facts['change']!['first']).toBeNull();
    expect(facts['count']).toMatchObject({ value: 0, rows: 2 });
  });
});

describe('fact timestamps', () => {
  it('a daily row reads as its day; an intraday row carries its time', () => {
    const daily = ask(series(rows), { l: { op: 'last', in: ['close'] } }, [
      'l',
    ]);
    expect(daily.facts['l']!['at']).toBe('2026-01-09');

    const fiveMin = series(rows, 5 * 60_000, Date.UTC(2026, 0, 5, 14, 30));
    const intraday = ask(fiveMin, { l: { op: 'last', in: ['close'] } }, ['l']);
    expect(intraday.facts['l']!['at']).toBe('2026-01-05T14:50:00Z');
  });
});

describe('a worked agent question', () => {
  it('after close fell below its 3-bar average, what was the average 2-bar forward change?', () => {
    // Graph 43's shape on a small series: signal, forward return, mean where.
    const closes = [10, 11, 12, 11, 9, 10, 12, 13, 11, 10];
    const data = series(closes.map((c) => [c, 0]));
    let registry: Registry = kit();
    registry = registry.define({
      name: 'sma',
      family: 'trend',
      summary: 'Test SMA.',
      params: {},
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        const v = closes;
        void ctx;
        return v.map((_, i) =>
          i < 2 ? undefined : (v[i]! + v[i - 1]! + v[i - 2]!) / 3,
        );
      },
    });
    const host = createHost({ registry }).add('px', data);
    const result = host.run({
      from: 'px',
      nodes: {
        avg: { op: 'sma', in: ['close'] },
        dip: {
          op: 'compareColumns',
          params: { test: 'below' },
          in: ['close', 'avg'],
        },
        later: { op: 'shift', params: { periods: -2 }, in: ['close'] },
        ratio: { op: 'divide', in: ['later', 'close'] },
        fwd: {
          op: 'scale',
          params: { factor: 100, offset: -100 },
          in: ['ratio'],
        },
        answer: { op: 'meanWhere', in: ['fwd', 'dip'] },
      },
      outputs: { answer: { on: 'answer' } },
    } as never);
    // Dips (close < 3-bar avg) at rows 3 (11<11.33), 4 (9<10.67); row 5 (10 vs 10)
    // is not below; then rows 8 (11<12) and 9 (10<11.33).
    // Forward 2-bar change: row3 11→10 = −9.0909%, row4 9→12 = +33.3333%,
    // row8 and row9 run past the end, so they count as signals only.
    const fact = result.facts[0]!;
    expect(fact).toMatchObject({ count: 2, signals: 4 });
    expect(fact['value']).toBeCloseTo((-100 / 11 + 100 / 3) / 2, 5);
  });
});

describe('review findings', () => {
  const boolSchema = [
    { name: 'time', kind: 'time' },
    { name: 'flag', kind: 'boolean', required: false },
  ] as const;

  it('a boolean column reads as 1/0 in steps and folds alike', () => {
    const flags = [true, false, true, null, true];
    const data = TimeSeries.fromJSON({
      name: 'flags',
      schema: boolSchema,
      rows: flags.map((f, i) => [T0 + i * DAY, f]),
    } as never);
    const host = createHost({ registry: kit() }).add('f', data);
    const result = host.run({
      from: 'f',
      nodes: {
        direct: { op: 'shareTrue', in: ['flag'] },
        tested: {
          op: 'compare',
          params: { test: 'equal', value: 1 },
          in: ['flag'],
        },
        viaStep: { op: 'shareTrue', in: ['tested'] },
      },
      outputs: { direct: { on: 'direct' }, viaStep: { on: 'viaStep' } },
    } as never);
    const byName = Object.fromEntries(result.facts.map((f) => [f.name, f]));
    expect(byName['direct']).toMatchObject({ true: 3, of: 4 });
    expect(byName['viaStep']).toMatchObject({ true: 3, of: 4 });
  });

  it('cumulative product that overflows and meets a 0 stays a gap, never restarts', () => {
    const data = series([
      [1e200, 0],
      [1e200, 0],
      [0, 0],
      [5, 0],
    ]);
    const { result } = ask(
      data,
      { p: { op: 'cumulative', params: { how: 'product' }, in: ['close'] } },
      ['p'],
    );
    // Infinity is a missing cell, and Infinity × 0 is NaN: both gaps.
    expect(cells(result, 'p')).toEqual([
      1e200,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('an intraday row on 00:00 UTC still prints its time, so one list never mixes formats', () => {
    const hourly = series(
      [
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      60 * 60_000,
      Date.UTC(2026, 0, 5, 23, 0),
    );
    const { facts } = ask(hourly, { e: { op: 'events', in: ['other'] } }, [
      'e',
    ]);
    expect(facts['e']!['at']).toEqual([
      '2026-01-05T23:00:00Z',
      '2026-01-06T00:00:00Z',
      '2026-01-06T01:00:00Z',
    ]);
    // A list of dates carries no price unit.
    expect(facts['e']!['unit']).toBe('dates');
  });
});
