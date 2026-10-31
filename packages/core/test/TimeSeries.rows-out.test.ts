import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

// [PND-ROWSOUT] `toJSON` / `toPoints` write rows from the columns when the
// rows' `Event`s do not exist yet, and from the events where they do. The
// output must not depend on which: each case below compares a fresh series
// (column path) with the same series after `.events` (event path).

type Kind = 'time' | 'timeRange' | 'interval';
const keyFor = (kind: Kind, t: number, i: number) =>
  kind === 'time'
    ? t
    : kind === 'timeRange'
      ? [t, t + (i % 3)]
      : [`L${i}`, t, t + (i % 3)];

function make(kind: Kind) {
  const schema = [
    { name: 'k', kind },
    { name: 'x', kind: 'number', required: false },
    { name: 's', kind: 'string', required: false },
    { name: 'b', kind: 'boolean', required: false },
  ] as const;
  const rows = [0, 1, 2, 3, 4, 5].map((i) => [
    keyFor(kind, i * 10, i),
    i === 1 ? undefined : i === 2 ? -0 : i * 1.5,
    i === 3 ? undefined : `v${i % 2}`,
    i === 4 ? undefined : i % 2 === 0,
  ]);
  return () =>
    new TimeSeries({ name: 'c', schema, rows: rows as never }) as TimeSeries<
      typeof schema
    >;
}

const exports = {
  toJSON: (s: TimeSeries<any>) => s.toJSON(),
  toJSONObject: (s: TimeSeries<any>) => s.toJSON({ rowFormat: 'object' }),
  toPoints: (s: TimeSeries<any>) => s.toPoints(),
};

describe('row exports read the columns [PND-ROWSOUT]', () => {
  for (const kind of ['time', 'timeRange', 'interval'] as const) {
    for (const [name, out] of Object.entries(exports)) {
      it(`${name} on a ${kind} key: same output with or without built events`, () => {
        const build = make(kind);
        const columnPath = out(build());
        const all = build();
        void all.events;
        const partial = build();
        partial.at(2);
        partial.at(4);
        expect(columnPath).toEqual(out(all));
        expect(columnPath).toEqual(out(partial));
        // -0 survives, gaps are null in JSON and undefined in points.
        expect(JSON.stringify(columnPath)).toBe(JSON.stringify(out(all)));
      });
    }
  }

  it('rows are frozen as before; toPoints freezes the array', () => {
    const s = make('time')();
    const json = s.toJSON();
    expect(Object.isFrozen(json.rows[0])).toBe(true);
    expect(Object.isFrozen(json.rows)).toBe(false);
    expect(Object.isFrozen(s.toJSON({ rowFormat: 'object' }).rows[0])).toBe(
      true,
    );
    const points = s.toPoints();
    expect(Object.isFrozen(points)).toBe(true);
    expect(Object.isFrozen(points[0])).toBe(true);
  });

  it('keeps -0 and gaps', () => {
    const s = make('time')();
    expect(Object.is(s.toPoints()[2]!.x, -0)).toBe(true);
    expect(s.toPoints()[1]!.x).toBeUndefined();
    expect('x' in s.toPoints()[1]!).toBe(true);
    expect(s.toJSON().rows[1]![1]).toBeNull();
  });

  it('a non-finite number stored by fromColumns reads as a gap, as before', () => {
    const s = TimeSeries.fromColumns({
      name: 'c',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'x', kind: 'number', required: false },
      ] as const,
      columns: { time: [0, 1, 2], x: new Float64Array([1, Infinity, NaN]) },
    });
    const fresh = s.toPoints();
    void s.events;
    expect(fresh).toEqual(s.toPoints());
    expect(fresh.map((p) => p.x)).toEqual([1, undefined, undefined]);
  });

  it('an empty series', () => {
    const s = new TimeSeries({
      name: 'c',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'x', kind: 'number' },
      ] as const,
      rows: [],
    });
    expect(s.toJSON().rows).toEqual([]);
    expect(s.toPoints()).toEqual([]);
  });
});
