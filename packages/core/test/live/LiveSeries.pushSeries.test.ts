/**
 * [PND-LPUSHCOL] `LiveSeries.pushSeries(ts)` must behave exactly like
 * `pushMany` of the batch's rows: same rows stored, same stats, same
 * listener calls in the same order, same errors. The differential
 * harness below runs both on twin series across every ordering mode, key
 * kind and retention, then the targeted tests pin what only pushSeries
 * has (shape checks, required gaps judged by the live schema, shared
 * buffers).
 */
import { describe, expect, it } from 'vitest';

import {
  Interval,
  LiveSeries,
  Sequence,
  TimeSeries,
  ValidationError,
} from '../../src/index.js';
import { copyBatch } from '../../src/live/live-series.js';
import { ON_SIGNAL } from '../../src/schema/series.js';

type AnyLive = LiveSeries<any>;
type AnySeries = TimeSeries<any>;

type KeyKind = 'time' | 'timeRange' | 'interval';

function schemaFor<K extends KeyKind>(key: K) {
  return [
    { name: key, kind: key },
    { name: 'v', kind: 'number' },
    { name: 'w', kind: 'number', required: false },
    { name: 's', kind: 'string', required: false },
  ] as const;
}

// Small seeded PRNG (mulberry32) so a failing seed can be replayed.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Config = {
  label: string;
  key: KeyKind;
  labels?: 'string' | 'number';
  late: boolean; // generate late rows across batches
  opts: Record<string, unknown>;
};

const CONFIGS: Config[] = [
  { label: 'strict time (chunked)', key: 'time', late: false, opts: {} },
  {
    label: 'strict time, array backing',
    key: 'time',
    late: false,
    opts: { __backing: 'array' },
  },
  { label: 'drop', key: 'time', late: true, opts: { ordering: 'drop' } },
  { label: 'reorder', key: 'time', late: true, opts: { ordering: 'reorder' } },
  {
    label: 'reorder, grace 2s',
    key: 'time',
    late: true,
    opts: { ordering: 'reorder', graceWindow: '2s' },
  },
  { label: 'strict timeRange', key: 'timeRange', late: false, opts: {} },
  {
    label: 'strict interval, text labels',
    key: 'interval',
    labels: 'string',
    late: false,
    opts: {},
  },
  {
    label: 'strict interval, number labels',
    key: 'interval',
    labels: 'number',
    late: false,
    opts: {},
  },
];

const RETENTIONS = [undefined, { maxEvents: 7 }, { maxAge: '5s' }] as const;

const SIZES = [0, 1, 1, 3, 8, 20, 60];

/**
 * One batch as a `TimeSeries` built through `fromColumns` (Float64Array
 * value columns, so NaN in `w` is a gap). Keys rise inside the batch
 * (equal `time` keys allowed); the batch starts `offset` after `last`.
 */
function makeBatch(
  rand: () => number,
  cfg: Config,
  n: number,
  start: number,
): AnySeries {
  const begin = new Float64Array(n);
  const end = new Float64Array(n);
  const labels: Array<string | number> = [];
  const v = new Float64Array(n);
  const w = new Float64Array(n);
  const s: Array<string | null> = [];
  let t = start;
  for (let i = 0; i < n; i += 1) {
    if (i > 0) {
      // `time` keys may repeat; two-edged keys always rise.
      const step = Math.floor(rand() * 3) * 500;
      t += cfg.key === 'time' ? step : step + 500;
    }
    begin[i] = t;
    end[i] = t + 250 + Math.floor(rand() * 3) * 250;
    const k = Math.floor(rand() * 4);
    labels.push(cfg.labels === 'number' ? k : `L${k}`);
    v[i] = Math.floor(rand() * 100);
    w[i] = rand() < 0.2 ? NaN : Math.floor(rand() * 100) / 4;
    s.push(rand() < 0.2 ? null : ['a', 'b', 'c'][Math.floor(rand() * 3)]!);
  }
  const columns: Record<string, unknown> = { v, w, s };
  if (cfg.key === 'time') columns.time = begin;
  if (cfg.key === 'timeRange') {
    columns.timeRange = begin;
    columns.timeRangeEnd = end;
  }
  if (cfg.key === 'interval') {
    columns.interval = begin;
    columns.intervalEnd = end;
    columns.intervalLabel = labels;
  }
  return TimeSeries.fromColumns({
    name: 'batch',
    schema: schemaFor(cfg.key),
    columns,
  } as never) as AnySeries;
}

function keyDesc(k: any): unknown[] {
  return [k.begin(), k.end(), k instanceof Interval ? k.value : null];
}

function eventDesc(e: any): unknown[] {
  return [keyDesc(e.key()), e.get('v'), e.get('w'), e.get('s')];
}

function rowDesc(r: readonly unknown[]): unknown[] {
  return [keyDesc(r[0]), ...r.slice(1)];
}

function makeLive(cfg: Config, retention: unknown): AnyLive {
  return new LiveSeries({
    name: 'live',
    schema: schemaFor(cfg.key),
    ...cfg.opts,
    ...(retention === undefined ? {} : { retention }),
  } as never) as AnyLive;
}

/** One log of every listener call, in order, with what each one saw. */
function record(live: AnyLive): unknown[] {
  const log: unknown[] = [];
  live.on('event', (e: any) => log.push(['event', eventDesc(e), live.length]));
  live.on('batch', (es: any) => log.push(['batch', es.map(eventDesc)]));
  live.on('evict', (es: any) => log.push(['evict', es.map(eventDesc)]));
  live._onSettle(() => log.push(['settle', live.length]));
  return log;
}

/**
 * The payload-free change signals the React hooks use ([PND-HOOKSIGNAL]).
 * They don't make the chunked backing build events, so they are logged
 * with and without the listeners above.
 */
function recordSignals(live: AnyLive, log: unknown[]): unknown[] {
  const on = (live as any)[ON_SIGNAL].bind(live);
  on('event', () => log.push(['signal:event', live.length]));
  on('evict', () => log.push(['signal:evict', live.length]));
  return log;
}

function state(live: AnyLive) {
  return {
    rows: live.toRows().map((r) => rowDesc(r as unknown[])),
    length: live.length,
    stats: live.stats(),
  };
}

function attempt(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return [(err as Error).constructor.name, (err as Error).message];
  }
}

describe('pushSeries matches pushMany (differential)', () => {
  for (const cfg of CONFIGS) {
    for (const retention of RETENTIONS) {
      for (const watched of [true, false]) {
        const name =
          `${cfg.label}, retention ${JSON.stringify(retention ?? null)}` +
          (watched ? ', with listeners' : ', no listeners');
        it(name, () => {
          for (let seed = 1; seed <= 40; seed += 1) {
            const rand = rng(seed * 7919 + cfg.label.length);
            const a = makeLive(cfg, retention);
            const b = makeLive(cfg, retention);
            const logA = recordSignals(a, watched ? record(a) : []);
            const logB = recordSignals(b, watched ? record(b) : []);
            let last = 0;
            const batches = 1 + Math.floor(rand() * 6);
            for (let k = 0; k < batches; k += 1) {
              const n = SIZES[Math.floor(rand() * SIZES.length)]!;
              const late = cfg.late || rand() < 0.1;
              const offset = late
                ? (Math.floor(rand() * 7) - 4) * 1000
                : Math.floor(rand() * 3) * 500;
              const ts = makeBatch(rand, cfg, n, last + offset);
              if (n > 0) {
                last = Math.max(last, ts.keyColumn().begin[n - 1]!);
              }
              const errA = attempt(() => a.pushMany(ts.toRows() as never));
              const errB = attempt(() => b.pushSeries(ts));
              const where = `seed ${seed} batch ${k}`;
              expect(errB, where).toEqual(errA);
              expect(state(b), where).toEqual(state(a));
              expect(logB, where).toEqual(logA);
            }
          }
        });
      }
    }
  }
});

describe('pushSeries matches pushMany with views on the series', () => {
  it('filter view, aggregate and reduce outputs agree', () => {
    const schema = schemaFor('time');
    const build = () => {
      const live = new LiveSeries({
        name: 'live',
        schema,
        retention: { maxEvents: 50 },
      });
      const view = live.filter((e) => (e.get('v') as number) > 30);
      const agg = live.aggregate(Sequence.every('2s'), { v: 'sum' });
      const red = live.reduce({ v: 'sum' });
      const seen: unknown[] = [];
      red.on('event', (e) => seen.push(e.get('v')));
      return { live, view, agg, red, seen };
    };
    const a = build();
    const b = build();
    const rand = rng(42);
    const cfg = CONFIGS[0]!;
    let last = 0;
    for (let k = 0; k < 12; k += 1) {
      const ts = makeBatch(rand, cfg, 1 + Math.floor(rand() * 30), last + 500);
      last = ts.keyColumn().begin[ts.length - 1]!;
      a.live.pushMany(ts.toRows() as never);
      b.live.pushSeries(ts as never);
    }
    expect(b.view.toTimeSeries().toRows()).toEqual(
      a.view.toTimeSeries().toRows(),
    );
    expect(b.view.length).toBeGreaterThan(0);
    expect(b.agg.closed().toRows()).toEqual(a.agg.closed().toRows());
    expect(b.red.value()).toEqual(a.red.value());
    expect(a.seen.length).toBe(12);
    expect(b.seen).toEqual(a.seen);
  });
});

// ── Targeted tests ─────────────────────────────────────────────

const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'price', kind: 'number' },
  { name: 'size', kind: 'number', required: false },
  { name: 'venue', kind: 'string', required: false },
] as const;

function ticks(times: number[], price?: number[], venue?: string[]) {
  return TimeSeries.fromColumns({
    name: 'ticks',
    schema: SCHEMA,
    columns: {
      time: new Float64Array(times),
      price: new Float64Array(price ?? times.map((t) => t / 1000)),
      size: new Float64Array(times.map(() => 1)),
      venue: venue ?? times.map(() => 'x'),
    },
  });
}

function watch(live: AnyLive) {
  const seen: string[] = [];
  for (const type of ['event', 'batch', 'evict']) {
    live.on(type as never, (() => seen.push(type)) as never);
  }
  live._onSettle(() => seen.push('settle'));
  return seen;
}

describe('pushSeries on the chunked backing', () => {
  it('adds one chunk per batch and counts every row', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    expect((live as any)._isChunked).toBe(true);
    live.pushSeries(ticks([0, 1000, 2000]));
    live.pushSeries(ticks([3000, 4000]));
    expect(live._chunkCount).toBe(2);
    expect(live.length).toBe(5);
    expect(live.stats().ingested).toBe(5);
    expect(live.at(3)!.get('price')).toBe(3);
  });

  it('every event handler sees the post-batch length', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    const lengths: number[] = [];
    live.on('event', () => lengths.push(live.length));
    live.pushSeries(ticks([0, 1000, 2000]));
    expect(lengths).toEqual([3, 3, 3]);
  });

  it('refuses a first row older than the newest held, with pushMany’s message', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(ticks([0, 1000, 2000]));
    const seen = watch(live as AnyLive);
    const before = live.stats();
    expect(() => live.pushSeries(ticks([1500, 3000]))).toThrow(
      /out-of-order event: timestamp 1500 is before latest 2000/,
    );
    expect(live.length).toBe(3);
    expect(live.stats()).toEqual(before);
    expect(seen).toEqual(['settle']); // a refused push still settles once
  });

  it('accepts a first row equal to the newest held', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(ticks([0, 1000]));
    live.pushSeries(ticks([1000, 2000]));
    expect(live.length).toBe(4);
  });
});

describe('pushSeries empty batches and the guard', () => {
  it('an empty batch of the right shape does nothing', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(ticks([0]));
    const seen = watch(live as AnyLive);
    const before = live.stats();
    live.pushSeries(ticks([]));
    expect(seen).toEqual([]);
    expect(live.stats()).toEqual(before);
  });

  it('an empty batch of the wrong shape still throws, without settling', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    const seen = watch(live as AnyLive);
    const empty = new TimeSeries({
      name: 'thin',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'price', kind: 'number' },
      ] as const,
      rows: [],
    });
    expect(() => live.pushSeries(empty as never)).toThrow(
      /pushSeries: series 'thin' has no column 'size' \(it has: price\)/,
    );
    expect(seen).toEqual([]);
  });

  it('an empty batch pushed from a listener is ignored', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    let settles = 0;
    live._onSettle(() => (settles += 1));
    live.on('batch', () => live.pushSeries(ticks([])));
    live.pushSeries(ticks([0, 1000]));
    expect(settles).toBe(1);
    expect(live.length).toBe(2);
  });

  it('refuses anything that is not a TimeSeries', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    expect(() => live.pushSeries([[0, 1]] as never)).toThrow(
      new TypeError('pushSeries: expected a TimeSeries'),
    );
    expect(() => live.pushSeries({ length: 0 } as never)).toThrow(TypeError);
    const vs = ticks([0, 1000]).byValue('price' as never);
    expect(() => live.pushSeries(vs as never)).toThrow(TypeError);
  });
});

describe('pushSeries shape checks', () => {
  const cases: Array<[string, AnySeries, RegExp]> = [
    [
      'a different key kind',
      new TimeSeries({
        name: 'spans',
        schema: [
          { name: 'timeRange', kind: 'timeRange' },
          { name: 'price', kind: 'number' },
          { name: 'size', kind: 'number', required: false },
          { name: 'venue', kind: 'string', required: false },
        ] as const,
        rows: [[{ start: 0, end: 10 }, 1, 1, 'x']],
      }) as AnySeries,
      /pushSeries: series 'spans' is keyed by 'timeRange', but live series 'x' is keyed by 'time'/,
    ],
    [
      'a missing column',
      new TimeSeries({
        name: 'thin',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'price', kind: 'number' },
          { name: 'venue', kind: 'string', required: false },
        ] as const,
        rows: [[0, 1, 'x']],
      }) as AnySeries,
      /pushSeries: series 'thin' has no column 'size' \(it has: price, venue\)/,
    ],
    [
      'a column of another kind',
      new TimeSeries({
        name: 'odd',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'price', kind: 'number' },
          { name: 'size', kind: 'string', required: false },
          { name: 'venue', kind: 'string', required: false },
        ] as const,
        rows: [[0, 1, 'big', 'x']],
      }) as AnySeries,
      /pushSeries: column 'size' is 'string' in series 'odd' but 'number' in live series 'x'/,
    ],
    [
      'an extra column',
      new TimeSeries({
        name: 'wide',
        schema: [...SCHEMA, { name: 'side', kind: 'string' }] as const,
        rows: [[0, 1, 1, 'x', 'buy']],
      }) as AnySeries,
      /pushSeries: series 'wide' has column 'side', which live series 'x' does not declare/,
    ],
  ];
  for (const [label, series, message] of cases) {
    it(`refuses ${label} with nothing stored`, () => {
      for (const opts of [{}, { ordering: 'drop' }] as const) {
        const live = new LiveSeries({ name: 'x', schema: SCHEMA, ...opts });
        live.pushSeries(ticks([0]));
        const seen = watch(live as AnyLive);
        const before = live.stats();
        let err: unknown;
        try {
          live.pushSeries(series);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as Error).message).toMatch(message);
        expect(live.length).toBe(1);
        expect(live.stats()).toEqual(before);
        expect(seen).toEqual(['settle']);
      }
    });
  }

  it('a value column named like the live key column counts as extra', () => {
    const live = new LiveSeries({
      name: 'x',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
    });
    // A runtime schema: key named `at`, plus a value column named `time`.
    const odd = new TimeSeries({
      name: 'odd',
      schema: [
        { name: 'at', kind: 'time' },
        { name: 'v', kind: 'number' },
        { name: 'time', kind: 'number' },
      ] as never,
      rows: [[0, 1, 2]] as never,
    });
    expect(() => live.pushSeries(odd as never)).toThrow(
      /series 'odd' has column 'time', which live series 'x' does not declare/,
    );
  });

  it('a different key column name is accepted', () => {
    const live = new LiveSeries({
      name: 'x',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as const,
    });
    const other = new TimeSeries({
      name: 'other',
      schema: [
        { name: 'at', kind: 'time' },
        { name: 'v', kind: 'number' },
      ] as never,
      rows: [[5, 1]] as never,
    });
    live.pushSeries(other as never);
    expect(live.at(0)!.begin()).toBe(5);
  });

  it('matches value columns by name, in any order, on both backings', () => {
    for (const opts of [{}, { ordering: 'reorder' }] as const) {
      const live = new LiveSeries({ name: 'x', schema: SCHEMA, ...opts });
      const shuffled = new TimeSeries({
        name: 'shuffled',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'venue', kind: 'string', required: false },
          { name: 'size', kind: 'number', required: false },
          { name: 'price', kind: 'number' },
        ] as const,
        rows: [
          [0, 'a', 10, 1.5],
          [1000, 'b', 20, 2.5],
        ],
      });
      live.pushSeries(shuffled as never);
      expect(live.toRows().map((r) => r.slice(1))).toEqual([
        [1.5, 10, 'a'],
        [2.5, 20, 'b'],
      ]);
    }
  });
});

describe('pushSeries required columns, judged by the live schema', () => {
  const BACKINGS = [{}, { ordering: 'drop' }] as const;

  it('refuses NaN in a required number column (fromColumns Float64Array)', () => {
    for (const opts of BACKINGS) {
      const live = new LiveSeries({ name: 'x', schema: SCHEMA, ...opts });
      const seen = watch(live as AnyLive);
      expect(() =>
        live.pushSeries(ticks([0, 1000, 2000], [1, NaN, 3])),
      ).toThrow(
        new ValidationError('pushSeries: row 1 col 1 (price) is required'),
      );
      expect(live.length).toBe(0);
      expect(seen).toEqual(['settle']);
    }
  });

  it('names the first bad cell in row order, as pushMany does', () => {
    // Gaps at row 3 of `a` and row 1 of `b`: pushMany meets row 1 first.
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'a', kind: 'number' },
      { name: 'b', kind: 'number' },
    ] as const;
    const batch = TimeSeries.fromColumns({
      name: 'b',
      schema,
      columns: {
        time: new Float64Array([0, 1, 2, 3]),
        a: new Float64Array([1, 1, 1, NaN]),
        b: new Float64Array([1, NaN, 1, 1]),
      },
    });
    const viaSeries = new LiveSeries({ name: 'x', schema });
    expect(() => viaSeries.pushSeries(batch)).toThrow(
      new ValidationError('pushSeries: row 1 col 2 (b) is required'),
    );
    const viaMany = new LiveSeries({ name: 'x', schema });
    expect(() =>
      viaMany.pushMany([
        [0, 1, 1],
        [1, 1, undefined],
        [2, 1, 1],
        [3, undefined, 1],
      ] as never),
    ).toThrow(new ValidationError('row 1 col 2 (b) is required'));
  });

  it('refuses null in a required number column (number[] input)', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    const ts = TimeSeries.fromColumns({
      name: 'ticks',
      schema: SCHEMA,
      columns: {
        time: [0, 1000],
        price: [1, null],
        size: [1, 1],
        venue: ['a', 'b'],
      },
    });
    expect(() => live.pushSeries(ts)).toThrow(
      /pushSeries: row 1 col 1 \(price\) is required/,
    );
  });

  it('refuses gaps in required string, boolean and array columns', () => {
    // The batch's own schema calls the column optional; the live one
    // requires it, and the live schema decides.
    for (const [kind, cell] of [
      ['string', 'a'],
      ['boolean', true],
      ['array', ['a']],
    ] as const) {
      const loose = new TimeSeries({
        name: 'loose',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'c', kind, required: false },
        ] as never,
        rows: [
          [0, cell],
          [1000, undefined],
        ] as never,
      });
      for (const opts of BACKINGS) {
        const live: AnyLive = new LiveSeries({
          name: 'x',
          schema: [
            { name: 'time', kind: 'time' },
            { name: 'c', kind },
          ],
          ...opts,
        } as never);
        expect(() => live.pushSeries(loose)).toThrow(
          /pushSeries: row 1 col 1 \(c\) is required/,
        );
        expect(live.length).toBe(0);
      }
    }
  });

  it('stores the same gaps in an optional live column', () => {
    for (const opts of BACKINGS) {
      const live = new LiveSeries({
        name: 'x',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'price', kind: 'number', required: false },
        ] as const,
        ...opts,
      });
      live.pushSeries(
        TimeSeries.fromColumns({
          name: 'ticks',
          schema: [
            { name: 'time', kind: 'time' },
            { name: 'price', kind: 'number', required: false },
          ] as const,
          columns: {
            time: new Float64Array([0, 1000, 2000]),
            price: new Float64Array([1, NaN, Infinity]),
          },
        }),
      );
      expect(live.toRows().map((r) => r[1])).toEqual([1, undefined, undefined]);
      expect(live.stats().ingested).toBe(3);
    }
  });

  it('passes a sliced column whose gaps fall outside the slice', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    const full = ticks([0, 1000, 2000, 3000], [NaN, 2, 3, 4]);
    live.pushSeries(full.slice(1, 4) as never);
    expect(live.toRows().map((r) => r[1])).toEqual([2, 3, 4]);
  });
});

describe('pushSeries value kinds beyond fromColumns', () => {
  const schema = [
    { name: 'time', kind: 'time' },
    { name: 'ok', kind: 'boolean' },
    { name: 'tags', kind: 'array', required: false },
    { name: 'host', kind: 'string' },
  ] as const;
  const rows = [
    [0, true, ['a', 'b'], 'h1'],
    [1000, false, undefined, 'h1'],
    [2000, true, ['c'], 'h2'],
  ] as const;

  it('boolean and array columns land the same as pushMany', () => {
    for (const opts of [{}, { ordering: 'reorder' }] as const) {
      const a = new LiveSeries({ name: 'x', schema, ...opts });
      const b = new LiveSeries({ name: 'x', schema, ...opts });
      a.pushMany(rows as never);
      b.pushSeries(new TimeSeries({ name: 'b', schema, rows: rows as never }));
      expect(b.toRows()).toEqual(a.toRows());
    }
  });

  it('a dictionary-encoded string column reads back', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    const n = 2000;
    const times = Array.from({ length: n }, (_, i) => i * 10);
    const venues = times.map((_, i) => `v${i % 4}`);
    live.pushSeries(ticks(times, undefined, venues));
    expect(live.at(1999)!.get('venue')).toBe('v3');
    expect(live.toRows().map((r) => r[3])).toEqual(venues);
  });
});

describe('pushSeries shares the batch buffers on the chunked backing', () => {
  it('a write to a pushed Float64Array shows in rows not yet read', () => {
    const price = new Float64Array([1, 2, 3]);
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(
      TimeSeries.fromColumns({
        name: 't',
        schema: SCHEMA,
        columns: {
          time: new Float64Array([0, 1000, 2000]),
          price,
          size: new Float64Array([1, 1, 1]),
          venue: ['a', 'a', 'a'],
        },
      }),
    );
    const snapshot = live.toTimeSeries();
    price[2] = 99;
    // Row 2 was never read, so nothing cached it: the write shows.
    expect(live.at(2)!.get('price')).toBe(99);
    // A snapshot taken before the write is its own copy.
    expect(snapshot.at(2)!.get('price')).toBe(3);
  });

  it('per-row backings copy into events, so a later write does not show', () => {
    for (const opts of [
      { ordering: 'drop' },
      { ordering: 'reorder' },
      { __backing: 'array' },
    ] as const) {
      const price = new Float64Array([1, 2, 3]);
      const live = new LiveSeries({ name: 'x', schema: SCHEMA, ...opts });
      live.pushSeries(
        TimeSeries.fromColumns({
          name: 't',
          schema: SCHEMA,
          columns: {
            time: new Float64Array([0, 1000, 2000]),
            price,
            size: new Float64Array([1, 1, 1]),
            venue: ['a', 'a', 'a'],
          },
        }),
      );
      price[2] = 99;
      expect(live.at(2)!.get('price')).toBe(3);
    }
  });

  /** A batch whose columns are views into one buffer of `bytes`. */
  function viewsBatch(n: number, bytes: number) {
    const buf = new ArrayBuffer(bytes);
    const time = new Float64Array(buf, 0, n);
    const price = new Float64Array(buf, n * 8, n);
    const size = new Float64Array(buf, n * 16, n);
    for (let i = 0; i < n; i += 1) {
      time[i] = i * 1000;
      price[i] = i;
      size[i] = 1;
    }
    const venue = Array.from({ length: n }, () => 'a');
    const batch = TimeSeries.fromColumns({
      name: 't',
      schema: SCHEMA,
      columns: { time, price, size, venue },
    });
    return { batch, price };
  }

  it('keeps views into a buffer up to twice the batch (a worker message)', () => {
    // 4 rows x 4 columns x 8 bytes x 2 = 256.
    const { batch, price } = viewsBatch(4, 256);
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(batch);
    price[3] = 99;
    expect(live.toTimeSeries().at(3)!.get('price')).toBe(99);
  });

  it('copies views into a bigger buffer, so they do not keep it alive', () => {
    const { batch, price } = viewsBatch(4, 264);
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(batch);
    const rows = batch.toRows();
    price[3] = 99;
    expect(live.toTimeSeries().toRows()).toEqual(rows);
    expect(live.toTimeSeries().at(3)!.get('price')).toBe(3);
  });

  it('copies a slice of a bigger series', () => {
    const n = 2_000;
    const time = Float64Array.from({ length: n }, (_, i) => i * 1000);
    const price = Float64Array.from({ length: n }, (_, i) => i);
    const big = TimeSeries.fromColumns({
      name: 'history',
      schema: SCHEMA,
      columns: {
        time,
        price,
        size: new Float64Array(n).fill(1),
        venue: Array.from({ length: n }, (_, i) => `v${i % 3}`),
      },
    });
    const seed = big.slice(n - 100, n);
    const viaMany = new LiveSeries({ name: 'x', schema: SCHEMA });
    viaMany.pushMany(seed.toRows() as never);
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(seed);
    time[n - 1] = 0;
    price[n - 1] = -1;
    expect(live.toTimeSeries().toRows()).toEqual(
      viaMany.toTimeSeries().toRows(),
    );
  });

  it('the copy owns every buffer, a dictionary string column included', () => {
    const n = 2_000;
    const big = TimeSeries.fromColumns({
      name: 'history',
      schema: SCHEMA,
      columns: {
        time: Float64Array.from({ length: n }, (_, i) => i * 1000),
        price: new Float64Array(n).fill(1),
        size: new Float64Array(n).fill(1),
        venue: Array.from({ length: n }, (_, i) => `v${i % 3}`),
      },
    });
    const seed = big.slice(n - 100, n);
    const venue = seed.column('venue') as unknown as { indices?: Int32Array };
    // The slice's columns are views into the parent's buffers.
    expect(venue.indices!.buffer.byteLength).toBe(n * 4);
    const columns = new Map(
      ['price', 'size', 'venue'].map((name) => [
        name,
        seed.column(name as 'price') as any,
      ]),
    );
    const key = copyBatch(seed.keyColumn() as any, columns, 100);
    expect(key.begin.buffer.byteLength).toBe(100 * 8);
    for (const name of ['price', 'size']) {
      expect(columns.get(name)._values.buffer.byteLength).toBe(100 * 8);
    }
    expect(columns.get('venue').indices.buffer.byteLength).toBe(100 * 4);
    expect(
      Array.from({ length: 100 }, (_, i) => columns.get('venue').read(i)),
    ).toEqual(Array.from({ length: 100 }, (_, i) => `v${(n - 100 + i) % 3}`));
  });
});

describe('pushSeries retention', () => {
  it('a big batch into a small window equals pushMany, rows, stats and evict', () => {
    for (const retention of [{ maxEvents: 1000 }, { maxAge: '30s' }] as const) {
      const a = new LiveSeries({ name: 'x', schema: SCHEMA, retention });
      const b = new LiveSeries({ name: 'x', schema: SCHEMA, retention });
      const evA: number[] = [];
      const evB: number[] = [];
      a.on('evict', (es) => evA.push(es.length, es[0]!.begin()));
      b.on('evict', (es) => evB.push(es.length, es[0]!.begin()));
      for (let k = 0; k < 3; k += 1) {
        const times = Array.from(
          { length: 10_000 },
          (_, i) => (k * 10_000 + i) * 10,
        );
        const ts = ticks(times);
        a.pushMany(ts.toRows() as never);
        b.pushSeries(ts);
      }
      expect(b.length).toBe(a.length);
      expect(b.stats()).toEqual(a.stats());
      expect(evB).toEqual(evA);
      expect(b.toRows()).toEqual(a.toRows());
    }
  });
});

describe('pushSeries ordering modes', () => {
  it('drop: a late prefix is counted as rejected and fires nothing', () => {
    const live = new LiveSeries({
      name: 'x',
      schema: SCHEMA,
      ordering: 'drop',
    });
    live.pushSeries(ticks([5000]));
    const begins: number[] = [];
    live.on('event', (e) => begins.push(e.begin()));
    live.on('batch', (es) => begins.push(-es.length));
    live.pushSeries(ticks([3000, 4000, 6000, 7000]));
    expect(begins).toEqual([6000, 7000, -2]);
    expect(live.stats().rejected).toBe(2);
    expect(live.length).toBe(3);
  });

  it('drop: an all-late batch stores nothing but still settles', () => {
    const live = new LiveSeries({
      name: 'x',
      schema: SCHEMA,
      ordering: 'drop',
    });
    live.pushSeries(ticks([5000]));
    const seen = watch(live as AnyLive);
    live.pushSeries(ticks([1000, 2000]));
    expect(seen).toEqual(['settle']);
    expect(live.length).toBe(1);
    expect(live.stats().rejected).toBe(2);
  });

  it('reorder: late rows within grace are sorted in, listeners see batch order', () => {
    const live = new LiveSeries({
      name: 'x',
      schema: SCHEMA,
      ordering: 'reorder',
      graceWindow: '5s',
    });
    live.pushSeries(ticks([5000, 6000]));
    const begins: number[] = [];
    live.on('event', (e) => begins.push(e.begin()));
    live.pushSeries(ticks([2000, 7000]));
    expect(begins).toEqual([2000, 7000]);
    expect(live.toRows().map((r) => (r[0] as any).begin())).toEqual([
      2000, 5000, 6000, 7000,
    ]);
  });

  it('reorder: a row past grace refuses the batch', () => {
    const live = new LiveSeries({
      name: 'x',
      schema: SCHEMA,
      ordering: 'reorder',
      graceWindow: '1s',
    });
    live.pushSeries(ticks([5000, 6000]));
    expect(() => live.pushSeries(ticks([2000, 7000]))).toThrow(
      /outside grace window/,
    );
    expect(live.length).toBe(2);
  });

  it('the batch is already sorted, unlike pushMany of the raw arrival order', () => {
    // Held max 3000. Arrival [10000, 2000, 12000]: pushMany under drop
    // drops 2000 (it arrives after 10000). A series built with
    // `ordering: 'reorder'` sorts it to the front, where it is late
    // against the held 3000 and dropped too, but 10000 and 12000 keep
    // their sorted places. The difference shows under reorder.
    const make = () =>
      new LiveSeries({
        name: 'x',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'v', kind: 'number' },
        ] as const,
        ordering: 'drop',
      });
    const a = make();
    const b = make();
    a.push([3000, 0]);
    b.push([3000, 0]);
    a.pushMany([
      [10_000, 1],
      [5000, 2],
      [12_000, 3],
    ]);
    b.pushSeries(
      TimeSeries.fromColumns({
        name: 'arrivals',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'v', kind: 'number' },
        ] as const,
        columns: { time: [10_000, 5000, 12_000], v: [1, 2, 3] },
        ordering: 'reorder',
      }),
    );
    expect(a.toRows().map((r) => r[1])).toEqual([0, 1, 3]); // 5000 dropped
    expect(b.toRows().map((r) => r[1])).toEqual([0, 2, 1, 3]); // 5000 kept
  });
});

describe('pushSeries interval keys', () => {
  const schema = [
    { name: 'interval', kind: 'interval' },
    { name: 'v', kind: 'number' },
  ] as const;
  const spans = (labels: Array<string | number>, start: number) =>
    TimeSeries.fromColumns({
      name: 'spans',
      schema,
      columns: {
        interval: labels.map((_, i) => start + i * 10),
        intervalEnd: labels.map((_, i) => start + i * 10 + 10),
        intervalLabel: labels as never,
        v: labels.map((_, i) => i),
      },
    });

  it('keeps each row’s label', () => {
    const live = new LiveSeries({ name: 'x', schema });
    live.pushSeries(spans(['a', 'b'], 0));
    const keys = live.toRows().map((r) => r[0] as Interval);
    expect(keys.every((k) => k instanceof Interval)).toBe(true);
    expect(keys.map((k) => k.value)).toEqual(['a', 'b']);
  });

  it('refuses labels of another type than the rows held', () => {
    const live = new LiveSeries({ name: 'x', schema });
    live.pushSeries(spans(['a'], 0));
    expect(() => live.pushSeries(spans([1, 2], 10))).toThrow(/one label type/);
    expect(live.length).toBe(1);
  });
});

describe('pushSeries listener errors', () => {
  for (const opts of [{}, { ordering: 'drop' }] as const) {
    it(`a throwing event listener does not stop the push (${JSON.stringify(opts)})`, () => {
      const live = new LiveSeries({
        name: 'x',
        schema: SCHEMA,
        retention: { maxEvents: 2 },
        ...opts,
      });
      const seen = watch(live as AnyLive);
      live.on('event', () => {
        throw new Error('boom');
      });
      expect(() => live.pushSeries(ticks([0, 1000, 2000]))).toThrow('boom');
      expect(live.length).toBe(2);
      expect(live.stats().ingested).toBe(3);
      expect(live.stats().evicted).toBe(1);
      expect(seen.filter((s) => s !== 'event')).toEqual([
        'batch',
        'evict',
        'settle',
      ]);
    });
  }
});

describe('pushSeries from inside a listener', () => {
  it('queues behind the current push, in order with pushMany', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    let settles = 0;
    live._onSettle(() => (settles += 1));
    let fired = false;
    live.on('event', () => {
      if (fired) return;
      fired = true;
      live.pushMany([[3000, 3, 1, 'x']]);
      live.pushSeries(ticks([4000, 5000]));
      live.pushMany([[6000, 6, 1, 'x']]);
    });
    live.pushSeries(ticks([0, 1000]));
    expect(live.toRows().map((r) => (r[0] as any).begin())).toEqual([
      0, 1000, 3000, 4000, 5000, 6000,
    ]);
    expect(settles).toBe(4);
  });

  it('a queued late batch throws to the outer caller after the drain', () => {
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    let fired = false;
    live.on('batch', () => {
      if (fired) return;
      fired = true;
      live.pushSeries(ticks([500])); // late against 1000
      live.pushMany([[2000, 2, 1, 'x']]);
    });
    expect(() => live.pushSeries(ticks([0, 1000]))).toThrow(
      /out-of-order event: timestamp 500 is before latest 1000/,
    );
    expect(live.toRows().map((r) => (r[0] as any).begin())).toEqual([
      0, 1000, 2000,
    ]);
  });
});

describe('pushSeries into a partitioned source', () => {
  // `toMap()` hands back each partition as a `LiveSource`.
  const rowsOf = (part: unknown) => (part as AnyLive).toRows();
  const HOSTS = ['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'];

  function feed(rand: () => number, k: number) {
    const n = 1 + Math.floor(rand() * 40);
    const times = Array.from({ length: n }, (_, i) => k * 1000 + i);
    const price = new Float64Array(times.map((t) => t / 1000));
    const ts = TimeSeries.fromColumns({
      name: 'ticks',
      schema: SCHEMA,
      columns: {
        time: new Float64Array(times),
        price,
        size: new Float64Array(n).fill(1),
        venue: times.map(() => HOSTS[Math.floor(rand() * HOSTS.length)]!),
      },
    });
    return { ts, price };
  }

  for (const partOpts of [{}, { ordering: 'drop' }] as const) {
    it(`partitions equal pushMany’s (${JSON.stringify(partOpts)})`, () => {
      const build = () => {
        const live = new LiveSeries({ name: 'x', schema: SCHEMA });
        const parts = live.partitionBy('venue', partOpts as never);
        return { live, parts };
      };
      const a = build();
      const b = build();
      const rand = rng(7);
      const buffers: Float64Array[] = [];
      for (let k = 0; k < 20; k += 1) {
        const { ts, price } = feed(rand, k);
        buffers.push(price);
        a.live.pushMany(ts.toRows() as never);
        b.live.pushSeries(ts);
      }
      const mapA = a.parts.toMap();
      const mapB = b.parts.toMap();
      expect([...mapB.keys()].sort()).toEqual([...mapA.keys()].sort());
      for (const [key, part] of mapA) {
        expect(rowsOf(mapB.get(key))).toEqual(rowsOf(part));
      }
      expect(b.parts.stats()).toEqual(a.parts.stats());
      expect(b.parts.collect().toRows()).toEqual(a.parts.collect().toRows());

      // Partitions copy what they route: writing the batch buffers after
      // the push leaves them alone.
      const before = rowsOf(mapB.get('h0'));
      for (const price of buffers) price.fill(-1);
      expect(rowsOf(mapB.get('h0'))).toEqual(before);
      // ...while the source itself shares them (the documented contract).
      expect(b.live.at(b.live.length - 1)!.get('price')).toBe(-1);
    });
  }

  it('a row for an undeclared group: same outcome as pushMany', () => {
    // Today a router error on the chunked backing skips the source's own
    // retention and 'batch' ([PND-ONCHUNKISO], open). pushSeries goes
    // through the same commit, so it must match pushMany either way.
    const build = () => {
      const live = new LiveSeries({
        name: 'x',
        schema: SCHEMA,
        retention: { maxEvents: 2 },
      });
      const parts = live.partitionBy('venue', { groups: ['a'] } as never);
      const seen = watch(live as AnyLive);
      return { live, parts, seen };
    };
    const a = build();
    const b = build();
    const ts = ticks([0, 1000, 2000], undefined, ['a', 'ROGUE', 'a']);
    const errA = attempt(() => a.live.pushMany(ts.toRows() as never));
    const errB = attempt(() => b.live.pushSeries(ts));
    expect(errB).toEqual(errA);
    expect(errA).not.toBeNull();
    expect(b.live.toRows()).toEqual(a.live.toRows());
    expect(b.live.stats()).toEqual(a.live.stats());
    expect(b.seen).toEqual(a.seen);
    expect(rowsOf(b.parts.toMap().get('a'))).toEqual(
      rowsOf(a.parts.toMap().get('a')),
    );
  });
});
