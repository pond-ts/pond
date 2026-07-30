// Setup module for the HostPool tests — imported by BOTH isolates.
//
// Plain `.mjs` importing `dist/`, not the TS source, because a worker is
// a real Node thread: it cannot load TypeScript. That is also why the
// pool suite runs against the built output (see the note in
// `pool.test.ts`).
import { TimeSeries } from 'pond-ts';
import { createRegistry, int, num } from '../../dist/index.js';

const values = (ctx, role) => {
  const col = ctx.series.column(ctx.inputs[role]);
  const out = new Array(col.length);
  for (let i = 0; i < col.length; i += 1) out[i] = col.at(i);
  return out;
};

export default function setup(options) {
  const rows = Number(options?.rows ?? 64);
  const registry = createRegistry()
    .define({
      name: 'sma',
      family: 'trend',
      summary: 'Rolling mean.',
      params: { period: int({ min: 2, default: 3 }) },
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => {
        const v = values(ctx, 'source');
        const period = ctx.params.period;
        return v.map((_, i) => {
          if (i < period - 1) return undefined;
          let s = 0;
          for (let k = i - period + 1; k <= i; k += 1) s += v[k];
          return s / period;
        });
      },
    })
    .define({
      name: 'band',
      family: 'bands',
      summary: 'Mid, plus and minus a width.',
      params: { width: num({ default: 1 }) },
      inputs: [{ role: 'source' }],
      outputs: [
        { id: 'Upper', unit: 'inherit' },
        { id: 'Middle', unit: 'inherit' },
        { id: 'Lower', unit: 'inherit' },
      ],
      run: (ctx) => {
        const v = values(ctx, 'source');
        const w = ctx.params.width;
        return [
          v.map((x) => (x === undefined ? undefined : x + w)),
          v,
          v.map((x) => (x === undefined ? undefined : x - w)),
        ];
      },
    })
    .define({
      name: 'boom',
      family: 'test',
      summary: 'Always throws — the error path.',
      params: {},
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: () => {
        throw new Error('boom: this op always fails');
      },
    });

  return { registry, datasets: { px: makeSeries(rows) } };
}

export function makeSeries(rows) {
  return new TimeSeries({
    name: 'px',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'px', kind: 'number' },
    ],
    rows: Array.from({ length: rows }, (_, i) => [
      i * 1000,
      100 + Math.sin(i / 5) * 10,
    ]),
  });
}
