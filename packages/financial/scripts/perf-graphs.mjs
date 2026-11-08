// The finance catalogue's graphs, run as an MCP server would run them, on a
// one-million-bar series.
//
// `docs/notes/finance-process-graphs-2026-11.md` lists 48 questions an
// agent asks a finance MCP server. 22 of them can be answered with what
// ships today: the study bridge (`@pond-ts/financial/process`), the basic
// steps (`BASIC_OPS`) and the summary folds (`SUMMARY_FOLDS`, plus the
// four standard folds). Each is written here as the slot request an agent
// would send, and timed through `host.run` — the whole answer, not one
// node.
//
// Per graph it reports:
//   first — the very first request in a fresh process (nothing compiled
//           yet by V8: what the first agent after a server restart waits)
//   warm  — median of RUNS requests after WARMUP passes over every graph,
//           each on a fresh host so no node is served from cache
//   nodes — the sum of the host's own per-node timings for one warm run;
//           `warm - nodes` is what the plan layer itself costs (compile,
//           ids, adding columns, building facts)
//   slow  — the slowest node in that run, and its time
//
// Then the same 22 graphs as one request (an agent asking several
// questions at once), where shared nodes (`rsi(14)`, `percentChange(1)`,
// …) are computed once.
//
// Run:  node packages/financial/scripts/perf-graphs.mjs
//       ROWS=100000 RUNS=7 WARMUP=5 node packages/financial/scripts/perf-graphs.mjs
import { performance } from 'node:perf_hooks';
import {
  BASIC_OPS,
  SUMMARY_FOLDS,
  createHost,
  createRegistry,
} from '../../process/dist/index.js';
import { studyOps } from '../dist/process/index.js';
import { makeBars } from '../../process/scripts/fixtures/studies-setup.mjs';

const ROWS = Number(process.env.ROWS ?? 1_000_000);
const RUNS = Number(process.env.RUNS ?? 7);
const WARMUP = Number(process.env.WARMUP ?? 5);
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const ms = (x) => Number(x.toFixed(1));

// One-minute bars; one 24-hour UTC session per day, so the session studies
// (session VWAP, pivot points) have ~695 sessions to work through.
const bars = makeBars(ROWS);
const DAY = 86_400_000;
const days = Math.ceil((ROWS * 60_000) / DAY);
const sessions = Array.from({ length: days }, (_, k) => ({
  date: new Date(k * DAY).toISOString().slice(0, 10),
  open: k * DAY,
  close: (k + 1) * DAY,
}));

let registry = createRegistry();
for (const def of [...studyOps({ sessions }), ...BASIC_OPS, ...SUMMARY_FOLDS])
  registry = registry.define(def);

// Each graph: catalogue number, the question, its slot nodes, its outputs.
// Outputs name the slot a fact is read from.
const out = (...slots) => Object.fromEntries(slots.map((s) => [s, { on: s }]));

const GRAPHS = [
  {
    n: 1,
    q: '14-day RSI now; overbought?',
    nodes: {
      rsi: { op: 'rsi', params: { period: 14 }, in: ['close'] },
      now: { op: 'last', in: ['rsi'] },
      rank: { op: 'percentileRank', in: ['rsi'] },
    },
    outputs: out('now', 'rank'),
  },
  {
    n: 2,
    q: 'Position inside Bollinger bands',
    nodes: {
      pb: { op: 'bollingerPercentB', in: ['close'] },
      now: { op: 'last', in: ['pb'] },
    },
    outputs: out('now'),
  },
  {
    n: 3,
    q: '% above 50 and 200 day averages',
    nodes: {
      s50: { op: 'sma', params: { period: 50 }, in: ['close'] },
      s200: { op: 'sma', params: { period: 200 }, in: ['close'] },
      r50: { op: 'divide', in: ['close', 's50'] },
      r200: { op: 'divide', in: ['close', 's200'] },
      p50: { op: 'scale', params: { factor: 100, offset: -100 }, in: ['r50'] },
      p200: {
        op: 'scale',
        params: { factor: 100, offset: -100 },
        in: ['r200'],
      },
      now50: { op: 'last', in: ['p50'] },
      now200: { op: 'last', in: ['p200'] },
    },
    outputs: out('now50', 'now200'),
  },
  {
    n: 4,
    q: 'MACD and side of signal',
    nodes: {
      m: { op: 'macd', in: ['close'] },
      line: { op: 'last', in: ['m#Line'] },
      signal: { op: 'last', in: ['m#Signal'] },
      hist: { op: 'last', in: ['m#Hist'] },
      above: { op: 'compareColumns', in: ['m#Line', 'm#Signal'] },
      side: { op: 'last', in: ['above'] },
    },
    outputs: out('line', 'signal', 'hist', 'side'),
  },
  {
    n: 5,
    q: 'Trend strength (ADX)',
    nodes: {
      dm: { op: 'directionalMovement', in: ['high', 'low', 'close'] },
      now: { op: 'last', in: ['dm#Adx'] },
      rank: { op: 'percentileRank', in: ['dm#Adx'] },
    },
    outputs: out('now', 'rank'),
  },
  {
    n: 6,
    q: 'ATR as % of price',
    nodes: {
      atr: { op: 'atr', in: ['high', 'low', 'close'] },
      r: { op: 'divide', in: ['atr', 'close'] },
      pct: { op: 'scale', params: { factor: 100 }, in: ['r'] },
      now: { op: 'last', in: ['pct'] },
    },
    outputs: out('now'),
  },
  {
    n: 8,
    q: 'How unusual is volume today',
    nodes: {
      z: { op: 'zScore', params: { period: 50 }, in: ['volume'] },
      now: { op: 'last', in: ['z'] },
      rank: { op: 'percentileRank', in: ['z'] },
    },
    outputs: out('now', 'rank'),
  },
  {
    n: 10,
    q: '30-day annualised volatility',
    nodes: {
      hv: { op: 'historicalVolatility', params: { period: 30 }, in: ['close'] },
      now: { op: 'last', in: ['hv'] },
    },
    outputs: out('now'),
  },
  {
    n: 13,
    q: 'Biggest one-bar drop and gain',
    nodes: {
      ret: { op: 'percentChange', in: ['close'] },
      ext: { op: 'extremes', in: ['ret'] },
    },
    outputs: out('ext'),
  },
  {
    n: 14,
    q: 'Rolling 252-bar return line',
    nodes: {
      ret: { op: 'percentChange', params: { periods: 252 }, in: ['close'] },
      line: { op: 'shape', params: { points: 52 }, in: ['ret'] },
    },
    outputs: out('line'),
  },
  {
    n: 15,
    q: 'Share of bars that closed up',
    nodes: {
      ret: { op: 'percentChange', in: ['close'] },
      up: { op: 'compare', params: { test: 'above', value: 0 }, in: ['ret'] },
      share: { op: 'shareTrue', in: ['up'] },
    },
    outputs: out('share'),
  },
  {
    n: 16,
    q: 'One-bar 95% VaR',
    nodes: {
      ret: { op: 'percentChange', in: ['close'] },
      var: { op: 'percentile', params: { q: 5 }, in: ['ret'] },
    },
    outputs: out('var'),
  },
  {
    n: 23,
    q: 'Last golden cross',
    nodes: {
      x: {
        op: 'movingAverageCross',
        params: { fastPeriod: 50, slowPeriod: 200 },
        in: ['close'],
      },
      flip: { op: 'lastChange', in: ['x'] },
    },
    outputs: out('flip'),
  },
  {
    n: 24,
    q: 'Every time RSI fell below 30',
    nodes: {
      rsi: { op: 'rsi', params: { period: 14 }, in: ['close'] },
      oversold: {
        op: 'compare',
        params: { test: 'below', value: 30 },
        in: ['rsi'],
      },
      when: { op: 'events', in: ['oversold'] },
    },
    outputs: out('when'),
  },
  {
    n: 26,
    q: 'Did close break its 20-bar high',
    nodes: {
      dc: { op: 'donchian', params: { period: 20 }, in: ['high', 'low'] },
      prev: { op: 'shift', params: { periods: 1 }, in: ['dc#Upper'] },
      brk: { op: 'compareColumns', in: ['close', 'prev'] },
      now: { op: 'last', in: ['brk'] },
    },
    outputs: out('now'),
  },
  {
    n: 27,
    q: 'SuperTrend direction and last flip',
    nodes: {
      st: { op: 'superTrend', in: ['high', 'low', 'close'] },
      dir: { op: 'last', in: ['st#Trend'] },
      flip: { op: 'lastChange', in: ['st#Trend'] },
    },
    outputs: out('dir', 'flip'),
  },
  {
    n: 28,
    q: 'Bars with 3x volume and a >3% drop',
    nodes: {
      avgv: { op: 'sma', params: { period: 50 }, in: ['volume'] },
      rv: { op: 'divide', in: ['volume', 'avgv'] },
      loud: {
        op: 'compare',
        params: { test: 'atLeast', value: 3 },
        in: ['rv'],
      },
      ret: { op: 'percentChange', in: ['close'] },
      drop: {
        op: 'compare',
        params: { test: 'below', value: -3 },
        in: ['ret'],
      },
      both: { op: 'and', in: ['loud', 'drop'] },
      when: { op: 'events', in: ['both'] },
    },
    outputs: out('when'),
  },
  {
    n: 29,
    q: 'Close vs session VWAP',
    nodes: {
      vw: { op: 'sessionVwap', in: ['high', 'low', 'close', 'volume'] },
      gap: { op: 'subtract', in: ['close', 'vw'] },
      now: { op: 'last', in: ['gap'] },
    },
    outputs: out('now'),
  },
  {
    n: 32,
    q: "Today's pivot points",
    nodes: {
      pp: { op: 'pivotPoints', in: ['high', 'low', 'close'] },
      ...Object.fromEntries(
        ['Pivot', 'R1', 'R2', 'R3', 'S1', 'S2', 'S3'].map((o) => [
          o.toLowerCase(),
          { op: 'last', in: [`pp#${o}`] },
        ]),
      ),
    },
    outputs: out('pivot', 'r1', 'r2', 'r3', 's1', 's2', 's3'),
  },
  {
    n: 43,
    q: 'Average 10-bar return after RSI<30',
    nodes: {
      rsi: { op: 'rsi', params: { period: 14 }, in: ['close'] },
      oversold: {
        op: 'compare',
        params: { test: 'below', value: 30 },
        in: ['rsi'],
      },
      r10: { op: 'percentChange', params: { periods: 10 }, in: ['close'] },
      fwd: { op: 'shift', params: { periods: -10 }, in: ['r10'] },
      avg: { op: 'meanWhere', in: ['fwd', 'oversold'] },
    },
    outputs: out('avg'),
  },
  {
    n: 44,
    q: 'Hit rate of a higher close 5 bars after a lower-band break',
    nodes: {
      bb: { op: 'bollinger', in: ['close'] },
      brk: {
        op: 'compareColumns',
        params: { test: 'below' },
        in: ['close', 'bb#Lower'],
      },
      r5: { op: 'percentChange', params: { periods: 5 }, in: ['close'] },
      fwd: { op: 'shift', params: { periods: -5 }, in: ['r5'] },
      up: { op: 'compare', params: { test: 'above', value: 0 }, in: ['fwd'] },
      hit: { op: 'meanWhere', in: ['up', 'brk'] },
    },
    outputs: out('hit'),
  },
  {
    n: 45,
    q: '50/200 crossover vs buy and hold',
    nodes: {
      x: {
        op: 'movingAverageCross',
        params: { fastPeriod: 50, slowPeriod: 200 },
        in: ['close'],
      },
      long: { op: 'compare', params: { test: 'above', value: 0 }, in: ['x'] },
      held: { op: 'hold', in: ['long'] },
      pos: { op: 'shift', params: { periods: 1 }, in: ['held'] },
      ret: { op: 'percentChange', in: ['close'] },
      frac: { op: 'scale', params: { factor: 0.01 }, in: ['ret'] },
      sret: { op: 'multiply', in: ['frac', 'pos'] },
      grow: { op: 'scale', params: { offset: 1 }, in: ['sret'] },
      equity: { op: 'cumulative', params: { how: 'product' }, in: ['grow'] },
      strategy: { op: 'last', in: ['equity'] },
      buyHold: { op: 'change', in: ['close'] },
    },
    outputs: out('strategy', 'buyHold'),
  },
  {
    n: 48,
    q: 'Flag possible unadjusted splits',
    nodes: {
      ret: { op: 'percentChange', in: ['close'] },
      down: {
        op: 'compare',
        params: { test: 'below', value: -40 },
        in: ['ret'],
      },
      up: { op: 'compare', params: { test: 'above', value: 40 }, in: ['ret'] },
      big: { op: 'or', in: ['down', 'up'] },
      when: { op: 'events', in: ['big'] },
    },
    outputs: out('when'),
  },
];

function request(g) {
  return { from: 'bars', nodes: g.nodes, outputs: g.outputs, onError: 'throw' };
}

function runOnce(g) {
  const host = createHost({ registry }).add('bars', bars);
  const t0 = performance.now();
  const result = host.run(request(g));
  const wall = performance.now() - t0;
  return { wall, result };
}

// Every graph's nodes in one request, slot names prefixed by graph number.
function combined() {
  const nodes = {};
  const outputs = {};
  for (const g of GRAPHS) {
    const p = (s) =>
      Object.hasOwn(g.nodes, s.split('#')[0]) ? `g${g.n}_${s}` : s;
    for (const [k, v] of Object.entries(g.nodes))
      nodes[p(k)] = { ...v, in: v.in.map(p) };
    for (const [k, v] of Object.entries(g.outputs))
      outputs[p(k)] = { on: p(v.on) };
  }
  return { n: 'all', q: 'all 22 in one request', nodes, outputs };
}

// first: one request per graph, in a process where nothing has run yet.
const first = {};
for (const g of GRAPHS) first[g.n] = runOnce(g).wall;

for (let w = 0; w < WARMUP; w += 1) for (const g of GRAPHS) runOnce(g);

const rows = [];
for (const g of GRAPHS) {
  const walls = [];
  let last;
  for (let r = 0; r < RUNS; r += 1) {
    last = runOnce(g);
    walls.push(last.wall);
  }
  const nodes = last.result.nodes.filter((x) => typeof x.ms === 'number');
  const nodeSum = nodes.reduce((a, x) => a + x.ms, 0);
  const slow = nodes.reduce((a, x) => (x.ms > a.ms ? x : a), { ms: -1 });
  rows.push({
    n: g.n,
    question: g.q,
    steps: Object.keys(g.nodes).length,
    first: ms(first[g.n]),
    warm: ms(median(walls)),
    nodes: ms(nodeSum),
    slow: `${slow.slot ?? slow.op ?? '?'} ${ms(slow.ms)}`,
  });
}

const all = combined();
const allWalls = [];
for (let r = 0; r < RUNS; r += 1) allWalls.push(runOnce(all).wall);
const separate = rows.reduce((a, r) => a + r.warm, 0);

console.log(
  JSON.stringify(
    {
      rows: ROWS,
      runs: RUNS,
      warmup: WARMUP,
      sessions: days,
      graphs: rows,
      combined: {
        steps: Object.keys(all.nodes).length,
        warm: ms(median(allWalls)),
        sumOfSeparate: ms(separate),
      },
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
    },
    null,
    2,
  ),
);

if (process.env.DEBUG_COMBINED) {
  const { result } = runOnce(all);
  const ns = result.nodes;
  const sum = ns.reduce((a, x) => a + x.ms, 0);
  console.error(
    'nodes',
    ns.length,
    'unique ids',
    new Set(ns.map((x) => x.id)).size,
    'sum ms',
    sum.toFixed(0),
  );
  console.error(
    [...ns]
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 12)
      .map((x) => `${x.slot} ${x.ms.toFixed(0)}`)
      .join(', '),
  );
  console.error('series columns', result.series?.schema.length);
}
