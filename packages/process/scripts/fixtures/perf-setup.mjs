// Setup module for the HostPool throughput benchmark — imported by the
// main thread AND by every worker, which is the whole reason a registry
// is named by module rather than passed as a value.
import { TimeSeries } from 'pond-ts';
import { createRegistry, int } from '../../dist/index.js';

/** A rolling mean written plainly — the cost is the O(n) walk, not the op. */
function sma(ctx) {
  const col = ctx.series.column(ctx.inputs['source']);
  const period = ctx.params.period;
  const n = col.length;
  const src = col.toFloat64Array();
  const out = new Array(n);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += src[i];
    if (i >= period) sum -= src[i - period];
    out[i] = i >= period - 1 ? sum / period : undefined;
  }
  return out;
}

export default function setup(options) {
  const rows = Number(options?.rows ?? 200_000);
  const registry = createRegistry().define({
    name: 'sma',
    family: 'trend',
    summary: 'Rolling mean.',
    params: { period: int({ min: 2, default: 20 }) },
    inputs: [{ role: 'source' }],
    outputs: [{ id: '', unit: 'inherit' }],
    run: sma,
  });
  return { registry, datasets: { px: makeSeries(rows) } };
}

export function makeSeries(rows) {
  const time = new Float64Array(rows);
  const px = new Float64Array(rows);
  let price = 100;
  let seed = 0x5eed;
  for (let i = 0; i < rows; i += 1) {
    seed = (seed + 0x6d2b79f5) >>> 0;
    const r = ((seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    price = Math.max(1, price + (r - 0.5) * 0.4);
    time[i] = i * 60_000;
    px[i] = price;
  }
  return TimeSeries.fromColumns({
    name: 'px',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'px', kind: 'number' },
    ],
    columns: { time, px },
  });
}
