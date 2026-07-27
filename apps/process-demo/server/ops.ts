/**
 * The demo's op vocabulary — and, for [PND-PROCREG], the thing under test.
 *
 * M2 asks whether `registry.toJsonSchema()` plus `registry.describe()` is
 * enough for an agent to compose a valid plan with no prose hand-holding.
 * That question is only interesting against a vocabulary with real edges,
 * so this set deliberately includes:
 *
 * - a **multi-output** op (`bollinger` → three columns under one spec),
 * - a **typed input** (`annualise` demands a `'variance'` input, which the
 *   JSON Schema projection does not express — see the note below),
 * - ops whose output units differ from their input (`roc`, `zscore`).
 *
 * The typed input is the sharp one. `toJsonSchema()` projects params but
 * not `InputDef.unit`, so an agent reading only the schema cannot know
 * `annualise` refuses a raw price. Whether it recovers from the resulting
 * `skipped` reason is a friction note, not a bug to design around.
 */

import {
  createRegistry,
  int,
  num,
  type OpContext,
  type Registry,
} from '@pond-ts/process';
import type { Column } from 'pond-ts';

/** Reads an input role into a dense array, `undefined` for missing cells. */
function dense(ctx: OpContext, role: string): (number | undefined)[] {
  const col = ctx.series.column(ctx.inputs[role]!) as unknown as Column;
  const out = new Array<number | undefined>(col.length);
  for (let i = 0; i < col.length; i += 1) {
    const v = col.read(i);
    out[i] = typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }
  return out;
}

/** Rolling window fold. Emits `undefined` until the window is full. */
function rolling(
  v: readonly (number | undefined)[],
  period: number,
  fn: (window: number[]) => number,
): (number | undefined)[] {
  const out = new Array<number | undefined>(v.length).fill(undefined);
  for (let i = period - 1; i < v.length; i += 1) {
    const w: number[] = [];
    for (let k = i - period + 1; k <= i; k += 1) {
      const x = v[k];
      if (x === undefined) break;
      w.push(x);
    }
    if (w.length === period) out[i] = fn(w);
  }
  return out;
}

const mean = (w: readonly number[]): number =>
  w.reduce((a, b) => a + b, 0) / w.length;

/** Sample variance — n-1, matching the corpus convention. */
function variance(w: readonly number[]): number {
  const m = mean(w);
  return w.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, w.length - 1);
}

export function demoRegistry(): Registry {
  return createRegistry()
    .define({
      name: 'sma',
      family: 'trend',
      summary:
        'Simple moving average — the unweighted mean of the last `period` values.',
      params: { period: int({ min: 2, max: 5000, default: 20 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      label: (p, inputs) => `SMA(${p['period']}) of ${inputs}`,
      run: (ctx) =>
        rolling(dense(ctx, 'source'), ctx.params['period'] as number, mean),
    })
    .define({
      name: 'ema',
      family: 'trend',
      summary:
        'Exponential moving average — weights recent values more heavily, so it turns faster than an SMA of the same period.',
      params: { period: int({ min: 2, max: 5000, default: 20 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      label: (p, inputs) => `EMA(${p['period']}) of ${inputs}`,
      run: (ctx) => {
        const v = dense(ctx, 'source');
        const period = ctx.params['period'] as number;
        const k = 2 / (period + 1);
        const out = new Array<number | undefined>(v.length).fill(undefined);
        let prev: number | undefined;
        for (let i = 0; i < v.length; i += 1) {
          const x = v[i];
          if (x === undefined) continue;
          prev = prev === undefined ? x : x * k + prev * (1 - k);
          // Withhold until the average has seen a full period, so an EMA
          // and an SMA of the same period start on the same row.
          if (i >= period - 1) out[i] = prev;
        }
        return out;
      },
    })
    .define({
      name: 'delta',
      family: 'momentum',
      summary:
        'First difference — each value minus the one before it, in the input’s own units.',
      params: {},
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      label: (_p, inputs) => `Δ${inputs}`,
      run: (ctx) => {
        const v = dense(ctx, 'source');
        const out = new Array<number | undefined>(v.length).fill(undefined);
        for (let i = 1; i < v.length; i += 1) {
          const a = v[i - 1];
          const b = v[i];
          if (a !== undefined && b !== undefined) out[i] = b - a;
        }
        return out;
      },
    })
    .define({
      name: 'roc',
      family: 'momentum',
      summary:
        'Rate of change — percentage move over `period` bars. Output is a percentage regardless of the input’s units.',
      params: { period: int({ min: 1, max: 5000, default: 12 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: '%' }],
      label: (p, inputs) => `ROC(${p['period']}) of ${inputs}`,
      run: (ctx) => {
        const v = dense(ctx, 'source');
        const period = ctx.params['period'] as number;
        const out = new Array<number | undefined>(v.length).fill(undefined);
        for (let i = period; i < v.length; i += 1) {
          const a = v[i - period];
          const b = v[i];
          if (a !== undefined && b !== undefined && a !== 0) {
            out[i] = ((b - a) / a) * 100;
          }
        }
        return out;
      },
    })
    .define({
      name: 'rsi',
      family: 'momentum',
      summary:
        'Relative strength index — a 0–100 oscillator; conventionally above 70 is overbought and below 30 oversold.',
      params: { period: int({ min: 2, max: 1000, default: 14 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'index' }],
      label: (p, inputs) => `RSI(${p['period']}) of ${inputs}`,
      run: (ctx) => {
        const v = dense(ctx, 'source');
        const period = ctx.params['period'] as number;
        const out = new Array<number | undefined>(v.length).fill(undefined);
        let avgGain = 0;
        let avgLoss = 0;
        for (let i = 1; i < v.length; i += 1) {
          const a = v[i - 1];
          const b = v[i];
          if (a === undefined || b === undefined) continue;
          const change = b - a;
          const gain = Math.max(0, change);
          const loss = Math.max(0, -change);
          if (i <= period) {
            avgGain += gain / period;
            avgLoss += loss / period;
            if (i < period) continue;
          } else {
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
          }
          out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        }
        return out;
      },
    })
    .define({
      name: 'stddev',
      family: 'volatility',
      summary:
        'Rolling sample standard deviation over `period` bars, in the input’s own units.',
      params: { period: int({ min: 2, max: 5000, default: 20 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      label: (p, inputs) => `σ(${p['period']}) of ${inputs}`,
      run: (ctx) =>
        rolling(dense(ctx, 'source'), ctx.params['period'] as number, (w) =>
          Math.sqrt(variance(w)),
        ),
    })
    .define({
      name: 'variance',
      family: 'volatility',
      summary:
        'Rolling sample variance over `period` bars. Produces a `variance`-unit series, which is what `annualise` consumes.',
      params: { period: int({ min: 2, max: 5000, default: 20 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'variance' }],
      label: (p, inputs) => `Var(${p['period']}) of ${inputs}`,
      run: (ctx) =>
        rolling(dense(ctx, 'source'), ctx.params['period'] as number, variance),
    })
    .define({
      name: 'annualise',
      family: 'volatility',
      summary:
        'Annualised volatility, in percent per year. Requires a `variance`-unit input, and that variance must be of a percentage series — so the whole chain is annualise(variance(roc(px))), not annualise(variance(px)).',
      params: { barsPerYear: int({ min: 1, default: 105_120 }) },
      // The typed input the schema projection cannot express.
      inputs: [{ role: 'source', unit: 'variance' }],
      outputs: [{ id: '', unit: '%/yr' }],
      label: (_p, inputs) => `annualised ${inputs}`,
      run: (ctx) => {
        const v = dense(ctx, 'source');
        const scale = ctx.params['barsPerYear'] as number;
        // Input is variance of percentages, so the root is already in
        // percent — no further scaling.
        return v.map((x) =>
          x === undefined ? undefined : Math.sqrt(x * scale),
        );
      },
    })
    .define({
      name: 'zscore',
      family: 'normalisation',
      summary:
        'Rolling z-score — how many standard deviations the latest value sits from its own `period`-bar mean.',
      params: { period: int({ min: 2, max: 5000, default: 20 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'σ' }],
      label: (p, inputs) => `z(${p['period']}) of ${inputs}`,
      run: (ctx) =>
        rolling(dense(ctx, 'source'), ctx.params['period'] as number, (w) => {
          const sd = Math.sqrt(variance(w));
          return sd === 0 ? 0 : (w[w.length - 1]! - mean(w)) / sd;
        }),
    })
    .define({
      name: 'bollinger',
      family: 'bands',
      summary:
        'Bollinger bands — an SMA with a ±`stdDev`σ envelope. One spec, three columns (Upper, Middle, Lower).',
      params: {
        period: int({ min: 2, max: 5000, default: 20 }),
        stdDev: num({ min: 0.1, max: 5, default: 2 }),
      },
      inputs: [{ role: 'source' }],
      outputs: [
        { id: 'Upper', unit: 'inherit' },
        { id: 'Middle', unit: 'inherit' },
        { id: 'Lower', unit: 'inherit' },
      ],
      label: (p, inputs) =>
        `Bollinger(${p['period']}, ${p['stdDev']}σ) of ${inputs}`,
      run: (ctx) => {
        const v = dense(ctx, 'source');
        const period = ctx.params['period'] as number;
        const mult = ctx.params['stdDev'] as number;
        const mid = rolling(v, period, mean);
        const sd = rolling(v, period, (w) => Math.sqrt(variance(w)));
        const band = (sign: number) =>
          mid.map((m, i) =>
            m === undefined || sd[i] === undefined
              ? undefined
              : m + sign * mult * sd[i]!,
          );
        return [band(1), mid, band(-1)];
      },
    })
    .define({
      name: 'scale',
      family: 'transform',
      summary: 'Multiplies every value by `by`, preserving units.',
      params: { by: num({ default: 2 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      label: (p, inputs) => `${inputs} × ${p['by']}`,
      run: (ctx) =>
        dense(ctx, 'source').map((x) =>
          x === undefined ? undefined : x * (ctx.params['by'] as number),
        ),
    });
}
