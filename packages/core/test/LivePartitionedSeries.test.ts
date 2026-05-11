import { describe, expect, it } from 'vitest';
import { LivePartitionedSeries, LiveSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number', required: false },
  { name: 'host', kind: 'string', required: false },
] as const;

function makeLive() {
  return new LiveSeries({ name: 'metrics', schema });
}

describe('LivePartitionedSeries', () => {
  describe('routing', () => {
    it('routes events to per-partition sub-buffers', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');

      // Source ordering 'strict' — push globally ordered by time;
      // partition view routes each to its host bucket.
      live.push([0, 0.5, 'a']);
      live.push([0, 0.3, 'b']);
      live.push([60_000, 0.6, 'a']);
      live.push([60_000, 0.4, 'b']);

      const m = partitioned.toMap();
      expect(m.size).toBe(2);
      expect(m.get('a')?.length).toBe(2);
      expect(m.get('b')?.length).toBe(2);
    });

    it('replays existing source events into partitions on construction', () => {
      const live = makeLive();
      live.push([0, 0.5, 'a']);
      live.push([60_000, 0.6, 'a']);

      // Construct partitioned view AFTER events were pushed
      const partitioned = live.partitionBy('host');
      const m = partitioned.toMap();
      expect(m.get('a')?.length).toBe(2);
    });

    it('auto-spawns a new partition the first time a value is seen', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');

      expect(partitioned.toMap().size).toBe(0);
      live.push([0, 0.5, 'a']);
      expect(partitioned.toMap().size).toBe(1);
      live.push([60_000, 0.4, 'b']);
      expect(partitioned.toMap().size).toBe(2);
    });

    it('treats undefined partition values via the leading-space sentinel', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');

      live.push([0, 0.5, undefined]); // missing host
      live.push([60_000, 0.6, 'a']);

      const m = partitioned.toMap();
      expect(m.size).toBe(2);
      expect(m.has(' undefined')).toBe(true);
      expect(m.has('a')).toBe(true);
    });
  });

  describe('declared groups', () => {
    it('eagerly spawns declared groups even before events arrive', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host', {
        groups: ['a', 'b'] as const,
      });
      const m = partitioned.toMap();
      expect(m.size).toBe(2);
      expect(m.get('a')?.length).toBe(0);
      expect(m.get('b')?.length).toBe(0);
    });

    it('throws on a partition value not in declared groups', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host', {
        groups: ['a', 'b'] as const,
      });
      expect(() => live.push([0, 0.5, 'rogue'])).toThrow(
        /not in declared groups/,
      );
      void partitioned;
    });

    it('throws on empty groups array', () => {
      const live = makeLive();
      expect(() => live.partitionBy('host', { groups: [] as const })).toThrow(
        /cannot be empty/,
      );
    });

    it('throws on duplicate values in groups', () => {
      const live = makeLive();
      expect(() =>
        live.partitionBy('host', { groups: ['a', 'b', 'a'] as const }),
      ).toThrow(/duplicate value "a"/);
    });
  });

  describe('per-partition retention', () => {
    it('each partition enforces its own maxEvents independently', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host', {
        retention: { maxEvents: 2 },
      });

      // Push more than 2 events for host 'a' — its sub-buffer caps at 2.
      live.push([0, 0.5, 'a']);
      live.push([60_000, 0.6, 'a']);
      live.push([120_000, 0.7, 'a']);
      live.push([180_000, 0.8, 'a']);

      // Push only 1 event for host 'b'. Its sub-buffer should still
      // have it — host 'a' didn't squeeze it out.
      live.push([240_000, 0.3, 'b']);

      const m = partitioned.toMap();
      expect(m.get('a')?.length).toBe(2); // capped
      expect(m.get('b')?.length).toBe(1); // independent
      // 'a' kept the latest two events (maxEvents evicts oldest)
      expect(m.get('a')?.first()?.begin()).toBe(120_000);
      expect(m.get('a')?.last()?.begin()).toBe(180_000);
    });
  });

  describe('per-partition grace window', () => {
    it('late events are accepted within their own partition grace', () => {
      // Source ordering 'reorder' to allow out-of-order pushes.
      // Each per-partition LiveSeries gets its own graceWindow.
      const live = new LiveSeries({
        name: 'metrics',
        schema,
        ordering: 'reorder',
        graceWindow: '10m',
      });
      const partitioned = live.partitionBy('host', {
        ordering: 'reorder',
        graceWindow: '10m',
      });

      live.push([0, 0.5, 'a']);
      live.push([60_000, 0.6, 'a']);
      live.push([120_000, 0.7, 'a']);
      // Late event for 'a' at t=30_000 — within grace
      live.push([30_000, 0.55, 'a']);

      const m = partitioned.toMap();
      const aEvents = m.get('a')!;
      // The reorder mode should have inserted the late event at its
      // proper position. 'a' has 4 events.
      expect(aEvents.length).toBe(4);
      const times = [];
      for (let i = 0; i < aEvents.length; i++)
        times.push(aEvents.at(i)!.begin());
      expect(times).toEqual([0, 30_000, 60_000, 120_000]);
    });

    it('per-host grace is independent: a late event for host_a does not affect host_b', () => {
      // Two hosts, each with its own per-partition grace window.
      // Push host_a far ahead, then a late host_b event whose
      // timestamp is older than host_a's latest. host_b's
      // partition has its own latest and grace, so the late
      // host_b event is NOT compared to host_a's timeline.
      const live = new LiveSeries({
        name: 'metrics',
        schema,
        ordering: 'reorder',
        graceWindow: '1h',
      });
      const partitioned = live.partitionBy('host', {
        ordering: 'reorder',
        graceWindow: '1h',
      });

      live.push([0, 0.3, 'b']);
      live.push([60_000, 0.4, 'b']);
      // host_a jumps ahead in time
      live.push([3_600_000, 5.0, 'a']);
      // Now a "late" event for host_b at t=120_000.
      // Globally that's 1h behind 'a'; per-partition for 'b' it's
      // only 60s after b's latest at 60_000. b's partition accepts.
      live.push([120_000, 0.5, 'b']);

      const m = partitioned.toMap();
      const bEvents = m.get('b')!;
      expect(bEvents.length).toBe(3); // [0, 60k, 120k]
      const bTimes = [];
      for (let i = 0; i < bEvents.length; i++)
        bTimes.push(bEvents.at(i)!.begin());
      expect(bTimes).toEqual([0, 60_000, 120_000]);
      // host_a's timeline unaffected
      expect(m.get('a')?.length).toBe(1);
    });
  });

  describe('default-inherit from source (ordering, graceWindow, retention)', () => {
    // Regression pins for the gRPC experiment M4 footgun: pre-fix,
    // partition sub-series defaulted to `'strict'` regardless of source,
    // so late events the source accepted under `'reorder'` then threw
    // in the partition's `#insert` with a confusing strict-mode error.
    // Now `partitionBy()` default-inherits `ordering`, `graceWindow`,
    // and `retention` from the source. Explicit options override.

    it('inherits ordering=reorder when source is reorder and partitionBy is bare', () => {
      const live = new LiveSeries({
        name: 'metrics',
        schema,
        ordering: 'reorder',
        graceWindow: '5m',
      });
      const partitioned = live.partitionBy('host'); // ← no options

      // The headline bug: late event past partition latest (within
      // grace) should be accepted, not throw.
      live.push([60_000, 0.5, 'a']);
      live.push([120_000, 0.6, 'a']);
      expect(() => live.push([30_000, 0.55, 'a'])).not.toThrow();

      const m = partitioned.toMap();
      const aEvents = m.get('a')!;
      expect(aEvents.length).toBe(3);
      const times = [];
      for (let i = 0; i < aEvents.length; i++)
        times.push(aEvents.at(i)!.begin());
      expect(times).toEqual([30_000, 60_000, 120_000]); // sorted
    });

    it('inherits graceWindow only when effective ordering is reorder', () => {
      const live = new LiveSeries({
        name: 'metrics',
        schema,
        ordering: 'reorder',
        graceWindow: '10m',
      });
      const partitioned = live.partitionBy('host');

      // Late event well within 10m grace — should accept.
      live.push([600_000, 0.5, 'a']);
      live.push([700_000, 0.6, 'a']);
      expect(() => live.push([150_000, 0.55, 'a'])).not.toThrow();

      // Event past grace — should reject. With 10m grace and latest
      // at 700_000, anything before 100_000 is past grace.
      expect(() => live.push([50_000, 0.5, 'a'])).toThrow(
        /grace window|out-of-order/i,
      );
    });

    it('inherits retention from source by default', () => {
      const live = new LiveSeries({
        name: 'metrics',
        schema,
        retention: { maxEvents: 3 },
      });
      const partitioned = live.partitionBy('host');

      // 5 events for host_a — source caps at 3, and the partition
      // sub-series should now also cap at 3 (inherited).
      for (let i = 0; i < 5; i++) live.push([i * 1000, i * 0.1, 'a']);

      const aEvents = partitioned.toMap().get('a')!;
      expect(aEvents.length).toBe(3); // last 3
    });

    it('explicit partitionBy options override inheritance', () => {
      const live = new LiveSeries({
        name: 'metrics',
        schema,
        ordering: 'reorder',
        graceWindow: '5m',
      });
      // Caller explicitly opts back to strict on partitions despite
      // source being reorder. Inheritance must NOT happen.
      const partitioned = live.partitionBy('host', { ordering: 'strict' });

      live.push([60_000, 0.5, 'a']);
      // Out-of-order push that the source would accept under reorder
      // — partition is strict so it throws inside the listener
      // fan-out (and the throw propagates to the source's push call).
      expect(() => live.push([30_000, 0.55, 'a'])).toThrow(/out-of-order/i);
      void partitioned;
    });

    it('does not inherit graceWindow when ordering is overridden to strict', () => {
      // Edge: source reorder + grace, but partitionBy overrides
      // ordering to strict. Inheriting graceWindow would be invalid
      // (LiveSeries rejects strict + graceWindow at construction).
      // The fix gates graceWindow inheritance on effective ordering.
      const live = new LiveSeries({
        name: 'metrics',
        schema,
        ordering: 'reorder',
        graceWindow: '5m',
      });
      expect(() =>
        live.partitionBy('host', { ordering: 'strict' }),
      ).not.toThrow();
    });

    it('strict source still produces strict partitions (no behavior change)', () => {
      const live = makeLive(); // strict by default
      const partitioned = live.partitionBy('host');

      live.push([60_000, 0.5, 'a']);
      // Out-of-order push — source rejects under strict
      expect(() => live.push([30_000, 0.55, 'a'])).toThrow(/out-of-order/i);
      void partitioned;
    });
  });

  describe('collect()', () => {
    it('inherits ordering / graceWindow / retention from the partitioned series', () => {
      // Pre-fix: collect() defaulted to strict regardless of the
      // source's ordering. Now it inherits the effective options
      // from the partitioned series (which inherits from source).
      const live = new LiveSeries({
        name: 'metrics',
        schema,
        ordering: 'reorder',
        graceWindow: '5m',
      });
      const partitioned = live.partitionBy('host');
      const unified = partitioned.collect();

      // Push events that arrive at the unified buffer out of order
      // across partitions. Under default-strict collect (pre-fix),
      // these would throw on the second-partition late arrival.
      live.push([60_000, 0.5, 'a']);
      live.push([90_000, 0.6, 'b']);
      // Late event on 'a' — earlier than the most-recently-collected
      // event from 'b'. Unified buffer must be in reorder mode.
      expect(() => live.push([30_000, 0.55, 'a'])).not.toThrow();
      expect(unified.length).toBe(3);
    });

    it('collects events from all partitions into a unified LiveSeries', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');
      const unified = partitioned.collect();

      const seen: Array<{ host: string; cpu: number }> = [];
      unified.on('event', (event) => {
        seen.push({
          host: event.get('host') as string,
          cpu: event.get('cpu') as number,
        });
      });

      live.push([0, 0.5, 'a']);
      live.push([0, 0.3, 'b']);
      live.push([60_000, 0.6, 'a']);
      live.push([60_000, 0.4, 'b']);

      expect(seen.length).toBe(4);
      expect(seen).toContainEqual({ host: 'a', cpu: 0.5 });
      expect(seen).toContainEqual({ host: 'b', cpu: 0.3 });
      expect(unified.length).toBe(4);
    });

    it('replays existing partition events into the unified buffer', () => {
      const live = makeLive();
      live.push([0, 0.5, 'a']);
      live.push([60_000, 0.6, 'a']);

      const partitioned = live.partitionBy('host');
      const unified = partitioned.collect();
      expect(unified.length).toBe(2);
    });

    it('subscribes to partitions spawned after collect()', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');
      const unified = partitioned.collect();

      // No partitions yet, then events arrive for 'a' and 'b'.
      live.push([0, 0.5, 'a']);
      live.push([60_000, 0.4, 'b']);

      expect(unified.length).toBe(2);
      const hosts = new Set([
        unified.first()?.get('host'),
        unified.last()?.get('host'),
      ]);
      expect(hosts).toEqual(new Set(['a', 'b']));
    });
  });

  describe('apply() — per-partition operator factory', () => {
    it('applies a fill chain per partition', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');
      const filled = partitioned.apply((sub) => sub.fill({ cpu: 'hold' }));

      // Globally ordered by time; interleave hosts at each timestamp.
      live.push([0, 0.5, 'a']);
      live.push([0, 0.3, 'b']);
      live.push([60_000, undefined, 'a']);
      live.push([60_000, undefined, 'b']);

      expect(filled.length).toBe(4);
      const events = [...filled.toTimeSeries().events];
      const aMid = events.find(
        (e) => e.begin() === 60_000 && e.get('host') === 'a',
      );
      const bMid = events.find(
        (e) => e.begin() === 60_000 && e.get('host') === 'b',
      );
      // Per-partition hold-fill: each host's undefined cpu is filled
      // from its own previous event (0.5 for 'a', 0.3 for 'b'),
      // not from the other host.
      expect(aMid?.get('cpu')).toBe(0.5);
      expect(bMid?.get('cpu')).toBe(0.3);
    });

    it('does NOT cross partition boundaries on hold-fill (hazard pinned)', () => {
      // The point of partitioning. Without per-partition scoping,
      // host 'b''s missing cpu at t=120k would hold from host 'a'@60k.
      const live = makeLive();

      // First: no partitioning — confirm the hazard would happen.
      const unscoped = live.fill({ cpu: 'hold' });
      live.push([0, 0.5, 'a']);
      live.push([60_000, 1.0, 'b']);
      live.push([120_000, undefined, 'a']);
      // Without partitioning, t=120k for 'a' would hold from b's 1.0.
      const aMidUnscoped = [...unscoped.toTimeSeries().events].find(
        (e) => e.begin() === 120_000,
      );
      expect(aMidUnscoped?.get('cpu')).toBe(1.0); // hazard

      // Now: with partitioning, t=120k for 'a' holds from a's own 0.5.
      const live2 = makeLive();
      const filled = live2
        .partitionBy('host')
        .apply((sub) => sub.fill({ cpu: 'hold' }));
      live2.push([0, 0.5, 'a']);
      live2.push([60_000, 1.0, 'b']);
      live2.push([120_000, undefined, 'a']);
      const aMidScoped = [...filled.toTimeSeries().events].find(
        (e) => e.begin() === 120_000 && e.get('host') === 'a',
      );
      expect(aMidScoped?.get('cpu')).toBe(0.5); // correct
    });

    it('chains multiple operators inside the factory (fill + diff)', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');
      const out = partitioned.apply((sub) =>
        sub.fill({ cpu: 'hold' }).diff('cpu'),
      );

      live.push([0, 0.5, 'a']);
      live.push([60_000, 0.7, 'a']);
      live.push([120_000, 0.9, 'a']);

      expect(out.length).toBe(3);
      // diff first event is undefined; subsequent are deltas
      const events = [...out.toTimeSeries().events];
      expect(events[0]?.get('cpu')).toBeUndefined();
      expect(events[1]?.get('cpu')).toBeCloseTo(0.2, 5);
      expect(events[2]?.get('cpu')).toBeCloseTo(0.2, 5);
    });

    it('applies the factory to partitions spawned after apply()', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');
      const filled = partitioned.apply((sub) => sub.fill({ cpu: 'hold' }));

      // No partitions when apply() ran; spawn 'b' mid-stream.
      // Globally ordered timestamps; 'b' first appears at t=60k.
      live.push([0, 0.5, 'a']);
      live.push([60_000, undefined, 'a']);
      live.push([60_000, 0.3, 'b']);
      live.push([120_000, undefined, 'b']);

      const events = [...filled.toTimeSeries().events];
      const bMid = events.find(
        (e) => e.begin() === 120_000 && e.get('host') === 'b',
      );
      expect(bMid?.get('cpu')).toBe(0.3); // 'b' got its own fill chain
    });
  });

  describe('dispose()', () => {
    it('unsubscribes from the source after dispose', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');

      live.push([0, 0.5, 'a']);
      expect(partitioned.toMap().get('a')?.length).toBe(1);

      partitioned.dispose();

      // Events pushed after dispose should not reach partitions.
      live.push([60_000, 0.6, 'a']);
      expect(partitioned.toMap().get('a')?.length).toBe(1); // unchanged
    });

    it('disconnects collect() unified series after dispose', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');
      const unified = partitioned.collect();

      live.push([0, 0.5, 'a']);
      expect(unified.length).toBe(1);

      partitioned.dispose();
      live.push([60_000, 0.6, 'a']);
      expect(unified.length).toBe(1); // unchanged
    });

    it('is safe to call multiple times', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');
      partitioned.dispose();
      expect(() => partitioned.dispose()).not.toThrow();
    });

    it('disconnects apply() output after dispose', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');
      const filled = partitioned.apply((sub) => sub.fill({ cpu: 'hold' }));

      live.push([0, 0.5, 'a']);
      live.push([60_000, undefined, 'a']);
      expect(filled.length).toBe(2);

      partitioned.dispose();
      // Events pushed after dispose should not propagate through
      // the partition routing or the apply() factory output.
      live.push([120_000, 0.7, 'a']);
      expect(filled.length).toBe(2); // unchanged
    });
  });

  describe('construction-time validation', () => {
    it('throws when source has events with values not in declared groups', () => {
      const live = makeLive();
      // Push events to source BEFORE constructing the partitioned view.
      live.push([0, 0.5, 'a']);
      live.push([60_000, 0.3, 'rogue']);
      // Constructor replays existing events through #routeEvent;
      // 'rogue' is not in declared groups → throws.
      expect(() =>
        live.partitionBy('host', { groups: ['a', 'b'] as const }),
      ).toThrow(/not in declared groups/);
    });
  });

  describe('apply() history replay (Codex finding 1)', () => {
    it('globally orders existing events when called after interleaved multi-partition history', () => {
      // Source has interleaved history: a@0, b@60k, a@120k.
      // apply() must replay existing factory-output events in
      // global time order (not per-partition order), or unified's
      // strict ordering throws on the second push.
      const live = makeLive();
      live.push([0, 0.5, 'a']);
      live.push([60_000, 0.3, 'b']);
      live.push([120_000, 0.6, 'a']);

      const partitioned = live.partitionBy('host');
      // Identity factory — output events are the partition's own.
      const unified = partitioned.apply((sub) => sub);

      expect(unified.length).toBe(3);
      const times = [];
      for (let i = 0; i < unified.length; i++)
        times.push(unified.at(i)!.begin());
      expect(times).toEqual([0, 60_000, 120_000]);
    });

    it('apply() with a transforming factory globally orders existing events', () => {
      // Same scenario but the factory transforms (fill).
      const live = makeLive();
      live.push([0, 0.5, 'a']);
      live.push([60_000, undefined, 'b']);
      live.push([120_000, 0.6, 'a']);

      const partitioned = live.partitionBy('host');
      const unified = partitioned.apply((sub) => sub.fill({ cpu: 'hold' }));

      expect(unified.length).toBe(3);
      const times = [];
      for (let i = 0; i < unified.length; i++)
        times.push(unified.at(i)!.begin());
      expect(times).toEqual([0, 60_000, 120_000]);
    });
  });

  describe('append-only fan-in (Codex finding 3, documented)', () => {
    // Per the v0.11 PR 1 design, collect()/apply() are fan-in sinks
    // — per-partition retention does NOT propagate to the unified
    // buffer. The unified buffer's own retention is independent.

    it('collect() retains events even after per-partition retention evicts them', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host', {
        retention: { maxEvents: 1 },
      });
      const unified = partitioned.collect();

      live.push([0, 0.5, 'a']);
      live.push([60_000, 0.6, 'a']);

      // Per-partition retention: 'a' has only 1 event left.
      expect(partitioned.toMap().get('a')?.length).toBe(1);
      // Unified is append-only: keeps both events.
      expect(unified.length).toBe(2);
    });

    it('apply() output retains events even after per-partition retention evicts them', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host', {
        retention: { maxEvents: 1 },
      });
      const unified = partitioned.apply((sub) => sub);

      live.push([0, 0.5, 'a']);
      live.push([60_000, 0.6, 'a']);

      expect(partitioned.toMap().get('a')?.length).toBe(1);
      expect(unified.length).toBe(2); // append-only
    });

    it('unified retention can be set independently via collect() options', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');
      // Source has no retention; unified has its own maxEvents: 2.
      const unified = partitioned.collect({ retention: { maxEvents: 2 } });

      live.push([0, 0.5, 'a']);
      live.push([60_000, 0.6, 'a']);
      live.push([120_000, 0.7, 'a']);

      // Per-partition keeps everything.
      expect(partitioned.toMap().get('a')?.length).toBe(3);
      // Unified obeys its own retention.
      expect(unified.length).toBe(2);
    });
  });

  describe('post-commit error semantics (Codex finding 2, documented)', () => {
    it('source state moves even when partition view rejects the event', () => {
      const live = makeLive();
      const _partitioned = live.partitionBy('host', {
        groups: ['a', 'b'] as const,
      });
      void _partitioned;

      expect(() => live.push([0, 0.5, 'rogue'])).toThrow(
        /not in declared groups/,
      );
      // Source already committed the event before the listener threw.
      // This is documented behavior; pin it so changes don't accidentally
      // create a different inconsistency.
      expect(live.length).toBe(1);
    });
  });

  describe('headline dashboard chain', () => {
    it('partitionBy + apply(fill + rolling) produces per-host smoothed values', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host');
      const smoothed = partitioned.apply((sub) =>
        sub.fill({ cpu: 'hold' }).rolling(10, { cpu: 'avg' }),
      );

      // Source ordering is 'strict' — push events globally in time
      // order. The partition view routes each to its host's
      // sub-buffer where rolling state is per-host.
      live.push([0, 0.4, 'a']);
      live.push([0, 1.0, 'b']);
      live.push([1, 0.5, 'a']);
      live.push([1, 1.1, 'b']);
      live.push([2, 0.6, 'a']);
      live.push([2, 1.2, 'b']);

      // The smoothed series has rolling-avg events from each host.
      // Host 'a' values average around 0.5; host 'b' around 1.1.
      expect(smoothed.length).toBeGreaterThan(0);
      // Sanity: events from both hosts present.
      const events = [...smoothed.toTimeSeries().events];
      const aSeen = events.some((e) => {
        const v = e.get('cpu') as number | undefined;
        return v !== undefined && v < 0.7;
      });
      const bSeen = events.some((e) => {
        const v = e.get('cpu') as number | undefined;
        return v !== undefined && v > 0.9;
      });
      expect(aSeen).toBe(true);
      expect(bSeen).toBe(true);
    });
  });

  describe('LivePartitionedSeries instance', () => {
    it('exposes name, schema, by, and groups', () => {
      const live = makeLive();
      const partitioned = live.partitionBy('host', {
        groups: ['a', 'b'] as const,
      });
      expect(partitioned.name).toBe('metrics');
      expect(partitioned.schema).toEqual(schema);
      expect(partitioned.by).toBe('host');
      expect(partitioned.groups).toEqual(['a', 'b']);
    });

    it('throws on a column not in the schema', () => {
      const live = makeLive();
      expect(() =>
        // @ts-expect-error invalid column
        live.partitionBy('not_a_column'),
      ).toThrow(/not in schema/);
    });

    it('also supports direct construction via new LivePartitionedSeries', () => {
      const live = makeLive();
      const partitioned = new LivePartitionedSeries(live, 'host');
      live.push([0, 0.5, 'a']);
      expect(partitioned.toMap().get('a')?.length).toBe(1);
    });
  });
});
