import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries } from '../src/index.js';

// Pins the `first` / `last` columnar fast path (audit v2 §3.2/§3.3). The
// aggregate fast path now handles `first` / `last` as a boundary scan over
// any column kind, instead of bailing the whole call to the row path. The
// load-bearing contract: `first`/`last` select the first/last *defined*
// value, scanning past missing cells — NOT the boundary row's raw value.

describe('aggregate first/last columnar fast path', () => {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'value', kind: 'number', required: false },
    { name: 'label', kind: 'string', required: false },
  ] as const;

  // All four events fall in the same 1-minute bucket [0, 60s).
  const oneBucket = () =>
    new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, undefined, 'x'], // value missing
        [10_000, 5, 'y'],
        [20_000, 7, undefined], // label missing
        [30_000, undefined, 'z'], // value missing
      ],
    });

  const seq = Sequence.every(60_000);

  it('first skips a missing leading cell (first DEFINED, not first row)', () => {
    const out = oneBucket().aggregate(seq, { value: 'first' });
    expect(out.length).toBe(1);
    // Row 0's value is missing; the first defined value is row 1's (5).
    expect(out.at(0)?.get('value')).toBe(5);
  });

  it('last skips a missing trailing cell (last DEFINED, not last row)', () => {
    const out = oneBucket().aggregate(seq, { value: 'last' });
    // Row 3's value is missing; the last defined value is row 2's (7).
    expect(out.at(0)?.get('value')).toBe(7);
  });

  it('first/last work on a string column, scanning past missing', () => {
    const out = oneBucket().aggregate(seq, {
      first_label: { from: 'label', using: 'first' },
      last_label: { from: 'label', using: 'last' },
    });
    expect(out.at(0)?.get('first_label')).toBe('x');
    expect(out.at(0)?.get('last_label')).toBe('z'); // row 2's label is missing
  });

  it('all-missing bucket yields undefined for first and last', () => {
    const out = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, undefined, 'a'],
        [10_000, undefined, 'b'],
      ],
    }).aggregate(seq, {
      value: 'first',
      also: { from: 'value', using: 'last' },
    });
    expect(out.at(0)?.get('value')).toBeUndefined();
    expect(out.at(0)?.get('also')).toBeUndefined();
  });

  it('empty bucket (sparse grid) yields undefined for first', () => {
    // One event at t=0, a multi-minute grid → bucket 0 has the event, the
    // later bucket(s) are empty and must reduce to undefined.
    const out = new TimeSeries({
      name: 's',
      schema,
      rows: [[0, 9, 'q']],
    }).aggregate(
      seq,
      { value: 'first' },
      {
        range: { begin: () => 0, end: () => 180_000 },
      },
    );
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.at(0)?.get('value')).toBe(9);
    expect(out.at(1)?.get('value')).toBeUndefined();
  });

  it('mixes a numeric reducer and a boundary selector in one call', () => {
    const out = oneBucket().aggregate(seq, { value: 'avg', label: 'first' });
    expect(out.at(0)?.get('value')).toBe(6); // avg of [5, 7]
    expect(out.at(0)?.get('label')).toBe('x');
  });
});

describe('partitioned aggregate takes the fast path (parity)', () => {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'cpu', kind: 'number' },
    { name: 'host', kind: 'string' },
  ] as const;

  it('auto-injected host:first resolves correctly per partition', () => {
    // 2 hosts × 2 minutes, one event each. The partitioned aggregate
    // auto-injects { host: { from: 'host', using: 'first' } } — which used
    // to knock every partitioned call off the columnar fast path.
    const s = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, 10, 'a'],
        [0, 20, 'b'],
        [60_000, 30, 'a'],
        [60_000, 40, 'b'],
      ],
    });

    const out = s
      .partitionBy('host')
      .aggregate(Sequence.every(60_000), { cpu: 'avg' })
      .collect();

    expect(out.length).toBe(4);
    const pairs = out
      .toObjects()
      .map((o) => `${String(o.host)}:${String(o.cpu)}`)
      .sort();
    expect(pairs).toEqual(['a:10', 'a:30', 'b:20', 'b:40']);
    // Every output row carries its partition's host (the injected 'first').
    expect(out.toObjects().every((o) => o.host === 'a' || o.host === 'b')).toBe(
      true,
    );
  });
});
