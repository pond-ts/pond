import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

// Pins the columnar partition split (audit v2 §3.2). `applyToSource` /
// `toMap` now group row indices off the store via `_partitionByColumns`
// instead of walking `this.events` + `fromEvents`-per-bucket. The split's
// key encoder must match the old event-based `partitionKeyOf` exactly —
// these cover the edge cases the broader partitionBy suite doesn't pin
// (the partition *key* itself being missing / array / composite-with-null).

describe('partitionBy columnar split — key encoding parity', () => {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'cpu', kind: 'number', required: false },
    { name: 'host', kind: 'string', required: false },
  ] as const;

  it('buckets a missing partition key under the leading-space sentinel', () => {
    const ts = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, 1, 'a'],
        [10_000, 2, undefined], // missing host
        [20_000, 3, 'a'],
        [30_000, 4, undefined],
      ],
    });
    const m = ts.partitionBy('host').toMap();
    expect([...m.keys()].sort()).toEqual([' undefined', 'a']);
    expect(m.get('a')?.length).toBe(2);
    expect(m.get(' undefined')?.length).toBe(2);
    // collect() keeps the missing-host rows (they are a real partition).
    expect(ts.partitionBy('host').collect().length).toBe(4);
  });

  it('distinguishes a missing key from the literal string "undefined"', () => {
    const ts = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, 1, undefined], // missing → ' undefined' (leading space)
        [10_000, 2, 'undefined'], // literal string → 'undefined'
      ],
    });
    const m = ts.partitionBy('host').toMap();
    expect(m.has(' undefined')).toBe(true);
    expect(m.has('undefined')).toBe(true);
    expect(m.get(' undefined')?.length).toBe(1);
    expect(m.get('undefined')?.length).toBe(1);
  });

  it('preserves first-encountered partition order in toMap', () => {
    const ts = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, 1, 'b'], // 'b' first
        [10_000, 2, 'a'],
        [20_000, 3, 'b'],
      ],
    });
    expect([...ts.partitionBy('host').toMap().keys()]).toEqual(['b', 'a']);
  });

  it('buckets an array-kind partition column by stringified value', () => {
    const arrSchema = [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
      { name: 'tags', kind: 'array' },
    ] as const;
    const ts = new TimeSeries({
      name: 's',
      schema: arrSchema,
      rows: [
        [0, 1, [1, 2]],
        [10_000, 2, [1, 2]],
        [20_000, 3, [3]],
      ],
    });
    const m = ts.partitionBy('tags').toMap();
    // String([1, 2]) === '1,2' — same as the old event path's partitionKeyOf.
    expect(m.get('1,2')?.length).toBe(2);
    expect(m.get('3')?.length).toBe(1);
  });

  it('sub-series carry equal cell values but not source Event identity', () => {
    // Deliberate trade for skipping materialization: the columnar split
    // gathers a fresh store per partition, so its events lazily materialize
    // as new instances rather than reusing the source's `Event` objects.
    // Cell values are identical; only object identity differs. (The old
    // `fromEvents` path reused source instances.)
    const ts = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, 1, 'a'],
        [10_000, 2, 'a'],
      ],
    });
    const sub = ts.partitionBy('host').toMap().get('a');
    expect(sub?.at(0)?.get('cpu')).toBe(1); // value identical to source row 0
    expect(sub?.at(0)?.get('host')).toBe('a');
    expect(sub?.at(0)).not.toBe(ts.at(0)); // but not the same Event instance
  });

  it('declared groups validate via a columnar scan (no materialization)', () => {
    // The membership check now scans the partition column off the store; an
    // out-of-group value still throws at construction, same as before.
    const rows = [
      [0, 1, 'a'],
      [10_000, 2, 'c'], // 'c' not in declared groups
    ] as const;
    expect(() =>
      new TimeSeries({ name: 's', schema, rows: rows.map((r) => [...r]) }) //
        .partitionBy('host', { groups: ['a', 'b'] as const }),
    ).toThrow(/not in declared groups/);
    // Valid membership constructs fine and toMap honors declared order.
    const ok = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, 1, 'b'],
        [10_000, 2, 'a'],
      ],
    }).partitionBy('host', { groups: ['a', 'b'] as const });
    expect([...ok.toMap().keys()]).toEqual(['a', 'b']); // declared order
  });

  it('encodes a composite partition with a missing component as null', () => {
    const cSchema = [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
      { name: 'host', kind: 'string', required: false },
      { name: 'region', kind: 'string', required: false },
    ] as const;
    const ts = new TimeSeries({
      name: 's',
      schema: cSchema,
      rows: [
        [0, 1, 'a', 'eu'],
        [10_000, 2, 'a', undefined], // region missing → ["a", null]
      ],
    });
    const m = ts.partitionBy(['host', 'region']).toMap();
    expect(m.has('["a","eu"]')).toBe(true);
    expect(m.has('["a",null]')).toBe(true);
  });
});
