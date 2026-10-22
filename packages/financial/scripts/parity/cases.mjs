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
// it), a step, then a flat run again; signed zeros in `open`; a `ramp`
// that keeps rising through the flat run.
const FLAT_ROWS = Array.from({ length: 60 }, (_, i) => [
  i * 1000,
  i < 25 ? 5 : i < 40 ? 7.5 : 7.5 + (i % 2) * 0.125,
  i % 3 === 0 ? -0 : i % 3 === 1 ? 0 : -0,
  i,
]);
const FLAT_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
  { name: 'open', kind: 'number' },
  { name: 'ramp', kind: 'number' },
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
  i,
]);
const NAMED_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
  { name: 'macdHist', kind: 'number' },
  { name: '__macdLine__', kind: 'number' },
  { name: 'gmmaL60', kind: 'number' },
  { name: 'rainbow10', kind: 'number' },
  { name: '__stochRsiRsi__', kind: 'number' },
];

// Bars with gaps on every side, for the studies that read high, low and
// close: a gap in close only (rows 7, 30), in high only (12), in low only
// (19), a run of 9 whole-bar gaps (40-48), a stretch where high = low =
// close (60-74, so the spread and the true range are zero), signed zeros in
// `open`, a `prime` column of values around and past the prime limits,
// and columns a prefix of `m`, `u` or `l` collides with.
const OHLC_LENGTH = 100;
const PRIME_VALUES = [
  -3,
  0,
  1,
  1.5,
  2,
  2.5,
  3,
  4,
  7,
  7.5,
  8,
  9.99,
  10,
  89,
  90,
  113.5,
  1e6,
  1e6 + 0.5,
  2 ** 31,
  2 ** 53 - 111,
  2 ** 53 - 112,
  2 ** 53 - 1,
  2 ** 53,
  1e300,
];
const OHLC_ROWS = (() => {
  let price = 50;
  return Array.from({ length: OHLC_LENGTH }, (_, i) => {
    const flat = i >= 60 && i < 75;
    if (!flat) price += (unit(i + 7, 2654435761) - 0.5) * 2;
    const spread = flat ? 0 : 0.25 + unit(i, 40503) * 1.5;
    const whole = i >= 40 && i < 49;
    const high = whole || i === 12 ? null : price + spread;
    const low = whole || i === 19 ? null : price - spread;
    const close =
      whole || i === 7 || i === 30
        ? null
        : price + (unit(i, 69069) - 0.5) * spread;
    const open = i % 4 === 0 ? -0 : i % 4 === 2 ? 0 : price;
    return [
      i * 60_000,
      open,
      high,
      low,
      close,
      PRIME_VALUES[i % PRIME_VALUES.length],
      i % 2 === 0 ? 'a' : 'b',
      i,
      i,
      i,
      i,
      i,
      i,
    ];
  });
})();
const OHLC_GAPPY_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number', required: false },
  { name: 'low', kind: 'number', required: false },
  { name: 'close', kind: 'number', required: false },
  { name: 'prime', kind: 'number' },
  { name: 'name', kind: 'string' },
  { name: 'mMiddle', kind: 'number' },
  { name: 'uUpper', kind: 'number' },
  { name: 'lLower', kind: 'number' },
  { name: 'mK', kind: 'number' },
  { name: 'uD', kind: 'number' },
  { name: 'lSignal', kind: 'number' },
];

// Clean bars after a leading gap run, so the average true range warms up
// and keeps going: whole bars missing at rows 0-2 and the close alone at
// row 3 (the first true range is row 5, which shifts Wilder's seed), a
// stretch where high = low = close (40-54, zero true range), no gaps after.
const LEAD_ROWS = Array.from({ length: 90 }, (_, i) => {
  const flat = i >= 40 && i < 55;
  const price = flat ? 80 : 80 + Math.sin(i / 4) * 3 + unit(i, 69069);
  const spread = flat ? 0 : 0.2 + unit(i, 40503);
  const whole = i < 3;
  return [
    i * 60_000,
    whole ? null : price + spread,
    whole ? null : price - spread,
    whole || i === 3 ? null : price + (unit(i, 2654435761) - 0.5) * spread,
    whole ? null : price - (unit(i, 1103515245) - 0.5) * spread,
  ];
});
// Edge bars for the trend studies: a long first run whose second bar is an
// inside bar (the high falls further than the low rises, so both moves are
// negative) and which jumps from -1.7e308 to 1.7e308 near its end (rows
// 33-34: the ranges and averages overflow to infinity and the bands to
// NaN; pond-ts refuses infinite inputs, so overflow is the only way in),
// then two short runs after whole-bar gaps, each opening with an inside
// bar.
const EDGE_ROWS = Array.from({ length: 60 }, (_, i) => {
  const time = i * 60_000;
  if (i === 40 || i === 50) return [time, null, null, null, null];
  const start = i === 0 || i === 41 || i === 51;
  const inside = i === 1 || i === 42 || i === 52;
  const price = 20 + Math.sin(i / 3) * 2 + unit(i, 69069);
  const spread = 0.3 + unit(i, 40503);
  let high = price + spread;
  let low = price - spread;
  if (start) [high, low] = [21, 19];
  if (inside) [high, low] = [20.5, 19.2];
  // An outside bar whose high rises exactly as far as its low falls.
  if (i === 2) [high, low] = [21, 19];
  if (i === 3) [high, low] = [21.5, 18.5];
  let close = Math.min(high, Math.max(low, price));
  // A close above its bar's high, then two bars flat at that close: the
  // true range over them is 0 while the bar before them reaches below.
  if (i === 45) [high, low, close] = [20, 19.5, 21];
  if (i === 46 || i === 47) [high, low, close] = [21, 21, 21];
  if (i === 33) [high, low, close] = [-1.7e308, -1.7e308, -1.7e308];
  if (i === 34) [high, low, close] = [1.7e308, 1.7e308, 1.7e308];
  return [time, high, low, close, price];
});
// Exact ties: a ZigZag first swing of exactly 25% (25 = 0.25 * 100, no
// rounding), then closes alternating 1 and -1, so a two-bar average is
// exactly 0 (RAVI's zero long average).
const TIE_ROWS = [
  [0, 100, 100, 1, 100],
  [60_000, 125, 110, -1, 110],
  [120_000, 124, 112, 1, 120],
  [180_000, 120, 90, -1, 100],
  [240_000, 118, 100, 1, 105],
  [300_000, 116, 101, -1, 104],
];
const LEAD_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'high', kind: 'number', required: false },
  { name: 'low', kind: 'number', required: false },
  { name: 'close', kind: 'number', required: false },
  { name: 'open', kind: 'number', required: false },
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
    ohlc: { name: 'ohlc', schema: OHLC_GAPPY_SCHEMA, rows: OHLC_ROWS },
    lead: { name: 'lead', schema: LEAD_SCHEMA, rows: LEAD_ROWS },
    edge: { name: 'edge', schema: LEAD_SCHEMA, rows: EDGE_ROWS },
    ties: { name: 'ties', schema: LEAD_SCHEMA, rows: TIE_ROWS },
    ohlcEmpty: { name: 'ohlcEmpty', schema: LEAD_SCHEMA, rows: [] },
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
  bandFamilyCases(add);
  momentumFamilyCases(add);
  trendFamilyCases(add);
  trendFamilyCases2(add);
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

// R2 step 2b: the bands family. Every study at its defaults on every
// input, small settings on the inputs with bars, every moving-average type
// where the study takes one, other columns, and every error.
const BAND_SMALL = {
  bollinger: [{ period: 5 }, { period: 4, stdDev: 1.5 }],
  bollingerBandwidth: [{ period: 5 }, { period: 4, stdDev: 1 }],
  bollingerPercentB: [{ period: 5 }, { period: 4, stdDev: 3 }],
  keltner: [
    { period: 5, atrPeriod: 3 },
    { period: 4, atrPeriod: 7, multiplier: 1.5 },
  ],
  starcBands: [
    { period: 5, atrPeriod: 3 },
    { period: 6, atrPeriod: 4, multiplier: 0.5 },
  ],
  atrBands: [{ period: 5 }, { period: 3, multiplier: 1.25 }],
  donchian: [{ period: 5 }, { period: 1 }],
  highLowBands: [{ period: 5 }, { period: 4, percent: 3 }],
  primeNumberBands: [{}],
  envelope: [{ period: 5 }, { period: 4, percent: 10 }],
};
const BAND_TYPE_OPTION = {
  keltner: 'maType',
  starcBands: 'maType',
  highLowBands: 'maType',
  envelope: 'maType',
};
const BAND_NUMBERS = {
  bollinger: ['stdDev'],
  bollingerBandwidth: ['stdDev'],
  bollingerPercentB: ['stdDev'],
  keltner: ['multiplier'],
  starcBands: ['multiplier'],
  atrBands: ['multiplier'],
  highLowBands: ['percent'],
  envelope: ['percent'],
};
const BAND_PERIODS = {
  bollinger: ['period'],
  bollingerBandwidth: ['period'],
  bollingerPercentB: ['period'],
  keltner: ['period', 'atrPeriod'],
  starcBands: ['period', 'atrPeriod'],
  atrBands: ['period'],
  donchian: ['period'],
  highLowBands: ['period'],
  primeNumberBands: [],
  envelope: ['period'],
};
// What each study reads: `column` or high / low / close (atrBands both).
const BAND_READS = {
  bollinger: ['column'],
  bollingerBandwidth: ['column'],
  bollingerPercentB: ['column'],
  keltner: ['high', 'low', 'close'],
  starcBands: ['high', 'low', 'close'],
  atrBands: ['column', 'high', 'low', 'close'],
  donchian: ['high', 'low'],
  highLowBands: ['high', 'low'],
  primeNumberBands: ['high', 'low'],
  envelope: ['column'],
};
const BAND_NAMING = {
  bollinger: 'prefix',
  keltner: 'prefix',
  starcBands: 'prefix',
  atrBands: 'prefix',
  donchian: 'prefix',
  highLowBands: 'prefix',
  primeNumberBands: 'prefix',
  envelope: 'prefix',
};

// One study family's cases: every study at its defaults on every input it
// can read, small settings, every moving-average type where it takes one,
// other columns, custom and colliding names, and every error.
function familyCases(add, F) {
  for (const [study, settings] of Object.entries(F.small)) {
    // Studies of price bars only take the inputs that have them.
    const bars = F.reads[study].some((r) => r !== 'column');
    const inputs = bars
      ? ['bars', 'ohlc', 'lead', 'ohlcEmpty']
      : ['bars', 'long', 'gappy', 'large', 'flat', 'tiny', 'empty', 'ohlc'];
    const smallInputs = bars
      ? ['bars', 'ohlc', 'lead']
      : ['bars', 'ohlc', 'lead', 'gappy', 'large', 'flat', 'tiny'];
    for (const input of inputs) add(study, input, {});
    const typeOption = F.typeOption[study];
    for (const [index, small] of settings.entries()) {
      for (const input of smallInputs) add(study, input, small);
      if (typeOption && index === 0) {
        for (const type of MA_TYPES) {
          add(study, 'bars', { ...small, [typeOption]: type });
          add(study, 'ohlc', { ...small, [typeOption]: type });
          add(study, 'lead', { ...small, [typeOption]: type });
        }
      }
    }
    const small = settings[0];
    // Other columns: the signed zeros of `open`, the prime ladder, a text
    // column and a missing one.
    for (const option of F.reads[study]) {
      for (const column of ['open', 'prime', 'name', 'nope']) {
        add(study, 'ohlc', { ...small, [option]: column });
      }
    }
    // Custom names, and names that collide.
    const naming = F.naming[study] ?? 'output';
    add(study, 'ohlc', { ...small, [naming]: 'x' });
    add(study, 'ohlc', { ...small, [naming]: 'close' });
    add(study, 'ohlc', { ...small, [naming]: 'time' });
    add(study, 'ohlc', { ...small, [naming]: '' });
    if (naming === 'prefix') {
      for (const prefix of ['m', 'u', 'l']) {
        add(study, 'ohlc', { ...small, prefix });
      }
    }
    // Periods that are not positive whole numbers, and multipliers or
    // percents that are not positive.
    for (const option of F.periods[study]) {
      for (const bad of [0, -1, 1.5]) {
        add(study, 'ohlc', { ...small, [option]: bad });
      }
    }
    for (const option of F.numbers[study] ?? []) {
      for (const bad of [0, -1])
        add(study, 'ohlc', { ...small, [option]: bad });
      add(study, 'ohlc', { ...small, [option]: 1e-9 });
    }
    if (typeOption) add(study, 'ohlc', { ...small, [typeOption]: 'nope' });
  }
}

function bandFamilyCases(add) {
  familyCases(add, {
    small: BAND_SMALL,
    reads: BAND_READS,
    typeOption: BAND_TYPE_OPTION,
    naming: BAND_NAMING,
    periods: BAND_PERIODS,
    numbers: BAND_NUMBERS,
  });
  // A long period on the 900 closes, and the true range's own columns
  // moved: atrBands' centre follows a moved close.
  add('bollinger', 'long', { period: 101, stdDev: 2.5 });
  add('envelope', 'long', { period: 50, maType: 'hull' });
  add('atrBands', 'ohlc', { period: 3, close: 'open' });
  add('atrBands', 'ohlc', { period: 3, close: 'open', column: 'close' });
  add('keltner', 'bars', { period: 50, atrPeriod: 30, maType: 'kama' });
  add('donchian', 'bars', { period: 60, high: 'close', low: 'open' });
}

// R2 step 2c: the momentum family (part 1).
function momentumFamilyCases(add) {
  const bar = ['high', 'low', 'close'];
  familyCases(add, {
    small: {
      rsi: [{ period: 5 }, { period: 2 }],
      stochastic: [
        { kPeriod: 5, slowing: 2, dPeriod: 2 },
        { kPeriod: 3, slowing: 1, dPeriod: 1 },
      ],
      stochasticMomentumIndex: [
        { period: 5, longPeriod: 4, shortPeriod: 2, signalPeriod: 2 },
        { period: 3, longPeriod: 1, shortPeriod: 1, signalPeriod: 1 },
      ],
      stochasticRsi: [
        { rsiPeriod: 5, stochPeriod: 4, kPeriod: 2, dPeriod: 2 },
        { rsiPeriod: 2, stochPeriod: 2, kPeriod: 1, dPeriod: 1 },
      ],
      williamsR: [{ period: 5 }, { period: 1 }],
      chandeMomentum: [{ period: 5 }, { period: 1 }],
      momentum: [{ period: 3 }, { period: 1 }],
      percentChange: [{ periods: 3 }, { periods: 1 }],
      intradayMomentumIndex: [{ period: 5 }, { period: 1 }],
      awesomeOscillator: [
        { fastPeriod: 3, slowPeriod: 7 },
        { fastPeriod: 1, slowPeriod: 2 },
      ],
      ultimateOscillator: [
        { shortPeriod: 2, mediumPeriod: 4, longPeriod: 8 },
        { shortPeriod: 1, mediumPeriod: 2, longPeriod: 3 },
      ],
    },
    reads: {
      rsi: ['column'],
      stochastic: bar,
      stochasticMomentumIndex: bar,
      stochasticRsi: ['column'],
      williamsR: bar,
      chandeMomentum: ['column'],
      momentum: ['column'],
      percentChange: ['column'],
      intradayMomentumIndex: ['open', 'close'],
      awesomeOscillator: ['high', 'low'],
      ultimateOscillator: bar,
    },
    typeOption: {},
    naming: {
      stochastic: 'prefix',
      stochasticMomentumIndex: 'prefix',
      stochasticRsi: 'prefix',
    },
    periods: {
      rsi: ['period'],
      stochastic: ['kPeriod', 'slowing', 'dPeriod'],
      stochasticMomentumIndex: [
        'period',
        'longPeriod',
        'shortPeriod',
        'signalPeriod',
      ],
      stochasticRsi: ['rsiPeriod', 'stochPeriod', 'kPeriod', 'dPeriod'],
      williamsR: ['period'],
      chandeMomentum: ['period'],
      momentum: ['period'],
      percentChange: ['periods'],
      intradayMomentumIndex: ['period'],
      awesomeOscillator: ['fastPeriod', 'slowPeriod'],
      ultimateOscillator: ['shortPeriod', 'mediumPeriod', 'longPeriod'],
    },
    numbers: {},
  });
  // Orders the periods must keep, the RSI's scratch column, and longer
  // settings on the 900 closes.
  add('awesomeOscillator', 'bars', { fastPeriod: 7, slowPeriod: 7 });
  add('awesomeOscillator', 'bars', { fastPeriod: 9, slowPeriod: 7 });
  for (const [s, m, l] of [
    [3, 3, 8],
    [2, 4, 4],
    [5, 4, 8],
  ]) {
    add('ultimateOscillator', 'bars', {
      shortPeriod: s,
      mediumPeriod: m,
      longPeriod: l,
    });
  }
  add('stochasticRsi', 'named', { rsiPeriod: 3, stochPeriod: 3 });
  add('stochasticRsi', 'named', { rsiPeriod: 3, prefix: 'z' });
  add('rsi', 'named', { period: 3 });
  add('rsi', 'long', { period: 50 });
  add('stochasticRsi', 'long', { rsiPeriod: 30, stochPeriod: 60 });
  add('chandeMomentum', 'long', { period: 101 });
  add('momentum', 'long', { period: 899 });
  add('momentum', 'long', { period: 900 });
  add('percentChange', 'long', { periods: 300 });

  // Part 2.
  familyCases(add, {
    small: {
      commodityChannelIndex: [{ period: 5 }, { period: 1 }],
      fisherTransform: [{ period: 5 }, { period: 1 }],
      psychologicalLine: [{ period: 5 }, { period: 1 }],
      prettyGoodOscillator: [{ period: 5 }, { period: 1 }],
      primeNumberOscillator: [{}],
      qstick: [{ period: 3 }, { period: 1 }],
      relativeVigorIndex: [{ period: 3 }, { period: 1 }],
      centerOfGravity: [{ period: 5 }, { period: 1 }],
      chandeForecastOscillator: [{ period: 5 }, { period: 2 }],
      trueStrengthIndex: [
        { longPeriod: 5, shortPeriod: 3, signalPeriod: 2 },
        { longPeriod: 1, shortPeriod: 1, signalPeriod: 1 },
      ],
    },
    reads: {
      commodityChannelIndex: bar,
      fisherTransform: ['high', 'low'],
      psychologicalLine: ['column'],
      prettyGoodOscillator: ['column', ...bar],
      primeNumberOscillator: ['column'],
      qstick: ['open', 'close'],
      relativeVigorIndex: ['open', ...bar],
      centerOfGravity: ['column'],
      chandeForecastOscillator: ['column'],
      trueStrengthIndex: ['column'],
    },
    typeOption: { qstick: 'maType' },
    naming: {
      fisherTransform: 'prefix',
      relativeVigorIndex: 'prefix',
      trueStrengthIndex: 'prefix',
    },
    periods: {
      commodityChannelIndex: ['period'],
      fisherTransform: ['period'],
      psychologicalLine: ['period'],
      prettyGoodOscillator: ['period'],
      primeNumberOscillator: [],
      qstick: ['period'],
      relativeVigorIndex: ['period'],
      centerOfGravity: ['period'],
      chandeForecastOscillator: ['period'],
      trueStrengthIndex: ['longPeriod', 'shortPeriod', 'signalPeriod'],
    },
    numbers: {},
  });
  // A one-bar regression, the oscillator's centre following a moved close,
  // the prime ladder, and longer settings on the 900 closes and the large
  // values (where the regression's running sums lose their low bits).
  add('chandeForecastOscillator', 'bars', { period: 1 });
  // Bars that never move (high = low = close) from the start: the true
  // range's average is exactly 0 under a column that does move.
  add('prettyGoodOscillator', 'flat', {
    period: 3,
    high: 'close',
    low: 'close',
    close: 'close',
    column: 'ramp',
  });
  add('prettyGoodOscillator', 'ohlc', { period: 3, close: 'open' });
  add('prettyGoodOscillator', 'ohlc', {
    period: 3,
    close: 'open',
    column: 'close',
  });
  add('primeNumberOscillator', 'ohlc', { column: 'prime' });
  add('fisherTransform', 'bars', { period: 40 });
  add('commodityChannelIndex', 'bars', { period: 50 });
  add('chandeForecastOscillator', 'long', { period: 101 });
  add('chandeForecastOscillator', 'large', { period: 3 });
  add('chandeForecastOscillator', 'large', { period: 14 });
  add('centerOfGravity', 'large', { period: 7 });
  add('trueStrengthIndex', 'long', { longPeriod: 60, shortPeriod: 30 });
}

// R2 step 2d: the trend family (part 1).
function trendFamilyCases(add) {
  const bar = ['high', 'low', 'close'];
  familyCases(add, {
    small: {
      directionalMovement: [{ period: 5 }, { period: 1 }],
      aroon: [{ period: 5 }, { period: 1 }],
      vortex: [{ period: 5 }, { period: 1 }],
      verticalHorizontalFilter: [{ period: 5 }, { period: 1 }],
      randomWalkIndex: [{ period: 5 }, { period: 2 }],
      superTrend: [
        { period: 3, multiplier: 1.5 },
        { period: 1, multiplier: 0.5 },
      ],
      parabolicSar: [
        { step: 0.05, maxStep: 0.3 },
        { step: 0.2, maxStep: 0.2 },
      ],
      atrTrailingStop: [
        { period: 3, multiplier: 1.5 },
        { period: 1, multiplier: 0.5 },
      ],
    },
    reads: {
      directionalMovement: bar,
      aroon: ['high', 'low'],
      vortex: bar,
      verticalHorizontalFilter: ['column'],
      randomWalkIndex: bar,
      superTrend: bar,
      parabolicSar: ['high', 'low'],
      atrTrailingStop: bar,
    },
    typeOption: {},
    naming: {
      directionalMovement: 'prefix',
      aroon: 'prefix',
      vortex: 'prefix',
      randomWalkIndex: 'prefix',
      superTrend: 'prefix',
      parabolicSar: 'prefix',
      atrTrailingStop: 'prefix',
    },
    periods: {
      directionalMovement: ['period'],
      aroon: ['period'],
      vortex: ['period'],
      verticalHorizontalFilter: ['period'],
      randomWalkIndex: ['period'],
      superTrend: ['period'],
      parabolicSar: [],
      atrTrailingStop: ['period'],
    },
    numbers: {
      superTrend: ['multiplier'],
      parabolicSar: ['step', 'maxStep'],
      atrTrailingStop: ['multiplier'],
    },
  });
  // A one-bar random walk (refused), a ceiling below the step (refused),
  // moved columns, and longer settings on
  // the 900 closes and the bars.
  add('randomWalkIndex', 'ohlc', { period: 1 });
  add('parabolicSar', 'ohlc', { step: 0.1, maxStep: 0.05 });
  add('superTrend', 'ohlc', { period: 3, close: 'open' });
  add('atrTrailingStop', 'ohlc', { period: 3, close: 'open' });
  add('aroon', 'bars', { period: 60, high: 'close', low: 'close' });
  add('parabolicSar', 'bars', { high: 'close', low: 'open' });
  add('directionalMovement', 'bars', { period: 30 });
  add('vortex', 'bars', { period: 40 });
  add('randomWalkIndex', 'bars', { period: 40 });
  add('verticalHorizontalFilter', 'long', { period: 101 });
  add('verticalHorizontalFilter', 'large', { period: 7 });
  add('superTrend', 'bars', { period: 30, multiplier: 2 });
  add('atrTrailingStop', 'bars', { period: 30, multiplier: 1 });
  // Inside bars after gaps, and prices that overflow.
  for (const study of [
    'directionalMovement',
    'aroon',
    'vortex',
    'randomWalkIndex',
    'superTrend',
    'parabolicSar',
    'atrTrailingStop',
  ]) {
    add(study, 'edge', {});
    add(
      study,
      'edge',
      study === 'parabolicSar' ? { step: 0.1, maxStep: 0.3 } : { period: 3 },
    );
  }
  add('verticalHorizontalFilter', 'edge', { period: 3, column: 'high' });
}

// R2 step 2d: the trend family (part 2).
function trendFamilyCases2(add) {
  const bar = ['high', 'low', 'close'];
  familyCases(add, {
    small: {
      zigZag: [{ deviation: 1 }, { deviation: 0.5 }],
      ichimoku: [
        { conversionPeriod: 3, basePeriod: 5, spanBPeriod: 8, displacement: 4 },
        { conversionPeriod: 1, basePeriod: 1, spanBPeriod: 1, displacement: 1 },
      ],
      elderImpulse: [
        { emaPeriod: 5, fastPeriod: 3, slowPeriod: 6, signalPeriod: 2 },
        { emaPeriod: 1, fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 },
      ],
      elderRay: [{ period: 5 }, { period: 1 }],
      trendIntensityIndex: [
        { period: 5, maPeriod: 8 },
        { period: 1, maPeriod: 1 },
      ],
      ravi: [
        { shortPeriod: 3, longPeriod: 8 },
        { shortPeriod: 1, longPeriod: 1 },
      ],
      swingIndex: [{ limit: 3 }, { limit: 0.5 }],
      accumulativeSwingIndex: [{ limit: 3 }, { limit: 0.5 }],
    },
    reads: {
      zigZag: ['high', 'low'],
      ichimoku: bar,
      elderImpulse: ['column'],
      elderRay: bar,
      trendIntensityIndex: ['column'],
      ravi: ['column'],
      swingIndex: ['open', ...bar],
      accumulativeSwingIndex: ['open', ...bar],
    },
    typeOption: {},
    naming: { zigZag: 'prefix', ichimoku: 'prefix', elderRay: 'prefix' },
    periods: {
      zigZag: [],
      ichimoku: [
        'conversionPeriod',
        'basePeriod',
        'spanBPeriod',
        'displacement',
      ],
      elderImpulse: ['emaPeriod', 'fastPeriod', 'slowPeriod', 'signalPeriod'],
      elderRay: ['period'],
      trendIntensityIndex: ['period', 'maPeriod'],
      ravi: ['shortPeriod', 'longPeriod'],
      swingIndex: [],
      accumulativeSwingIndex: [],
    },
    numbers: {
      zigZag: ['deviation'],
      swingIndex: ['limit'],
      accumulativeSwingIndex: ['limit'],
    },
  });
  // The fast MACD period not shorter than the slow, the MACD's scratch
  // column already on the series, a displacement that changes no value,
  // swings over many legs (the 900 closes as a line) and none, bars that
  // never move (the swing's span is 0 and the running total ends), an
  // inverted RAVI pair, and the edge bars.
  add('elderImpulse', 'ohlc', { fastPeriod: 26, slowPeriod: 12 });
  add('elderImpulse', 'ohlc', { fastPeriod: 12, slowPeriod: 12 });
  add('elderImpulse', 'named', {});
  add('elderImpulse', 'long', { emaPeriod: 30 });
  add('ichimoku', 'bars', { displacement: 1 });
  add('ichimoku', 'long', { high: 'close', low: 'close' });
  add('zigZag', 'long', { high: 'close', low: 'close', deviation: 2 });
  add('zigZag', 'long', { high: 'close', low: 'close', deviation: 0.1 });
  add('zigZag', 'bars', { deviation: 50 });
  add('zigZag', 'bars', { high: 'low', low: 'high', deviation: 1 });
  for (const study of ['swingIndex', 'accumulativeSwingIndex']) {
    add(study, 'flat', {
      limit: 1,
      open: 'close',
      high: 'close',
      low: 'close',
    });
    add(study, 'flat', { limit: 1, high: 'close', low: 'close' });
    add(study, 'bars', { limit: 1e-9 });
    add(study, 'edge', { limit: 2 });
  }
  add('ravi', 'long', { shortPeriod: 65, longPeriod: 7 });
  add('ravi', 'long', {});
  add('trendIntensityIndex', 'long', {});
  add('trendIntensityIndex', 'flat', { period: 3, maPeriod: 2 });
  for (const study of ['zigZag', 'ichimoku', 'elderRay']) {
    add(study, 'edge', {});
  }
  add('zigZag', 'edge', { deviation: 1 });
  add('ichimoku', 'edge', {
    conversionPeriod: 2,
    basePeriod: 3,
    spanBPeriod: 5,
  });
  // One-bar windows on the edge bars: a bar at 1.7e308 whose high plus
  // low overflows (the midpoint is then infinite, as pond-ts adds first).
  add('ichimoku', 'edge', {
    conversionPeriod: 1,
    basePeriod: 1,
    spanBPeriod: 2,
  });
  // A first swing of exactly the deviation, and a zero long average.
  add('zigZag', 'ties', { deviation: 25 });
  add('ravi', 'ties', { shortPeriod: 1, longPeriod: 2 });
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
