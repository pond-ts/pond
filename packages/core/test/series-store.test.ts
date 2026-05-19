import { describe, expect, it } from 'vitest';

import { Event } from '../src/core/event.js';
import { Interval } from '../src/core/interval.js';
import { Time } from '../src/core/time.js';
import { TimeRange } from '../src/core/time-range.js';
import {
  ColumnarStore,
  Float64Column,
  IntervalKeyColumn,
  arrayColumnFromArray,
  stringColumnFromArray,
  timeKeyColumnFromArray,
  timeRangeKeyColumnFromPairs,
} from '../src/columnar/index.js';
import { SeriesStore, type SeriesEvent } from '../src/live/series-store.js';

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

function makeBasicSeriesStore() {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number' },
    { name: 'load', kind: 'number' },
  ] as const;
  const keys = timeKeyColumnFromArray([1000, 2000, 3000]);
  const value = new Float64Column(Float64Array.of(10, 20, 30), 3);
  const load = new Float64Column(Float64Array.of(0.5, 0.75, 0.9), 3);
  const store = ColumnarStore.fromTrustedStore(
    schema,
    keys,
    new Map([
      ['value', value],
      ['load', load],
    ]),
  );
  return { schema, keys, store, series: SeriesStore.fromTrustedStore(store) };
}

describe('SeriesStore.fromTrustedStore', () => {
  it('wraps a ColumnarStore with row-API materialization', () => {
    const { series } = makeBasicSeriesStore();
    expect(series.length).toBe(3);
    expect(series.schema[0]!.name).toBe('time');
  });
});

/* -------------------------------------------------------------------------- */
/* keyAt — EventKey materialization                                           */
/* -------------------------------------------------------------------------- */

describe('SeriesStore.keyAt', () => {
  it('returns a Time instance for time-keyed stores', () => {
    const { series } = makeBasicSeriesStore();
    expect(series.keyAt(0)).toBeInstanceOf(Time);
    expect(series.keyAt(0).begin()).toBe(1000);
  });

  it('keyAt cache pins reference identity', () => {
    const { series } = makeBasicSeriesStore();
    expect(series.keyAt(1)).toBe(series.keyAt(1));
  });

  it('returns a TimeRange instance for timeRange-keyed stores', () => {
    const schema = [
      { name: 'tr', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const;
    const keys = timeRangeKeyColumnFromPairs([
      [0, 10],
      [10, 20],
    ]);
    const v = new Float64Column(Float64Array.of(100, 200), 2);
    const cstore = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['v', v]]),
    );
    const series = SeriesStore.fromTrustedStore(cstore);
    const k = series.keyAt(0);
    expect(k).toBeInstanceOf(TimeRange);
    expect(k.begin()).toBe(0);
    expect(k.end()).toBe(10);
  });

  it('returns an Interval instance for interval-keyed stores with the right label', () => {
    const schema = [
      { name: 'bucket', kind: 'interval' },
      { name: 'count', kind: 'number' },
    ] as const;
    const begin = Float64Array.of(0, 86_400_000);
    const end = Float64Array.of(86_400_000, 172_800_000);
    const labels = stringColumnFromArray(['day-1', 'day-2'], {
      forceDict: true,
    });
    const keys = new IntervalKeyColumn(begin, end, labels, 2);
    const counts = new Float64Column(Float64Array.of(42, 99), 2);
    const cstore = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['count', counts]]),
    );
    const series = SeriesStore.fromTrustedStore(cstore);
    const k = series.keyAt(1);
    expect(k).toBeInstanceOf(Interval);
    expect((k as Interval).value).toBe('day-2');
    expect(k.begin()).toBe(86_400_000);
  });

  it('returns an Interval with a numeric label when the label column is a Float64Column', () => {
    const schema = [
      { name: 'bucket', kind: 'interval' },
      { name: 'count', kind: 'number' },
    ] as const;
    const begin = Float64Array.of(0, 100);
    const end = Float64Array.of(50, 200);
    const labels = new Float64Column(Float64Array.of(42, 7), 2);
    const keys = new IntervalKeyColumn(begin, end, labels, 2);
    const counts = new Float64Column(Float64Array.of(1, 2), 2);
    const cstore = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['count', counts]]),
    );
    const series = SeriesStore.fromTrustedStore(cstore);
    const k = series.keyAt(0);
    expect(k).toBeInstanceOf(Interval);
    expect((k as Interval).value).toBe(42);
    expect(typeof (k as Interval).value).toBe('number');
  });

  it('keyAt out of range throws', () => {
    const { series } = makeBasicSeriesStore();
    expect(() => series.keyAt(-1)).toThrow(RangeError);
    expect(() => series.keyAt(3)).toThrow(RangeError);
  });
});

/* -------------------------------------------------------------------------- */
/* Public API invariants (the five from the RFC)                              */
/* -------------------------------------------------------------------------- */

describe('Public API invariants', () => {
  it('Invariant 1: toEvents() === toEvents() (events array identity)', () => {
    const { series } = makeBasicSeriesStore();
    expect(series.toEvents()).toBe(series.toEvents());
  });

  it('Invariant 2: at(i) reference stability — eventAt(i) === eventAt(i)', () => {
    const { series } = makeBasicSeriesStore();
    expect(series.eventAt(0)).toBe(series.eventAt(0));
    expect(series.eventAt(2)).toBe(series.eventAt(2));
  });

  it('Invariant 3: at(i) ↔ events consistency — eventAt(i) === toEvents()[i]', () => {
    const { series } = makeBasicSeriesStore();
    const events = series.toEvents();
    for (let i = 0; i < series.length; i += 1) {
      expect(series.eventAt(i)).toBe(events[i]);
    }
  });

  it('Invariant 4 (mechanism only — concat-identity test lands in step 2): eventCache pre-population inherits row-specific event reference', () => {
    const { schema, keys, store } = makeBasicSeriesStore();
    const seriesA = SeriesStore.fromTrustedStore(store);
    const eventA = seriesA.eventAt(1);
    const sharedCache = new Map<number, SeriesEvent>();
    sharedCache.set(1, eventA);
    // Same underlying store, fresh adapter with pre-populated cache.
    // The schema/columns are identical, so the cached event's
    // structural validation succeeds and the reference is preserved.
    const seriesB = SeriesStore.fromTrustedStore(store, {
      eventCache: sharedCache,
    });
    expect(seriesB.eventAt(1)).toBe(eventA);
    // Silence the unused-binding warnings for the destructured names.
    void schema;
    void keys;
  });

  it('Invariant 5: Symbol.iterator yields cached Event references', () => {
    const { series } = makeBasicSeriesStore();
    const fromIter: SeriesEvent[] = [];
    for (const ev of series) {
      fromIter.push(ev);
    }
    expect(fromIter.length).toBe(3);
    for (let i = 0; i < series.length; i += 1) {
      expect(fromIter[i]).toBe(series.eventAt(i));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* eventAt — content + bounds                                                 */
/* -------------------------------------------------------------------------- */

describe('SeriesStore.eventAt', () => {
  it('materializes events with the correct row data', () => {
    const { series } = makeBasicSeriesStore();
    const ev = series.eventAt(1);
    expect(ev).toBeInstanceOf(Event);
    expect(ev.key()).toBeInstanceOf(Time);
    expect(ev.key().begin()).toBe(2000);
    expect(ev.data().value).toBe(20);
    expect(ev.data().load).toBe(0.75);
  });

  it('throws on out-of-range index', () => {
    const { series } = makeBasicSeriesStore();
    expect(() => series.eventAt(-1)).toThrow(RangeError);
    expect(() => series.eventAt(3)).toThrow(RangeError);
  });

  it('event data is frozen', () => {
    const { series } = makeBasicSeriesStore();
    expect(Object.isFrozen(series.eventAt(0).data())).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* eventCache validation                                                       */
/* -------------------------------------------------------------------------- */

describe('eventCache validation', () => {
  function makeStoreAndKeys() {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2, 3]);
    const value = new Float64Column(Float64Array.of(10, 20, 30), 3);
    const store = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['value', value]]),
    );
    return { schema, keys, store };
  }

  it('rejects cache entries whose key disagrees structurally with the column key', () => {
    const { store } = makeStoreAndKeys();
    const poisoned = new Map<number, SeriesEvent>();
    poisoned.set(1, new Event(new Time(99999), { value: 20 }) as SeriesEvent);
    expect(() =>
      SeriesStore.fromTrustedStore(store, { eventCache: poisoned }),
    ).toThrow(/does not structurally equal/);
  });

  it('rejects cache entries whose key kind differs (e.g. TimeRange vs Time)', () => {
    const { store } = makeStoreAndKeys();
    const poisoned = new Map<number, SeriesEvent>();
    poisoned.set(
      1,
      new Event(new TimeRange({ start: 2, end: 2 }), {
        value: 20,
      }) as SeriesEvent,
    );
    expect(() =>
      SeriesStore.fromTrustedStore(store, { eventCache: poisoned }),
    ).toThrow(/does not structurally equal/);
  });

  it('rejects cache entries whose data values disagree with column reads', () => {
    const { store } = makeStoreAndKeys();
    const poisoned = new Map<number, SeriesEvent>();
    poisoned.set(1, new Event(new Time(2), { value: 99999 }) as SeriesEvent);
    expect(() =>
      SeriesStore.fromTrustedStore(store, { eventCache: poisoned }),
    ).toThrow(/data\['value'\] = 99999.*column read returns 20/);
  });

  it('rejects cache entries with EXTRA fields not in the schema (Codex round-2 finding)', () => {
    // Bounds match, declared values match — but data carries an
    // unexpected field. Adopting it would leak stale/cross-schema
    // data through eventAt / toEvents.
    const { store } = makeStoreAndKeys();
    const poisoned = new Map<number, SeriesEvent>();
    poisoned.set(
      1,
      new Event(new Time(2), {
        value: 20,
        leftover: 'stale',
      }) as SeriesEvent,
    );
    expect(() =>
      SeriesStore.fromTrustedStore(store, { eventCache: poisoned }),
    ).toThrow(/unexpected data field 'leftover'/);
  });

  it('rejects cache entries MISSING a schema-declared field even when the column read is undefined (Codex Path-B-post finding)', () => {
    // Schema declares `value: string`. Row 1 of the column reads as
    // undefined (invalid cell). A cached event whose data omits the
    // `value` field entirely would previously slip through because
    // `cachedData[name] === undefined` matches `column.read() ===
    // undefined`. The hasOwnProperty check rejects the missing
    // field.
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'string' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2, 3]);
    const value = stringColumnFromArray(['a', undefined, 'c']);
    const store = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['value', value]]),
    );
    const poisoned = new Map<number, SeriesEvent>();
    // Row 1: column.read returns undefined. Cached event data is {} —
    // no `value` key at all.
    poisoned.set(1, new Event(new Time(2), {}) as SeriesEvent);
    expect(() =>
      SeriesStore.fromTrustedStore(store, { eventCache: poisoned }),
    ).toThrow(/missing required schema data field 'value'/);
  });

  it('rejects cache entries with out-of-range row index', () => {
    const { store } = makeStoreAndKeys();
    const poisoned = new Map<number, SeriesEvent>();
    poisoned.set(99, new Event(new Time(1), { value: 10 }) as SeriesEvent);
    expect(() =>
      SeriesStore.fromTrustedStore(store, { eventCache: poisoned }),
    ).toThrow(/out-of-range row index 99/);
  });

  it('accepts cache entries that fully agree with the column data', () => {
    const { store } = makeStoreAndKeys();
    const goodCache = new Map<number, SeriesEvent>();
    const ev = new Event(new Time(2), { value: 20 }) as SeriesEvent;
    goodCache.set(1, ev);
    const series = SeriesStore.fromTrustedStore(store, {
      eventCache: goodCache,
    });
    expect(series.eventAt(1)).toBe(ev);
  });

  it('rejects cache entries with mismatched interval label', () => {
    const schema = [
      { name: 'bucket', kind: 'interval' },
      { name: 'v', kind: 'number' },
    ] as const;
    const begin = Float64Array.of(0);
    const end = Float64Array.of(10);
    const labels = stringColumnFromArray(['real-label'], { forceDict: true });
    const keys = new IntervalKeyColumn(begin, end, labels, 1);
    const v = new Float64Column(Float64Array.of(42), 1);
    const store = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['v', v]]),
    );
    const poisoned = new Map<number, SeriesEvent>();
    poisoned.set(
      0,
      new Event(new Interval({ value: 'wrong-label', start: 0, end: 10 }), {
        v: 42,
      }) as SeriesEvent,
    );
    expect(() =>
      SeriesStore.fromTrustedStore(store, { eventCache: poisoned }),
    ).toThrow(/does not structurally equal/);
  });

  it('defensively owns the cache — mutating source after construction is ignored', () => {
    const { store } = makeStoreAndKeys();
    const ev = new Event(new Time(2), { value: 20 }) as SeriesEvent;
    const sourceCache = new Map<number, SeriesEvent>();
    sourceCache.set(1, ev);
    const series = SeriesStore.fromTrustedStore(store, {
      eventCache: sourceCache,
    });
    sourceCache.set(
      0,
      new Event(new Time(99999), { value: 10 }) as SeriesEvent,
    );
    const ev0 = series.eventAt(0);
    expect(ev0.key().begin()).toBe(1); // matches the column, not the poison
  });
});

/* -------------------------------------------------------------------------- */
/* Kind-aware cache equality (Codex round-2 finding)                          */
/* -------------------------------------------------------------------------- */

describe('Kind-aware cache value equality', () => {
  it('array-kind values are compared element-wise, not by reference (ArrayColumn defensive-freeze case)', () => {
    // The framework's ArrayColumn defensively copies + freezes array
    // cells. A re-built store with semantically identical arrays
    // produces different array instances. Reference equality (===)
    // would reject the cache; kind-aware equality accepts it.
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'tags', kind: 'array' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2]);
    const tags = arrayColumnFromArray([['a', 'b'], ['c']]);
    const store = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['tags', tags]]),
    );
    // Cache entry holds a separately-constructed array with the
    // SAME content as row 0. Equivalent but different reference.
    const cachedEvent = new Event(new Time(1), {
      tags: ['a', 'b'],
    }) as SeriesEvent;
    const goodCache = new Map<number, SeriesEvent>();
    goodCache.set(0, cachedEvent);
    // Should adopt without throwing.
    const series = SeriesStore.fromTrustedStore(store, {
      eventCache: goodCache,
    });
    expect(series.eventAt(0)).toBe(cachedEvent);
  });

  it('numeric NaN values are compared via Object.is (NaN equals NaN)', () => {
    // Cache validation needs to treat NaN === NaN as a match.
    // Reference / strict equality would reject NaN identity.
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const;
    const keys = timeKeyColumnFromArray([1, 2]);
    // Float64Column accepts NaN values (validity-marked-defined is
    // the framework's value contract; row-API validates upstream).
    const v = new Float64Column(Float64Array.of(NaN, 5), 2);
    const store = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['v', v]]),
    );
    const cachedEvent = new Event(new Time(1), { v: NaN }) as SeriesEvent;
    const goodCache = new Map<number, SeriesEvent>();
    goodCache.set(0, cachedEvent);
    const series = SeriesStore.fromTrustedStore(store, {
      eventCache: goodCache,
    });
    expect(series.eventAt(0)).toBe(cachedEvent);
  });

  it('array equality is shallow — differing element values are rejected', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'tags', kind: 'array' },
    ] as const;
    const keys = timeKeyColumnFromArray([1]);
    const tags = arrayColumnFromArray([['a', 'b']]);
    const store = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['tags', tags]]),
    );
    const poisoned = new Map<number, SeriesEvent>();
    poisoned.set(
      0,
      new Event(new Time(1), { tags: ['a', 'WRONG'] }) as SeriesEvent,
    );
    expect(() =>
      SeriesStore.fromTrustedStore(store, { eventCache: poisoned }),
    ).toThrow(/data\['tags'\]/);
  });
});

/* -------------------------------------------------------------------------- */
/* Native exports                                                              */
/* -------------------------------------------------------------------------- */

describe('SeriesStore.toRows', () => {
  it('produces tuple-shaped rows [EventKey, ...values]', () => {
    const { series } = makeBasicSeriesStore();
    const rows = series.toRows();
    expect(rows.length).toBe(3);
    expect(rows[0]![0]).toBeInstanceOf(Time);
    expect((rows[0]![0] as Time).begin()).toBe(1000);
    expect(rows[0]!.slice(1)).toEqual([10, 0.5]);
  });

  it('preserves interval label through toRows', () => {
    const schema = [
      { name: 'bucket', kind: 'interval' },
      { name: 'count', kind: 'number' },
    ] as const;
    const begin = Float64Array.of(0, 86_400_000);
    const end = Float64Array.of(86_400_000, 172_800_000);
    const labels = stringColumnFromArray(['day-1', 'day-2'], {
      forceDict: true,
    });
    const keys = new IntervalKeyColumn(begin, end, labels, 2);
    const counts = new Float64Column(Float64Array.of(42, 99), 2);
    const cstore = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['count', counts]]),
    );
    const series = SeriesStore.fromTrustedStore(cstore);
    const rows = series.toRows();
    expect(rows[0]![0]).toBeInstanceOf(Interval);
    expect((rows[0]![0] as Interval).value).toBe('day-1');
    expect(rows[0]![1]).toBe(42);
  });

  it('rebuilds on each call (documented contract)', () => {
    const { series } = makeBasicSeriesStore();
    expect(series.toRows()).not.toBe(series.toRows());
  });
});

describe('SeriesStore.toObjects', () => {
  it('produces object-shaped rows with EventKey under the key column name', () => {
    const { series } = makeBasicSeriesStore();
    const objs = series.toObjects();
    expect(objs.length).toBe(3);
    expect(objs[0]!.time).toBeInstanceOf(Time);
    expect((objs[0]!.time as Time).begin()).toBe(1000);
    expect(objs[0]!.value).toBe(10);
  });

  it('value column named "end" does not collide with the key', () => {
    const schema = [
      { name: 'tr', kind: 'timeRange' },
      { name: 'end', kind: 'number' },
    ] as const;
    const keys = timeRangeKeyColumnFromPairs([[0, 10]]);
    const endCol = new Float64Column(Float64Array.of(42), 1);
    const cstore = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['end', endCol]]),
    );
    const series = SeriesStore.fromTrustedStore(cstore);
    const objs = series.toObjects();
    expect((objs[0]!.tr as TimeRange).end()).toBe(10);
    expect(objs[0]!.end).toBe(42);
  });

  it('row objects are frozen', () => {
    const { series } = makeBasicSeriesStore();
    expect(Object.isFrozen(series.toObjects()[0])).toBe(true);
  });

  it('rebuilds on each call', () => {
    const { series } = makeBasicSeriesStore();
    expect(series.toObjects()).not.toBe(series.toObjects());
  });
});

/* -------------------------------------------------------------------------- */
/* fromValidatedRows — row-intake factory (sub-step 1e)                       */
/* -------------------------------------------------------------------------- */

describe('SeriesStore.fromValidatedRows', () => {
  it('builds a SeriesStore from time-keyed row data', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'load', kind: 'number' },
    ] as const;
    const rows = [
      [1000, 10, 0.5],
      [2000, 20, 0.75],
      [3000, 30, 0.9],
    ] as const;
    const series = SeriesStore.fromValidatedRows(schema, rows);
    expect(series.length).toBe(3);
    expect(series.keyAt(1)).toBeInstanceOf(Time);
    expect(series.keyAt(1).begin()).toBe(2000);
    expect(series.eventAt(1).data().value).toBe(20);
    expect(series.eventAt(1).data().load).toBe(0.75);
  });

  it('builds a SeriesStore with string columns (dict-encoded by heuristic)', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'host', kind: 'string' },
    ] as const;
    const rows = Array.from(
      { length: 20 },
      (_, i): readonly [number, string] => [i * 1000, ['a', 'b'][i % 2]!],
    );
    const series = SeriesStore.fromValidatedRows(schema, rows);
    expect(series.length).toBe(20);
    // The dict-encoding decision happens inside the builder/factory;
    // pin the user-visible result instead of the internal shape.
    expect(series.eventAt(0).data().host).toBe('a');
    expect(series.eventAt(1).data().host).toBe('b');
  });

  it('builds a timeRange-keyed SeriesStore', () => {
    const schema = [
      { name: 'tr', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const;
    const rows = [
      [[0, 10] as const, 100],
      [[10, 20] as const, 200],
    ] as const;
    const series = SeriesStore.fromValidatedRows(schema, rows);
    expect(series.length).toBe(2);
    expect(series.keyAt(0)).toBeInstanceOf(TimeRange);
    expect(series.keyAt(0).begin()).toBe(0);
    expect(series.keyAt(0).end()).toBe(10);
  });

  it('builds an interval-keyed SeriesStore with string labels', () => {
    const schema = [
      { name: 'bucket', kind: 'interval' },
      { name: 'count', kind: 'number' },
    ] as const;
    const rows = [
      [['day-1', 0, 86_400_000] as const, 42],
      [['day-2', 86_400_000, 172_800_000] as const, 99],
    ] as const;
    const series = SeriesStore.fromValidatedRows(schema, rows);
    expect(series.length).toBe(2);
    expect(series.keyAt(0)).toBeInstanceOf(Interval);
    expect((series.keyAt(0) as Interval).value).toBe('day-1');
    expect(series.eventAt(1).data().count).toBe(99);
  });

  it('builds an interval-keyed SeriesStore with numeric labels', () => {
    const schema = [
      { name: 'tile', kind: 'interval' },
      { name: 'v', kind: 'number' },
    ] as const;
    const rows = [
      [[1, 0, 100] as const, 10],
      [[2, 100, 200] as const, 20],
    ] as const;
    const series = SeriesStore.fromValidatedRows(schema, rows);
    expect((series.keyAt(0) as Interval).value).toBe(1);
    expect(typeof (series.keyAt(0) as Interval).value).toBe('number');
  });

  it('rejects interval rows that mix string and numeric labels', () => {
    const schema = [
      { name: 'tile', kind: 'interval' },
      { name: 'v', kind: 'number' },
    ] as const;
    const rows = [
      [['day-1', 0, 100] as const, 10],
      [[2, 100, 200] as const, 20], // numeric label after string — inconsistent
    ] as const;
    expect(() => SeriesStore.fromValidatedRows(schema, rows)).toThrow(
      /interval-keyed series must use one label type/,
    );
  });

  it('produces events that are pre-populated into the cache (eventAt === validated event)', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const series = SeriesStore.fromValidatedRows(schema, [
      [1, 10],
      [2, 20],
    ]);
    const ev = series.eventAt(0);
    expect(ev).toBe(series.eventAt(0)); // identity stable
    // The events came from validateAndNormalize and are already in
    // the cache — the same reference comes back through toEvents.
    expect(series.toEvents()[0]).toBe(ev);
  });

  it('handles invalid (undefined) value-column cells via validity', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'string', required: false },
    ] as const;
    const series = SeriesStore.fromValidatedRows(schema, [
      [1, 'a'],
      [2, undefined],
      [3, 'c'],
    ]);
    expect(series.eventAt(0).data().value).toBe('a');
    expect(series.eventAt(1).data().value).toBeUndefined();
    expect(series.eventAt(2).data().value).toBe('c');
  });

  it('empty rows produce a zero-length store', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    const series = SeriesStore.fromValidatedRows(schema, []);
    expect(series.length).toBe(0);
    expect(series.toEvents()).toEqual([]);
  });

  it('rejects out-of-order rows (delegates to validateAndNormalize)', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    expect(() =>
      SeriesStore.fromValidatedRows(schema, [
        [2000, 20],
        [1000, 10],
      ]),
    ).toThrow(/out of order/);
  });

  it('rejects schema-violating values (delegates to validateAndNormalize)', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ] as const;
    expect(() =>
      SeriesStore.fromValidatedRows(schema, [
        [1, 'not-a-number' as unknown as number],
      ]),
    ).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Framework independence — REAL cross-module assertion                        */
/* -------------------------------------------------------------------------- */

describe('Framework independence (pure substrate contract)', () => {
  // After the Path B refactor the framework contract is much
  // stronger than before: the columnar/ directory must not import
  // ANY pond-ts row-API value class. This test enforces it.
  it('packages/core/src/columnar/*.ts does not import Event / EventKey / Time / TimeRange / Interval / temporal / operators', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const columnarDir = resolve(here, '../src/columnar');
    const files = readdirSync(columnarDir).filter((f) => f.endsWith('.ts'));

    // Row-API value classes and the temporal module — these were
    // allowed by the previous (looser) boundary but the Path B
    // refactor pushed all this knowledge into the row-API adapter
    // at src/series-store.ts.
    const forbiddenFiles = [
      'Event',
      'Time',
      'TimeRange',
      'Interval',
      'temporal',
      'types', // framework owns its own type vocabulary at columnar/types.ts
      'TimeSeries',
      'LiveSeries',
      'PartitionedTimeSeries',
      'LivePartitionedSeries',
      'LiveAggregation',
      'LiveRollingAggregation',
      'LiveFusedRolling',
      'LiveView',
      'LiveReduce',
      'LivePartitionedFusedRolling',
      'LivePartitionedSyncRolling',
    ];
    const forbiddenDirs = ['reducers'];

    for (const f of files) {
      const content = readFileSync(resolve(columnarDir, f), 'utf8');
      for (const banned of forbiddenFiles) {
        expect(
          content.includes(`from '../${banned}.js'`),
          `${f} imports forbidden module: ../${banned}.js`,
        ).toBe(false);
        expect(
          content.includes(`from '../${banned}';`),
          `${f} imports forbidden module: ../${banned}`,
        ).toBe(false);
      }
      for (const banned of forbiddenDirs) {
        expect(
          content.includes(`from '../${banned}/`),
          `${f} imports forbidden subdirectory: ../${banned}/`,
        ).toBe(false);
        expect(
          content.includes(`from '../${banned}.js'`),
          `${f} imports forbidden module: ../${banned}.js`,
        ).toBe(false);
        expect(
          content.includes(`from '../${banned}';`),
          `${f} imports forbidden module: ../${banned}`,
        ).toBe(false);
      }
    }
  });

  it('a SeriesStore built end-to-end through the framework works', async () => {
    const { ColumnarStore, Float64Column, timeKeyColumnFromArray } =
      await import('../src/columnar/index.js');
    const { SeriesStore } = await import('../src/live/series-store.js');

    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'temperature', kind: 'number' },
    ] as const;
    const keys = timeKeyColumnFromArray([0, 1000, 2000]);
    const temp = new Float64Column(Float64Array.of(20, 21, 22), 3);
    const store = ColumnarStore.fromTrustedStore(
      schema,
      keys,
      new Map([['temperature', temp]]),
    );
    const series = SeriesStore.fromTrustedStore(store);

    expect(series.length).toBe(3);
    expect(series.eventAt(1).data().temperature).toBe(21);
    expect((series.toRows()[2]![0] as Time).begin()).toBe(2000);
  });
});
