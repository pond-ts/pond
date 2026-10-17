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
 * `{ "sequence": { "every": "5s" } }` means `Sequence.every('5s')`), and then
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

const every = (duration) => ({ sequence: { every: duration } });

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
  [
    'rolling-dense-10s-stdev',
    'dense',
    'rolling',
    ['10s', { value: 'stdev' }],
    1e-12,
  ],
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

export function buildFixture(pond) {
  const { TimeSeries, Sequence } = pond;
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
    signed: TimeSeries.fromJSON({
      name: 'signed',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number', required: false },
      ],
      rows: SIGNED_ROWS,
    }),
  };
  const decode = (arg) =>
    arg && typeof arg === 'object' && 'sequence' in arg
      ? Sequence.every(arg.sequence.every)
      : arg;

  return {
    meta: {
      generator: 'packages/core/scripts/parity/generate.mjs',
      reference: 'pond-ts',
      encoding:
        'series are TimeSeries.toJSON(); null = missing; -0/NaN/±Infinity tagged as {"f64":"-0"|"NaN"|"inf"|"-inf"}; args encode Sequence.every(d) as {"sequence":{"every":d}}; a case has expected (series) or error ({name,message}); exact unless tolerance is set',
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
