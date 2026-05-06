/**
 * Auto-inject of partition columns on `PartitionedTimeSeries.aggregate`
 * / `.rolling`. Surfaced by the gRPC experiment's M3.5 friction note
 * "Per-partition `aggregate` must re-declare the partition column".
 *
 * Pre-fix: `series.partitionBy('host').aggregate(seq, { cpu: 'avg' })`
 * threw `column "host" not in schema` at the rewrap step because the
 * mapping didn't carry the partition column through.
 *
 * Post-fix: pond auto-injects `{ <partitionCol>: { from, using: 'first' } }`
 * for any partition column not already present as a key in the user's
 * mapping. `'first'` is by-construction-correct since every row in a
 * single partition shares that column's value.
 */
import { describe, expect, it } from 'vitest';
import { Sequence, TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'cpu', kind: 'number' },
] as const;

const compositeSchema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'region', kind: 'string' },
  { name: 'cpu', kind: 'number' },
] as const;

function makeSeries() {
  return new TimeSeries({
    name: 't',
    schema,
    rows: [
      [1000, 'a', 1],
      [2000, 'a', 2],
      [3000, 'b', 3],
      [4000, 'b', 4],
    ],
  });
}

// ── aggregate ───────────────────────────────────────────────────

describe('PartitionedTimeSeries.aggregate auto-inject of partition column', () => {
  it('does NOT throw when the mapping omits the partition column', () => {
    const series = makeSeries();
    expect(() =>
      series
        .partitionBy('host')
        .aggregate(Sequence.every('1s'), { cpu: 'avg' }),
    ).not.toThrow();
  });

  it('output schema includes the partition column', () => {
    const series = makeSeries();
    const out = series
      .partitionBy('host')
      .aggregate(Sequence.every('1s'), { cpu: 'avg' })
      .collect();
    expect(out.schema.map((c) => c.name)).toContain('host');
    expect(out.schema.map((c) => c.name)).toContain('cpu');
  });

  it('partition column carries the partition value (first row)', () => {
    const series = makeSeries();
    const rows = series
      .partitionBy('host')
      .aggregate(Sequence.every('1s'), { cpu: 'avg' })
      .collect()
      .toRows();
    // Two partitions (a, b) × two buckets each = 4 rows. Each row's
    // host column should match the partition.
    const hostsByPartitionStart = new Map<string, Set<string>>();
    for (const r of rows) {
      const host = r[2] as string; // [time, cpu, host] order
      const ts = (r[0] as { begin?: () => number }).begin?.() ?? 0;
      const partition = ts < 2500 ? 'a' : 'b';
      if (!hostsByPartitionStart.has(partition)) {
        hostsByPartitionStart.set(partition, new Set());
      }
      hostsByPartitionStart.get(partition)!.add(host);
    }
    expect(hostsByPartitionStart.get('a')).toEqual(new Set(['a']));
    expect(hostsByPartitionStart.get('b')).toEqual(new Set(['b']));
  });

  it('user-supplied partition column mapping wins over auto-inject', () => {
    const series = makeSeries();
    // User explicitly maps `host` with `'last'` — auto-inject must
    // respect that. Result rows should still have `host` set to
    // the partition's host value (since 'first' === 'last' inside
    // a partition by construction, but the test pins that the user's
    // choice was honored, not silently overridden).
    const out = series
      .partitionBy('host')
      .aggregate(Sequence.every('1s'), { host: 'last', cpu: 'avg' })
      .collect();
    expect(out.schema.map((c) => c.name)).toContain('host');
    // No additional `host`-ish columns from a forced auto-inject.
    const hostCols = out.schema.filter((c) => c.name === 'host');
    expect(hostCols).toHaveLength(1);
  });

  it('AggregateOutputMap with partition col aliased away — auto-inject still adds the original name', () => {
    const series = makeSeries();
    // User aliases the partition column to `host_id`. Auto-inject
    // must still add `host` (with its original name) because the
    // rewrap requires it.
    const out = series
      .partitionBy('host')
      .aggregate(Sequence.every('1s'), {
        host_id: { from: 'host', using: 'first' },
        cpu_avg: { from: 'cpu', using: 'avg' },
      })
      .collect();
    const names = out.schema.map((c) => c.name);
    expect(names).toContain('host');
    expect(names).toContain('host_id');
    expect(names).toContain('cpu_avg');
  });

  it('composite partitionBy auto-injects every partition column', () => {
    const series = new TimeSeries({
      name: 't',
      schema: compositeSchema,
      rows: [
        [1000, 'a', 'us', 1],
        [2000, 'a', 'us', 2],
        [3000, 'b', 'eu', 3],
      ],
    });
    const out = series
      .partitionBy(['host', 'region'])
      .aggregate(Sequence.every('1s'), { cpu: 'avg' })
      .collect();
    const names = out.schema.map((c) => c.name);
    expect(names).toContain('host');
    expect(names).toContain('region');
    expect(names).toContain('cpu');
  });
});

// ── rolling ─────────────────────────────────────────────────────

describe('PartitionedTimeSeries.rolling auto-inject of partition column', () => {
  it('does NOT throw when the mapping omits the partition column (count window)', () => {
    const series = makeSeries();
    expect(() =>
      series.partitionBy('host').rolling(2, { cpu: 'avg' }),
    ).not.toThrow();
  });

  it('does NOT throw when the mapping omits the partition column (duration window)', () => {
    const series = makeSeries();
    expect(() =>
      series.partitionBy('host').rolling('5s', { cpu: 'avg' }),
    ).not.toThrow();
  });

  it('does NOT throw on the (sequence, window, mapping) form', () => {
    const series = makeSeries();
    // The sequence-prefix form should also auto-inject correctly —
    // mapping is at index 2, not index 1.
    expect(() =>
      series
        .partitionBy('host')
        .rolling(Sequence.every('1s'), '2s', { cpu: 'avg' }),
    ).not.toThrow();
  });

  it('output schema includes the partition column', () => {
    const series = makeSeries();
    const out = series.partitionBy('host').rolling(2, { cpu: 'avg' }).collect();
    expect(out.schema.map((c) => c.name)).toContain('host');
  });

  it('composite partitionBy auto-injects every partition column on rolling', () => {
    const series = new TimeSeries({
      name: 't',
      schema: compositeSchema,
      rows: [
        [1000, 'a', 'us', 1],
        [2000, 'a', 'us', 2],
        [3000, 'b', 'eu', 3],
      ],
    });
    const out = series
      .partitionBy(['host', 'region'])
      .rolling(2, { cpu: 'avg' })
      .collect();
    const names = out.schema.map((c) => c.name);
    expect(names).toContain('host');
    expect(names).toContain('region');
  });
});

// ── Existing-behavior regression pin ────────────────────────────

describe('partitioned aggregate / rolling existing behavior is preserved', () => {
  it('mapping that already includes the partition column still works', () => {
    const series = makeSeries();
    // The pre-fix workaround pattern (gRPC experiment's friction
    // note's mechanical workaround) must still work — the auto-inject
    // is a no-op when the user has already opted in.
    expect(() =>
      series.partitionBy('host').aggregate(Sequence.every('1s'), {
        host: 'first',
        cpu: 'avg',
      }),
    ).not.toThrow();
    expect(() =>
      series.partitionBy('host').rolling(2, { host: 'first', cpu: 'avg' }),
    ).not.toThrow();
  });
});
