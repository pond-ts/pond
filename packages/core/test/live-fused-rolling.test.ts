/**
 * Tests for the keyed-form fused multi-window rolling primitive
 * (`live.rolling({ '1m': m1, '200ms': m2 }, opts)`). See
 * `LiveFusedRolling` and `LivePartitionedFusedRolling`. Design:
 * PLAN.md "Fused multi-window rolling + buffer-as-window
 * unification".
 *
 * Three blocks:
 *   1. Single-window equivalence — fused-with-one-entry MUST behave
 *      identically to today's `live.rolling(window, mapping)`. This
 *      is the load-bearing pin.
 *   2. Multi-window correctness on LiveSeries — independent windows,
 *      shared deque, merged output.
 *   3. Partitioned variant — `partitionBy('host').rolling({...},
 *      { trigger })` synced cross-partition emission.
 */
import { describe, expect, it } from 'vitest';
import { LiveSeries, Sequence, Trigger } from '../src/index.js';

const numericSchema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function makeLive() {
  return new LiveSeries({ name: 'metrics', schema: numericSchema });
}

// ── 1. Single-window equivalence ────────────────────────────────

describe('LiveFusedRolling — single-window equivalence', () => {
  it('one-window fused matches today-shape rolling on event trigger', () => {
    const liveA = makeLive();
    const liveB = makeLive();
    const todayShape = liveA.rolling('1m', { cpu: 'avg' });
    const fusedShape = liveB.rolling({ '1m': { cpu: 'avg' } });

    for (let t = 0; t < 5; t++) {
      const ts = t * 1000;
      const cpu = (t % 3) * 0.1;
      liveA.push([ts, cpu, 'a']);
      liveB.push([ts, cpu, 'a']);
    }

    expect(todayShape.length).toBe(fusedShape.length);
    for (let i = 0; i < todayShape.length; i++) {
      expect(fusedShape.at(i)!.get('cpu')).toBe(todayShape.at(i)!.get('cpu'));
      expect(fusedShape.at(i)!.begin()).toBe(todayShape.at(i)!.begin());
    }

    todayShape.dispose();
    fusedShape.dispose();
  });

  it('one-window fused matches today-shape on AggregateOutputMap form', () => {
    const liveA = makeLive();
    const liveB = makeLive();
    const todayShape = liveA.rolling('1m', {
      cpu_avg: { from: 'cpu', using: 'avg' },
      cpu_max: { from: 'cpu', using: 'max' },
    });
    const fusedShape = liveB.rolling({
      '1m': {
        cpu_avg: { from: 'cpu', using: 'avg' },
        cpu_max: { from: 'cpu', using: 'max' },
      },
    });

    for (let t = 0; t < 8; t++) {
      const ts = t * 500;
      liveA.push([ts, t, 'a']);
      liveB.push([ts, t, 'a']);
    }

    expect(todayShape.length).toBe(fusedShape.length);
    for (let i = 0; i < todayShape.length; i++) {
      expect(fusedShape.at(i)!.get('cpu_avg')).toBe(
        todayShape.at(i)!.get('cpu_avg'),
      );
      expect(fusedShape.at(i)!.get('cpu_max')).toBe(
        todayShape.at(i)!.get('cpu_max'),
      );
    }

    todayShape.dispose();
    fusedShape.dispose();
  });

  it('one-window fused matches today-shape on clock trigger', () => {
    const liveA = makeLive();
    const liveB = makeLive();
    const trig = Trigger.every('1s');
    const todayShape = liveA.rolling('5s', { cpu: 'avg' }, { trigger: trig });
    const fusedShape = liveB.rolling(
      { '5s': { cpu: 'avg' } },
      { trigger: trig },
    );

    for (let t = 0; t < 10; t++) {
      const ts = t * 250;
      liveA.push([ts, t, 'a']);
      liveB.push([ts, t, 'a']);
    }

    expect(todayShape.length).toBe(fusedShape.length);
    for (let i = 0; i < todayShape.length; i++) {
      expect(fusedShape.at(i)!.begin()).toBe(todayShape.at(i)!.begin());
      expect(fusedShape.at(i)!.get('cpu')).toBe(todayShape.at(i)!.get('cpu'));
    }

    todayShape.dispose();
    fusedShape.dispose();
  });

  it('one-window fused respects minSamples (top-level option)', () => {
    const live = makeLive();
    const r = live.rolling({ '5s': { cpu: 'avg' } }, { minSamples: 3 });

    live.push([0, 10, 'a']);
    expect(r.at(0)!.get('cpu')).toBeUndefined(); // 1 < 3
    live.push([1000, 20, 'a']);
    expect(r.at(1)!.get('cpu')).toBeUndefined(); // 2 < 3
    live.push([2000, 30, 'a']);
    expect(r.at(2)!.get('cpu')).toBe(20); // gate opens at 3

    r.dispose();
  });
});

// ── 2. Multi-window correctness ─────────────────────────────────

describe('LiveFusedRolling — multi-window correctness', () => {
  it('emits one merged event per source event with all windows', () => {
    const live = makeLive();
    const fused = live.rolling({
      '5s': { cpu_avg: { from: 'cpu', using: 'avg' } },
      '1s': { cpu_max: { from: 'cpu', using: 'max' } },
    });

    live.push([0, 10, 'a']);
    live.push([500, 20, 'a']);
    live.push([1500, 30, 'a']); // 0-event leaves 1s window

    expect(fused.length).toBe(3);

    // After last push: 5s window holds [10, 20, 30] → avg = 20.
    // 1s window holds [20, 30] (event at 0 evicted; cutoff 1500-1000=500
    // and event at 500 has timestamp >= 500, so it's still in).
    expect(fused.at(2)!.get('cpu_avg')).toBe(20);
    expect(fused.at(2)!.get('cpu_max')).toBe(30);

    fused.dispose();
  });

  it('different windows evict at different rates', () => {
    const live = makeLive();
    const fused = live.rolling({
      '5s': { cpu_avg: { from: 'cpu', using: 'avg' } },
      '1s': { cpu_max: { from: 'cpu', using: 'max' } },
    });

    live.push([0, 10, 'a']);
    live.push([2000, 100, 'a']); // 5s window: [10, 100]; 1s window: [100]

    expect(fused.at(1)!.get('cpu_avg')).toBe(55); // (10 + 100) / 2
    expect(fused.at(1)!.get('cpu_max')).toBe(100); // only 100 in 1s window

    fused.dispose();
  });

  it('rejects duplicate output column names across windows', () => {
    const live = makeLive();
    expect(() =>
      live.rolling({
        '1m': { cpu: 'avg' },
        '5m': { cpu: 'avg' }, // duplicate output column 'cpu'
      }),
    ).toThrow(/duplicate output column/i);
  });

  it('elaborated value form: per-window minSamples overrides top-level', () => {
    const live = makeLive();
    const fused = live.rolling(
      {
        // bare mapping → uses top-level minSamples=2
        '5s': { cpu_avg: { from: 'cpu', using: 'avg' } },
        // per-window override
        '1s': {
          mapping: { cpu_max: { from: 'cpu', using: 'max' } },
          minSamples: 5,
        },
      },
      { minSamples: 2 },
    );

    live.push([0, 10, 'a']);
    expect(fused.at(0)!.get('cpu_avg')).toBeUndefined(); // 1 < 2
    expect(fused.at(0)!.get('cpu_max')).toBeUndefined(); // 1 < 5

    live.push([100, 20, 'a']);
    expect(fused.at(1)!.get('cpu_avg')).toBe(15); // gate opens (2 ≥ 2)
    expect(fused.at(1)!.get('cpu_max')).toBeUndefined(); // 2 < 5

    fused.dispose();
  });

  it('rejects empty fused mapping', () => {
    const live = makeLive();
    expect(() => live.rolling({})).toThrow(/at least one window/);
  });

  it('rejects invalid window keys', () => {
    const live = makeLive();
    expect(() =>
      live.rolling({ '1min': { cpu: 'avg' } as never } as never),
    ).toThrow(/invalid window key/i);
  });

  it('rejects buffer sentinel for now (reserved for live.reduce)', () => {
    const live = makeLive();
    expect(() => live.rolling({ buffer: { cpu: 'avg' } })).toThrow(
      /buffer.*reserved/i,
    );
  });

  it('clock trigger emits one merged event per boundary crossing', () => {
    const live = makeLive();
    const fused = live.rolling(
      {
        '5s': { cpu_avg: { from: 'cpu', using: 'avg' } },
        '1s': { cpu_max: { from: 'cpu', using: 'max' } },
      },
      { trigger: Trigger.every('1s') },
    );

    // First event establishes starting bucket; no emission.
    live.push([0, 10, 'a']);
    expect(fused.length).toBe(0);

    // Event at 1500 crosses the 1s boundary: emit one event at boundary 1000.
    live.push([1500, 20, 'a']);
    expect(fused.length).toBe(1);
    const e = fused.at(0)!;
    expect(e.begin()).toBe(1000);
    // Reducer state at the time of the boundary-crossing event:
    expect(e.get('cpu_avg')).toBe(15); // [10, 20] in 5s
    expect(e.get('cpu_max')).toBe(20); // [20] in 1s (10 evicted)

    fused.dispose();
  });

  it('value() returns merged snapshot across all windows', () => {
    const live = makeLive();
    const fused = live.rolling({
      '5s': { cpu_avg: { from: 'cpu', using: 'avg' } },
      '1s': { cpu_max: { from: 'cpu', using: 'max' } },
    });

    live.push([0, 10, 'a']);
    live.push([500, 20, 'a']);

    const snap = fused.value();
    expect(snap.cpu_avg).toBe(15);
    expect(snap.cpu_max).toBe(20);

    fused.dispose();
  });

  it('multi-window over the same source matches two separate rollings', () => {
    // Two windows in fused must produce identical per-event output
    // to two separate rollings over the same source. (This is the
    // architectural pin: fused is a perf optimization, not a
    // semantic change.)
    const liveA = makeLive();
    const liveB = makeLive();

    const sep1 = liveA.rolling('5s', {
      cpu_avg: { from: 'cpu', using: 'avg' },
    });
    const sep2 = liveA.rolling('1s', {
      cpu_max: { from: 'cpu', using: 'max' },
    });
    const fused = liveB.rolling({
      '5s': { cpu_avg: { from: 'cpu', using: 'avg' } },
      '1s': { cpu_max: { from: 'cpu', using: 'max' } },
    });

    for (let t = 0; t < 10; t++) {
      const ts = t * 300;
      liveA.push([ts, t * 5, 'a']);
      liveB.push([ts, t * 5, 'a']);
    }

    expect(fused.length).toBe(sep1.length);
    for (let i = 0; i < fused.length; i++) {
      expect(fused.at(i)!.get('cpu_avg')).toBe(sep1.at(i)!.get('cpu_avg'));
      expect(fused.at(i)!.get('cpu_max')).toBe(sep2.at(i)!.get('cpu_max'));
    }

    sep1.dispose();
    sep2.dispose();
    fused.dispose();
  });
});

// ── 3. Partitioned variant ──────────────────────────────────────

describe('LivePartitionedFusedRolling — partitioned variant', () => {
  function makePartitionedLive() {
    return new LiveSeries({
      name: 'metrics-partitioned',
      schema: numericSchema,
    });
  }

  it('emits one merged row per partition per boundary crossing', () => {
    const live = makePartitionedLive();
    const byHost = live.partitionBy('host');
    const fused = byHost.rolling(
      {
        '5s': { cpu_avg: { from: 'cpu', using: 'avg' } },
        '1s': { cpu_max: { from: 'cpu', using: 'max' } },
      },
      { trigger: Trigger.every('1s') },
    );

    live.push([0, 10, 'api-1']);
    live.push([100, 20, 'api-2']);
    // Event at 1500 crosses the 1s boundary; emit two events at boundary 1000.
    live.push([1500, 30, 'api-1']);

    expect(fused.length).toBe(2); // one per partition (api-1, api-2)
    const byHostEvent = new Map<string, any>();
    for (let i = 0; i < fused.length; i++) {
      const e = fused.at(i)!;
      byHostEvent.set(e.get('host') as string, e);
    }
    const e1 = byHostEvent.get('api-1');
    const e2 = byHostEvent.get('api-2');
    expect(e1).toBeDefined();
    expect(e2).toBeDefined();
    // At the boundary-crossing event(1500, 30, api-1):
    //   ingest adds 30 to api-1's reducer state, evicts 0-event from
    //   1s window (cutoff 500) — keeps 30. 5s window (cutoff -3500)
    //   keeps both 10 and 30. Then trigger fires for boundary 1000.
    //   #emitTick re-evicts both partitions against latestTs=1500,
    //   then snapshots.
    //   api-1: 5s = (10+30)/2 = 20, 1s = 30
    //   api-2: 5s = 20 (only one event at t=100, still in 5s window),
    //          1s = undefined (event at 100 < cutoff 500 → evicted)
    expect(e1.get('cpu_avg')).toBe(20);
    expect(e1.get('cpu_max')).toBe(30);
    expect(e2.get('cpu_avg')).toBe(20);
    expect(e2.get('cpu_max')).toBeUndefined();

    fused.dispose();
  });

  it('output schema has time, partition column, then merged columns', () => {
    const live = makePartitionedLive();
    const fused = live.partitionBy('host').rolling(
      {
        '1m': { cpu_avg: { from: 'cpu', using: 'avg' } },
        '200ms': { cpu_max: { from: 'cpu', using: 'max' } },
      },
      { trigger: Trigger.every('100ms') },
    );

    expect(fused.schema[0]?.name).toBe('time');
    expect(fused.schema[1]?.name).toBe('host');
    const valueColumns = fused.schema.slice(2).map((c) => c?.name);
    expect(valueColumns).toContain('cpu_avg');
    expect(valueColumns).toContain('cpu_max');

    fused.dispose();
  });

  it('rejects non-clock trigger on partitioned fused', () => {
    const live = makePartitionedLive();
    const byHost = live.partitionBy('host');
    expect(() =>
      byHost.rolling(
        { '1m': { cpu: 'avg' } },
        // event-trigger isn't accepted on partitioned fused
        { trigger: { kind: 'event' } as never },
      ),
    ).toThrow(/clock trigger/i);
  });

  it('rejects partition-column collision in any window', () => {
    const live = makePartitionedLive();
    expect(() =>
      live
        .partitionBy('host')
        .rolling(
          { '1m': { host: 'last' } },
          { trigger: Trigger.every('100ms') },
        ),
    ).toThrow(/partition column.*collides/i);
  });

  it('rejects duplicate output columns across windows in partitioned form', () => {
    const live = makePartitionedLive();
    expect(() =>
      live.partitionBy('host').rolling(
        {
          '1m': { cpu_avg: { from: 'cpu', using: 'avg' } },
          '5m': { cpu_avg: { from: 'cpu', using: 'avg' } },
        },
        { trigger: Trigger.every('1s') },
      ),
    ).toThrow(/duplicate output column/i);
  });

  it('declared groups pre-seed partition order', () => {
    const live = makePartitionedLive();
    const fused = live
      .partitionBy('host', { groups: ['api-1', 'api-2', 'api-3'] as const })
      .rolling(
        { '1s': { cpu_avg: { from: 'cpu', using: 'avg' } } },
        { trigger: Trigger.every('500ms') },
      );

    // Push only to api-1; trigger crossing should still emit one
    // snapshot per declared group (in declared order).
    live.push([0, 10, 'api-1']);
    live.push([700, 20, 'api-1']); // crosses the 500ms boundary

    // Expect 3 events at boundary 500 (one per declared group),
    // even though only api-1 has any data.
    expect(fused.length).toBe(3);
    expect(fused.at(0)!.get('host')).toBe('api-1');
    expect(fused.at(1)!.get('host')).toBe('api-2');
    expect(fused.at(2)!.get('host')).toBe('api-3');
    // At the boundary-crossing event(700, 20), api-1's reducer state
    // already includes both 10 and 20. The 1s window's cutoff is
    // 700 - 1000 = -300, so nothing evicts. Snapshot = (10+20)/2 = 15.
    expect(fused.at(0)!.get('cpu_avg')).toBe(15);
    expect(fused.at(1)!.get('cpu_avg')).toBeUndefined();
    expect(fused.at(2)!.get('cpu_avg')).toBeUndefined();

    fused.dispose();
  });

  it('quiet partitions get evicted-against-now on emit', () => {
    const live = makePartitionedLive();
    const fused = live
      .partitionBy('host')
      .rolling(
        { '500ms': { cpu_avg: { from: 'cpu', using: 'avg' } } },
        { trigger: Trigger.every('1s') },
      );

    // api-1 receives at t=0, then goes silent.
    live.push([0, 100, 'api-1']);
    // api-2 starts at t=500; its event is well-ordered.
    live.push([500, 50, 'api-2']);
    // api-2 fires the boundary at t=1500 → both partitions emit.
    live.push([1500, 60, 'api-2']);

    // At the boundary (1000), against latestTs=1500:
    //   500ms cutoff = 1500 - 500 = 1000
    //   api-1's only entry is at ts=0, which is < 1000 → evicted
    //   api-2's entries at 500 (< 1000, evicted) and 1500 (>= 1000, kept)
    // So api-1's cpu_avg should be undefined; api-2's should be 60.
    const byHostEvent = new Map<string, any>();
    for (let i = 0; i < fused.length; i++) {
      const e = fused.at(i)!;
      byHostEvent.set(e.get('host') as string, e);
    }
    expect(byHostEvent.get('api-1')!.get('cpu_avg')).toBeUndefined();
    expect(byHostEvent.get('api-2')!.get('cpu_avg')).toBe(60);

    fused.dispose();
  });
});

// ── 4. Smoke: dispose / unsubscribe ─────────────────────────────

describe('LiveFusedRolling — lifecycle', () => {
  it('dispose detaches from source', () => {
    const live = makeLive();
    const fused = live.rolling({ '1s': { cpu: 'avg' } });

    live.push([0, 10, 'a']);
    expect(fused.length).toBe(1);

    fused.dispose();

    live.push([100, 20, 'a']);
    expect(fused.length).toBe(1); // no growth after dispose
  });

  it('partitioned fused: dispose detaches all partition subscriptions', () => {
    const live = new LiveSeries({
      name: 'p-fused-dispose',
      schema: numericSchema,
    });
    const fused = live
      .partitionBy('host')
      .rolling({ '1s': { cpu: 'avg' } }, { trigger: Trigger.every('500ms') });

    live.push([0, 10, 'a']);
    live.push([700, 20, 'a']);
    const lengthBefore = fused.length;

    fused.dispose();

    live.push([1500, 30, 'a']);
    expect(fused.length).toBe(lengthBefore); // no growth after dispose
  });
});

// ── 5. Periodic batched compaction (v0.15.2 head-index path) ──

describe('LiveFusedRolling — head-index batched compaction', () => {
  // Layer 2 review flagged that the existing test suite caps at ~1k
  // events and never exercises the COMPACT_BATCH_THRESHOLD=1024
  // splice path inside `#compactFront`. These tests force it by
  // pushing >2000 events with per-event eviction, then verify
  // reducer outputs stay consistent across the compaction boundary.

  it('non-partitioned: reducer state survives periodic compaction', () => {
    const live = makeLive();
    // Tight 1ms timestamps, 50ms window → every push past the
    // first ~50 events evicts the front. Pushing 3000 events
    // crosses COMPACT_BATCH_THRESHOLD multiple times.
    const fused = live.rolling({
      '50ms': { cpu_avg: { from: 'cpu', using: 'avg' } },
    });

    const N = 3000;
    for (let i = 0; i < N; i++) {
      live.push([i, i, 'a']);
    }

    // Window is `ts >= latest - 50`; last event at ts=2999 keeps
    // ts in [2949, 2999] = 51 events. Avg = (2949+2999)/2 = 2974.
    const last = fused.at(N - 1)!;
    expect(last.get('cpu_avg')).toBeCloseTo(2974, 5);

    // Length matches input; output history wasn't corrupted by
    // compaction.
    expect(fused.length).toBe(N);
    fused.dispose();
  });

  it('non-partitioned: window snapshot during compaction is correct', () => {
    // Sample several intermediate snapshots across the run and
    // verify each matches the expected trailing-window average.
    const live = makeLive();
    const fused = live.rolling({
      '100ms': { cpu_avg: { from: 'cpu', using: 'avg' } },
    });

    const N = 5000;
    for (let i = 0; i < N; i++) {
      live.push([i, i, 'a']);
    }

    // Spot-check at indices that span the compaction boundary.
    for (const idx of [1500, 2500, 3500, 4500, 4999]) {
      const e = fused.at(idx)!;
      // 100ms window at event idx keeps `ts >= idx-100`, i.e.,
      // ts in [idx-100, idx] = 101 entries. Avg = (idx-100 + idx)/2
      // = idx - 50.
      expect(e.get('cpu_avg')).toBeCloseTo(idx - 50, 5);
    }

    fused.dispose();
  });

  it('partitioned: per-partition compaction stays consistent', () => {
    const live = new LiveSeries({
      name: 'metrics-compaction',
      schema: numericSchema,
    });
    const fused = live
      .partitionBy('host')
      .rolling(
        { '50ms': { cpu_avg: { from: 'cpu', using: 'avg' } } },
        { trigger: Trigger.every('100ms') },
      );

    // Two partitions, each receives 2000 events with per-event
    // eviction → both partitions exercise compaction independently.
    const N_PER = 2000;
    for (let i = 0; i < N_PER; i++) {
      // Interleave api-1 and api-2 at ms i and i+0.5 — both
      // share the same window cutoff dynamics.
      live.push([i, i, 'api-1']);
      live.push([i, i * 2, 'api-2']);
    }

    // Final boundary fires at trigger crossing. The last emit has
    // both partitions' state — verify the snapshots match the
    // trailing 50ms window on each partition.
    expect(fused.length).toBeGreaterThan(0);
    const last = fused.at(fused.length - 2)!;
    const second = fused.at(fused.length - 1)!;
    const byHost = new Map<string, number>();
    byHost.set(last.get('host') as string, last.get('cpu_avg') as number);
    byHost.set(second.get('host') as string, second.get('cpu_avg') as number);
    const a1 = byHost.get('api-1')!;
    const a2 = byHost.get('api-2')!;
    expect(a1).toBeGreaterThan(0);
    expect(a2).toBeGreaterThan(0);
    // api-2 receives 2× api-1's values at the same timestamps;
    // the running averages should match within rounding (the
    // partitioned variant evicts each partition independently
    // against the trigger boundary, so both share a window cutoff).
    // Tolerance of 1 absorbs any tiny boundary timing differences.
    expect(Math.abs(a2 - a1 * 2)).toBeLessThanOrEqual(1);

    fused.dispose();
  });

  it('LiveRollingAggregation: reducer state survives compaction', () => {
    // Same shape as the non-partitioned fused test, but for the
    // single-window class. Pre-v0.15.2 used the same shift pattern.
    const live = makeLive();
    const r = live.rolling('50ms', { cpu: 'avg' });

    const N = 3000;
    for (let i = 0; i < N; i++) {
      live.push([i, i, 'a']);
    }

    const last = r.at(N - 1)!;
    // Same window arithmetic as the fused-rolling test above:
    // ts in [2949, 2999], avg = 2974.
    expect(last.get('cpu')).toBeCloseTo(2974, 5);
    expect(r.length).toBe(N);
    r.dispose();
  });
});

// ── 6. Codex-flagged regressions ────────────────────────────────

describe('LiveFusedRolling — alias-name collision', () => {
  it('handles an AggregateOutputMap entry literally named "mapping"', () => {
    // Codex Layer 2 review flagged this: the elaborated wrapper
    // detection used `'mapping' in value` + `typeof value.mapping
    // === 'object'`. A user with an AggregateOutputMap that happens
    // to alias an output as `mapping` would be misinterpreted as
    // the elaborated wrapper. The disambiguation looks for
    // AggregateOutputSpec shape (`from` + `using`) on the
    // candidate `.mapping` field.
    const live = makeLive();
    const fused = live.rolling({
      '1m': {
        mapping: { from: 'cpu', using: 'avg' },
      },
    });

    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);

    expect(fused.at(1)!.get('mapping')).toBe(15);
    fused.dispose();
  });

  it('still recognises the elaborated wrapper on an inner-record mapping', () => {
    // The disambiguation only fires when `.mapping` is itself an
    // AggregateOutputSpec. The elaborated wrapper's `.mapping`
    // points at a record (containing column specs), so it's NOT a
    // spec and IS still detected as elaborated.
    const live = makeLive();
    const fused = live.rolling({
      '5s': {
        mapping: { cpu_avg: { from: 'cpu', using: 'avg' } },
        minSamples: 3,
      },
    });

    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);
    expect(fused.at(1)!.get('cpu_avg')).toBeUndefined(); // 2 < 3
    live.push([2000, 30, 'a']);
    expect(fused.at(2)!.get('cpu_avg')).toBe(20); // gate opens

    fused.dispose();
  });
});

describe('LivePartitionedView — chained fused rolling', () => {
  function makePartitionedLive() {
    return new LiveSeries({
      name: 'metrics-chained',
      schema: numericSchema,
    });
  }

  it('partitionBy(host).fill(...).rolling({...}, {trigger}) works (fused on chain)', () => {
    // Codex Layer 2 review flagged that LivePartitionedView.rolling
    // didn't accept the keyed-form. Without this fix, chained
    // partitioned pipelines couldn't use fused rolling at all.
    const schemaWithGaps = [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number', required: false },
      { name: 'host', kind: 'string' },
    ] as const;
    const live = new LiveSeries({
      name: 'metrics-chained-gaps',
      schema: schemaWithGaps,
    });

    const fused = live
      .partitionBy('host')
      .fill({ cpu: 'hold' })
      .rolling(
        {
          '5s': { cpu_avg: { from: 'cpu', using: 'avg' } },
          '1s': { cpu_max: { from: 'cpu', using: 'max' } },
        },
        { trigger: Trigger.every('1s') },
      );

    live.push([0, 10, 'api-1']);
    live.push([500, undefined, 'api-1']); // gap, fill'hold' carries 10
    live.push([1500, 20, 'api-1']); // crosses 1s boundary

    expect(fused.length).toBeGreaterThan(0);
    // At the boundary-crossing event, api-1's reducer state has
    // [10, 10, 20] from the fill chain. Snapshot at the boundary
    // should reflect that filled history.
    const e = fused.at(0)!;
    expect(e.get('host')).toBe('api-1');
    expect(typeof e.get('cpu_avg')).toBe('number');
    expect(typeof e.get('cpu_max')).toBe('number');

    fused.dispose();
  });

  it('chained fused requires clock trigger (event/count rejected)', () => {
    const live = makePartitionedLive();
    expect(() =>
      live
        .partitionBy('host')
        .fill({ cpu: 'hold' })
        .rolling(
          { '1m': { cpu: 'avg' } },
          { trigger: { kind: 'event' } as never },
        ),
    ).toThrow(/clock trigger/i);
  });
});

// ── 6. Sequence-anchored trigger sanity ────────────────────────

describe('LiveFusedRolling — trigger forms', () => {
  it('Trigger.clock(seq) is equivalent to Trigger.every(duration)', () => {
    const liveA = makeLive();
    const liveB = makeLive();
    const trigA = Trigger.every('500ms');
    const trigB = Trigger.clock(Sequence.every('500ms'));
    const fA = liveA.rolling(
      { '1s': { cpu_avg: { from: 'cpu', using: 'avg' } } },
      { trigger: trigA },
    );
    const fB = liveB.rolling(
      { '1s': { cpu_avg: { from: 'cpu', using: 'avg' } } },
      { trigger: trigB },
    );

    for (let t = 0; t < 5; t++) {
      const ts = t * 200;
      liveA.push([ts, t, 'a']);
      liveB.push([ts, t, 'a']);
    }

    expect(fA.length).toBe(fB.length);
    for (let i = 0; i < fA.length; i++) {
      expect(fA.at(i)!.begin()).toBe(fB.at(i)!.begin());
      expect(fA.at(i)!.get('cpu_avg')).toBe(fB.at(i)!.get('cpu_avg'));
    }

    fA.dispose();
    fB.dispose();
  });
});
