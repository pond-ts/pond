/**
 * Column-native `align` / `materialize` / `dedupe` ([PND-ALIGNHOLD],
 * [PND-DEDUPEMAP]). Each op now picks source row numbers over the key
 * buffers and gathers columns by them; these tests rebuild the old
 * row-at-a-time answers by hand and check the edges the buffer walks
 * restate (key order across key kinds, rounding in fixed grids, interval
 * labels that compare equal, event identity).
 */
import { describe, expect, it } from 'vitest';
import {
  BoundedSequence,
  Interval,
  Sequence,
  Time,
  TimeRange,
  TimeSeries,
} from '../src/index.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Kind = 'time' | 'timeRange' | 'interval';

function randomSeries(seed: number, kind: Kind) {
  const r = rng(seed);
  const rows: unknown[][] = [];
  let t = 0;
  for (let i = 0; i < 40; i += 1) {
    t += r() < 0.35 ? 0 : Math.floor(r() * 9) + 1;
    // Zero-length range / interval keys land exactly on sample times.
    const len = r() < 0.4 ? 0 : Math.floor(r() * 6) + 1;
    const key =
      kind === 'time'
        ? t
        : kind === 'timeRange'
          ? [t, t + len]
          : [`L${Math.floor(r() * 3)}`, t, t + len];
    rows.push([key, r() < 0.2 ? undefined : Math.round(r() * 100) / 10]);
  }
  return new TimeSeries({
    name: 's',
    schema: [
      { name: kind, kind },
      { name: 'v', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
    ordering: 'reorder',
  });
}

describe('fixed grids laid out as buffers', () => {
  it('match bounded() bucket for bucket, or fail with its error', () => {
    const cases: Array<[number, number, number, number]> = [
      [7, 0, -20, 300],
      [0.3, 0, 0, 50],
      [3, -1.5, -10, 40],
      [13, 3, 5, 5],
      [5, 2 ** 54 + 2, 2 ** 54, 2 ** 54 + 60],
      // Rounding makes these invalid; bounded() throws.
      [3, 2 ** 53, 2 ** 53, 2 ** 53 + 60],
      [1, 2 ** 53, 2 ** 53, 2 ** 53 + 60],
    ];
    const series = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [[0, 1]],
    });
    for (const [step, anchor, start, end] of cases) {
      const seq = Sequence.every(step, { anchor });
      const range = new TimeRange({ start, end });
      for (const sample of ['begin', 'center', 'end'] as const) {
        let want: unknown;
        try {
          want = seq
            .bounded(range, { sample })
            .intervals()
            .map((iv) => [iv.value, iv.begin(), iv.end()]);
        } catch (error) {
          want = (error as Error).message;
        }
        let got: unknown;
        try {
          got = series
            .align(seq, { sample, range })
            .toArray()
            .map((e) => {
              const iv = e.key() as Interval;
              return [iv.value, iv.begin(), iv.end()];
            });
        } catch (error) {
          got = (error as Error).message;
        }
        expect(got, `${step} ${anchor} ${sample}`).toEqual(want);
      }
    }
  });

  it('keeps a -0 anchor', () => {
    const series = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [[0, 1]],
    });
    const out = series.align(Sequence.every(5, { anchor: -0 }), {
      range: new TimeRange({ start: -0.5, end: 1 }),
    });
    const iv = out.at(0)!.key() as Interval;
    expect(Object.is(iv.begin(), -0)).toBe(true);
    expect(Object.is(iv.value, -0)).toBe(true);
  });
});

describe('align hold', () => {
  it('takes atOrBefore(Time(t)) for every key kind', () => {
    for (let seed = 1; seed <= 30; seed += 1) {
      for (const kind of ['time', 'timeRange', 'interval'] as const) {
        const s = randomSeries(seed, kind);
        for (const sample of ['begin', 'center', 'end'] as const) {
          const out = s.align(Sequence.every(3), { sample });
          out.toArray().forEach((e) => {
            const iv = e.key() as Interval;
            const t =
              sample === 'begin'
                ? iv.begin()
                : sample === 'end'
                  ? iv.end()
                  : iv.begin() + iv.duration() / 2;
            const ref = s.atOrBefore(new Time(t));
            expect(e.get('v'), `${seed} ${kind} ${sample} t=${t}`).toBe(
              ref?.get('v'),
            );
          });
        }
      }
    }
  });
});

describe('align linear', () => {
  it('interpolates numbers, holds the rest, and turns overflow into a gap', () => {
    const s = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number', required: false },
        { name: 'tag', kind: 'string', required: false },
      ] as const,
      rows: [
        [0, -1.7e308, 'a'],
        [10, 1.7e308, 'b'],
        [20, 4, 'c'],
        [30, undefined, 'd'],
        [40, 8, undefined],
      ],
    });
    const out = s.align(Sequence.every(5), { method: 'linear' });
    expect(
      out.toArray().map((e) => [e.begin(), e.get('v'), e.get('tag')]),
    ).toEqual([
      [0, -1.7e308, 'a'],
      // (1.7e308 - -1.7e308) overflows to Infinity: stored as missing.
      [5, undefined, 'a'],
      [10, 1.7e308, 'b'],
      [15, 1.7e308 + (4 - 1.7e308) * 0.5, 'b'],
      [20, 4, 'c'],
      // next cell missing: keep the earlier value.
      [25, 4, 'c'],
      [30, undefined, 'd'],
      // earlier cell missing: stays missing.
      [35, undefined, 'd'],
      [40, 8, undefined],
    ]);
  });
});

describe('dedupe on key runs', () => {
  const schema = [
    { name: 'interval', kind: 'interval' },
    { name: 'v', kind: 'number', required: false },
  ] as const;
  // Precomposed and decomposed é compare equal, so they can interleave
  // inside one span; the old walk grouped by the label's exact text.
  const E1 = 'é';
  const E2 = 'é';

  it('groups equal labels by text inside a span, in first-seen order', () => {
    const s = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [[E1, 0, 5], 1],
        [[E2, 0, 5], 2],
        [[E1, 0, 5], 3],
        [['b', 0, 5], 4],
        [['b', 1, 5], 5],
      ],
    });
    const order = s.toArray().map((e) => e.get('v'));
    const last = s
      .dedupe({ keep: 'last' })
      .toArray()
      .map((e) => e.get('v'));
    const first = s
      .dedupe({ keep: 'first' })
      .toArray()
      .map((e) => e.get('v'));
    // Rebuild the old answer: group by `${begin}:${end}:${label}`.
    const groups = new Map<string, number[]>();
    s.toArray().forEach((e) => {
      const iv = e.key() as Interval;
      const k = `${iv.begin()}:${iv.end()}:${String(iv.value)}`;
      groups.set(k, [...(groups.get(k) ?? []), e.get('v') as number]);
    });
    expect(last).toEqual([...groups.values()].map((g) => g[g.length - 1]));
    expect(first).toEqual([...groups.values()].map((g) => g[0]));
    expect(order.length).toBe(5);
    expect(() => s.dedupe({ keep: 'error' })).toThrow(
      /^dedupe: 2 events at key "0:5:/,
    );
  });

  it('checks the keep option only once a duplicate is found', () => {
    const unique = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [0, 1],
        [1, 2],
      ],
    });
    expect(unique.dedupe({ keep: 'bogus' as never }).length).toBe(2);
    const dup = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [0, 1],
        [0, 2],
      ],
    });
    expect(() => dup.dedupe({ keep: { other: 1 } as never })).toThrow(
      /^dedupe: invalid keep option/,
    );
    expect(() => dup.dedupe({ keep: 'error' })).toThrow(
      'dedupe: 2 events at 1970-01-01T00:00:00.000Z (0). ' +
        "Specify a different 'keep' policy or fix upstream.",
    );
  });

  it("shares each kept row's event with the source, whichever is built first", () => {
    const s = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [0, 1],
        [0, 2],
        [1, 3],
      ],
    });
    const d = s.dedupe();
    // Result first, then the source.
    const kept = d.at(0)!;
    expect(s.at(1)).toBe(kept);
    expect(d.events[1]).toBe(s.events[2]);
  });

  it('returns already-built events as the same objects', () => {
    const s = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [0, 1],
        [0, 2],
        [1, 3],
        [2, 4],
      ],
    });
    const held = s.at(3)!;
    const d = s.dedupe();
    expect(d.at(2)).toBe(held);
    // With every event built, each kept row is its source event.
    const all = s.events;
    const d2 = s.dedupe({ keep: 'first' });
    expect(d2.events).toEqual([all[0], all[2], all[3]]);
    d2.events.forEach((e, i) => expect(e).toBe([all[0], all[2], all[3]][i]));
  });
});

describe('partitioned materialize', () => {
  it('stamps the partition value on empty buckets, even a strategy name', () => {
    const s = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'host', kind: 'string' },
        { name: 'v', kind: 'number' },
      ] as const,
      rows: [
        [0, 'hold', 1],
        [0, 'linear', 2],
        [20, 'hold', 3],
      ],
    });
    const out = s
      .partitionBy('host')
      .materialize(Sequence.every(10), {
        range: new TimeRange({ start: 0, end: 20 }),
      })
      .collect()
      .toArray()
      .map((e) => [e.begin(), e.get('host'), e.get('v')]);
    expect(out).toEqual([
      [0, 'hold', 1],
      [0, 'linear', 2],
      [10, 'hold', undefined],
      [10, 'linear', undefined],
      [20, 'hold', 3],
      [20, 'linear', undefined],
    ]);
  });
});
