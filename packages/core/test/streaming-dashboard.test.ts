import { describe, expect, it } from 'vitest';
import { LiveSeries, Sequence } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'latency', kind: 'number' },
  { name: 'host', kind: 'string' },
] as const;

function makeLive() {
  return new LiveSeries({ name: 'requests', schema });
}

function ms(minutes: number, seconds = 0) {
  return minutes * 60_000 + seconds * 1000;
}

// Simulate realistic latency data: base + jitter + occasional spikes
function generateEvents(
  live: ReturnType<typeof makeLive>,
  startMin: number,
  endMin: number,
  intervalSec = 1,
) {
  for (let t = ms(startMin); t < ms(endMin); t += intervalSec * 1000) {
    const base = 40 + Math.sin(t / 60_000) * 10;
    const jitter = Math.random() * 20 - 10;
    const spike = Math.random() < 0.05 ? 150 + Math.random() * 100 : 0;
    const latency = Math.round(base + jitter + spike);
    const host = `api-${(t / 1000) % 3 === 0 ? 1 : 2}`;
    live.push([t, latency, host]);
  }
}

// ── 5-minute aggregated bar chart ──────────────────────────────

describe('streaming bar chart: 5m avg latency', () => {
  it('produces closed buckets as data streams in', () => {
    const live = makeLive();
    const barChart = live.aggregate(Sequence.every('5m'), { latency: 'avg' });

    const closedBuckets: { start: number; avg: number }[] = [];
    barChart.on('event', (event) => {
      closedBuckets.push({
        start: event.begin(),
        avg: event.get('latency') as number,
      });
    });

    // Push 12 minutes of data at 1s intervals
    generateEvents(live, 0, 12);

    // Should have at least 2 closed 5m buckets: [0,5m) and [5m,10m)
    expect(closedBuckets.length).toBeGreaterThanOrEqual(2);
    expect(closedBuckets[0]!.start).toBe(0);
    expect(closedBuckets[1]!.start).toBe(ms(5));

    // Each bucket avg should be a reasonable latency
    for (const b of closedBuckets) {
      expect(b.avg).toBeGreaterThan(0);
      expect(b.avg).toBeLessThan(300);
    }

    // snapshot() includes the open bucket for real-time rendering
    const snap = barChart.snapshot();
    expect(snap.length).toBeGreaterThan(closedBuckets.length);

    barChart.dispose();
  });

  it('incremental: new buckets appear as time advances', () => {
    const live = makeLive();
    const barChart = live.aggregate(Sequence.every('5m'), { latency: 'avg' });

    generateEvents(live, 0, 5);
    const countAfter5m = barChart.closedCount;

    generateEvents(live, 5, 10);
    const countAfter10m = barChart.closedCount;

    // Advancing 5 more minutes should produce at least one more closed bucket
    expect(countAfter10m).toBeGreaterThan(countAfter5m);

    barChart.dispose();
  });

  it('closed() returns only finalized bars for export', () => {
    const live = makeLive();
    const barChart = live.aggregate(Sequence.every('5m'), { latency: 'avg' });

    generateEvents(live, 0, 12);

    const closed = barChart.closed();
    const snap = barChart.snapshot();

    // closed has only finalized buckets, snapshot includes provisional
    expect(closed.length).toBeLessThanOrEqual(snap.length);
    expect(closed.length).toBe(barChart.closedCount);

    barChart.dispose();
  });
});

// ── Rolling p95 live value ─────────────────────────────────────

describe('streaming live value: 1m rolling p95', () => {
  it('computes rolling p95 over a 1-minute window', () => {
    const live = makeLive();
    const p95 = live.rolling('1m', { latency: 'p95' });

    // Push 2 minutes of data
    generateEvents(live, 0, 2);

    const current = p95.value();
    expect(current.latency).toBeDefined();
    expect(typeof current.latency).toBe('number');
    // p95 should be higher than a simple average
    expect(current.latency).toBeGreaterThan(0);

    p95.dispose();
  });

  it('updates on every event', () => {
    const live = makeLive();
    const p95 = live.rolling('1m', { latency: 'p95' });

    const updates: number[] = [];
    p95.on('update', (val) => {
      if (val.latency !== undefined) updates.push(val.latency as number);
    });

    generateEvents(live, 0, 2);

    // Should have received an update for each event
    expect(updates.length).toBeGreaterThan(100);

    // All values should be valid latencies
    for (const v of updates) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(500);
    }

    p95.dispose();
  });

  it('evicts old events as window slides', () => {
    const live = makeLive();
    const p95 = live.rolling('1m', { latency: 'p95' });

    // Push data with a known spike in the first 30s
    for (let t = 0; t < 30_000; t += 1000) {
      live.push([t, 200, 'api-1']); // high latency
    }
    const withSpike = p95.value().latency as number;

    // Push 90s of normal data to push spike out of window
    for (let t = 30_000; t < 120_000; t += 1000) {
      live.push([t, 30, 'api-1']); // low latency
    }
    const afterEviction = p95.value().latency as number;

    expect(withSpike).toBeGreaterThan(afterEviction);
    expect(afterEviction).toBe(30); // all values are 30, so p95 = 30

    p95.dispose();
  });
});

// ── Combined dashboard pipeline ────────────────────────────────

describe('combined streaming dashboard', () => {
  it('bar chart + live p95 from the same LiveSeries', () => {
    const live = makeLive();

    // Bar chart: 5m average latency
    const barChart = live.aggregate(Sequence.every('5m'), { latency: 'avg' });

    // Live value: 1m rolling p95
    const p95 = live.rolling('1m', { latency: 'p95' });

    // Track updates from both
    const bars: number[] = [];
    const p95Values: number[] = [];

    barChart.on('event', (event) => bars.push(event.get('latency') as number));
    p95.on('update', (val) => {
      if (val.latency !== undefined) p95Values.push(val.latency as number);
    });

    // Stream 15 minutes of data
    generateEvents(live, 0, 15);

    // Bar chart should have closed buckets
    expect(bars.length).toBeGreaterThanOrEqual(2);

    // p95 should have been updated many times
    expect(p95Values.length).toBeGreaterThan(0);

    // p95 values should generally be >= bar chart averages
    const avgBar = bars.reduce((a, b) => a + b, 0) / bars.length;
    const avgP95 = p95Values.reduce((a, b) => a + b, 0) / p95Values.length;
    expect(avgP95).toBeGreaterThanOrEqual(avgBar);

    // snapshot() gives current state for rendering
    const snap = barChart.snapshot();
    expect(snap.length).toBeGreaterThan(0);

    const currentP95 = p95.value().latency;
    expect(currentP95).toBeDefined();

    barChart.dispose();
    p95.dispose();
  });

  it('filter by host before aggregation', () => {
    const live = makeLive();

    // Filter to api-1 only, then aggregate
    const api1View = live.filter((e) => e.get('host') === 'api-1');
    const barChart = api1View.aggregate(Sequence.every('5m'), {
      latency: 'avg',
    });
    const p95 = api1View.rolling('1m', { latency: 'p95' });

    generateEvents(live, 0, 12);

    // Both should produce results from filtered data
    const snap = barChart.snapshot();
    expect(snap.length).toBeGreaterThan(0);
    expect(p95.value().latency).toBeDefined();

    barChart.dispose();
    p95.dispose();
  });

  it('full pipeline: filter → bar chart with diff for trend', () => {
    const live = makeLive();

    const barChart = live.aggregate(Sequence.every('5m'), { latency: 'avg' });

    // Diff between consecutive 5m buckets shows trend
    const trend = barChart.diff('latency');

    const diffs: (number | undefined)[] = [];
    trend.on('event', (event: any) => {
      diffs.push(event.get('latency'));
    });

    generateEvents(live, 0, 20);

    // First diff is undefined (no previous bucket), rest are numbers
    expect(diffs.length).toBeGreaterThanOrEqual(2);
    expect(diffs[0]).toBeUndefined();
    expect(typeof diffs[1]).toBe('number');

    barChart.dispose();
  });
});
