/**
 * Tests for `smooth(..., { missing: 'skip' })` — validity-respecting smoothing
 * (estela F-smooth-interactive). A cell whose own value is missing stays missing
 * in the output under `'skip'`, instead of being fabricated from its present
 * neighbours (the default `'bridge'`). `ema` takes no `missing` option (it is
 * causal and never fabricates across a gap).
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
] as const;

// A series with a missing middle cell (a "coast"). The tuple type forbids
// `undefined` for a number cell, so cast — `required: false` accepts it at intake.
const withGap = () =>
  new TimeSeries({
    name: 'g',
    schema,
    rows: [
      [0, 10],
      [1, 20],
      [2, undefined],
      [3, 40],
      [4, 50],
    ] as never,
  });

const vals = (sm: unknown): Array<number | undefined> =>
  [...(sm as Iterable<{ get(n: string): number | undefined }>)].map((e) =>
    e.get('v'),
  );

describe('smooth movingAverage { missing }', () => {
  it("default 'bridge' fabricates a value at the missing cell from its window", () => {
    const out = vals(
      withGap().smooth('v', 'movingAverage', {
        window: '1s',
        alignment: 'centered',
      }),
    );
    expect(out[2]).toBe(30); // avg of present {10,20,40,50} — drawn across the hole
  });

  it("'skip' keeps the missing cell missing; present cells unchanged", () => {
    const out = vals(
      withGap().smooth('v', 'movingAverage', {
        window: '1s',
        alignment: 'centered',
        missing: 'skip',
      }),
    );
    expect(out[2]).toBeUndefined(); // the hole is preserved (no fabrication)
    expect(out[0]).toBe(30); // present cell still smoothed over present values
  });
});

describe('smooth loess { missing }', () => {
  it("default 'bridge' fits a value through the missing cell", () => {
    const out = vals(withGap().smooth('v', 'loess', { span: 1 }));
    expect(typeof out[2]).toBe('number'); // regressed across the gap
  });

  it("'skip' keeps the missing cell missing; present cells unchanged", () => {
    const out = vals(
      withGap().smooth('v', 'loess', { span: 1, missing: 'skip' }),
    );
    expect(out[2]).toBeUndefined();
    expect(typeof out[0]).toBe('number'); // present cell still fitted
  });
});
