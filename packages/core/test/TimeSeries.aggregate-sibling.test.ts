import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries } from '../src/index.js';

// [PND-AGGSIBLING]: a column's aggregate result must not depend on which
// other columns share the call. Before the fix, one column without a
// columnar kernel (`unique`, `top`, `samples`, `keep`, `difference`, a
// reducer over a text column, a custom function) sent the whole call to the
// row path, where `sum` / `avg` lose the blocked summation (buckets of 32+
// values) and `median` can pick the other sign of zero.

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'host', kind: 'string' },
] as const;

function series(
  value: (i: number) => number | undefined,
): TimeSeries<typeof schema> {
  const rows: Array<[number, number | undefined, string]> = [];
  for (let i = 0; i < 200; i += 1) rows.push([i * 1000, value(i), `h${i % 3}`]);
  return new TimeSeries({ name: 's', schema, rows });
}

// Long, order-sensitive mantissas: a blocked and a sequential sum differ.
const noisy = series((i) =>
  i % 10 === 3
    ? undefined
    : (((i * 2654435761) % 4294967291) / 4294967291 - 0.3) * 10 ** (i % 6),
);
const zeros = series((i) =>
  i % 9 === 4 ? undefined : [0, -0, 1, -1, 2][(i * 3) % 5],
);

const siblings = {
  count: { from: 'host', using: 'count' },
  unique: { from: 'host', using: 'unique' },
  top: { from: 'host', using: 'top2' },
  samples: { from: 'host', using: 'samples' },
  keep: { from: 'host', using: 'keep' },
  difference: { from: 'v', using: 'difference' },
  custom: {
    from: 'host',
    using: (values: ReadonlyArray<unknown>) => values.length,
    kind: 'number',
  },
} as const;

describe('aggregate: a column does not depend on its siblings', () => {
  for (const [label, input] of [
    ['noisy', noisy],
    ['zeros', zeros],
  ] as const) {
    for (const reducer of [
      'sum',
      'avg',
      'median',
      'p95',
      'stdev',
      'min',
      'max',
    ] as const) {
      for (const [name, sibling] of Object.entries(siblings)) {
        it(`${label}: ${reducer} with a ${name} sibling`, () => {
          const seq = Sequence.every('1m');
          const alone = input.aggregate(seq, { v: reducer });
          const mixed = input.aggregate(seq, {
            v: reducer,
            other: sibling,
          } as never);
          const a = alone.toArray().map((e) => e.get('v'));
          const b = mixed.toArray().map((e) => e.get('v'));
          expect(b.length).toBe(a.length);
          // Object.is: the same bits, -0 included.
          b.forEach((x, i) => expect(Object.is(x, a[i])).toBe(true));
        });
      }
    }
  }

  it('sibling columns still get their own answers', () => {
    const r = noisy
      .aggregate(Sequence.every('1m'), {
        v: 'sum',
        u: { from: 'host', using: 'unique' },
        n: { from: 'host', using: 'count' },
        k: { from: 'host', using: 'keep' },
      })
      .toArray()[0]!;
    expect(r.get('u')).toEqual(['h0', 'h1', 'h2']);
    expect(r.get('n')).toBe(60);
    expect(r.get('k')).toBeUndefined();
  });
});
