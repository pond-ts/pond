// The process parity fixture: what `@pond-ts/process` answers for a fixed
// set of requests, so the Rust port (`crates/pond-process`) can check
// itself against it. Shared by `generate.mjs` (which writes the file) and
// `test/parity-fixture.test.ts` (which fails when the file is stale).
//
// Everything here must be deterministic. The one non-deterministic field
// in a response, a node's `ms`, is dropped.
//
// `pond` is the `pond-ts` module and `proc` this package, passed in so the
// test can run it against source and the script against the build.

// ── inputs ────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5); // a Monday

/** A small deterministic generator: values in cents, so JSON is exact. */
function walk(n, seed, start, step) {
  let x = seed >>> 0;
  let v = start;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    x = (Math.imul(x, 1_103_515_245) + 12_345) >>> 0;
    const move = ((x >>> 8) % (2 * step + 1)) - step; // cents
    v = Math.round(v * 100 + move) / 100;
    out.push(v);
  }
  return out;
}

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number', required: false },
  { name: 'volume', kind: 'number', required: false },
  { name: 'var', kind: 'number', required: false },
];

function daily(variant) {
  const n = 60;
  const close = walk(n, variant === 2 ? 99 : 7, 100, 150);
  const volume = walk(n, variant === 2 ? 5 : 3, 5000, 900);
  return {
    name: 'daily',
    schema,
    rows: close.map((c, i) => [
      T0 + i * DAY,
      // Gaps: a missing close mid-series, a missing volume near the end.
      i === 17 ? null : c,
      i === 50 ? null : volume[i],
      // A variance-like column, for the typed-input op.
      i < 3 ? null : Math.round(((c - 100) ** 2 / 100) * 1e4) / 1e4,
    ]),
  };
}

function intraday() {
  const n = 48;
  const close = walk(n, 11, 50, 40);
  const start = Date.UTC(2026, 2, 2, 14, 30); // not on a day boundary
  return {
    name: 'intraday',
    schema,
    rows: close.map((c, i) => [
      start + i * 5 * 60_000,
      c,
      1000 + (i % 7) * 10,
      i % 5 === 0 ? null : c / 100,
    ]),
  };
}

function gappy() {
  const n = 12;
  return {
    name: 'gappy',
    schema,
    rows: Array.from({ length: n }, (_, i) => [
      T0 + i * DAY,
      i % 3 === 0 ? null : 10 + i * 0.5,
      null, // a column with no value at all
      i % 4 === 0 ? 0 : i % 2,
    ]),
  };
}

function empty() {
  return { name: 'empty', schema, rows: [] };
}

const INPUTS = {
  daily: daily(1),
  daily2: daily(2),
  intraday: intraday(),
  gappy: gappy(),
  empty: empty(),
};

// ── fixture-only ops ──────────────────────────────────────────────────
//
// A consumer can define its own ops, and the Rust port must let it. These
// four exist only here; the Rust harness defines the same four through its
// custom-op API and must reach the same answers. They also reach failure
// paths no shipped op does: a typed input, a multi-output op, op code that
// throws, and op code returning the wrong length.

function fixtureOps(proc, pond) {
  const read = (ctx, role) => {
    const col = ctx.series.column(ctx.inputs[role]);
    const out = new Array(col.length);
    for (let i = 0; i < col.length; i += 1) out[i] = col.at(i);
    return out;
  };
  return [
    {
      name: 'annualise',
      family: 'fixture',
      summary: 'Annualised vol in percent from a daily variance.',
      params: { days: proc.int({ min: 1, max: 366, default: 252 }) },
      inputs: [{ role: 'variance', unit: 'variance' }],
      outputs: [{ id: '', unit: '%' }],
      lookback: () => 0,
      label: (p, inputs) => `annualised(${p.days}) ${inputs}`,
      run: (ctx) =>
        read(ctx, 'variance').map((v) =>
          v === undefined ? undefined : Math.sqrt(v * ctx.params.days) * 100,
        ),
    },
    {
      name: 'band',
      family: 'fixture',
      summary: 'source ± width.',
      params: { width: proc.num({ min: 0, default: 1 }) },
      inputs: [{ role: 'source' }],
      outputs: [
        { id: 'Upper', unit: 'inherit', dependsOn: ['width'] },
        { id: 'Mid', unit: 'inherit', dependsOn: [] },
        { id: 'Lower', unit: 'inherit', dependsOn: ['width'] },
      ],
      lookback: () => 0,
      run: (ctx) => {
        const v = read(ctx, 'source');
        const w = ctx.params.width;
        return [
          v.map((x) => (x === undefined ? undefined : x + w)),
          v,
          v.map((x) => (x === undefined ? undefined : x - w)),
        ];
      },
    },
    {
      name: 'boom',
      family: 'fixture',
      summary: 'Op code that throws.',
      params: {},
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: () => {
        throw new Error('boom: op code failed');
      },
    },
    {
      name: 'short',
      family: 'fixture',
      summary: 'Op code returning one row too few.',
      params: {},
      inputs: [{ role: 'source' }],
      outputs: [{ id: '', unit: 'inherit' }],
      run: (ctx) => read(ctx, 'source').slice(1),
    },
  ];
}

/**
 * Registries by name. `standard` is what `createRegistry()` gives; `all`
 * adds the basic ops, the summary folds and the fixture ops.
 */
function registries(proc, pond) {
  const standard = proc.createRegistry();
  let all = proc.createRegistry();
  for (const def of [
    ...proc.BASIC_OPS,
    ...proc.SUMMARY_FOLDS,
    ...fixtureOps(proc, pond),
  ]) {
    all = all.define(def);
  }
  return { standard, all };
}

const UNITS = { close: 'USD', volume: 'shares', var: 'variance' };

// ── requests ──────────────────────────────────────────────────────────

/** Every basic op and every fold, wired the way an agent would. */
const KITCHEN = {
  prev: { op: 'shift', in: ['close'], params: { periods: 1 } },
  next: { op: 'shift', in: ['close'], params: { periods: -3 } },
  ratio: { op: 'divide', in: ['close', 'prev'] },
  ret: { op: 'scale', in: ['ratio'], params: { factor: 100, offset: -100 } },
  fwd: { op: 'subtract', in: ['next', 'close'] },
  up: { op: 'compare', in: ['ret'], params: { test: 'above', value: 0 } },
  down: { op: 'compare', in: ['ret'], params: { test: 'below', value: -1 } },
  flat: { op: 'compare', in: ['ret'], params: { test: 'equal', value: 0 } },
  big: {
    op: 'compare',
    in: ['close'],
    params: { test: 'atLeast', value: 101 },
  },
  small: {
    op: 'compare',
    in: ['close'],
    params: { test: 'atMost', value: 99 },
  },
  peak: { op: 'cumulative', in: ['close'], params: { how: 'max' } },
  trough: { op: 'cumulative', in: ['close'], params: { how: 'min' } },
  growth: { op: 'cumulative', in: ['ratio'], params: { how: 'product' } },
  total: { op: 'cumulative', in: ['volume'] },
  dd: { op: 'subtract', in: ['close', 'peak'] },
  atPeak: {
    op: 'compareColumns',
    in: ['close', 'peak'],
    params: { test: 'atLeast' },
  },
  under: {
    op: 'compareColumns',
    in: ['close', 'prev'],
    params: { test: 'below' },
  },
  same: {
    op: 'compareColumns',
    in: ['close', 'prev'],
    params: { test: 'equal' },
  },
  le: {
    op: 'compareColumns',
    in: ['close', 'prev'],
    params: { test: 'atMost' },
  },
  gt: { op: 'compareColumns', in: ['close', 'prev'] },
  both: { op: 'and', in: ['up', 'big'] },
  either: { op: 'or', in: ['down', 'small'] },
  pos: { op: 'subtract', in: ['up', 'down'] },
  held: { op: 'hold', in: ['pos'] },
  dollars: { op: 'multiply', in: ['close', 'volume'] },
  sum2: { op: 'add', in: ['close', 'prev'] },
  vol: { op: 'annualise', in: ['var'] },
  vol30: { op: 'annualise', in: ['var'], params: { days: 30 } },
  bb: { op: 'band', in: ['close'], params: { width: 2.5 } },
  // folds
  last: { op: 'last', in: ['close'] },
  lastUp: { op: 'last', in: ['bb#Upper'] },
  range: { op: 'extremes', in: ['close'] },
  rank: { op: 'percentileRank', in: ['ret'] },
  sSample: { op: 'shape', in: ['close'], params: { points: 7 } },
  sMean: { op: 'shape', in: ['close'], params: { points: 7, how: 'mean' } },
  sMedian: { op: 'shape', in: ['close'], params: { points: 8, how: 'median' } },
  sMin: { op: 'shape', in: ['close'], params: { points: 5, how: 'min' } },
  sMax: { op: 'shape', in: ['close'], params: { points: 5, how: 'max' } },
  sMinMax: { op: 'shape', in: ['close'], params: { points: 6, how: 'minMax' } },
  sM4: {
    op: 'shape',
    in: ['dd'],
    params: { points: 9, how: 'minMaxFirstLast' },
  },
  sAll: { op: 'shape', in: ['close'], params: { points: 400 } },
  mean: { op: 'mean', in: ['ret'] },
  sd: { op: 'stdev', in: ['ret'] },
  tot: { op: 'sum', in: ['volume'] },
  cnt: { op: 'count', in: ['prev'] },
  p0: { op: 'percentile', in: ['ret'], params: { q: 0 } },
  p5: { op: 'percentile', in: ['ret'], params: { q: 5 } },
  p50: { op: 'percentile', in: ['ret'] },
  p975: { op: 'percentile', in: ['ret'], params: { q: 97.5 } },
  p100: { op: 'percentile', in: ['ret'], params: { q: 100 } },
  share: { op: 'shareTrue', in: ['up'] },
  lt: { op: 'lastTrue', in: ['down'] },
  lc: { op: 'lastChange', in: ['held'] },
  lcFlat: { op: 'lastChange', in: ['big'] },
  ev: { op: 'events', in: ['up'], params: { limit: 5 } },
  evAll: { op: 'events', in: ['either'] },
  mw: { op: 'meanWhere', in: ['fwd', 'down'] },
  ch: { op: 'change', in: ['close'] },
  chVol: { op: 'change', in: ['vol'] },
};

const FOLD_SLOTS = Object.entries(KITCHEN)
  .filter(([, n]) =>
    [
      'last',
      'extremes',
      'percentileRank',
      'shape',
      'mean',
      'stdev',
      'sum',
      'count',
      'percentile',
      'shareTrue',
      'lastTrue',
      'lastChange',
      'events',
      'meanWhere',
      'change',
    ].includes(n.op),
  )
  .map(([slot]) => slot);

const kitchenOutputs = (extra = {}) => ({
  ...Object.fromEntries(FOLD_SLOTS.map((s) => [s, { on: s }])),
  ...extra,
});

/** Facts only, the shape an MCP tool asks for. */
const facts = (from, nodes, outputs) => ({
  from,
  nodes,
  outputs,
  onError: 'collect',
  assemble: false,
});

const sma3 = { op: 'scale', params: { factor: 2 }, inputs: ['close'] };

/**
 * Sessions: a host, then a list of steps run against it in order. A step
 * is `{ add }` (register or replace a dataset), `{ run }`, `{ runAsync }`,
 * `{ remove }`, `{ revise }` (the next load of a feed returns another
 * revision) or `{ has }`.
 */
function sessions() {
  return [
    {
      name: 'kitchen sink: every op and fold, warm, then new data',
      registry: 'all',
      units: UNITS,
      steps: [
        { add: 'd', input: 'daily' },
        { run: facts('d', KITCHEN, kitchenOutputs()) },
        // The same request again: every node served warm.
        { run: facts('d', KITCHEN, kitchenOutputs()) },
        // Columns as well as facts, in the order the caller named them.
        {
          run: {
            from: 'd',
            nodes: KITCHEN,
            outputs: {
              dd: { on: 'dd' },
              upper: { on: 'bb', output: 'Upper' },
              allBands: { on: 'bb' },
              ret: { on: 'ret' },
              again: { on: 'ret' },
              rank: { on: 'rank' },
            },
            onError: 'collect',
            assemble: false,
          },
        },
        // New data under the same graph: everything recomputes.
        { add: 'd', input: 'daily2' },
        { run: facts('d', KITCHEN, kitchenOutputs()) },
        { has: 'd' },
        { has: 'nope' },
      ],
    },
    {
      name: 'nested plans and inline selectors',
      registry: 'all',
      units: UNITS,
      steps: [
        { add: 'd', input: 'daily' },
        {
          run: {
            from: 'd',
            process: [
              sma3,
              { op: 'band', params: { width: 1 }, inputs: [sma3] },
              {
                op: 'last',
                inputs: [
                  {
                    from: { op: 'band', params: { width: 1 }, inputs: [sma3] },
                    output: 'Lower',
                  },
                ],
              },
            ],
            select: [
              { on: { op: 'last', inputs: ['close'] } },
              {
                on: {
                  op: 'last',
                  inputs: [
                    {
                      from: {
                        op: 'band',
                        params: { width: 1 },
                        inputs: [sma3],
                      },
                      output: 'Lower',
                    },
                  ],
                },
              },
              // Selected inline, never listed in the plan.
              {
                on: {
                  op: 'extremes',
                  inputs: [{ op: 'shift', inputs: ['close'] }],
                },
              },
              { on: sma3 },
              {
                on: { op: 'band', params: { width: 1 }, inputs: [sma3] },
                output: 'Mid',
              },
            ],
            onError: 'collect',
            assemble: false,
          },
        },
        // An id string cites a node a previous answer returned.
        {
          run: {
            from: 'd',
            process: [],
            select: [{ on: 'p1:scale(close;factor=2,offset=0)' }],
            onError: 'collect',
            assemble: false,
          },
        },
      ],
    },
    {
      name: 'failures under collect',
      registry: 'all',
      units: UNITS,
      steps: [
        { add: 'd', input: 'daily' },
        // The nested form reports each bad spec on its own.
        {
          run: {
            from: 'd',
            process: [
              { op: 'last', inputs: ['close'] },
              { op: 'smaa', inputs: ['close'] },
              { op: 'shift', params: { periods: '2' }, inputs: ['close'] },
              { op: 'shift', params: { periods: 1.5 }, inputs: ['close'] },
              { op: 'scale', params: { factor: 'x' }, inputs: ['close'] },
              { op: 'shift', params: { periods: -6000 }, inputs: ['close'] },
              { op: 'shape', params: { points: 401 }, inputs: ['close'] },
              { op: 'cumulative', params: { how: 'avg' }, inputs: ['close'] },
              { op: 'shape', params: { how: 3 }, inputs: ['close'] },
              { op: 'last', params: { period: 3 }, inputs: ['close'] },
              { op: 'add', inputs: ['close'] },
              { op: 'shift' },
              { op: 'shift', params: null, inputs: ['close'] },
              { op: 'shift', inputs: [null] },
              { op: 'annualise', inputs: ['close'] },
              { op: 'annualise', inputs: [{ op: 'scale', inputs: ['close'] }] },
              {
                op: 'annualise',
                inputs: [
                  { from: { op: 'band', inputs: ['var'] }, output: 'Lower' },
                ],
              },
              { op: 'annualise', inputs: ['var'] },
              { op: 'shift', inputs: [{ op: 'last', inputs: ['close'] }] },
              {
                op: 'last',
                inputs: [
                  { from: { op: 'band', inputs: ['close'] }, output: 'Middle' },
                ],
              },
              { op: 'last', inputs: ['nope'] },
              { op: 'last', inputs: [{ op: 'scale', inputs: ['nope'] }] },
              { op: 'annualise', inputs: [{ op: 'scale', inputs: ['nope'] }] },
              { op: 'boom', inputs: ['close'] },
              { op: 'short', inputs: ['close'] },
            ],
            select: [
              { on: { op: 'last', inputs: ['close'] } },
              { on: { op: 'smaa', inputs: ['close'] } },
              { on: { op: 'annualise', inputs: ['var'] } },
              {
                on: { op: 'last', inputs: [{ op: 'boom', inputs: ['close'] }] },
              },
              {
                on: {
                  op: 'last',
                  inputs: [{ op: 'short', inputs: ['close'] }],
                },
              },
              { on: { op: 'boom', inputs: ['volume'] } },
              { on: { op: 'band', inputs: ['close'] }, output: 'Middle' },
              { on: { op: 'band', inputs: ['close'] }, output: 'Lower' },
              { on: { op: 'last', inputs: ['volume'] } },
              { on: 'p1:last(close;)' },
              { on: 'p1:last(nope;)' },
            ],
            onError: 'collect',
            assemble: false,
          },
        },
        // Slot form: one bad step refuses the whole request (F-charts-39).
        {
          run: facts(
            'd',
            {
              ok: { op: 'last', in: ['close'] },
              bad: { op: 'smaa', in: ['close'] },
            },
            { ok: { on: 'ok' } },
          ),
        },
        {
          run: facts(
            'd',
            {
              ok: { op: 'last', in: ['close'] },
              bad: { op: 'shift', in: ['close'], params: { periods: 'x' } },
            },
            { ok: { on: 'ok' } },
          ),
        },
        // A step that compiles but fails when pulled is skipped alone.
        {
          run: facts(
            'd',
            {
              ok: { op: 'last', in: ['close'] },
              t: { op: 'boom', in: ['close'] },
              tl: { op: 'last', in: ['t'] },
              s: { op: 'short', in: ['close'] },
              sl: { op: 'last', in: ['s'] },
              wu: { op: 'annualise', in: ['close'] },
            },
            {
              ok: { on: 'ok' },
              tl: { on: 'tl' },
              sl: { on: 'sl' },
              s: { on: 's' },
              missing: { on: 'nowhere' },
            },
          ),
        },
        // Slot names that fail expansion.
        { run: facts('d', { close: { op: 'last', in: ['close'] } }, {}) },
        { run: facts('d', { a: { op: 'last', in: ['clsoe'] } }, {}) },
        {
          run: facts(
            'd',
            {
              bb: { op: 'band', in: ['close'] },
              x: { op: 'last', in: ['bb.Upper'] },
            },
            {},
          ),
        },
        {
          run: facts(
            'd',
            {
              bb: { op: 'band', in: ['close'] },
              x: { op: 'last', in: ['bb#Middle'] },
            },
            { x: { on: 'x' } },
          ),
        },
        {
          run: facts(
            'd',
            {
              a: { op: 'scale', in: ['b'] },
              b: { op: 'scale', in: ['c'] },
              c: { op: 'scale', in: ['a'] },
            },
            {},
          ),
        },
        // skip reports like collect.
        {
          run: {
            from: 'd',
            process: [
              { op: 'smaa', inputs: ['close'] },
              { op: 'last', inputs: ['close'] },
            ],
            select: [{ on: { op: 'last', inputs: ['close'] } }],
            onError: 'skip',
          },
        },
        // throw (the default) raises the first failure.
        {
          run: {
            from: 'd',
            nodes: {
              a: { op: 'shift', in: ['close'], params: { periods: 'x' } },
            },
          },
        },
        {
          run: {
            from: 'd',
            process: [{ op: 'last', inputs: ['nope'] }],
          },
        },
        {
          run: {
            from: 'd',
            nodes: { a: { op: 'boom', in: ['close'] } },
            outputs: { a: { on: 'a' } },
            onError: 'throw',
          },
        },
        { run: { from: 'nope', nodes: {}, onError: 'collect' } },
      ],
    },
    {
      name: 'byte budget evicts least recently used nodes',
      registry: 'all',
      units: UNITS,
      // Three 60-row number columns.
      budgetBytes: 3 * 60 * 8,
      steps: [
        { add: 'd', input: 'daily' },
        {
          run: facts(
            'd',
            {
              a: { op: 'scale', in: ['close'], params: { factor: 2 } },
              b: { op: 'scale', in: ['a'], params: { factor: 3 } },
              c: { op: 'shift', in: ['b'] },
              d: { op: 'cumulative', in: ['c'] },
              f: { op: 'last', in: ['d'] },
              g: { op: 'mean', in: ['b'] },
            },
            { f: { on: 'f' }, g: { on: 'g' } },
          ),
        },
        {
          run: facts(
            'd',
            {
              x: { op: 'scale', in: ['volume'], params: { factor: 2 } },
              y: { op: 'last', in: ['x'] },
            },
            { y: { on: 'y' } },
          ),
        },
        {
          run: facts(
            'd',
            {
              a: { op: 'scale', in: ['close'], params: { factor: 2 } },
              b: { op: 'scale', in: ['a'], params: { factor: 3 } },
              c: { op: 'shift', in: ['b'] },
              d: { op: 'cumulative', in: ['c'] },
              f: { op: 'last', in: ['d'] },
              g: { op: 'mean', in: ['b'] },
            },
            { f: { on: 'f' }, g: { on: 'g' } },
          ),
        },
        { datasets: true },
      ],
    },
    {
      name: 'time stamps, gaps and empty series',
      registry: 'all',
      units: UNITS,
      steps: [
        { add: 'i', input: 'intraday' },
        { add: 'g', input: 'gappy' },
        { add: 'e', input: 'empty' },
        ...['i', 'g', 'e'].map((from) => ({
          run: facts(
            from,
            {
              last: { op: 'last', in: ['close'] },
              range: { op: 'extremes', in: ['close'] },
              rank: { op: 'percentileRank', in: ['close'] },
              s: { op: 'shape', in: ['close'], params: { points: 4 } },
              sv: {
                op: 'shape',
                in: ['volume'],
                params: { points: 4, how: 'mean' },
              },
              lastV: { op: 'last', in: ['volume'] },
              rangeV: { op: 'extremes', in: ['volume'] },
              rankV: { op: 'percentileRank', in: ['volume'] },
              mean: { op: 'mean', in: ['volume'] },
              sd: { op: 'stdev', in: ['volume'] },
              sum: { op: 'sum', in: ['volume'] },
              cnt: { op: 'count', in: ['volume'] },
              p: { op: 'percentile', in: ['volume'], params: { q: 25 } },
              share: { op: 'shareTrue', in: ['var'] },
              lt: { op: 'lastTrue', in: ['var'] },
              lc: { op: 'lastChange', in: ['var'] },
              ev: { op: 'events', in: ['var'], params: { limit: 3 } },
              mw: { op: 'meanWhere', in: ['close', 'var'] },
              mwV: { op: 'meanWhere', in: ['volume', 'var'] },
              ch: { op: 'change', in: ['close'] },
              chV: { op: 'change', in: ['volume'] },
              cum: {
                op: 'cumulative',
                in: ['close'],
                params: { how: 'product' },
              },
              held: { op: 'hold', in: ['var'] },
              lastHeld: { op: 'last', in: ['held'] },
              lastCum: { op: 'last', in: ['cum'] },
            },
            {
              ...Object.fromEntries(
                [
                  'last',
                  'range',
                  'rank',
                  's',
                  'sv',
                  'lastV',
                  'rangeV',
                  'rankV',
                  'mean',
                  'sd',
                  'sum',
                  'cnt',
                  'p',
                  'share',
                  'lt',
                  'lc',
                  'ev',
                  'mw',
                  'mwV',
                  'ch',
                  'chV',
                  'lastHeld',
                  'lastCum',
                ].map((s) => [s, { on: s }]),
              ),
              held: { on: 'held' },
            },
          ),
        })),
      ],
    },
    {
      name: 'async sources: revisions, sharing and the source cap',
      registry: 'all',
      units: UNITS,
      maxSources: 2,
      feeds: { daily: 'daily', intraday: 'intraday', gappy: 'gappy' },
      steps: [
        {
          runAsync: facts(
            { source: 'feed', params: { input: 'daily', bars: 60 } },
            { l: { op: 'last', in: ['close'] } },
            { l: { on: 'l' } },
          ),
        },
        // Key order does not matter to a source's identity.
        {
          runAsync: facts(
            { source: 'feed', params: { bars: 60, input: 'daily' } },
            { l: { op: 'last', in: ['close'] } },
            { l: { on: 'l' } },
          ),
        },
        { has: 'source:feed?bars=number%3A60&input=string%3A%22daily%22' },
        // A new revision of the same source: same graph, recomputed.
        { revise: 'daily', input: 'daily2' },
        {
          runAsync: facts(
            { source: 'feed', params: { input: 'daily', bars: 60 } },
            { l: { op: 'last', in: ['close'] } },
            { l: { on: 'l' } },
          ),
        },
        {
          runAsync: facts(
            { source: 'feed', params: { input: 'intraday', bars: 48 } },
            { l: { op: 'last', in: ['close'] } },
            { l: { on: 'l' } },
          ),
        },
        // A third source evicts the least recently used.
        {
          runAsync: facts(
            { source: 'feed', params: { input: 'gappy', bars: 12 } },
            { l: { op: 'last', in: ['close'] } },
            { l: { on: 'l' } },
          ),
        },
        { has: 'source:feed?bars=number%3A60&input=string%3A%22daily%22' },
        { has: 'source:feed?bars=number%3A48&input=string%3A%22intraday%22' },
        { runAsync: facts({ source: 'nope', params: {} }, {}, {}) },
        // A loader that throws: the error reaches the caller.
        {
          runAsync: facts(
            { source: 'feed', params: { input: 'broken' } },
            { l: { op: 'last', in: ['close'] } },
            { l: { on: 'l' } },
          ),
        },
        // A local envelope through runAsync is an ordinary run.
        { add: 'd', input: 'daily' },
        {
          runAsync: facts(
            'd',
            { l: { op: 'last', in: ['close'] } },
            { l: { on: 'l' } },
          ),
        },
        { remove: 'd' },
        { remove: 'd' },
        { has: 'd' },
      ],
    },
    {
      name: 'standard registry only',
      registry: 'standard',
      steps: [
        { add: 'd', input: 'daily' },
        {
          run: facts(
            'd',
            {
              l: { op: 'last', in: ['close'] },
              s: { op: 'shape', in: ['close'] },
              m: { op: 'mean', in: ['close'] },
            },
            { l: { on: 'l' }, s: { on: 's' } },
          ),
        },
        {
          run: facts(
            'd',
            {
              l: { op: 'last', in: ['close'] },
              s: { op: 'shape', in: ['close'] },
            },
            { l: { on: 'l' }, s: { on: 's' } },
          ),
        },
      ],
    },
  ];
}

// ── ids, explanations, descriptions ───────────────────────────────────

function idCases() {
  const sh = (params, inputs = ['close']) => ({ op: 'shift', params, inputs });
  return [
    { spec: sh(undefined) },
    { spec: sh({ periods: 1 }) },
    { spec: sh({ periods: 1e21 }) },
    { spec: sh({ periods: -0 }) },
    {
      spec: {
        op: 'scale',
        params: { offset: 0.1, factor: 1e-7 },
        inputs: ['close'],
      },
    },
    {
      spec: {
        op: 'scale',
        params: { factor: 123456789.125 },
        inputs: ['close'],
      },
    },
    {
      spec: {
        op: 'compare',
        params: { value: -1.5, test: 'atMost' },
        inputs: ['close'],
      },
    },
    {
      spec: {
        op: 'shape',
        params: { how: 'minMax' },
        inputs: ['a;b(c)=d,e+f\\g'],
      },
    },
    { spec: { op: 'band', inputs: ['close'] } },
    {
      spec: {
        op: 'last',
        inputs: [
          {
            from: { op: 'band', params: { width: 2 }, inputs: ['close'] },
            output: 'Lower',
          },
        ],
      },
    },
    { spec: { op: 'add', inputs: [sma3, { op: 'shift', inputs: [sma3] }] } },
    // Strict failures.
    { spec: { op: 'smaa', inputs: ['close'] } },
    { spec: sh({ periods: '1' }) },
    { spec: sh({ periods: 1, bogus: 2 }) },
    { spec: { op: 'add', inputs: ['close'] } },
    { spec: { op: 'shift' } },
    { spec: { op: 'shift', params: null, inputs: ['close'] } },
    { spec: { op: 'shift', inputs: [null] } },
    { spec: { op: 'shift', inputs: 'close' } },
    {
      spec: {
        op: 'shift',
        inputs: [{ op: 'shift', params: { periods: '2' }, inputs: ['close'] }],
      },
    },
    {
      spec: {
        op: 'smaa',
        params: { period: 20, a: true },
        inputs: ['close', 7],
      },
    },
    { spec: { op: 'shift', params: { 'a=1,b': 1 }, inputs: ['close'] } },
    { spec: { op: 'shift', params: [1], inputs: [{ x: 1 }] } },
  ];
}

const SOURCE_REFS = [
  { source: 'feed', params: {} },
  { source: 'feed', params: { b: 2, a: 'x' } },
  { source: 'a b/c?', params: { 'k&=': 'v w', t: true, n: -0.5 } },
  { source: 'feed', params: { s: 'é"\\' } },
];

// ── runner ────────────────────────────────────────────────────────────

/** A thrown error as data. */
function caught(e) {
  return {
    code: e?.code ?? null,
    name: e?.name ?? null,
    message: e instanceof Error ? e.message : String(e),
  };
}

/** A column as plain numbers, `null` for a gap. */
function cells(column) {
  const out = [];
  for (let i = 0; i < column.length; i += 1) {
    const v = column.at(i);
    out.push(v === undefined || !Number.isFinite(v) ? null : v);
  }
  return out;
}

/** The deterministic part of a response. */
function response(proc, result) {
  const wire = proc.toWire(result);
  const out = JSON.parse(JSON.stringify(wire));
  out.nodes = out.nodes.map(({ ms, ...rest }) => rest);
  if (result.columns !== undefined) {
    out.columns = Object.fromEntries(
      Object.entries(result.columns).map(([k, c]) => [k, cells(c)]),
    );
  }
  return out;
}

async function runSession(pond, proc, session) {
  const regs = registries(proc, pond);
  const series = (name) => pond.TimeSeries.fromJSON(INPUTS[name]);
  const revisions = new Map(); // feed input -> [revision, input name]
  let sources;
  if (session.feeds !== undefined) {
    for (const input of Object.keys(session.feeds))
      revisions.set(input, [1, input]);
    sources = proc.createSourceRegistry().define(
      proc.defineSource({
        name: 'feed',
        load: async (params) => {
          if (params.input === 'broken') throw new Error('feed is down');
          const [revision, input] = revisions.get(params.input);
          return { value: series(input), revision: `r${revision}` };
        },
      }),
    );
  }
  const host = proc.createHost({
    registry: regs[session.registry],
    ...(session.units !== undefined && { units: session.units }),
    ...(sources !== undefined && { sources }),
    ...(session.budgetBytes !== undefined && {
      budgetBytes: session.budgetBytes,
    }),
    ...(session.maxSources !== undefined && { maxSources: session.maxSources }),
  });
  const results = [];
  for (const step of session.steps) {
    if (step.add !== undefined) {
      host.add(step.add, series(step.input));
      results.push(null);
    } else if (step.remove !== undefined) {
      results.push({ removed: host.remove(step.remove) });
    } else if (step.has !== undefined) {
      results.push({ has: host.has(step.has) });
    } else if (step.revise !== undefined) {
      const [revision] = revisions.get(step.revise);
      revisions.set(step.revise, [revision + 1, step.input]);
      results.push(null);
    } else if (step.datasets !== undefined) {
      results.push({ datasets: host.datasets });
    } else {
      try {
        const result =
          step.run !== undefined
            ? host.run(step.run)
            : await host.runAsync(step.runAsync);
        results.push({ result: response(proc, result) });
      } catch (e) {
        results.push({ error: caught(e) });
      }
    }
  }
  return { ...session, results };
}

/**
 * The whole fixture. `pond` is `pond-ts`, `proc` this package.
 */
export async function buildFixture(pond, proc) {
  const { all } = registries(proc, pond);
  const ids = idCases().map(({ spec }) => {
    const out = { spec };
    for (const [key, validate] of [
      ['strict', true],
      ['lenient', false],
    ]) {
      try {
        out[key] = { id: proc.specId(all, spec, { validate }) };
      } catch (e) {
        out[key] = { error: caught(e) };
      }
    }
    // Only a valid spec has an explanation: `explain` does not check a
    // malformed one, and what it throws there is the JavaScript engine's own
    // TypeError text, which no port should copy.
    if (out.strict.id !== undefined) out.explain = proc.explain(all, spec);
    return out;
  });
  const sessionsOut = [];
  for (const session of sessions()) {
    sessionsOut.push(await runSession(pond, proc, session));
  }
  return JSON.parse(
    JSON.stringify({
      inputs: Object.fromEntries(
        Object.entries(INPUTS).map(([k, v]) => [
          k,
          pond.TimeSeries.fromJSON(v).toJSON(),
        ]),
      ),
      describe: {
        standard: registries(proc, pond).standard.describe(),
        all: all.describe(),
      },
      ids,
      sourceIds: SOURCE_REFS.map((ref) => ({ ref, id: proc.sourceId(ref) })),
      sessions: sessionsOut,
    }),
  );
}
