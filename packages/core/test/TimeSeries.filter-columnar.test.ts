import { describe, expect, it } from 'vitest';
import { TimeRange, TimeSeries } from '../src/index.js';
import { SeriesStore } from '../src/live/series-store.js';
import {
  ColumnarStore,
  float64ColumnFromArray,
  timeKeyColumnFromArray,
} from '../src/columnar/index.js';

/* -------------------------------------------------------------------------- */
/* [PND-FILTERTAKE] — `filter` copies the kept rows out of each column         */
/* (`withRowSelection`) instead of rebuilding every column from the kept       */
/* `Event` objects, and hands the kept events to the result as a dense array.  */
/*                                                                             */
/* The reference is the OLD code path, still reachable through the public API: */
/* `TimeSeries.fromEvents(source.events.filter(pred), …)` is exactly what      */
/* `filter` used to do (`fromEvents` sorts, and a stable sort of already-      */
/* sorted events is the identity, duplicate keys included). Every case below  */
/* compares against it rather than hard-coded values.                          */
/* -------------------------------------------------------------------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type AnySeries = TimeSeries<never>;

/** Old `filter`: rebuild from the kept events. */
function referenceFilter(
  s: AnySeries,
  pred: (e: never, i: number) => unknown,
): AnySeries {
  return TimeSeries.fromEvents(
    s.events.filter((e, i) => pred(e as never, i)) as never,
    { schema: s.schema as never, name: s.name },
  ) as AnySeries;
}

function expectSameSeries(actual: AnySeries, expected: AnySeries) {
  expect(actual.name).toBe(expected.name);
  expect(actual.schema).toEqual(expected.schema);
  expect(actual.length).toBe(expected.length);
  // Rows carry the key (as its JSON form) and every cell.
  expect(actual.toJSON()).toEqual(expected.toJSON());
  // Cell-by-cell through the column API too, with Object.is so -0 counts.
  for (const def of actual.schema.slice(1)) {
    const a = actual.column(def.name as never) as {
      read(i: number): unknown;
    };
    const b = expected.column(def.name as never) as {
      read(i: number): unknown;
    };
    for (let i = 0; i < actual.length; i += 1) {
      const x = a.read(i);
      const y = b.read(i);
      if (typeof x === 'number' || typeof y === 'number') {
        expect(Object.is(x, y)).toBe(true);
      } else {
        expect(x).toEqual(y);
      }
    }
  }
}

const VALUE_SCHEMA = [
  { name: 'v', kind: 'number', required: false },
  { name: 'host', kind: 'string', required: false },
  { name: 'up', kind: 'boolean', required: false },
  { name: 'tags', kind: 'array', required: false },
] as const;

function randomCells(rnd: () => number) {
  const gap = () => rnd() < 0.2;
  return [
    gap() ? undefined : rnd() < 0.05 ? -0 : Math.round((rnd() - 0.5) * 1e4) / 8,
    gap() ? undefined : `h${Math.floor(rnd() * 5)}`,
    gap() ? undefined : rnd() < 0.5,
    gap() ? undefined : rnd() < 0.2 ? [] : ['a', Math.floor(rnd() * 3)],
  ] as const;
}

function timeSeries(rnd: () => number, n: number): AnySeries {
  const rows = [];
  let t = 0;
  for (let i = 0; i < n; i += 1) {
    // ~20% repeated timestamps.
    t += rnd() < 0.2 ? 0 : 1000;
    rows.push([t, ...randomCells(rnd)]);
  }
  return new TimeSeries({
    name: 'time-keyed',
    schema: [{ name: 'time', kind: 'time' }, ...VALUE_SCHEMA] as const,
    rows: rows as never,
  }) as unknown as AnySeries;
}

function timeRangeSeries(rnd: () => number, n: number): AnySeries {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const start = i * 1000;
    rows.push([
      new TimeRange({ start, end: start + 500 + Math.floor(rnd() * 3000) }),
      ...randomCells(rnd),
    ]);
  }
  return new TimeSeries({
    name: 'range-keyed',
    schema: [{ name: 'tr', kind: 'timeRange' }, ...VALUE_SCHEMA] as const,
    rows: rows as never,
  }) as unknown as AnySeries;
}

function intervalSeries(rnd: () => number, n: number): AnySeries {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const start = i * 1000;
    rows.push([
      { value: `w${i}`, start, end: start + 1000 },
      ...randomCells(rnd),
    ]);
  }
  return new TimeSeries({
    name: 'interval-keyed',
    schema: [{ name: 'window', kind: 'interval' }, ...VALUE_SCHEMA] as const,
    rows: rows as never,
  }) as unknown as AnySeries;
}

const PREDICATES: Record<string, (e: never, i: number) => unknown> = {
  all: () => true,
  none: () => false,
  'even index': (_e, i) => i % 2 === 0,
  'first only': (_e, i) => i === 0,
  'last only': (_e, i) => i === 1e9, // replaced per series below
  'v defined and > 0': (e) => {
    const v = (e as { get(n: string): unknown }).get('v');
    return typeof v === 'number' && v > 0;
  },
  'host is h1': (e) => (e as { get(n: string): unknown }).get('host') === 'h1',
  // Truthy / falsy non-booleans, as Array.prototype.filter accepts.
  'truthy non-boolean': (_e, i) => (i % 3 === 0 ? 'yes' : i % 3 === 1 ? 0 : 1),
};

describe('[PND-FILTERTAKE] filter equals the old rebuild-from-events path', () => {
  const builders: Record<string, (rnd: () => number, n: number) => AnySeries> =
    {
      'time keys': timeSeries,
      'timeRange keys': timeRangeSeries,
      'interval keys': intervalSeries,
    };
  for (const [kind, build] of Object.entries(builders)) {
    it(`${kind}: every predicate over 40 random series`, () => {
      const rnd = mulberry32(0xf11e);
      for (let s = 0; s < 40; s += 1) {
        const n = Math.floor(rnd() * 60); // includes empty
        const series = build(rnd, n);
        const preds = {
          ...PREDICATES,
          'last only': (_e: never, i: number) => i === n - 1,
          random: () => rnd() < 0.5,
        };
        for (const [, pred] of Object.entries(preds)) {
          // `random` must see the same draws on both sides.
          const draws: unknown[] = [];
          const recorded = (e: never, i: number) => {
            const r = pred(e, i);
            draws.push(r);
            return r;
          };
          const expected = referenceFilter(series, recorded);
          let k = 0;
          const replay = () => draws[k++];
          const actual = series.filter(replay as never) as AnySeries;
          expect(k).toBe(series.length);
          expectSameSeries(actual, expected);
        }
      }
    });
  }

  it('calls the predicate once per row, in order, with (event, index)', () => {
    const series = timeSeries(mulberry32(7), 25);
    const seen: Array<[unknown, number]> = [];
    series.filter(((e: unknown, i: number) => {
      seen.push([e, i]);
      return true;
    }) as never);
    expect(seen.length).toBe(25);
    seen.forEach(([e, i], j) => {
      expect(i).toBe(j);
      expect(e).toBe(series.events[j]);
    });
  });

  it('keeps event identity: filtered events are the source events', () => {
    const series = timeSeries(mulberry32(8), 30);
    const out = series.filter(
      ((_e: unknown, i: number) => i % 3 === 0) as never,
    );
    for (let j = 0; j < out.length; j += 1) {
      expect(out.at(j)).toBe(series.at(j * 3));
      expect(out.events[j]).toBe(series.events[j * 3]);
    }
    // events is frozen and stable across reads.
    expect(Object.isFrozen(out.events)).toBe(true);
    expect(out.events).toBe(out.events);
  });

  it('a predicate that throws propagates and builds nothing', () => {
    const series = timeSeries(mulberry32(9), 10);
    expect(() =>
      series.filter(((_e: unknown, i: number) => {
        if (i === 4) throw new Error('boom');
        return true;
      }) as never),
    ).toThrow('boom');
  });

  it('chained operators on the result read the copied columns correctly', () => {
    const series = timeSeries(mulberry32(10), 200);
    const pred = (e: never) => {
      const v = (e as { get(n: string): unknown }).get('v');
      return typeof v === 'number' && v > 0;
    };
    const a = series.filter(pred as never) as AnySeries;
    const b = referenceFilter(series, pred);
    expect(
      (a as unknown as TimeSeries<never>).column('v' as never),
    ).toBeDefined();
    expectSameSeries(
      (a as never as { diff(c: string): AnySeries }).diff('v'),
      (b as never as { diff(c: string): AnySeries }).diff('v'),
    );
    expectSameSeries(a.slice(3, 40) as AnySeries, b.slice(3, 40) as AnySeries);
  });
});

describe('[PND-FILTERTAKE] SeriesStore with a dense event array', () => {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number' },
  ] as const;
  const store = () =>
    ColumnarStore.fromTrustedStore(
      schema,
      timeKeyColumnFromArray([0, 1000, 2000]),
      new Map([['v', float64ColumnFromArray([1, 2, 3])]]),
    );
  const source = new TimeSeries({
    name: 's',
    schema,
    rows: [
      [0, 1],
      [1000, 2],
      [2000, 3],
    ],
  });

  it('eventAt returns the supplied events; toEvents reuses a frozen array', () => {
    const events = Object.freeze([...source.events]) as never;
    const ss = SeriesStore._fromStoreAndAlignedEventsModulePrivate(
      store(),
      events,
    );
    expect(ss.eventAt(1)).toBe(source.events[1]);
    expect(ss.toEvents()).toBe(events);
    expect([...ss]).toEqual([...source.events]);
  });

  it('a mutable array is copied before toEvents hands it out', () => {
    const events = [...source.events] as never[];
    const ss = SeriesStore._fromStoreAndAlignedEventsModulePrivate(
      store(),
      events as never,
    );
    const out = ss.toEvents();
    expect(out).not.toBe(events);
    expect(Object.isFrozen(out)).toBe(true);
    expect(out[2]).toBe(source.events[2]);
  });

  it('rejects an event array of the wrong length', () => {
    expect(() =>
      SeriesStore._fromStoreAndAlignedEventsModulePrivate(
        store(),
        source.events.slice(0, 2) as never,
      ),
    ).toThrow(RangeError);
  });

  it('eventAt still range-checks', () => {
    const ss = SeriesStore._fromStoreAndAlignedEventsModulePrivate(
      store(),
      Object.freeze([...source.events]) as never,
    );
    expect(() => ss.eventAt(3)).toThrow(RangeError);
    expect(() => ss.eventAt(-1)).toThrow(RangeError);
  });

  it('fromTrustedEvents snapshots a caller array: later writes do not leak in', () => {
    const arr = [...source.events];
    const ss = SeriesStore.fromTrustedEvents(schema, arr as never);
    const first = ss.eventAt(0);
    expect(first).toBe(source.events[0]);
    (arr as unknown[])[0] = source.events[2];
    expect(ss.eventAt(0)).toBe(first);
  });
});

describe('[PND-FILTERTAKE] storage of a filtered text column', () => {
  it('keeps a dictionary-encoded column dictionary-encoded, like slice', () => {
    const rows: Array<[number, string]> = [];
    for (let i = 0; i < 5000; i += 1)
      rows.push([i * 1000, ['A', 'B', 'C'][i % 3]!]);
    const s = new TimeSeries({
      name: 'x',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'sym', kind: 'string' },
      ] as const,
      rows,
    });
    const src = s.column('sym') as unknown as { dictionary?: unknown };
    expect(src.dictionary).toBeDefined(); // guard: source is dict-encoded
    const f = s.filter((e) => e.get('sym') !== 'A');
    const col = f.column('sym') as unknown as {
      dictionary?: ReadonlyArray<string>;
    };
    // Values are what the old path gave; the dictionary is shared with the
    // source (it still lists 'A'), exactly as after `slice`.
    expect(col.dictionary).toBe(src.dictionary);
    expect(
      (s.slice(0, 2).column('sym') as unknown as { dictionary?: unknown })
        .dictionary,
    ).toBe(src.dictionary);
    expect(f.toJSON()).toEqual(
      referenceFilter(
        s as never,
        ((e: { get(n: string): unknown }) => e.get('sym') !== 'A') as never,
      ).toJSON(),
    );
  });
});
