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

// Signed zeros first and among ties: a running sum starts from +0, and max /
// min keep the earlier of two equal values.
const ZERO_ROWS = [
  [0, -0],
  [1000, null],
  [2000, 0],
  [3000, -0],
  [4000, 3],
];
// Gaps at both ends and in the middle, spaced unevenly, so each way fill
// measures a gap's span (neighbour to neighbour, edge to neighbour) shows.
const EDGE_ROWS = [
  [0, null],
  [1000, null],
  [2000, 1],
  [5000, null],
  [6000, 2],
  [9000, null],
  [10000, null],
];
// Values whose running sums overflow: the variance comes out NaN, which
// pond-ts turns into a gap (Math.max(0, NaN) is NaN).
const EXTREME_ROWS = [
  [0, Number.MAX_VALUE],
  [1, -Number.MAX_VALUE],
  [2, 1],
];
// A running sum that overflows at the second row and never comes back.
const OVERFLOW_ROWS = [
  [0, Number.MAX_VALUE],
  [1000, Number.MAX_VALUE],
  [2000, -Number.MAX_VALUE],
  [3000, null],
  [4000, 1],
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
// `Time.parse(text, { timeZone })` over every pairing of these texts and
// zones, recorded as `timeParse` (milliseconds, or the error's name). The
// texts cover each of pond-ts's three local shapes (month, day, wall-clock
// time), clock changes in both directions (including Santiago and São
// Paulo, whose clocks once skipped midnight), sub-millisecond fractions
// before 1970 (which round down), leap seconds, and the offset forms
// Temporal accepts or refuses. Left out because pond-rs reads them
// differently (pinned in its own tests): years beyond ±9999, times after
// 9999-12-30, and offsets with fractions of a second.
const TIME_PARSE_TEXTS = [
  '2025-03',
  '2025-13',
  '2025-00',
  '0000-01',
  '2025-01-01',
  '2025-02-30',
  '2024-02-29',
  '2025-04-31',
  '1969-12-31',
  '0000-01-01',
  '0001-01-01',
  '+002025-01-01',
  '2025-1-1',
  '  2025-01-01',
  '2025-W01',
  '2025-001',
  '',
  'abc',
  '2025-03-30T02:30',
  '2025-03-30 02:30',
  '2025-03-30T02:00',
  '2025-10-26T02:30',
  '2025-03-09T02:30',
  '2025-11-02T01:30',
  '2011-12-30',
  '2011-12-30T12:00',
  '2011-12-31',
  '2025-09-07',
  '2025-09-07T00:00',
  '2025-04-06T00:00',
  '2025-04-05T23:30',
  '2025-02-29T00:00',
  '2025-01-01T09:00:00',
  '2025-01-01T09:00:00.1',
  '2025-01-01T09:00:00.123456789',
  '2025-01-01T09:00:00.1234567890',
  '1969-12-31T23:59:59.9995',
  '1969-12-31T23:59:59.999999999',
  '2025-01-01T23:59:60',
  '2025-01-01T23:59:61',
  '2025-01-01T24:00',
  '2025-01-01T25:00',
  '2025-01-01T23:60',
  '2025-01-01T09',
  '2025-01-01T9:00',
  '2025-01-01T09:00:00.',
  '2025-01-01T09:00:.5',
  '1970-01-01T00:00:00Z',
  '1969-12-31T23:59:59.9995Z',
  '1969-12-31T23:59:59.999999999Z',
  '2025-06-30T23:59:60Z',
  '2025-01-01T09:00:60Z',
  '2025-01-01T09Z',
  '2025-01-01T0900Z',
  '20250101T090000Z',
  '2025-01-01T09:00Z',
  '2025-01-01T09:00z',
  '2025-01-01 09:00Z',
  '2025-01-01t09:00Z',
  '2025-01-01T09:00:00.000Z',
  '2025-01-01T09:00:00,5Z',
  '2025-01-01T09:00:00.Z',
  '2025-01-01T09:00:00Z ',
  'T09:00Z',
  '2025-01-01T09:00:00+01:00',
  '2025-01-01T09:00+01:00',
  '2025-01-01T09:00:00+0100',
  '2025-01-01T09:00:00+01',
  '2025-01-01T09:00:00-00:00',
  '2025-01-01T09:00:00+14:00',
  '2025-01-01T09:00:00+25:00',
  '2025-01-01T09:00:00+01:00:30',
  '2025-01-01T09:00:00.5+05:30',
  '2025-01-01T09:00:00.5-03:30',
  '2025-01-01T09:00:00 +01:00',
  '2025-01-01T09:00:00\u221201:00',
  '2025-12-31T23:59:59.999999999+00:00',
  '2025-01-01T09:00:00.123+00:00:00',
  '-000001-01-01T00:00Z',
  '9999-12-30T21:00Z',
  '2025-01-01T09:00:00+01:00[Europe/Madrid]',
  '2025-01-01T09:00:00+01:00[America/New_York]',
  '2025-01-01T09:00:00+01:00[!Europe/Madrid]',
  '2025-01-01T09:00:00Z[Foo/Bar]',
  '2025-01-01T09:00:00Z[u-ca=gregory]',
  '2025-01-01T09:00:00+01:00[u-ca=japanese]',
  '2025-01-01T09:00:00+01:00[Europe/Madrid][u-ca=iso8601]',
  '2025-01-01T09:00:00[Europe/Madrid]',
  '2025-W01-1T00:00Z',
  '2025-001T00:00Z',
];
const TIME_PARSE_ZONES = [
  'UTC',
  'Europe/Madrid',
  'Europe/London',
  'America/New_York',
  'America/Santiago',
  'America/Sao_Paulo',
  'Asia/Kolkata',
  'Pacific/Apia',
  'Etc/GMT+5',
  'Mars/Base',
];

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
  // element-wise: options, other keys, overflow, every fill strategy
  ['diff-a-drop', 'gappy', 'diff', ['a', { drop: true }]],
  ['rate-b-drop', 'gappy', 'rate', ['b', { drop: true }]],
  ['rate-ranges', 'ranges', 'rate', [['a', 'b']]],
  ['pctChange-labelled', 'labelled', 'pctChange', [['a', 'b']]],
  ['diff-extreme', 'extreme', 'diff', ['v']],
  ['rate-noisy', 'noisy', 'rate', [['x', 'y']]],
  ['cumulative-count-min', 'gappy', 'cumulative', [{ a: 'count', b: 'min' }]],
  ['cumulative-extreme', 'extreme', 'cumulative', [{ v: 'sum' }]],
  ['cumulative-noisy', 'noisy', 'cumulative', [{ x: 'max', y: 'min' }]],
  ['shift-a-0', 'gappy', 'shift', ['a', 0]],
  ['shift-a-12', 'gappy', 'shift', ['a', 12]],
  ['shift-b-minus20', 'gappy', 'shift', ['b', -20]],
  ['fill-hold', 'gappy', 'fill', ['hold']],
  ['fill-bfill-zero', 'gappy', 'fill', [{ a: 'bfill', b: 'zero' }]],
  ['fill-literal', 'gappy', 'fill', [{ a: 7.5, b: -1 }]],
  ['fill-hold-limit-1', 'gappy', 'fill', ['hold', { limit: 1 }]],
  ['fill-linear-maxgap', 'gappy', 'fill', ['linear', { maxGap: '2s' }]],
  [
    'fill-edges-maxgap',
    'gappy',
    'fill',
    [{ a: 'hold', b: 'bfill' }, { maxGap: '1500ms' }],
  ],
  ['fill-limit-maxgap', 'gappy', 'fill', ['zero', { limit: 2, maxGap: '3s' }]],
  ['fill-mixed-hold', 'mixed', 'fill', ['hold']],
  ['fill-mixed-zero', 'mixed', 'fill', ['zero']],
  [
    'fill-mixed-literal',
    'mixed',
    'fill',
    [{ host: 'unknown', up: false, v: 'bfill' }],
  ],
  ['fill-ranges-linear', 'ranges', 'fill', ['linear']],
  ['fill-labelled-linear', 'labelled', 'fill', ['linear']],
  ['fill-noisy-linear', 'noisy', 'fill', ['linear']],
  ['cumulative-overflow', 'overflow', 'cumulative', [{ v: 'sum' }]],
  ['diff-overflow', 'overflow', 'diff', ['v']],
  ['cumulative-zeros', 'zeros', 'cumulative', [{ v: 'sum' }]],
  ['cumulative-zeros-max', 'zeros', 'cumulative', [{ v: 'max' }]],
  ['cumulative-zeros-min', 'zeros', 'cumulative', [{ v: 'min' }]],
  ['diff-zeros', 'zeros', 'diff', ['v']],
  ['fill-edges-hold-1s', 'edges', 'fill', ['hold', { maxGap: '1s' }]],
  ['fill-edges-hold-3s', 'edges', 'fill', ['hold', { maxGap: '3s' }]],
  ['fill-edges-bfill-1s', 'edges', 'fill', ['bfill', { maxGap: '1s' }]],
  ['fill-edges-bfill-2s', 'edges', 'fill', ['bfill', { maxGap: '2s' }]],
  ['fill-edges-zero-1s', 'edges', 'fill', ['zero', { maxGap: '1s' }]],
  ['fill-edges-zero-limit', 'edges', 'fill', ['zero', { limit: 1 }]],
  ['fill-edges-linear-4s', 'edges', 'fill', ['linear', { maxGap: '4s' }]],
  ['error-diff-no-columns', 'gappy', 'diff', [[]]],
  ['error-shift-fraction', 'gappy', 'shift', ['a', 1.5]],
  ['error-cumulative-empty', 'gappy', 'cumulative', [{}]],
  ['error-fill-literal-kind', 'gappy', 'fill', [{ a: 'bogus' }]],
  ['error-fill-maxgap', 'gappy', 'fill', ['hold', { maxGap: '2 s' }]],
  ['error-diff-text', 'mixed', 'diff', ['host']],
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
  // time-range keys: ordered by start, then end; rolling anchors at the start
  ['asTime-ranges-begin', 'ranges', 'asTime', []],
  ['asTime-ranges-center', 'ranges', 'asTime', [{ at: 'center' }]],
  // Ends 1000, 3000, 2000: out of order, so an error.
  ['asTime-error-ranges-end', 'ranges', 'asTime', [{ at: 'end' }]],
  ['select-ranges', 'ranges', 'select', ['b']],
  ['rename-ranges', 'ranges', 'rename', [{ a: 'x' }]],
  ['rename-error-ranges-key', 'ranges', 'rename', [{ timeRange: 't' }]],
  ['rolling-ranges-3s', 'ranges', 'rolling', ['3s', { a: 'sum', b: 'count' }]],
  // interval keys with text labels
  ['asTime-labelled-end', 'labelled', 'asTime', [{ at: 'end' }]],
  ['select-labelled', 'labelled', 'select', ['a']],
  ['rename-labelled', 'labelled', 'rename', [{ a: 'x' }]],
  ['rolling-labelled-6s', 'labelled', 'rolling', ['6s', { a: 'avg' }]],
  // slice: Array.prototype.slice positions (negative counts from the end;
  // out of range clamps)
  ['slice-all', 'gappy', 'slice', []],
  ['slice-from', 'gappy', 'slice', [3]],
  ['slice-range', 'gappy', 'slice', [2, 7]],
  ['slice-negative-from', 'gappy', 'slice', [-3]],
  ['slice-negative-end', 'gappy', 'slice', [1, -2]],
  ['slice-negative-both', 'gappy', 'slice', [-5, -1]],
  ['slice-empty-reversed', 'gappy', 'slice', [7, 2]],
  ['slice-clamped', 'gappy', 'slice', [-100, 100]],
  ['slice-past-end', 'gappy', 'slice', [50]],
  ['slice-mixed', 'mixed', 'slice', [4, 15]],
  ['slice-ranges', 'ranges', 'slice', [1, 3]],
  ['slice-labelled', 'labelled', 'slice', [-3]],
  // filter: the predicate is a closure, so the fixture names one of a few
  // fixed predicates ({ fn: ... }); see `predicate` below.
  ['filter-gt', 'gappy', 'filter', [{ fn: { column: 'a', gt: 3 } }]],
  ['filter-missing', 'gappy', 'filter', [{ fn: { missing: 'b' } }]],
  ['filter-none', 'gappy', 'filter', [{ fn: { column: 'a', gt: 1000 } }]],
  ['filter-every-3rd', 'gappy', 'filter', [{ fn: { everyNth: 3 } }]],
  ['filter-begin', 'gappy', 'filter', [{ fn: { beginAtLeast: 8000 } }]],
  ['filter-text', 'mixed', 'filter', [{ fn: { column: 'site', eq: 'east' } }]],
  ['filter-bool', 'mixed', 'filter', [{ fn: { column: 'up', eq: true } }]],
  ['filter-ranges', 'ranges', 'filter', [{ fn: { endAtMost: 2000 } }]],
  ['filter-labelled', 'labelled', 'filter', [{ fn: { everyNth: 2 } }]],
  // mapColumns: fixed mappers ({ fn: ... }); missing cells stay missing and
  // a non-finite number result is a gap
  [
    'mapColumns-number',
    'gappy',
    'mapColumns',
    [{ a: { fn: { mul: 2, add: 1 } } }],
  ],
  [
    'mapColumns-two',
    'gappy',
    'mapColumns',
    [{ a: { fn: { mul: -1, add: 0 } }, b: { fn: { mul: 0.5, add: 0 } } }],
  ],
  [
    'mapColumns-overflow',
    'dense',
    'mapColumns',
    [{ value: { fn: { mul: 1e308, add: 1e308 } } }],
  ],
  [
    'mapColumns-text-bool',
    'mixed',
    'mapColumns',
    [{ host: { fn: 'upper' }, up: { fn: 'not' } }],
  ],
  ['mapColumns-error-empty', 'gappy', 'mapColumns', [{}]],
  // withColumn: append a number column; `null` is a gap
  [
    'withColumn-gappy',
    'gappy',
    'withColumn',
    ['c', [1, null, 3, 4, null, 6, 7, 8, 9, 10, 11, 12]],
  ],
  ['withColumn-ranges', 'ranges', 'withColumn', ['c', [0.5, null, 2, 3, null]]],
  ['withColumn-error-length', 'gappy', 'withColumn', ['c', [1, 2]]],
  [
    'withColumn-error-name',
    'gappy',
    'withColumn',
    ['a', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
  ],
  [
    'withColumn-error-key-name',
    'gappy',
    'withColumn',
    ['time', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
  ],
  // partitionBy: [by, steps, end]. Each step is [method, ...args] run on the
  // partitioned view; `end` is 'collect' (one series) or 'toMap' (groups).
  // `hosts` has rows for three hosts at shared times (the tie order after
  // collecting is partition order, not input order), one row with no host,
  // and gaps.
  ['partition-collect', 'hosts', 'partitionBy', ['host', [], 'collect']],
  ['partition-toMap', 'hosts', 'partitionBy', ['host', [], 'toMap']],
  [
    'partition-fill-hold',
    'hosts',
    'partitionBy',
    ['host', [['fill', 'hold']], 'collect'],
  ],
  [
    'partition-fill-linear-map',
    'hosts',
    'partitionBy',
    ['host', [['fill', { cpu: 'linear' }]], 'toMap'],
  ],
  [
    'partition-diff',
    'hosts',
    'partitionBy',
    ['host', [['diff', 'cpu']], 'collect'],
  ],
  [
    'partition-diff-drop-then-cumulative',
    'hosts',
    'partitionBy',
    [
      'host',
      [
        ['diff', 'cpu', { drop: true }],
        ['cumulative', { cpu: 'sum' }],
      ],
      'collect',
    ],
  ],
  // Two drops leave a's first row (3000) before b's (5000): the partition
  // order flips, which decides the tie order at 6000 and 21000.
  [
    'partition-two-drops',
    'hosts',
    'partitionBy',
    [
      'host',
      [
        ['diff', 'cpu', { drop: true }],
        ['diff', 'mem', { drop: true }],
      ],
      'collect',
    ],
  ],
  [
    'partition-two-drops-toMap',
    'hosts',
    'partitionBy',
    [
      'host',
      [
        ['diff', 'cpu', { drop: true }],
        ['diff', 'mem', { drop: true }],
      ],
      'toMap',
    ],
  ],
  [
    'partition-rate-pct',
    'hosts',
    'partitionBy',
    [
      'host',
      [
        ['rate', 'cpu'],
        ['pctChange', 'mem'],
      ],
      'collect',
    ],
  ],
  [
    'partition-shift',
    'hosts',
    'partitionBy',
    ['region', [['shift', 'cpu', 1]], 'collect'],
  ],
  [
    'partition-composite-cumulative',
    'hosts',
    'partitionBy',
    [['region', 'host'], [['cumulative', { mem: 'max' }]], 'toMap'],
  ],
  [
    'partition-rolling',
    'hosts',
    'partitionBy',
    ['host', [['rolling', '3s', { cpu: 'avg', mem: 'count' }]], 'collect'],
  ],
  [
    'partition-rolling-names-host',
    'hosts',
    'partitionBy',
    ['host', [['rolling', '3s', { host: 'last', cpu: 'sum' }]], 'collect'],
  ],
  [
    'partition-aggregate',
    'hosts',
    'partitionBy',
    [
      'host',
      [['aggregate', every('5s'), { cpu: 'avg', mem: 'max' }]],
      'collect',
    ],
  ],
  // Empty buckets get no host from the injected `first`, so the next split
  // puts them in the missing-host partition.
  [
    'partition-aggregate-toMap',
    'hosts',
    'partitionBy',
    ['host', [['aggregate', every('5s'), { cpu: 'sum' }]], 'toMap'],
  ],
  [
    'partition-aggregate-then-diff',
    'hosts',
    'partitionBy',
    [
      'host',
      [
        ['aggregate', every('5s'), { cpu: 'sum' }],
        ['diff', 'cpu'],
      ],
      'collect',
    ],
  ],
  [
    'partition-composite-aggregate',
    'hosts',
    'partitionBy',
    [
      ['region', 'up'],
      [['aggregate', every('10s'), { cpu: 'max' }]],
      'collect',
    ],
  ],
  [
    'partition-boolean',
    'hosts',
    'partitionBy',
    ['up', [['diff', 'mem']], 'toMap'],
  ],
  [
    'partition-number',
    'hosts',
    'partitionBy',
    ['mem', [['cumulative', { cpu: 'count' }]], 'collect'],
  ],
  // cumulative changes the partition column itself (mem 20 and 12 each
  // appear twice), so the rows are split again by the new values before
  // the diff.
  [
    'partition-changed-values',
    'hosts',
    'partitionBy',
    [
      'mem',
      [
        ['cumulative', { mem: 'sum' }],
        ['diff', 'cpu'],
      ],
      'collect',
    ],
  ],
  [
    'partition-changed-values-toMap',
    'hosts',
    'partitionBy',
    [
      'mem',
      [
        ['cumulative', { mem: 'sum' }],
        ['diff', 'cpu'],
      ],
      'toMap',
    ],
  ],
  [
    'partition-mixed-text',
    'mixed',
    'partitionBy',
    ['site', [['fill', { host: 'hold', up: 'bfill' }]], 'collect'],
  ],
  [
    'partition-ranges',
    'ranges',
    'partitionBy',
    ['b', [['diff', 'a']], 'toMap'],
  ],
  [
    'partition-labelled',
    'labelled',
    'partitionBy',
    ['b', [['cumulative', { a: 'sum' }]], 'collect'],
  ],
  [
    'partition-empty',
    'emptyHosts',
    'partitionBy',
    ['host', [['aggregate', every('5s'), { cpu: 'avg' }]], 'collect'],
  ],
  ['partition-empty-toMap', 'emptyHosts', 'partitionBy', ['host', [], 'toMap']],
  ['partition-error-none', 'hosts', 'partitionBy', [[], [], 'collect']],
  ['partition-error-unknown', 'hosts', 'partitionBy', ['zz', [], 'collect']],
  // groupBy: a missing value is the key 'undefined' (no leading space)
  ['groupBy-host', 'hosts', 'groupBy', ['host']],
  ['groupBy-up', 'hosts', 'groupBy', ['up']],
  // align: hold takes atOrBefore (the first row at the point, else the last
  // row before it); `noisy` repeats times, so both halves are pinned
  ['align-hold', 'gappy', 'align', [every('1s')]],
  ['align-hold-noisy', 'noisy', 'align', [every('700ms')]],
  ['align-linear', 'gappy', 'align', [every('1s'), { method: 'linear' }]],
  [
    'align-linear-noisy',
    'noisy',
    'align',
    [every('700ms'), { method: 'linear' }],
  ],
  ['align-center', 'gappy', 'align', [every('3s'), { sample: 'center' }]],
  // a 333 ms step puts each middle on a half millisecond
  [
    'align-linear-center-half-ms',
    'gappy',
    'align',
    [every('333ms'), { method: 'linear', sample: 'center' }],
  ],
  ['align-end', 'gappy', 'align', [every('2s'), { sample: 'end' }]],
  [
    'align-end-linear',
    'gappy',
    'align',
    [every('2s'), { sample: 'end', method: 'linear' }],
  ],
  [
    'align-range',
    'gappy',
    'align',
    [every('2s'), { range: { start: -3000, end: 30000 } }],
  ],
  [
    'align-range-linear',
    'gappy',
    'align',
    [every('2s'), { method: 'linear', range: { start: -3000, end: 30000 } }],
  ],
  ['align-range-point', 'gappy', 'align', [every('1s'), { range: 5000 }]],
  ['align-calendar', 'dst', 'align', [calendar('day', 'America/New_York')]],
  [
    'align-calendar-center',
    'dst',
    'align',
    [calendar('day', 'America/New_York'), { sample: 'center' }],
  ],
  [
    'align-calendar-end',
    'dst',
    'align',
    [calendar('day', 'America/New_York'), { sample: 'end' }],
  ],
  ['align-mixed', 'mixed', 'align', [every('2s')]],
  [
    'align-mixed-linear',
    'mixed',
    'align',
    [every('1500ms'), { method: 'linear' }],
  ],
  // range and interval keys: a row counts when it starts before the point
  ['align-ranges', 'ranges', 'align', [every('1s')]],
  ['align-labelled', 'labelled', 'align', [every('2s')]],
  ['align-buckets', 'buckets', 'align', [every('5s')]],
  // a zero-length interval at the point sorts before it
  ['align-zero-intervals', 'zeroIntervals', 'align', [every('1s')]],
  ['align-empty', 'emptyHosts', 'align', [every('1s')]],
  [
    'align-error-linear-ranges',
    'ranges',
    'align',
    [every('1s'), { method: 'linear' }],
  ],
  ['align-error-key-name', 'intervalColumn', 'align', [every('1s')]],
  [
    'align-error-range-reversed',
    'gappy',
    'align',
    [every('1s'), { range: { start: 5000, end: 0 } }],
  ],
  // materialize: one source row per bucket by start, gaps when empty
  ['materialize-last', 'gappy', 'materialize', [every('2s')]],
  [
    'materialize-first',
    'gappy',
    'materialize',
    [every('2s'), { select: 'first' }],
  ],
  [
    'materialize-nearest-center',
    'gappy',
    'materialize',
    [every('2s'), { select: 'nearest', sample: 'center' }],
  ],
  [
    'materialize-nearest-noisy',
    'noisy',
    'materialize',
    [every('700ms'), { select: 'nearest' }],
  ],
  ['materialize-end', 'gappy', 'materialize', [every('3s'), { sample: 'end' }]],
  [
    'materialize-range',
    'gappy',
    'materialize',
    [every('2s'), { range: { start: -5000, end: 30000 } }],
  ],
  ['materialize-mixed', 'mixed', 'materialize', [every('2500ms')]],
  ['materialize-labelled', 'labelled', 'materialize', [every('3s')]],
  ['materialize-ranges', 'ranges', 'materialize', [every('2s')]],
  ['materialize-zero-intervals', 'zeroIntervals', 'materialize', [every('1s')]],
  [
    'materialize-calendar',
    'dst',
    'materialize',
    [calendar('day', 'America/New_York'), { sample: 'center' }],
  ],
  [
    'materialize-calendar-end',
    'dst',
    'materialize',
    [calendar('day', 'America/New_York'), { sample: 'end' }],
  ],
  ['materialize-empty', 'emptyHosts', 'materialize', [every('1s')]],
  ['materialize-error-key-name', 'timeColumn', 'materialize', [every('1s')]],
  // dedupe: the whole key (time; range start and end; interval span and
  // label) decides a duplicate; groups keep first-appearance order
  ['dedupe-last', 'noisy', 'dedupe', []],
  ['dedupe-first', 'noisy', 'dedupe', [{ keep: 'first' }]],
  ['dedupe-drop', 'noisy', 'dedupe', [{ keep: 'drop' }]],
  ['dedupe-min', 'noisy', 'dedupe', [{ keep: { min: 'x' } }]],
  ['dedupe-max', 'noisy', 'dedupe', [{ keep: { max: 'x' } }]],
  ['dedupe-min-gaps', 'gappyDups', 'dedupe', [{ keep: { min: 'a' } }]],
  ['dedupe-max-gaps', 'gappyDups', 'dedupe', [{ keep: { max: 'a' } }]],
  ['dedupe-none', 'gappy', 'dedupe', [{ keep: 'error' }]],
  ['dedupe-hosts', 'hosts', 'dedupe', [{ keep: 'last' }]],
  ['dedupe-ranges', 'dupRanges', 'dedupe', []],
  ['dedupe-labelled', 'dupLabelled', 'dedupe', []],
  ['dedupe-labelled-drop', 'dupLabelled', 'dedupe', [{ keep: 'drop' }]],
  ['dedupe-empty', 'emptyHosts', 'dedupe', []],
  ['dedupe-error', 'noisy', 'dedupe', [{ keep: 'error' }]],
  ['dedupe-error-ranges', 'dupRanges', 'dedupe', [{ keep: 'error' }]],
  ['dedupe-error-labelled', 'dupLabelled', 'dedupe', [{ keep: 'error' }]],
  // per partition
  [
    'partition-align',
    'hosts',
    'partitionBy',
    ['host', [['align', every('2s')]], 'collect'],
  ],
  [
    'partition-align-toMap',
    'hosts',
    'partitionBy',
    ['host', [['align', every('2s')]], 'toMap'],
  ],
  [
    'partition-align-linear',
    'hosts',
    'partitionBy',
    ['host', [['align', every('1500ms'), { method: 'linear' }]], 'collect'],
  ],
  [
    'partition-materialize',
    'hosts',
    'partitionBy',
    ['host', [['materialize', every('2s')]], 'collect'],
  ],
  [
    'partition-materialize-toMap',
    'hosts',
    'partitionBy',
    [
      ['region', 'up'],
      [['materialize', every('3s'), { select: 'first' }]],
      'toMap',
    ],
  ],
  [
    'partition-dedupe',
    'hosts',
    'partitionBy',
    ['region', [['dedupe', { keep: 'first' }]], 'collect'],
  ],
  [
    'partition-dedupe-then-materialize',
    'hosts',
    'partitionBy',
    [
      'region',
      [
        ['dedupe', { keep: { max: 'cpu' } }],
        ['materialize', every('2s')],
        ['fill', { cpu: 'linear' }],
      ],
      'collect',
    ],
  ],
  // join: exact keys, pairing repeats one to one; a matched row keeps the
  // left key. joinB has 1000 three times to joinA's two. (pond-rs names
  // keys by kind, so a key-name clash is a pond-rs unit test, via Arrow.)
  ['join-outer', 'joinA', 'join', [{ series: 'joinB' }]],
  ['join-inner', 'joinA', 'join', [{ series: 'joinB' }, { type: 'inner' }]],
  ['join-left', 'joinA', 'join', [{ series: 'joinB' }, { type: 'left' }]],
  ['join-right', 'joinA', 'join', [{ series: 'joinB' }, { type: 'right' }]],
  ['join-reversed', 'joinB', 'join', [{ series: 'joinA' }]],
  ['join-same-keys', 'gappy', 'join', [{ series: 'gappyOther' }]],
  ['join-conflict-error', 'gappy', 'join', [{ series: 'joinConflict' }]],
  [
    'join-conflict-prefix',
    'gappy',
    'join',
    [
      { series: 'joinConflict' },
      { onConflict: 'prefix', prefixes: ['l', 'r'] },
    ],
  ],
  [
    'join-self-prefix',
    'gappy',
    'join',
    [
      { series: 'gappy' },
      { type: 'inner', onConflict: 'prefix', prefixes: ['l', 'r'] },
    ],
  ],
  [
    'join-prefix-unused',
    'joinA',
    'join',
    [{ series: 'joinB' }, { onConflict: 'prefix', prefixes: ['x'] }],
  ],
  [
    'join-prefix-count',
    'gappy',
    'join',
    [{ series: 'joinConflict' }, { onConflict: 'prefix', prefixes: ['l'] }],
  ],
  [
    'join-prefix-same',
    'gappy',
    'join',
    [
      { series: 'joinConflict' },
      { onConflict: 'prefix', prefixes: ['p', 'p'] },
    ],
  ],
  ['join-key-kinds', 'joinA', 'join', [{ series: 'ranges2' }]],
  ['join-empty-right', 'joinA', 'join', [{ series: 'joinEmpty' }]],
  ['join-empty-left', 'joinEmpty', 'join', [{ series: 'joinA' }]],
  [
    'join-empty-inner',
    'joinA',
    'join',
    [{ series: 'joinEmpty' }, { type: 'inner' }],
  ],
  ['join-ranges', 'ranges', 'join', [{ series: 'ranges2' }]],
  [
    'join-ranges-inner',
    'ranges',
    'join',
    [{ series: 'ranges2' }, { type: 'inner' }],
  ],
  [
    'join-ranges-right',
    'ranges',
    'join',
    [{ series: 'ranges2' }, { type: 'right' }],
  ],
  // Labels on one span compare as JavaScript's localeCompare: "a" < "B",
  // and a precomposed é equals e + combining accent.
  ['join-labels', 'labelsA', 'join', [{ series: 'labelsB' }]],
  [
    'join-labels-inner',
    'labelsA',
    'join',
    [{ series: 'labelsB' }, { type: 'inner' }],
  ],
  [
    'join-labels-left',
    'labelsA',
    'join',
    [{ series: 'labelsB' }, { type: 'left' }],
  ],
  [
    'join-labels-right',
    'labelsA',
    'join',
    [{ series: 'labelsB' }, { type: 'right' }],
  ],
  ['join-labels-reversed', 'labelsB', 'join', [{ series: 'labelsA' }]],
  ['join-label-kinds', 'labelsA', 'join', [{ series: 'numberLabels' }]],
  [
    'join-label-kinds-inner',
    'labelsA',
    'join',
    [{ series: 'numberLabels' }, { type: 'inner' }],
  ],
  [
    'join-label-kinds-left',
    'labelsA',
    'join',
    [{ series: 'numberLabels' }, { type: 'left' }],
  ],
  [
    'join-label-kinds-right',
    'labelsA',
    'join',
    [{ series: 'numberLabels' }, { type: 'right' }],
  ],
  ['join-number-labels', 'buckets', 'join', [{ series: 'numberLabels' }]],
  [
    'join-zero-intervals',
    'zeroIntervals',
    'join',
    [{ series: 'labelled' }, { onConflict: 'prefix', prefixes: ['z', 'l'] }],
  ],
  // joinMany: names repeated across any of the series take that series'
  // prefix; then left to right.
  [
    'joinMany',
    'joinA',
    'joinMany',
    [[{ series: 'joinB' }, { series: 'joinConflict' }]],
  ],
  [
    'joinMany-inner',
    'joinA',
    'joinMany',
    [[{ series: 'joinB' }, { series: 'joinConflict' }], { type: 'inner' }],
  ],
  [
    'joinMany-prefix',
    'gappy',
    'joinMany',
    [
      [{ series: 'joinConflict' }, { series: 'gappyOther' }],
      { onConflict: 'prefix', prefixes: ['g', 'c', 'o'] },
    ],
  ],
  ['joinMany-conflict', 'gappy', 'joinMany', [[{ series: 'joinConflict' }]]],
  ['joinMany-one', 'joinA', 'joinMany', [[]]],
  [
    'joinMany-prefix-count',
    'gappy',
    'joinMany',
    [[{ series: 'joinConflict' }], { onConflict: 'prefix', prefixes: ['g'] }],
  ],
];

/**
 * The closures a case can name, as `{ fn: spec }`. pond-rs's harness builds
 * the same closure from the same spec.
 */
function closure(spec) {
  if (spec === 'upper') return (v) => v.toUpperCase();
  if (spec === 'not') return (v) => !v;
  if ('mul' in spec) return (v) => v * spec.mul + spec.add;
  if ('column' in spec) {
    return (e) => {
      const v = e.get(spec.column);
      if (v === undefined) return false;
      return 'gt' in spec ? v > spec.gt : v === spec.eq;
    };
  }
  if ('missing' in spec) return (e) => e.get(spec.missing) === undefined;
  if ('everyNth' in spec) return (_e, i) => i % spec.everyNth === 0;
  if ('beginAtLeast' in spec) return (e) => e.begin() >= spec.beginAtLeast;
  if ('endAtMost' in spec) return (e) => e.end() <= spec.endAtMost;
  throw new Error(`unknown closure spec ${JSON.stringify(spec)}`);
}

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

// Time-range keys (begin, end). Rows 0 and 1 share a start, so they sort by
// end; row 2 is zero-length; row 4 overlaps row 3.
const RANGE_SCHEMA = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'a', kind: 'number', required: false },
  { name: 'b', kind: 'number', required: false },
];
const RANGE_ROWS = [
  [[0, 1000], 1, 10],
  [[0, 3000], null, 11],
  [[2000, 2000], 3, null],
  [[5000, 9000], 4, 13],
  [[6000, 8000], -1, 14],
];
// Interval keys labelled with text; labels need not be unique.
const LABELLED_ROWS = [
  [['mon', 0, 4000], 1, 10],
  [['tue', 4000, 8000], null, 12],
  [['mon', 8000, 12000], 5, null],
  [['wed', 12000, 16000], 2, 3],
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

// Three hosts reporting at shared times, interleaved so that the input order
// at a shared time is not partition order, one row with no host, and gaps.
const HOSTS_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string', required: false },
  { name: 'region', kind: 'string' },
  { name: 'up', kind: 'boolean' },
  { name: 'cpu', kind: 'number', required: false },
  { name: 'mem', kind: 'number', required: false },
];
const HOSTS_ROWS = [
  [0, 'b', 'eu', true, 0.5, 10],
  [0, 'a', 'eu', true, 0.25, 20],
  [1000, 'a', 'eu', false, 0.75, 20],
  [1000, 'b', 'eu', true, null, 12],
  [2000, 'c', 'us', true, 1.5, 30],
  [3000, 'a', 'eu', true, null, 22],
  [3000, 'c', 'us', false, 1.25, null],
  [4000, null, 'us', true, 9, 40],
  [5000, 'b', 'eu', true, 0.5, 12],
  [6000, 'b', 'eu', false, 0.0, 14],
  [6000, 'a', 'eu', true, 1, 21],
  [9000, 'c', 'us', true, 2, 31],
  [9000, 'a', 'eu', true, 0.5, null],
  [12000, 'b', 'eu', true, null, 16],
  [13000, 'a', 'eu', false, 0.25, 24],
  [20000, 'c', 'us', true, 3, 33],
  [21000, 'a', 'eu', true, 0.75, 25],
  [21000, 'b', 'eu', true, 1.25, 15],
];

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

/** The `ranges` input series, also exported to Arrow by export.mjs. */
export function rangesSeries(pond) {
  return pond.TimeSeries.fromJSON({
    name: 'ranges',
    schema: RANGE_SCHEMA,
    rows: RANGE_ROWS,
  });
}

/** The `labelled` input series, also exported to Arrow by export.mjs. */
export function labelledSeries(pond) {
  return pond.TimeSeries.fromJSON({
    name: 'labelled',
    schema: INTERVAL_SCHEMA,
    rows: LABELLED_ROWS,
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
    zeros: series('zeros', ZERO_ROWS),
    edges: series('edges', EDGE_ROWS),
    overflow: series('overflow', OVERFLOW_ROWS),
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
    ranges: rangesSeries(pond),
    labelled: labelledSeries(pond),
    hosts: TimeSeries.fromJSON({
      name: 'hosts',
      schema: HOSTS_SCHEMA,
      rows: HOSTS_ROWS,
    }),
    emptyHosts: TimeSeries.fromJSON({
      name: 'emptyHosts',
      schema: HOSTS_SCHEMA,
      rows: [],
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
    // Zero-length intervals, one at each grid point.
    zeroIntervals: TimeSeries.fromJSON({
      name: 'zeroIntervals',
      schema: INTERVAL_SCHEMA,
      rows: [
        [[0, 0, 0], 1, 10],
        [[0, 0, 1000], 2, null],
        [[1000, 1000, 1000], 3, 12],
      ],
    }),
    // A value column named `interval` clashes with the key `align` makes.
    intervalColumn: TimeSeries.fromJSON({
      name: 'intervalColumn',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'interval', kind: 'number' },
      ],
      rows: [[0, 1]],
    }),
    // Repeated times with gaps in the column `min` / `max` read.
    gappyDups: TimeSeries.fromJSON({
      name: 'gappyDups',
      schema: GAPPY_SCHEMA,
      rows: [
        [0, null, 1],
        [0, 3, 2],
        [0, 1, 3],
        [0, 1, 4],
        [1000, null, 5],
        [1000, null, 6],
        [2000, -0, 7],
        [2000, 0, 8],
      ],
    }),
    dupRanges: TimeSeries.fromJSON({
      name: 'dupRanges',
      schema: RANGE_SCHEMA,
      rows: [
        [[0, 1000], 1, 10],
        [[0, 1000], 2, null],
        [[0, 3000], 3, 12],
        [[2000, 2000], 4, 13],
        [[2000, 2000], 5, 14],
      ],
    }),
    // Same span, labels interleaved: pond-ts groups by label, in the order
    // each label first appears.
    dupLabelled: TimeSeries.fromJSON({
      name: 'dupLabelled',
      schema: INTERVAL_SCHEMA,
      rows: [
        [['a', 0, 10], 1, 10],
        [['b', 0, 10], 2, 11],
        [['a', 0, 10], 3, 12],
        [['b', 10, 20], 4, 13],
        [['c', 20, 30], 5, 14],
      ],
    }),
    joinA: TimeSeries.fromJSON({
      name: 'joinA',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'cpu', kind: 'number', required: false },
        { name: 'host', kind: 'string', required: false },
      ],
      rows: [
        [0, 0.5, 'a'],
        [1000, 0.75, 'b'],
        [1000, null, 'c'],
        [2000, 1.25, null],
        [4000, 2, 'd'],
      ],
    }),
    joinB: TimeSeries.fromJSON({
      name: 'joinB',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'mem', kind: 'number' },
        { name: 'up', kind: 'boolean' },
      ],
      rows: [
        [1000, 10, true],
        [1000, 11, false],
        [1000, 12, true],
        [3000, 13, false],
        [4000, 14, true],
        [5000, 15, false],
      ],
    }),
    joinConflict: TimeSeries.fromJSON({
      name: 'joinConflict',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'a', kind: 'number' },
      ],
      rows: [
        [0, 100],
        [1000, 200],
        [30000, 300],
      ],
    }),
    // gappy's keys exactly, so both sides pass through.
    gappyOther: TimeSeries.fromJSON({
      name: 'gappyOther',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'c', kind: 'number', required: false },
      ],
      rows: GAPPY_ROWS.map(([t], i) => [t, i % 4 === 0 ? null : i]),
    }),
    joinEmpty: TimeSeries.fromJSON({
      name: 'joinEmpty',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'w', kind: 'number' },
      ],
      rows: [],
    }),
    ranges2: TimeSeries.fromJSON({
      name: 'ranges2',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'c', kind: 'number' },
      ],
      rows: [
        [[0, 1000], 5],
        [[0, 3000], 6],
        [[2000, 2000], 7],
        [[2000, 2000], 8],
        [[7000, 9000], 9],
      ],
    }),
    labelsA: TimeSeries.fromJSON({
      name: 'labelsA',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'p', kind: 'number' },
      ],
      rows: [
        [['b', 0, 10], 1],
        [['a', 0, 10], 2],
        [['B', 0, 10], 3],
        [['\u00e9', 10, 20], 4],
        [['x', 20, 30], 5],
      ],
    }),
    labelsB: TimeSeries.fromJSON({
      name: 'labelsB',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'q', kind: 'number' },
      ],
      rows: [
        [['a', 0, 10], 10],
        [['b', 0, 10], 11],
        [['A', 0, 10], 12],
        [['e\u0301', 10, 20], 13],
        [['x', 20, 30], 14],
        [['y', 20, 30], 15],
      ],
    }),
    numberLabels: TimeSeries.fromJSON({
      name: 'numberLabels',
      schema: [
        { name: 'interval', kind: 'interval' },
        { name: 'r', kind: 'number' },
      ],
      rows: [
        [[0, 0, 10], 1],
        [[7, 10, 20], 2],
        [[5000, 5000, 10000], 3],
      ],
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
    // withColumn's values: JSON has no `undefined`, so `null` marks a gap.
    if (Array.isArray(arg)) return arg.map((v) => (v === null ? undefined : v));
    if (arg && typeof arg === 'object' && 'fn' in arg) return closure(arg.fn);
    // mapColumns: { column: { fn } }. Only a mapping whose every value is a
    // closure spec, so an options object is never touched.
    const isClosure = (v) => v && typeof v === 'object' && 'fn' in v;
    if (
      arg &&
      typeof arg === 'object' &&
      Object.keys(arg).length > 0 &&
      Object.values(arg).every(isClosure)
    ) {
      return Object.fromEntries(
        Object.entries(arg).map(([k, v]) => [k, decode(v)]),
      );
    }
    // Another input series, by name (join / joinMany).
    if (arg && typeof arg === 'object' && 'series' in arg) {
      return inputs[arg.series];
    }
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
        'series are TimeSeries.toJSON(); null = missing; -0/NaN/±Infinity tagged as {"f64":"-0"|"NaN"|"inf"|"-inf"}; args encode Sequence.every(d) as {"sequence":{"every":d}} and Sequence.calendar(u, {timeZone, weekStartsOn}) as {"sequence":{"calendar":u,"timeZone":z,"weekStartsOn"?:w}}; a case has expected (series), groups ([key, series] pairs, from toMap / groupBy) or error ({name,message}); partitionBy args are [by, steps, end] with steps [[method, ...args]] run on the partitioned view and end "collect" or "toMap"; {"series":name} is another input series; joinMany args are [[others...], options?] and call TimeSeries.joinMany([input, ...others], options); exact unless tolerance is set; timeParse holds Time.parse(input, {timeZone}) as expected (ms) or error (its name)',
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
        if (op === 'partitionBy') {
          const [by, steps, end] = args;
          let view = inputs[input].partitionBy(by);
          for (const [method, ...rest] of steps) {
            view = view[method](...rest.map(decode));
          }
          result = end === 'toMap' ? view.toMap() : view.collect();
        } else if (op === 'joinMany') {
          const [others, options] = args;
          result = TimeSeries.joinMany(
            [inputs[input], ...others.map(decode)],
            options,
          );
        } else {
          result = inputs[input][op](...args.map(decode));
        }
      } catch (e) {
        return { ...head, error: { name: e.name, message: e.message } };
      }
      if (result instanceof Map) {
        return {
          ...head,
          groups: [...result].map(([key, series]) => [
            key,
            encodeSeries(series),
          ]),
        };
      }
      return { ...head, expected: encodeSeries(result) };
    }),
    timeParse: TIME_PARSE_TEXTS.flatMap((input) =>
      TIME_PARSE_ZONES.map((timeZone) => {
        try {
          const expected = pond.Time.parse(input, { timeZone }).timestamp;
          return { input, timeZone, expected };
        } catch (e) {
          return { input, timeZone, error: e.name };
        }
      }),
    ),
  };
}
