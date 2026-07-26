import { describe, expect, it, vi } from 'vitest';
import { LiveSeries, Sequence, TimeSeries } from 'pond-ts';
import { derive, fromLive, source } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'cpu', kind: 'number' },
] as const;

function makeSeries(
  rows: readonly (readonly [number, number])[],
): TimeSeries<typeof schema> {
  return TimeSeries.fromJSON({
    name: 'metrics',
    schema,
    rows: rows.map((r) => [...r]),
  });
}

describe('TimeSeries values in a graph', () => {
  it('composes batch transforms across nodes', () => {
    const raw = source<TimeSeries<typeof schema>>();
    const hourly = derive({ s: raw.out.value }, ({ s }) =>
      s.aggregate(Sequence.every('1h'), { cpu: 'avg' }),
    );
    const count = derive({ s: hourly.out.value }, ({ s }) => s.length);

    raw.set(
      makeSeries([
        [0, 10],
        [1_800_000, 20],
        [3_600_000, 40],
      ]),
    );

    expect(count.out.value.get()).toBe(2);
    expect(hourly.out.value.get().at(0)?.get('cpu')).toBe(15);
  });

  it('reuses cached results when an unrelated source changes', () => {
    const raw = source<TimeSeries<typeof schema>>();
    const other = source<number>();
    const aggregateFn = vi.fn((v: { s: TimeSeries<typeof schema> }) =>
      v.s.aggregate(Sequence.every('1h'), { cpu: 'avg' }),
    );
    const hourly = derive({ s: raw.out.value }, aggregateFn);
    const combined = derive(
      { h: hourly.out.value, n: other.out.value },
      ({ h, n }) => h.length + n,
    );

    raw.set(makeSeries([[0, 10]]));
    other.set(1);
    expect(combined.out.value.get()).toBe(2);
    expect(aggregateFn).toHaveBeenCalledTimes(1);

    // Touching only `other` must not re-run the aggregation.
    other.set(5);
    expect(combined.out.value.get()).toBe(6);
    expect(aggregateFn).toHaveBeenCalledTimes(1);
  });
});

describe('fromLive', () => {
  it('snapshots once per pull, not once per event', () => {
    const live = new LiveSeries({ name: 'metrics', schema });
    const feed = fromLive(live);
    const downstream = vi.fn(
      (v: { s: TimeSeries<typeof schema> }) => v.s.length,
    );
    const count = derive({ s: feed.out.value }, downstream);

    for (let i = 0; i < 100; i += 1) live.push([i * 1000, i]);

    // 100 events, one evaluation.
    expect(count.out.value.get()).toBe(100);
    expect(downstream).toHaveBeenCalledTimes(1);

    for (let i = 100; i < 200; i += 1) live.push([i * 1000, i]);
    expect(count.out.value.get()).toBe(200);
    expect(downstream).toHaveBeenCalledTimes(2);
  });

  it('does not evaluate at all if nothing pulls', () => {
    const live = new LiveSeries({ name: 'metrics', schema });
    const feed = fromLive(live);
    const fn = vi.fn((v: { s: TimeSeries<typeof schema> }) => v.s.length);
    derive({ s: feed.out.value }, fn);

    for (let i = 0; i < 50; i += 1) live.push([i * 1000, i]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops tracking after dispose but keeps the last snapshot', () => {
    const live = new LiveSeries({ name: 'metrics', schema });
    const feed = fromLive(live);

    live.push([0, 1]);
    expect(feed.out.value.get().length).toBe(1);
    expect(feed.subscribed).toBe(true);

    feed.dispose();
    expect(feed.subscribed).toBe(false);

    live.push([1000, 2]);
    expect(feed.out.value.get().length).toBe(1);
  });

  it('binds an incremental LiveAggregation, which has no toTimeSeries', () => {
    const live = new LiveSeries({ name: 'metrics', schema });
    // The whole point: LiveAggregation implements the live-source shape
    // but cannot snapshot itself, so requiring toTimeSeries() would
    // exclude exactly the operators that make repeated pulls cheap.
    const agg = live.aggregate(Sequence.every('1h'), { cpu: 'avg' });
    expect('toTimeSeries' in agg).toBe(false);

    const feed = fromLive(agg);
    const peak = derive({ s: feed.out.value }, ({ s }) =>
      s.column('cpu').max(),
    );

    for (let i = 0; i < 120; i += 1) live.push([i * 60_000, i]);

    // The snapshot is bucket-sized, not event-sized: 120 events in, one
    // row out.
    expect(feed.out.value.get().length).toBe(1);
    expect(peak.out.value.get()).toBe(29.5); // mean of 0..59
    feed.dispose();
  });

  it('shows closed buckets only — the in-progress bucket is not visible', () => {
    const live = new LiveSeries({ name: 'metrics', schema });
    const feed = fromLive(live.aggregate(Sequence.every('1h'), { cpu: 'avg' }));

    // Two hours of minute data, last event at 1h59m: the second bucket
    // has not closed yet.
    for (let i = 0; i < 120; i += 1) live.push([i * 60_000, i]);

    // This is the tradeoff against re-aggregating the raw buffer, which
    // would report 2 — it buckets the partial tail as well. Data is the
    // clock, so the open bucket appears only once an event crosses its
    // end. A dashboard that must show the current partial bucket cannot
    // take this path.
    expect(feed.out.value.get().length).toBe(1);
    expect(
      live.toTimeSeries().aggregate(Sequence.every('1h'), { cpu: 'avg' })
        .length,
    ).toBe(2);

    live.push([120 * 60_000, 0]); // crosses the 2h boundary
    expect(feed.out.value.get().length).toBe(2);
    feed.dispose();
  });

  it('is idempotent on repeated dispose', () => {
    const live = new LiveSeries({ name: 'metrics', schema });
    const feed = fromLive(live);
    expect(() => {
      feed.dispose();
      feed.dispose();
    }).not.toThrow();
  });
});
