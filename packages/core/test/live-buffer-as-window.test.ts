/**
 * Tests for buffer-as-window Tier 1 — `LiveSeries.reduce(mapping)`,
 * `LiveSeries.timeRange()`, and `LiveSeries.eventRate()`.
 *
 * Design: PLAN.md "Queued: live API parity for the buffer-as-window
 * persona." The metric agent's pattern was
 * `live.rolling(RETENTION, mapping, opts)` — a workaround for the
 * absence of a streaming reduce-over-the-buffer primitive. This
 * suite pins the new direct API.
 */
import { describe, expect, it } from 'vitest';
import { LiveSeries, Trigger } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function makeLive() {
  return new LiveSeries({ name: 'metrics', schema });
}

/**
 * `LiveReduce` defers trigger fires to a `queueMicrotask` so the
 * snapshot reflects the post-retention buffer state. Tests that
 * inspect emitted output (`r.length`, `r.at(i)`, listener payloads)
 * must yield to microtasks first.
 *
 * `r.value()` reads reducer state synchronously and doesn't need
 * the flush.
 */
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

// ── LiveSeries.reduce — full-window streaming reduce ────────────

describe('LiveSeries.reduce — basic semantics', () => {
  it('emits one event per single-row push under the default trigger', async () => {
    const live = makeLive();
    const r = live.reduce({
      cpu: 'avg',
      count: { from: 'cpu', using: 'count' },
    });

    live.push([0, 10, 'a']);
    await flush();
    live.push([1000, 20, 'a']);
    await flush();
    live.push([2000, 30, 'a']);
    await flush();

    expect(r.length).toBe(3);
    expect(r.at(0)!.get('cpu')).toBe(10);
    expect(r.at(0)!.get('count')).toBe(1);
    expect(r.at(1)!.get('cpu')).toBe(15); // (10+20)/2
    expect(r.at(1)!.get('count')).toBe(2);
    expect(r.at(2)!.get('cpu')).toBe(20); // (10+20+30)/3
    expect(r.at(2)!.get('count')).toBe(3);

    r.dispose();
  });

  it('pushMany of K rows fires ONE deferred emission, not K', async () => {
    const live = makeLive();
    const r = live.reduce({ count: { from: 'cpu', using: 'count' } });

    live.pushMany([
      [0, 10, 'a'],
      [1000, 20, 'a'],
      [2000, 30, 'a'],
    ]);
    await flush();

    expect(r.length).toBe(1);
    expect(r.at(0)!.get('count')).toBe(3);

    r.dispose();
  });

  it('emission is post-retention (Codex regression pin)', async () => {
    // Pre-fix: emit fired during 'event', BEFORE retention applied.
    // With maxEvents:2, the third push emitted count=3 even though
    // the buffer has 2 events post-retention. Microtask defer
    // fixes this.
    const live = new LiveSeries({
      name: 'r',
      schema,
      retention: { maxEvents: 2 },
    });
    const r = live.reduce({ count: { from: 'cpu', using: 'count' } });

    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);
    live.push([2000, 30, 'a']); // triggers eviction of event 0
    await flush();

    // Post-retention emit reflects the 2-event buffer, not 3.
    const last = r.at(r.length - 1)!;
    expect(last.get('count')).toBe(2);
    expect(r.value().count).toBe(2);
    r.dispose();
  });

  it('value() returns the current snapshot without an emit', () => {
    const live = makeLive();
    const r = live.reduce({ cpu: 'avg' });

    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);

    expect(r.value().cpu).toBe(15);
    r.dispose();
  });

  it('replays the existing buffer at construction', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);

    // Construct AFTER pushes — should pick up existing buffer.
    const r = live.reduce({ cpu: 'avg' });
    expect(r.value().cpu).toBe(15);

    // Subsequent pushes flow through.
    live.push([2000, 30, 'a']);
    expect(r.value().cpu).toBe(20);

    r.dispose();
  });

  it('replay emits ONE deferred event after construction', async () => {
    // With deferred microtask emit (Codex regression fix), the
    // construction-time replay of N existing events fires the
    // trigger once, not N times. Reducer state reflects all
    // replayed events; only the emit-event fires are deduplicated.
    const live = makeLive();
    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);
    live.push([2000, 30, 'a']);

    const r = live.reduce({ cpu: 'avg' });
    await flush();
    expect(r.length).toBe(1);
    expect(r.at(0)!.get('cpu')).toBe(20); // (10+20+30)/3

    r.dispose();
  });

  it('removes from reducer state when source evicts (retention)', () => {
    const live = new LiveSeries({
      name: 'with-retention',
      schema,
      retention: { maxEvents: 2 },
    });
    const r = live.reduce({
      cpu: 'avg',
      count: { from: 'cpu', using: 'count' },
    });

    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);
    expect(r.value().cpu).toBe(15);
    expect(r.value().count).toBe(2);

    // Third push triggers eviction of the first event.
    live.push([2000, 30, 'a']);
    expect(r.value().cpu).toBe(25); // (20 + 30) / 2
    expect(r.value().count).toBe(2);

    r.dispose();
  });

  it('handles maxAge retention', () => {
    const live = new LiveSeries({
      name: 'with-maxage',
      schema,
      retention: { maxAge: '5s' },
    });
    const r = live.reduce({ count: { from: 'cpu', using: 'count' } });

    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);
    // Push at 7000 — events at 0 and 1000 are both > 5s old → evicted.
    live.push([7000, 30, 'a']);
    expect(r.value().count).toBe(1); // only the last event remains

    r.dispose();
  });

  it('AggregateOutputMap form names output columns', () => {
    const live = makeLive();
    const r = live.reduce({
      cpu_avg: { from: 'cpu', using: 'avg' },
      cpu_max: { from: 'cpu', using: 'max' },
      n: { from: 'cpu', using: 'count' },
    });

    live.push([0, 10, 'a']);
    live.push([1000, 50, 'a']);
    live.push([2000, 30, 'a']);

    expect(r.value().cpu_avg).toBe(30);
    expect(r.value().cpu_max).toBe(50);
    expect(r.value().n).toBe(3);

    r.dispose();
  });

  it('output schema has the source first column + reducer columns', () => {
    const live = makeLive();
    const r = live.reduce({
      cpu_avg: { from: 'cpu', using: 'avg' },
      cpu_max: { from: 'cpu', using: 'max' },
    });

    expect(r.schema[0]?.name).toBe('time');
    expect(r.schema[0]?.kind).toBe('time');
    const valueColumns = r.schema.slice(1).map((c) => c?.name);
    expect(valueColumns).toEqual(['cpu_avg', 'cpu_max']);

    r.dispose();
  });
});

describe('LiveSeries.reduce — eviction slot resolution (PR #170 regression)', () => {
  // The reducer removes an evicted event's contribution by its
  // arrival-assigned slot index. Resolving the evicted event back to
  // that slot uses object identity for the `Event[]` backing (the
  // SAME object is re-handed on evict — the only correct path for
  // `reorder`, where eviction order ≠ arrival order), falling back to
  // the FIFO frontier only for the chunked backing's freshly
  // materialized evictions (append-only → oldest-first → FIFO exact).
  //
  // The bug Codex caught: a pure-FIFO resolution removed the
  // oldest-ARRIVED slot for every source — wrong for `reorder`, whose
  // sorted-prefix eviction can drop a later arrival. The fix restores
  // identity-primary, matching main's pre-chunked behavior on the
  // array backing while keeping the chunked path correct.
  //
  // NOTE on `reorder` + retention: the *value-based* reducers
  // (`avg`/`sum`/`count`/`median`/`percentile`/`stdev`/`unique`)
  // remove by value and are correct regardless of eviction order — the
  // guarantee pinned here. The *windowed* reducers
  // (`min`/`max`/`first`/`last`/`samples`) use forward-sliding-window
  // state (monotone deque / head-removal ordered entries) that assumes
  // monotonic oldest-by-arrival eviction; `reorder`'s sorted-prefix
  // eviction violates that, so they are NOT reliable for
  // `reorder` + retention. That is a pre-existing limitation (true on
  // main before the chunked work) and is documented in `LiveReduce`'s
  // class JSDoc — see PLAN.md "Deferred". This PR neither introduces
  // nor fixes it.

  it('reorder + retention: value-based reducers track the retained window', () => {
    // Arrivals 30, 20, 10 (descending time); maxEvents:2 evicts the
    // sorted-oldest (1000→10) immediately on its own insert. Retained
    // buffer is {2000→20, 3000→30}. The evicted event's value (10) is
    // removed from value-based state regardless of which slot index the
    // resolver picks, so these stay correct under the fix.
    const live = new LiveSeries({
      name: 'reorder-value-based',
      schema,
      ordering: 'reorder',
      retention: { maxEvents: 2 },
    });
    const r = live.reduce({
      mean: { from: 'cpu', using: 'avg' },
      n: { from: 'cpu', using: 'count' },
      mid: { from: 'cpu', using: 'median' },
    });

    live.push([3000, 30, 'a']); // arrival 0
    live.push([2000, 20, 'a']); // arrival 1
    live.push([1000, 10, 'a']); // arrival 2 → evicts sorted-oldest (10)

    expect(r.value().mean).toBe(25); // (20 + 30) / 2
    expect(r.value().n).toBe(2);
    expect(r.value().mid).toBe(25); // median of {20, 30}

    r.dispose();
  });

  it('chunked source: eviction across the replay→forward boundary keeps min correct', () => {
    // A reduce over a non-empty chunked source replays the buffered
    // events (materialized + cached → identity HITS on evict). Forward
    // events are transient (identity MISSES → FIFO fallback). As
    // retention evicts past the last replayed event into the forward
    // events, the FIFO frontier must already be advanced past the hits
    // — otherwise the first miss removes an already-removed slot and
    // min corrupts. (Top-level strict+time auto-selects chunked.)
    const live = new LiveSeries({
      name: 'chunked-boundary',
      schema,
      retention: { maxEvents: 3 },
    });
    live.push([0, 50, 'a']);
    live.push([1000, 40, 'a']);
    live.push([2000, 30, 'a']);

    const r = live.reduce({ lo: { from: 'cpu', using: 'min' } });
    expect(r.value().lo).toBe(30); // over replayed {50,40,30}

    live.push([3000, 20, 'a']); // evicts replayed 50 (hit) → {40,30,20}
    expect(r.value().lo).toBe(20);
    live.push([4000, 10, 'a']); // evicts replayed 40 (hit) → {30,20,10}
    expect(r.value().lo).toBe(10);
    live.push([5000, 5, 'a']); // evicts replayed 30 (hit) → {20,10,5}
    expect(r.value().lo).toBe(5);
    live.push([6000, 100, 'a']); // evicts FIRST forward (miss → FIFO) → {10,5,100}
    expect(r.value().lo).toBe(5);
    live.push([7000, 1, 'a']); // evicts forward (miss) → {5,100,1}
    expect(r.value().lo).toBe(1);

    r.dispose();
  });
});

describe('LiveSeries.reduce — triggers', () => {
  it('Trigger.every emits at clock boundaries', async () => {
    const live = makeLive();
    const r = live.reduce(
      { cpu_avg: { from: 'cpu', using: 'avg' } },
      { trigger: Trigger.every('1s') },
    );

    // First event establishes starting bucket; no emission.
    live.push([0, 10, 'a']);
    await flush();
    expect(r.length).toBe(0);

    // Crosses 1s boundary; emit one event at boundary 1000.
    live.push([1500, 20, 'a']);
    await flush();
    expect(r.length).toBe(1);
    expect(r.at(0)!.begin()).toBe(1000);
    expect(r.at(0)!.get('cpu_avg')).toBe(15);

    r.dispose();
  });

  it('Trigger.count(n) emits every n source events', async () => {
    const live = makeLive();
    const r = live.reduce(
      { cpu_avg: { from: 'cpu', using: 'avg' } },
      { trigger: Trigger.count(3) },
    );

    live.push([0, 10, 'a']);
    live.push([1000, 20, 'a']);
    await flush();
    expect(r.length).toBe(0); // 2 < 3

    live.push([2000, 30, 'a']);
    await flush();
    expect(r.length).toBe(1);
    expect(r.at(0)!.get('cpu_avg')).toBe(20);

    live.push([3000, 40, 'a']);
    live.push([4000, 50, 'a']);
    await flush();
    expect(r.length).toBe(1);

    live.push([5000, 60, 'a']);
    await flush();
    expect(r.length).toBe(2);
    expect(r.at(1)!.get('cpu_avg')).toBe(35); // (10+20+30+40+50+60)/6

    r.dispose();
  });

  it('Trigger.count(n) drains multiple emits per pushMany', async () => {
    // pushMany of K rows where K > n: should emit floor(K/n)
    // times in the deferred microtask flush.
    const live = makeLive();
    const r = live.reduce(
      { cpu_avg: { from: 'cpu', using: 'avg' } },
      { trigger: Trigger.count(2) },
    );

    live.pushMany([
      [0, 10, 'a'],
      [1000, 20, 'a'],
      [2000, 30, 'a'],
      [3000, 40, 'a'],
      [4000, 50, 'a'],
    ]);
    await flush();

    // 5 events / count(2) = 2 emits (4 events accounted for, 1 left in counter).
    expect(r.length).toBe(2);

    r.dispose();
  });
});

describe('LiveSeries.reduce — composition', () => {
  it('composes from a LiveView (filter then reduce)', () => {
    const live = makeLive();
    const filtered = live.filter((e) => e.get('host') === 'api-1');
    const r = filtered.reduce({ count: { from: 'cpu', using: 'count' } });

    live.push([0, 10, 'api-1']);
    live.push([1000, 20, 'api-2']); // filtered out
    live.push([2000, 30, 'api-1']);

    expect(r.value().count).toBe(2); // only api-1 events

    r.dispose();
  });

  it('subscribers fire on every emit', async () => {
    const live = makeLive();
    const r = live.reduce({ cpu_avg: { from: 'cpu', using: 'avg' } });

    const seen: number[] = [];
    const unsub = r.on('event', (e: any) => {
      seen.push(e.get('cpu_avg'));
    });

    live.push([0, 10, 'a']);
    await flush();
    live.push([1000, 20, 'a']);
    await flush();
    live.push([2000, 30, 'a']);
    await flush();

    expect(seen).toEqual([10, 15, 20]);
    unsub();
    r.dispose();
  });

  it('dispose detaches from source', async () => {
    const live = makeLive();
    const r = live.reduce({ cpu_avg: { from: 'cpu', using: 'avg' } });

    live.push([0, 10, 'a']);
    await flush();
    expect(r.length).toBe(1);

    r.dispose();
    live.push([1000, 20, 'a']);
    await flush();
    expect(r.length).toBe(1); // no growth after dispose
  });
});

// ── LiveSeries.timeRange ────────────────────────────────────────

describe('LiveSeries.timeRange', () => {
  it('returns 0 for an empty buffer', () => {
    expect(makeLive().timeRange()).toBe(0);
  });

  it('returns 0 for a single event (no span)', () => {
    const live = makeLive();
    live.push([1000, 10, 'a']);
    expect(live.timeRange()).toBe(0);
  });

  it('returns last.begin() - first.begin()', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    live.push([5000, 20, 'a']);
    expect(live.timeRange()).toBe(5000);
  });

  it('updates as the buffer grows', () => {
    const live = makeLive();
    live.push([0, 10, 'a']);
    live.push([3000, 20, 'a']);
    expect(live.timeRange()).toBe(3000);
    live.push([10000, 30, 'a']);
    expect(live.timeRange()).toBe(10000);
  });

  it('reflects retention-bounded span', () => {
    const live = new LiveSeries({
      name: 'r',
      schema,
      retention: { maxEvents: 2 },
    });
    live.push([0, 10, 'a']);
    live.push([5000, 20, 'a']);
    expect(live.timeRange()).toBe(5000);
    // Third event evicts the first; span is now between 5000 and 10000.
    live.push([10000, 30, 'a']);
    expect(live.timeRange()).toBe(5000);
  });
});

// ── LiveSeries.eventRate ────────────────────────────────────────

describe('LiveSeries.eventRate', () => {
  it('returns 0 for an empty buffer', () => {
    expect(makeLive().eventRate()).toBe(0);
  });

  it('returns 0 for a single event (no span to divide by)', () => {
    const live = makeLive();
    live.push([1000, 10, 'a']);
    expect(live.eventRate()).toBe(0);
  });

  it('computes events / (span in seconds)', () => {
    const live = makeLive();
    // 5 events spanning 5000ms (5s) → rate = 5 / 5 = 1 evt/s.
    live.push([0, 10, 'a']);
    live.push([1000, 11, 'a']);
    live.push([2500, 12, 'a']);
    live.push([3500, 13, 'a']);
    live.push([5000, 14, 'a']);
    expect(live.eventRate()).toBe(1);
  });

  it('handles fractional rates', () => {
    const live = makeLive();
    // 3 events spanning 1000ms → rate = 3 evt / 1s = 3 evt/s.
    live.push([0, 10, 'a']);
    live.push([500, 11, 'a']);
    live.push([1000, 12, 'a']);
    expect(live.eventRate()).toBe(3);
  });
});
