// Inputs the parity fixture does not cover, each checked against what
// pond-ts does with them (pond-ts 0.75.0, by hand): cell checks in the
// constructor, -0 as a whole number, empty lists.
//
//   node test/inputs.mjs           (after ./build.sh)
import assert from 'node:assert/strict';
import { TimeSeries, alive } from '../index.js';

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
for (const [kind, cell, message] of refused)
  assert.throws(() => oneCell(kind, cell), {
    message: `row 0 col 1: ${message}`,
  });
for (const [kind, cell] of [
  ['number', undefined],
  ['string', null],
  ['array', [1, 'a', true]],
]) {
  const s = oneCell(kind, cell);
  assert.equal(s.length, 1);
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

assert.equal(alive(), 0, 'series left in memory');
console.log('inputs through @pond-ts/rs: all match pond-ts');
