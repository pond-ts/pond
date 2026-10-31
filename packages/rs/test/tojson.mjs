// `toJSON()` through @pond-ts/rs against pond-ts's own, on random series:
// every key kind (interval labels as text and as numbers), number columns
// with gaps and -0, text with repeats, empty text and gaps, booleans, lists,
// both row formats, column names that need escaping. Equal means
// deepStrictEqual, which compares cells with Object.is (so -0 is not 0) and
// rows' prototypes. Then the names pond-ts refuses, a decimal column (the
// bridge reads one from Arrow; pond-ts has none), an unknown rowFormat, and
// the whole file again in a child process where code cannot be made from
// text, so the rows come from the plain loop.
//
//   npm run build --workspace=pond-ts   (and npm ci, for apache-arrow)
//   packages/rs/build.sh
//   node packages/rs/test/tojson.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as A from 'apache-arrow';
import * as rs from '../index.js';
import * as ts from '../../core/dist/index.js';

const CHILD = process.env.POND_RS_TOJSON_CHILD === '1';
if (CHILD)
  assert.throws(() => new Function(''), EvalError, 'code generation is on');

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
// Names the generated loop must write safely: quotes, a backslash, line
// breaks (U+2028 too), keywords, Object.prototype methods and its own
// variable names.
const NAMES = [
  'c0',
  'v',
  'q"uote',
  'back\\slash',
  'new\nline',
  'sep\u2028arator',
  ' x',
  'class',
  'return',
  'toString',
  'hasOwnProperty',
  'c1',
  'c4',
  'parts',
  'rows',
  'x',
  'i',
  'n',
  '0',
  '🦆',
];
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
  const names = [...NAMES].sort(() => rand() - 0.5);
  for (let c = 0; c < width; c++) {
    const def = { name: names[c], kind: pick(KINDS) };
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
          : [
              numberLabels
                ? pick([-0, 0, i, i + 0.5])
                : pick(['', 'a', 'a', `bucket-${i}`]),
              t,
              end,
            ];
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

// Names pond-ts refuses ("reserved"); the bridge takes them, and each must
// be an own field of an object row, prototype untouched.
for (const name of ['__proto__', 'constructor']) {
  const b = new rs.TimeSeries({
    name: 'r',
    schema: [
      { name: 'time', kind: 'time' },
      { name, kind: 'number', required: false },
      { name: 'w', kind: 'string' },
    ],
    rows: [
      [1, 5, 'a'],
      [2, undefined, 'b'],
    ],
  });
  const rows = b.toJSON({ rowFormat: 'object' }).rows;
  rows.forEach((r, i) => {
    assert.equal(Object.getPrototypeOf(r), Object.prototype, name);
    assert.deepEqual(Object.getOwnPropertyNames(r), ['time', name, 'w']);
    assert.equal(Object.getOwnPropertyDescriptor(r, name).value, [5, null][i]);
    assert.equal(r.w, ['a', 'b'][i]);
  });
  assert.deepStrictEqual(b.toJSON().rows, [
    [1, 5, 'a'],
    [2, null, 'b'],
  ]);
  b.free();
}

// A decimal column (from Arrow) as text, a gap as null, in both formats.
{
  const words = new Uint32Array(16);
  [150n, -5n, 0n, 123456789012n].forEach((v, i) => {
    let x = BigInt.asUintN(128, v);
    for (let w = 0; w < 4; w++, x >>= 32n)
      words[4 * i + w] = Number(x & 0xffffffffn);
  });
  const d = A.makeVector(
    A.makeData({
      type: new A.Decimal(2, 20, 128),
      length: 4,
      nullCount: 1,
      nullBitmap: new Uint8Array([0b1011]),
      data: words,
    }),
  );
  const time = A.makeVector(new Float64Array([0, 1000, 2000, 3000]));
  const b = rs.TimeSeries.fromArrow(
    A.tableToIPC(new A.Table({ time, d }), 'file'),
  );
  const cells = ['1.50', '-0.05', null, '1234567890.12'];
  assert.deepStrictEqual(
    b.toJSON().rows,
    cells.map((c, i) => [i * 1000, c]),
  );
  assert.deepStrictEqual(
    b.toJSON({ rowFormat: 'object' }).rows,
    cells.map((c, i) => ({ time: i * 1000, d: c })),
  );
  b.free();
}

// An unknown rowFormat gives array rows, as pond-ts.
{
  const spec = {
    name: 'u',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ],
    rows: [[1, 2]],
  };
  const b = new rs.TimeSeries(spec);
  for (const options of [{ rowFormat: 'bogus' }, {}, ''])
    assert.deepStrictEqual(
      b.toJSON(options).rows,
      new ts.TimeSeries(spec).toJSON(options).rows,
    );
  b.free();
}

assert.equal(rs.alive(), 0, 'series left in memory');
if (!CHILD) {
  const child = spawnSync(
    process.execPath,
    ['--disallow-code-generation-from-strings', fileURLToPath(import.meta.url)],
    {
      env: { ...process.env, POND_RS_TOJSON_CHILD: '1' },
      encoding: 'utf8',
    },
  );
  assert.equal(child.status, 0, `without code generation:\n${child.stderr}`);
  process.stdout.write(child.stdout);
}
console.log(
  `toJSON through @pond-ts/rs matches pond-ts: ${cases} cases${CHILD ? ' (plain loop, no code generation)' : ''}`,
);
