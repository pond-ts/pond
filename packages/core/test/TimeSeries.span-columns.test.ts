import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeRange, TimeSeries } from '../src/index.js';

// [PND-SPANFILTER] `before` / `after` / `within` / `tail` / `overlapping` /
// `containedBy` pick rows off the key buffers, and [PND-ROWSOUT] `rows` /
// `toObjects` write rows from the columns, without building an `Event` per
// row. Results must match what `filter` and the event path gave, including
// which `Event` / key objects come back.

type Kind = 'time' | 'timeRange' | 'interval';
const keyFor = (kind: Kind, t: number, i: number) =>
  kind === 'time'
    ? t
    : kind === 'timeRange'
      ? [t, t + (i % 3) * 4]
      : [`L${i}`, t, t + (i % 3) * 4];

const schema = (kind: Kind) =>
  [
    { name: 'k', kind },
    { name: 'x', kind: 'number', required: false },
    { name: 's', kind: 'string', required: false },
  ] as const;

function make(kind: Kind, n = 8) {
  const rows = Array.from({ length: n }, (_, i) => [
    keyFor(kind, i * 10, i),
    i === 1 ? undefined : i * 1.5,
    `v${i % 2}`,
  ]);
  return new TimeSeries({
    name: 'c',
    schema: schema(kind),
    rows: rows as never,
  }) as TimeSeries<any>;
}

// The same selection written as the old `filter` predicate.
const cases: Array<
  [string, (s: TimeSeries<any>) => TimeSeries<any>, (e: any) => boolean]
> = [
  ['before', (s) => s.before(30), (e) => e.end() < 30],
  ['after', (s) => s.after(30), (e) => e.begin() > 30],
  ['within', (s) => s.within(10, 50), (e) => e.begin() >= 10 && e.end() <= 50],
  [
    'overlapping',
    (s) => s.overlapping([22, 40]),
    (e) => e.overlaps(new TimeRange({ start: 22, end: 40 })),
  ],
  [
    'containedBy',
    (s) => s.containedBy(['q', 10, 52]),
    (e) => e.begin() >= 10 && e.end() <= 52,
  ],
  ['tail', (s) => s.tail(30), (e) => e.begin() > 40],
];

afterEach(() => vi.restoreAllMocks());

describe('key-span selectors read the key buffers [PND-SPANFILTER]', () => {
  for (const kind of ['time', 'timeRange', 'interval'] as const) {
    for (const [name, select, predicate] of cases) {
      it(`${name} on a ${kind} key matches filter and keeps event identity`, () => {
        const expected = make(kind).filter(predicate);
        const s = make(kind);
        const spy = vi.spyOn(TimeSeries.prototype, 'events', 'get');
        const out = select(s);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        expect(out.toJSON()).toEqual(expected.toJSON());
        expect(out.length).toBeGreaterThan(0);
        expect(out.length).toBeLessThan(s.length);
        // A kept row's event is the source row's own, whichever is asked first.
        const first = out.at(0)!;
        const i = s.events.indexOf(first as never);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(out.at(out.length - 1)).toBe(s.at(i + out.length - 1));
      });
    }
  }

  it('an empty series never reads the range, a non-empty one throws as before', () => {
    const empty = make('time', 0);
    expect(empty.overlapping([9, 2]).length).toBe(0);
    let oldMessage = '';
    try {
      make('time').filter((e) => e.overlaps([9, 2]));
    } catch (e) {
      oldMessage = (e as Error).message;
    }
    expect(oldMessage).not.toBe('');
    expect(() => make('time').overlapping([9, 2])).toThrow(oldMessage);
  });

  it('a NaN boundary keeps nothing, as the comparisons did', () => {
    expect(make('time').before(NaN).length).toBe(0);
    expect(make('time').after(NaN).length).toBe(0);
  });

  it('chained selectors still hand back the first source row events', () => {
    const s = make('timeRange');
    const out = s.after(5).before(70).within(0, 80);
    expect(out.at(0)).toBe(s.at(1));
  });
});

describe('rows / toObjects read the columns [PND-ROWSOUT]', () => {
  const exportsOf = {
    rows: (s: TimeSeries<any>) => s.rows,
    toObjects: (s: TimeSeries<any>) => s.toObjects(),
  };
  const keyOf = (r: any) => (Array.isArray(r) ? r[0] : r.k);

  for (const kind of ['time', 'timeRange', 'interval'] as const) {
    for (const [name, out] of Object.entries(exportsOf)) {
      it(`${name} on a ${kind} key: same rows and key identity as the event path`, () => {
        const all = make(kind);
        void all.events;
        const expected = out(all);
        const s = make(kind);
        const spy = vi.spyOn(TimeSeries.prototype, 'events', 'get');
        const got = out(s);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        expect(got).toEqual(expected);
        expect(Object.isFrozen(got[0])).toBe(true);
        // Keys are the ones the events get later.
        got.forEach((r: any, i: number) =>
          expect(keyOf(r)).toBe(s.at(i)!.key()),
        );
      });
    }
  }

  it('a delegated store (after, dedupe) hands out its source rows keys', () => {
    for (const s of [make('time'), make('interval')]) {
      const picked = s.after(15);
      const rows = picked.rows;
      rows.forEach((r: any, i: number) => {
        expect(r[0]).toBe(picked.at(i)!.key());
        expect(picked.at(i)).toBe(s.at(i + 2));
      });
      const objects = s.dedupe().toObjects();
      objects.forEach((r: any, i: number) => expect(r.k).toBe(s.at(i)!.key()));
    }
  });

  it('a filter result (dense events) hands out its events keys', () => {
    const s = make('timeRange');
    const kept = s.filter((e) => e.begin() > 15);
    const rows = kept.after(0).rows;
    rows.forEach((r: any, i: number) => {
      expect(r[0]).toBe(kept.at(i)!.key());
      expect(r[0]).toBe(s.at(i + 2)!.key());
    });
  });

  it('a series with an array column takes the event path', () => {
    const s = new TimeSeries({
      name: 'a',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'tags', kind: 'array', required: false },
      ] as const,
      rows: [
        [1, ['p', 'q']],
        [2, undefined],
      ] as never,
    });
    const rows = s.rows;
    expect(rows[0]![1]).toBe(s.at(0)!.data().tags);
    expect(rows[1]![1]).toBeUndefined();
  });
});
