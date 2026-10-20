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

// The columns that moved off the row path must keep the answers they had
// there: custom functions (inputs, call order, errors), boolean and array
// sources, and partitioned calls.
describe('aggregate: moved columns keep their row-path answers', () => {
  const mixedSchema = [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number', required: false },
    { name: 'ok', kind: 'boolean', required: false },
    { name: 'tags', kind: 'array', required: false },
  ] as const;
  const s = new TimeSeries({
    name: 'm',
    schema: mixedSchema,
    rows: [
      [0, 1, true, ['a', 'b']],
      [1000, undefined, true, ['b']],
      [2000, -0, undefined, undefined],
      [60_000, 4, false, ['c']],
      [61_000, 5, true, ['c', 'a']],
    ],
  });

  it('custom function sees gaps as undefined and -0 kept, bucket by bucket', () => {
    const seen: unknown[][] = [];
    s.aggregate(Sequence.every('1m'), {
      v: 'sum',
      f: {
        from: 'v',
        using: (values: ReadonlyArray<unknown>) => {
          seen.push([...values]);
          return values.length;
        },
        kind: 'number',
      },
    } as never);
    expect(seen.length).toBe(2);
    expect(seen[0]).toEqual([1, undefined, -0]);
    expect(Object.is(seen[0]![2], -0)).toBe(true);
    expect(seen[1]).toEqual([4, 5]);
  });

  it('custom function returning the wrong kind names the row and column', () => {
    expect(() =>
      s.aggregate(Sequence.every('1m'), {
        v: 'sum',
        f: { from: 'v', using: () => 'oops', kind: 'number' },
      } as never),
    ).toThrow(/row 0.*f|f.*row 0/);
  });

  it('boolean and array sources', () => {
    const rows = s
      .aggregate(Sequence.every('1m'), {
        v: 'sum',
        okKeep: { from: 'ok', using: 'keep' },
        okCount: { from: 'ok', using: 'count' },
        tagSet: { from: 'tags', using: 'unique' },
      } as never)
      .toArray();
    expect(rows[0]!.get('okKeep' as never)).toBe(true);
    expect(rows[0]!.get('okCount' as never)).toBe(2);
    expect(rows[0]!.get('tagSet' as never)).toEqual(['a', 'b']);
    expect(rows[1]!.get('okKeep' as never)).toBeUndefined();
    expect(rows[1]!.get('tagSet' as never)).toEqual(['a', 'c']);
  });

  it('partitioned: each partition matches its own unpartitioned call', () => {
    const seq = Sequence.every('1m');
    const spec = {
      v: 'sum',
      u: { from: 'host', using: 'unique' },
    } as const;
    const parts = noisy
      .partitionBy('host')
      .aggregate(seq, spec as never)
      .collect()
      .toArray();
    for (const host of ['h0', 'h1', 'h2']) {
      const alone = noisy
        .filter((e) => e.get('host') === host)
        .aggregate(seq, { v: 'sum' })
        .toArray()
        .map((e) => e.get('v'));
      const got = parts
        .filter((e) => e.get('host' as never) === host)
        .map((e) => e.get('v'));
      expect(got.length).toBe(alone.length);
      got.forEach((x, i) => expect(Object.is(x, alone[i])).toBe(true));
    }
  });
});
