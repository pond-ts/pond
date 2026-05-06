/**
 * Type-level tests for `stats()` visibility across all live classes.
 * Specifically pins that partitioned rolling overloads return
 * concrete classes (not bare `LiveSource<...>`) so callers can
 * invoke `stats()` without a cast — Codex's PR #123 HIGH finding.
 */
import { LiveSeries, Sequence, Trigger } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

const live = new LiveSeries({ name: 'metrics', schema });

// ── LiveSeries.stats ────────────────────────────────────────────

const liveStats = live.stats();
const _ingested: number = liveStats.ingested;
const _evicted: number = liveStats.evicted;
const _rejected: number = liveStats.rejected;
const _length: number = liveStats.length;
const _earliestTs: number | undefined = liveStats.earliestTs;
const _latestTs: number | undefined = liveStats.latestTs;
void _ingested;
void _evicted;
void _rejected;
void _length;
void _earliestTs;
void _latestTs;

// ── LiveRollingAggregation.stats ────────────────────────────────

const rolling = live.rolling(3, { cpu: 'avg' });
const rollingStats = rolling.stats();
const _eo1: number = rollingStats.eventsObserved;
const _ev1: number = rollingStats.evictions;
const _em1: number = rollingStats.emissions;
const _ws1: number = rollingStats.windowSize;
void _eo1;
void _ev1;
void _em1;
void _ws1;

// ── LiveFusedRolling.stats ──────────────────────────────────────

const fused = live.rolling({ '1m': { cpu: 'avg' } });
const fusedStats = fused.stats();
const _eo2: number = fusedStats.eventsObserved;
const _ev2: number = fusedStats.evictions;
const _em2: number = fusedStats.emissions;
const _ws2: number = fusedStats.windowSize;
const _wc2: number = fusedStats.windowsCount;
void _eo2;
void _ev2;
void _em2;
void _ws2;
void _wc2;

// ── LiveAggregation.stats ───────────────────────────────────────

const agg = live.aggregate(Sequence.every('1s'), { cpu: 'avg' });
const aggStats = agg.stats();
const _eo3: number = aggStats.eventsObserved;
const _bc3: number = aggStats.bucketsClosed;
const _ob3: number = aggStats.openBuckets;
const _obs3: number | undefined = aggStats.openBucketStart;
void _eo3;
void _bc3;
void _ob3;
void _obs3;

// ── LiveReduce.stats ────────────────────────────────────────────

const reduced = live.reduce({ cpu: 'avg' });
const reducedStats = reduced.stats();
const _eo4: number = reducedStats.eventsObserved;
const _ev4: number = reducedStats.evictions;
const _em4: number = reducedStats.emissions;
const _bs4: number = reducedStats.bufferSize;
void _eo4;
void _ev4;
void _em4;
void _bs4;

// ── LivePartitionedSeries.stats ─────────────────────────────────

const byHost = live.partitionBy('host');
const byHostStats = byHost.stats();
const _p5: number = byHostStats.partitions;
const _er5: number = byHostStats.eventsRouted;
void _p5;
void _er5;

// ── LivePartitionedSyncRolling.stats (Codex HIGH regression pin) ─
//
// The clock-trigger overload on `LivePartitionedSeries.rolling`
// previously returned a bare `LiveSource<...>`, which doesn't
// expose `stats()`. Callers had to cast. The return type is now
// the concrete `LivePartitionedSyncRolling`, so `stats()` is
// directly callable.

const sync = live
  .partitionBy('host')
  .rolling('5s', { cpu: 'avg' }, { trigger: Trigger.every('1s') });
const syncStats = sync.stats();
const _p6: number = syncStats.partitions;
const _eo6: number = syncStats.eventsObserved;
const _em6: number = syncStats.emissions;
const _ws6: number = syncStats.windowSize;
void _p6;
void _eo6;
void _em6;
void _ws6;

// ── LivePartitionedFusedRolling.stats (Codex HIGH regression pin) ─

const partFused = live.partitionBy('host').rolling(
  {
    '5s': { cpu_avg: { from: 'cpu', using: 'avg' } },
    '10s': { cpu_max: { from: 'cpu', using: 'max' } },
  },
  { trigger: Trigger.every('1s') },
);
const partFusedStats = partFused.stats();
const _p7: number = partFusedStats.partitions;
const _eo7: number = partFusedStats.eventsObserved;
const _em7: number = partFusedStats.emissions;
const _ws7: number = partFusedStats.windowSize;
const _wc7: number = partFusedStats.windowsCount;
void _p7;
void _eo7;
void _em7;
void _ws7;
void _wc7;

// ── Chained partitioned variant: stats() also visible ────────────

const chainedSync = live
  .partitionBy('host')
  .fill({ cpu: 'hold' })
  .rolling('5s', { cpu: 'avg' }, { trigger: Trigger.every('1s') });
const chainedSyncStats = chainedSync.stats();
const _p8: number = chainedSyncStats.partitions;
void _p8;
