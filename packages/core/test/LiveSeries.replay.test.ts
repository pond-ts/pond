import { describe, expect, it } from 'vitest';
import { LiveSeries, Sequence } from '../src/index.js';

// [PND-LIVEREPLAY] A live operator attached to a series that already holds
// rows reads them the way it reads new pushes: fresh `Event`s, without
// filling the series' per-row cache. Its results match an operator that
// was attached before the rows arrived.

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number', required: false },
  { name: 'h', kind: 'string' },
] as const;

const batches = Array.from({ length: 12 }, (_, b) =>
  Array.from({ length: 25 }, (_, j) => {
    const i = b * 25 + j;
    return [i * 1000, i % 7 === 0 ? undefined : (i * 37) % 101, `h${i % 3}`];
  }),
);

const make = (retention?: { maxEvents: number }) =>
  new LiveSeries({ name: 'l', schema, retention } as never) as LiveSeries<any>;

const dump = (o: { length: number; at(i: number): any }) =>
  Array.from({ length: o.length }, (_, i) => {
    const e = o.at(i);
    return [e.begin(), e.end(), { ...e.data() }];
  });

const ops: Array<[string, (s: LiveSeries<any>) => any]> = [
  ['filter', (s) => s.filter((e: any) => (e.get('v') ?? 0) > 40)],
  ['rolling', (s) => s.rolling('20s', { v: 'avg' })],
  ['aggregate', (s) => s.aggregate(Sequence.every('30s'), { v: 'sum' })],
  ['partitionBy().collect()', (s) => s.partitionBy('h').collect()],
  [
    'partitionBy().rolling()',
    (s) => s.partitionBy('h').rolling('20s', { v: 'max' }),
  ],
];

describe('live operators replay existing rows like new pushes [PND-LIVEREPLAY]', () => {
  for (const retention of [undefined, { maxEvents: 200 }]) {
    for (const [name, op] of ops) {
      it(`${name}${retention ? ' with retention' : ''}: same output attached before or after the rows`, () => {
        const before = make(retention);
        const early = op(before);
        for (const b of batches) before.pushMany(b as never);

        const after = make(retention);
        for (const b of batches.slice(0, 6)) after.pushMany(b as never);
        const late = op(after);
        for (const b of batches.slice(6)) after.pushMany(b as never);

        expect(dump(late)).toEqual(dump(early));
      });
    }
  }

  it('reduce with retention: replayed rows are evicted from its state', () => {
    const before = make({ maxEvents: 60 });
    const early = before.reduce({ v: 'sum', n: { from: 'v', using: 'count' } });
    for (const b of batches) before.pushMany(b as never);
    const after = make({ maxEvents: 60 });
    for (const b of batches.slice(0, 6)) after.pushMany(b as never);
    const late = after.reduce({ v: 'sum', n: { from: 'v', using: 'count' } });
    for (const b of batches.slice(6)) after.pushMany(b as never);
    expect(late.value()).toEqual(early.value());
  });

  // Attach `reduce` early and late on the same pushes, with `setup` run
  // on the late series just before attaching and `post` on both after.
  const reduceBoth = (
    retention: unknown,
    setup: (s: LiveSeries<any>) => void = () => {},
    post: (s: LiveSeries<any>) => void = () => {},
  ) => {
    const spec = {
      v: 'sum',
      n: { from: 'v', using: 'count' },
      lo: { from: 'v', using: 'min' },
      f: { from: 'v', using: 'first' },
    } as const;
    const before = make(retention as never);
    const early = before.reduce(spec as never);
    for (const b of batches) before.pushMany(b as never);
    post(before);
    const after = make(retention as never);
    for (const b of batches.slice(0, 6)) after.pushMany(b as never);
    setup(after);
    const late = after.reduce(spec as never);
    for (const b of batches.slice(6)) after.pushMany(b as never);
    post(after);
    return [late.value(), early.value()];
  };

  it('reduce with retention on a partly cached series evicts the right rows', () => {
    const [late, early] = reduceBoth({ maxEvents: 60 }, (s) => {
      for (const i of [0, 3, 40, 59]) s.at(s.length - 60 + i);
    });
    expect(late).toEqual(early);
  });

  it('reduce with maxAge retention matches', () => {
    const [late, early] = reduceBoth({ maxAge: '45s' });
    expect(late).toEqual(early);
  });

  it('reduce after clear() matches', () => {
    const [late, early] = reduceBoth(undefined, undefined, (s) => {
      s.clear();
      s.pushMany(
        batches[0]!.map((r) => [(r[0] as number) + 1e6, r[1], r[2]]) as never,
      );
    });
    expect(late).toEqual(early);
  });

  it('reduce on a partition replays rows still waiting to be packed', () => {
    // 900 rows over 3 partitions: 300 each, so 256 packed and 44 waiting.
    const spec = { v: 'sum', n: { from: 'v', using: 'count' } } as const;
    const rows = batches.flat().concat(
      batches.flat().map((r) => [(r[0] as number) + 300_000, r[1], r[2]]),
      batches.flat().map((r) => [(r[0] as number) + 600_000, r[1], r[2]]),
    );
    const early = make();
    const ep = early.partitionBy('h');
    early.pushMany(rows.slice(0, 3) as never);
    const earlyReduce = [...ep.toMap().values()].map((p: any) =>
      p.reduce(spec as never),
    );
    early.pushMany(rows.slice(3) as never);

    const late = make();
    const lp = late.partitionBy('h');
    late.pushMany(rows as never);
    const parts = [...lp.toMap().values()] as any[];
    expect(parts.every((p) => p._isChunked && p.length === 300)).toBe(true);
    const lateReduce = parts.map((p) => p.reduce(spec as never));
    const tail = rows.map((r) => [(r[0] as number) + 900_000, r[1], r[2]]);
    early.pushMany(tail as never);
    late.pushMany(tail as never);
    expect(lateReduce.map((r) => r.value())).toEqual(
      earlyReduce.map((r) => r.value()),
    );
  });

  it('replayed events are fresh objects, as pushed events are', () => {
    const s = make();
    for (const b of batches) s.pushMany(b as never);
    const view = s.filter(() => true);
    expect(view.length).toBe(s.length);
    expect(view.at(0)).not.toBe(s.at(0));
    expect(dump(view)).toEqual(dump(s));
  });

  it('an event the series already built is reused', () => {
    const s = make();
    for (const b of batches) s.pushMany(b as never);
    const first = s.at(0);
    const view = s.filter(() => true);
    expect(view.at(0)).toBe(first);
  });
});
