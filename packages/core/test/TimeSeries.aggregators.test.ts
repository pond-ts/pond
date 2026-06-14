import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function makeSeries() {
  return new TimeSeries({
    name: 'test',
    schema,
    rows: [
      [0, 10, 'a'],
      [1000, 20, 'a'],
      [2000, 30, 'a'],
      [3000, 40, 'b'],
      [4000, 50, 'a'],
    ],
  });
}

function makeEmpty() {
  return new TimeSeries({ name: 'empty', schema, rows: [] });
}

function makeSingle() {
  return new TimeSeries({
    name: 'single',
    schema,
    rows: [[0, 42, 'x']],
  });
}

// ── median ──────────────────────────────────────────────────

describe('median', () => {
  it('returns the middle value of an odd-length set', () => {
    expect(makeSeries().reduce('value', 'median')).toBe(30);
  });

  it('interpolates for an even-length set', () => {
    const s = new TimeSeries({
      name: 'even',
      schema,
      rows: [
        [0, 10, 'a'],
        [1000, 20, 'a'],
        [2000, 30, 'a'],
        [3000, 40, 'a'],
      ],
    });
    expect(s.reduce('value', 'median')).toBe(25);
  });

  it('returns undefined for empty series', () => {
    expect(makeEmpty().reduce('value', 'median')).toBeUndefined();
  });

  it('returns the value for single-event series', () => {
    expect(makeSingle().reduce('value', 'median')).toBe(42);
  });
});

// ── stdev ───────────────────────────────────────────────────

describe('stdev', () => {
  it('computes population standard deviation', () => {
    const s = new TimeSeries({
      name: 'sd',
      schema,
      rows: [
        [0, 2, 'a'],
        [1000, 4, 'a'],
        [2000, 4, 'a'],
        [3000, 4, 'a'],
        [4000, 5, 'a'],
        [5000, 5, 'a'],
        [6000, 7, 'a'],
        [7000, 9, 'a'],
      ],
    });
    expect(s.reduce('value', 'stdev')).toBeCloseTo(2.0, 5);
  });

  it('returns 0 for identical values', () => {
    const s = new TimeSeries({
      name: 'flat',
      schema,
      rows: [
        [0, 5, 'a'],
        [1000, 5, 'a'],
        [2000, 5, 'a'],
      ],
    });
    expect(s.reduce('value', 'stdev')).toBe(0);
  });

  it('returns undefined for empty series', () => {
    expect(makeEmpty().reduce('value', 'stdev')).toBeUndefined();
  });

  // Regression: L2 review on PR #153 (step 3 reducer fast-path)
  // caught that the column path's one-pass `sq/n − mean²` formula
  // suffers catastrophic cancellation on near-equal large-magnitude
  // values — diverging from the row-API two-pass formula. Both
  // paths now use two-pass; this test pins the algorithmic recovery
  // for values where one-pass would have returned 0 (or NaN without
  // a clamp) vs the correct ~1.118 from two-pass.
  it('stdev is numerically stable on near-equal large-magnitude values', () => {
    const s = new TimeSeries({
      name: 'large',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [
        [0, 1e10],
        [1000, 1e10 + 1],
        [2000, 1e10 + 2],
        [3000, 1e10 + 3],
      ],
    });
    // Inputs are exactly representable in float64 (well under 2^53).
    // True population stdev of {0, 1, 2, 3} = sqrt(5/4) ≈ 1.118; the
    // 1e10 shift is mathematically a no-op (stdev is shift-invariant)
    // but `sq/n - mean*mean` cancels catastrophically — at 1e10 the
    // formula yields exactly 0. The two-pass `Σ(v - mean)²/n` recovers
    // the exact answer.
    const result = s.reduce('value', 'stdev') as number;
    expect(result).toBeCloseTo(Math.sqrt(5 / 4), 10);
  });
});

// ── percentile ──────────────────────────────────────────────

describe('percentile', () => {
  it('p50 matches median', () => {
    expect(makeSeries().reduce('value', 'p50')).toBe(
      makeSeries().reduce('value', 'median'),
    );
  });

  it('p0 returns the minimum', () => {
    expect(makeSeries().reduce('value', 'p0')).toBe(10);
  });

  it('p100 returns the maximum', () => {
    expect(makeSeries().reduce('value', 'p100')).toBe(50);
  });

  it('p95 interpolates near the top', () => {
    const result = makeSeries().reduce('value', 'p95');
    expect(typeof result).toBe('number');
    expect(result as number).toBeGreaterThan(45);
    expect(result as number).toBeLessThanOrEqual(50);
  });

  it('returns undefined for empty series', () => {
    expect(makeEmpty().reduce('value', 'p50')).toBeUndefined();
  });

  it('works with fractional percentiles', () => {
    const result = makeSeries().reduce('value', 'p99.9');
    expect(typeof result).toBe('number');
  });
});

// ── difference ──────────────────────────────────────────────

describe('difference', () => {
  it('returns max - min', () => {
    expect(makeSeries().reduce('value', 'difference')).toBe(40);
  });

  it('returns 0 for identical values', () => {
    const s = new TimeSeries({
      name: 'flat',
      schema,
      rows: [
        [0, 5, 'a'],
        [1000, 5, 'a'],
      ],
    });
    expect(s.reduce('value', 'difference')).toBe(0);
  });

  it('returns undefined for empty series', () => {
    expect(makeEmpty().reduce('value', 'difference')).toBeUndefined();
  });

  it('returns 0 for single-event series', () => {
    expect(makeSingle().reduce('value', 'difference')).toBe(0);
  });
});

// ── keep ────────────────────────────────────────────────────

describe('keep', () => {
  it('returns the value when all values are identical', () => {
    const s = new TimeSeries({
      name: 'same',
      schema,
      rows: [
        [0, 10, 'a'],
        [1000, 20, 'a'],
        [2000, 30, 'a'],
      ],
    });
    expect(s.reduce('host', 'keep')).toBe('a');
  });

  it('returns undefined when values differ', () => {
    expect(makeSeries().reduce('host', 'keep')).toBeUndefined();
  });

  it('returns undefined for empty series', () => {
    expect(makeEmpty().reduce('host', 'keep')).toBeUndefined();
  });

  it('returns the value for single-event series', () => {
    expect(makeSingle().reduce('host', 'keep')).toBe('x');
  });

  it('works on numeric columns', () => {
    const s = new TimeSeries({
      name: 'same-num',
      schema,
      rows: [
        [0, 7, 'a'],
        [1000, 7, 'a'],
        [2000, 7, 'a'],
      ],
    });
    expect(s.reduce('value', 'keep')).toBe(7);
  });
});

// ── aggregate (bucketed) ────────────────────────────────────

describe('aggregate with new reducers', () => {
  function makeLonger() {
    return new TimeSeries({
      name: 'longer',
      schema,
      rows: [
        [0, 10, 'a'],
        [1000, 20, 'a'],
        [2000, 30, 'a'],
        [3000, 40, 'a'],
        [4000, 50, 'a'],
        [5000, 60, 'b'],
        [6000, 70, 'b'],
        [7000, 80, 'b'],
        [8000, 90, 'b'],
        [9000, 100, 'b'],
      ],
    });
  }

  it('aggregates median into buckets', () => {
    const agg = makeLonger().aggregate(Sequence.every('5s'), {
      value: 'median',
    });
    expect(agg.at(0)?.get('value')).toBe(30);
    expect(agg.at(1)?.get('value')).toBe(80);
  });

  it('aggregates stdev into buckets', () => {
    const agg = makeLonger().aggregate(Sequence.every('5s'), {
      value: 'stdev',
    });
    const first = agg.at(0)?.get('value') as number;
    expect(first).toBeGreaterThan(0);
  });

  it('aggregates percentile into buckets', () => {
    const agg = makeLonger().aggregate(Sequence.every('5s'), {
      value: 'p95',
    });
    const first = agg.at(0)?.get('value') as number;
    expect(first).toBeGreaterThan(40);
    expect(first).toBeLessThanOrEqual(50);
  });

  it('aggregates difference into buckets', () => {
    const agg = makeLonger().aggregate(Sequence.every('5s'), {
      value: 'difference',
    });
    expect(agg.at(0)?.get('value')).toBe(40);
    expect(agg.at(1)?.get('value')).toBe(40);
  });

  it('aggregates keep into buckets', () => {
    const agg = makeLonger().aggregate(Sequence.every('5s'), {
      host: 'keep',
    });
    expect(agg.at(0)?.get('host')).toBe('a');
    expect(agg.at(1)?.get('host')).toBe('b');
  });

  it('mixed new and old reducers in same aggregate call', () => {
    const agg = makeLonger().aggregate(Sequence.every('5s'), {
      value: 'median',
      host: 'keep',
    });
    expect(agg.at(0)?.get('value')).toBe(30);
    expect(agg.at(0)?.get('host')).toBe('a');
  });
});

// ── rolling ─────────────────────────────────────────────────

describe('rolling with new reducers', () => {
  function makeRegular() {
    return new TimeSeries({
      name: 'regular',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'value', kind: 'number' },
      ] as const,
      rows: [
        [0, 10],
        [1000, 20],
        [2000, 30],
        [3000, 40],
        [4000, 50],
      ],
    });
  }

  it('rolling median over 3-event window', () => {
    const r = makeRegular().rolling('3s', { value: 'median' });
    expect(r.at(0)?.get('value')).toBe(10);
    expect(r.at(1)?.get('value')).toBe(15);
    expect(r.at(2)?.get('value')).toBe(20);
    expect(r.at(3)?.get('value')).toBe(30);
    expect(r.at(4)?.get('value')).toBe(40);
  });

  it('rolling stdev', () => {
    const r = makeRegular().rolling('3s', { value: 'stdev' });
    expect(r.at(0)?.get('value')).toBe(0);
    const mid = r.at(2)?.get('value') as number;
    expect(mid).toBeGreaterThan(0);
  });

  it('rolling difference', () => {
    const r = makeRegular().rolling('3s', { value: 'difference' });
    expect(r.at(0)?.get('value')).toBe(0);
    expect(r.at(1)?.get('value')).toBe(10);
    expect(r.at(2)?.get('value')).toBe(20);
    expect(r.at(3)?.get('value')).toBe(20);
    expect(r.at(4)?.get('value')).toBe(20);
  });

  it('rolling percentile', () => {
    const r = makeRegular().rolling('3s', { value: 'p50' });
    const medianR = makeRegular().rolling('3s', { value: 'median' });
    for (let i = 0; i < 5; i++) {
      expect(r.at(i)?.get('value')).toBe(medianR.at(i)?.get('value'));
    }
  });

  it('rolling keep', () => {
    const s = new TimeSeries({
      name: 'rk',
      schema,
      rows: [
        [0, 10, 'a'],
        [1000, 20, 'a'],
        [2000, 30, 'a'],
        [3000, 40, 'b'],
        [4000, 50, 'b'],
      ],
    });
    const r = s.rolling('3s', { host: 'keep' });
    expect(r.at(0)?.get('host')).toBe('a');
    expect(r.at(1)?.get('host')).toBe('a');
    expect(r.at(2)?.get('host')).toBe('a');
    // window spans both 'a' and 'b' at indices 3 and 4
    expect(r.at(3)?.get('host')).toBeUndefined();
    expect(r.at(4)?.get('host')).toBeUndefined();
  });
});
