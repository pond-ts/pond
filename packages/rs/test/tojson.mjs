// `toJSON()` through @pond-ts/rs against pond-ts's own, on random series:
// every key kind (interval labels as text and as numbers), number columns
// with gaps and -0, text with repeats, empty text and gaps, booleans, lists,
// both row formats. Equal means deepStrictEqual, which compares cells with
// Object.is (so -0 is not 0).
//
//   npm run build --workspace=pond-ts
//   packages/rs/build.sh
//   node packages/rs/test/tojson.mjs
import assert from 'node:assert/strict';
import * as rs from '../index.js';
import * as ts from '../../core/dist/index.js';

let seed = 20261031;
const rand = () => {
  seed ^= seed << 13;
  seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  seed >>>= 0;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const chance = (p) => rand() < p;

const TEXTS = [
  '',
  'a',
  'b',
  'host-1',
  'héllo',
  '"quoted"',
  'line\nbreak',
  '🦆',
];
const NUMBERS = [0, -0, 1, -1, 0.1, 1e-7, 1.5e21, 12345.678, -2.5];
const SCALARS = [0, -0, 3.5, 'x', '', true, false];

const KINDS = ['number', 'string', 'boolean', 'array'];
const cellOf = {
  number: () => (chance(0.5) ? pick(NUMBERS) : (rand() - 0.5) * 1e4),
  string: () => pick(TEXTS),
  boolean: () => chance(0.5),
  array: () =>
    Array.from({ length: Math.floor(rand() * 4) }, () => pick(SCALARS)),
};

function randomSpec(n) {
  const key = pick(['time', 'timeRange', 'interval']);
  const numberLabels = chance(0.5);
  // pond-ts's default key names: the bridge's constructor does not take
  // another one yet (pond-rs names the key by its kind).
  const schema = [{ name: key, kind: key }];
  const width = Math.floor(rand() * 5);
  for (let c = 0; c < width; c++) {
    const def = { name: `c${c}`, kind: pick(KINDS) };
    if (chance(0.6)) def.required = false;
    schema.push(def);
  }
  const rows = [];
  let t = Math.floor(rand() * 1e12);
  for (let i = 0; i < n; i++) {
    t += 1 + Math.floor(rand() * 60_000);
    const end = t + Math.floor(rand() * 5000);
    const k =
      key === 'time'
        ? t
        : key === 'timeRange'
          ? [t, end]
          : [numberLabels ? pick([-0, 0, i, i + 0.5]) : `bucket-${i}`, t, end];
    const row = [k];
    for (const def of schema.slice(1))
      row.push(
        def.required === false && chance(0.3) ? undefined : cellOf[def.kind](),
      );
    rows.push(row);
  }
  return { name: pick(['', 'x', 'cpu "load"']), schema, rows };
}

let cases = 0;
for (let k = 0; k < 300; k++) {
  const spec = randomSpec(pick([0, 1, 2, 5, 50, 300]));
  const a = new ts.TimeSeries(spec);
  const b = new rs.TimeSeries(spec);
  for (const options of [
    undefined,
    { rowFormat: 'array' },
    { rowFormat: 'object' },
  ]) {
    const want = a.toJSON(options);
    const got = b.toJSON(options);
    assert.deepStrictEqual(
      got,
      // pond-ts hands back its own (frozen) schema and rows; the tree is
      // what must match.
      { name: want.name, schema: want.schema, rows: want.rows },
      `case ${k} ${JSON.stringify(options)}: ${JSON.stringify(spec.schema)}`,
    );
    cases++;
  }
  assert.equal(JSON.stringify(b), JSON.stringify(a), `case ${k}: JSON text`);
  b.free();
}

assert.equal(rs.alive(), 0, 'series left in memory');
console.log(`toJSON through @pond-ts/rs matches pond-ts: ${cases} cases`);
