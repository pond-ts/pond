// Inputs the parity fixture does not cover, each checked against what
// pond-ts does with them (pond-ts 0.75.0, by hand): cell checks in the
// constructor, -0 as a whole number, empty lists.
//
//   node test/inputs.mjs           (after ./build.sh)
//
// Pointed at pond-ts instead (with a no-op `free` and `alive`), every line
// passes but the `joinMany([])` one.
import assert from 'node:assert/strict';
import { Sequence, Time, TimeRange, TimeSeries, alive } from '../index.js';

const series = () =>
  new TimeSeries({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ],
    rows: [
      [0, 1],
      [1000, 2],
      [2000, 3],
    ],
  });
const oneCell = (kind, cell) =>
  new TimeSeries({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind, required: false },
    ],
    rows: [[0, cell]],
  });

// The constructor refuses a cell of the wrong kind with pond-ts's message.
const refused = [
  ['number', '5', 'expected finite number'],
  ['number', NaN, 'expected finite number'],
  ['number', Infinity, 'expected finite number'],
  ['number', true, 'expected finite number'],
  ['string', 5, 'expected string'],
  ['boolean', 1, 'expected boolean'],
  ['array', 5, 'expected array of scalars'],
  [
    'array',
    [{}],
    'array element 0 must be a finite number, string, or boolean',
  ],
];
// pond-ts's constructor refuses null; its fromJSON reads it as a gap.
for (const kind of ['number', 'string', 'boolean', 'array'])
  refused.push([kind, null, refused.find((r) => r[0] === kind)[2]]);
for (const [kind, cell, message] of refused)
  assert.throws(() => oneCell(kind, cell), {
    message: `row 0 col 1: ${message}`,
  });
for (const [kind, cell] of [
  ['number', undefined],
  ['string', undefined],
  ['array', [1, 'a', true]],
]) {
  const s = oneCell(kind, cell);
  assert.equal(s.length, 1);
  s.free();
}
{
  const s = TimeSeries.fromJSON({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'string', required: false },
    ],
    rows: [[0, null]],
  });
  assert.equal(s.at(0).get('v'), undefined);
  s.free();
}

// -0 is a whole number, as in JavaScript.
const s = series();
for (const [name, run, rows] of [
  ['shift', (s) => s.shift('v', -0), 3],
  ['before', (s) => s.before(-0), 0],
  ['within', (s) => s.within(-0, 2000), 3],
]) {
  const out = run(s);
  assert.equal(out.length, rows, name);
  out.free();
}
s.free();

assert.throws(() => TimeSeries.concat([]), {
  message: 'TimeSeries.concat requires at least one input series.',
});
// pond-ts returns undefined here; the bridge refuses instead.
assert.throws(() => TimeSeries.joinMany([]), /at least one input series/);

// Functions. A gappy series: v = [1, -, 3], s = [a, b, -].
const gappy = () =>
  new TimeSeries({
    name: 'g',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
      { name: 's', kind: 'string', required: false },
      { name: 'b', kind: 'boolean', required: false },
    ],
    rows: [
      [0, 1, 'a', true],
      [1000, undefined, 'b', false],
      [2000, 3, undefined, undefined],
    ],
  });
const rows = (s) => {
  const r = s.toJSON().rows;
  s.free();
  return r;
};
const g = gappy();

// The first exception is rethrown as it was; the function is not called
// again.
class Boom extends Error {}
for (const run of [
  (f) => g.filter(f),
  (f) => g.find(f),
  (f) => g.some(f),
  (f) => g.every(f),
  (f) => g.mapColumns({ v: f }),
  (f) => g.scan('v', f, 0),
  (f) => g.collapse(['v'], 'o', f),
  (f) => g.asInterval(f),
  (f) => g.partitionBy('s').scan('v', f, 0).collect(),
]) {
  let calls = 0;
  const boom = new Boom('boom');
  assert.throws(
    () =>
      run(() => {
        calls++;
        throw boom;
      }),
    (e) => e === boom,
  );
  assert.equal(calls, 1);
}

// A function may use the bridge itself.
assert.deepEqual(
  rows(
    g.filter((e) => {
      const t = gappy();
      const keep = t.length === 3 && e.get('v') !== undefined;
      t.free();
      return keep;
    }),
  ),
  [
    [0, 1, 'a', true],
    [2000, 3, null, null],
  ],
);

// As pond-ts, a result of the wrong type is a gap.
assert.deepEqual(rows(g.mapColumns({ v: () => 'x' })), [
  [0, null, 'a', true],
  [1000, null, 'b', false],
  [2000, null, null, null],
]);
assert.deepEqual(rows(g.mapColumns({ s: () => 5, b: () => 'no' })), [
  [0, 1, null, null],
  [1000, null, null, null],
  [2000, 3, null, null],
]);
assert.deepEqual(
  rows(g.mapColumns({ v: () => NaN })).map((r) => r[1]),
  [null, null, null],
);
// scan reads result[0] and result[1] of whatever comes back.
assert.deepEqual(
  rows(g.scan('v', () => 5, 0)).map((r) => r[1]),
  [null, null, null],
);
assert.deepEqual(
  rows(g.scan('v', (a, v) => [a + v, String(a + v)], 0)).map((r) => r[1]),
  [null, null, null],
);
// pond-ts fails reading undefined[0]; the bridge names the problem.
assert.throws(
  () => g.scan('v', () => undefined, 0),
  /returned nothing|reading '0'/,
);
assert.deepEqual(
  rows(g.collapse(['v'], 'o', () => ({}))).map((r) => r.at(-1)),
  [null, null, null],
);
assert.throws(() => g.asInterval(() => true), /got boolean|no label/);

// What the functions are given.
const seen = [];
rows(
  g.filter((e, i) => {
    seen.push([i, e.begin(), e.key().type(), e.get('s'), e.data()]);
    return true;
  }),
);
assert.deepEqual(seen, [
  [0, 0, 'time', 'a', { v: 1, s: 'a', b: true }],
  [1, 1000, 'time', 'b', { v: undefined, s: 'b', b: false }],
  [2, 2000, 'time', undefined, { v: 3, s: undefined, b: undefined }],
]);
const spans = [];
rows(
  g.asInterval((range, i) => {
    assert.ok(range instanceof TimeRange);
    spans.push([range.begin(), range.end(), i]);
    return `r${i}`;
  }),
);
assert.deepEqual(spans, [
  [0, 0, 0],
  [1000, 1000, 1],
  [2000, 2000, 2],
]);
const scans = [];
const init = { total: 0 };
rows(
  g.scan(
    'v',
    (acc, v, i) => {
      scans.push([acc === init, v, i]);
      return [{ total: acc.total + v }, acc.total + v];
    },
    init,
  ),
);
assert.deepEqual(scans, [
  [true, 1, 0],
  [false, 3, 2],
]);
assert.deepEqual(
  rows(g.collapse(['v', 's'], 'o', (values) => JSON.stringify(values))).map(
    (r) => r.at(-1),
  ),
  ['{"v":1,"s":"a"}', '{"s":"b"}', '{"v":3}'],
);

// Row lookups take Time and TimeRange as well as ms.
assert.equal(g.bisect(new Time(1500)), 2);
const k = g.at(1).key();
assert.deepEqual(
  [+k, k.timestampMs(), k.toDate().getTime(), k.duration()],
  [1000, 1000, 1000, 0],
);
assert.ok(k.equals(new Time(1000)) && !k.equals(new Time(999)));
assert.equal(g.atOrBefore(new Time(1500)).begin(), 1000);
assert.equal(g.overlaps(new TimeRange([500, 1500])), true);
assert.deepEqual([g.timeRange().begin(), g.timeRange().end()], [0, 2000]);
assert.equal(
  Time.parse('2025-03-30T02:30', { timeZone: 'Europe/Madrid' }).timestamp,
  1743298200000,
);
g.free();

// A duration may be a number of ms, as pond-ts's `DurationInput`.
{
  const s = series();
  const same = (a, b) => {
    assert.deepEqual(a.toJSON().rows, b.toJSON().rows);
    a.free();
    b.free();
  };
  same(s.rolling(2000, { v: 'avg' }), s.rolling('2s', { v: 'avg' }));
  same(
    s.rolling(Sequence.every(1000), 2000, { v: 'sum' }),
    s.rolling(Sequence.every('1s'), '2s', { v: 'sum' }),
  );
  same(
    s.aggregate(Sequence.every(2000), { v: 'sum' }),
    s.aggregate(Sequence.every('2s'), { v: 'sum' }),
  );
  same(s.tail(1000), s.tail('1s'));
  for (const bad of [0, -1000, NaN])
    assert.throws(() => s.rolling(bad, { v: 'avg' }));
  s.free();
}

// A number maxGap is milliseconds, as pond-ts: rows are 1000 ms apart, so
// 500 fills nothing and 2000 fills the gap.
{
  const g = gappy();
  for (const [gap, filled] of [
    [500, undefined],
    ['500ms', undefined],
    [2000, 2],
    ['2s', 2],
  ]) {
    const f = g.fill({ v: 'linear' }, { maxGap: gap });
    assert.equal(f.at(1).get('v'), filled, `maxGap ${gap}`);
    f.free();
  }
  g.free();
}

assert.equal(alive(), 0, 'series left in memory');
console.log('inputs through @pond-ts/rs: all match pond-ts');
