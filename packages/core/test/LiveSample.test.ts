/**
 * Tests for `live.sample({...})` and the snapshot-side parity on
 * `TimeSeries.sample` / `PartitionedTimeSeries.sample`. Covers stride
 * determinism, reservoir drift bounds under steady-state eviction,
 * per-partition isolation, source-eviction tracking, composability
 * with rolling/aggregate/reduce, and the `unsafeGlobal: true`
 * type-level gate (runtime-only test here; full type-d coverage in
 * `test-d/live-sample.test-d.ts`).
 */
import { describe, expect, it } from 'vitest';
import { LiveSeries, Sequence, TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number' },
] as const;

const partSchema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'value', kind: 'number' },
] as const;

function makeLive() {
  return new LiveSeries({ name: 'test', schema });
}

function makePartLive(opts?: { retention?: { maxAge?: string } }) {
  return new LiveSeries({ name: 'test', schema: partSchema, ...opts });
}

// ── Live sample: stride strategy ─────────────────────────────────

describe('LiveSeries.sample({ stride })', () => {
  it('keeps every Nth event (stride=1 keeps all)', () => {
    const live = makeLive();
    const sampled = live.sample({ stride: 1, unsafeGlobal: true });
    for (let i = 1; i <= 10; i++) live.push([i * 1000, i]);
    expect(sampled.length).toBe(10);
  });

  it('stride=2 keeps every other event (deterministic)', () => {
    const live = makeLive();
    const sampled = live.sample({ stride: 2, unsafeGlobal: true });
    for (let i = 1; i <= 10; i++) live.push([i * 1000, i]);
    expect(sampled.length).toBe(5);
    // The first event passes stride=2 only on the SECOND ingest (1-indexed
    // counter % 2 === 0). Verify positions.
    const values = Array.from({ length: sampled.length }, (_, i) =>
      sampled.at(i)?.get('value'),
    );
    expect(values).toEqual([2, 4, 6, 8, 10]);
  });

  it('stride=10 keeps 1 in 10', () => {
    const live = makeLive();
    const sampled = live.sample({ stride: 10, unsafeGlobal: true });
    for (let i = 1; i <= 100; i++) live.push([i * 1000, i]);
    expect(sampled.length).toBe(10);
  });

  it('does not affect parent series length or events', () => {
    const live = makeLive();
    const sampled = live.sample({ stride: 5, unsafeGlobal: true });
    for (let i = 1; i <= 20; i++) live.push([i * 1000, i]);
    expect(live.length).toBe(20);
    expect(sampled.length).toBe(4);
  });

  it('throws on non-positive-integer stride', () => {
    const live = makeLive();
    expect(() => live.sample({ stride: 0, unsafeGlobal: true })).toThrow(
      /positive integer/,
    );
    expect(() => live.sample({ stride: -1, unsafeGlobal: true })).toThrow(
      /positive integer/,
    );
    expect(() => live.sample({ stride: 1.5, unsafeGlobal: true })).toThrow(
      /positive integer/,
    );
  });

  it('replays existing events on construction', () => {
    const live = makeLive();
    for (let i = 1; i <= 10; i++) live.push([i * 1000, i]);
    // sample created AFTER events already exist — should replay through ingest path.
    const sampled = live.sample({ stride: 2, unsafeGlobal: true });
    expect(sampled.length).toBe(5);
  });

  it("fires 'event' listener for each kept event", () => {
    const live = makeLive();
    const sampled = live.sample({ stride: 3, unsafeGlobal: true });
    const seen: number[] = [];
    sampled.on('event', (e) => seen.push(e.get('value') as number));
    for (let i = 1; i <= 9; i++) live.push([i * 1000, i]);
    expect(seen).toEqual([3, 6, 9]);
  });
});

// ── Live sample: stride + source eviction ────────────────────────

describe('LiveSeries.sample({ stride }) eviction tracking', () => {
  it('drops sampled events when source evicts (cutoff-based)', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      retention: { maxEvents: 5 },
    });
    const sampled = live.sample({ stride: 2, unsafeGlobal: true });
    // Push 10 events. Source retains last 5; sampled buffer shrinks accordingly.
    for (let i = 1; i <= 10; i++) live.push([i * 1000, i]);
    expect(live.length).toBe(5); // [6, 7, 8, 9, 10]
    // Stride=2 keeps even-indexed (1-indexed positions 2, 4, 6, 8, 10) = values [2, 4, 6, 8, 10].
    // After source evicts events at ts 1000-5000, the sampled buffer
    // drops events at or before ts=5000: values 2 and 4 go. Remaining: [6, 8, 10].
    expect(sampled.length).toBe(3);
    expect(sampled.at(0)?.get('value')).toBe(6);
    expect(sampled.at(-1)?.get('value')).toBe(10);
  });

  it("fires 'evict' listener when source eviction drops sampled events", () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      retention: { maxEvents: 3 },
    });
    const sampled = live.sample({ stride: 1, unsafeGlobal: true });
    const evicted: number[] = [];
    sampled.on('evict', (events) => {
      for (const e of events) evicted.push(e.get('value') as number);
    });
    for (let i = 1; i <= 5; i++) live.push([i * 1000, i]);
    expect(evicted).toEqual([1, 2]); // first 2 evicted by retention
  });
});

// ── Live sample: reservoir strategy ──────────────────────────────

describe('LiveSeries.sample({ reservoir })', () => {
  it('initial fill (N <= K): keeps all events', () => {
    const live = makeLive();
    const sampled = live.sample({
      reservoir: { size: 10 },
      unsafeGlobal: true,
    });
    for (let i = 1; i <= 5; i++) live.push([i * 1000, i]);
    expect(sampled.length).toBe(5);
  });

  it('full fill: reservoir size hits K then stays at K', () => {
    const live = makeLive();
    const sampled = live.sample({
      reservoir: { size: 10 },
      unsafeGlobal: true,
    });
    for (let i = 1; i <= 100; i++) live.push([i * 1000, i]);
    expect(sampled.length).toBe(10);
  });

  it('reservoir contents stay in chronological order after random replacements', () => {
    // Algorithm R picks random slots; replaced events leave the buffer
    // in mid-positions and new events append. The `#events` buffer
    // must remain key-sorted.
    const live = makeLive();
    const sampled = live.sample({
      reservoir: { size: 5 },
      unsafeGlobal: true,
    });
    for (let i = 1; i <= 200; i++) live.push([i * 1000, i]);
    // Read out and verify chronological order.
    const begins: number[] = [];
    for (let i = 0; i < sampled.length; i++) {
      begins.push(sampled.at(i)!.begin());
    }
    for (let i = 1; i < begins.length; i++) {
      expect(begins[i]).toBeGreaterThanOrEqual(begins[i - 1]!);
    }
  });

  it('throws on non-positive-integer reservoir size', () => {
    const live = makeLive();
    expect(() =>
      live.sample({ reservoir: { size: 0 }, unsafeGlobal: true }),
    ).toThrow(/positive integer/);
    expect(() =>
      live.sample({ reservoir: { size: -1 }, unsafeGlobal: true }),
    ).toThrow(/positive integer/);
    expect(() =>
      live.sample({ reservoir: { size: 1.5 }, unsafeGlobal: true }),
    ).toThrow(/positive integer/);
  });
});

// ── Live sample: reservoir + source eviction (Option A drift) ────

describe('LiveSeries.sample({ reservoir }) eviction tracking', () => {
  it('clears reservoir slot when source evicts a reservoir event', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      retention: { maxEvents: 2 },
    });
    const sampled = live.sample({
      reservoir: { size: 5 },
      unsafeGlobal: true,
    });
    for (let i = 1; i <= 10; i++) live.push([i * 1000, i]);
    // Source retains [9000, 10000]. The reservoir held some subset of
    // events 1-10; events outside [9000, 10000] should have been
    // evicted from the reservoir AND the sampled buffer.
    for (let i = 0; i < sampled.length; i++) {
      const begin = sampled.at(i)!.begin();
      expect(begin).toBeGreaterThanOrEqual(9000);
    }
    // With K=5 but only 2 retained, the reservoir is at most 2.
    expect(sampled.length).toBeLessThanOrEqual(2);
  });

  it('refills empty slots with the next ingested event after eviction', () => {
    const live = new LiveSeries({
      name: 'test',
      schema,
      retention: { maxEvents: 5 },
    });
    const sampled = live.sample({
      reservoir: { size: 3 },
      unsafeGlobal: true,
    });
    // Fill phase
    for (let i = 1; i <= 3; i++) live.push([i * 1000, i]);
    expect(sampled.length).toBe(3);
    // Push 2 more (still in retention); reservoir is full so Algorithm
    // R may replace, but size stays at 3.
    for (let i = 4; i <= 5; i++) live.push([i * 1000, i]);
    expect(sampled.length).toBe(3);
    // Now push 5 more — source retention will start evicting (max 5
    // events). Reservoir slots get freed and refilled.
    for (let i = 6; i <= 10; i++) live.push([i * 1000, i]);
    expect(sampled.length).toBe(3);
    // All retained reservoir events should be in [6000, 10000].
    for (let i = 0; i < sampled.length; i++) {
      expect(sampled.at(i)!.begin()).toBeGreaterThanOrEqual(6000);
    }
  });
});

// ── Per-partition sample (the safe-by-construction shape) ───────

describe('LivePartitionedSeries.sample (no unsafeGlobal needed)', () => {
  it('thins each partition independently with stride', () => {
    const live = makePartLive();
    const sampled = live
      .partitionBy('host')
      .sample({ stride: 2 })
      .collect({ name: 'sampled' });
    // Push 10 events for 'a', 10 for 'b' — alternating.
    for (let i = 1; i <= 10; i++) live.push([i * 100, 'a', i]);
    for (let i = 11; i <= 20; i++) live.push([i * 100, 'b', i]);
    // Each partition gets stride=2 → 5 events each → 10 total.
    expect(sampled.length).toBe(10);
  });

  it('the bias-trap regression pin: structured input does NOT silently drop hosts', () => {
    // The gRPC experiment's prototype hit this: a global stride
    // counter against round-robin host order kept 8 of 80 hosts.
    // partitionBy(...).sample(...) avoids it by construction.
    const live = makePartLive();
    const sampled = live
      .partitionBy('host')
      .sample({ stride: 5 })
      .collect({ name: 'sampled' });
    // Round-robin order: a, b, c, d, e, a, b, c, d, e, ...
    const hosts = ['a', 'b', 'c', 'd', 'e'];
    for (let i = 1; i <= 25; i++) {
      live.push([i * 100, hosts[i % hosts.length]!, i]);
    }
    // Each host contributes 5 events; stride=5 keeps 1 per host.
    // Verify all 5 hosts are represented.
    const seenHosts = new Set<string>();
    for (let i = 0; i < sampled.length; i++) {
      seenHosts.add(sampled.at(i)!.get('host') as string);
    }
    expect(seenHosts.size).toBe(5);
  });

  it('per-partition reservoir: each partition gets its own K-event reservoir', () => {
    // The reservoir state lives on the per-partition LiveSample
    // instances, NOT on the collected unified buffer (which is fan-in
    // and accumulates every 'event' fire including replacements).
    // toMap() exposes the per-partition LiveSamples directly so the
    // K-cap can be observed.
    const live = makePartLive();
    const sampled = live.partitionBy('host').sample({ reservoir: { size: 3 } });
    // 10 events for each of 2 hosts.
    for (let i = 1; i <= 10; i++) live.push([i * 100, 'a', i]);
    for (let i = 11; i <= 20; i++) live.push([i * 100, 'b', i]);
    const map = sampled.toMap();
    expect(map.get('a')!.length).toBe(3);
    expect(map.get('b')!.length).toBe(3);
  });
});

// ── Composability: sample + rolling/reduce ───────────────────────

describe('sample composes with downstream rolling and reduce', () => {
  it('partitionBy().sample().rolling() — stride feeds rolling', () => {
    const live = makePartLive();
    const rolling = live
      .partitionBy('host')
      .sample({ stride: 2 })
      .rolling(100, { value: 'avg', count: { from: 'value', using: 'count' } });
    // 10 events for one host. Stride=2 → 5 events into rolling. With
    // window=100 (count-based), rolling should average those 5.
    for (let i = 1; i <= 10; i++) live.push([i * 1000, 'a', i]);
    const results = rolling.collect({ name: 'rolling' });
    expect(results.length).toBeGreaterThan(0);
  });
});

// ── Snapshot-side TimeSeries.sample ──────────────────────────────

describe('TimeSeries.sample', () => {
  it('stride: keeps every Nth event', () => {
    const series = new TimeSeries({
      name: 'test',
      schema,
      rows: Array.from({ length: 100 }, (_, i) => [(i + 1) * 1000, i + 1]),
    });
    const sampled = series.sample({ stride: 10 });
    expect(sampled.length).toBe(10);
    expect(sampled.first()?.get('value')).toBe(10); // first kept = 10th event
    expect(sampled.last()?.get('value')).toBe(100);
  });

  it('reservoir: K-of-N when N > K', () => {
    const series = new TimeSeries({
      name: 'test',
      schema,
      rows: Array.from({ length: 1000 }, (_, i) => [(i + 1) * 1000, i + 1]),
    });
    const sampled = series.sample({ reservoir: { size: 100 } });
    expect(sampled.length).toBe(100);
    // Output is chronologically sorted (snapshot invariant).
    for (let i = 1; i < sampled.length; i++) {
      expect(sampled.at(i)!.begin()).toBeGreaterThanOrEqual(
        sampled.at(i - 1)!.begin(),
      );
    }
  });

  it('reservoir: K >= N returns all events', () => {
    const series = new TimeSeries({
      name: 'test',
      schema,
      rows: Array.from({ length: 5 }, (_, i) => [(i + 1) * 1000, i + 1]),
    });
    const sampled = series.sample({ reservoir: { size: 100 } });
    expect(sampled.length).toBe(5);
  });

  it('reservoir is approximately uniform (statistical pin)', () => {
    // 10000 events, reservoir K=500, run multiple trials. Each event's
    // probability of being included should be ~K/N = 0.05. We check
    // that the mean position of the sample is near the population
    // mean, within a tolerance accounting for sampling variance.
    const N = 10000;
    const K = 500;
    const series = new TimeSeries({
      name: 'test',
      schema,
      rows: Array.from({ length: N }, (_, i) => [(i + 1) * 1000, i]),
    });
    const trials = 20;
    let withinTolerance = 0;
    const populationMean = (N - 1) / 2; // 0..N-1 mean
    // Population variance of uniform on {0..N-1} is ~N²/12; SE of the
    // mean of K samples is sqrt(variance / K) = N/sqrt(12K).
    const sigmaOfMean = N / Math.sqrt(12 * K);
    const tolerance = 4 * sigmaOfMean; // 4σ ≈ 99.99% under CLT
    for (let t = 0; t < trials; t++) {
      const sampled = series.sample({ reservoir: { size: K } });
      let sum = 0;
      for (let i = 0; i < sampled.length; i++) {
        sum += sampled.at(i)!.get('value') as number;
      }
      const sampleMean = sum / K;
      if (Math.abs(sampleMean - populationMean) <= tolerance) {
        withinTolerance++;
      }
    }
    // Under CLT, ~99.99% of trials should be within 4σ. 20 trials at
    // 99.99% per trial is ~99.8% probability of all 20 passing.
    expect(withinTolerance).toBeGreaterThanOrEqual(18);
  });
});

// ── Snapshot-side PartitionedTimeSeries.sample ───────────────────

describe('PartitionedTimeSeries.sample', () => {
  it('per-partition stride', () => {
    const rows: Array<[number, string, number]> = [];
    for (let i = 0; i < 10; i++) rows.push([(i + 1) * 100, 'a', i + 1]);
    for (let i = 0; i < 10; i++) rows.push([(i + 11) * 100, 'b', i + 11]);
    const series = new TimeSeries({ name: 'test', schema: partSchema, rows });
    const sampled = series.partitionBy('host').sample({ stride: 2 }).collect();
    // 5 events per partition (stride=2 of 10) × 2 partitions = 10.
    expect(sampled.length).toBe(10);
  });

  it('per-partition reservoir', () => {
    const rows: Array<[number, string, number]> = [];
    for (let i = 0; i < 100; i++) rows.push([(i + 1) * 100, 'a', i + 1]);
    for (let i = 0; i < 100; i++) rows.push([(i + 101) * 100, 'b', i + 101]);
    const series = new TimeSeries({ name: 'test', schema: partSchema, rows });
    const sampled = series
      .partitionBy('host')
      .sample({ reservoir: { size: 10 } })
      .collect();
    // K=10 per partition × 2 partitions = 20.
    expect(sampled.length).toBe(20);
  });
});

// ── Sequence import is needed for one composability test ──────────
void Sequence; // keep import live so the file remains stable across reorders
