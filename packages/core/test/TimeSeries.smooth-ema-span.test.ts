/**
 * Tests for the EMA `span` rate convention and the length-preserving
 * `minSamples` warm-up added for the financial studies layer (#449 item 2 + 3).
 * `span` is the industry parameterization (`α = 2/(span+1)`); `minSamples`
 * masks the warm-up rows as `undefined` while keeping length (unlike the
 * existing length-changing `warmup`), mirroring `rolling`'s `minSamples`.
 */
import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

/** `n` rows, value = row index. */
function series(n = 5) {
  return new TimeSeries({
    name: 'v',
    schema,
    rows: Array.from({ length: n }, (_, i) => [i * 1000, i]) as Array<
      [number, number]
    >,
  });
}

describe('smooth ema — span rate', () => {
  it('span maps to alpha = 2/(span+1) (span 3 ≡ alpha 0.5)', () => {
    const bySpan = series(6).smooth('v', 'ema', { span: 3 });
    const byAlpha = series(6).smooth('v', 'ema', { alpha: 0.5 });
    expect(bySpan.length).toBe(6);
    for (let i = 0; i < 6; i += 1) {
      expect(bySpan.at(i)!.get('v')).toBeCloseTo(
        byAlpha.at(i)!.get('v') as number,
        10,
      );
    }
  });

  it('span 1 → alpha 1 → passes the source through unchanged', () => {
    const r = series(4).smooth('v', 'ema', { span: 1 });
    expect([0, 1, 2, 3].map((i) => r.at(i)!.get('v'))).toEqual([0, 1, 2, 3]);
  });

  it('rejects giving both alpha and span, or neither', () => {
    expect(() => series().smooth('v', 'ema', { alpha: 0.5, span: 3 })).toThrow(
      /exactly one of alpha or span/,
    );
    // @ts-expect-error — ema requires alpha or span
    expect(() => series().smooth('v', 'ema', {})).toThrow(
      /exactly one of alpha or span/,
    );
  });

  it('rejects span < 1 or non-finite', () => {
    expect(() => series().smooth('v', 'ema', { span: 0 })).toThrow(
      /span to be a finite number >= 1/,
    );
    expect(() => series().smooth('v', 'ema', { span: 0.5 })).toThrow(
      /span to be a finite number >= 1/,
    );
    expect(() =>
      series().smooth('v', 'ema', { span: Number.POSITIVE_INFINITY }),
    ).toThrow(/span to be a finite number >= 1/);
  });
});

describe('smooth ema — minSamples (length-preserving warm-up)', () => {
  it('masks the first minSamples-1 rows as undefined but keeps length', () => {
    const full = series(5).smooth('v', 'ema', { alpha: 0.5 });
    const gated = series(5).smooth('v', 'ema', { alpha: 0.5, minSamples: 3 });
    expect(gated.length).toBe(5); // length preserved (unlike `warmup`)
    expect(gated.at(0)!.get('v')).toBeUndefined();
    expect(gated.at(1)!.get('v')).toBeUndefined();
    // From the threshold on, the kept values equal the ungated series — the EMA
    // converged on the real values underneath; only the emitted head was masked.
    for (let i = 2; i < 5; i += 1) {
      expect(gated.at(i)!.get('v')).toBeCloseTo(
        full.at(i)!.get('v') as number,
        10,
      );
    }
  });

  it('composes with span (the study default: minSamples = span)', () => {
    const r = series(6).smooth('v', 'ema', { span: 3, minSamples: 3 });
    expect(r.length).toBe(6);
    expect(r.at(0)!.get('v')).toBeUndefined();
    expect(r.at(2)!.get('v')).toBeDefined();
  });

  it('rejects a non-integer or negative minSamples', () => {
    expect(() =>
      series().smooth('v', 'ema', { alpha: 0.5, minSamples: 2.5 }),
    ).toThrow(/minSamples to be a non-negative integer/);
    expect(() =>
      series().smooth('v', 'ema', { alpha: 0.5, minSamples: -1 }),
    ).toThrow(/minSamples to be a non-negative integer/);
  });

  it('minSamples: 0 is a no-op (matches no-gate behavior)', () => {
    const none = series(4).smooth('v', 'ema', { alpha: 0.5 });
    const zero = series(4).smooth('v', 'ema', { alpha: 0.5, minSamples: 0 });
    for (let i = 0; i < 4; i += 1) {
      expect(zero.at(i)!.get('v')).toBe(none.at(i)!.get('v'));
    }
  });
});
