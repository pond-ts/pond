/**
 * Study parity fixture: what `@pond-ts/financial` returns for a fixed set of
 * study calls, recorded as language-neutral JSON so pond-rs can check that
 * its studies give the same bits. (The pandas / TA-Lib oracle in
 * `study-oracle.json` checks the maths within a tolerance; this file checks
 * the exact doubles, plus gaps, edge inputs and errors the oracle never sees.)
 *
 * `buildFixture(pond, financial, oracle)` takes the modules and the oracle
 * JSON so the same code runs against the compiled packages
 * (`generate.mjs`, which writes the file) and against source
 * (`test/study-parity.test.ts`, which fails if the committed file no longer
 * matches what the studies produce).
 *
 * Inputs are stored as `TimeSeries.toJSON()` (a missing cell is `null`).
 * Each case calls `financial[study](inputs[input], options)` and records
 * either `expected` (the columns the study appended, in order: name, kind,
 * required and every value) or `error` (`{ name, message }`). A value is a
 * JSON number, `null` for a gap, or `{ "f64": "-0" | "NaN" | "inf" |
 * "-inf" }` for what plain JSON cannot carry. Values must agree exactly.
 */

const OHLCV_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'volume', kind: 'number' },
];

const CLOSE_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
];

// A repeatable [0, 1) sequence (no Math.random).
const unit = (i, mult) => ((i * mult) % 4294967291) / 4294967291;

// A random walk near 100 with gaps where the studies must handle them: three
// leading gaps, single gaps, a run of 25 (longer than period 20), a run of
// period-length 5, and two trailing gaps. Also a
// gappy `volume`, and text (`name`) and true/false (`flag`) columns for
// studies pointed at a column that is not a number one.
const GAPPY_LENGTH = 140;
const GAPPY_MISSING = new Set([
  0, 1, 2, 9, 17, 18, 31, 44, 45, 46, 47, 48, 60, 61, 62, 63, 64, 65, 66, 67,
  68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 97, 112,
  138, 139,
]);
const GAPPY_ROWS = (() => {
  let price = 100;
  return Array.from({ length: GAPPY_LENGTH }, (_, i) => {
    price += (unit(i + 1, 2654435761) - 0.5) * 3;
    const close = GAPPY_MISSING.has(i) ? null : price;
    const volume = i % 7 === 3 ? null : 1000 + Math.round(unit(i, 40503) * 500);
    return [i * 60_000, close, volume, i % 2 === 0 ? 'a' : 'b', i % 3 === 0];
  });
})();
const GAPPY_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number', required: false },
  { name: 'volume', kind: 'number', required: false },
  { name: 'name', kind: 'string' },
  { name: 'flag', kind: 'boolean' },
];

// Large magnitudes, where a running sum of raw values loses its low bits:
// 1e15 + a small cycle (the shifted frame's worst case) and 1e9 + a sine.
const LARGE_ROWS = Array.from({ length: 200 }, (_, i) => [
  i * 1000,
  1e15 + ((i % 7) - 3),
  1e9 + Math.sin(i / 3),
]);
const LARGE_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
  { name: 'open', kind: 'number' },
];

// A flat run (zero spread: z-score and KAMA's efficiency ratio divide by
// it), a step, then a flat run again; signed zeros in `open`.
const FLAT_ROWS = Array.from({ length: 60 }, (_, i) => [
  i * 1000,
  i < 25 ? 5 : i < 40 ? 7.5 : 7.5 + (i % 2) * 0.125,
  i % 3 === 0 ? -0 : i % 3 === 1 ? 0 : -0,
]);
const FLAT_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
  { name: 'open', kind: 'number' },
];

// A series that already has columns a study writes (or, for macd, its
// scratch column), so the collision errors are recorded.
const NAMED_ROWS = Array.from({ length: 12 }, (_, i) => [
  i * 1000,
  10 + i,
  i,
  i,
  i,
  i,
]);
const NAMED_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
  { name: 'macdHist', kind: 'number' },
  { name: '__macdLine__', kind: 'number' },
  { name: 'gmmaL60', kind: 'number' },
  { name: 'rainbow10', kind: 'number' },
];

const TINY_ROWS = [
  [0, 3],
  [1000, 1],
  [2000, 2],
];

function oracleInputs(oracle) {
  const o = oracle.input;
  return {
    bars: {
      name: 'bars',
      schema: OHLCV_SCHEMA,
      rows: o.closes.map((c, i) => [
        i,
        o.opens[i],
        o.highs[i],
        o.lows[i],
        c,
        o.volumes[i],
      ]),
    },
    long: {
      name: 'long',
      schema: CLOSE_SCHEMA,
      rows: o.longCloses.map((c, i) => [i, c]),
    },
  };
}

function inputs(oracle) {
  return {
    ...oracleInputs(oracle),
    gappy: { name: 'gappy', schema: GAPPY_SCHEMA, rows: GAPPY_ROWS },
    large: { name: 'large', schema: LARGE_SCHEMA, rows: LARGE_ROWS },
    flat: { name: 'flat', schema: FLAT_SCHEMA, rows: FLAT_ROWS },
    tiny: { name: 'tiny', schema: CLOSE_SCHEMA, rows: TINY_ROWS },
    named: { name: 'named', schema: NAMED_SCHEMA, rows: NAMED_ROWS },
    empty: { name: 'empty', schema: CLOSE_SCHEMA, rows: [] },
  };
}

const MA_TYPES = [
  'sma',
  'ema',
  'wma',
  'smma',
  'dema',
  'tema',
  'trima',
  'hull',
  'kama',
  'zlema',
];

// Single-period studies (column + output + period), and the extra options
// each takes.
const SINGLE = [
  ['sma', {}],
  ['ema', {}],
  ['rollingStdev', {}],
  ['rollingMin', {}],
  ['rollingMax', {}],
  ['rollingPercentile', { q: 90 }],
  ['zScore', {}],
];

function cases() {
  const out = [];
  const add = (study, input, options) => out.push({ study, input, options });

  // Every study and moving-average type at small, odd/even and long periods
  // on every input. Period 1 and periods longer than the input are edges.
  const periods = {
    bars: [1, 2, 5, 20],
    long: [10, 21, 50],
    gappy: [1, 2, 3, 5, 20],
    large: [2, 7, 20],
    flat: [1, 4, 5],
    tiny: [1, 2, 3, 4],
    empty: [3],
  };
  for (const [input, list] of Object.entries(periods)) {
    for (const period of list) {
      for (const [study, extra] of SINGLE) {
        add(study, input, { period, ...extra });
      }
      for (const type of MA_TYPES) {
        add('movingAverage', input, { period, type });
      }
    }
  }
  // movingAverage with no type is sma.
  add('movingAverage', 'bars', { period: 5 });
  // Moving-average types at more periods: hull's half and root lengths,
  // trima's odd/even split, zlema's lag.
  for (const period of [3, 4, 6, 9, 10, 16, 21]) {
    for (const type of ['wma', 'trima', 'hull', 'kama', 'zlema']) {
      add('movingAverage', 'bars', { period, type });
    }
  }

  // Percentiles: the ends, a fraction, and a value written with an exponent
  // (the default output name is `p` + the number as JavaScript prints it).
  for (const q of [0, 2.5, 50, 100, 1e-7]) {
    add('rollingPercentile', 'gappy', { period: 5, q });
  }

  // Other source columns, custom output names, and the errors.
  for (const [study, extra] of SINGLE) {
    add(study, 'bars', { period: 5, column: 'open', output: 'out', ...extra });
    add(study, 'gappy', { period: 3, column: 'volume', ...extra });
    // A text column reads as all gaps; a missing one too, except where core
    // `rolling` is called with the name (it throws).
    add(study, 'gappy', { period: 3, column: 'name', ...extra });
    add(study, 'gappy', { period: 3, column: 'flag', ...extra });
    add(study, 'gappy', { period: 3, column: 'nope', ...extra });
    add(study, 'flat', { period: 3, column: 'open', ...extra });
    add(study, 'bars', { period: 5, output: 'close', ...extra });
    add(study, 'bars', { period: 5, output: 'time', ...extra });
    for (const period of [0, -1, 1.5]) add(study, 'bars', { period, ...extra });
  }
  for (const type of MA_TYPES) {
    add('movingAverage', 'gappy', { period: 3, column: 'name', type });
    add('movingAverage', 'gappy', { period: 3, column: 'flag', type });
    add('movingAverage', 'gappy', { period: 3, column: 'nope', type });
    add('movingAverage', 'flat', { period: 3, column: 'open', type });
  }
  for (const output of ['out', 'close', 'time']) {
    add('movingAverage', 'bars', { period: 5, type: 'wma', output });
  }
  add('movingAverage', 'bars', { period: 5, type: 'nope' });
  add('movingAverage', 'bars', { period: 0, type: 'nope' });
  for (const q of [-1, 101]) add('rollingPercentile', 'bars', { period: 5, q });

  averageFamilyCases(add);
  return out;
}

// R2 step 2a: the moving-average family. Every study at its defaults on
// every input, then small settings (so 80 bars reach a value), every
// moving-average type where the study takes one, other columns, and every
// error.
const AVERAGE_FAMILY = [
  'macd',
  'priceOscillator',
  'movingAverageCross',
  'movingAverageDeviation',
  'disparityIndex',
  'detrendedPriceOscillator',
  'guppy',
  'rainbow',
  'rainbowOscillator',
  'trix',
  'schaffTrendCycle',
  'coppock',
  'kst',
  'specialK',
  'priceMomentumOscillator',
];

// Small settings per study, and the option that names its moving-average
// type (if any).
const AVERAGE_SMALL = {
  macd: [
    { fastPeriod: 3, slowPeriod: 7, signalPeriod: 4 },
    { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 },
  ],
  priceOscillator: [
    { fastPeriod: 3, slowPeriod: 7 },
    { fastPeriod: 3, slowPeriod: 7, mode: 'absolute' },
    { fastPeriod: 1, slowPeriod: 2, mode: 'percent' },
  ],
  movingAverageCross: [
    { fastPeriod: 3, slowPeriod: 7 },
    { fastPeriod: 1, slowPeriod: 2 },
  ],
  movingAverageDeviation: [{ period: 1 }, { period: 2 }, { period: 5 }],
  disparityIndex: [{ period: 1 }, { period: 2 }, { period: 5 }],
  detrendedPriceOscillator: [{ period: 1 }, { period: 2 }, { period: 5 }],
  guppy: [{}],
  rainbow: [{ period: 2 }, { period: 1 }, { period: 3 }],
  rainbowOscillator: [
    { period: 2, lookback: 3 },
    { period: 3, lookback: 25 },
    { period: 1, lookback: 1 },
  ],
  trix: [
    { period: 5, signalPeriod: 3 },
    { period: 1, signalPeriod: 1 },
  ],
  schaffTrendCycle: [
    { fastPeriod: 5, slowPeriod: 12, cyclePeriod: 4 },
    { fastPeriod: 2, slowPeriod: 3, cyclePeriod: 2 },
  ],
  coppock: [
    { longPeriod: 6, shortPeriod: 3, wmaPeriod: 4 },
    { longPeriod: 1, shortPeriod: 1, wmaPeriod: 1 },
  ],
  kst: [{ signalPeriod: 3 }, { signalPeriod: 1 }],
  specialK: [{}],
  priceMomentumOscillator: [{}],
};
const AVERAGE_TYPE_OPTION = {
  priceOscillator: 'maType',
  movingAverageCross: 'maType',
  movingAverageDeviation: 'maType',
  disparityIndex: 'maType',
  detrendedPriceOscillator: 'maType',
  guppy: 'type',
  rainbow: 'type',
  rainbowOscillator: 'type',
};
// The option naming what a study writes, and the period options it checks.
const AVERAGE_NAMING = {
  macd: 'prefix',
  guppy: 'prefix',
  rainbow: 'prefix',
  rainbowOscillator: 'prefix',
  trix: 'prefix',
  kst: 'prefix',
  priceMomentumOscillator: 'prefix',
};
const AVERAGE_PERIODS = {
  macd: ['fastPeriod', 'slowPeriod', 'signalPeriod'],
  priceOscillator: ['fastPeriod', 'slowPeriod'],
  movingAverageCross: ['fastPeriod', 'slowPeriod'],
  movingAverageDeviation: ['period'],
  disparityIndex: ['period'],
  detrendedPriceOscillator: ['period'],
  guppy: [],
  rainbow: ['period'],
  rainbowOscillator: ['period', 'lookback'],
  trix: ['period', 'signalPeriod'],
  schaffTrendCycle: ['fastPeriod', 'slowPeriod', 'cyclePeriod'],
  coppock: ['longPeriod', 'shortPeriod', 'wmaPeriod'],
  kst: ['signalPeriod'],
  specialK: [],
  priceMomentumOscillator: [],
};

function averageFamilyCases(add) {
  const inputs = ['bars', 'long', 'gappy', 'large', 'flat', 'tiny', 'empty'];
  for (const study of AVERAGE_FAMILY) {
    for (const input of inputs) add(study, input, {});
    const typeOption = AVERAGE_TYPE_OPTION[study];
    for (const [index, small] of AVERAGE_SMALL[study].entries()) {
      for (const input of ['bars', 'gappy', 'large', 'flat']) {
        add(study, input, small);
      }
      // Every moving-average type, on clean and gappy input (for the
      // ten- and twelve-column stacks, at the first setting only).
      const stack = study === 'guppy' || study === 'rainbow';
      if (typeOption && (index === 0 || !stack)) {
        for (const type of MA_TYPES) {
          add(study, 'bars', { ...small, [typeOption]: type });
          add(study, 'gappy', { ...small, [typeOption]: type });
        }
      }
    }
    const small = AVERAGE_SMALL[study][0];
    // Other source columns: open, a gappy volume, the signed zeros of
    // flat.open (zero denominators), and the ones pond-rs refuses.
    add(study, 'bars', { ...small, column: 'open' });
    add(study, 'gappy', { ...small, column: 'volume' });
    add(study, 'flat', { ...small, column: 'open' });
    for (const column of ['name', 'flag', 'nope']) {
      add(study, 'gappy', { ...small, column });
    }
    // Custom names, and names that collide.
    const naming = AVERAGE_NAMING[study] ?? 'output';
    add(study, 'bars', { ...small, [naming]: 'x' });
    add(study, 'bars', { ...small, [naming]: 'close' });
    add(study, 'bars', { ...small, [naming]: 'time' });
    add(study, 'named', small);
    // Periods that are not positive whole numbers.
    for (const option of AVERAGE_PERIODS[study]) {
      for (const bad of [0, -1, 1.5]) {
        add(study, 'bars', { ...small, [option]: bad });
      }
    }
    if (typeOption) add(study, 'bars', { ...small, [typeOption]: 'nope' });
  }
  // fast must be shorter than slow.
  for (const study of [
    'macd',
    'priceOscillator',
    'movingAverageCross',
    'schaffTrendCycle',
  ]) {
    add(study, 'bars', { fastPeriod: 7, slowPeriod: 7 });
    add(study, 'bars', { fastPeriod: 9, slowPeriod: 7 });
  }
  add('priceOscillator', 'bars', { mode: 'nope' });
  // Only macd's scratch column collides.
  add('macd', 'named', { fastPeriod: 3, slowPeriod: 7, prefix: 'z' });
  // Longer settings on the 900 closes.
  add('macd', 'long', { fastPeriod: 50, slowPeriod: 200, signalPeriod: 30 });
  add('schaffTrendCycle', 'long', {
    fastPeriod: 10,
    slowPeriod: 40,
    cyclePeriod: 20,
  });
  add('detrendedPriceOscillator', 'long', { period: 101 });
  add('rainbowOscillator', 'long', { period: 5, lookback: 60 });
}

function encodeCell(cell) {
  if (cell === undefined || cell === null) return null;
  if (typeof cell !== 'number') return cell;
  if (Object.is(cell, -0)) return { f64: '-0' };
  if (Number.isNaN(cell)) return { f64: 'NaN' };
  if (cell === Infinity) return { f64: 'inf' };
  if (cell === -Infinity) return { f64: '-inf' };
  return cell;
}

function run(pond, financial, series, c) {
  try {
    const result = financial[c.study](series, c.options);
    const before = series.schema.length;
    const columns = result.schema.slice(before).map((def) => {
      const column = result.column(def.name);
      return {
        name: def.name,
        kind: def.kind,
        required: def.required !== false,
        values: Array.from({ length: result.length }, (_, i) =>
          encodeCell(column.at(i)),
        ),
      };
    });
    return { expected: columns };
  } catch (e) {
    return { error: { name: e.name, message: e.message } };
  }
}

export function buildFixture(pond, financial, oracle) {
  const sources = inputs(oracle);
  const series = Object.fromEntries(
    Object.entries(sources).map(([name, json]) => [
      name,
      new pond.TimeSeries({
        name: json.name,
        schema: json.schema,
        rows: json.rows.map((row) =>
          row.map((v) => (v === null ? undefined : v)),
        ),
      }),
    ]),
  );
  const encoded = Object.fromEntries(
    Object.entries(series).map(([name, s]) => {
      const json = s.toJSON();
      return [
        name,
        { ...json, rows: json.rows.map((row) => row.map(encodeCell)) },
      ];
    }),
  );
  return {
    meta: {
      description:
        '@pond-ts/financial study output for pond-rs to match bit for bit; inputs are TimeSeries.toJSON(); -0 / NaN / ±Infinity are tagged {"f64":"-0"|"NaN"|"inf"|"-inf"}; each case is financial[study](inputs[input], options) giving expected (the appended columns: name, kind, required, values with null for a gap) or error ({name, message})',
    },
    inputs: encoded,
    cases: cases().map((c, i) => ({
      id: `${i}-${c.study}-${c.input}`,
      ...c,
      ...run(pond, financial, series[c.input], c),
    })),
  };
}
