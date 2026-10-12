/**
 * End-to-end example: an error-rate dashboard over a request stream.
 *
 * This test is the runnable counterpart of
 * `website/docs/examples/error-rate-dashboard.mdx`. If you change one,
 * change the other — they're meant to stay in sync so the docs can't
 * silently drift from reality.
 *
 * The fixture is 15 hand-picked request events spread across three
 * minutes. The scenario is:
 *
 *   - Minute 0: one isolated `/checkout` 5xx on api-1.
 *   - Minute 1: a broad outage — 5 failing requests across api-1/api-2/
 *     api-3/api-4, hitting `/checkout` and `/cart` with a mix of tags.
 *   - Minute 2: back to clean traffic, no errors.
 *
 * The dashboard composes: `arrayContainsAny` (filter to error events) →
 * `aggregate` with `'p95'` + `'unique'` + `top(n)` (per-minute rollup) →
 * `arrayAggregate('host', 'count', { as: 'hostCount' })` (blast-radius
 * sidecar) → `filter` on `hostCount >= 3` (alert view) → `arrayExplode`
 * (per-host fan-out for a small-multiples chart).
 *
 * A second case repeats the aggregation on a `LiveSeries` to show the
 * same composition working in a streaming context.
 */
import { describe, expect, it } from 'vitest';
import {
  LiveSeries,
  Sequence,
  TimeRange,
  TimeSeries,
  top,
  type ArrayValue,
} from '../src/index.js';

/**
 * Dashboard range: three full minutes. We pass this explicitly to every
 * aggregate() call so buckets [0, 60s), [60s, 120s), [120s, 180s) are
 * always present — even when the upstream filter leaves a minute empty.
 */
const DASHBOARD_RANGE = new TimeRange({ start: 0, end: 180_000 });

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'host', kind: 'string' },
  { name: 'path', kind: 'string' },
  { name: 'tags', kind: 'array' },
  { name: 'latency_ms', kind: 'number' },
] as const;

// ── Fixture ──────────────────────────────────────────────────────────────
//
// 15 events. See header comment for scenario.
// Time values are seconds for readability; we multiply by 1000 on ingest.
const rows: ReadonlyArray<
  readonly [number, string, string, readonly string[], number]
> = [
  // Minute 0: mostly healthy.
  [5, 'api-1', '/home', [], 42],
  [10, 'api-1', '/home', [], 38],
  [20, 'api-2', '/checkout', ['slow'], 210],
  [30, 'api-1', '/checkout', ['5xx'], 80], // error
  [50, 'api-3', '/cart', [], 55],

  // Minute 1: broad outage across 4 hosts, /checkout + /cart.
  [65, 'api-1', '/checkout', ['timeout'], 3000], // error
  [70, 'api-2', '/checkout', ['5xx', 'retry'], 200], // error
  [80, 'api-2', '/cart', ['timeout'], 900], // error
  [90, 'api-3', '/checkout', ['5xx'], 150], // error
  [100, 'api-4', '/cart', ['retry'], 400], // error
  [110, 'api-3', '/cart', [], 60],
  [115, 'api-1', '/home', [], 35],

  // Minute 2: recovery, no errors.
  [130, 'api-2', '/home', [], 40],
  [150, 'api-1', '/home', [], 41],
  [170, 'api-3', '/home', [], 45],
];

function buildSeries(): TimeSeries<typeof schema> {
  return new TimeSeries({
    name: 'requests',
    schema,
    rows: rows.map(([t, host, path, tags, lat]) => [
      t * 1000,
      host,
      path,
      tags,
      lat,
    ]),
  });
}

const ERROR_TAGS = ['5xx', 'timeout', 'retry'];

describe('error-rate dashboard (batch)', () => {
  const series = buildSeries();

  it('arrayContainsAny filters to events tagged with any error type', () => {
    const errors = series.arrayContainsAny('tags', ERROR_TAGS);
    // Event 3 (min 0) + events 5-9 (min 1) = 6 error events.
    expect(errors.length).toBe(6);
    expect(errors.toArray().map((e) => e.begin() / 1000)).toEqual([
      30, 65, 70, 80, 90, 100,
    ]);
  });

  it('aggregate(p95 + unique + top(n)) produces a typed per-minute rollup', () => {
    const perMinute = series.arrayContainsAny('tags', ERROR_TAGS).aggregate(
      Sequence.every('1m'),
      {
        latency_ms: 'p95',
        host: 'unique',
        path: top(3),
        tags: top(5),
      },
      { range: DASHBOARD_RANGE },
    );

    // Output schema: interval key + 4 reducer-output columns.
    expect(perMinute.schema.map((c) => [c.name, c.kind])).toEqual([
      ['interval', 'interval'],
      ['latency_ms', 'number'],
      ['host', 'array'],
      ['path', 'array'],
      ['tags', 'array'],
    ]);

    // Minute 0 has exactly one error event (api-1 /checkout ['5xx'] @ 80ms).
    const minute0 = perMinute.at(0)!;
    expect(minute0.get('latency_ms')).toBe(80);
    expect(minute0.get('host')).toEqual(['api-1']);
    expect(minute0.get('path')).toEqual(['/checkout']);
    expect(minute0.get('tags')).toEqual(['5xx']);

    // Minute 1: 5 errors, 4 distinct hosts.
    const minute1 = perMinute.at(1)!;
    // Latencies sorted: [150, 200, 400, 900, 3000].
    // p95 rank = 0.95 * (5-1) = 3.8 -> between 900 and 3000.
    // 900 + 0.8 * (3000 - 900) = 2580.
    expect(minute1.get('latency_ms')).toBeCloseTo(2580, 6);
    expect(minute1.get('host')).toEqual(['api-1', 'api-2', 'api-3', 'api-4']);
    // /checkout x3, /cart x2 -> top 3 gives both (only 2 unique).
    expect(minute1.get('path')).toEqual(['/checkout', '/cart']);
    // Flattened error tags: ['timeout','5xx','retry','timeout','5xx','retry']
    // Counts: 5xx=2, retry=2, timeout=2. Three-way tie, scalar order.
    expect(minute1.get('tags')).toEqual(['5xx', 'retry', 'timeout']);

    // Minute 2: no errors in that bucket; all reducer outputs bottom out.
    const minute2 = perMinute.at(2)!;
    expect(minute2.get('latency_ms')).toBeUndefined();
    expect(minute2.get('host')).toEqual([]);
    expect(minute2.get('path')).toEqual([]);
    expect(minute2.get('tags')).toEqual([]);
  });

  it('arrayAggregate({ as: "hostCount" }) preserves the host list and adds a scalar sidecar', () => {
    const perMinute = series.arrayContainsAny('tags', ERROR_TAGS).aggregate(
      Sequence.every('1m'),
      {
        latency_ms: 'p95',
        host: 'unique',
      },
      { range: DASHBOARD_RANGE },
    );
    const withCount = perMinute.arrayAggregate('host', 'count', {
      as: 'hostCount',
    });

    // Schema: original columns unchanged, new scalar column appended.
    const hostCol = withCount.schema.find((c) => c.name === 'host');
    const hostCountCol = withCount.schema.find((c) => c.name === 'hostCount');
    expect(hostCol?.kind).toBe('array');
    expect(hostCountCol?.kind).toBe('number');

    expect(withCount.at(0)!.get('host')).toEqual(['api-1']);
    expect(withCount.at(0)!.get('hostCount')).toBe(1);
    expect(withCount.at(1)!.get('host')).toEqual([
      'api-1',
      'api-2',
      'api-3',
      'api-4',
    ]);
    expect(withCount.at(1)!.get('hostCount')).toBe(4);
  });

  it('filter on hostCount >= 3 catches the broad-outage minute', () => {
    const perMinute = series
      .arrayContainsAny('tags', ERROR_TAGS)
      .aggregate(
        Sequence.every('1m'),
        { host: 'unique' },
        { range: DASHBOARD_RANGE },
      );
    const broad = perMinute
      .arrayAggregate('host', 'count', { as: 'hostCount' })
      .filter((e) => (e.get('hostCount') as number) >= 3);

    expect(broad.length).toBe(1);
    expect(broad.at(0)!.begin()).toBe(60_000); // minute 1
    expect(broad.at(0)!.get('hostCount')).toBe(4);
  });

  it('arrayExplode fans each bucket out per host (small-multiples prep)', () => {
    const perMinute = series.arrayContainsAny('tags', ERROR_TAGS).aggregate(
      Sequence.every('1m'),
      {
        latency_ms: 'p95',
        host: 'unique',
      },
      { range: DASHBOARD_RANGE },
    );
    const perMinutePerHost = perMinute.arrayExplode('host');

    // Minute 0 contributes 1 row (api-1), minute 1 contributes 4, minute 2
    // has an empty host array so arrayExplode drops it.
    expect(perMinutePerHost.length).toBe(5);

    // Each minute-1 row shares the same interval key but a distinct host.
    const minute1Rows = perMinutePerHost
      .toArray()
      .filter((e) => e.begin() === 60_000);
    expect(minute1Rows.map((e) => e.get('host'))).toEqual([
      'api-1',
      'api-2',
      'api-3',
      'api-4',
    ]);
    // latency_ms sidecar travels with each fanned-out row.
    for (const row of minute1Rows) {
      expect(row.get('latency_ms') as number).toBeCloseTo(2580, 6);
    }
  });

  it('arrayExplode({ as }) keeps the array column and adds a scalar sibling', () => {
    const perMinute = series
      .arrayContainsAny('tags', ERROR_TAGS)
      .aggregate(
        Sequence.every('1m'),
        { host: 'unique' },
        { range: DASHBOARD_RANGE },
      );
    const fanned = perMinute.arrayExplode('host', { as: 'focusHost' });

    const hostCol = fanned.schema.find((c) => c.name === 'host');
    const focusCol = fanned.schema.find((c) => c.name === 'focusHost');
    expect(hostCol?.kind).toBe('array');
    expect(focusCol?.kind).toBe('string');

    // Every fanned-out minute-1 row still carries the full host list.
    const minute1Rows = fanned.toArray().filter((e) => e.begin() === 60_000);
    for (const row of minute1Rows) {
      expect(row.get('host')).toEqual(['api-1', 'api-2', 'api-3', 'api-4']);
    }
    expect(minute1Rows.map((e) => e.get('focusHost'))).toEqual([
      'api-1',
      'api-2',
      'api-3',
      'api-4',
    ]);
  });
});

describe('error-rate dashboard (live)', () => {
  it('the same composition works incrementally on a LiveSeries', () => {
    const live = new LiveSeries({ name: 'requests', schema });

    // Same filter → aggregate pipeline as the batch case.
    const errorStream = live
      .filter((event) => {
        const tags = event.get('tags') as ArrayValue | undefined;
        if (!Array.isArray(tags)) return false;
        for (const needle of ERROR_TAGS) {
          if (tags.includes(needle)) return true;
        }
        return false;
      })
      .aggregate(Sequence.every('1m'), {
        host: 'unique',
        path: top(3),
        tags: top(5),
      });

    const closedBuckets: {
      start: number;
      hosts: ArrayValue;
      paths: ArrayValue;
      tags: ArrayValue;
    }[] = [];
    errorStream.on('event', (event) => {
      closedBuckets.push({
        start: event.begin(),
        hosts: event.get('host') as ArrayValue,
        paths: event.get('path') as ArrayValue,
        tags: event.get('tags') as ArrayValue,
      });
    });

    // Replay the fixture. Buckets close as the watermark crosses each
    // minute boundary — the next row past 60_000ms closes minute 0, and
    // so on. Buckets only materialize in the live layer if an event
    // actually lands in them, so an all-clean minute 2 won't emit a
    // closed bucket (use the batch path if you want explicit empty
    // buckets via `{ range }`).
    for (const [t, host, path, tags, lat] of rows) {
      live.push([t * 1000, host, path, tags, lat]);
    }

    // Push a trailing error past the minute-1 boundary to force bucket 1
    // to close. Use a minute-3 timestamp so this event's own bucket
    // stays open.
    live.push([200_000, 'api-1', '/checkout', ['5xx'], 50]);

    // Minutes 0 and 1 should be closed; minute 2 never received an
    // error event so no bucket exists for it in the streaming layer.
    expect(closedBuckets.length).toBe(2);
    expect(closedBuckets[0]!.start).toBe(0);
    expect(closedBuckets[0]!.hosts).toEqual(['api-1']);
    expect(closedBuckets[0]!.paths).toEqual(['/checkout']);
    expect(closedBuckets[0]!.tags).toEqual(['5xx']);

    expect(closedBuckets[1]!.start).toBe(60_000);
    expect(closedBuckets[1]!.hosts).toEqual([
      'api-1',
      'api-2',
      'api-3',
      'api-4',
    ]);
    expect(closedBuckets[1]!.paths).toEqual(['/checkout', '/cart']);
    expect(closedBuckets[1]!.tags).toEqual(['5xx', 'retry', 'timeout']);

    // The minute-3 event is still accumulating in an open bucket.
    // `snapshot()` includes it as a provisional bar; `closed()` does not.
    const snap = errorStream.snapshot();
    expect(snap.length).toBe(3);
    expect(snap.at(2)!.begin()).toBe(180_000);
    expect(snap.at(2)!.get('host')).toEqual(['api-1']);
  });
});
