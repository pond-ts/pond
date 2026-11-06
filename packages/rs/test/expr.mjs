// Expression uses the parity fixture does not reach (it builds every
// literal with `lit` and never mixes functions with expressions): plain
// values as operands, `mapColumns` mixing both, and the same JSON tree as
// pond-ts's builder. Expected values are pond-ts 0.75.0's answers to the
// same calls (copied here so the test needs no pond-ts build).
//
//   node test/expr.mjs           (after ./build.sh)
import assert from 'node:assert/strict';
import * as rs from '../index.js';

const spec = {
  name: 'x',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number', required: false },
    { name: 'w', kind: 'number' },
    { name: 'host', kind: 'string' },
  ],
  rows: [
    [0, 1, 2, 'a'],
    [1000, undefined, 4, 'b'],
    [2000, 3, 0, 'a'],
    [3000, -6, 3, 'c'],
  ],
};
const b = new rs.TimeSeries(spec);
const rows = (s) => s.toJSON().rows;

// Each rule with plain values as operands, and pond-ts's tree and answers.
const rules = [
  (l) => l.col('v').gt(0),
  (l) => l.col('v').div(l.col('w')).ge(0.5).or(l.col('host').eq('c')),
  (l) => l.lit(10).sub(l.col('v')).lt(8),
  (l) => l.col('host').in(['a', 'c']).and(l.col('v').isMissing().not()),
  (l) => l.when(l.col('v').gt(2), true, false),
  (l) => l.col('v').abs().neg().add(5).mul(2).fill(0).ne(4),
];
const pondTs = [
  {
    tree: { op: 'gt', args: [{ col: 'v' }, { lit: 0 }] },
    times: [0, 2000],
    some: true,
    every: false,
    find: 0,
  },
  {
    tree: {
      op: 'or',
      args: [
        {
          op: 'ge',
          args: [
            { op: 'div', args: [{ col: 'v' }, { col: 'w' }] },
            { lit: 0.5 },
          ],
        },
        { op: 'eq', args: [{ col: 'host' }, { lit: 'c' }] },
      ],
    },
    times: [0, 3000],
    some: true,
    every: false,
    find: 0,
  },
  {
    tree: {
      op: 'lt',
      args: [{ op: 'sub', args: [{ lit: 10 }, { col: 'v' }] }, { lit: 8 }],
    },
    times: [2000],
    some: true,
    every: false,
    find: 2000,
  },
  {
    tree: {
      op: 'and',
      args: [
        { op: 'in', args: [{ col: 'host' }], values: ['a', 'c'] },
        { op: 'not', args: [{ op: 'isMissing', args: [{ col: 'v' }] }] },
      ],
    },
    times: [0, 2000, 3000],
    some: true,
    every: false,
    find: 0,
  },
  {
    tree: {
      op: 'when',
      args: [
        { op: 'gt', args: [{ col: 'v' }, { lit: 2 }] },
        { lit: true },
        { lit: false },
      ],
    },
    times: [2000],
    some: true,
    every: false,
    find: 2000,
  },
  {
    tree: {
      op: 'ne',
      args: [
        {
          op: 'fill',
          args: [
            {
              op: 'mul',
              args: [
                {
                  op: 'add',
                  args: [
                    { op: 'neg', args: [{ op: 'abs', args: [{ col: 'v' }] }] },
                    { lit: 5 },
                  ],
                },
                { lit: 2 },
              ],
            },
            { lit: 0 },
          ],
        },
        { lit: 4 },
      ],
    },
    times: [0, 1000, 3000],
    some: true,
    every: false,
    find: 0,
  },
];
rules.forEach((rule, i) => {
  const e = rule(rs);
  const want = pondTs[i];
  assert.deepEqual(JSON.parse(JSON.stringify(e)), want.tree);
  const f = b.filter(e);
  assert.deepEqual(
    rows(f).map((r) => r[0]),
    want.times,
    JSON.stringify(want.tree),
  );
  f.free();
  assert.equal(b.some(e), want.some);
  assert.equal(b.every(e), want.every);
  assert.equal(b.find(e)?.begin() ?? null, want.find);
});

// mapColumns with an expression and a function together: the expression
// reads `v` as it was before the function mapped it.
{
  const got = b.mapColumns({
    v: (x) => x * 10,
    w: rs.col('w').add(rs.col('v')),
  });
  assert.deepEqual(rows(got), [
    [0, 10, 3, 'a'],
    [1000, null, null, 'b'],
    [2000, 30, 3, 'a'],
    [3000, -60, -3, 'c'],
  ]);
  got.free();
}

// withColumn with an expression: fill fills here.
{
  const got = b.withColumn('r', rs.col('v').fill(rs.col('w')).mul(2));
  assert.deepEqual(rows(got), [
    [0, 1, 2, 'a', 2],
    [1000, null, 4, 'b', 8],
    [2000, 3, 0, 'a', 6],
    [3000, -6, 3, 'c', -12],
  ]);
  got.free();
}

// A bad operand is refused when the rule is built or used, as pond-ts.
assert.throws(() => rs.col('v').gt(NaN), TypeError);
assert.throws(() => rs.lit(Infinity), TypeError);
assert.throws(() => b.filter(rs.col('nope').gt(0)));
assert.throws(() => b.filter(rs.col('host').gt(0)));

b.free();
assert.equal(rs.alive(), 0);
console.log('expressions through @pond-ts/rs match pond-ts');
