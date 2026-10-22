/**
 * `rolling(sequence, window, mapping)` — the grid-driven form — checked by
 * brute force on random series ([PND-ROLLGRID]). The implementation finds
 * each bucket's window with two forward cursors; these tests rebuild every
 * window by scanning all rows, and check that the reducer saw exactly that
 * window's values, in row order, for every alignment, sample point, window
 * size and `minSamples`.
 *
 * Bit-for-bit results of the built-in numeric reducers are pinned by the
 * pond-rs parity fixture (`test/parity-fixture.test.ts`); here the
 * order-free built-ins (`count`, `min`, `max`, `first`, `last`) are compared
 * exactly and `avg` within rounding.
 */
import { describe, expect, it } from 'vitest';
import {
  BoundedSequence,
  Interval,
  Sequence,
  TimeSeries,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'host', kind: 'string', required: false },
] as const;

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

type Row = [number, number | undefined, string | undefined];

function randomRows(rand: () => number, n: number): Row[] {
  const rows: Row[] = [];
  let t = 1_000 + Math.floor(rand() * 500);
  for (let i = 0; i < n; i += 1) {
    // Repeated times, short steps, and the odd long silence.
    const r = rand();
    t += r < 0.15 ? 0 : r < 0.95 ? Math.floor(rand() * 900) : 20_000;
    const v = rand() < 0.1 ? undefined : Math.round((rand() - 0.5) * 2000) / 8;
    const host = rand() < 0.1 ? undefined : `h${Math.floor(rand() * 4)}`;
    rows.push([t, v, host]);
  }
  return rows;
}

type Alignment = 'trailing' | 'leading' | 'centered';
type Sample = 'begin' | 'center' | 'end';

function inWindow(
  t: number,
  anchor: number,
  windowMs: number,
  alignment: Alignment,
): boolean {
  if (alignment === 'trailing') return t > anchor - windowMs && t <= anchor;
  if (alignment === 'leading') return t >= anchor && t < anchor + windowMs;
  return t >= anchor - windowMs / 2 && t < anchor + windowMs / 2;
}

function anchorOf(bucket: Interval, sample: Sample): number {
  if (sample === 'begin') return bucket.begin();
  if (sample === 'end') return bucket.end();
  return bucket.begin() + (bucket.end() - bucket.begin()) / 2;
}

describe('rolling over a sequence matches a brute-force window scan', () => {
  const alignments: Alignment[] = ['trailing', 'leading', 'centered'];
  const samples: Sample[] = ['begin', 'center', 'end'];

  for (let seed = 1; seed <= 6; seed += 1) {
    it(`random series #${seed}`, () => {
      const rand = rng(seed);
      const rows = randomRows(rand, 40 + Math.floor(rand() * 200));
      const series = new TimeSeries({ name: 's', schema, rows });
      const step = 200 + Math.floor(rand() * 3000);
      // Windows narrower than a step (rows between windows are skipped),
      // equal to a step, and many steps wide.
      const windows = [
        Math.max(1, Math.floor(step / 3)),
        step,
        step * 7 + 1,
        // Odd ms count so centred windows have half-ms edges.
        2 * Math.floor(rand() * 2000) + 1,
      ];
      for (const alignment of alignments) {
        for (const sample of samples) {
          for (const windowMs of windows) {
            for (const minSamples of [0, 3]) {
              const seen: Array<ReadonlyArray<unknown>> = [];
              const hostsSeen: Array<ReadonlyArray<unknown>> = [];
              const out = series.rolling(
                Sequence.every(step),
                windowMs,
                {
                  n: { from: 'v', using: 'count' },
                  lo: { from: 'v', using: 'min' },
                  hi: { from: 'v', using: 'max' },
                  first: { from: 'v', using: 'first' },
                  last: { from: 'host', using: 'last' },
                  mean: { from: 'v', using: 'avg' },
                  raw: {
                    from: 'v',
                    using: (values) => {
                      seen.push([...values]);
                      return values.length;
                    },
                  },
                  hosts: {
                    from: 'host',
                    kind: 'string',
                    using: (values) => {
                      hostsSeen.push([...values]);
                      return values.join(',');
                    },
                  },
                },
                { alignment, sample, minSamples },
              );

              const expectedSeen: unknown[][] = [];
              const expectedHosts: unknown[][] = [];
              for (let i = 0; i < out.length; i += 1) {
                const event = out.at(i)!;
                const bucket = event.key() as Interval;
                const anchor = anchorOf(bucket, sample);
                const window = rows.filter((r) =>
                  inWindow(r[0], anchor, windowMs, alignment),
                );
                const ctx = `${alignment}/${sample}/w=${windowMs}/min=${minSamples}/bucket ${i}`;
                if (window.length < minSamples) {
                  for (const name of [
                    'n',
                    'lo',
                    'hi',
                    'first',
                    'last',
                    'mean',
                    'raw',
                    'hosts',
                  ] as const) {
                    expect(event.get(name), ctx).toBeUndefined();
                  }
                  continue;
                }
                const vs = window.map((r) => r[1]);
                const defined = vs.filter((v): v is number => v !== undefined);
                const hosts = window
                  .map((r) => r[2])
                  .filter((h) => h !== undefined);
                expectedSeen.push(vs);
                expectedHosts.push(window.map((r) => r[2]));
                expect(event.get('n'), ctx).toBe(defined.length);
                expect(event.get('raw'), ctx).toBe(vs.length);
                expect(event.get('lo'), ctx).toBe(
                  defined.length ? Math.min(...defined) : undefined,
                );
                expect(event.get('hi'), ctx).toBe(
                  defined.length ? Math.max(...defined) : undefined,
                );
                expect(event.get('first'), ctx).toBe(defined[0]);
                expect(event.get('last'), ctx).toBe(hosts[hosts.length - 1]);
                if (defined.length === 0) {
                  expect(event.get('mean'), ctx).toBeUndefined();
                } else {
                  const mean =
                    defined.reduce((s, v) => s + v, 0) / defined.length;
                  expect(event.get('mean') as number, ctx).toBeCloseTo(mean, 9);
                }
              }
              expect(seen).toEqual(expectedSeen);
              expect(hostsSeen).toEqual(expectedHosts);
            }
          }
        }
      }
    });
  }

  it('handles explicit buckets with gaps between them', () => {
    const rows: Row[] = [
      [0, 1, 'a'],
      [5, 2, 'a'],
      [5, 3, 'b'],
      [10, 4, 'a'],
      [50, 5, 'a'],
      [100, 6, 'b'],
      [101, 7, 'b'],
    ];
    const series = new TimeSeries({ name: 's', schema, rows });
    const seq = new BoundedSequence([
      new Interval({ value: 'x', start: 0, end: 5 }),
      new Interval({ value: 'y', start: 40, end: 60 }),
      new Interval({ value: 'z', start: 100, end: 200 }),
    ]);
    const out = series.rolling(seq, 10, { v: 'sum' }, { sample: 'end' });
    // Windows (trailing, anchored at bucket end): (-5, 5], (50, 60], (190, 200].
    expect(out.toArray().map((e) => [e.key().value, e.get('v')])).toEqual([
      ['x', 6],
      // An empty window sums to 0 (as `aggregate` does).
      ['y', 0],
      ['z', 0],
    ]);
    // Leading from bucket begin: [0, 10), [40, 50), [100, 110).
    const lead = series.rolling(
      seq,
      10,
      { v: 'sum' },
      { alignment: 'leading' },
    );
    expect(lead.toArray().map((e) => e.get('v'))).toEqual([6, 0, 13]);
  });

  it('keeps number bucket labels as numbers', () => {
    const series = new TimeSeries({
      name: 's',
      schema,
      rows: [
        [0, 1, 'a'],
        [10, 2, 'a'],
      ],
    });
    const seq = new BoundedSequence([
      new Interval({ value: 1, start: 0, end: 10 }),
      new Interval({ value: 2, start: 10, end: 20 }),
    ]);
    const out = series.rolling(seq, 10, { v: 'sum' });
    expect(out.toArray().map((e) => e.key().value)).toEqual([1, 2]);
    expect(out.toArray().map((e) => e.get('v'))).toEqual([1, 2]);
  });
});
