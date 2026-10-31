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
// The open jumps from 1e-300 to 1e300: a first log return of +Infinity
// (the price ratio overflows), which historical volatility skips as it
// skips a gap.
const TIE_ROWS = [
  [0, 100, 100, 1, 1e-300],
  [60_000, 125, 110, -1, 1e300],
  [120_000, 124, 112, 1, 2e300],
  [180_000, 120, 90, -1, 1.5e300],
  [240_000, 118, 100, 1, 3e300],
  [300_000, 116, 101, -1, 2.5e300],
];
// A close and elderImpulse's own scratch column (and no `__macdLine__`), so
// the refusal comes from the elder scratch alone.
const SCRATCH_ROWS = Array.from({ length: 40 }, (_, i) => [
  i * 60_000,
  50 + Math.sin(i / 4) * 3,
  i,
]);
const SCRATCH_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
  { name: '__elderMacd__Hist', kind: 'number' },
];
const LEAD_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'high', kind: 'number', required: false },
  { name: 'low', kind: 'number', required: false },
  { name: 'close', kind: 'number', required: false },
  { name: 'open', kind: 'number', required: false },
];

// Two columns for the two-column studies (beta, correlation, price
// relative, performance index): `close` a wave near 100 and `bench` one
// near 1e12 (the shifted frame's worst case), with gaps in each column on
// different rows; `bench` flat while `close` moves (rows 140-179) and the
// reverse (220-259); zeros in `bench` (300, 301) and in `close` (310);
// `step`, prices that plateau between 1% steps with a jitter of a few ulps
// (the windows the kernel fits again on demand); `twin` = 3 x close and
// `mirror` = 7 - 2 x close (a correlation that rounds past +1 or -1);
// `small` / `smallStep` and `big` / `bigStep` (close and step scaled by
// 1e-100 and 1e100: the product of two variances underflows to 0 or
// overflows to infinity, where each variance does not); and `stepTwin` =
// 3 x step + 1.
const PAIR_ROWS = Array.from({ length: 400 }, (_, i) => {
  let close = 100 + Math.sin(i / 5) * 4 + unit(i, 69069) * 2;
  let bench = 1e12 + Math.cos(i / 7) * 3 + unit(i, 40503);
  if (i >= 140 && i < 180) bench = 1e12;
  if (i >= 220 && i < 260) close = 101.5;
  if (i === 300 || i === 301) bench = 0;
  if (i === 310) close = 0;
  const step = 100 * 1.01 ** Math.floor(i / 37) + (i % 3) * 2 ** -40;
  const gapClose = i === 50 || i === 51 || i === 120;
  const gapBench = i === 80 || (i >= 200 && i < 206);
  return [
    i * 60_000,
    gapClose ? null : close,
    gapBench ? null : bench,
    step,
    gapClose ? null : close * 3,
    gapClose ? null : 7 - 2 * close,
    i % 2 === 0 ? 'a' : 'b',
    gapClose ? null : close * 1e-100,
    step * 1e-100,
    gapClose ? null : close * 1e100,
    step * 1e100,
    step * 3 + 1,
  ];
});
const PAIR_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number', required: false },
  { name: 'bench', kind: 'number', required: false },
  { name: 'step', kind: 'number' },
  { name: 'twin', kind: 'number', required: false },
  { name: 'mirror', kind: 'number', required: false },
  { name: 'name', kind: 'string' },
  { name: 'small', kind: 'number', required: false },
  { name: 'smallStep', kind: 'number' },
  { name: 'big', kind: 'number', required: false },
  { name: 'bigStep', kind: 'number' },
  { name: 'stepTwin', kind: 'number' },
];

// Price bars with volume for the volume family: whole bars missing at
// rows 0-2 (the running totals start late), a gap in the close only (7),
// the high only (12), the low only (19), the volume only (25-26), whole
// bars (40-44), a stretch where high = low = close and the close does not
// change (60-69: no range, no change), zero volume (80-81), a close of 0
// (110: the next percent change is a gap), signed zeros in `open`, a
// `prime` column of the prime ladder and a text column.
const VOL_ROWS = (() => {
  let price = 50;
  return Array.from({ length: 120 }, (_, i) => {
    const flat = i >= 60 && i < 70;
    if (!flat) price += (unit(i + 11, 2654435761) - 0.5) * 2;
    const spread = flat ? 0 : 0.25 + unit(i, 40503) * 1.5;
    const whole = i < 3 || (i >= 40 && i < 45);
    const high = whole || i === 12 ? null : price + spread;
    const low = whole || i === 19 ? null : price - spread;
    let close =
      whole || i === 7 ? null : price + (unit(i, 69069) - 0.5) * spread;
    if (i === 110) close = 0;
    const volume =
      whole || i === 25 || i === 26
        ? null
        : i === 80 || i === 81
          ? 0
          : 1000 + Math.round(unit(i, 1103515245) * 900);
    const open = i % 4 === 0 ? -0 : i % 4 === 2 ? 0 : price;
    return [
      i * 60_000,
      open,
      high,
      low,
      close,
      volume,
      PRIME_VALUES[i % PRIME_VALUES.length],
      i % 2 === 0 ? 'a' : 'b',
    ];
  });
})();
const VOL_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number', required: false },
  { name: 'low', kind: 'number', required: false },
  { name: 'close', kind: 'number', required: false },
  { name: 'volume', kind: 'number', required: false },
  { name: 'prime', kind: 'number' },
  { name: 'name', kind: 'string' },
];
const VOL_EMPTY_SCHEMA = VOL_SCHEMA.filter((c) => c.name !== 'name');

// Closes that move by exactly 0.5 (exact in binary) against the last
// decisive move, both ways, for the trade volume index's dead band.
const TICK_CLOSES = [10, 11, 10.5, 11, 10, 10.5, 11.5, 11];
const TICK_ROWS = TICK_CLOSES.map((close, i) => [
  i * 60_000,
  close,
  100 * (i + 1),
]);
// Thirty-minute bars on a New York clock, 08:00 to 17:00 local, every day
// from 2024-01-08 to 2024-01-17 (so weekend and pre- and post-market bars
// fall in closed time, and 2024-01-15 is the calendar's holiday). The
// 09:30 bar on the 8th has no high (a leading gap), the 13:00 bar on the
// 9th no close (an interior gap), the 10th has one bar without a low, the
// 11th has no bars in session at all, the 12th opens on three bars of zero
// volume, and the 16th has no highs. `sid` is a session-id column (the
// date as a number in session, a gap outside); `name` is text; `S4`
// collides with an empty pivot prefix.
const SESSION_ROWS = (() => {
  const rows = [];
  let price = 470;
  for (let d = 8; d <= 17; d += 1) {
    for (let k = 0; k < 19; k += 1) {
      const minutes = 8 * 60 + k * 30; // local, EST = UTC-5
      const t = Date.UTC(2024, 0, d, 5) + minutes * 60_000;
      const inSession = minutes >= 570 && minutes < 960;
      const weekday = new Date(Date.UTC(2024, 0, d)).getUTCDay();
      const trading = weekday >= 1 && weekday <= 5 && d !== 15;
      if (d === 11 && inSession) continue;
      price += (unit(d * 19 + k + 3, 2654435761) - 0.5) * 2;
      const spread = 0.2 + unit(d * 19 + k, 40503);
      let high = price + spread;
      let low = price - spread;
      let close = price + (unit(d * 19 + k, 69069) - 0.5) * spread;
      let volume = 1000 + Math.round(unit(d * 19 + k, 48271) * 4000);
      if (d === 8 && minutes === 570) high = null;
      if (d === 9 && minutes === 780) close = null;
      if (d === 10 && minutes === 690) low = null;
      if (d === 12 && minutes >= 570 && minutes < 660) volume = 0;
      if (d === 16) high = null;
      rows.push([
        t,
        price,
        high,
        low,
        close,
        volume,
        inSession && trading ? 20240100 + d : null,
        k % 2 === 0 ? 'a' : 'b',
        k,
      ]);
    }
  }
  return rows;
})();
// The same bars from the first session's close on (Jan 8, 16:00 New York):
// under close stamping the first bar belongs to a session that opened
// before the series. Jan 12's ids reuse Jan 9's, so an id comes back
// after another (A, B, A).
const SESSION_LATE_ROWS = SESSION_ROWS.filter(
  (r) => r[0] >= Date.UTC(2024, 0, 8, 21),
).map((r) =>
  r[6] === 20240112 ? [...r.slice(0, 6), 20240109, ...r.slice(7)] : r,
);
const SESSION_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'open', kind: 'number' },
  { name: 'high', kind: 'number', required: false },
  { name: 'low', kind: 'number', required: false },
  { name: 'close', kind: 'number', required: false },
  { name: 'volume', kind: 'number' },
  { name: 'sid', kind: 'number', required: false },
  { name: 'name', kind: 'string' },
  { name: 'S4', kind: 'number' },
];

const TICK_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'close', kind: 'number' },
  { name: 'volume', kind: 'number' },
];

// Bars that overflow: row 5's close is far below a bar that is itself
// near the largest double, so where it sits in the bar (and that times
// the volume) is -Infinity; everything else is ordinary.
const BLOWUP_ROWS = Array.from({ length: 12 }, (_, i) => {
  const t = i * 60_000;
  if (i === 5) return [t, 1.5e308, 1.4e308, -1.7e308, 1000];
  const price = 30 + Math.sin(i) * 2;
  return [t, price + 1, price - 1, price + Math.cos(i) / 2, 900 + i * 10];
});
const BLOWUP_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'high', kind: 'number' },
  { name: 'low', kind: 'number' },
  { name: 'close', kind: 'number' },
  { name: 'volume', kind: 'number' },
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
    scratch: { name: 'scratch', schema: SCRATCH_SCHEMA, rows: SCRATCH_ROWS },
    pair: { name: 'pair', schema: PAIR_SCHEMA, rows: PAIR_ROWS },
    vol: { name: 'vol', schema: VOL_SCHEMA, rows: VOL_ROWS },
    blowup: { name: 'blowup', schema: BLOWUP_SCHEMA, rows: BLOWUP_ROWS },
    volEmpty: { name: 'volEmpty', schema: VOL_EMPTY_SCHEMA, rows: [] },
    ticks: { name: 'ticks', schema: TICK_SCHEMA, rows: TICK_ROWS },
    sessions: { name: 'sessions', schema: SESSION_SCHEMA, rows: SESSION_ROWS },
    sessionsLate: {
      name: 'sessionsLate',
      schema: SESSION_SCHEMA,
      rows: SESSION_LATE_ROWS,
    },
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
  volatilityFamilyCases(add);
  statisticsFamilyCases(add);
  volumeFamilyCases(add);
  volumeFamilyCases2(add);
  priceFamilyCases(add);
  sessionFamilyCases(add);
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
    const inputs =
      F.inputs ??
      (bars
        ? ['bars', 'ohlc', 'lead', 'ohlcEmpty']
        : ['bars', 'long', 'gappy', 'large', 'flat', 'tiny', 'empty', 'ohlc']);
    const smallInputs =
      F.smallInputs ??
      (bars
        ? ['bars', 'ohlc', 'lead']
        : ['bars', 'ohlc', 'lead', 'gappy', 'large', 'flat', 'tiny']);
    const other = F.otherInput ?? 'ohlc';
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
        add(study, other, { ...small, [option]: column });
      }
    }
    // Custom names, and names that collide.
    const naming = F.naming[study] ?? 'output';
    add(study, other, { ...small, [naming]: 'x' });
    add(study, other, { ...small, [naming]: 'close' });
    add(study, other, { ...small, [naming]: 'time' });
    add(study, other, { ...small, [naming]: '' });
    if (naming === 'prefix') {
      for (const prefix of ['m', 'u', 'l']) {
        add(study, other, { ...small, prefix });
      }
    }
    // Periods that are not positive whole numbers, and multipliers or
    // percents that are not positive.
    for (const option of F.periods[study]) {
      for (const bad of [0, -1, 1.5]) {
        add(study, other, { ...small, [option]: bad });
      }
    }
    for (const option of F.numbers[study] ?? []) {
      for (const bad of [0, -1]) add(study, other, { ...small, [option]: bad });
      add(study, other, { ...small, [option]: 1e-9 });
    }
    if (typeOption) add(study, other, { ...small, [typeOption]: 'nope' });
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
  // elderImpulse refuses its MACD scratch column; elderRay and RAVI on the
  // same series succeed (the column is not theirs).
  add('elderImpulse', 'scratch', {
    emaPeriod: 3,
    fastPeriod: 2,
    slowPeriod: 4,
  });
  add('ravi', 'scratch', { shortPeriod: 2, longPeriod: 5 });
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

// A `sessions` option written as `{ rules, from, to }` stands for the
// TradingCalendar those rules give (a calendar is not JSON); a session list
// is passed as it is.
function decodeOptions(financial, options) {
  const sessions = options.sessions;
  if (sessions && !Array.isArray(sessions) && sessions.rules) {
    return {
      ...options,
      sessions: financial.TradingCalendar.fromRules(sessions.rules, {
        from: sessions.from,
        to: sessions.to,
      }),
    };
  }
  return options;
}

function run(pond, financial, series, c) {
  try {
    const result = financial[c.study](
      series,
      decodeOptions(financial, c.options),
    );
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

function volatilityFamilyCases(add) {
  const bar = ['high', 'low', 'close'];
  familyCases(add, {
    small: {
      atr: [{ period: 3 }, { period: 1 }],
      historicalVolatility: [
        { period: 3, annualize: 1 },
        { period: 1, annualize: 0.5 },
      ],
      chaikinVolatility: [
        { period: 3, rocPeriod: 2 },
        { period: 1, rocPeriod: 1 },
      ],
      massIndex: [
        { emaPeriod: 3, sumPeriod: 4 },
        { emaPeriod: 1, sumPeriod: 1 },
      ],
      choppinessIndex: [{ period: 3 }, { period: 2 }],
      gopalakrishnanRangeIndex: [{ period: 3 }, { period: 2 }],
      ulcerIndex: [{ period: 3 }, { period: 1 }],
      relativeVolatilityIndex: [
        { period: 3, stdevPeriod: 4 },
        { period: 1, stdevPeriod: 1 },
      ],
    },
    reads: {
      atr: bar,
      historicalVolatility: ['column'],
      chaikinVolatility: ['high', 'low'],
      massIndex: ['high', 'low'],
      choppinessIndex: bar,
      gopalakrishnanRangeIndex: ['high', 'low'],
      ulcerIndex: ['column'],
      relativeVolatilityIndex: ['column'],
    },
    typeOption: {},
    naming: {},
    periods: {
      atr: ['period'],
      historicalVolatility: ['period'],
      chaikinVolatility: ['period', 'rocPeriod'],
      massIndex: ['emaPeriod', 'sumPeriod'],
      choppinessIndex: ['period'],
      gopalakrishnanRangeIndex: ['period'],
      ulcerIndex: ['period'],
      relativeVolatilityIndex: ['period', 'stdevPeriod'],
    },
    numbers: { historicalVolatility: ['annualize'] },
  });
  // Period 1 where a logarithm of it divides; prices at or below zero
  // (zeros, a ramp from 0, the edge bars' -1.7e308) and leading gaps for
  // the log returns; flat bars, where ranges, EMAs and spans are 0; a
  // window of only new highs (the ulcer index's exact 0) and of a peak of
  // 0; unchanged closes (the relative volatility index counts them as
  // down); bars flat while the close moves (the choppiness span is 0 but
  // its true-range sum is not); and the edge bars.
  add('choppinessIndex', 'bars', { period: 1 });
  add('gopalakrishnanRangeIndex', 'bars', { period: 1 });
  add('historicalVolatility', 'flat', { column: 'open' });
  add('historicalVolatility', 'flat', { column: 'ramp', period: 5 });
  add('historicalVolatility', 'lead', { period: 5 });
  add('historicalVolatility', 'long', {});
  add('historicalVolatility', 'tiny', { period: 1 });
  for (const study of ['chaikinVolatility', 'massIndex']) {
    add(study, 'flat', { high: 'close', low: 'close', period: 3 });
    add(study, 'lead', {});
    add(study, 'long', { high: 'close', low: 'open' });
  }
  add('choppinessIndex', 'flat', {
    high: 'close',
    low: 'close',
    close: 'ramp',
    period: 4,
  });
  add('choppinessIndex', 'lead', {});
  add('gopalakrishnanRangeIndex', 'flat', { high: 'close', low: 'close' });
  add('gopalakrishnanRangeIndex', 'lead', {});
  add('historicalVolatility', 'ties', { column: 'open', period: 2 });
  add('ulcerIndex', 'flat', { column: 'ramp', period: 4 });
  add('ulcerIndex', 'flat', { column: 'open', period: 4 });
  add('ulcerIndex', 'named', { period: 3 });
  add('ulcerIndex', 'long', {});
  add('relativeVolatilityIndex', 'flat', { period: 3, stdevPeriod: 3 });
  add('relativeVolatilityIndex', 'long', {});
  add('atr', 'lead', {});
  for (const study of [
    'atr',
    'historicalVolatility',
    'chaikinVolatility',
    'massIndex',
    'choppinessIndex',
    'gopalakrishnanRangeIndex',
    'ulcerIndex',
    'relativeVolatilityIndex',
  ]) {
    add(study, 'edge', {});
    add(
      study,
      'edge',
      study === 'massIndex' ? { emaPeriod: 2, sumPeriod: 3 } : { period: 3 },
    );
  }
}

// R2 step 2e part 2: the statistics family. The two regression studies go
// through `familyCases`; the four two-column studies need a benchmark on
// every call, so they get their own list: each input with a second number
// column, every small setting, then every error in pond-ts's order.
function statisticsFamilyCases(add) {
  familyCases(add, {
    small: {
      linearRegression: [{ period: 3 }, { period: 2 }],
      timeSeriesForecast: [{ period: 3 }, { period: 2 }],
    },
    reads: { linearRegression: ['column'], timeSeriesForecast: ['column'] },
    typeOption: {},
    naming: { linearRegression: 'prefix' },
    periods: { linearRegression: ['period'], timeSeriesForecast: ['period'] },
    numbers: {},
  });
  for (const study of ['linearRegression', 'timeSeriesForecast']) {
    add(study, 'bars', { period: 1 });
    add(study, 'flat', { period: 5, column: 'open' });
    add(study, 'flat', { period: 30, column: 'ramp' });
    add(study, 'long', { period: 101 });
    add(study, 'pair', { column: 'step', period: 30 });
    add(study, 'pair', { column: 'bench' });
    add(study, 'edge', {});
    add(study, 'edge', { period: 3 });
  }
  const small = {
    beta: [{ period: 3 }, { period: 2 }],
    correlation: [{ period: 5 }, { period: 2 }],
    priceRelative: [{}],
    performanceIndex: [{ period: 3 }, { period: 1 }],
  };
  const pairs = [
    ['bars', {}, 'open'],
    ['bars', {}, 'volume'],
    ['gappy', {}, 'volume'],
    ['large', {}, 'open'],
    ['flat', {}, 'open'],
    ['flat', {}, 'ramp'],
    ['flat', { column: 'ramp' }, 'open'],
    ['ohlc', {}, 'open'],
    ['ohlc', {}, 'prime'],
    ['lead', {}, 'open'],
    ['edge', {}, 'open'],
    ['ties', {}, 'open'],
    ['pair', {}, 'bench'],
    ['pair', {}, 'twin'],
    ['pair', {}, 'mirror'],
    ['pair', { column: 'step' }, 'bench'],
    ['pair', { column: 'step' }, 'close'],
    ['pair', { column: 'bench' }, 'step'],
    ['pair', { column: 'small' }, 'smallStep'],
    ['pair', { column: 'big' }, 'bigStep'],
    ['pair', { column: 'step' }, 'stepTwin'],
  ];
  for (const [study, settings] of Object.entries(small)) {
    for (const [input, extra, benchmark] of pairs) {
      add(study, input, { ...extra, benchmark });
      for (const s of settings)
        add(study, input, { ...extra, ...s, benchmark });
    }
    const first = { ...settings[0], benchmark: 'bench' };
    add(study, 'pair', { ...first, period: 30 });
    add(study, 'tiny', { benchmark: 'open' });
    add(study, 'empty', { benchmark: 'open' });
    add(study, 'ohlcEmpty', { benchmark: 'open' });
    // The benchmark: the column itself (named or by default), missing, the
    // key, a text or true/false column; then the output and the column.
    add(study, 'pair', { ...first, benchmark: 'close' });
    add(study, 'pair', { ...first, column: 'step', benchmark: 'step' });
    add(study, 'pair', { ...first, benchmark: 'close', output: 'close' });
    add(study, 'pair', { ...first, benchmark: 'nope' });
    add(study, 'pair', { ...first, benchmark: 'nope', output: 'close' });
    add(study, 'pair', { ...first, benchmark: 'time' });
    add(study, 'pair', { ...first, benchmark: 'name' });
    add(study, 'gappy', { ...first, benchmark: 'flag' });
    for (const output of ['x', 'close', 'bench', 'time', '']) {
      add(study, 'pair', { ...first, output });
    }
    add(study, 'pair', { ...first, column: 'nope' });
    add(study, 'pair', { ...first, column: 'name' });
    add(study, 'pair', { ...first, column: 'nope', output: 'close' });
    if (study !== 'priceRelative') {
      for (const period of [0, -1, 1.5])
        add(study, 'pair', { ...first, period });
      add(study, 'pair', { ...first, period: 0, benchmark: 'close' });
      add(study, 'pair', { ...first, period: 500 });
    }
  }
  for (const study of ['beta', 'correlation']) {
    add(study, 'pair', { benchmark: 'bench', period: 1 });
    add(study, 'pair', { benchmark: 'close', period: 1 });
  }
}

// R2 step 2f part 1: the volume family's first nine studies, on the bars
// (oracle prices and volume) and the `vol` bars; other columns, names and
// periods on `vol`; then the edges: the `edge` and `ties` bars with their
// open as the volume (overflowing products), a flat close, and the
// moving-average types and bad scales of ease of movement.
function volumeFamilyCases(add) {
  const all = ['high', 'low', 'close', 'volume'];
  const cv = ['close', 'volume'];
  familyCases(add, {
    inputs: ['bars', 'vol', 'volEmpty'],
    smallInputs: ['bars', 'vol'],
    otherInput: 'vol',
    small: {
      obv: [{}],
      accumulationDistribution: [{}],
      priceVolumeTrend: [{}],
      chaikinMoneyFlow: [{ period: 3 }, { period: 1 }],
      chaikinOscillator: [
        { fastPeriod: 2, slowPeriod: 4 },
        { fastPeriod: 1, slowPeriod: 2 },
      ],
      moneyFlowIndex: [{ period: 3 }, { period: 1 }],
      twiggsMoneyFlow: [{ period: 3 }, { period: 1 }],
      forceIndex: [{ period: 3 }, { period: 1 }],
      easeOfMovement: [{ period: 3 }, { period: 1, scale: 1 }],
    },
    reads: {
      obv: cv,
      accumulationDistribution: all,
      priceVolumeTrend: cv,
      chaikinMoneyFlow: all,
      chaikinOscillator: all,
      moneyFlowIndex: all,
      twiggsMoneyFlow: all,
      forceIndex: cv,
      easeOfMovement: ['high', 'low', 'volume'],
    },
    typeOption: { easeOfMovement: 'maType' },
    naming: {},
    periods: {
      obv: [],
      accumulationDistribution: [],
      priceVolumeTrend: [],
      chaikinMoneyFlow: ['period'],
      chaikinOscillator: ['fastPeriod', 'slowPeriod'],
      moneyFlowIndex: ['period'],
      twiggsMoneyFlow: ['period'],
      forceIndex: ['period'],
      easeOfMovement: ['period'],
    },
    numbers: { easeOfMovement: ['scale'] },
  });
  for (const study of [
    'obv',
    'accumulationDistribution',
    'priceVolumeTrend',
    'chaikinMoneyFlow',
    'chaikinOscillator',
    'moneyFlowIndex',
    'twiggsMoneyFlow',
    'forceIndex',
    'easeOfMovement',
  ]) {
    add(study, 'edge', { volume: 'open' });
    add(study, 'ties', { volume: 'open' });
    add(study, 'lead', { volume: 'open' });
    add(study, 'vol', { volume: 'open' });
    add(study, 'vol', { volume: 'prime' });
    add(study, 'vol', { high: 'close', low: 'close' });
    // A bar with no range whose close is a gap (row 7), and the bars
    // that overflow.
    add(study, 'vol', { high: 'prime', low: 'prime' });
    add(study, 'blowup', {});
    add(
      study,
      'blowup',
      study === 'chaikinOscillator'
        ? { fastPeriod: 2, slowPeriod: 3 }
        : { period: 3 },
    );
  }
  // A close before the first volume (the volume is the close, whose rows
  // 0-2 and 7 are gaps; the close is the open, never a gap).
  add('obv', 'vol', { close: 'open', volume: 'close' });
  // The `gappy` closes: rows 0-2 missing and row 3's volume missing, so
  // the first complete row is 4.
  for (const study of ['obv', 'priceVolumeTrend', 'forceIndex']) {
    add(study, 'gappy', {});
  }
  // Zero volume (rows 80-81) under every moving-average type.
  for (const maType of MA_TYPES) {
    add('easeOfMovement', 'vol', { period: 3, maType });
  }
  add('chaikinOscillator', 'vol', { fastPeriod: 4, slowPeriod: 4 });
  add('chaikinOscillator', 'vol', { fastPeriod: 5, slowPeriod: 4 });
  add('chaikinOscillator', 'vol', { fastPeriod: 0, slowPeriod: 0 });
  add('chaikinMoneyFlow', 'bars', { period: 50 });
  add('moneyFlowIndex', 'bars', { period: 50 });
  add('twiggsMoneyFlow', 'vol', { period: 200 });
  for (const scale of [Number.MAX_VALUE, 1e-300, 2.5]) {
    add('easeOfMovement', 'vol', { period: 3, scale });
  }
  add('easeOfMovement', 'vol', { period: 0, maType: 'nope' });
}

// R2 step 2f part 2: the rest of the volume family (anchored VWAP waits
// for the calendars).
function volumeFamilyCases2(add) {
  const all = ['high', 'low', 'close', 'volume'];
  const cv = ['column', 'volume'];
  familyCases(add, {
    inputs: ['bars', 'vol', 'volEmpty'],
    smallInputs: ['bars', 'vol', 'volEmpty'],
    otherInput: 'vol',
    small: {
      klinger: [
        { fastPeriod: 3, slowPeriod: 5, signalPeriod: 2 },
        { fastPeriod: 1, slowPeriod: 2, signalPeriod: 1 },
      ],
      volumeOscillator: [
        { fastPeriod: 2, slowPeriod: 4 },
        { fastPeriod: 1, slowPeriod: 2 },
      ],
      tradeVolumeIndex: [{ minTick: 0.01 }, { minTick: 0.5 }],
      negativeVolumeIndex: [{}, { start: 1 }],
      positiveVolumeIndex: [{}, { start: 1 }],
      marketFacilitationIndex: [{}],
      shinoharaIntensityRatio: [{ period: 3 }, { period: 1 }],
      vwap: [{ period: 3 }, { period: 1 }],
    },
    reads: {
      klinger: all,
      volumeOscillator: ['volume'],
      tradeVolumeIndex: cv,
      negativeVolumeIndex: cv,
      positiveVolumeIndex: cv,
      marketFacilitationIndex: ['high', 'low', 'volume'],
      shinoharaIntensityRatio: ['open', 'high', 'low', 'close'],
      vwap: all,
    },
    typeOption: { volumeOscillator: 'maType' },
    naming: { klinger: 'prefix', shinoharaIntensityRatio: 'prefix' },
    periods: {
      klinger: ['fastPeriod', 'slowPeriod', 'signalPeriod'],
      volumeOscillator: ['fastPeriod', 'slowPeriod'],
      tradeVolumeIndex: [],
      negativeVolumeIndex: [],
      positiveVolumeIndex: [],
      marketFacilitationIndex: [],
      shinoharaIntensityRatio: ['period'],
      vwap: ['period'],
    },
    numbers: {
      tradeVolumeIndex: ['minTick'],
      negativeVolumeIndex: ['start'],
      positiveVolumeIndex: ['start'],
    },
  });
  const base = {
    klinger: { fastPeriod: 3, slowPeriod: 5, signalPeriod: 2 },
    volumeOscillator: { fastPeriod: 2, slowPeriod: 4 },
    tradeVolumeIndex: { minTick: 0.01 },
    negativeVolumeIndex: {},
    positiveVolumeIndex: {},
    marketFacilitationIndex: {},
    shinoharaIntensityRatio: { period: 3 },
    vwap: { period: 3 },
  };
  for (const [study, small] of Object.entries(base)) {
    for (const input of ['edge', 'ties', 'lead']) {
      add(study, input, { ...small, volume: 'open' });
    }
    add(study, 'vol', { ...small, volume: 'open' });
    add(study, 'vol', { ...small, volume: 'prime' });
    if (study !== 'volumeOscillator') {
      add(study, 'vol', { ...small, high: 'close', low: 'close' });
      add(study, 'vol', { ...small, high: 'prime', low: 'prime' });
    }
    add(study, 'blowup', small);
    add(study, 'gappy', small);
  }
  // Leading gaps in the volume only (it is the close: rows 0-2, 7), and
  // an interior gap in the price only.
  for (const study of [
    'tradeVolumeIndex',
    'negativeVolumeIndex',
    'positiveVolumeIndex',
  ]) {
    const small = base[study];
    add(study, 'vol', { ...small, column: 'open', volume: 'close' });
    add(study, 'vol', { ...small, column: 'prime', volume: 'close' });
    add(study, 'gappy', { ...small, volume: 'close' });
  }
  // A tick no move beats, and the trade volume index with no tick.
  // Moves of exactly the tick do not change the direction: 0.5 both ways
  // after a decisive move the other way, and the prime ladder's fall from
  // 2^53 - 111 to 2^53 - 112 while rising (the ladder is its own volume;
  // the open is 0 on that row).
  add('tradeVolumeIndex', 'ticks', { minTick: 0.5 });
  add('tradeVolumeIndex', 'ticks', { minTick: 0.25 });
  add('tradeVolumeIndex', 'vol', {
    minTick: 1,
    column: 'prime',
    volume: 'prime',
  });
  add('tradeVolumeIndex', 'vol', { minTick: 1e9 });
  add('tradeVolumeIndex', 'vol', {});
  add('tradeVolumeIndex', 'vol', { minTick: Number.MAX_VALUE });
  for (const start of [Number.MAX_VALUE, 1e-300, 2.5]) {
    add('negativeVolumeIndex', 'vol', { start });
    add('positiveVolumeIndex', 'vol', { start });
  }
  add('negativeVolumeIndex', 'vol', { start: 0, output: 'close' });
  // fast must be shorter than slow, checked before the periods.
  for (const study of ['klinger', 'volumeOscillator']) {
    add(study, 'vol', { ...base[study], fastPeriod: 4, slowPeriod: 4 });
    add(study, 'vol', { ...base[study], fastPeriod: 5, slowPeriod: 4 });
    add(study, 'vol', { ...base[study], fastPeriod: 0, slowPeriod: 0 });
    add(study, 'vol', { ...base[study], fastPeriod: 0, slowPeriod: 4 });
  }
  add('klinger', 'bars', {});
  add('klinger', 'vol', { fastPeriod: 2, slowPeriod: 3, signalPeriod: 0 });
  for (const maType of MA_TYPES) {
    add('volumeOscillator', 'vol', { fastPeriod: 2, slowPeriod: 4, maType });
  }
  add('vwap', 'vol', {});
  add('vwap', 'bars', { period: 50 });
  add('shinoharaIntensityRatio', 'bars', { period: 50 });
  add('shinoharaIntensityRatio', 'vol', { period: 1, open: 'close' });
}

// R2 step 2g: the price family.
function priceFamilyCases(add) {
  const hlc = ['high', 'low', 'close'];
  const ohlc = ['open', 'high', 'low', 'close'];
  familyCases(add, {
    small: {
      typicalPrice: [{}],
      medianPrice: [{}],
      weightedClose: [{}],
      averagePrice: [{}],
      balanceOfPower: [{ period: 3 }, { period: 1 }, {}],
    },
    reads: {
      typicalPrice: hlc,
      medianPrice: hlc,
      weightedClose: hlc,
      averagePrice: ohlc,
      balanceOfPower: ohlc,
    },
    typeOption: { balanceOfPower: 'maType' },
    numbers: {},
    naming: {},
    periods: {
      typicalPrice: [],
      medianPrice: [],
      weightedClose: [],
      averagePrice: [],
      balanceOfPower: ['period'],
    },
  });
  for (const study of [
    'typicalPrice',
    'medianPrice',
    'weightedClose',
    'averagePrice',
    'balanceOfPower',
  ]) {
    for (const input of ['edge', 'ties', 'vol', 'blowup'])
      add(study, input, {});
    // Bars with no range (and a gap in the close on row 7).
    add(study, 'vol', { high: 'close', low: 'close' });
    add(study, 'vol', { high: 'prime', low: 'prime' });
  }
  // The open read first: a missing open beats a missing high.
  add('averagePrice', 'bars', { open: 'nope', high: 'nope2' });
  add('balanceOfPower', 'bars', { open: 'nope', high: 'nope2' });
  // A type needs a period; the period is checked first.
  add('balanceOfPower', 'ohlc', { maType: 'ema' });
  add('balanceOfPower', 'ohlc', { maType: 'sma' });
  add('balanceOfPower', 'ohlc', { period: 0, maType: 'ema' });
  add('balanceOfPower', 'vol', { period: 3, high: 'close', low: 'close' });
  for (const maType of MA_TYPES) {
    add('balanceOfPower', 'vol', { period: 3, maType });
  }
  add('balanceOfPower', 'bars', { period: 50, maType: 'kama' });
}

const NYSE_JAN = {
  rules: {
    timeZone: 'America/New_York',
    open: '09:30',
    close: '16:00',
    holidays: ['2024-01-15'],
  },
  from: '2024-01-08',
  to: '2024-01-17',
};
// The same sessions written out (09:30-16:00 EST is 14:30-21:00 UTC), the
// 10th with a lunch break (breaks do not split a session).
const jan = (d, breaks) => ({
  date: `2024-01-${String(d).padStart(2, '0')}`,
  open: Date.UTC(2024, 0, d, 14, 30),
  close: Date.UTC(2024, 0, d, 21),
  ...(breaks ? { breaks } : {}),
});
const LIST = [
  jan(8),
  jan(9),
  jan(10, [
    { start: Date.UTC(2024, 0, 10, 17), end: Date.UTC(2024, 0, 10, 18) },
  ]),
  jan(11),
  jan(12),
  jan(16),
  jan(17),
];
const LIST_UNSORTED = [jan(12), jan(8), jan(16), jan(9)];
const LIST_OVERLAP = [jan(8), { ...jan(9), open: Date.UTC(2024, 0, 8, 20) }];
const PIVOT_METHODS_LIST = ['standard', 'fibonacci', 'woodie', 'camarilla'];

function sessionFamilyCases(add) {
  const doors = [
    { sessions: NYSE_JAN },
    { sessions: NYSE_JAN, stamped: 'close' },
    { sessions: NYSE_JAN, stamped: 'open' },
    { sessions: LIST },
    { sessions: LIST, stamped: 'close' },
    { sessions: LIST_UNSORTED },
    { sessions: [] },
    { session: 'sid' },
  ];
  const wrong = [
    {},
    { sessions: NYSE_JAN, session: 'sid' },
    { session: 'sid', stamped: 'close' },
    { session: 'nope' },
    { session: 'name' },
    { session: 'time' },
    { sessions: LIST_OVERLAP },
    { sessions: NYSE_JAN, stamped: 'middle' },
  ];
  const studies = [
    ['sessionVwap', {}],
    ...PIVOT_METHODS_LIST.map((method) => ['pivotPoints', { method }]),
  ];
  for (const [study, extra] of studies) {
    for (const door of [...doors, ...wrong]) {
      add(study, 'sessions', { ...extra, ...door });
    }
    // Bars far from any session, and no bars at all.
    add(study, 'bars', { ...extra, sessions: NYSE_JAN });
    add(study, 'ohlcEmpty', { ...extra, sessions: NYSE_JAN });
    add(study, 'ohlcEmpty', { ...extra, session: 'nope' });
    // Other columns, and a missing one.
    add(study, 'sessions', { ...extra, sessions: NYSE_JAN, close: 'open' });
    add(study, 'sessions', { ...extra, sessions: NYSE_JAN, high: 'nope' });
    add(study, 'sessions', {
      ...extra,
      sessions: NYSE_JAN,
      high: 'open',
      low: 'open',
    });
  }
  // A first bar on a session's close, and an id that comes back.
  for (const [study, extra] of studies) {
    for (const door of [
      { sessions: NYSE_JAN, stamped: 'close' },
      { sessions: NYSE_JAN },
      { sessions: LIST, stamped: 'close' },
      { session: 'sid' },
    ]) {
      add(study, 'sessionsLate', { ...extra, ...door });
    }
  }
  add('sessionVwap', 'sessions', { session: 'sid', volume: 'S4' });
  add('sessionVwap', 'sessions', { sessions: NYSE_JAN, output: 'close' });
  add('sessionVwap', 'sessions', { sessions: NYSE_JAN, output: 'mine' });
  // The output names are checked before the sessions.
  add('sessionVwap', 'sessions', { session: 'nope', output: 'close' });
  add('pivotPoints', 'sessions', { session: 'nope', prefix: '' });
  add('pivotPoints', 'sessions', {
    session: 'nope',
    prefix: '',
    method: 'camarilla',
  });
  for (const method of PIVOT_METHODS_LIST) {
    add('pivotPoints', 'sessions', { sessions: NYSE_JAN, method, prefix: '' });
    add('pivotPoints', 'sessions', { sessions: NYSE_JAN, method, prefix: 'x' });
  }
  add('pivotPoints', 'sessions', { sessions: NYSE_JAN, method: 'bogus' });
  add('pivotPoints', 'sessions', { session: 'sid', method: 'bogus' });

  const first = SESSION_ROWS[0][0];
  const last = SESSION_ROWS[SESSION_ROWS.length - 1][0];
  for (const anchor of [
    -1e15,
    0,
    first,
    first + 1,
    SESSION_ROWS[40][0],
    SESSION_ROWS[40][0] - 1,
    Date.UTC(2024, 0, 12, 14, 30),
    last,
    last + 1,
  ]) {
    add('anchoredVwap', 'sessions', { anchor });
  }
  for (const anchor of [0, 40, 79, 80, 40.5]) {
    add('anchoredVwap', 'bars', { anchor });
    add('anchoredVwap', 'vol', { anchor });
  }
  add('anchoredVwap', 'sessions', { anchor: first, close: 'open' });
  add('anchoredVwap', 'sessions', { anchor: first, high: 'nope' });
  add('anchoredVwap', 'sessions', { anchor: first, output: 'close' });
  add('anchoredVwap', 'sessions', { anchor: first, output: 'mine' });
  add('anchoredVwap', 'ohlcEmpty', { anchor: 0 });
  add('anchoredVwap', 'sessions', {});
  add('anchoredVwap', 'sessions', { anchor: 'soon' });
  add('anchoredVwap', 'sessions', { anchor: null, output: 'close' });
}
