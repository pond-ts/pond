import { describe, expect, it } from 'vitest';

import { LiveSeries } from '../../src/index.js';

/* -------------------------------------------------------------------------- */
/* §A prong-2 spike — LiveView column reads (column / keyColumn /              */
/* partitionBy().toMap()). Walk-now gather off the view's event buffer.        */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function make() {
  const live = new LiveSeries({ name: 's', schema, ordering: 'strict' });
  live.pushMany([
    [1000, 10, 'a'],
    [1001, 20, 'b'],
    [1002, 30, 'a'],
    [1003, 40, 'b'],
    [1004, 50, 'a'],
    [1005, 60, 'b'],
  ]);
  return live;
}

describe('LiveView.column / keyColumn', () => {
  it('column() gathers a numeric column from the view', () => {
    const cpu = make().window(10).column('cpu');
    expect(Array.from(cpu.toFloat64Array())).toEqual([10, 20, 30, 40, 50, 60]);
    expect(cpu.mean()).toBeCloseTo(35);
  });

  it('keyColumn() gathers begins as a Float64Array', () => {
    const begin = make().window(10).keyColumn().begin;
    expect(Array.from(begin)).toEqual([1000, 1001, 1002, 1003, 1004, 1005]);
  });

  it('reflects the window slice (eviction)', () => {
    const cpu = make().window(2).column('cpu'); // last 2 events
    expect(Array.from(cpu.toFloat64Array())).toEqual([50, 60]);
  });

  it('column() carries validity for undefined cells', () => {
    const optSchema = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number', required: false },
    ] as const;
    const live = new LiveSeries({ name: 's', schema: optSchema });
    live.pushMany([
      [1000, 10],
      [1001, undefined],
      [1002, 30],
    ]);
    const cpu = live.window(10).column('cpu');
    expect(cpu.at(0)).toBe(10);
    expect(cpu.at(1)).toBeUndefined();
    expect(cpu.at(2)).toBe(30);
    expect(cpu.mean()).toBeCloseTo(20); // skips the undefined
  });

  it('rejects a non-numeric column read at runtime (compile error via the types)', () => {
    // column() is typed numeric-only; this is a compile error in typed code.
    // The runtime backstop throws a clear message (test files aren't type-checked).
    expect(() => make().window(10).column('host')).toThrow(
      /numeric value columns/,
    );
  });
});

describe('LiveView.partitionBy().toMap() — walk-now', () => {
  it('groups by the partition column and gathers per-partition', () => {
    const m = make()
      .window(10)
      .partitionBy('host')
      .toMap((g) => ({
        n: g.length,
        ts: Array.from(g.keyColumn().begin),
        cpu: Array.from(g.column('cpu').toFloat64Array()),
      }));
    expect(m.get('a')).toEqual({
      n: 3,
      ts: [1000, 1002, 1004],
      cpu: [10, 30, 50],
    });
    expect(m.get('b')).toEqual({
      n: 3,
      ts: [1001, 1003, 1005],
      cpu: [20, 40, 60],
    });
  });

  it('matches TimeSeries.partitionBy().toMap() (parity with the snapshot path)', () => {
    const view = make().window(10);
    const walkNow = view
      .partitionBy('host')
      .toMap((g) => Array.from(g.column('cpu').toFloat64Array()));
    const snapshot = view
      .toTimeSeries()
      .partitionBy('host')
      .toMap((g) => Array.from(g.column('cpu').toFloat64Array()));
    expect(walkNow.size).toBe(snapshot.size);
    for (const [key, arr] of snapshot) {
      expect(walkNow.get(key)).toEqual(arr);
    }
  });

  it('empty view yields an empty map', () => {
    const live = new LiveSeries({ name: 's', schema, ordering: 'strict' });
    const m = live
      .window(10)
      .partitionBy('host')
      .toMap((g) => g.length);
    expect(m.size).toBe(0);
  });

  it('keeps a missing partition value distinct from the literal "undefined" (TimeSeries parity)', () => {
    // Regression for the partition-key sentinel: String(undefined) ===
    // 'undefined' would silently merge a missing host with a host literally
    // named 'undefined'. TimeSeries uses the ' undefined' sentinel; LiveView
    // must match.
    const optSchema = [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
      { name: 'host', kind: 'string', required: false },
    ] as const;
    const live = new LiveSeries({
      name: 's',
      schema: optSchema,
      ordering: 'strict',
    });
    live.pushMany([
      [1000, 1, 'a'],
      [1001, 2, undefined], // missing → ' undefined' sentinel
      [1002, 3, 'undefined'], // literal string 'undefined'
      [1003, 4, 'a'],
    ]);
    const view = live.window(10);
    const walkNow = view.partitionBy('host').toMap((g) => g.length);
    const snapshot = view
      .toTimeSeries()
      .partitionBy('host')
      .toMap((g) => g.length);

    // Three distinct buckets: 'a', the missing sentinel, the literal.
    expect(walkNow.size).toBe(3);
    expect([...walkNow.keys()].sort()).toEqual([...snapshot.keys()].sort());
    for (const [key, n] of snapshot) {
      expect(walkNow.get(key)).toBe(n);
    }
  });

  it('groups stay stable after later eviction (snapshot-style slice)', () => {
    const live = new LiveSeries({ name: 's', schema, ordering: 'strict' });
    live.pushMany([
      [1000, 10, 'a'],
      [1001, 20, 'a'],
    ]);
    const view = live.window(2); // count window keeps the last 2
    // Return the group itself (a lazy reader), then mutate the view.
    const g = view
      .partitionBy('host')
      .toMap((grp) => grp)
      .get('a')!;
    expect(Array.from(g.column('cpu').toFloat64Array())).toEqual([10, 20]);

    // Pushing two more evicts the original pair (splice from the front).
    live.pushMany([
      [1002, 30, 'a'],
      [1003, 40, 'a'],
    ]);

    // Without the toMap() slice, the group's indices would now read the
    // shifted rows ([30, 40]); the snapshot freeze keeps [10, 20].
    expect(g.length).toBe(2);
    expect(Array.from(g.column('cpu').toFloat64Array())).toEqual([10, 20]);
    expect(Array.from(g.keyColumn().begin)).toEqual([1000, 1001]);
  });

  it('throws on a missing / key partition column instead of silently merging', () => {
    const view = make().window(10);
    // Bad column name (the generic blocks this at compile time; the cast
    // models a JS caller / schema drift). Without the guard, every row's
    // get('nope') is undefined → all collapse into one bucket.
    expect(() =>
      (view as { partitionBy(c: string): { toMap(fn: unknown): unknown } })
        .partitionBy('nope')
        .toMap((g: { length: number }) => g.length),
    ).toThrow(/not a value column/);
    // The key column is rejected too (it's excluded by schema.slice(1)).
    expect(() =>
      (
        view as { partitionBy(c: string): { toMap(fn: unknown): unknown } }
      ).partitionBy('time'),
    ).toThrow(/not a value column/);
  });
});
