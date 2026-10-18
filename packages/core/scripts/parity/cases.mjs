/**
 * Core parity fixture: pond-ts's own output for a fixed set of operations,
 * recorded as language-neutral JSON so another implementation (pond-rs) can
 * check itself against pond-ts. See `docs/rfcs/pond-rs.md` §6.
 *
 * `buildFixture(pond)` takes the pond-ts module so the same code runs against
 * the compiled package (`generate.mjs`, which writes the file) and against
 * source (`test/parity-fixture.test.ts`, which fails if the committed file no
 * longer matches what pond-ts produces).
 *
 * Every series is stored as `TimeSeries.toJSON()` output. A missing cell is
 * JSON `null`. Plain JSON cannot carry `-0`, `NaN` or `±Infinity`, so those
 * cells are tagged: `{ "f64": "-0" | "NaN" | "inf" | "-inf" }`.
 *
 * Each case records the call as `op` + `args` (the positional argument list;
 * `{ "sequence": { "every": "5s" } }` means `Sequence.every('5s')`, and
 * `{ "sequence": { "calendar": "day", "timeZone": "UTC" } }` means
 * `Sequence.calendar('day', { timeZone: 'UTC' })`), and then
 * either `expected` (a series) or `error` (`{ name, message }`) when pond-ts
 * throws. Values, signed zero and non-finites must agree exactly unless the
 * case carries `tolerance` (absolute, finite values only).
 *
 * Which pond-ts this describes: the commit the file is committed in. The drift
 * test keeps the two in step, so there is no separate version field.
 */

const GAPPY_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'a', kind: 'number', required: false },
  { name: 'b', kind: 'number', required: false },
];

// Irregular spacing, gaps in both columns, a run where both are missing, and
// a long silence (13s → 21s) so time windows see empty and partial spans.
const GAPPY_ROWS = [
  [0, 1, 10],
  [1000, 2, null],
  [2500, null, 12],
  [3000, 4, 13],
  [4200, 3.5, 11],
  [7000, 5, null],
  [8000, 6, 16],
  [9000, null, null],
  [9500, -2, 15],
  [13000, 7.25, 14],
  [21000, 8, -3],
  [21500, 0, 20],
];

const DENSE_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
];

// 60 samples on a 1s grid. Values are exact binary fractions (multiples of
// 1/8) so sums are exact in any order and the fixture can demand exact
// agreement.
const DENSE_ROWS = Array.from({ length: 60 }, (_, i) => [
  i * 1000,
  ((i * 37) % 23) / 8 - 1,
]);

// Negative values that repeat, plus an explicit -0, so `pctChange` produces
// -0 ((-2 - -2) / -2) and `shift` must carry -0 through untouched.
const SIGNED_ROWS = [
  [0, -2],
  [1000, -2],
  [2000, -0],
  [3000, 4],
  [4000, null],
  [5000, -4],
];

// 300 rows of values whose sums depend on the order they are added in (so
// the eight-lane block sums pond-ts uses from 32 values are pinned), with
// gaps, a run of repeated times (rows sharing a window), a long silence, and
// a few signed zeros.
const NOISY_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'x', kind: 'number', required: false },
  { name: 'y', kind: 'number', required: false },
];
// Built only from integer arithmetic and single +, -, *, / steps, which
// IEEE 754 rounds the same on every machine. (Math.sin / Math.cos are not
// specified that tightly: an earlier version regenerated differently on
// Node 26 / ARM64.) Values still carry long, order-sensitive mantissas.
const unit = (i, mult) => ((i * mult) % 4294967291) / 4294967291; // [0, 1)
const NOISY_ROWS = Array.from({ length: 300 }, (_, i) => {
  const time = i < 150 ? i * 700 : 150 * 700 + 60_000 + (i - 150) * 700;
  const repeated = i % 13 === 12 ? time - 700 : time; // repeats the previous time
  const x =
    i % 10 === 3
      ? null
      : i % 41 === 0
        ? -0
        : ((unit(i + 1, 2654435761) * 2 - 1) * 100) / 3;
  const y =
    i % 7 === 2 || (i >= 60 && i < 75)
      ? null
      : (unit(i + 7, 40503) * 2 - 1) * 1e6 + i / 3;
  return [repeated, x, y];
});

// Values whose running sums overflow: the variance comes out NaN, which
// pond-ts turns into a gap (Math.max(0, NaN) is NaN).
const EXTREME_ROWS = [
  [0, Number.MAX_VALUE],
  [1, -Number.MAX_VALUE],
  [2, 1],
];

// Calendar buckets. `dst` crosses New York's spring-forward night (a 23-hour
// day, 2026-03-08); `santiago` crosses Chile's, where local midnight itself
// is skipped (2026-09-06 starts at 01:00); `seasons` spans two years of
// weekly rows for month / quarter / year buckets.
const HOUR = 3_600_000;
const DST_ROWS = Array.from({ length: 100 }, (_, i) => [
  Date.UTC(2026, 2, 5) + i * 1.5 * HOUR,
  i % 9 === 4 ? null : ((i * 7) % 31) - 15,
]);
const SANTIAGO_ROWS = Array.from({ length: 60 }, (_, i) => [
  Date.UTC(2026, 8, 3, 12) + i * 2 * HOUR,
  (i % 11) / 4,
]);
// Samoa skipped 2011-12-30 entirely (UTC-10 → UTC+14): no bucket for it.
const APIA_ROWS = Array.from({ length: 40 }, (_, i) => [
  Date.UTC(2011, 11, 28, 12) + i * 3 * HOUR,
  i % 5,
]);
const SEASON_ROWS = Array.from({ length: 110 }, (_, i) => [
  Date.UTC(2025, 10, 2, 13) + i * 7 * 24 * HOUR,
  i % 6 === 5 ? null : (i % 13) - 6,
]);

const every = (duration) => ({ sequence: { every: duration } });
const calendar = (unit, timeZone, weekStartsOn) => ({
  sequence: {
    calendar: unit,
    timeZone,
    ...(weekStartsOn === undefined ? {} : { weekStartsOn }),
  },
});

/** [id, input, op, args] — the call is `inputs[input][op](...decode(args))`. */
const CASES = [
  // rolling: time window, trailing, keyed at each event
  ['rolling-3s-avg-sum', 'gappy', 'rolling', ['3s', { a: 'avg', b: 'sum' }]],
  ['rolling-5s-min-max', 'gappy', 'rolling', ['5s', { a: 'min', b: 'max' }]],
  [
    'rolling-4s-count-first',
    'gappy',
    'rolling',
    ['4s', { a: 'count', b: 'first' }],
  ],
  [
    'rolling-4s-last-median',
    'gappy',
    'rolling',
    ['4s', { a: 'last', b: 'median' }],
  ],
  // 1s windows: several hold only missing cells (sum → 0, avg → missing)
  ['rolling-1s-avg-sum', 'gappy', 'rolling', ['1s', { a: 'avg', b: 'sum' }]],
  ['rolling-1s-sum-avg', 'gappy', 'rolling', ['1s', { a: 'sum', b: 'avg' }]],
  ['rolling-dense-10s-avg', 'dense', 'rolling', ['10s', { value: 'avg' }]],
  ['rolling-dense-10s-stdev', 'dense', 'rolling', ['10s', { value: 'stdev' }]],
  // aggregate: fixed buckets, interval-keyed output
  [
    'aggregate-5s-sum-count',
    'gappy',
    'aggregate',
    [every('5s'), { a: 'sum', b: 'count' }],
  ],
  [
    'aggregate-5s-avg-max',
    'gappy',
    'aggregate',
    [every('5s'), { a: 'avg', b: 'max' }],
  ],
  [
    'aggregate-5s-first-last',
    'gappy',
    'aggregate',
    [every('5s'), { a: 'first', b: 'last' }],
  ],
  [
    'aggregate-dense-15s-sum',
    'dense',
    'aggregate',
    [every('15s'), { value: 'sum' }],
  ],
  // order-sensitive sums, quickselect medians, repeated times
  [
    'aggregate-noisy-30s-sum-avg',
    'noisy',
    'aggregate',
    [every('30s'), { x: 'sum', y: 'avg' }],
  ],
  [
    'aggregate-noisy-30s-spread',
    'noisy',
    'aggregate',
    [
      every('30s'),
      {
        x_min: { from: 'x', using: 'min' },
        x_max: { from: 'x', using: 'max' },
        x_sd: { from: 'x', using: 'stdev' },
        x_med: { from: 'x', using: 'median' },
        x_p95: { from: 'x', using: 'p95' },
        y_n: { from: 'y', using: 'count' },
        y_first: { from: 'y', using: 'first' },
        y_last: { from: 'y', using: 'last' },
      },
    ],
  ],
  [
    'rolling-noisy-20s-all',
    'noisy',
    'rolling',
    [
      '20s',
      {
        x_sum: { from: 'x', using: 'sum' },
        x_avg: { from: 'x', using: 'avg' },
        x_min: { from: 'x', using: 'min' },
        x_max: { from: 'x', using: 'max' },
        x_med: { from: 'x', using: 'median' },
        x_p10: { from: 'x', using: 'p10' },
        y_n: { from: 'y', using: 'count' },
        y_first: { from: 'y', using: 'first' },
        y_last: { from: 'y', using: 'last' },
      },
    ],
  ],
  [
    'rolling-noisy-20s-stdev',
    'noisy',
    'rolling',
    ['20s', { x: 'stdev', y: 'stdev' }],
  ],
  // shorthand out of schema order: pond-ts sorts it into schema order
  [
    'rolling-shorthand-order',
    'gappy',
    'rolling',
    ['2s', { b: 'sum', a: 'max' }],
  ],
  // spec form keeps the order given
  [
    'aggregate-spec-order',
    'gappy',
    'aggregate',
    [
      every('10s'),
      {
        b_n: { from: 'b', using: 'count' },
        a_mean: { from: 'a', using: 'mean' },
      },
    ],
  ],
  // shorthand out of schema order: aggregate keeps the order given
  [
    'aggregate-shorthand-order',
    'gappy',
    'aggregate',
    [every('5s'), { b: 'sum', a: 'max' }],
  ],
  // overflowing sums: stdev is a gap, not 0
  [
    'aggregate-extreme-stdev',
    'extreme',
    'aggregate',
    [every('1s'), { v: 'stdev' }],
  ],
  // calendar buckets: local midnights, DST-length days, week starts
  [
    'aggregate-calendar-day-new-york',
    'dst',
    'aggregate',
    [
      calendar('day', 'America/New_York'),
      { v: 'sum', n: { from: 'v', using: 'count' } },
    ],
  ],
  [
    'aggregate-calendar-week-sunday',
    'dst',
    'aggregate',
    [calendar('week', 'America/New_York', 7), { v: 'avg' }],
  ],
  [
    'aggregate-calendar-day-santiago',
    'santiago',
    'aggregate',
    [calendar('day', 'America/Santiago'), { v: 'sum' }],
  ],
  [
    'aggregate-calendar-day-apia-skipped',
    'apia',
    'aggregate',
    [calendar('day', 'Pacific/Apia'), { v: 'sum' }],
  ],
  [
    // The week from Friday 2011-12-30 (a date Apia skipped) starts on the 31st.
    'aggregate-calendar-week-apia-skipped-start',
    'apia',
    'aggregate',
    [calendar('week', 'Pacific/Apia', 5), { v: 'sum' }],
  ],
  [
    'aggregate-calendar-day-fixed-offset',
    'dst',
    'aggregate',
    [calendar('day', '+05:30'), { v: 'count' }],
  ],
  [
    'aggregate-calendar-month-london',
    'seasons',
    'aggregate',
    [calendar('month', 'Europe/London'), { v: 'sum' }],
  ],
  [
    'aggregate-calendar-quarter-tokyo',
    'seasons',
    'aggregate',
    [calendar('quarter', 'Asia/Tokyo'), { v: 'max' }],
  ],
  [
    'aggregate-calendar-year-utc',
    'seasons',
    'aggregate',
    [calendar('year', 'UTC'), { v: 'count' }],
  ],
  // signed zero through min / max / sum
  [
    'rolling-signed-3s',
    'signed',
    'rolling',
    [
      '3s',
      {
        v_min: { from: 'v', using: 'min' },
        v_sum: { from: 'v', using: 'sum' },
      },
    ],
  ],
  [
    'aggregate-signed-2s',
    'signed',
    'aggregate',
    [
      every('2s'),
      {
        v_max: { from: 'v', using: 'max' },
        v_sum: { from: 'v', using: 'sum' },
      },
    ],
  ],
  // element-wise
  ['diff-a', 'gappy', 'diff', ['a']],
  ['diff-a-b', 'gappy', 'diff', [['a', 'b']]],
  ['rate-a', 'gappy', 'rate', ['a']],
  ['pctChange-b', 'gappy', 'pctChange', ['b']],
  ['cumulative-sum-max', 'gappy', 'cumulative', [{ a: 'sum', b: 'max' }]],
  ['shift-a-1', 'gappy', 'shift', ['a', 1]],
  ['shift-a-b-minus2', 'gappy', 'shift', [['a', 'b'], -2]],
  ['fill-linear-hold', 'gappy', 'fill', [{ a: 'linear', b: 'hold' }]],
  // signed zero
  ['pctChange-signed', 'signed', 'pctChange', ['v']],
  ['shift-signed', 'signed', 'shift', ['v', 1]],
  ['cumulative-signed', 'signed', 'cumulative', [{ v: 'sum' }]],
  // errors: pond-ts throws. Only "an error is raised" is the contract for
  // now; the message is recorded for reference, not for matching.
  ['error-unknown-column', 'gappy', 'rolling', ['1s', { nope: 'avg' }]],
  [
    'error-unknown-reducer',
    'gappy',
    'aggregate',
    [every('1s'), { a: 'bogus' }],
  ],
  ['error-negative-window', 'gappy', 'rolling', ['-1s', { a: 'avg' }]],
  // reshape: select / rename / asTime (no new values, so every cell is exact)
  ['select-b', 'gappy', 'select', ['b']],
  ['select-none', 'gappy', 'select', []],
  ['select-repeat-keeps-schema-order', 'gappy', 'select', ['b', 'a', 'b']],
  ['select-error-unknown', 'gappy', 'select', ['zz']],
  ['rename-a', 'gappy', 'rename', [{ a: 'x' }]],
  ['rename-swap', 'gappy', 'rename', [{ a: 'b', b: 'a' }]],
  ['rename-to-self', 'gappy', 'rename', [{ a: 'a' }]],
  ['rename-error-key', 'gappy', 'rename', [{ time: 't' }]],
  ['rename-error-collision', 'gappy', 'rename', [{ a: 'b' }]],
  ['rename-error-to-key', 'gappy', 'rename', [{ a: 'time' }]],
  ['rename-error-unknown', 'gappy', 'rename', [{ zz: 'q' }]],
  ['asTime-begin', 'buckets', 'asTime', [{ at: 'begin' }]],
  ['asTime-default', 'buckets', 'asTime', []],
  ['asTime-center', 'buckets', 'asTime', [{ at: 'center' }]],
  ['asTime-end', 'buckets', 'asTime', [{ at: 'end' }]],
  ['asTime-time-key', 'gappy', 'asTime', [{ at: 'end' }]],
  ['asTime-error-end-overlap', 'overlap', 'asTime', [{ at: 'end' }]],
  ['asTime-error-center-overlap', 'overlap', 'asTime', [{ at: 'center' }]],
  ['asTime-error-time-column', 'timeColumn', 'asTime', []],
  // text and true/false columns: count, first, last (the reducers pond-ts's
  // types allow on them that pond-rs has)
  [
    'aggregate-mixed-5s',
    'mixed',
    'aggregate',
    [
      every('5s'),
      {
        site_n: { from: 'site', using: 'count' },
        site_first: { from: 'site', using: 'first' },
        host_n: { from: 'host', using: 'count' },
        host_first: { from: 'host', using: 'first' },
        host_last: { from: 'host', using: 'last' },
        up_n: { from: 'up', using: 'count' },
        up_first: { from: 'up', using: 'first' },
        up_last: { from: 'up', using: 'last' },
        v: { from: 'v', using: 'sum' },
      },
    ],
  ],
  [
    'aggregate-mixed-calendar-day',
    'mixed',
    'aggregate',
    [calendar('day', 'UTC'), { site: 'last', up: 'first' }],
  ],
  [
    'rolling-mixed-3s',
    'mixed',
    'rolling',
    [
      '3s',
      {
        site_last: { from: 'site', using: 'last' },
        host_first: { from: 'host', using: 'first' },
        host_n: { from: 'host', using: 'count' },
        up_last: { from: 'up', using: 'last' },
      },
    ],
  ],
  [
    'rolling-mixed-shorthand-order',
    'mixed',
    'rolling',
    ['4s', { up: 'first', host: 'last' }],
  ],
  ['select-mixed', 'mixed', 'select', ['up', 'site']],
  ['rename-mixed', 'mixed', 'rename', [{ host: 'name', up: 'alive' }]],
];

// Interval-keyed inputs (label, begin, end), the shape `aggregate` returns.
// Even lengths only: pond-rs keeps whole milliseconds, so it refuses a centre
// on a half millisecond (see `as_time`), which pond-ts would give as x.5.
const INTERVAL_SCHEMA = [
  { name: 'interval', kind: 'interval' },
  { name: 'a', kind: 'number', required: false },
  { name: 'b', kind: 'number', required: false },
];
const BUCKET_ROWS = [
  [[0, 0, 5000], 1, 10],
  [[5000, 5000, 10000], null, 12],
  [[10000, 10000, 20000], 4, null],
  [[20000, 20000, 21000], null, null],
];
// The first interval contains the second, so anchoring at end or centre
// would put the rows out of order.
const OVERLAP_ROWS = [
  [[0, 0, 5000], 1, 2],
  [[1000, 1000, 2000], 3, 4],
];

// Text and true/false columns. `site` repeats few values over 20 rows, so
// pond-ts holds it as a dictionary (and `toArrow` writes it as one); `host`
// is mostly distinct, so it stays plain text. Gaps in `host` and `up`, and an
// empty string, which is a value, not a gap.
const MIXED_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'site', kind: 'string' },
  { name: 'host', kind: 'string', required: false },
  { name: 'up', kind: 'boolean', required: false },
  { name: 'v', kind: 'number', required: false },
];
const MIXED_ROWS = Array.from({ length: 20 }, (_, i) => [
  i < 12 ? i * 1000 : 12_000 + (i - 11) * 2500,
  ['east', 'west', 'north'][(i * 7) % 3],
  i % 4 === 1 ? null : i === 6 ? '' : `h${(i * 5) % 17}`,
  i % 5 === 2 ? null : (i * 3) % 4 < 2,
  i % 6 === 4 ? null : i / 4,
]);

/** Tag the numbers plain JSON would lose or change. */
function encodeCell(cell) {
  if (Array.isArray(cell)) return cell.map(encodeCell);
  if (typeof cell !== 'number') return cell;
  if (Object.is(cell, -0)) return { f64: '-0' };
  if (Number.isNaN(cell)) return { f64: 'NaN' };
  if (cell === Infinity) return { f64: 'inf' };
  if (cell === -Infinity) return { f64: '-inf' };
  return cell;
}

function encodeSeries(series) {
  const json = series.toJSON();
  return { ...json, rows: json.rows.map((row) => row.map(encodeCell)) };
}

/** The `noisy` input series, also exported to Arrow by export.mjs. */
export function noisySeries(pond) {
  return pond.TimeSeries.fromJSON({
    name: 'noisy',
    schema: NOISY_SCHEMA,
    rows: NOISY_ROWS,
  });
}

/** The `mixed` input series, also exported to Arrow by export.mjs. */
export function mixedSeries(pond) {
  return pond.TimeSeries.fromJSON({
    name: 'mixed',
    schema: MIXED_SCHEMA,
    rows: MIXED_ROWS,
  });
}

export function buildFixture(pond) {
  const { TimeSeries, Sequence } = pond;
  const series = (name, rows) =>
    TimeSeries.fromJSON({
      name,
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number', required: false },
      ],
      rows,
    });
  const inputs = {
    gappy: TimeSeries.fromJSON({
      name: 'gappy',
      schema: GAPPY_SCHEMA,
      rows: GAPPY_ROWS,
    }),
    dense: TimeSeries.fromJSON({
      name: 'dense',
      schema: DENSE_SCHEMA,
      rows: DENSE_ROWS,
    }),
    noisy: noisySeries(pond),
    mixed: mixedSeries(pond),
    signed: TimeSeries.fromJSON({
      name: 'signed',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number', required: false },
      ],
      rows: SIGNED_ROWS,
    }),
    dst: series('dst', DST_ROWS),
    santiago: series('santiago', SANTIAGO_ROWS),
    apia: series('apia', APIA_ROWS),
    seasons: series('seasons', SEASON_ROWS),
    buckets: TimeSeries.fromJSON({
      name: 'buckets',
      schema: INTERVAL_SCHEMA,
      rows: BUCKET_ROWS,
    }),
    overlap: TimeSeries.fromJSON({
      name: 'overlap',
      schema: INTERVAL_SCHEMA,
      rows: OVERLAP_ROWS,
    }),
    // A value column named `time` clashes with the key `asTime` makes.
    timeColumn: TimeSeries.fromJSON({
      name: 'timeColumn',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'time', kind: 'number' },
      ],
      rows: [[[0, 0, 1000], 1]],
    }),
    extreme: TimeSeries.fromJSON({
      name: 'extreme',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number', required: false },
      ],
      rows: EXTREME_ROWS,
    }),
  };
  const decode = (arg) => {
    if (!(arg && typeof arg === 'object' && 'sequence' in arg)) return arg;
    const { every, calendar, timeZone, weekStartsOn } = arg.sequence;
    return every !== undefined
      ? Sequence.every(every)
      : Sequence.calendar(calendar, { timeZone, weekStartsOn });
  };

  return {
    meta: {
      generator: 'packages/core/scripts/parity/generate.mjs',
      reference: 'pond-ts',
      encoding:
        'series are TimeSeries.toJSON(); null = missing; -0/NaN/±Infinity tagged as {"f64":"-0"|"NaN"|"inf"|"-inf"}; args encode Sequence.every(d) as {"sequence":{"every":d}} and Sequence.calendar(u, {timeZone, weekStartsOn}) as {"sequence":{"calendar":u,"timeZone":z,"weekStartsOn"?:w}}; a case has expected (series) or error ({name,message}); exact unless tolerance is set',
    },
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([name, series]) => [
        name,
        encodeSeries(series),
      ]),
    ),
    cases: CASES.map(([id, input, op, args, tolerance]) => {
      const head = {
        id,
        input,
        op,
        args,
        ...(tolerance === undefined ? {} : { tolerance }),
      };
      let result;
      try {
        result = inputs[input][op](...args.map(decode));
      } catch (e) {
        return { ...head, error: { name: e.name, message: e.message } };
      }
      return { ...head, expected: encodeSeries(result) };
    }),
  };
}
