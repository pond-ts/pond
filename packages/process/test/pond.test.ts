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

  it('is idempotent on repeated dispose', () => {
    const live = new LiveSeries({ name: 'metrics', schema });
    const feed = fromLive(live);
    expect(() => {
      feed.dispose();
      feed.dispose();
    }).not.toThrow();
  });
});
