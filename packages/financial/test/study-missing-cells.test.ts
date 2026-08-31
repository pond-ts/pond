import { describe, expect, it } from 'vitest';
import { TimeSeries } from 'pond-ts';
import {
  sma,
  ema,
  bollinger,
  zScore,
  percentChange,
  envelope,
  rsi,
} from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* [PND-STUDYBOX] — studies compute over Float64Array with NaN-as-missing.     */
/*                                                                             */
/* The kernel used to hand studies `Array<number | undefined>` and each study  */
/* checked every input for `undefined` per cell. It now hands them a           */
/* `Float64Array` where NaN marks a gap, which propagates through arithmetic   */
/* on its own — so those per-cell checks are gone.                             */
/*                                                                             */
/* That is only safe if the OBSERVABLE result is unchanged, which is what      */
/* these pin. The oracle suite (test/study-oracle.test.ts) already checks the  */
/* numbers against pandas; this checks the thing the oracle fixtures don't     */
/* exercise — where the gaps are, and that they read back as `undefined`       */
/* rather than as NaN leaking into a user-visible column.                      */
/* -------------------------------------------------------------------------- */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
] as const;

const MINUTE = 60_000;

const bars = (closes: number[]) =>
  new TimeSeries({
    name: 'bars',
    schema,
    rows: closes.map((c, i) => [i * MINUTE, c] as const) as never,
  });

/** Structural read so a test can name any output column without the
 *  schema-narrowed `column()` overload rejecting a plain string. */
type ReadableSeries = {
  readonly length: number;
  column(name: string): { at(i: number): unknown } | undefined;
};

const cells = (s: unknown, name: string): Array<unknown> => {
  const r = s as ReadableSeries;
  const col = r.column(name);
  return Array.from({ length: r.length }, (_, i) => col?.at(i));
};

const nullCountOf = (s: unknown, name: string): number =>
  cells(s, name).filter((x) => x === undefined).length;

const rising = Array.from({ length: 30 }, (_, i) => 100 + i);

describe('[PND-STUDYBOX] warm-up heads read as undefined, not NaN', () => {
  it('sma warms up length-preservingly', () => {
    const out = sma(bars(rising), { period: 5 });
    const v = cells(out, 'sma');
    expect(out.length).toBe(30);
    for (let i = 0; i < 4; i += 1) {
      expect(v[i], `bar ${i}`).toBeUndefined();
    }
    expect(v[4]).toBeCloseTo(102, 10);
    // No NaN may reach a user-visible column — a NaN here would mean the
    // gap marker leaked through `withColumn` instead of becoming a gap.
    expect(v.some((x) => typeof x === 'number' && Number.isNaN(x))).toBe(false);
    expect(nullCountOf(out, 'sma')).toBe(4);
  });

  it('ema warms up length-preservingly', () => {
    const out = ema(bars(rising), { period: 5 });
    const v = cells(out, 'ema');
    expect(v.slice(0, 4).every((x) => x === undefined)).toBe(true);
    expect(typeof v[4]).toBe('number');
  });

  it('bollinger warms up on all three bands', () => {
    const out = bollinger(bars(rising), { period: 5 });
    for (const name of ['bbMiddle', 'bbUpper', 'bbLower']) {
      const v = cells(out as never, name);
      expect(
        v.slice(0, 4).every((x) => x === undefined),
        name,
      ).toBe(true);
      expect(typeof v[4], name).toBe('number');
      expect(nullCountOf(out, name), name).toBe(4);
    }
  });

  it('zScore warms up', () => {
    const out = zScore(bars(rising), { period: 5 });
    const v = cells(out, 'zscore');
    expect(v.slice(0, 4).every((x) => x === undefined)).toBe(true);
    expect(typeof v[4]).toBe('number');
  });

  it('envelope warms up on all three lines', () => {
    const out = envelope(bars(rising), { period: 5 });
    for (const name of ['envMiddle', 'envUpper', 'envLower']) {
      const v = cells(out as never, name);
      expect(
        v.slice(0, 4).every((x) => x === undefined),
        name,
      ).toBe(true);
      expect(typeof v[4], name).toBe('number');
    }
  });

  it('percentChange has no predecessor for the first bar', () => {
    const out = percentChange(bars(rising), {});
    const v = cells(out, 'pctChange');
    expect(v[0]).toBeUndefined();
    expect(v[1]).toBeCloseTo(1, 10);
  });

  it('rsi warms up without leaking NaN', () => {
    // rsi is the first study to hand-roll its own NaN derivation (the
    // gain/loss split), so it is the most likely to leak one into a
    // user-visible column rather than reading back as `undefined`.
    const out = rsi(bars(rising), { period: 5 });
    const v = cells(out, 'rsi');
    expect(v.slice(0, 5).every((x) => x === undefined)).toBe(true);
    expect(typeof v[5]).toBe('number');
    expect(v.every((x) => !Number.isNaN(x as number))).toBe(true);
  });
});

describe('[PND-STUDYBOX] the study-specific guards still produce missing', () => {
  // A flat window has σ = 0, which has no meaningful band or z-score. These
  // are the only per-cell guards that survived the NaN-propagation
  // simplification, so they are the ones worth pinning.
  const flat = Array.from({ length: 10 }, () => 42);

  it('rsi emits missing on a flat window (0/0 has no relative strength)', () => {
    // And the value is `undefined`, not NaN — the deliberate delta from
    // TA-Lib, which reports 0 here and so cannot distinguish "no movement"
    // from "every bar fell".
    const out = rsi(bars(flat), { period: 3 });
    const v = cells(out, 'rsi');
    expect(v[3]).toBeUndefined();
    expect(v[9]).toBeUndefined();
    expect(v.every((x) => !Number.isNaN(x as number))).toBe(true);
  });

  it('bollinger emits missing bands where σ = 0', () => {
    const out = bollinger(bars(flat), { period: 5 });
    const upper = cells(out, 'bbUpper');
    const middle = cells(out, 'bbMiddle');
    // The centre line is defined on a flat window; the bands are not.
    expect(middle[9]).toBeCloseTo(42, 10);
    expect(upper[9]).toBeUndefined();
    expect(nullCountOf(out, 'bbUpper')).toBe(10);
  });

  it('zScore emits missing where σ = 0', () => {
    const out = zScore(bars(flat), { period: 5 });
    expect(cells(out, 'zscore')[9]).toBeUndefined();
    expect(nullCountOf(out, 'zscore')).toBe(10);
  });

  it('percentChange emits missing where the base is zero', () => {
    const out = percentChange(bars([0, 5, 0, 5]), {});
    const v = cells(out, 'pctChange');
    expect(v[0]).toBeUndefined(); // no predecessor
    expect(v[1]).toBeUndefined(); // base 0
    expect(v[2]).toBeCloseTo(-100, 10);
    expect(v[3]).toBeUndefined(); // base 0
  });
});

describe('[PND-STUDYBOX] gaps in the source propagate', () => {
  const gappySchema = [
    { name: 'time', kind: 'time' },
    { name: 'close', kind: 'number', required: false },
  ] as const;

  const gappy = new TimeSeries({
    name: 'bars',
    schema: gappySchema,
    rows: Array.from({ length: 20 }, (_, i) => [
      i * MINUTE,
      i === 10 ? undefined : 100 + i,
    ]) as never,
  });

  it('a missing source bar does not become a spurious number', () => {
    const out = sma(gappy, { period: 4 });
    const v = cells(out, 'sma');
    // A count window still advances over the gap, so the study stays
    // length-preserving; what matters is that no cell reads back NaN.
    expect(v.length).toBe(20);
    expect(v.some((x) => typeof x === 'number' && Number.isNaN(x))).toBe(false);
  });

  it('studies compose — one study over another’s output', () => {
    const stacked = sma(sma(bars(rising), { period: 5, output: 'sma5' }), {
      period: 3,
      column: 'sma5' as never,
      output: 'smaOfSma',
    });
    const v = cells(stacked, 'smaOfSma');
    // Warm-up is 4 bars, not 6. The outer window is a **count of rows**, not
    // of defined values, so once its span reaches the inner study's first
    // defined bar it has met `minSamples` and averages the one contributor
    // it can see. Verified byte-identical to the pre-[PND-STUDYBOX] build,
    // so this is the existing contract rather than something the typed
    // rewrite introduced.
    expect(v.slice(0, 4).every((x) => x === undefined)).toBe(true);
    expect(v[4]).toBeCloseTo(102, 10);
    expect(v[5]).toBeCloseTo(102.5, 10);
    expect(v.some((x) => typeof x === 'number' && Number.isNaN(x))).toBe(false);
  });
});
