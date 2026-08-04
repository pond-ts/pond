import { describe, expect, it } from 'vitest';
import { TimeSeries, ValueSeries } from 'pond-ts';
import {
  listFraction,
  listRowsFromTimeSeries,
  listRowsFromValueSeries,
  resolveListDomain,
  sortListRows,
  validateBoxListColumn,
  type ListRow,
} from '../src/list.js';

const row = (key: string, values: ListRow['values']): ListRow => ({
  key,
  values,
});

describe('sortListRows', () => {
  const rows = [
    row('a', { v: 3, name: 'web1' }),
    row('b', { v: 9, name: 'db2' }),
    row('c', { v: 5, name: 'app3' }),
  ];

  it('leaves input order without sortBy', () => {
    expect(sortListRows(rows, undefined, 'desc')).toBe(rows);
  });

  it('sorts desc (largest first) and asc', () => {
    expect(sortListRows(rows, 'v', 'desc').map((r) => r.key)).toEqual([
      'b',
      'c',
      'a',
    ]);
    expect(sortListRows(rows, 'v', 'asc').map((r) => r.key)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('does not mutate the input', () => {
    sortListRows(rows, 'v', 'desc');
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('sorts missing / non-finite last in both directions', () => {
    const withGaps = [
      row('gap', { v: undefined }),
      row('hi', { v: 9 }),
      row('nan', { v: NaN }),
      row('lo', { v: 1 }),
    ];
    expect(sortListRows(withGaps, 'v', 'desc').map((r) => r.key)).toEqual([
      'hi',
      'lo',
      'gap',
      'nan',
    ]);
    expect(sortListRows(withGaps, 'v', 'asc').map((r) => r.key)).toEqual([
      'lo',
      'hi',
      'gap',
      'nan',
    ]);
  });

  it('sorts strings lexicographically, numbers before strings', () => {
    expect(sortListRows(rows, 'name', 'asc').map((r) => r.key)).toEqual([
      'c', // app3
      'b', // db2
      'a', // web1
    ]);
    const mixed = [row('s', { v: 'x' }), row('n', { v: 2 })];
    expect(sortListRows(mixed, 'v', 'desc').map((r) => r.key)).toEqual([
      'n',
      's',
    ]);
    expect(sortListRows(mixed, 'v', 'asc').map((r) => r.key)).toEqual([
      'n',
      's',
    ]);
  });

  it('a custom comparator overrides sortBy entirely', () => {
    const out = sortListRows(rows, 'v', 'desc', (a, b) =>
      a.key.localeCompare(b.key),
    );
    expect(out.map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('is stable on ties', () => {
    const tied = [row('x', { v: 1 }), row('y', { v: 1 }), row('z', { v: 1 })];
    expect(sortListRows(tied, 'v', 'desc').map((r) => r.key)).toEqual([
      'x',
      'y',
      'z',
    ]);
  });
});

describe('resolveListDomain', () => {
  it('spans [0, max] over the named keys', () => {
    const rows = [row('a', { v: 3, w: 8 }), row('b', { v: 5, w: 2 })];
    expect(resolveListDomain(rows, ['v', 'w'])).toEqual([0, 8]);
    // Only the named keys participate.
    expect(resolveListDomain(rows, ['v'])).toEqual([0, 5]);
  });

  it('keeps a below-zero minimum (a negative whisker still fits)', () => {
    const rows = [row('a', { lo: -4, hi: 6 })];
    expect(resolveListDomain(rows, ['lo', 'hi'])).toEqual([-4, 6]);
  });

  it('ignores missing / string values and falls back to [0, 1] when empty', () => {
    const rows = [row('a', { v: undefined, s: 'txt' })];
    expect(resolveListDomain(rows, ['v', 's'])).toEqual([0, 1]);
    expect(resolveListDomain([], ['v'])).toEqual([0, 1]);
  });

  it('an explicit domain wins outright', () => {
    const rows = [row('a', { v: 3 })];
    expect(resolveListDomain(rows, ['v'], [0, 100])).toEqual([0, 100]);
  });
});

describe('listFraction', () => {
  it('maps into [0, 1] and clamps out-of-domain values', () => {
    expect(listFraction(5, [0, 10])).toBe(0.5);
    expect(listFraction(-3, [0, 10])).toBe(0);
    expect(listFraction(15, [0, 10])).toBe(1);
  });

  it('gaps are null; a degenerate domain maps to 0', () => {
    expect(listFraction(undefined, [0, 10])).toBeNull();
    expect(listFraction(NaN, [0, 10])).toBeNull();
    expect(listFraction('9' as unknown as number, [0, 10])).toBeNull();
    expect(listFraction(7, [7, 7])).toBe(0);
  });
});

describe('validateBoxListColumn', () => {
  it('rejects a half-specified body, accepts none / both', () => {
    expect(() =>
      validateBoxListColumn({ lower: 'lo', q1: 'q1', upper: 'hi' }),
    ).toThrow(/both-or-neither/);
    expect(() =>
      validateBoxListColumn({ lower: 'lo', q3: 'q3', upper: 'hi' }),
    ).toThrow(/both-or-neither/);
    expect(() =>
      validateBoxListColumn({ lower: 'lo', upper: 'hi' }),
    ).not.toThrow();
    expect(() =>
      validateBoxListColumn({ lower: 'lo', q1: 'a', q3: 'b', upper: 'hi' }),
    ).not.toThrow();
  });
});

describe('listRowsFromTimeSeries', () => {
  const series = () =>
    new TimeSeries({
      name: 'splits',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'speed', kind: 'number', required: false },
        { name: 'surface', kind: 'string' },
      ] as const,
      rows: [
        [1000, 7.3, 'road'],
        [2000, 15.3, 'track'],
        [3000, undefined, 'trail'],
      ] as Array<[number, number | undefined, string]>,
    });

  it('one row per event; numeric + string columns land in values', () => {
    const rows = listRowsFromTimeSeries(series());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      key: '1000',
      values: { speed: 7.3, surface: 'road' },
    });
    // A missing cell reads as a gap, not 0.
    expect(rows[2]!.values.speed).toBeUndefined();
    expect(rows[2]!.values.surface).toBe('trail');
  });

  it('labels come from the option (ordinal + axis key)', () => {
    const rows = listRowsFromTimeSeries(series(), {
      label: (i, key) => `${i + 1}@${key}`,
    });
    expect(rows[0]!.label).toBe('1@1000');
    expect(rows[2]!.label).toBe('3@3000');
    // Without the option, no label field at all (the table falls back to key).
    expect('label' in listRowsFromTimeSeries(series())[0]!).toBe(false);
  });
});

describe('listRowsFromValueSeries', () => {
  it('keys rows on the axis value', () => {
    const vs = ValueSeries.fromColumns({
      name: 'byDist',
      schema: [
        { name: 'km', kind: 'value' },
        { name: 'pace', kind: 'number' },
      ] as const,
      columns: { km: [1, 2, 5], pace: [4.1, 3.9, 4.4] },
    });
    const rows = listRowsFromValueSeries(vs, { label: (i) => `${i + 1}` });
    expect(rows.map((r) => r.key)).toEqual(['1', '2', '5']);
    expect(rows[1]).toMatchObject({ label: '2', values: { pace: 3.9 } });
  });
});
