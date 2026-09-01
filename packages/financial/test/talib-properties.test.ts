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
 *   BSD 2-Clause License. Redistributions of source code must retain the
 *   above copyright notice, this list of conditions and the following
 *   disclaimer. THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND
 *   CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES ARE
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
 *   - `test_input_lengths`  multi-input studies and mismatched inputs
 *
 * What the all-missing tests actually pin is that a study handed nothing
 * usable neither throws nor INVENTS a value. They do not, and cannot, pin
 * "no NaN leaks into a column": `withColumn` maps `NaN` to missing on its
 * typed door ([PND-WCNAN]), so a leaked `NaN` would arrive at any reader as
 * `undefined` and read as a pass. That guarantee belongs to core and is
 * tested there; claiming it here would be coverage this file does not have.
 *
 * The middle one is not hypothetical for us. `rsi(sma(...))` shipped in
 * review returning an entirely empty column, because a leading NaN landed in
 * the Wilder seed window and a recursion carries state forward forever. It
 * was caught by a chaining test written on a hunch; TA-Lib has had a standing
 * test for that shape for years. This file is the standing version.
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  atr,
  ema,
  historicalVolatility,
  macd,
  momentum,
  rsi,
  sma,
} from '../src/index.js';

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

  it('atr scales LINEARLY with the input', () => {
    // ATR is an absolute quantity in the price's units — it deliberately does
    // not normalise, so tripling every price triples it.
    const ohlc = (k: number) =>
      new TimeSeries({
        name: 'bars',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'high', kind: 'number' },
          { name: 'low', kind: 'number' },
          { name: 'close', kind: 'number' },
        ] as const,
        rows: Array.from({ length: 30 }, (_, i) => {
          const c = 100 + 8 * Math.sin(i / 3);
          return [i, (c + 1.2) * k, (c - 0.9) * k, c * k];
        }) as Array<[number, number, number, number]>,
      });
    const base = col(atr(ohlc(1), { period: 4 }), 'atr');
    const scaled = col(atr(ohlc(3), { period: 4 }), 'atr');
    for (let i = 0; i < base.length; i += 1) {
      if (base[i] === undefined) expect(scaled[i], `bar ${i}`).toBeUndefined();
      else expect(scaled[i]! / 3, `bar ${i}`).toBeCloseTo(base[i]!, 9);
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
    //
    // The source OSCILLATES deliberately. A monotonic one (an earlier draft
    // used `100 + i`) sends every bar through RSI's `avgLoss === 0` branch,
    // so the whole test passes on a constant 100 and pins nothing but the
    // shape — mutating that branch to emit 0, or deleting it outright,
    // survived. With a source that falls as well as rises, the same test
    // also pins the values.
    const wavy = Array.from(
      { length: 30 },
      (_, i) => 100 + 6 * Math.sin(i / 2.5) + i * 0.1,
    );
    const src = sma(bars(wavy), { period: 3 });
    const v = col(rsi(src, { column: 'sma', period: 4, output: 'r' }), 'r');
    expect(v).toHaveLength(wavy.length);
    // sma(3) first valid at 2; rsi(4) needs 4 differences after that.
    expect(firstValid(v)).toBe(6);
    expect(v.slice(6).every((x) => x !== undefined)).toBe(true);
    // Strictly interior values: proof the arithmetic ran rather than the
    // no-losses shortcut, which is what a monotonic source hid.
    const defined = v.slice(6) as number[];
    expect(defined.some((x) => x > 0 && x < 100)).toBe(true);
    expect(new Set(defined).size).toBeGreaterThan(1);
  });

  it('atr over a study output composes its warm-up', () => {
    // ATR's close can be redirected at another study's output, whose warm-up
    // must shift the Wilder seed rather than poison it.
    const n = 30;
    const src = new TimeSeries({
      name: 'bars',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'high', kind: 'number' },
        { name: 'low', kind: 'number' },
        { name: 'close', kind: 'number' },
      ] as const,
      rows: Array.from({ length: n }, (_, i) => {
        const c = 100 + 5 * Math.sin(i / 3);
        return [i, c + 1, c - 1, c];
      }) as Array<[number, number, number, number]>,
    });
    const smoothed = sma(src, { period: 3, output: 'sc' });
    const v = col(atr(smoothed, { period: 4, close: 'sc', output: 'a' }), 'a');
    expect(v).toHaveLength(n);
    // sma(3) first valid at 2, so TR first valid at 3, seed 4 bars on: 6.
    expect(firstValid(v)).toBe(6);
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

describe("[talib] a multi-input study's inputs cannot disagree in length", () => {
  /*
   * TA-Lib's `test_input_lengths` exists because its functions take separate
   * arrays: `ATR(high, low, close)` with a short `low` is a caller error it
   * must detect and raise on. Converting it literally is impossible here, and
   * that is the finding rather than a gap — pond's multi-input studies read
   * COLUMNS OF ONE SERIES, so unequal lengths are unrepresentable. The check
   * that upstream needs at every call site is discharged by the type.
   *
   * What remains testable is the part that IS still a caller error: naming a
   * column that is not there.
   */
  const bar = (n: number) =>
    new TimeSeries({
      name: 'bars',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'high', kind: 'number' },
        { name: 'low', kind: 'number' },
        { name: 'close', kind: 'number' },
      ] as const,
      rows: Array.from({ length: n }, (_, i) => [i, 101, 99, 100]) as Array<
        [number, number, number, number]
      >,
    });

  it('atr over aligned columns needs no length check', () => {
    const v = col(atr(bar(12) as never, { period: 3 }), 'atr');
    expect(v).toHaveLength(12);
    expect(v[3]).toBeCloseTo(2, 12);
  });

  it('atr reads all-missing when an input column is misnamed', () => {
    const v = col(
      atr(bar(12) as never, { period: 3, low: 'nope' as never }),
      'atr',
    );
    expect(v).toHaveLength(12);
    expect(v.every((x) => x === undefined)).toBe(true);
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

  it('atr', () => {
    const allMissingBars = new TimeSeries({
      name: 'bars',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'high', kind: 'number', required: false },
        { name: 'low', kind: 'number', required: false },
        { name: 'close', kind: 'number', required: false },
      ] as const,
      rows: Array.from({ length: 20 }, (_, i) => [
        i,
        undefined,
        undefined,
        undefined,
      ]) as Array<
        [number, number | undefined, number | undefined, number | undefined]
      >,
    });
    const v = col(atr(allMissingBars as never, { period: 5 }), 'atr');
    expect(v).toHaveLength(20);
    expect(v.every((x) => x === undefined)).toBe(true);
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

  it('momentum and historicalVolatility', () => {
    const m = col(momentum(allMissing as never, { period: 3 }), 'momentum');
    expect(m).toHaveLength(20);
    expect(m.every((x) => x === undefined)).toBe(true);
    const h = col(
      historicalVolatility(allMissing as never, { period: 3 }),
      'hv',
    );
    expect(h).toHaveLength(20);
    expect(h.every((x) => x === undefined)).toBe(true);
  });
});

describe('[talib] momentum and historical volatility: scale and composition', () => {
  // Oscillating: a geometric series has constant log returns (HV ≡ 0, which
  // is scale-invariant for the wrong reason), and a linear one has constant
  // momentum (a shifted lookback passes).
  const wavy = Array.from(
    { length: 40 },
    (_, i) => 100 + 8 * Math.sin(i / 3) + 3 * Math.sin(i / 1.3),
  );

  it('momentum scales LINEARLY with the input', () => {
    // A difference of prices is in the price's units, like ATR and MACD.
    const k = 1000;
    const base = col(momentum(bars(wavy), { period: 4 }), 'momentum');
    const scaled = col(
      momentum(bars(wavy.map((x) => x * k)), { period: 4 }),
      'momentum',
    );
    expect(firstValid(base)).toBe(4);
    for (let i = 0; i < base.length; i += 1) {
      if (base[i] === undefined) expect(scaled[i], `bar ${i}`).toBeUndefined();
      else expect(scaled[i]! / k, `bar ${i}`).toBeCloseTo(base[i]!, 9);
    }
  });

  it('historicalVolatility is INVARIANT under scaling the input', () => {
    // Log returns are ratios, so a constant factor cancels — at 1e5 and at
    // 1e-5, where the RSI test above showed float error can bite.
    const base = col(historicalVolatility(bars(wavy), { period: 6 }), 'hv');
    expect(firstValid(base)).toBe(6);
    expect(base.slice(6).every((x) => x! > 0)).toBe(true);
    for (const k of [1e5, 1e-5]) {
      const scaled = col(
        historicalVolatility(bars(wavy.map((x) => x * k)), { period: 6 }),
        'hv',
      );
      for (let i = 0; i < base.length; i += 1) {
        if (base[i] === undefined)
          expect(scaled[i], `×${k} bar ${i}`).toBeUndefined();
        else expect(scaled[i], `×${k} bar ${i}`).toBeCloseTo(base[i]!, 9);
      }
    }
  });

  it('momentum over sma composes its warm-up', () => {
    const src = sma(bars(wavy), { period: 3 });
    const v = col(
      momentum(src, { column: 'sma', period: 4, output: 'm' }),
      'm',
    );
    expect(v).toHaveLength(wavy.length);
    // sma(3) first valid at 2; a 4-bar difference of it needs 4 more.
    expect(firstValid(v)).toBe(6);
    expect(v.slice(6).every((x) => x !== undefined)).toBe(true);
  });

  it('historicalVolatility over sma composes its warm-up', () => {
    const src = sma(bars(wavy), { period: 3 });
    const v = col(
      historicalVolatility(src, { column: 'sma', period: 4, output: 'h' }),
      'h',
    );
    expect(v).toHaveLength(wavy.length);
    // sma(3) first valid at 2; 4 returns of it need 4 more bars.
    expect(firstValid(v)).toBe(6);
    expect(v.slice(6).every((x) => x !== undefined && x > 0)).toBe(true);
  });
});
