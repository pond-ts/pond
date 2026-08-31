/*
 * Property tests converted from TA-Lib's own Python test suite.
 *
 * Portions (the input arrays and expected values in `scale invariance`) are
 * derived from `tests/test_func.py` in TA-Lib/ta-lib-python
 * (https://github.com/TA-Lib/ta-lib-python), used under the BSD 2-Clause
 * License, which requires that redistributions of source retain the copyright
 * notice and disclaimer. The upstream LICENSE file names no individual
 * copyright holder, so attribution is to the project.
 *
 *   BSD 2-Clause License. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS
 *   AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES ARE
 *   DISCLAIMED. See https://github.com/TA-Lib/ta-lib-python/blob/master/LICENSE
 *
 * ## Why these, and not TA-Lib's value tables
 *
 * `study-oracle.test.ts` already checks our VALUES against TA-Lib, bar for
 * bar, on a generated input. Copying more value tables would duplicate it.
 *
 * What TA-Lib's suite has that ours does not is PROPERTY tests, and they
 * cover exactly the ground the oracle's input is designed to avoid — its
 * series is clean, never flat, and gap-free by construction. These are the
 * cases where an indicator is most likely to be quietly wrong:
 *
 *   - `test_RSI`      scale invariance at magnitudes near 1e-7
 *   - `test_EMAEMA`   a study over another study's output: length preserved,
 *                     warm-up composed
 *   - `test_input_allnans`  all-missing in, all-missing out
 *
 * The middle one is not hypothetical for us. `rsi(sma(...))` shipped in
 * review returning an entirely empty column, because a leading NaN landed in
 * the Wilder seed window and a recursion carries state forward forever. It
 * was caught by a chaining test written on a hunch; TA-Lib has had a standing
 * test for that shape for years. This file is the standing version.
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import { ema, macd, rsi, sma } from '../src/index.js';

const closeSchema = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
] as const;

const bars = (closes: number[]) =>
  new TimeSeries({
    name: 'bars',
    schema: closeSchema,
    rows: closes.map((c, i) => [i, c]) as Array<[number, number]>,
  });

const col = (s: unknown, name: string): Array<number | undefined> => {
  const events = (
    s as { events: ReadonlyArray<{ data(): Record<string, unknown> }> }
  ).events;
  return events.map((e) => {
    const v = e.data()[name];
    return typeof v === 'number' ? v : undefined;
  });
};

/** First index holding a value, or -1. */
const firstValid = (v: Array<number | undefined>) =>
  v.findIndex((x) => x !== undefined);

describe('[talib] scale invariance', () => {
  // Verbatim from TA-Lib's `test_RSI`: values around 2.4e-7, and the same
  // series multiplied by 1e5. RSI is a ratio of averaged differences, so it
  // is scale-free in exact arithmetic — the test is whether float error at
  // denormal-adjacent magnitudes breaks that.
  const tiny = [
    0.00000024, 0.00000024, 0.00000024, 0.00000024, 0.00000024, 0.00000023,
    0.00000024, 0.00000024, 0.00000024, 0.00000024, 0.00000023, 0.00000024,
    0.00000023, 0.00000024, 0.00000023, 0.00000024, 0.00000024, 0.00000023,
    0.00000023, 0.00000023,
  ];
  // TA-Lib's own expected output for `RSI(a, 10)`.
  const expected = [
    33.333333333333329, 51.351351351351347, 39.491916859122398,
    51.84807024709005, 42.25953803191981, 52.101824405061215,
    52.101824405061215, 43.043664867691085, 43.043664867691085,
    43.043664867691085,
  ];

  it('rsi matches TA-Lib at magnitudes near 1e-7', () => {
    const v = col(rsi(bars(tiny), { period: 10 }), 'rsi');
    expect(v.slice(0, 10).every((x) => x === undefined)).toBe(true);
    for (let i = 10; i < 20; i += 1) {
      expect(v[i], `bar ${i}`).toBeCloseTo(expected[i - 10]!, 9);
    }
  });

  it('rsi is unchanged by scaling the input', () => {
    const base = col(rsi(bars(tiny), { period: 10 }), 'rsi');
    const scaled = col(
      rsi(bars(tiny.map((x) => x * 100000)), { period: 10 }),
      'rsi',
    );
    for (let i = 0; i < base.length; i += 1) {
      if (base[i] === undefined) expect(scaled[i], `bar ${i}`).toBeUndefined();
      else expect(scaled[i], `bar ${i}`).toBeCloseTo(base[i]!, 9);
    }
  });

  it('macd scales LINEARLY with the input, rather than being invariant', () => {
    // The companion property, and the reason scale invariance is a real
    // assertion rather than a truism: MACD is a difference of prices, so it
    // must scale with them. An implementation that normalised somewhere it
    // shouldn't would pass the RSI test and fail this one.
    const src = Array.from(
      { length: 40 },
      (_, i) => 100 + 10 * Math.sin(i / 4),
    );
    const k = 1000;
    const opts = { fastPeriod: 3, slowPeriod: 7, signalPeriod: 4 } as const;
    const base = col(macd(bars(src), opts), 'macdLine');
    const scaled = col(macd(bars(src.map((x) => x * k)), opts), 'macdLine');
    for (let i = 0; i < base.length; i += 1) {
      if (base[i] === undefined) expect(scaled[i], `bar ${i}`).toBeUndefined();
      else expect(scaled[i]! / k, `bar ${i}`).toBeCloseTo(base[i]!, 9);
    }
  });
});

describe('[talib] a study over another study composes its warm-up', () => {
  const rising = Array.from({ length: 30 }, (_, i) => 100 + i);

  it('ema of ema preserves length and composes the warm-up', () => {
    // TA-Lib's `test_EMAEMA`: EMA(EMA(x, 2), 2) is length-preserving and
    // first valid at index 2 — each pass costs `period - 1` rows.
    const once = ema(bars(rising), { period: 2, output: 'e1' });
    const twice = ema(once, { period: 2, column: 'e1', output: 'e2' });
    const v = col(twice, 'e2');
    expect(v).toHaveLength(rising.length);
    expect(firstValid(v)).toBe(2);
  });

  it('rsi over sma starts late rather than coming back empty', () => {
    // The regression this file exists for. A leading gap from the source
    // study's own warm-up must SHIFT the Wilder seed, not poison it — a
    // recursion carries state forward forever, so poisoning empties the
    // whole column rather than delaying it.
    const src = sma(bars(rising), { period: 3 });
    const v = col(rsi(src, { column: 'sma', period: 4, output: 'r' }), 'r');
    expect(v).toHaveLength(rising.length);
    // sma(3) first valid at 2; rsi(4) needs 4 differences after that.
    expect(firstValid(v)).toBe(6);
    expect(v.slice(6).every((x) => x !== undefined)).toBe(true);
  });

  it('macd over sma composes too', () => {
    const src = sma(bars(rising), { period: 3 });
    const r = macd(src, {
      column: 'sma',
      fastPeriod: 2,
      slowPeriod: 5,
      signalPeriod: 3,
      prefix: 'm',
    });
    expect(col(r, 'mLine')).toHaveLength(rising.length);
    // sma(3) first valid at 2; the slow EMA needs 4 more; the signal 2 more.
    expect(firstValid(col(r, 'mLine'))).toBe(6);
    expect(firstValid(col(r, 'mSignal'))).toBe(8);
  });
});

describe('[talib] all-missing input yields all-missing output', () => {
  // TA-Lib's `test_input_allnans`. A study must not invent a value, throw, or
  // leak NaN into a user-visible column when it is handed nothing usable.
  const allMissing = new TimeSeries({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number', required: false },
    ] as const,
    rows: Array.from({ length: 20 }, (_, i) => [i, undefined]) as Array<
      [number, number | undefined]
    >,
  });

  it('rsi', () => {
    const v = col(rsi(allMissing as never, { period: 5 }), 'rsi');
    expect(v).toHaveLength(20);
    expect(v.every((x) => x === undefined)).toBe(true);
  });

  it('macd', () => {
    const r = macd(allMissing as never, {
      fastPeriod: 2,
      slowPeriod: 5,
      signalPeriod: 3,
    });
    for (const name of ['macdLine', 'macdSignal', 'macdHist']) {
      const v = col(r, name);
      expect(v, name).toHaveLength(20);
      expect(
        v.every((x) => x === undefined),
        name,
      ).toBe(true);
    }
  });

  it('sma and ema', () => {
    expect(
      col(sma(allMissing as never, { period: 5 }), 'sma').every(
        (x) => x === undefined,
      ),
    ).toBe(true);
    expect(
      col(ema(allMissing as never, { period: 5 }), 'ema').every(
        (x) => x === undefined,
      ),
    ).toBe(true);
  });
});
