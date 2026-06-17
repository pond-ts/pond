/**
 * `'mean'` is an accepted alias for `'avg'` in aggregate / rolling / byColumn
 * mappings, matching the column API's `Float64Column.mean()`
 * (estela F-reducer-naming). Previously `'mean'` threw in
 * `normalizeAggregateColumns` → `resolveReducer`.
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

const s = new TimeSeries({
  name: 't',
  schema,
  rows: [
    [0, 10],
    [1, 20],
    [2, 30],
    [3, 40],
  ],
});

describe("'mean' reducer alias for 'avg'", () => {
  it('reduce: mean matches avg', () => {
    const m = s.reduce({ x: { from: 'v', using: 'mean' } });
    const a = s.reduce({ x: { from: 'v', using: 'avg' } });
    expect(m.x).toBe(a.x);
    expect(m.x).toBe(25);
  });

  it('byColumn: mean matches avg per bin', () => {
    const m = s.byColumn(
      'v',
      { width: 100 },
      {
        x: { from: 'v', using: 'mean' },
      },
    );
    expect(m[0]!.x).toBe(25);
  });

  it('rollingByColumn: mean matches avg per window', () => {
    const m = s.rollingByColumn(
      'v',
      { radius: 100 },
      {
        x: { from: 'v', using: 'mean' },
      },
    );
    expect(m.every((r) => r.x === 25)).toBe(true);
  });
});
