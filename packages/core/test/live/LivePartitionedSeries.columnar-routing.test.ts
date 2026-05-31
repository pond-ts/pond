import { describe, expect, it } from 'vitest';

import { LiveSeries } from '../../src/live/live-series.js';

/* -------------------------------------------------------------------------- */
/* Phase 2 pins — column-native partition routing.                             */
/*                                                                             */
/* When the source is a chunked-backed LiveSeries (top-level strict + time),   */
/* `partitionBy` routes its appended chunks → per-partition column sub-batches */
/* via withRowSelection (no per-row Event), and partition sub-series use the   */
/* chunked backing. Any other source falls back to the per-event Event[] path. */
/* The broad LivePartitionedSeries suite already runs through this routing;    */
/* this file pins the Phase-2-specific contract.                               */
/* -------------------------------------------------------------------------- */

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

type Backed = { _isChunked: boolean };

describe('column-native partition routing — chunked source', () => {
  it('partitions adopt the chunked backing and route correctly across batches', () => {
    const live = new LiveSeries({ name: 's', schema: SCHEMA });
    expect((live as unknown as Backed)._isChunked).toBe(true); // strict+time

    const byHost = live.partitionBy('host');
    live.pushMany([
      [0, 10, 'a'],
      [0, 20, 'b'],
      [1000, 11, 'a'],
      [1000, 21, 'b'],
    ]);
    live.pushMany([
      [2000, 12, 'a'],
      [2000, 22, 'b'],
      [3000, 99, 'c'], // new partition mid-stream
    ]);

    const parts = byHost.toMap();
    expect([...parts.keys()].sort()).toEqual(['a', 'b', 'c']);

    const a = parts.get('a')!;
    const b = parts.get('b')!;
    const c = parts.get('c')!;

    // Partitions are chunked-backed (the OOM fix — no per-partition Event[]).
    expect((a as unknown as Backed)._isChunked).toBe(true);
    expect((b as unknown as Backed)._isChunked).toBe(true);
    expect((c as unknown as Backed)._isChunked).toBe(true);

    // Routed correctly.
    expect(a.length).toBe(3);
    expect([
      a.at(0)!.get('value'),
      a.at(1)!.get('value'),
      a.at(2)!.get('value'),
    ]).toEqual([10, 11, 12]);
    expect(b.length).toBe(3);
    expect(b.at(2)!.get('value')).toBe(22);
    expect(c.length).toBe(1);
    expect(c.at(0)!.get('value')).toBe(99);
  });

  it('coalesces thin per-partition routing into few chunks (gRPC V7 fix)', () => {
    // The pathology: thin scatter (1 row per partition per source batch)
    // would make one chunk per (batch × partition) — gRPC V7 measured
    // 23.5× the object count. Coalescing accumulates and flushes at the
    // threshold, so per-partition chunk count stays bounded by
    // ~rows / flushThreshold, not = number of source batches.
    const live = new LiveSeries({ name: 's', schema: SCHEMA }); // strict+time → chunked
    const byHost = live.partitionBy('host');
    const T = 600;
    for (let t = 0; t < T; t += 1) {
      live.pushMany([
        [t, t, 'a'],
        [t, t * 2, 'b'],
        [t, t * 3, 'c'],
      ]); // 1 row per host per batch — the thin-scatter case
    }
    const a = byHost.toMap().get('a')! as unknown as {
      length: number;
      _chunkCount: number;
      at(i: number): { get(c: string): unknown } | undefined;
    };
    expect(a.length).toBe(T); // every routed row present
    expect(a.at(0)!.get('value')).toBe(0);
    expect(a.at(T - 1)!.get('value')).toBe(T - 1);
    // Bounded by ~T/256 committed chunks — NOT T (one per source batch).
    expect(a._chunkCount).toBeLessThanOrEqual(3);
  });

  it('per-partition retention is exact through routing', () => {
    const live = new LiveSeries({
      name: 's',
      schema: SCHEMA,
      retention: { maxEvents: 2 },
    });
    const byHost = live.partitionBy('host');
    for (let t = 0; t < 5; t += 1) {
      live.pushMany([
        [t * 1000, t, 'a'],
        [t * 1000, t * 10, 'b'],
      ]);
    }
    const a = byHost.toMap().get('a')!;
    expect(a.length).toBe(2); // maxEvents inherited
    expect([a.at(0)!.get('value'), a.at(1)!.get('value')]).toEqual([3, 4]);
  });

  it('live collect() stays source-ordered across partitions (PR #175 P1)', () => {
    // The fan-out must stay in SOURCE order across partitions, not
    // bucketed per partition — else a live collect()'s strict unified
    // buffer throws on an out-of-order key. Subscribe BEFORE ingest (the
    // live path), then push a batch that interleaves partitions.
    const live = new LiveSeries({ name: 's', schema: SCHEMA });
    const byHost = live.partitionBy('host');
    const collected = byHost.collect(); // live subscription before ingest
    expect(() =>
      live.pushMany([
        [0, 1, 'a'],
        [1000, 2, 'b'],
        [2000, 3, 'a'], // bucketed routing would emit a@0,a@2 then b@1 → throw
      ]),
    ).not.toThrow();
    expect(collected.length).toBe(3);
    collected.dispose?.();
  });

  it('collect aggregates correctly over the column-routed partitions', () => {
    const live = new LiveSeries({ name: 's', schema: SCHEMA });
    const byHost = live.partitionBy('host');
    live.pushMany([
      [0, 10, 'a'],
      [1000, 20, 'b'],
      [2000, 30, 'a'],
    ]);
    const collected = byHost.collect();
    expect(collected.length).toBe(3);
    collected.dispose?.();
  });

  it('undefined partition key routes to the same " undefined" bucket as the per-event path', () => {
    // The partition column must be optional for an undefined value to
    // reach storage at all (a required column is rejected at intake on
    // both backings).
    const optionalHost = [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
      { name: 'host', kind: 'string', required: false },
    ] as const;
    const live = new LiveSeries({ name: 's', schema: optionalHost });
    const byHost = live.partitionBy('host');
    live.pushMany([
      [0, 10, 'a'],
      [1000, 20, undefined as unknown as string], // undefined host
    ]);
    const parts = byHost.toMap();
    expect(parts.has('a')).toBe(true);
    expect(parts.has(' undefined')).toBe(true);
    expect(parts.get(' undefined')!.at(0)!.get('value')).toBe(20);
  });

  it('declared groups still reject an undeclared value on the chunked path', () => {
    const live = new LiveSeries({ name: 's', schema: SCHEMA });
    const byHost = live.partitionBy('host', { groups: ['a', 'b'] });
    expect(() => live.pushMany([[0, 1, 'c']])).toThrow();
    void byHost;
  });
});

describe('column-native partition routing — array fallback', () => {
  it('ordering override on a chunked source falls back to per-event (no crash, PR #175 P1)', () => {
    // A chunked (strict) source with `partitionBy(col, { ordering: 'reorder' })`
    // spawns ARRAY-backed partitions — column routing must NOT be selected
    // (else #routeChunk → _stageRows throws "not chunked-backed" and crashes
    // ingest). The view falls back to the per-event path.
    for (const ordering of ['reorder', 'drop'] as const) {
      const live = new LiveSeries({ name: 's', schema: SCHEMA }); // chunked (strict+time)
      expect((live as unknown as Backed)._isChunked).toBe(true);
      const byHost = live.partitionBy('host', { ordering });
      expect(() =>
        live.pushMany([
          [0, 1, 'a'],
          [1000, 2, 'b'],
        ]),
      ).not.toThrow();
      const a = byHost.toMap().get('a')! as unknown as Backed & {
        length: number;
      };
      expect(a._isChunked).toBe(false); // array-backed (non-strict partition)
      expect(a.length).toBe(1);
    }
  });

  it('a reorder source keeps the per-event Event[] partition backing', () => {
    const live = new LiveSeries({
      name: 's',
      schema: SCHEMA,
      ordering: 'reorder',
    });
    expect((live as unknown as Backed)._isChunked).toBe(false);

    const byHost = live.partitionBy('host');
    live.push([1000, 10, 'a']);
    live.push([0, 5, 'a']); // out-of-order — reorder inserts sorted

    const a = byHost.toMap().get('a')!;
    expect((a as unknown as Backed)._isChunked).toBe(false); // array-backed
    expect(a.length).toBe(2);
    // reorder: sorted by time within the partition
    expect([a.at(0)!.get('value'), a.at(1)!.get('value')]).toEqual([5, 10]);
  });
});
