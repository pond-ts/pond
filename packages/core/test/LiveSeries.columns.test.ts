import { describe, expect, it } from 'vitest';
import { LiveSeries, TimeSeries } from '../src/index.js';

// [PND-COLOUT] `on('columns')` hands each push's added rows to the
// listener as a `TimeSeries`, without building an `Event` per row on the
// chunked backing.

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
] as const;

const rowsFrom = (start: number, n: number) =>
  Array.from({ length: n }, (_, j) => {
    const i = start + j;
    return [i * 1000, i % 5 === 0 ? undefined : i * 1.5, `h${i % 3}`] as const;
  });

const make = (options: Record<string, unknown> = {}) =>
  new LiveSeries({ name: 'cols', schema, ...options } as never) as LiveSeries<
    typeof schema
  >;

const asRows = (s: TimeSeries<any>) => s.toJSON().rows;
const expected = (rows: ReadonlyArray<unknown>) =>
  asRows(new TimeSeries({ name: 'x', schema, rows: rows as never }));

describe("LiveSeries on('columns') [PND-COLOUT]", () => {
  it('pushMany hands over exactly the added rows, once per push', () => {
    const live = make();
    const seen: TimeSeries<any>[] = [];
    live.on('columns', (b) => seen.push(b));
    expect(live._rowListenerCount).toBe(0);
    live.pushMany(rowsFrom(0, 20) as never);
    live.pushMany(rowsFrom(20, 5) as never);
    live.pushMany([]);
    expect(seen.length).toBe(2);
    expect(seen[0]).toBeInstanceOf(TimeSeries);
    expect(seen[0]!.name).toBe('cols');
    expect(seen[0]!.schema.map((c) => c.name)).toEqual(['time', 'cpu', 'host']);
    expect(asRows(seen[0]!)).toEqual(expected(rowsFrom(0, 20)));
    expect(asRows(seen[1]!)).toEqual(expected(rowsFrom(20, 5)));
    expect(seen[0]!.column('cpu')!.read(0)).toBeUndefined();
    expect(seen[0]!.keyColumn().beginAt(19)).toBe(19_000);
  });

  it('push, pushJson and pushSeries fire it too', () => {
    const live = make();
    const seen: TimeSeries<any>[] = [];
    live.on('columns', (b) => seen.push(b));
    live.push(rowsFrom(0, 1)[0] as never);
    live.pushJson(
      rowsFrom(1, 3).map((r) => [r[0], r[1] ?? null, r[2]]) as never,
    );
    const batch = new TimeSeries({
      name: 'b',
      schema,
      rows: rowsFrom(4, 30) as never,
    });
    live.pushSeries(batch);
    expect(seen.map((b) => b.length)).toEqual([1, 3, 30]);
    expect(asRows(seen[1]!)).toEqual(expected(rowsFrom(1, 3)));
    expect(asRows(seen[2]!)).toEqual(asRows(batch));
    // pushSeries keeps the batch's arrays, and so does the listener's view.
    expect(seen[2]!.column('cpu')).toBe(batch.column('cpu'));
  });

  it('fires after batch and before evict', () => {
    const live = make({ retention: { maxEvents: 10 } });
    const order: string[] = [];
    live.on('event', () => order.push('event'));
    live.on('batch', () => order.push('batch'));
    live.on('columns', () => order.push('columns'));
    live.on('evict', () => order.push('evict'));
    live.pushMany(rowsFrom(0, 12) as never);
    expect(order.filter((x) => x !== 'event')).toEqual([
      'batch',
      'columns',
      'evict',
    ]);
    expect(order.indexOf('batch')).toBe(12);
  });

  it('a batch already handed out never changes', () => {
    const live = make({ retention: { maxEvents: 10 } });
    let first: TimeSeries<any> | undefined;
    live.on('columns', (b) => (first ??= b));
    live.pushMany(rowsFrom(0, 8) as never);
    const before = asRows(first!);
    for (let k = 0; k < 10; k += 1)
      live.pushMany(rowsFrom(8 + k * 7, 7) as never);
    expect(live.length).toBe(10);
    expect(asRows(first!)).toEqual(before);
    expect(before).toEqual(expected(rowsFrom(0, 8)));
  });

  it('partition and time-range batches never change either', () => {
    const live = make({ retention: { maxEvents: 12 } });
    const parts = live.partitionBy('host', { groups: ['h0', 'h1', 'h2'] });
    const held: Array<[TimeSeries<any>, unknown]> = [];
    for (const p of parts.toMap().values()) {
      (p as LiveSeries<any>).on('columns', (b) => held.push([b, asRows(b)]));
    }
    const ranges = new LiveSeries({
      name: 'r',
      schema: [
        { name: 'span', kind: 'timeRange' },
        { name: 'v', kind: 'number' },
      ],
      retention: { maxEvents: 3 },
    } as never) as LiveSeries<any>;
    ranges.on('columns', (b) => held.push([b, asRows(b)]));
    for (let k = 0; k < 8; k += 1) {
      live.pushMany(rowsFrom(k * 9, 9) as never);
      ranges.pushMany([
        [[k * 10, k * 10 + 5], k],
        [[k * 10 + 1, k * 10 + 9], -k],
      ] as never);
    }
    expect(held.length).toBe(8 * 3 + 8);
    for (const [batch, rowsThen] of held)
      expect(asRows(batch)).toEqual(rowsThen);
  });

  it('reorder: the batch holds the accepted rows sorted by key, sharing their events', () => {
    const live = make({ ordering: 'reorder' });
    const seen: TimeSeries<any>[] = [];
    live.on('columns', (b) => seen.push(b));
    live.pushMany(rowsFrom(10, 3) as never);
    live.pushMany([rowsFrom(20, 1)[0], rowsFrom(5, 1)[0]] as never);
    expect(asRows(seen[1]!)).toEqual(
      expected([rowsFrom(5, 1)[0], rowsFrom(20, 1)[0]]),
    );
    const stored = live.toTimeSeries();
    expect(stored.length).toBe(5);
    expect(seen[1]!.at(0)).toBe(live.at(0));
    expect(seen[1]!.at(1)).toBe(live.at(4));
  });

  it('drop: dropped rows are left out, and a push that adds nothing fires nothing', () => {
    const live = make({ ordering: 'drop' });
    const seen: TimeSeries<any>[] = [];
    live.on('columns', (b) => seen.push(b));
    live.pushMany(rowsFrom(10, 3) as never);
    live.pushMany([rowsFrom(1, 1)[0], rowsFrom(20, 1)[0]] as never);
    live.pushMany([rowsFrom(2, 1)[0]] as never);
    expect(seen.length).toBe(2);
    expect(asRows(seen[1]!)).toEqual(expected(rowsFrom(20, 1)));
  });

  for (const ordering of ['strict', 'reorder'] as const) {
    it(`partition sub-series (${ordering} source) hand over their own rows`, () => {
      const live = make({ ordering });
      const parts = live.partitionBy('host', { groups: ['h0', 'h1', 'h2'] });
      const got = new Map<string, unknown[]>();
      for (const [k, p] of parts.toMap()) {
        got.set(k, []);
        (p as LiveSeries<any>).on('columns', (b) =>
          got.get(k)!.push(...asRows(b)),
        );
      }
      for (let k = 0; k < 4; k += 1)
        live.pushMany(rowsFrom(k * 50, 50) as never);
      for (const [k, p] of parts.toMap()) {
        expect(got.get(k)).toEqual(
          asRows((p as LiveSeries<any>).toTimeSeries()),
        );
        expect(got.get(k)!.length).toBeGreaterThan(60);
      }
    });
  }

  it('a throwing listener throws after the push completes; others still run', () => {
    const live = make();
    let other = 0;
    live.on('columns', () => {
      throw new Error('boom');
    });
    live.on('columns', (b) => (other += b.length));
    expect(() => live.pushMany(rowsFrom(0, 4) as never)).toThrow('boom');
    expect(live.length).toBe(4);
    expect(other).toBe(4);
  });

  it('unsubscribe stops it; a push from inside the listener runs after', () => {
    const live = make();
    const lengths: number[] = [];
    const off = live.on('columns', (b) => {
      lengths.push(b.length);
      if (lengths.length === 1) live.pushMany(rowsFrom(10, 2) as never);
    });
    live.pushMany(rowsFrom(0, 3) as never);
    expect(lengths).toEqual([3, 2]);
    off();
    live.pushMany(rowsFrom(20, 3) as never);
    expect(lengths).toEqual([3, 2]);
    expect(live.length).toBe(8);
  });
});
