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
import { batchHoldsExtra, copyBatch } from '../../src/live/live-series.js';
import { BooleanColumn, Float64Column } from '../../src/columnar/column.js';
import {
  ChunkedFloat64Column,
  ChunkedStringColumn,
} from '../../src/columnar/chunked-column.js';
import { TimeKeyColumn } from '../../src/columnar/key-column.js';
import { stringColumnDictEncoded } from '../../src/columnar/string-column.js';
import { validityFromBits } from '../../src/columnar/validity.js';
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

  // 12 rows as well as 3: a default series copies a batch of 8 rows or
  // fewer, so only the longer batch keeps its own boolean and array columns.
  const twelve = Array.from({ length: 12 }, (_, i) => [
    i * 1000,
    i % 3 !== 1,
    i % 4 === 1 ? undefined : i % 2 === 0 ? [`t${i}`] : [`t${i}`, 'x'],
    i % 2 === 0 ? 'h1' : 'h2',
  ]);

  it('boolean and array columns land the same as pushMany', () => {
    for (const batch of [rows, twelve]) {
      for (const opts of [{}, { ordering: 'reorder' }] as const) {
        const a = new LiveSeries({ name: 'x', schema, ...opts });
        const b = new LiveSeries({ name: 'x', schema, ...opts });
        a.pushMany(batch as never);
        b.pushSeries(
          new TimeSeries({ name: 'b', schema, rows: batch as never }),
        );
        expect(b.toRows()).toEqual(a.toRows());
      }
    }
    // The 12-row batch is kept as it is, not copied.
    const kept = new TimeSeries({ name: 'b', schema, rows: twelve as never });
    const columns = new Map(
      ['ok', 'tags', 'host'].map((name) => [
        name,
        kept.column(name as 'ok') as any,
      ]),
    );
    expect(batchHoldsExtra(kept.keyColumn() as any, columns, 12)).toBe(false);
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
  /** A fresh batch of `n` rows, with its `price` array. */
  function freshBatch(n: number) {
    const price = Float64Array.from({ length: n }, (_, i) => i + 1);
    const batch = TimeSeries.fromColumns({
      name: 't',
      schema: SCHEMA,
      columns: {
        time: Float64Array.from({ length: n }, (_, i) => i * 1000),
        price,
        size: new Float64Array(n).fill(1),
        venue: Array.from({ length: n }, () => 'a'),
      },
    });
    return { batch, price };
  }

  it('a write to a pushed Float64Array shows in rows not yet read', () => {
    const { batch, price } = freshBatch(9);
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(batch);
    const snapshot = live.toTimeSeries();
    price[8] = 99;
    // Row 8 was never read, so nothing cached it: the write shows.
    expect(live.at(8)!.get('price')).toBe(99);
    // A snapshot taken before the write is its own copy.
    expect(snapshot.at(8)!.get('price')).toBe(9);
  });

  it('a batch of 8 rows or fewer is copied, so a later write does not show', () => {
    for (const n of [1, 8]) {
      const { batch, price } = freshBatch(n);
      const live = new LiveSeries({ name: 'x', schema: SCHEMA });
      live.pushSeries(batch);
      price[n - 1] = 99;
      expect(live.at(n - 1)!.get('price')).toBe(n);
    }
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
    // The rows use 10 x 3 number columns (time, price, size) x 8 bytes =
    // 240; twice that is 480. (A 10-row text column is a plain list, not
    // dictionary-encoded, so it holds no typed array.)
    const { batch, price } = viewsBatch(10, 480);
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(batch);
    price[9] = 99;
    expect(live.toTimeSeries().at(9)!.get('price')).toBe(99);
  });

  it('copies views into a bigger buffer, so they do not keep it alive', () => {
    const { batch, price } = viewsBatch(10, 488);
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(batch);
    const rows = batch.toRows();
    price[9] = 99;
    expect(live.toTimeSeries().toRows()).toEqual(rows);
    expect(live.toTimeSeries().at(9)!.get('price')).toBe(9);
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

describe('pushSeries copies a batch that holds more than its rows need', () => {
  /**
   * A history of `n` rows whose `venue` cycles through `distinct` values
   * (dictionary-encoded when `distinct` is under half of `n`), with a gap
   * in `venue` every `gapEvery` rows when given.
   */
  function history(n: number, distinct: number, gapEvery = 0) {
    const time = Float64Array.from({ length: n }, (_, i) => i * 1000);
    const price = Float64Array.from({ length: n }, (_, i) => i);
    const venue = Array.from({ length: n }, (_, i) =>
      gapEvery > 0 && i % gapEvery === 0 ? undefined : `v${i % distinct}`,
    );
    const big = TimeSeries.fromColumns({
      name: 'history',
      schema: SCHEMA,
      columns: { time, price, size: new Float64Array(n).fill(1), venue },
    });
    return { big, price, venue };
  }

  /** A batch's key and value columns, as `pushSeries` passes them. */
  function parts(series: AnySeries) {
    const columns = new Map<string, any>(
      ['price', 'size', 'venue'].map((name) => [
        name,
        series.column(name as 'price'),
      ]),
    );
    return { key: series.keyColumn() as any, columns };
  }

  it('keeps a fresh batch and one buffer of exactly the batch', () => {
    const fresh = parts(ticks([0, 1000, 2000]));
    expect(batchHoldsExtra(fresh.key, fresh.columns, 3)).toBe(false);
    // 32 rows: time, price and size in one buffer, venue dictionary-encoded.
    const n = 32;
    const buf = new ArrayBuffer(n * 24);
    const time = new Float64Array(buf, 0, n);
    for (let i = 0; i < n; i += 1) time[i] = i * 1000;
    const message = TimeSeries.fromColumns({
      name: 't',
      schema: SCHEMA,
      columns: {
        time,
        price: new Float64Array(buf, n * 8, n),
        size: new Float64Array(buf, n * 16, n),
        venue: Array.from({ length: n }, (_, i) => (i % 2 ? 'a' : 'b')),
      },
    });
    const m = parts(message);
    expect(m.columns.get('venue').dictionary).toEqual(['b', 'a']);
    expect(batchHoldsExtra(m.key, m.columns, n)).toBe(false);
  });

  it('copies a slice of a bigger history, not the whole history', () => {
    const { big } = history(2_000, 3);
    const seed = parts(big.slice(1_900, 2_000));
    expect(batchHoldsExtra(seed.key, seed.columns, 100)).toBe(true);
    const whole = parts(big);
    expect(batchHoldsExtra(whole.key, whole.columns, 2_000)).toBe(false);
  });

  it('copies a compact key over value views (asTime center of a slice)', () => {
    const n = 2_000;
    const begin = Float64Array.from({ length: n }, (_, i) => i * 1000);
    const price = Float64Array.from({ length: n }, (_, i) => i);
    const bars = TimeSeries.fromColumns({
      name: 'bars',
      schema: [
        { name: 'timeRange', kind: 'timeRange' },
        { name: 'price', kind: 'number' },
        { name: 'size', kind: 'number', required: false },
        { name: 'venue', kind: 'string', required: false },
      ] as const,
      columns: {
        timeRange: begin,
        timeRangeEnd: begin.map((t) => t + 1000),
        price,
        size: new Float64Array(n).fill(1),
        // All distinct, so the text column copies when sliced and only
        // the number columns can hold the bars' buffers.
        venue: Array.from({ length: n }, (_, i) => `v${i}`),
      } as never,
    });
    const seed = bars.slice(n - 100, n).asTime({ at: 'center' });
    const p = parts(seed as AnySeries);
    // The key is new and compact; the value columns still view the bars.
    expect(p.key.begin.buffer.byteLength).toBe(100 * 8);
    expect(p.columns.get('price')._values.buffer.byteLength).toBe(n * 8);
    expect(batchHoldsExtra(p.key, p.columns, 100)).toBe(true);
    const viaMany = new LiveSeries({ name: 'x', schema: SCHEMA });
    viaMany.pushMany(seed.toRows() as never);
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(seed as never);
    price[n - 1] = -1;
    expect(live.toTimeSeries().toRows()).toEqual(
      viaMany.toTimeSeries().toRows(),
    );
  });

  it('copies a text column whose dictionary is much bigger than the batch', () => {
    const { big } = history(2_000, 900);
    const full = big.column('venue') as any;
    expect(full.dictionary.length).toBe(900);
    // A gather copies the indices (compact) but shares the dictionary, so
    // only the dictionary rule can catch it.
    const rows = Int32Array.from({ length: 100 }, (_, i) => 1_900 + i);
    const venue = full.sliceByIndices(rows);
    expect(venue.indices.buffer.byteLength).toBe(100 * 4);
    const key = new TimeKeyColumn(
      Float64Array.from({ length: 100 }, (_, i) => i * 1000),
      100,
    );
    expect(batchHoldsExtra(key, new Map([['venue', venue]]), 100)).toBe(true);
    // Copied past twice as many entries as rows.
    for (const [rows, distinct, copies] of [
      [200, 400, false],
      [200, 401, true],
      [16, 32, false],
      [16, 33, true],
    ] as const) {
      const gathered = (
        history(1_000, distinct).big.column('venue') as any
      ).sliceByIndices(Int32Array.from({ length: rows }, (_, i) => i));
      expect(gathered.dictionary.length).toBe(distinct);
      const k = new TimeKeyColumn(
        Float64Array.from({ length: rows }, (_, i) => i * 1000),
        rows,
      );
      expect(batchHoldsExtra(k, new Map([['venue', gathered]]), rows)).toBe(
        copies,
      );
    }
  });

  it('counts text indices, validity and boolean bits in a bigger buffer', () => {
    const key = new TimeKeyColumn(
      Float64Array.from({ length: 100 }, (_, i) => i * 1000),
      100,
    );
    // A range slice shares the text column's indices buffer: with a small
    // dictionary and every other column fresh, the indices alone decide.
    const ranged = (history(2_000, 3).big.column('venue') as any).sliceByRange(
      1_900,
      2_000,
    );
    expect(ranged.indices.buffer.byteLength).toBe(2_000 * 4);
    expect(batchHoldsExtra(key, new Map([['venue', ranged]]), 100)).toBe(true);
    // A validity bitmap in a bigger buffer counts too.
    const bits = new Uint8Array(10_000).fill(0xff);
    const sparse = stringColumnDictEncoded(
      ['a'],
      new Int32Array(100),
      validityFromBits(bits, 100),
    );
    expect(batchHoldsExtra(key, new Map([['venue', sparse]]), 100)).toBe(true);
    // And a boolean column's bits.
    const flags = new BooleanColumn(bits, 100);
    expect(batchHoldsExtra(key, new Map([['flag', flags]]), 100)).toBe(true);
    const ownFlags = new BooleanColumn(new Uint8Array(13), 100);
    expect(batchHoldsExtra(key, new Map([['flag', ownFlags]]), 100)).toBe(
      false,
    );
  });

  describe('counts each kind of array at its true size, at the 2x line', () => {
    // A fresh 100-row key: 800 bytes held, 800 used.
    const key = new TimeKeyColumn(
      Float64Array.from({ length: 100 }, (_, i) => i * 1000),
      100,
    );
    const holds = (columns: Record<string, unknown>) =>
      batchHoldsExtra(key, new Map(Object.entries(columns)) as never, 100);
    const numbers = (bufferLength: number, from = 0) =>
      new Float64Column(
        new Float64Array(bufferLength).subarray(from, from + 100),
        100,
        true,
      );

    it('each check starts its count from zero', () => {
      // Nothing carries over between calls. A key viewing a big buffer is
      // extra every time, including right after a call that saw the same
      // buffer; a batch within the line right after is not.
      const viewKey = new TimeKeyColumn(
        new Float64Array(10_000).subarray(0, 100),
        100,
      );
      expect(batchHoldsExtra(viewKey, new Map(), 100)).toBe(true);
      expect(batchHoldsExtra(viewKey, new Map(), 100)).toBe(true);
      expect(holds({ price: numbers(300) })).toBe(false);
    });

    it('a number column viewing a bigger buffer', () => {
      // Used 800 + 800 = 1,600. Held 800 + 8 x the buffer's length.
      expect(holds({ price: numbers(300) })).toBe(false); // 3,200
      expect(holds({ price: numbers(301) })).toBe(true); // 3,208
    });

    it('two columns viewing two buffers count both', () => {
      // Used 2,400. Each alone stays at 2x (above); together they hold
      // 800 + 2,400 + 2,400 = 5,600.
      expect(holds({ price: numbers(300), size: numbers(300, 200) })).toBe(
        true,
      );
    });

    it('two columns viewing one buffer, side by side, count it once', () => {
      const buf = new Float64Array(450);
      const view = (from: number) =>
        new Float64Column(buf.subarray(from, from + 100), 100, true);
      // Used 2,400; held 800 + 3,600 = 4,400 (counted twice: 8,000).
      expect(holds({ price: view(0), size: view(100) })).toBe(false);
    });

    it('an array filling its own buffer between two views keeps the count', () => {
      // Key, price and size view one 5,600-byte buffer; a fresh column sits
      // between price and size. Used 3,200; the line is 6,400. Held 5,600 +
      // 800 = 6,400 with the shared buffer counted once (12,000 if twice).
      const buf = new Float64Array(700);
      const k = new TimeKeyColumn(buf.subarray(0, 100), 100);
      const view = (from: number) =>
        new Float64Column(buf.subarray(from, from + 100), 100, true);
      const fresh = new Float64Column(new Float64Array(100), 100, true);
      const columns = new Map<string, unknown>([
        ['price', view(100)],
        ['fresh', fresh],
        ['size', view(200)],
      ]);
      expect(batchHoldsExtra(k, columns as never, 100)).toBe(false);
    });

    it('text indices viewing a bigger buffer', () => {
      const text = (bufferLength: number) =>
        stringColumnDictEncoded(
          ['a', 'b'],
          new Int32Array(bufferLength).subarray(0, 100),
        );
      // Used 800 + 400 = 1,200. Held 800 + 4 x the buffer's length.
      expect(holds({ venue: text(400) })).toBe(false); // 2,400
      expect(holds({ venue: text(401) })).toBe(true); // 2,404
    });

    it('validity bits in a bigger buffer', () => {
      const text = (bitsLength: number) =>
        stringColumnDictEncoded(
          ['a'],
          new Int32Array(100),
          validityFromBits(new Uint8Array(bitsLength).fill(0xff), 100),
        );
      // Used 800 + 400 + 13 = 1,213. Held 800 + 400 + the bits' buffer.
      expect(holds({ venue: text(1_226) })).toBe(false); // 2,426
      expect(holds({ venue: text(1_227) })).toBe(true); // 2,427
    });

    it('small bit arrays count at their own size, unread', () => {
      // A fresh 13-byte bitmap takes the unread path. Used 1,613; the line
      // is 3,226. Held 800 + 8 x the buffer's length + 13.
      const own = new BooleanColumn(new Uint8Array(13), 100);
      expect(holds({ price: numbers(301), flag: own })).toBe(false); // 3,221
      expect(holds({ price: numbers(302), flag: own })).toBe(true); // 3,229
    });

    it('a small bit array partway into a bigger buffer counts the buffer', () => {
      // 13 bytes at offset 100 of a 4,096-byte buffer: not at offset 0, so
      // its buffer is read and counted.
      const flags = new BooleanColumn(
        new Uint8Array(4_096).subarray(100, 113),
        100,
      );
      expect(holds({ flag: flags })).toBe(true);
    });

    it('a fresh bit array of 64 bytes or less is counted without reading it', () => {
      // A bit array whose \`buffer\` getter records each read.
      const watched = (bytes: number) => {
        const bits = new Uint8Array(bytes);
        const get = Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(Uint8Array.prototype),
          'buffer',
        )!.get!;
        let reads = 0;
        Object.defineProperty(bits, 'buffer', {
          get() {
            reads += 1;
            return get.call(bits);
          },
        });
        return { bits, reads: () => reads };
      };
      for (const [rows, bytes, read] of [
        [512, 64, false],
        [513, 65, true],
      ] as const) {
        const w = watched(bytes);
        const k = new TimeKeyColumn(
          Float64Array.from({ length: rows }, (_, i) => i),
          rows,
        );
        const flags = new BooleanColumn(w.bits, rows);
        batchHoldsExtra(k, new Map([['flag', flags]]) as never, rows);
        expect(w.reads() > 0).toBe(read);
      }
    });

    it('boolean bits in a bigger buffer', () => {
      const flags = (bitsLength: number) =>
        new BooleanColumn(new Uint8Array(bitsLength), 100);
      // Used 800 + 13 = 813. Held 800 + the bits' buffer.
      expect(holds({ flag: flags(826) })).toBe(false); // 1,626
      expect(holds({ flag: flags(827) })).toBe(true); // 1,627
    });

    it('a chunk whose dictionary is much bigger than its rows', () => {
      const four = new TimeKeyColumn(new Float64Array([0, 1, 2, 3]), 4);
      const dict = Array.from({ length: 10 }, (_, i) => `v${i}`);
      const venue = new ChunkedStringColumn([
        stringColumnDictEncoded(dict, Int32Array.of(0, 1)),
        stringColumnDictEncoded(dict, Int32Array.of(2, 3)),
      ]);
      expect(
        batchHoldsExtra(four, new Map([['venue', venue]]) as never, 4),
      ).toBe(true);
    });
  });

  it('the copy trims a dictionary only past twice its rows', () => {
    for (const [rows, distinct, trims] of [
      [200, 400, false],
      [200, 401, true],
      [16, 32, false],
      [16, 33, true],
      [5, 10, false],
      [5, 11, true],
    ] as const) {
      const { big } = history(1_000, distinct);
      const parent = big.column('venue') as any;
      const p = parts(big.slice(0, rows));
      copyBatch(p.key, p.columns, rows);
      const copied = p.columns.get('venue');
      expect(copied.dictionary === parent.dictionary).toBe(!trims);
      expect(copied.dictionary.length).toBe(trims ? rows : distinct);
      expect(Array.from({ length: rows }, (_, i) => copied.read(i))).toEqual(
        Array.from({ length: rows }, (_, i) => `v${i}`),
      );
    }
  });

  it('a tail of 8 rows or fewer is copied with its dictionary trimmed', () => {
    for (const k of [5, 8]) {
      const { big, venue } = history(2_000, 900);
      const parent = big.column('venue') as any;
      const live = new LiveSeries({ name: 'x', schema: SCHEMA });
      live.pushSeries(big.slice(2_000 - k, 2_000));
      // Had the live series kept the slice's indices or the parent's
      // dictionary, these writes would show in rows not yet read.
      parent.indices.fill(0);
      parent.dictionary.fill('changed');
      expect(
        Array.from({ length: k }, (_, i) => live.at(i)!.get('venue')),
      ).toEqual(venue.slice(2_000 - k));
    }
  });

  it('the copy keeps only the dictionary entries its rows use, gaps kept', () => {
    const { big, venue } = history(2_000, 900, 7);
    const seed = big.slice(1_900, 2_000);
    const p = parts(seed);
    copyBatch(p.key, p.columns, 100);
    const copied = p.columns.get('venue');
    const want = venue.slice(1_900, 2_000);
    expect(copied.dictionary.length).toBe(
      new Set(want.filter((v) => v !== undefined)).size,
    );
    expect(Array.from({ length: 100 }, (_, i) => copied.read(i))).toEqual(want);
    // End to end: same rows as pushMany.
    const viaMany = new LiveSeries({ name: 'x', schema: SCHEMA });
    viaMany.pushMany(seed.toRows() as never);
    const live = new LiveSeries({ name: 'x', schema: SCHEMA });
    live.pushSeries(seed);
    expect(live.toTimeSeries().toRows()).toEqual(
      viaMany.toTimeSeries().toRows(),
    );
  });

  it('counts each chunk of a chunked column', () => {
    const key = new TimeKeyColumn(new Float64Array([0, 1, 2, 3]), 4);
    const a = new Float64Column(new Float64Array([1, 2]), 2, true);
    const b = new Float64Column(new Float64Array([3, 4]), 2, true);
    const own = new ChunkedFloat64Column([a, b]);
    expect(batchHoldsExtra(key, new Map([['v', own]]) as never, 4)).toBe(false);
    const view = new Float64Column(
      new Float64Array(1_000).subarray(0, 2),
      2,
      true,
    );
    const pinned = new ChunkedFloat64Column([a, view]);
    expect(batchHoldsExtra(key, new Map([['v', pinned]]) as never, 4)).toBe(
      true,
    );
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

  it('a slice of a bigger series equals pushMany, on every per-row backing', () => {
    // The copy only runs on the default backing; the others turn the
    // slice's rows into events, views and all.
    const n = 2_000;
    const labels = Array.from({ length: n }, (_, i) => `s${i % 5}`);
    const big = spans(labels, 0);
    const seed = big.slice(n - 100, n);
    const rangeSchema = [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const;
    const begin = Float64Array.from({ length: n }, (_, i) => i * 10);
    const ranges = TimeSeries.fromColumns({
      name: 'ranges',
      schema: rangeSchema,
      columns: {
        timeRange: begin,
        timeRangeEnd: begin.map((t) => t + 10),
        v: Float64Array.from({ length: n }, (_, i) => i),
      } as never,
    }).slice(n - 100, n);
    const cases = [
      [schema, seed, {}],
      [rangeSchema, ranges, {}],
      [rangeSchema, ranges, { ordering: 'drop' }],
    ] as const;
    const keyOf = (k: any) => [k.begin(), k.end(), k.value];
    for (const [s, batch, opts] of cases) {
      const viaMany = new LiveSeries({
        name: 'x',
        schema: s,
        ...opts,
      } as never);
      const viaSeries = new LiveSeries({
        name: 'x',
        schema: s,
        ...opts,
      } as never);
      viaMany.pushMany(batch.toRows() as never);
      viaSeries.pushSeries(batch as never);
      const rows = (l: any) =>
        l.toRows().map((r: any[]) => [keyOf(r[0]), ...r.slice(1)]);
      expect(rows(viaSeries)).toEqual(rows(viaMany));
    }
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
