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

// Runs of equal values for `keep` and `difference`: zeros of both signs in
// both orders (a rolling `difference` of zeros can be `-0`), equal runs
// broken by one value, gaps inside runs, and text and true/false runs. The
// text includes '\uffff' and '😀', which JavaScript sorts in the opposite
// order to their UTF-8 bytes (for `unique` / `top`).
const RUNS_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 's', kind: 'string', required: false },
  { name: 'b', kind: 'boolean', required: false },
];
const RUNS_V = [
  5,
  5,
  null,
  5,
  0,
  -0,
  0,
  -0,
  -0,
  0,
  2,
  3,
  7,
  null,
  7,
  -0,
  0,
  -0,
  1,
  1,
  1,
  null,
  null,
  null,
  4,
  -0,
  0,
  9,
  9,
  8,
];
const RUNS_S = [
  'a',
  'a',
  null,
  'a',
  'b',
  'b',
  'c',
  'c',
  'c',
  null,
  '',
  '',
  '\uffff',
  '😀',
  '\uffff',
  null,
  null,
  null,
  'f',
  'f',
  'g',
  'g',
  'g',
  'g',
  null,
  'h',
  'h',
  'h',
  'i',
  'h',
];
const RUNS_ROWS = RUNS_V.map((v, i) => [
  i < 25 ? i * 1000 : 25_000 + (i - 25) * 400,
  v,
  RUNS_S[i],
  i % 7 === 3 ? null : i % 11 < 6,
]);

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

// `Time.parse(text, { timeZone })` over every pairing of these texts and
// zones, recorded as `timeParse` (milliseconds, or the error's name). The
// texts cover each of pond-ts's three local shapes (month, day, wall-clock
// time), clock changes in both directions (including Santiago and São
// Paulo, whose clocks once skipped midnight), sub-millisecond fractions
// before 1970 (which round down), leap seconds, the offset forms and
// bracketed notes Temporal accepts or refuses, and zones written as
// offsets. Left out because pond-rs reads them differently (pinned in its
// own tests): years beyond ±9999, times after 9999-12-30, and offsets with
// fractions of a second. Also kept away from zones whose history differs
// between Node's tz database and pond-rs's (far-future Casablanca, old
// EST5EDT).
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
  '2025-01-01T09:00:00Z[!u-ca=iso8601]',
  '2025-01-01T09:00:00Z[!u-ca=japanese]',
  '2025-01-01T09:00:00Z[foo=bar]',
  '2025-01-01T09:00:00Z[!foo=bar]',
  '2025-01-01T09:00:00Z[!u-ca=iso8601][u-ca=gregory]',
  '2025-01-01T09:00:00Z[u-ca=iso8601][Europe/Madrid]',
  '2025-01-01T09:00:00Z[UTC][!u-ca=iso8601][foo=bar]',
  '2025-01-01T09:00:00Z[+01:00]',
  '2025-01-01T09:00:00Z[+0100]',
  '2025-01-01T09:00:00Z[+01:00:30]',
  '2025-01-01T09:00:00Z[+24:00]',
  '2025-01-01T09:00:00Z[1Foo]',
  '2025-01-01T09:00:00Z[_x/Foo-Bar+5]',
  '2025-01-01T09:00:00Z[Foo//Bar]',
  '2025-01-01T09:00:00Z[x:y]',
  '2025-01-01T09:00:00Z[U-CA=iso8601]',
  '2025-01-01T09:00:00Z[a=b--c]',
  '2025-01-01T09:00:00Z[]',
  '2025-01-01T09:00:00Z[u-ca=]',
  '2025-01-01T09:00:00Z[UTC]x',
  '2025-01-01T09:00:00Z[Europe/Madrid',
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
  '+05:30',
  '-03',
];

// Row lookups: every key below against every input below, for each of
// bisect / includesKey / atOrBefore / atOrAfter / nearest. A key is a
// pond-ts KeyLike: a number is a time, [start, end] a time range, [label,
// start, end] an interval. Keys of every kind meet inputs of every kind, so
// the cross-kind order (start, end, kind name, then label) is pinned too.
const QUERY_INPUTS = [
  'gappy',
  'gappyDups',
  'emptyHosts',
  'ranges',
  'dupRanges',
  'labelled',
  'dupLabelled',
  'buckets',
  'zeroIntervals',
];
const QUERY_KEYS = [
  -1000,
  0,
  1,
  500,
  999,
  1000,
  1750,
  2000,
  2500,
  2750,
  4000,
  9250,
  12000,
  21250,
  21500,
  30000,
  [0, 0],
  [0, 10],
  [0, 500],
  [0, 1000],
  [0, 3000],
  [0, 5000],
  [2000, 2000],
  [5000, 9000],
  [6000, 8000],
  [10, 20],
  [1000, 0],
  ['a', 0, 10],
  ['b', 0, 10],
  ['B', 0, 10],
  ['A', 0, 10],
  ['c', 0, 10],
  ['', 0, 10],
  ['_', 0, 10],
  ['1', 0, 10],
  [0, 0, 10],
  ['mon', 0, 4000],
  ['Mon', 0, 4000],
  ['tue', 4000, 8000],
  ['mon', 8000, 12000],
  ['mon', 8000, 11999],
  [0, 0, 5000],
  [-0, 0, 5000],
  [5000, 5000, 10000],
  [4999, 0, 5000],
  ['0', 0, 5000],
  [1, 0, 0],
  [0, 0, 0],
  [1000, 1000, 1000],
  ['x', 20, 30],
  ['c', 20, 30],
  [0, 10, 0],
];
const QUERY_KEY_OPS = [
  'bisect',
  'includesKey',
  'atOrBefore',
  'atOrAfter',
  'nearest',
];
// overlaps / contains / intersection: the series' whole span against these
// (`{ time: t }` is a Time key; inclusive ends).
const QUERY_SPAN_KEYS = [
  [0, 21500],
  [-5000, 0],
  [21500, 30000],
  [21501, 30000],
  [2000, 9000],
  [-5000, 99999],
  ['x', 4000, 8000],
  { time: 0 },
  { time: 16000 },
  [9000, 2000],
];
const QUERY_POSITIONS = [-7, -6, -5, -2, -1, 0, 1, 4, 5, 11, 12];
// find / some / every: the same tests `filter` cases use.
const QUERY_TESTS = [
  { everyNth: 3 },
  { beginAtLeast: 5000 },
  { beginAtLeast: 99999 },
  { endAtMost: 4000 },
  { endAtMost: -1 },
  { missing: 'a' },
  { column: 'a', gt: 3 },
];

// Picking a time span: each op below over inputs of every key kind. A
// `{ time: t }` arg is a pond-ts `Time` key (a bare number is not a RangeLike
// in pond-ts); [start, end] is a time range, [label, start, end] an interval.
// Spans are inclusive; `trim` on ranges / intervals clips keys, and some of
// these clips bring two keys to one start (ranges at 6500, overlap at 1500).
const SPAN_INPUTS = [
  'gappy',
  'gappyDups',
  'emptyHosts',
  'ranges',
  'dupRanges',
  'buckets',
  'overlap',
  'labelled',
  'zeroIntervals',
];
const SPAN_RANGES = [
  [2000, 9000],
  [0, 0],
  [1000, 7000],
  [6500, 20000],
  [1500, 9000],
  [3000, 3000],
  ['x', 2500, 12000],
  { time: 2000 },
  [9000, 2000],
];
// before / after take a time or a key object (a bare [start, end] is not a
// BoundaryLike, and pond-ts compares against it as NaN, keeping nothing).
const SPAN_BOUNDARIES = [
  { time: 2500 },
  { time: 9000 },
  { timeRange: [2000, 9000] },
  { interval: ['x', 3000, 5000] },
];
const SPAN_CASES = SPAN_INPUTS.flatMap((input) => [
  ...['overlapping', 'containedBy', 'trim'].flatMap((op) =>
    SPAN_RANGES.map((r, i) => [`span-${op}-${input}-${i}`, input, op, [r]]),
  ),
  ...['before', 'after'].flatMap((op) =>
    SPAN_BOUNDARIES.map((b, i) => [`span-${op}-${input}-${i}`, input, op, [b]]),
  ),
  ...[
    [2000, 9000],
    [0, 21500],
    [9000, 2000],
  ].map(([b, e], i) => [`span-within-${input}-${i}`, input, 'within', [b, e]]),
]);

// Changing key type: asTimeRange, asInterval (a constant label, or a
// function of (range, index): closure specs rangeBegin / rangeEnd /
// rowLabel / mixedLabel), offsetTime (ms or a duration, '-' for earlier).
const KEY_INPUTS = [
  'gappy',
  'ranges',
  'labelled',
  'buckets',
  'emptyHosts',
  'intervalColumn',
];
const KEY_CASES = KEY_INPUTS.flatMap((input) => [
  [`key-asTimeRange-${input}`, input, 'asTimeRange', []],
  ...[
    'day',
    7,
    { f64: '-0' }, // JSON drops the sign of a bare -0
    { fn: 'rangeBegin' },
    { fn: 'rangeEnd' },
    { fn: 'rowLabel' },
    { fn: 'mixedLabel' },
  ].map((label, i) => [
    `key-asInterval-${input}-${i}`,
    input,
    'asInterval',
    [label],
  ]),
  ...['1m', '-1h', '0s', '-0s', 2500, -1000, 0, '1.5s', '+1s', '--1s'].map(
    (by, i) => [`key-offsetTime-${input}-${i}`, input, 'offsetTime', [by]],
  ),
]);

// fromJSON payloads, beyond each input's own round trip: every key form, time
// strings in a zone, object rows, the three orderings, and the errors.
// [id, payload, options?]; the payload's name is always 'j'.
const JSON_TIME_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 's', kind: 'string', required: false },
  { name: 'b', kind: 'boolean', required: false },
];
const JSON_RANGE_SCHEMA = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'v', kind: 'number', required: false },
];
const JSON_INTERVAL_SCHEMA = [
  { name: 'interval', kind: 'interval' },
  { name: 'v', kind: 'number', required: false },
];
const jsonTime = (rows) => ({ schema: JSON_TIME_SCHEMA, rows });
const jsonRange = (rows) => ({ schema: JSON_RANGE_SCHEMA, rows });
const jsonInterval = (rows) => ({ schema: JSON_INTERVAL_SCHEMA, rows });
const UNSORTED = [
  [3000, 1, 'a', true],
  [1000, 2, 'b', false],
  [2000, 3, null, null],
  [1000, 4, 'd', true],
  [5000, 5, 'e', false],
];
const JSON_PAYLOADS = [
  [
    'plain',
    jsonTime([
      [0, 1.5, 'a', true],
      [1000, null, null, null],
    ]),
  ],
  ['empty', jsonTime([])],
  ['emptyInterval', jsonInterval([])],
  [
    'objects',
    jsonTime([
      { time: 0, v: 1, s: 'x', b: false, extra: 9 },
      { time: 1000, s: 'y' },
      { b: true, time: 2000 },
    ]),
  ],
  ['objectNoKey', jsonTime([{ v: 1 }])],
  ['nullKey', jsonTime([[null, 1, 'a', true]])],
  ...['UTC', 'Europe/Madrid', 'America/Santiago', 'Pacific/Apia'].flatMap(
    (timeZone) =>
      [
        [
          'strings',
          jsonTime([
            ['2025-03', 1, null, null],
            ['2025-03-30', 2, null, null],
            ['2025-03-30T01:30', 3, null, null],
            ['2025-03-30T02:30', 4, null, null],
            ['2025-03-30T03:30:15.250', 5, null, null],
            ['2025-03-30T12:00:00Z', 6, null, null],
            ['2025-03-30T14:00:00+02:00', 7, null, null],
            ['2025-10-26T02:30', 8, null, null],
          ]),
        ],
        ['badString', jsonTime([['30/03/2025', 1, null, null]])],
        ['numericString', jsonTime([['1000', 1, null, null]])],
      ].map(([id, payload]) => [`${id}-${timeZone}`, payload, { timeZone }]),
  ),
  ['stringsDefaultZone', jsonTime([['2025-03-30T01:30', 1, null, null]])],
  ['boolKey', jsonTime([[true, 1, null, null]])],
  ['arrayKey', jsonTime([[[0, 1], 1, null, null]])],
  [
    'required',
    {
      ...jsonTime([[0, 1]]),
      schema: JSON_TIME_SCHEMA.slice(0, 2).map((c) => ({
        name: c.name,
        kind: c.kind,
      })),
    },
  ],
  [
    'requiredNull',
    {
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ],
      rows: [[0, null]],
    },
  ],
  ['numberAsString', jsonTime([[0, '5', null, null]])],
  ['stringAsNumber', jsonTime([[0, null, 5, null]])],
  ['boolAsNumber', jsonTime([[0, null, null, 1]])],
  ['numberAsBool', jsonTime([[0, true, null, null]])],
  ['short', jsonTime([[0, 1, 'a']])],
  ['long', jsonTime([[0, 1, 'a', true, 9]])],
  ['unsorted', jsonTime(UNSORTED)],
  ['unsorted-reorder', jsonTime(UNSORTED), { ordering: 'reorder' }],
  ['unsorted-clamp', jsonTime(UNSORTED), { ordering: 'clamp' }],
  [
    'sorted-clamp',
    jsonTime([
      [0, 1, null, null],
      [0, 2, null, null],
    ]),
    { ordering: 'clamp' },
  ],
  [
    'ranges',
    jsonRange([
      [[0, 1000], 1],
      [{ start: 0, end: 2000 }, 2],
      [['2025-01-01', '2025-01-02'], 3],
    ]),
  ],
  [
    'rangesZone',
    jsonRange([[['2025-03-30', '2025-03-31'], 1]]),
    { timeZone: 'Europe/Madrid' },
  ],
  ['rangeBackwards', jsonRange([[[1000, 0], 1]])],
  ['rangeNumber', jsonRange([[1000, 1]])],
  ['rangeTriple', jsonRange([[[0, 1000, 2000], 1]])],
  ['rangeObjectWithValue', jsonRange([[{ value: 'x', start: 0, end: 1 }, 1]])],
  [
    'rangesUnsorted-reorder',
    jsonRange([
      [[5, 9], 1],
      [[0, 9], 2],
      [[0, 3], 3],
      [[5, 9], 4],
    ]),
    { ordering: 'reorder' },
  ],
  [
    'rangesUnsorted',
    jsonRange([
      [[0, 9], 1],
      [[0, 3], 2],
    ]),
  ],
  ['rangesSorted-clamp', jsonRange([[[0, 3], 1]]), { ordering: 'clamp' }],
  [
    'intervals',
    jsonInterval([
      [['a', 0, 1000], 1],
      [{ value: 'b', start: 1000, end: 2000 }, 2],
    ]),
  ],
  [
    'intervalNumbers',
    jsonInterval([
      [[7, 0, 1000], 1],
      [[-2.5, 1000, 2000], 2],
    ]),
  ],
  [
    'intervalStrings',
    jsonInterval([[['day', '2025-03-30', '2025-03-31'], 1]]),
    { timeZone: 'Europe/Madrid' },
  ],
  [
    'intervalMixed',
    jsonInterval([
      [['a', 0, 1000], 1],
      [[1, 1000, 2000], 2],
    ]),
  ],
  ['intervalBoolLabel', jsonInterval([[[true, 0, 1000], 1]])],
  ['intervalNullLabel', jsonInterval([[[null, 0, 1000], 1]])],
  ['intervalBackwards', jsonInterval([[['a', 1000, 0], 1]])],
  ['intervalPair', jsonInterval([[[0, 1000], 1]])],
  [
    'intervalsSameSpan-reorder',
    jsonInterval([
      [['b', 5, 9], 1],
      [['a', 0, 9], 2],
      [['z', 5, 9], 3],
      [['a', 5, 9], 4],
    ]),
    { ordering: 'reorder' },
  ],
  [
    'keyNamedTs',
    {
      schema: [
        { name: 'ts', kind: 'time' },
        { name: 'v', kind: 'number' },
      ],
      rows: [[0, 1]],
    },
  ],
  ['schemaEmpty', { schema: [], rows: [] }],
  ['schemaKeyNumber', { schema: [{ name: 'n', kind: 'number' }], rows: [] }],
  [
    'schemaUnknownKind',
    {
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'float' },
      ],
      rows: [],
    },
  ],
  [
    'schemaDuplicate',
    {
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
        { name: 'v', kind: 'string' },
      ],
      rows: [],
    },
  ],
  [
    'schemaKeyNameClash',
    {
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'time', kind: 'number' },
      ],
      rows: [],
    },
  ],
  [
    'keyOnly',
    { schema: [{ name: 'time', kind: 'time' }], rows: [[0], [1000]] },
  ],
  [
    'wholeFloatKey',
    jsonTime([
      [1000.0, 1, null, null],
      [2e3, 2, null, null],
    ]),
  ],
  ['fractionKey', jsonTime([[1.5, 1, null, null]])],
  ['farKey', jsonTime([[8.64e15 + 1, 1, null, null]])],
  [
    'bigNumbers',
    jsonTime([
      [0, 1.7976931348623157e308, null, null],
      [1, 5e-324, null, null],
      [2, 0.1, null, null],
    ]),
  ],
  ['unicode', jsonTime([[0, null, 'héllo − 😀', null]])],
];

// fromColumns payloads, beyond each input's own round trip: every key kind
// with its flattened columns, the orderings, the errors, and the cells
// pond-ts coerces (which pond-rs refuses). [id, {schema, columns}, options?];
// the payload's name is 'c' unless given.
const COL_TIME_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 's', kind: 'string', required: false },
];
const COL_RANGE_SCHEMA = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'v', kind: 'number', required: false },
];
const COL_INTERVAL_SCHEMA = [
  { name: 'interval', kind: 'interval' },
  { name: 'v', kind: 'number', required: false },
];
const colTime = (time, v, s, extra = {}) => ({
  schema: COL_TIME_SCHEMA,
  columns: { time, v, s, ...extra },
});
const colRange = (timeRange, timeRangeEnd, v) => ({
  schema: COL_RANGE_SCHEMA,
  columns: { timeRange, timeRangeEnd, v },
});
const colInterval = (interval, intervalEnd, intervalLabel, v) => ({
  schema: COL_INTERVAL_SCHEMA,
  columns: { interval, intervalEnd, intervalLabel, v },
});
const UNSORTED_TIMES = [3000, 1000, 2000, 1000, 5000];
const COLUMN_PAYLOADS = [
  ['plain', colTime([0, 1000], [1.5, null], ['a', null])],
  ['empty', colTime([], [], [])],
  ['extra', colTime([0], [1], ['a'], { other: [1, 2, 3] })],
  [
    'requiredGap',
    {
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
        { name: 's', kind: 'string' },
      ],
      columns: { time: [0, 1], v: [1, null], s: [null, 'b'] },
    },
  ],
  [
    'requiredFull',
    {
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ],
      columns: { time: [0, 1], v: [1, 2] },
    },
  ],
  [
    'keyOnly',
    { schema: [{ name: 'time', kind: 'time' }], columns: { time: [0, 5] } },
  ],
  [
    'otherKeyName',
    {
      schema: [
        { name: 'at', kind: 'time' },
        { name: 'v', kind: 'number', required: false },
      ],
      columns: { at: [0, 5], v: [1, null] },
    },
  ],
  ['noName', { name: undefined, ...colTime([0], [1], ['a']) }],
  ['missingKey', { schema: COL_TIME_SCHEMA, columns: { v: [1], s: ['a'] } }],
  ['missingValue', { schema: COL_TIME_SCHEMA, columns: { time: [0], v: [1] } }],
  ['shortValue', colTime([0, 1], [1], ['a', 'b'])],
  ['longValue', colTime([0], [1], ['a', 'b'])],
  ['nullKey', colTime([null], [1], ['a'])],
  ['textDateKey', colTime(['2025-01-01'], [1], ['a'])],
  [
    'booleanKind',
    {
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'b', kind: 'boolean', required: false },
      ],
      columns: { time: [0], b: [true] },
    },
  ],
  [
    'arrayKind',
    {
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'a', kind: 'array', required: false },
      ],
      columns: { time: [0], a: [[1]] },
    },
  ],
  [
    'badKeyKind',
    {
      schema: [
        { name: 'v', kind: 'number' },
        { name: 'w', kind: 'number' },
      ],
      columns: { v: [0], w: [1] },
    },
  ],
  [
    'duplicateName',
    {
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number', required: false },
        { name: 'v', kind: 'number', required: false },
      ],
      columns: { time: [0], v: [1] },
    },
  ],
  [
    'unsorted',
    colTime(UNSORTED_TIMES, [1, 2, 3, 4, 5], ['a', 'b', null, 'd', 'e']),
  ],
  [
    'unsorted-reorder',
    colTime(UNSORTED_TIMES, [1, 2, 3, 4, 5], ['a', 'b', null, 'd', 'e']),
    { ordering: 'reorder' },
  ],
  [
    'unsorted-clamp',
    colTime(UNSORTED_TIMES, [1, 2, 3, 4, 5], ['a', 'b', null, 'd', 'e']),
    { ordering: 'clamp' },
  ],
  ['sorted-clamp', colTime([0, 0], [1, 2], ['a', 'b']), { ordering: 'clamp' }],
  ['ranges', colRange([0, 0, 5], [1000, 2000, 5], [1, null, 3])],
  ['rangesBackwards', colRange([1000], [0], [1])],
  [
    'rangesMissingEnd',
    { schema: COL_RANGE_SCHEMA, columns: { timeRange: [0], v: [1] } },
  ],
  ['rangesShortEnd', colRange([0, 1], [5], [1, 2])],
  [
    'rangesUnsorted-reorder',
    colRange([5, 0, 0, 5], [9, 9, 3, 9], [1, 2, 3, 4]),
    { ordering: 'reorder' },
  ],
  ['rangesUnsorted', colRange([0, 0], [9, 3], [1, 2])],
  ['rangesSorted-clamp', colRange([0], [3], [1]), { ordering: 'clamp' }],
  [
    'rangesCollision',
    {
      schema: [...COL_RANGE_SCHEMA, { name: 'timeRangeEnd', kind: 'number' }],
      columns: { timeRange: [0], timeRangeEnd: [5], v: [1] },
    },
  ],
  ['intervals', colInterval([0, 1000], [1000, 2000], ['a', 'b'], [1, null])],
  ['intervalsNumber', colInterval([0, 1000], [1000, 2000], [0, -0], [1, 2])],
  ['intervalsMixed', colInterval([0, 1000], [1000, 2000], ['a', 3], [1, 2])],
  ['intervalsNullLabel', colInterval([0], [1000], [null], [1])],
  ['intervalsBoolLabel', colInterval([0], [1000], [true], [1])],
  [
    'intervalsMissingLabel',
    {
      schema: COL_INTERVAL_SCHEMA,
      columns: { interval: [0], intervalEnd: [1], v: [1] },
    },
  ],
  ['intervalsShortLabel', colInterval([0, 1], [1, 2], ['a'], [1, 2])],
  [
    'intervalsUnsorted-reorder',
    colInterval([5, 0, 0], [9, 9, 3], ['x', 'y', 'z'], [1, 2, 3]),
    { ordering: 'reorder' },
  ],
  [
    'intervalsCollision',
    {
      schema: [
        ...COL_INTERVAL_SCHEMA,
        { name: 'intervalLabel', kind: 'string' },
      ],
      columns: {
        interval: [0],
        intervalEnd: [5],
        intervalLabel: ['a'],
        v: [1],
      },
    },
  ],
  // Accepted by pond-ts, refused by pond-rs: pond-ts coerces the cell.
  ['numberAsText', colTime([0], ['5'], [null])],
  ['numberAsBool', colTime([0], [true], [null])],
  ['textAsNumber', colTime([0], [null], [5])],
  ['keyAsText', colTime(['5'], [1], [null])],
  ['keyAsBool', colTime([true], [1], [null])],
  ['fractionKey', colTime([1.5], [1], [null])],
  ['farKey', colTime([8.64e15 + 1], [1], [null])],
];

// fromPoints payloads, beyond each time-keyed input's round trip.
// [id, points, schema]; the name is always 'p'.
const POINT_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 's', kind: 'string', required: false },
  { name: 'b', kind: 'boolean', required: false },
];
const POINT_PAYLOADS = [
  [
    'plain',
    [
      { ts: 0, v: 1.5, s: 'a', b: true },
      { ts: 1000, v: null, s: null, b: null },
      { ts: 2000 },
      { s: 'x', ts: 3000, other: 9 },
    ],
    POINT_SCHEMA,
  ],
  ['empty', [], POINT_SCHEMA],
  [
    'equalTimes',
    [
      { ts: 5, v: 1 },
      { ts: 5, v: 2 },
    ],
    POINT_SCHEMA,
  ],
  ['unsorted', [{ ts: 5 }, { ts: 0 }], POINT_SCHEMA],
  ['noTs', [{ v: 1 }], POINT_SCHEMA],
  ['nullTs', [{ ts: null }], POINT_SCHEMA],
  ['textTs', [{ ts: '2025-01-01T00:00:00Z' }], POINT_SCHEMA],
  ['arrayPoint', [[0, 1]], POINT_SCHEMA],
  ['nullPoint', [null], POINT_SCHEMA],
  ['numberAsText', [{ ts: 0, v: '5' }], POINT_SCHEMA],
  ['textAsNumber', [{ ts: 0, s: 5 }], POINT_SCHEMA],
  ['boolAsNumber', [{ ts: 0, b: 1 }], POINT_SCHEMA],
  [
    'requiredGap',
    [{ ts: 0 }],
    [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ],
  ],
  [
    'requiredFull',
    [{ ts: 0, v: 2 }],
    [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ],
  ],
  ['keyOnly', [{ ts: 0 }], [{ name: 'time', kind: 'time' }]],
  [
    'rangeKey',
    [{ ts: 0, v: 1 }],
    [{ name: 'timeRange', kind: 'timeRange' }, POINT_SCHEMA[1]],
  ],
  // Accepted by pond-ts, refused by pond-rs.
  ['fractionTs', [{ ts: 1.5, v: 1 }], POINT_SCHEMA],
  ['farTs', [{ ts: 8.64e15 + 1, v: 1 }], POINT_SCHEMA],
  [
    'tsColumn',
    [{ ts: 7 }],
    [
      { name: 'time', kind: 'time' },
      { name: 'ts', kind: 'number' },
    ],
  ],
];

// Array columns. `tags` holds text, `nums` numbers (with -0 and 0, in both
// orders), `items` mixes kinds. Rows at 3000 repeat a time.
const TAGS_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'tags', kind: 'array', required: false },
  { name: 'nums', kind: 'array', required: false },
  { name: 'v', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
];
const TAGS_ROWS = [
  [0, ['a', 'b', 'a'], [3, 1, 2], 1, 'x'],
  [1000, [], [], 2, 'y'],
  [2000, null, null, null, 'x'],
  [3000, ['b'], [-0, 0, 2, 3.5], 4, 'y'],
  [3000, ['c', 'a'], [1.5], 5, 'x'],
  [5000, ['a,b'], [10, 9, 10], 6, 'y'],
  [6000, null, [0, -0], null, 'x'],
  [8000, ['b', 'c'], [], 8, 'y'],
  [9000, ['é', 'B', ''], [1e300, 1e300], 9, 'x'],
];
const ITEMS_SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'items', kind: 'array', required: false },
];
const ITEMS_ROWS = [
  [0, [1, '1', true]],
  [1000, [0, 'x', false]],
  [2000, ['1']],
  [3000, [-0]],
  [4000, [true, 2.5]],
  [5000, null],
  [6000, []],
];
const ARRAY_REDUCERS = [
  'count',
  'sum',
  'avg',
  'mean',
  'min',
  'max',
  'median',
  'p25',
  'p90',
  'stdev',
  'difference',
  'unique',
  'top2',
  'samples',
];
const ARRAY_CASES = [
  ...[1, '1', true, 0, { f64: '-0' }, false, 'zz', 2.5].map((v, i) => [
    `arrayContains-items-${i}`,
    'items',
    'arrayContains',
    ['items', v],
  ]),
  ['arrayContains-tags-a', 'tags', 'arrayContains', ['tags', 'a']],
  ['arrayContains-tags-comma', 'tags', 'arrayContains', ['tags', 'a,b']],
  ...[[], [1, '1'], ['1'], [true, 1], ['zz']].map((vs, i) => [
    `arrayContainsAll-items-${i}`,
    'items',
    'arrayContainsAll',
    ['items', vs],
  ]),
  ['arrayContainsAll-tags', 'tags', 'arrayContainsAll', ['tags', ['a', 'c']]],
  ...[[], ['1', 2.5], [false], ['zz']].map((vs, i) => [
    `arrayContainsAny-items-${i}`,
    'items',
    'arrayContainsAny',
    ['items', vs],
  ]),
  ['arrayContainsAny-tags', 'tags', 'arrayContainsAny', ['tags', ['c', 'é']]],
  ...ARRAY_REDUCERS.flatMap((r) => [
    [`arrayAggregate-nums-${r}`, 'tags', 'arrayAggregate', ['nums', r]],
    [`arrayAggregate-items-${r}`, 'items', 'arrayAggregate', ['items', r]],
  ]),
  [
    'arrayAggregate-nums-first-number',
    'tags',
    'arrayAggregate',
    ['nums', 'first', { kind: 'number' }],
  ],
  [
    'arrayAggregate-nums-last-as',
    'tags',
    'arrayAggregate',
    ['nums', 'last', { as: 'lastNum', kind: 'number' }],
  ],
  ['arrayAggregate-tags-first', 'tags', 'arrayAggregate', ['tags', 'first']],
  // keep: every element `===` the first (`0` and `-0` are equal)
  [
    'arrayAggregate-nums-keep',
    'tags',
    'arrayAggregate',
    ['nums', 'keep', { kind: 'number' }],
  ],
  ['arrayAggregate-tags-keep', 'tags', 'arrayAggregate', ['tags', 'keep']],
  // keep on whole array cells, one cell per bucket or window: each keeps its
  // own cell (`[-0]` is not an earlier row's `[0]`)
  [
    'aggregate-items-1s-keep',
    'items',
    'aggregate',
    [every('1s'), { items: 'keep' }],
  ],
  ['rolling-items-1s-keep', 'items', 'rolling', ['1s', { items: 'keep' }]],
  [
    'aggregate-tags-1s-keep',
    'tags',
    'aggregate',
    [every('1s'), { tags: 'keep', nums: 'keep' }],
  ],
  ['rolling-tags-1s-keep', 'tags', 'rolling', ['1s', { nums: 'keep' }]],
  [
    'arrayAggregate-tags-last-as',
    'tags',
    'arrayAggregate',
    ['tags', 'last', { as: 'lastTag' }],
  ],
  [
    'arrayAggregate-tags-count-as-self',
    'tags',
    'arrayAggregate',
    ['tags', 'count', { as: 'tags' }],
  ],
  [
    'arrayAggregate-nums-max-as',
    'tags',
    'arrayAggregate',
    ['nums', 'max', { as: 'top' }],
  ],
  // Errors in both: mixed kinds, a taken name, a kind numbers can't fill.
  ['arrayAggregate-items-first', 'items', 'arrayAggregate', ['items', 'first']],
  ['arrayAggregate-items-last', 'items', 'arrayAggregate', ['items', 'last']],
  [
    'arrayAggregate-as-taken',
    'tags',
    'arrayAggregate',
    ['nums', 'sum', { as: 'v' }],
  ],
  [
    'arrayAggregate-count-as-string',
    'tags',
    'arrayAggregate',
    ['nums', 'count', { kind: 'string' }],
  ],
  ['arrayAggregate-bogus', 'tags', 'arrayAggregate', ['nums', 'bogus']],
  // Known difference: pond-ts writes 'string' here and throws on numbers.
  ['arrayAggregate-nums-first', 'tags', 'arrayAggregate', ['nums', 'first']],
  ['arrayExplode-tags', 'tags', 'arrayExplode', ['tags']],
  ['arrayExplode-tags-as', 'tags', 'arrayExplode', ['tags', { as: 'tag' }]],
  [
    'arrayExplode-nums-number',
    'tags',
    'arrayExplode',
    ['nums', { kind: 'number' }],
  ],
  ['arrayExplode-items', 'items', 'arrayExplode', ['items']],
  [
    'arrayExplode-items-number',
    'items',
    'arrayExplode',
    ['items', { kind: 'number' }],
  ],
  ['arrayExplode-as-taken', 'tags', 'arrayExplode', ['tags', { as: 'v' }]],
  ['arrayExplode-empty', 'emptyTags', 'arrayExplode', ['tags']],
  // Known difference: pond-ts explodes as 'string' and throws on numbers.
  ['arrayExplode-nums', 'tags', 'arrayExplode', ['nums']],
  // Array columns through the other operators.
  ['array-select', 'tags', 'select', ['tags', 'v']],
  ['array-rename', 'tags', 'rename', [{ tags: 'labels' }]],
  ['array-filter', 'tags', 'filter', [{ fn: { column: 'v', gt: 2 } }]],
  ['array-slice', 'tags', 'slice', [1, 5]],
  ['array-fill-hold', 'tags', 'fill', ['hold']],
  ['array-fill-bfill', 'tags', 'fill', [{ tags: 'bfill', nums: 'hold' }]],
  ['array-fill-linear', 'tags', 'fill', ['linear']],
  ['array-fill-zero', 'tags', 'fill', ['zero']],
  ['array-fill-literal', 'tags', 'fill', [{ tags: ['x', 1, false] }]],
  ['array-fill-empty', 'tags', 'fill', [{ nums: [] }]],
  ['array-fill-limit', 'tags', 'fill', ['hold', { limit: 1, maxGap: '1s' }]],
  ['array-align-hold', 'tags', 'align', [every('2s')]],
  ['array-align-linear', 'tags', 'align', [every('2s'), { method: 'linear' }]],
  ['array-materialize', 'tags', 'materialize', [every('2s')]],
  ['array-dedupe-first', 'tags', 'dedupe', [{ keep: 'first' }]],
  ['array-dedupe-last', 'tags', 'dedupe', []],
  [
    'array-aggregate',
    'tags',
    'aggregate',
    [
      every('4s'),
      {
        n: { from: 'tags', using: 'count' },
        first: { from: 'tags', using: 'first' },
        last: { from: 'nums', using: 'last' },
        v: 'sum',
      },
    ],
  ],
  [
    'array-rolling',
    'tags',
    'rolling',
    [
      '3s',
      {
        n: { from: 'nums', using: 'count' },
        first: { from: 'tags', using: 'first' },
        last: { from: 'tags', using: 'last' },
      },
    ],
  ],
  [
    'array-reduce',
    'tags',
    'reduce',
    [
      {
        n: { from: 'tags', using: 'count' },
        first: { from: 'tags', using: 'first' },
        last: { from: 'nums', using: 'last' },
      },
    ],
  ],
  ['array-join', 'tags', 'join', [{ series: 'items' }]],
  ['array-asTimeRange', 'tags', 'asTimeRange', []],
  ['array-tail', 'tags', 'tail', ['4s']],
  [
    'array-partition-fill',
    'tags',
    'partitionBy',
    ['host', [['fill', 'hold']], 'collect'],
  ],
  [
    'array-partition-aggregate',
    'tags',
    'partitionBy',
    [
      'host',
      [['aggregate', every('4s'), { tags: 'last', nums: 'count' }]],
      'toMap',
    ],
  ],
];

// Rolling options (pond-rs R1b step 8g): leading and centred windows, a
// minimum row count, windows counted in rows, and windows placed on a
// sequence's grid. Every reducer, on columns with gaps, repeated times,
// signed zeros and a long silence.
const ROLL_NOISY = {
  x_sum: { from: 'x', using: 'sum' },
  x_avg: { from: 'x', using: 'avg' },
  x_min: { from: 'x', using: 'min' },
  x_max: { from: 'x', using: 'max' },
  x_med: { from: 'x', using: 'median' },
  x_p10: { from: 'x', using: 'p10' },
  x_sd: { from: 'x', using: 'stdev' },
  x_keep: { from: 'x', using: 'keep' },
  x_diff: { from: 'x', using: 'difference' },
  y_n: { from: 'y', using: 'count' },
  y_first: { from: 'y', using: 'first' },
  y_last: { from: 'y', using: 'last' },
  y_sd: { from: 'y', using: 'stdev' },
};
const ROLL_RUNS = {
  v_keep: { from: 'v', using: 'keep' },
  v_diff: { from: 'v', using: 'difference' },
  v_sum: { from: 'v', using: 'sum' },
  v_u: { from: 'v', using: 'unique' },
  v_t: { from: 'v', using: 'top2' },
  v_s: { from: 'v', using: 'samples' },
  s_keep: { from: 's', using: 'keep' },
  s_u: { from: 's', using: 'unique' },
  s_first: { from: 's', using: 'first' },
  b_t: { from: 'b', using: 'top2' },
  b_n: { from: 'b', using: 'count' },
};
const ROLL_TAGS = {
  tags_u: { from: 'tags', using: 'unique' },
  tags_keep: { from: 'tags', using: 'keep' },
  nums_t: { from: 'nums', using: 'top2' },
  nums_s: { from: 'nums', using: 'samples' },
  v_avg: { from: 'v', using: 'avg' },
  host_last: { from: 'host', using: 'last' },
};
const ALIGNMENTS = ['trailing', 'leading', 'centered'];
const ROLLING_OPTION_CASES = [
  // time windows, each alignment
  ...ALIGNMENTS.flatMap((alignment) => [
    [
      `rolling-noisy-20s-${alignment}`,
      'noisy',
      'rolling',
      ['20s', ROLL_NOISY, { alignment }],
    ],
    [
      `rolling-runs-3s-${alignment}`,
      'runs',
      'rolling',
      ['3s', ROLL_RUNS, { alignment }],
    ],
    [
      `rolling-tags-2s-${alignment}`,
      'tags',
      'rolling',
      ['2s', ROLL_TAGS, { alignment }],
    ],
    [
      `rolling-gappy-3s-${alignment}-min2`,
      'gappy',
      'rolling',
      ['3s', { a: 'avg', b: 'count' }, { alignment, minSamples: 2 }],
    ],
    [
      `rolling-buckets-6s-${alignment}`,
      'buckets',
      'rolling',
      ['6s', { a: 'sum', b: 'last' }, { alignment }],
    ],
  ]),
  // centred windows an odd number of ms long have half-ms edges
  [
    'rolling-gappy-1001ms-centered',
    'gappy',
    'rolling',
    ['1001ms', { a: 'count', b: 'sum' }, { alignment: 'centered' }],
  ],
  [
    'rolling-noisy-1401ms-centered',
    'noisy',
    'rolling',
    ['1401ms', ROLL_NOISY, { alignment: 'centered' }],
  ],
  // a 999 ms centred window ends half a ms past a row 500 ms away
  [
    'rolling-gappy-999ms-centered',
    'gappy',
    'rolling',
    ['999ms', { a: 'count', b: 'sum' }, { alignment: 'centered' }],
  ],
  [
    'rolling-grid-gappy-1s-999ms-centered',
    'gappy',
    'rolling',
    [every('1s'), '999ms', { a: 'count', b: 'sum' }, { alignment: 'centered' }],
  ],
  // a minimum no window reaches: every row is a gap
  [
    'rolling-gappy-1s-min99',
    'gappy',
    'rolling',
    ['1s', { a: 'count', b: 'sum' }, { minSamples: 99 }],
  ],
  // windows counted in rows; an even count leans to the leading side
  ...ALIGNMENTS.flatMap((alignment) =>
    [1, 3, 4, 500].flatMap((count) => [
      [
        `rolling-noisy-count${count}-${alignment}`,
        'noisy',
        'rolling',
        [{ count }, ROLL_NOISY, { alignment }],
      ],
      [
        `rolling-runs-count${count}-${alignment}-min${count}`,
        'runs',
        'rolling',
        [{ count }, ROLL_RUNS, { alignment, minSamples: count }],
      ],
    ]),
  ),
  ...ALIGNMENTS.map((alignment) => [
    `rolling-tags-count2-${alignment}`,
    'tags',
    'rolling',
    [{ count: 2 }, ROLL_TAGS, { alignment }],
  ]),
  [
    'rolling-zeros-count3',
    'zeros',
    'rolling',
    [{ count: 3 }, { v: 'difference' }],
  ],
  [
    'rolling-count-shorthand',
    'gappy',
    'rolling',
    [{ count: 2 }, { b: 'sum', a: 'avg' }],
  ],
  ['rolling-error-count0', 'gappy', 'rolling', [{ count: 0 }, { a: 'avg' }]],
  [
    'rolling-empty-count2',
    'emptyHosts',
    'rolling',
    [{ count: 2 }, { cpu: 'avg' }],
  ],
  // windows on a sequence's grid
  ...ALIGNMENTS.flatMap((alignment) => [
    [
      `rolling-grid-noisy-5s-20s-${alignment}`,
      'noisy',
      'rolling',
      [every('5s'), '20s', ROLL_NOISY, { alignment }],
    ],
    [
      `rolling-grid-runs-2s-3s-${alignment}`,
      'runs',
      'rolling',
      [every('2s'), '3s', ROLL_RUNS, { alignment }],
    ],
    [
      `rolling-grid-tags-1s-2s-${alignment}`,
      'tags',
      'rolling',
      [every('1s'), '2s', ROLL_TAGS, { alignment }],
    ],
    [
      `rolling-grid-buckets-4s-6s-${alignment}`,
      'buckets',
      'rolling',
      [every('4s'), '6s', { a: 'sum', b: 'count' }, { alignment }],
    ],
  ]),
  ...['begin', 'center', 'end'].flatMap((sample) => [
    [
      `rolling-grid-gappy-3s-sample-${sample}`,
      'gappy',
      'rolling',
      [every('3s'), '4s', { a: 'avg', b: 'sum' }, { sample }],
    ],
    [
      `rolling-grid-gappy-333ms-centered-${sample}`,
      'gappy',
      'rolling',
      [
        every('333ms'),
        '1001ms',
        { a: 'count', b: 'last' },
        { sample, alignment: 'centered' },
      ],
    ],
  ]),
  [
    'rolling-grid-gappy-min2',
    'gappy',
    'rolling',
    [every('1s'), '3s', { a: 'avg', b: 'count' }, { minSamples: 2 }],
  ],
  [
    'rolling-grid-gappy-range',
    'gappy',
    'rolling',
    [every('2s'), '5s', { a: 'sum' }, { range: { start: -3000, end: 30000 } }],
  ],
  [
    'rolling-grid-shorthand',
    'gappy',
    'rolling',
    [every('2s'), '3s', { b: 'sum', a: 'avg' }],
  ],
  [
    'rolling-grid-empty',
    'emptyHosts',
    'rolling',
    [every('1s'), '2s', { cpu: 'avg', host: 'unique' }],
  ],
  [
    'rolling-grid-empty-range',
    'emptyHosts',
    'rolling',
    [
      every('1s'),
      '2s',
      { cpu: 'avg', host: 'unique' },
      { range: { start: 0, end: 3000 } },
    ],
  ],
  [
    'rolling-grid-calendar',
    'dst',
    'rolling',
    [
      { sequence: { calendar: 'day', timeZone: 'Europe/London' } },
      '1d',
      { v: 'sum' },
    ],
  ],
  [
    'rolling-grid-error-interval',
    'gappy',
    'rolling',
    [every('1s'), '2s', { interval: { from: 'a', using: 'avg' } }],
  ],
  // per partition
  [
    'rolling-partition-count2-min2',
    'hosts',
    'partitionBy',
    [
      'host',
      [['rolling', { count: 2 }, { cpu: 'avg' }, { minSamples: 2 }]],
      'collect',
    ],
  ],
  [
    'rolling-partition-leading',
    'hosts',
    'partitionBy',
    [
      'host',
      [['rolling', '2s', { cpu: 'sum' }, { alignment: 'leading' }]],
      'toMap',
    ],
  ],
  [
    'rolling-partition-grid',
    'hosts',
    'partitionBy',
    [
      'host',
      [['rolling', every('1s'), '2s', { cpu: 'avg', up: 'keep' }]],
      'toMap',
    ],
  ],
];

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
  // keep and difference: one column each way, beside a sum (with #796
  // pond-ts gives each column the answer it gets alone)
  ...['2s', '3s', '5s'].flatMap((every_) => [
    [
      `aggregate-runs-${every_}-keep-difference`,
      'runs',
      'aggregate',
      [
        every(every_),
        {
          v_keep: { from: 'v', using: 'keep' },
          v_diff: { from: 'v', using: 'difference' },
          s_keep: { from: 's', using: 'keep' },
          b_keep: { from: 'b', using: 'keep' },
          v_sum: { from: 'v', using: 'sum' },
        },
      ],
    ],
    [
      `rolling-runs-${every_}-keep-difference`,
      'runs',
      'rolling',
      [
        every_,
        {
          v_keep: { from: 'v', using: 'keep' },
          v_diff: { from: 'v', using: 'difference' },
          s_keep: { from: 's', using: 'keep' },
          b_keep: { from: 'b', using: 'keep' },
        },
      ],
    ],
  ]),
  [
    'reduce-runs-keep-difference',
    'runs',
    'reduce',
    [
      {
        v_keep: { from: 'v', using: 'keep' },
        v_diff: { from: 'v', using: 'difference' },
        s_keep: { from: 's', using: 'keep' },
        b_keep: { from: 'b', using: 'keep' },
      },
    ],
  ],
  [
    'reduce-zeros-keep-difference',
    'zeros',
    'reduce',
    [
      {
        keep: { from: 'v', using: 'keep' },
        diff: { from: 'v', using: 'difference' },
      },
    ],
  ],
  [
    'rolling-zeros-3s-difference',
    'zeros',
    'rolling',
    ['3s', { v: 'difference' }],
  ],
  ['rolling-zeros-3s-keep', 'zeros', 'rolling', ['3s', { v: 'keep' }]],
  [
    'aggregate-noisy-30s-keep-difference',
    'noisy',
    'aggregate',
    [
      every('30s'),
      {
        x: 'sum',
        x_diff: { from: 'x', using: 'difference' },
        y_keep: { from: 'y', using: 'keep' },
        y_avg: { from: 'y', using: 'avg' },
      },
    ],
  ],
  [
    'rolling-noisy-20s-difference',
    'noisy',
    'rolling',
    ['20s', { x: 'difference', y: 'keep' }],
  ],
  // unique / top / samples: lists, flattened one level from array columns,
  // zeros merged by unique / top and kept by samples, empty buckets []
  ...['2s', '5s'].flatMap((every_) => [
    [
      `aggregate-runs-${every_}-lists`,
      'runs',
      'aggregate',
      [
        every(every_),
        {
          v_u: { from: 'v', using: 'unique' },
          v_t: { from: 'v', using: 'top2' },
          v_s: { from: 'v', using: 'samples' },
          s_u: { from: 's', using: 'unique' },
          s_t: { from: 's', using: 'top1' },
          b_u: { from: 'b', using: 'unique' },
          b_t: { from: 'b', using: 'top3' },
          v: { from: 'v', using: 'sum' },
        },
      ],
    ],
    [
      `rolling-runs-${every_}-lists`,
      'runs',
      'rolling',
      [
        every_,
        {
          v_u: { from: 'v', using: 'unique' },
          v_t: { from: 'v', using: 'top2' },
          v_s: { from: 'v', using: 'samples' },
          s_u: { from: 's', using: 'unique' },
          s_t: { from: 's', using: 'top2' },
          b_s: { from: 'b', using: 'samples' },
        },
      ],
    ],
  ]),
  [
    'reduce-runs-lists',
    'runs',
    'reduce',
    [
      {
        v_u: { from: 'v', using: 'unique' },
        v_t: { from: 'v', using: 'top3' },
        v_s: { from: 'v', using: 'samples' },
        s_u: { from: 's', using: 'unique' },
        s_t: { from: 's', using: 'top007' },
        b_t: { from: 'b', using: 'top1' },
      },
    ],
  ],
  [
    'aggregate-tags-lists',
    'tags',
    'aggregate',
    [
      every('3s'),
      {
        tags_u: { from: 'tags', using: 'unique' },
        tags_t: { from: 'tags', using: 'top2' },
        nums_s: { from: 'nums', using: 'samples' },
        nums_u: { from: 'nums', using: 'unique' },
      },
    ],
  ],
  [
    'rolling-tags-lists',
    'tags',
    'rolling',
    [
      '3s',
      {
        tags_u: { from: 'tags', using: 'unique' },
        nums_t: { from: 'nums', using: 'top2' },
        nums_s: { from: 'nums', using: 'samples' },
      },
    ],
  ],
  [
    'reduce-items-lists',
    'items',
    'reduce',
    [
      {
        u: { from: 'items', using: 'unique' },
        t: { from: 'items', using: 'top3' },
        s: { from: 'items', using: 'samples' },
      },
    ],
  ],
  [
    'aggregate-noisy-30s-lists',
    'noisy',
    'aggregate',
    [every('30s'), { x: 'sum', x_t: { from: 'x', using: 'top3' }, y: 'avg' }],
  ],
  [
    'rolling-noisy-10s-lists',
    'noisy',
    'rolling',
    ['10s', { x_u: { from: 'x', using: 'unique' }, y: 'samples' }],
  ],
  [
    'reduce-emptyHosts-lists',
    'emptyHosts',
    'reduce',
    [{ host: 'unique', cpu: 'samples' }],
  ],
  [
    'partition-aggregate-lists',
    'hosts',
    'partitionBy',
    [
      'host',
      [
        [
          'aggregate',
          every('2s'),
          { region: 'unique', cpu: 'samples', up: 'top1' },
        ],
      ],
      'collect',
    ],
  ],
  [
    'partition-aggregate-keep-difference',
    'hosts',
    'partitionBy',
    [
      'host',
      [
        [
          'aggregate',
          every('2s'),
          {
            region: 'keep',
            up: 'keep',
            cpu: 'difference',
          },
        ],
      ],
      'collect',
    ],
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
  // tail: rows starting strictly after (last start - duration); repeated
  // times at the cut, time ranges, an empty series, a zero and a bad duration
  ['tail-gappy-5s', 'gappy', 'tail', ['5s']],
  ['tail-gappy-8500ms', 'gappy', 'tail', ['8500ms']],
  ['tail-gappy-1h', 'gappy', 'tail', ['1h']],
  ['tail-gappy-0s', 'gappy', 'tail', ['0s']],
  ['tail-noisy-20s', 'noisy', 'tail', ['20s']],
  ['tail-ranges-10s', 'ranges', 'tail', ['10s']],
  ['tail-empty', 'emptyHosts', 'tail', ['1m']],
  ['tail-bad-duration', 'gappy', 'tail', ['5 parsecs']],
  // reduce: the whole series as one bucket, as a record
  ['reduce-gappy-shorthand', 'gappy', 'reduce', [{ b: 'count', a: 'sum' }]],
  [
    'reduce-noisy-spread',
    'noisy',
    'reduce',
    [
      {
        x_sum: { from: 'x', using: 'sum' },
        x_avg: { from: 'x', using: 'avg' },
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
    'reduce-mixed-kinds',
    'mixed',
    'reduce',
    [
      {
        host_first: { from: 'host', using: 'first' },
        host_last: { from: 'host', using: 'last' },
        host_n: { from: 'host', using: 'count' },
        up_first: { from: 'up', using: 'first' },
        up_last: { from: 'up', using: 'last' },
        v_avg: { from: 'v', using: 'avg' },
      },
    ],
  ],
  ['reduce-signed', 'signed', 'reduce', [{ v: 'sum' }]],
  [
    'reduce-signed-spread',
    'signed',
    'reduce',
    [
      {
        avg: { from: 'v', using: 'avg' },
        min: { from: 'v', using: 'min' },
        max: { from: 'v', using: 'max' },
        med: { from: 'v', using: 'median' },
      },
    ],
  ],
  [
    'reduce-empty',
    'emptyHosts',
    'reduce',
    [
      {
        n: { from: 'cpu', using: 'count' },
        total: { from: 'cpu', using: 'sum' },
        mean: { from: 'cpu', using: 'avg' },
        sd: { from: 'cpu', using: 'stdev' },
        host: { from: 'host', using: 'first' },
      },
    ],
  ],
  // Signed zeros: the first value and the minimum are -0, and the sum
  // starts from +0.
  [
    'reduce-zeros',
    'zeros',
    'reduce',
    [
      {
        first: { from: 'v', using: 'first' },
        min: { from: 'v', using: 'min' },
        total: { from: 'v', using: 'sum' },
        med: { from: 'v', using: 'median' },
      },
    ],
  ],
  ['reduce-unknown-column', 'gappy', 'reduce', [{ nope: 'sum' }]],
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
  ...SPAN_CASES,
  ...KEY_CASES,
  ...ARRAY_CASES,
  ...ROLLING_OPTION_CASES,
];

/**
 * The closures a case can name, as `{ fn: spec }`. pond-rs's harness builds
 * the same closure from the same spec.
 */
function closure(spec) {
  if (spec === 'rangeBegin') return (r) => r.begin();
  if (spec === 'rangeEnd') return (r) => r.end();
  if (spec === 'rowLabel') return (_r, i) => `row${i}`;
  if (spec === 'mixedLabel') return (_r, i) => (i === 0 ? 1 : 'b');
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

/** As sent over the wire: `JSON.stringify` drops `undefined` and -0's sign. */
function wire(value) {
  return JSON.parse(JSON.stringify(value));
}

/** `{ ...head, expected: run() }`, or `{ ...head, error }` if it throws. */
function attempt(head, run) {
  try {
    return { ...head, expected: run() };
  } catch (e) {
    return { ...head, error: { name: e.name, message: e.message } };
  }
}

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
    runs: TimeSeries.fromJSON({
      name: 'runs',
      schema: RUNS_SCHEMA,
      rows: RUNS_ROWS,
    }),
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
    tags: TimeSeries.fromJSON({
      name: 'tags',
      schema: TAGS_SCHEMA,
      rows: TAGS_ROWS,
    }),
    emptyTags: TimeSeries.fromJSON({
      name: 'emptyTags',
      schema: TAGS_SCHEMA,
      rows: [],
    }),
    items: TimeSeries.fromJSON({
      name: 'items',
      schema: ITEMS_SCHEMA,
      rows: ITEMS_ROWS,
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
    if (arg && typeof arg === 'object' && arg.f64 === '-0') return -0;
    // pond-ts key objects (span ops).
    if (arg && typeof arg === 'object' && 'time' in arg) {
      return new pond.Time(arg.time);
    }
    if (arg && typeof arg === 'object' && 'timeRange' in arg) {
      return new pond.TimeRange(arg.timeRange);
    }
    if (arg && typeof arg === 'object' && 'interval' in arg) {
      return new pond.Interval(arg.interval);
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
        'series are TimeSeries.toJSON(); null = missing; -0/NaN/±Infinity tagged as {"f64":"-0"|"NaN"|"inf"|"-inf"}; args encode Time / TimeRange / Interval keys as {"time":t} / {"timeRange":[s,e]} / {"interval":[v,s,e]}, Sequence.every(d) as {"sequence":{"every":d}} and Sequence.calendar(u, {timeZone, weekStartsOn}) as {"sequence":{"calendar":u,"timeZone":z,"weekStartsOn"?:w}}; a case has expected (series), groups ([key, series] pairs, from toMap / groupBy), reduced ({output: cell}, from reduce) or error ({name,message}); partitionBy args are [by, steps, end] with steps [[method, ...args]] run on the partitioned view and end "collect" or "toMap"; {"series":name} is another input series; joinMany args are [[others...], options?] and call TimeSeries.joinMany([input, ...others], options); exact unless tolerance is set; timeParse holds Time.parse(input, {timeZone}) as expected (ms) or error (its name); queries hold inputs[input][op](arg) as expected (a row position, null for none, a bool, the bisect index, or [begin, end] for timeRange / intersection) or error (its name), with KeyLike args for key lookups and filter test specs for find / some / every',
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
      if (op === 'reduce') {
        return {
          ...head,
          reduced: Object.fromEntries(
            Object.entries(result).map(([k, v]) => [k, encodeCell(v ?? null)]),
          ),
        };
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
    queries: QUERY_INPUTS.flatMap((input) => {
      const series = inputs[input];
      const span = (r) =>
        r === undefined
          ? null
          : typeof r === 'boolean'
            ? r
            : [r.begin(), r.end()];
      const decodeSpan = (k) =>
        typeof k === 'object' && !Array.isArray(k) ? new pond.Time(k.time) : k;
      const row = (event) =>
        event === undefined ? null : series.events.indexOf(event);
      const run = (op, arg, call) => {
        try {
          return { input, op, arg, expected: call() };
        } catch (e) {
          return { input, op, arg, error: e.name };
        }
      };
      return [
        ...QUERY_KEYS.flatMap((key) =>
          QUERY_KEY_OPS.map((op) =>
            run(op, encodeCell(key), () => {
              const result = series[op](key);
              return typeof result === 'object' || result === undefined
                ? row(result)
                : result;
            }),
          ),
        ),
        ...QUERY_SPAN_KEYS.flatMap((key) =>
          ['overlaps', 'contains', 'intersection'].map((op) =>
            run(op, key, () => span(series[op](decodeSpan(key)))),
          ),
        ),
        run('timeRange', null, () => span(series.timeRange())),
        ...QUERY_POSITIONS.map((i) => run('at', i, () => row(series.at(i)))),
        ...QUERY_TESTS.flatMap((spec) => [
          run('find', spec, () => row(series.find(closure(spec)))),
          run('some', spec, () => series.some(closure(spec))),
          run('every', spec, () => series.every(closure(spec))),
        ]),
      ];
    }),
    // toJSON of every input in both row formats, as written on the wire
    // (JSON.stringify drops -0's sign), and fromJSON of each of those back,
    // plus JSON_PAYLOADS. A fromJSON case has expected (series, encoded as in
    // `cases`) or error ({name, message}).
    json: {
      toJSON: Object.entries(inputs).flatMap(([input, series]) =>
        ['array', 'object'].map((rowFormat) => ({
          input,
          rowFormat,
          expected: JSON.parse(JSON.stringify(series.toJSON({ rowFormat }))),
        })),
      ),
      fromJSON: [
        ...Object.entries(inputs).flatMap(([input, series]) =>
          ['array', 'object'].map((rowFormat) => [
            `roundTrip-${input}-${rowFormat}`,
            JSON.parse(JSON.stringify(series.toJSON({ rowFormat }))),
          ]),
        ),
        ...JSON_PAYLOADS.map(([id, payload, options]) => [
          id,
          { name: 'j', ...payload },
          options,
        ]),
      ].map(([id, payload, options]) => {
        const head =
          options === undefined ? { id, payload } : { id, payload, options };
        try {
          const { timeZone, ordering } = options ?? {};
          const series = TimeSeries.fromJSON({
            ...payload,
            ...(timeZone === undefined ? {} : { parse: { timeZone } }),
            ...(ordering === undefined ? {} : { ordering }),
          });
          return { ...head, expected: encodeSeries(series) };
        } catch (e) {
          return { ...head, error: { name: e.name, message: e.message } };
        }
      }),
    },
    // Columnar and point JSON (pond-ts toColumns / fromColumns / toPoints /
    // fromPoints), as written on the wire: every input out, each one back,
    // plus COLUMN_PAYLOADS and POINT_PAYLOADS. A case has expected or error.
    columnsJson: {
      toColumns: Object.entries(inputs).map(([input, series]) =>
        attempt({ input }, () => wire(series.toColumns())),
      ),
      fromColumns: [
        ...Object.entries(inputs).flatMap(([input, series]) => {
          try {
            return [[`roundTrip-${input}`, wire(series.toColumns())]];
          } catch {
            return [];
          }
        }),
        ...COLUMN_PAYLOADS.map(([id, payload, options]) => [
          id,
          wire({ name: 'c', ...payload }),
          options,
        ]),
      ].map(([id, payload, options]) =>
        attempt(
          options === undefined ? { id, payload } : { id, payload, options },
          () =>
            encodeSeries(
              TimeSeries.fromColumns({
                ...payload,
                ...(options?.ordering === undefined
                  ? {}
                  : { ordering: options.ordering }),
              }),
            ),
        ),
      ),
      toPoints: Object.entries(inputs).map(([input, series]) =>
        attempt({ input }, () => wire(series.toPoints())),
      ),
      fromPoints: [
        ...Object.entries(inputs)
          .filter(
            ([, series]) =>
              series.schema[0].kind === 'time' && series.schema.length > 1,
          )
          .map(([input, series]) => [
            `roundTrip-${input}`,
            wire(series.toPoints()),
            series.schema,
          ]),
        ...POINT_PAYLOADS.map(([id, points, schema]) => [
          id,
          wire(points),
          schema,
        ]),
      ].map(([id, points, schema]) =>
        attempt({ id, points, schema }, () =>
          encodeSeries(TimeSeries.fromPoints(points, { schema, name: 'p' })),
        ),
      ),
    },
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
