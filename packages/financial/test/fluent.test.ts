/**
 * The opt-in fluent surface: `import '@pond-ts/financial/fluent'` mounts the
 * studies as chainable `TimeSeries` methods. This file imports it for its side
 * effect, so `series.sma().ema().bollinger()` both type-checks (the `declare
 * module` merge) and runs (the prototype mount). The methods delegate to the
 * standalone functions, so values must match them exactly.
 */
import { describe, it, expect } from 'vitest';
import { TimeSeries } from 'pond-ts';
import { sma, ema, bollinger } from '../src/index.js';
import '../src/fluent.js';

const closeSchema = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
] as const;

function bars() {
  const closes = [10, 11, 12, 13, 14, 15, 16, 17];
  return new TimeSeries({
    name: 'bars',
    schema: closeSchema,
    rows: closes.map((c, i) => [i, c]) as Array<[number, number]>,
  });
}

function col(s: unknown, name: string): Array<number | undefined> {
  const events = (
    s as { events: ReadonlyArray<{ data(): Record<string, unknown> }> }
  ).events;
  return events.map((e) => {
    const v = e.data()[name];
    return typeof v === 'number' ? v : undefined;
  });
}

describe('fluent studies (opt-in prototype augmentation)', () => {
  it('chains metric.sma().ema().bollinger() into one series', () => {
    const study = bars()
      .sma({ period: 3 })
      .ema({ period: 3 })
      .bollinger({ period: 3, stdDev: 2 });
    const last = study.events.at(-1)!.data();
    expect(typeof last.sma).toBe('number');
    expect(typeof last.ema).toBe('number');
    expect(typeof last.bbMiddle).toBe('number');
    expect(typeof last.bbUpper).toBe('number');
    expect(typeof last.bbLower).toBe('number');
  });

  it('interleaves with core methods in the same chain', () => {
    // core `.smooth` then the augmented `.sma`, one chain.
    const study = bars()
      .smooth('close', 'ema', { alpha: 0.5, output: 'e' }) // core method
      .sma({ period: 3, column: 'e', output: 'ma' }); // fluent study
    expect(col(study, 'e')).toHaveLength(8);
    expect(typeof study.events.at(-1)!.data().ma).toBe('number');
    // plain fluent value check: sma(3) at index 4 = avg(close 12,13,14) = 13.
    expect(col(bars().sma({ period: 3, output: 'ma' }), 'ma')[4]).toBe(13);
  });

  it('is exactly the standalone functions bound to the series', () => {
    const fluent = bars()
      .sma({ period: 3 })
      .ema({ period: 4, output: 'e' })
      .bollinger({ period: 3 });
    const functional = bollinger(
      ema(sma(bars(), { period: 3 }), { period: 4, output: 'e' }),
      { period: 3 },
    );
    for (const c of ['sma', 'e', 'bbMiddle', 'bbUpper', 'bbLower']) {
      expect(col(fluent, c)).toEqual(col(functional, c));
    }
  });
});
