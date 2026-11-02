import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

// [PND-GROUPEVENTS] `groupBy` gathers groups off the columns and
// `pivotByGroup` reads cells off the columns, unless the events may hold
// values the columns don't. The output must match the event path, which
// is what a series with a dense event array (a `map` result) still takes.

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'x', kind: 'number', required: false },
  { name: 'g', kind: 'string', required: false },
  { name: 'h', kind: 'number', required: false },
] as const;
const rows = [
  [0, 1, 'a', 1],
  [0, 2, 'undefined', 2],
  [1, -0, undefined, 1],
  [2, 4, 'b', undefined],
  [2, 5, 'a', 2],
  [3, undefined, ' undefined', 1],
] as const;
const fresh = () => new TimeSeries({ name: 's', schema, rows: rows as never });
// `map` with an identity mapper gives the same data on the event path.
const viaEvents = () => fresh().map(schema, (e) => e);

const dump = (m: Map<string, TimeSeries<any>>) =>
  [...m].map(([k, s]) => [k, s.name, s.schema, s.toRows()]);

describe('groupBy / pivotByGroup from the columns [PND-GROUPEVENTS]', () => {
  for (const col of ['g', 'h', 'x', 'time', 'missing'] as const) {
    it(`groupBy('${col}') matches the event path`, () => {
      expect(dump(fresh().groupBy(col as 'g'))).toEqual(
        dump(viaEvents().groupBy(col as 'g')),
      );
    });
  }

  it("a gap and the string 'undefined' share the 'undefined' group, as before", () => {
    const groups = fresh().groupBy('g');
    expect([...groups.keys()]).toEqual(['a', 'undefined', 'b', ' undefined']);
    expect(groups.get('undefined')!.length).toBe(2);
  });

  it('groups are full series with the source schema and name', () => {
    const a = fresh().groupBy('g').get('a')!;
    expect(a.schema).toEqual(fresh().schema);
    expect(a.toRows().map((r) => r[1])).toEqual([1, 5]);
    expect(Object.is(fresh().groupBy('h').get('1')!.at(1)!.get('x'), -0)).toBe(
      true,
    );
  });

  it('transform gets each group and its key', () => {
    const seen = fresh().groupBy('g', (grp, key) => `${key}:${grp.length}`);
    expect([...seen.values()]).toEqual([
      'a:2',
      'undefined:2',
      'b:1',
      ' undefined:1',
    ]);
  });

  it('a required column holding a gap still throws, as the event path did', () => {
    const s = TimeSeries.fromColumns({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'x', kind: 'number' },
        { name: 'g', kind: 'string' },
      ] as const,
      columns: { time: [0, 1], x: new Float64Array([1, NaN]), g: ['a', 'a'] },
    });
    expect(() => s.groupBy('g')).toThrow(/required/);
  });

  for (const [label, call] of [
    [
      'plain',
      (s: TimeSeries<typeof schema>) =>
        s.pivotByGroup('h', 'x', { aggregate: 'sum' }),
    ],
    [
      'typed groups',
      (s: TimeSeries<typeof schema>) =>
        s.pivotByGroup('h', 'x', {
          groups: ['1', '2', 'undefined'],
          aggregate: 'first',
        }),
    ],
    [
      'key column as group',
      (s: TimeSeries<typeof schema>) =>
        s.pivotByGroup('time' as 'g', 'x', { aggregate: 'sum' }),
    ],
  ] as const) {
    it(`pivotByGroup (${label}) matches the event path`, () => {
      const a = call(fresh());
      const b = call(viaEvents());
      expect([a.schema, a.toRows()]).toEqual([b.schema, b.toRows()]);
    });
  }

  it('pivotByGroup duplicate error is unchanged', () => {
    const message = (s: TimeSeries<typeof schema>) => {
      try {
        s.pivotByGroup('time' as 'g', 'x');
      } catch (e) {
        return (e as Error).message;
      }
      return 'no error';
    };
    expect(message(fresh())).toMatch(
      /^pivotByGroup: 2 events share timestamp 0/,
    );
    expect(message(fresh())).toBe(message(viaEvents()));
  });
});
