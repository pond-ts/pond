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

  it('throws a clear spike-limit on a string-column read', () => {
    expect(() => make().window(10).column('host')).toThrow(/number\/boolean/);
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
});
