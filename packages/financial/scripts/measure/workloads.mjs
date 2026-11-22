/**
 * The two workloads the TypeScript-vs-Rust process measurement runs, shared
 * by `one.mjs` (TypeScript) and, as the JSON `run.mjs` writes, by
 * `crates/pond-process/examples/measure.rs` (Rust). The data is made from
 * the same 32-bit generator on both sides (mulberry32, as `makeBars` in
 * `packages/process/scripts/fixtures`), so both get identical numbers and
 * the facts they answer must match exactly.
 *
 * - **market**: daily OHLCV bars, an agent's question about a ticker:
 *   eight studies, returns, drawdown and the facts an assistant reads.
 * - **telemetry**: one-second samples of five service metrics, the
 *   questions a dashboard asks: smoothing, outliers, a p99, how often
 *   latency breached, and chart-sized shapes of each line.
 */

const DAY = 86_400_000;
const SECOND = 1_000;

function generator(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Column arrays for `market`: time, open, high, low, close, volume. */
export function marketColumns(n) {
  const rnd = generator(0x5eed);
  const cols = {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
  let price = 100;
  for (let i = 0; i < n; i += 1) {
    const drift = (rnd() - 0.5) * 0.04 * price;
    const o = price;
    const c = Math.max(1, price + drift);
    cols.time[i] = i * DAY;
    cols.open[i] = o;
    cols.close[i] = c;
    cols.high[i] = Math.max(o, c) + rnd() * 0.01 * price;
    cols.low[i] = Math.min(o, c) - rnd() * 0.01 * price;
    cols.volume[i] = Math.floor(rnd() * 1_000_000);
    price = c;
  }
  return cols;
}

/** Column arrays for `telemetry`: time, cpu, mem, latency, requests, errors. */
export function telemetryColumns(n) {
  const rnd = generator(0x7e1e);
  const cols = {
    time: new Float64Array(n),
    cpu: new Float64Array(n),
    mem: new Float64Array(n),
    latency: new Float64Array(n),
    requests: new Float64Array(n),
    errors: new Float64Array(n),
  };
  let cpu = 40;
  let mem = 60;
  for (let i = 0; i < n; i += 1) {
    cpu = Math.min(100, Math.max(0, cpu + (rnd() - 0.5) * 4));
    mem = Math.min(100, Math.max(0, mem + (rnd() - 0.5) * 0.5));
    const spike = rnd() < 0.001 ? 400 * rnd() : 0;
    cols.time[i] = i * SECOND;
    cols.cpu[i] = cpu;
    cols.mem[i] = mem;
    cols.latency[i] = 20 + rnd() * 10 + spike;
    cols.requests[i] = 100 + Math.floor(rnd() * 900);
    cols.errors[i] = Math.floor(rnd() * rnd() * 10);
  }
  return cols;
}

export const COLUMNS = { market: marketColumns, telemetry: telemetryColumns };

/** The request each workload sends, in the slot form an agent writes. */
export const REQUESTS = {
  market: {
    from: 'd',
    nodes: {
      sma20: { op: 'sma', in: ['close'], params: { period: 20 } },
      sma200: { op: 'sma', in: ['close'], params: { period: 200 } },
      ema50: { op: 'ema', in: ['close'], params: { period: 50 } },
      rsi: { op: 'rsi', in: ['close'] },
      bb: { op: 'bollinger', in: ['close'] },
      macd: { op: 'macd', in: ['close'] },
      atr: { op: 'atr', in: ['high', 'low', 'close'] },
      hv: { op: 'historicalVolatility', in: ['close'] },
      prev: { op: 'shift', in: ['close'] },
      ratio: { op: 'divide', in: ['close', 'prev'] },
      lr: { op: 'log', in: ['ratio'] },
      peak: { op: 'cumulative', in: ['close'], params: { how: 'max' } },
      dd: { op: 'subtract', in: ['close', 'peak'] },
      above: { op: 'compareColumns', in: ['close', 'sma200'] },
      hot: { op: 'compare', in: ['rsi'], params: { value: 70 } },
      lastClose: { op: 'last', in: ['close'] },
      lastRsi: { op: 'last', in: ['rsi'] },
      lastBand: { op: 'last', in: ['bb#Upper'] },
      lastMacd: { op: 'last', in: ['macd#Hist'] },
      lastAtr: { op: 'last', in: ['atr'] },
      lastHv: { op: 'last', in: ['hv'] },
      range: { op: 'extremes', in: ['close'] },
      worstDd: { op: 'extremes', in: ['dd'] },
      rank: { op: 'percentileRank', in: ['rsi'] },
      lrStdev: { op: 'stdev', in: ['lr'] },
      shareAbove: { op: 'shareTrue', in: ['above'] },
      crosses: { op: 'events', in: ['above'], params: { limit: 10 } },
      hotShare: { op: 'shareTrue', in: ['hot'] },
      chart: { op: 'shape', in: ['close'], params: { points: 400 } },
      chartEma: { op: 'shape', in: ['ema50'], params: { points: 400 } },
    },
    outputs: Object.fromEntries(
      [
        'lastClose',
        'lastRsi',
        'lastBand',
        'lastMacd',
        'lastAtr',
        'lastHv',
        'range',
        'worstDd',
        'rank',
        'lrStdev',
        'shareAbove',
        'crosses',
        'hotShare',
        'chart',
        'chartEma',
      ].map((k) => [k, { on: k }]),
    ),
    onError: 'collect',
    assemble: false,
  },
  telemetry: {
    from: 'd',
    nodes: {
      cpu1m: { op: 'sma', in: ['cpu'], params: { period: 60 } },
      cpu5m: { op: 'ema', in: ['cpu'], params: { period: 300 } },
      lat1m: { op: 'sma', in: ['latency'], params: { period: 60 } },
      latZ: { op: 'zScore', in: ['latency'], params: { period: 300 } },
      latBand: { op: 'bollinger', in: ['latency'], params: { period: 300 } },
      errRate: { op: 'divide', in: ['errors', 'requests'] },
      errPct: { op: 'scale', in: ['errRate'], params: { factor: 100 } },
      slow: { op: 'compare', in: ['latency'], params: { value: 100 } },
      outlier: { op: 'compare', in: ['latZ'], params: { value: 4 } },
      busy: { op: 'compare', in: ['cpu1m'], params: { value: 80 } },
      both: { op: 'and', in: ['slow', 'busy'] },
      p99: { op: 'percentile', in: ['latency'], params: { q: 99 } },
      p50: { op: 'percentile', in: ['latency'], params: { q: 50 } },
      meanLat: { op: 'mean', in: ['latency'] },
      cpuRange: { op: 'extremes', in: ['cpu'] },
      memRange: { op: 'extremes', in: ['mem'] },
      errTotal: { op: 'sum', in: ['errors'] },
      reqTotal: { op: 'sum', in: ['requests'] },
      slowShare: { op: 'shareTrue', in: ['slow'] },
      outliers: { op: 'events', in: ['outlier'], params: { limit: 20 } },
      bothShare: { op: 'shareTrue', in: ['both'] },
      lastCpu: { op: 'last', in: ['cpu5m'] },
      errChange: { op: 'change', in: ['errPct'] },
      chartCpu: {
        op: 'shape',
        in: ['cpu1m'],
        params: { points: 400, how: 'minMaxFirstLast' },
      },
      chartMem: {
        op: 'shape',
        in: ['mem'],
        params: { points: 400, how: 'mean' },
      },
      chartLat: {
        op: 'shape',
        in: ['lat1m'],
        params: { points: 400, how: 'minMax' },
      },
      chartBand: {
        op: 'shape',
        in: ['latBand#Upper'],
        params: { points: 400 },
      },
    },
    outputs: Object.fromEntries(
      [
        'p99',
        'p50',
        'meanLat',
        'cpuRange',
        'memRange',
        'errTotal',
        'reqTotal',
        'slowShare',
        'outliers',
        'bothShare',
        'lastCpu',
        'errChange',
        'chartCpu',
        'chartMem',
        'chartLat',
        'chartBand',
      ].map((k) => [k, { on: k }]),
    ),
    onError: 'collect',
    assemble: false,
  },
};
