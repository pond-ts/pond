/**
 * Tests for the **count-window columnar fast path** on `TimeSeries.rolling`
 * (`tryRollingCountColumnarNumeric`) — the all-built-in numeric mapping over
 * packed sources that builds its typed result columns in one sweep.
 *
 * The headline guarantee: the fast path is **pure plumbing** — it feeds the
 * same shared incremental reducer states the generic sweep feeds, in the same
 * order, so its output is value-identical. The parity tests pin that by
 * running the same mapping twice: once all-built-in (fast path) and once with
 * an extra custom-function column appended (which trips the all-or-nothing
 * gate and sends the whole call down the generic sweep), then comparing the
 * shared columns row by row.
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries, ValidationError } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
] as const;

/** Values with interior missing cells — windows see gaps mid-series. */
function holedSeries() {
  const values: Array<number | undefined> = [
    10,
    20,
    undefined,
    40,
    50,
    undefined,
    undefined,
    80,
    90,
    100,
  ];
  return new TimeSeries({
    name: 'v',
    schema,
    rows: values.map((v, i) => [i * 1_000, v] as [number, number | undefined]),
  });
}

/** The count of rolled values a custom reducer sees — appending this column
 *  to a mapping trips the all-or-nothing gate, so the WHOLE call (including
 *  the built-in columns) takes the generic sweep. Same states, same feed
 *  order → the built-in columns must come out value-identical. */
const customCount = {
  from: 'v',
  using: (vals: ReadonlyArray<number | undefined>) => vals.length,
} as const;

function collectColumn(
  series: { length: number; at(i: number): { get(name: string): unknown } },
  name: string,
): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < series.length; i += 1) {
    out.push(series.at(i)!.get(name));
  }
  return out;
}

describe('rolling { count } columnar fast path — parity with the generic sweep', () => {
  const mappings = {
    mean: { from: 'v', using: 'avg' },
    lo: { from: 'v', using: 'min' },
    hi: { from: 'v', using: 'max' },
    sd: { from: 'v', using: 'stdev' },
    total: { from: 'v', using: 'sum' },
  } as const;

  for (const alignment of ['trailing', 'leading', 'centered'] as const) {
    it(`matches the generic sweep exactly — ${alignment}, holes, minSamples`, () => {
      const s = holedSeries();
      const fast = s.rolling({ count: 3 }, mappings, {
        alignment,
        minSamples: 2,
      });
      const generic = s.rolling(
        { count: 3 },
        { ...mappings, n: customCount },
        { alignment, minSamples: 2 },
      );
      for (const name of Object.keys(mappings)) {
        expect(collectColumn(fast, name), name).toEqual(
          collectColumn(generic, name),
        );
      }
    });
  }

  it('matches the generic sweep with no minSamples gate (partial windows emit)', () => {
    const s = holedSeries();
    const fast = s.rolling({ count: 4 }, mappings);
    const generic = s.rolling({ count: 4 }, { ...mappings, n: customCount });
    for (const name of Object.keys(mappings)) {
      expect(collectColumn(fast, name), name).toEqual(
        collectColumn(generic, name),
      );
    }
  });

  it('an all-missing window emits a missing cell (no gate needed)', () => {
    // Rows 5 and 6 are both missing → a trailing count-2 window at row 6
    // holds two rows but zero present values → avg snapshots undefined.
    const s = holedSeries();
    const r = s.rolling({ count: 2 }, { m: { from: 'v', using: 'avg' } });
    expect(r.at(6)!.get('m')).toBeUndefined();
    // Its neighbours average over the present values only.
    expect(r.at(5)!.get('m')).toBe(50); // [50, missing]
    expect(r.at(7)!.get('m')).toBe(80); // [missing, 80]
  });
});

describe('rolling { count } columnar fast path — output shape', () => {
  it('shares the key column with the source (zero-copy keys)', () => {
    const s = holedSeries();
    const r = s.rolling({ count: 3 }, { m: { from: 'v', using: 'avg' } });
    expect(r.keyColumn()).toBe(s.keyColumn());
  });

  it('rejects a non-finite reducer result like the generic sweep (sum overflow)', () => {
    const big = new TimeSeries({
      name: 'v',
      schema,
      rows: [
        [0, 1.2e308],
        [1_000, 1.2e308],
      ] as Array<[number, number]>,
    });
    // Window [1.2e308, 1.2e308] → incremental sum overflows to Infinity.
    // Fast path asserts at write time; must match the generic sweep's
    // post-pass rejection (ValidationError, same message shape).
    expect(() =>
      big.rolling({ count: 2 }, { total: { from: 'v', using: 'sum' } }),
    ).toThrow(ValidationError);
    expect(() =>
      big.rolling({ count: 2 }, { total: { from: 'v', using: 'sum' } }),
    ).toThrow(/rolling column 'total'.*not a valid 'number' value/);
    // The generic sweep (custom column appended) rejects identically.
    expect(() =>
      big.rolling(
        { count: 2 },
        { total: { from: 'v', using: 'sum' }, n: customCount },
      ),
    ).toThrow(ValidationError);
  });

  it('downstream ops read the fast-path columns (validity round-trips)', () => {
    const s = holedSeries();
    const r = s.rolling(
      { count: 3 },
      { m: { from: 'v', using: 'avg' } },
      { minSamples: 3 },
    );
    // Warm-up head is missing; a whole-series reduce over the result skips it.
    const defined = collectColumn(r, 'm').filter((v) => v !== undefined);
    expect(r.reduce('m', 'count')).toBe(defined.length);
  });
});
