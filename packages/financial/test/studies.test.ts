import { describe, it, expect } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  sma,
  ema,
  bollinger,
  rollingStdev,
  rollingMin,
  rollingMax,
  rollingPercentile,
  zScore,
  envelope,
  percentChange,
  rsi,
  macd,
} from '../src/index.js';

/** A close-only bar series at 1ms spacing (value = the close). */
const closeSchema = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
] as const;

function bars(closes: number[], times?: number[]) {
  return new TimeSeries({
    name: 'bars',
    schema: closeSchema,
    rows: closes.map((c, i) => [times ? times[i]! : i, c]) as Array<
      [number, number]
    >,
  });
}

/** Read a numeric column as (number | undefined)[] from any result series. */
function col(s: unknown, name: string): Array<number | undefined> {
  const events = (
    s as { events: ReadonlyArray<{ data(): Record<string, unknown> }> }
  ).events;
  return events.map((e) => {
    const v = e.data()[name];
    return typeof v === 'number' ? v : undefined;
  });
}

describe('sma', () => {
  it('averages the last `period` bars, warmup rows undefined, length kept', () => {
    const r = sma(bars([10, 11, 12, 13, 14]), { period: 3 });
    expect(r.length).toBe(5);
    expect(col(r, 'sma')).toEqual([undefined, undefined, 11, 12, 13]);
  });

  it('counts N bars across a time gap (a duration window would not)', () => {
    // A big gap between bars 2 and 3; the count window still averages 2 bars.
    const r = sma(bars([10, 20, 30, 40, 50], [0, 1, 2, 1_000_000, 1_000_001]), {
      period: 2,
    });
    expect(col(r, 'sma')[3]).toBe(35); // (30 + 40) / 2 — two bars, not time
  });

  it('honours column + output, and composes over another study output', () => {
    const once = sma(bars([10, 11, 12, 13, 14]), { period: 2, output: 'fast' });
    const twice = sma(once, { period: 2, column: 'fast', output: 'fastfast' });
    expect(col(twice, 'fast')[4]).toBe(13.5); // avg(13,14)
    // fastfast = avg of the last two `fast` values (a study over a study).
    expect(col(twice, 'fastfast')[4]).toBeCloseTo((12.5 + 13.5) / 2, 10);
  });

  it('stacks sma → ema → bollinger without a strict-intake crash on the warmup gaps', () => {
    // Regression: chaining a rolling study (sma, undefined warmup) into ema
    // (which rebuilds rows via strict intake) crashed while withColumn marked
    // the sma column required. All three now stack on one series. (Separate
    // `const` bindings — each study widens the schema type, so a reassigned
    // `let` wouldn't typecheck.)
    const withSma = sma(bars([10, 11, 12, 13, 14, 15]), { period: 3 });
    const withEma = ema(withSma, { period: 3 });
    const withBands = bollinger(withEma, { period: 3 });
    const last = withBands.events.at(-1)!.data();
    expect(typeof last.sma).toBe('number');
    expect(typeof last.ema).toBe('number');
    expect(typeof last.bbMiddle).toBe('number');
  });

  it('throws on a bad period or an output collision', () => {
    expect(() => sma(bars([1, 2]), { period: 0 })).toThrow(/positive integer/);
    expect(() => sma(bars([1, 2]), { period: 1, output: 'close' })).toThrow(
      /collides/,
    );
  });

  it('period larger than the series → every row undefined, length kept', () => {
    const r = sma(bars([10, 20, 30]), { period: 5 });
    expect(r.length).toBe(3);
    expect(col(r, 'sma')).toEqual([undefined, undefined, undefined]);
  });

  it('period 1 on a single bar is that bar', () => {
    const r = sma(bars([42]), { period: 1 });
    expect(col(r, 'sma')).toEqual([42]);
  });
});

describe('ema', () => {
  it('is a span EMA (span = period → α = 2/(period+1)) with a length-preserving warmup', () => {
    const src = bars([10, 11, 12, 13, 14, 15]);
    const r = ema(src, { period: 3 }); // span 3 → α 0.5
    // First period-1 rows masked; length preserved.
    expect(r.length).toBe(6);
    expect(col(r, 'ema')[0]).toBeUndefined();
    expect(col(r, 'ema')[1]).toBeUndefined();
    // Equal to the raw smooth('ema', { span:3, minSamples:3 }) tail.
    const ref = src.smooth('close', 'ema', {
      span: 3,
      minSamples: 3,
      output: 'e',
    });
    for (let i = 2; i < 6; i += 1) {
      expect(col(r, 'ema')[i]).toBeCloseTo(col(ref, 'e')[i] as number, 10);
    }
  });
});

describe('bollinger', () => {
  it('appends middle/upper/lower with the ±stdDev band', () => {
    const r = bollinger(bars([10, 20, 30, 25, 15]), { period: 3, stdDev: 2 });
    const mid = col(r, 'bbMiddle');
    const up = col(r, 'bbUpper');
    const lo = col(r, 'bbLower');
    expect(mid[0]).toBeUndefined(); // warmup
    expect(mid[2]).toBeCloseTo(20, 10); // avg(10,20,30)
    // population stdev of {10,20,30} = sqrt(200/3); band = mid ± 2σ.
    const sd = Math.sqrt(200 / 3);
    expect(up[2]).toBeCloseTo(20 + 2 * sd, 10);
    expect(lo[2]).toBeCloseTo(20 - 2 * sd, 10);
  });

  it('emits undefined bands on a flat (σ = 0) window, and honours prefix', () => {
    const r = bollinger(bars([5, 5, 5, 5]), { period: 3, prefix: 'band' });
    expect(col(r, 'bandMiddle')[2]).toBe(5);
    expect(col(r, 'bandUpper')[2]).toBeUndefined(); // σ = 0 → no band
    expect(col(r, 'bandLower')[2]).toBeUndefined();
  });

  it('throws on a non-positive stdDev', () => {
    expect(() => bollinger(bars([1, 2, 3]), { period: 2, stdDev: 0 })).toThrow(
      /stdDev/,
    );
  });
});

// Values for the studies below are cross-validated against pandas in
// study-oracle.test.ts; here we pin the behaviours the oracle doesn't cover
// (output naming, warm-up shape, σ=0 / edge handling, validation).
describe('rolling-stat family', () => {
  it('rollingStdev/Min/Max append their default columns, warmup undefined', () => {
    const src = bars([10, 12, 11, 15, 14]);
    expect(col(rollingStdev(src, { period: 3 }), 'stdev')[1]).toBeUndefined();
    expect(col(rollingMin(src, { period: 3 }), 'min')[2]).toBe(10);
    expect(col(rollingMax(src, { period: 3 }), 'max')[2]).toBe(12);
    expect(col(rollingMax(src, { period: 3 }), 'max')[3]).toBe(15);
  });

  it('rollingPercentile defaults output to p{q} and validates q', () => {
    const r = rollingPercentile(bars([1, 2, 3, 4, 5]), { period: 3, q: 50 });
    expect(col(r, 'p50')[2]).toBe(2); // median of [1,2,3]
    expect(() =>
      rollingPercentile(bars([1, 2]), { period: 2, q: 150 }),
    ).toThrow(/\[0, 100\]/);
  });
});

describe('zScore', () => {
  it('is (value - mean) / stdev, undefined on warmup and flat windows', () => {
    // window [10,20,30] → mean 20, pop stdev sqrt(200/3); z of 30 = 10/sd.
    const r = zScore(bars([10, 20, 30]), { period: 3 });
    expect(col(r, 'zscore')[1]).toBeUndefined();
    expect(col(r, 'zscore')[2]).toBeCloseTo(10 / Math.sqrt(200 / 3), 10);
    // flat window → σ = 0 → undefined (not ±Infinity).
    expect(col(zScore(bars([5, 5, 5]), { period: 3 }), 'zscore')[2]).toBe(
      undefined,
    );
  });
});

describe('envelope', () => {
  it('bands are middle × (1 ± percent/100); honours prefix', () => {
    const r = envelope(bars([10, 20, 30]), { period: 3, percent: 10 });
    expect(col(r, 'envMiddle')[2]).toBe(20);
    expect(col(r, 'envUpper')[2]).toBeCloseTo(22, 10); // 20 * 1.10
    expect(col(r, 'envLower')[2]).toBeCloseTo(18, 10); // 20 * 0.90
    const e = envelope(bars([10, 20, 30]), { period: 3, prefix: 'ma' });
    expect(col(e, 'maMiddle')[2]).toBe(20);
  });

  it('throws on a non-positive percent', () => {
    expect(() => envelope(bars([1, 2, 3]), { period: 2, percent: 0 })).toThrow(
      /percent/,
    );
  });
});

describe('percentChange', () => {
  it('is (v / v[-periods] - 1) * 100; first `periods` rows undefined', () => {
    const r = percentChange(bars([100, 110, 121]), { periods: 1 });
    expect(col(r, 'pctChange')[0]).toBeUndefined();
    expect(col(r, 'pctChange')[1]).toBeCloseTo(10, 10); // 110/100 - 1
    expect(col(r, 'pctChange')[2]).toBeCloseTo(10, 10); // 121/110 - 1
  });

  it('defaults periods to 1 and validates', () => {
    expect(col(percentChange(bars([100, 105])), 'pctChange')[1]).toBeCloseTo(
      5,
      10,
    );
    expect(() => percentChange(bars([1, 2]), { periods: 0 })).toThrow(
      /positive integer/,
    );
  });
});

describe('rsi', () => {
  it('needs period+1 bars: the first `period` rows are undefined', () => {
    // RSI is built from DIFFERENCES, so a period-bar average of them needs
    // period+1 bars. Off-by-one here is the classic RSI mistake.
    const r = rsi(bars([1, 2, 3, 4, 5, 6]), { period: 3 });
    const v = col(r, 'rsi');
    expect(v.slice(0, 3).every((x) => x === undefined)).toBe(true);
    expect(v[3]).toBeDefined();
    expect(v).toHaveLength(6); // length-preserving
  });

  it('is 100 when the window has no losses', () => {
    // Monotonically rising: avgLoss is 0, the ratio diverges, RSI's limit
    // is 100 — not a division by zero and not undefined.
    const v = col(rsi(bars([1, 2, 3, 4, 5, 6]), { period: 3 }), 'rsi');
    expect(v[3]).toBe(100);
    expect(v[5]).toBe(100);
  });

  it('is 0 when the window has no gains', () => {
    const v = col(rsi(bars([6, 5, 4, 3, 2, 1]), { period: 3 }), 'rsi');
    expect(v[3]).toBe(0);
  });

  it('is undefined on a perfectly flat window (no relative strength)', () => {
    // avgGain and avgLoss are both 0: the ratio is 0/0, which has no value
    // rather than a conventional one.
    const v = col(rsi(bars([5, 5, 5, 5, 5, 5]), { period: 3 }), 'rsi');
    expect(v[3]).toBeUndefined();
    expect(v[5]).toBeUndefined();
  });

  it('stays within 0..100', () => {
    const closes = Array.from(
      { length: 60 },
      (_, i) => 100 + 10 * Math.sin(i / 4) + i * 0.3,
    );
    for (const x of col(rsi(bars(closes), { period: 14 }), 'rsi')) {
      if (x !== undefined) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(100);
      }
    }
  });

  it('defaults to period 14 and the `rsi` output name, and honours both', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + (i % 5) - 2);
    const def = rsi(bars(closes));
    expect(col(def, 'rsi')[13]).toBeUndefined(); // period 14 → 14 warm-up rows
    expect(col(def, 'rsi')[14]).toBeDefined();

    const named = rsi(bars(closes), { period: 5, output: 'momentum' });
    expect(col(named, 'momentum')[5]).toBeDefined();
    expect(col(named, 'rsi')[5]).toBeUndefined(); // no default column written
  });

  it('runs over any numeric column, including another study output', () => {
    // The uniform-shape rule: never hard-code `close`.
    const chained = rsi(
      sma(bars([1, 3, 2, 5, 4, 7, 6, 9, 8, 11]), { period: 2 }),
      {
        column: 'sma',
        period: 3,
        output: 'smaRsi',
      },
    );
    expect(col(chained, 'smaRsi')[9]).toBeDefined();
  });

  it('propagates an interior gap, but only shifts for a leading one', () => {
    // The asymmetry is inherent to a recursion and is documented as such: a
    // leading gap (a chained study's warm-up) moves the seed; an interior one
    // has no state to carry across and poisons what follows.
    const withHole = new TimeSeries({
      name: 'bars',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'close', kind: 'number', required: false },
      ] as const,
      rows: [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [4, undefined],
        [5, 6],
        [6, 7],
        [7, 8],
      ] as Array<[number, number | undefined]>,
    });
    const v = col(rsi(withHole as never, { period: 3 }), 'rsi');
    expect(v[3]).toBeDefined(); // seeded before the hole
    expect(v[7]).toBeUndefined(); // and never recovers after it
  });

  it('rejects a non-positive or fractional period, and a colliding output', () => {
    expect(() => rsi(bars([1, 2, 3]), { period: 0 })).toThrow(TypeError);
    expect(() => rsi(bars([1, 2, 3]), { period: 2.5 })).toThrow(TypeError);
    expect(() => rsi(bars([1, 2, 3]), { output: 'close' })).toThrow();
  });

  it('is all-undefined when the period exceeds the available differences', () => {
    const v = col(rsi(bars([1, 2, 3]), { period: 5 }), 'rsi');
    expect(v).toHaveLength(3);
    expect(v.every((x) => x === undefined)).toBe(true);
  });
});

describe('macd', () => {
  const rising = Array.from({ length: 60 }, (_, i) => 100 + i);

  it('each column warms up when it can, not all at the slowest', () => {
    // The line is defined once the SLOW ema is (bar slow-1); the signal a
    // further signalPeriod-1 bars on. TA-Lib masks the line back to the
    // signal's start and throws those values away; we keep them.
    const r = macd(bars(rising), {
      fastPeriod: 3,
      slowPeriod: 7,
      signalPeriod: 4,
    });
    const line = col(r, 'macdLine');
    const signal = col(r, 'macdSignal');
    const hist = col(r, 'macdHist');

    expect(line[5]).toBeUndefined();
    expect(line[6]).toBeDefined(); // slowPeriod - 1
    expect(signal[8]).toBeUndefined();
    expect(signal[9]).toBeDefined(); // + signalPeriod - 1
    expect(hist[8]).toBeUndefined();
    expect(hist[9]).toBeDefined();
    expect(line).toHaveLength(60); // length-preserving
  });

  it('the line is exactly ema(fast) − ema(slow) from this package', () => {
    // The internal-consistency property that decided the seed convention: if
    // this ever fails, macd() and ema() have drifted apart and the reason for
    // NOT matching TA-Lib's seed has evaporated.
    const src = bars(rising);
    const f = col(ema(src, { period: 3, output: 'f' }), 'f');
    const sl = col(ema(src, { period: 7, output: 's' }), 's');
    const line = col(
      macd(src, { fastPeriod: 3, slowPeriod: 7, signalPeriod: 4 }),
      'macdLine',
    );
    for (let i = 0; i < rising.length; i += 1) {
      if (f[i] === undefined || sl[i] === undefined) {
        expect(line[i]).toBeUndefined();
      } else {
        expect(line[i]).toBeCloseTo(f[i]! - sl[i]!, 12);
      }
    }
  });

  it('the histogram is exactly line − signal', () => {
    const r = macd(bars(rising), {
      fastPeriod: 3,
      slowPeriod: 7,
      signalPeriod: 4,
    });
    const line = col(r, 'macdLine');
    const signal = col(r, 'macdSignal');
    const hist = col(r, 'macdHist');
    for (let i = 0; i < rising.length; i += 1) {
      if (signal[i] === undefined) expect(hist[i]).toBeUndefined();
      else expect(hist[i]).toBeCloseTo(line[i]! - signal[i]!, 12);
    }
  });

  it('honours a custom prefix and leaves no scratch column behind', () => {
    const r = macd(bars(rising), { prefix: 'x' });
    expect(col(r, 'xLine')[30]).toBeDefined();
    expect(col(r, 'xSignal')[40]).toBeDefined();
    expect(col(r, 'xHist')[40]).toBeDefined();
    // The signal EMA is taken over a scratch column; it must not survive.
    expect(
      (r as unknown as { column(n: string): unknown }).column('__macdLine__'),
    ).toBeUndefined();
  });

  it('rejects a fast period that is not shorter than the slow one', () => {
    expect(() =>
      macd(bars(rising), { fastPeriod: 26, slowPeriod: 26 }),
    ).toThrow(TypeError);
    expect(() =>
      macd(bars(rising), { fastPeriod: 30, slowPeriod: 26 }),
    ).toThrow(TypeError);
  });

  it('rejects non-positive or fractional periods, and a colliding prefix', () => {
    expect(() => macd(bars(rising), { signalPeriod: 0 })).toThrow(TypeError);
    expect(() => macd(bars(rising), { fastPeriod: 2.5 })).toThrow(TypeError);
    expect(() => macd(bars(rising), { prefix: 'clo' as never })).not.toThrow();
    const withLine = macd(bars(rising));
    expect(() => macd(withLine as never)).toThrow(); // macdLine already there
  });

  it('is all-undefined when the slow period exceeds the series', () => {
    const short = bars([1, 2, 3, 4, 5]);
    const r = macd(short, { fastPeriod: 2, slowPeriod: 9, signalPeriod: 3 });
    for (const name of ['macdLine', 'macdSignal', 'macdHist']) {
      const v = col(r, name);
      expect(v, name).toHaveLength(5);
      expect(
        v.every((x) => x === undefined),
        name,
      ).toBe(true);
    }
  });

  it('runs over a non-default column', () => {
    const r = macd(sma(bars(rising), { period: 2 }), {
      column: 'sma',
      fastPeriod: 3,
      slowPeriod: 7,
      signalPeriod: 4,
      prefix: 'smaMacd',
    });
    expect(col(r, 'smaMacdLine')[20]).toBeDefined();
    expect(col(r, 'smaMacdSignal')[20]).toBeDefined();
  });
});
