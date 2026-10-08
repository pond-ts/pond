import { describe, expect, it } from 'vitest';
import { Interval, TimeRange, TimeSeries } from '../src/index.js';
import {
  ChunkedFloat64Column,
  ColumnarStore,
  Float64Column,
  TimeKeyColumn,
  type ColumnSchema,
} from '../src/columnar/index.js';
import { joinOp } from '../src/batch/operators/join.js';

/* -------------------------------------------------------------------------- */
/* [PND-JOINCOL] — column-native join.                                         */
/*                                                                             */
/* `join` used to materialise both sides' events, merge one object per output  */
/* row, and re-columnarise. It now merge-walks the key buffers into a pair of  */
/* match indices and passes columns through / gathers them. These pin:         */
/*   1. cell-for-cell equality with the event walk it replaced (differential,  */
/*      every key kind × join type × value kind, duplicate keys, gaps);        */
/*   2. the pass-through: which columns are adopted by reference;              */
/*   3. the edges the event walk handled implicitly (interval labels).         */
/* -------------------------------------------------------------------------- */

type JoinType = 'inner' | 'left' | 'right' | 'outer';
const JOIN_TYPES: readonly JoinType[] = ['inner', 'left', 'right', 'outer'];

/**
 * The pre-[PND-JOINCOL] implementation, verbatim in shape: a merge walk over
 * `series.events` comparing `key().compare(...)`, emitting `{ key, data }`.
 * Kept here as the oracle the column-native path must reproduce.
 */
function eventWalkJoin(
  left: TimeSeries<any>,
  right: TimeSeries<any>,
  joinType: JoinType,
): Array<{ key: any; data: Record<string, unknown> }> {
  const out: Array<{ key: any; data: Record<string, unknown> }> = [];
  const L = left.events;
  const R = right.events;
  const keepLeft = joinType === 'left' || joinType === 'outer';
  const keepRight = joinType === 'right' || joinType === 'outer';
  let i = 0;
  let j = 0;
  while (i < L.length || j < R.length) {
    const l = L[i];
    const r = R[j];
    if (l && !r) {
      if (keepLeft) out.push({ key: l.key(), data: { ...l.data() } });
      i += 1;
      continue;
    }
    if (r && !l) {
      if (keepRight) out.push({ key: r.key(), data: { ...r.data() } });
      j += 1;
      continue;
    }
    const c = l!.key().compare(r!.key());
    if (c === 0) {
      out.push({ key: l!.key(), data: { ...l!.data(), ...r!.data() } });
      i += 1;
      j += 1;
    } else if (c < 0) {
      if (keepLeft) out.push({ key: l!.key(), data: { ...l!.data() } });
      i += 1;
    } else {
      if (keepRight) out.push({ key: r!.key(), data: { ...r!.data() } });
      j += 1;
    }
  }
  return out;
}

function expectSameAsEventWalk(
  left: TimeSeries<any>,
  right: TimeSeries<any>,
  joinType: JoinType,
  joined: TimeSeries<any> = left.join(right, { type: joinType }),
): void {
  const expected = eventWalkJoin(left, right, joinType);
  expect(joined.length).toBe(expected.length);
  const names = joined.schema.slice(1).map((c: { name: string }) => c.name);
  for (let r = 0; r < expected.length; r += 1) {
    const key = joined.at(r)!.key();
    const want = expected[r]!;
    expect(key.type()).toBe(want.key.type());
    expect(key.begin()).toBe(want.key.begin());
    expect(key.end()).toBe(want.key.end());
    if (want.key instanceof Interval) {
      expect((key as Interval).value).toBe(want.key.value);
    }
    for (const name of names) {
      expect((joined.at(r) as any).get(name)).toEqual(want.data[name]);
    }
  }
}

/** Deterministic PRNG so a failing seed reproduces. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type KeyKind = 'time' | 'timeRange' | 'interval-string' | 'interval-number';

/**
 * A random series over a small key domain — so duplicates, one-sided keys,
 * and (for range keys) equal begins with different ends all occur — with a
 * value column of every kind and ~20% gaps.
 */
function randomSeries(
  rand: () => number,
  keyKind: KeyKind,
  prefix: string,
  rows: number,
): TimeSeries<any> {
  const keyCol =
    keyKind === 'time'
      ? { name: 'time', kind: 'time' }
      : keyKind === 'timeRange'
        ? { name: 'range', kind: 'timeRange' }
        : { name: 'interval', kind: 'interval' };
  const schema = [
    keyCol,
    { name: `${prefix}n`, kind: 'number', required: false },
    { name: `${prefix}s`, kind: 'string', required: false },
    { name: `${prefix}b`, kind: 'boolean', required: false },
    { name: `${prefix}a`, kind: 'array', required: false },
  ] as const;
  const gap = <T>(v: T): T | undefined => (rand() < 0.2 ? undefined : v);
  const raw: Array<[number, number, unknown[]]> = [];
  for (let i = 0; i < rows; i += 1) {
    const begin = Math.floor(rand() * 12) * 10;
    const end = begin + Math.floor(rand() * 3) * 5;
    raw.push([
      begin,
      end,
      [
        gap(Math.round(rand() * 1000) / 10),
        gap(['x', 'y', 'z'][Math.floor(rand() * 3)]),
        gap(rand() < 0.5),
        gap([Math.floor(rand() * 5), 'k']),
      ],
    ]);
  }
  // Non-decreasing by (begin, end) — intake's rule. Ties keep generation
  // order, so interval labels within a tie are unsorted, as intake allows.
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const built = raw.map(([begin, end, values]) => {
    const label = Math.floor(rand() * 3);
    const key =
      keyKind === 'time'
        ? begin
        : keyKind === 'timeRange'
          ? new TimeRange({ start: begin, end })
          : new Interval({
              value: keyKind === 'interval-number' ? label : `L${label}`,
              start: begin,
              end,
            });
    return [key, ...values];
  });
  return new TimeSeries({
    name: prefix,
    schema: schema as any,
    rows: built as any,
  });
}

describe('column-native join — differential against the event walk', () => {
  const KEY_KINDS: readonly KeyKind[] = [
    'time',
    'timeRange',
    'interval-string',
    'interval-number',
  ];
  for (const keyKind of KEY_KINDS) {
    it(`matches the event walk cell for cell — ${keyKind} keys, every join type`, () => {
      for (let seed = 1; seed <= 40; seed += 1) {
        const rand = lcg(seed * 7919 + keyKind.length);
        const left = randomSeries(rand, keyKind, 'l', Math.floor(rand() * 25));
        const right = randomSeries(rand, keyKind, 'r', Math.floor(rand() * 25));
        for (const joinType of JOIN_TYPES) {
          expectSameAsEventWalk(left, right, joinType);
        }
      }
    });
  }

  it('matches the event walk on sliced inputs (key and value buffers are offset views)', () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const rand = lcg(seed * 104729);
      for (const keyKind of KEY_KINDS) {
        const left = randomSeries(rand, keyKind, 'l', 30).slice(3, -4);
        const right = randomSeries(rand, keyKind, 'r', 30).slice(5, -2);
        for (const joinType of JOIN_TYPES) {
          expectSameAsEventWalk(left, right, joinType);
        }
      }
    }
  });

  it('matches the event walk through prefix conflict handling', () => {
    const names = ['n', 's', 'b', 'a'];
    const renamed = (p: string) =>
      Object.fromEntries(names.map((c) => [`v${c}`, `${p}_v${c}`]));
    for (let seed = 1; seed <= 20; seed += 1) {
      const rand = lcg(seed * 15485863);
      // Same prefix on both sides, so every value column collides.
      const left = randomSeries(rand, 'time', 'v', Math.floor(rand() * 25));
      const right = randomSeries(rand, 'time', 'v', Math.floor(rand() * 25));
      for (const joinType of JOIN_TYPES) {
        const joined = left.join(right, {
          type: joinType,
          onConflict: 'prefix',
          prefixes: ['l', 'r'],
        });
        expectSameAsEventWalk(
          left.rename(renamed('l') as any) as TimeSeries<any>,
          right.rename(renamed('r') as any) as TimeSeries<any>,
          joinType,
          joined as TimeSeries<any>,
        );
      }
    }
  });

  it('pairs a repeated key one to one, in order — not a cross product', () => {
    const schemaL = [
      { name: 'time', kind: 'time' },
      { name: 'l', kind: 'number' },
    ] as const;
    const schemaR = [
      { name: 'time', kind: 'time' },
      { name: 'r', kind: 'number' },
    ] as const;
    const left = new TimeSeries({
      name: 'l',
      schema: schemaL,
      rows: [
        [10, 1],
        [10, 2],
        [10, 3],
      ],
    });
    const right = new TimeSeries({
      name: 'r',
      schema: schemaR,
      rows: [
        [10, 100],
        [10, 200],
      ],
    });
    const outer = left.join(right);
    expect(outer.toArray().map((e) => [e.get('l'), e.get('r')])).toEqual([
      [1, 100],
      [2, 200],
      [3, undefined],
    ]);
    for (const joinType of JOIN_TYPES) {
      expectSameAsEventWalk(left, right, joinType);
    }
  });
});

describe('column-native join — pass-through', () => {
  const lSchema = [
    { name: 'time', kind: 'time' },
    { name: 'a', kind: 'number' },
    { name: 'tag', kind: 'string' },
  ] as const;
  const rSchema = [
    { name: 'time', kind: 'time' },
    { name: 'b', kind: 'number' },
  ] as const;
  const left = new TimeSeries({
    name: 'left',
    schema: lSchema,
    rows: [
      [0, 1, 'p'],
      [10, 2, 'q'],
      [20, 3, 'r'],
    ],
  });
  const right = new TimeSeries({
    name: 'right',
    schema: rSchema,
    rows: [
      [10, 20],
      [30, 40],
    ],
  });

  it('left join adopts the left key and value columns by reference', () => {
    const j = left.join(right, { type: 'left' });
    expect(j.keyColumn()).toBe(left.keyColumn());
    expect(j.column('a')).toBe(left.column('a'));
    expect(j.column('tag')).toBe(left.column('tag'));
    // The other side is gathered, with the unmatched rows missing.
    expect(j.column('b')).not.toBe(right.column('b'));
    expect(j.toArray().map((e) => e.get('b'))).toEqual([
      undefined,
      20,
      undefined,
    ]);
  });

  it('right join adopts the right value columns by reference, and gathers the key', () => {
    const j = left.join(right, { type: 'right' });
    expect(j.column('b')).toBe(right.column('b'));
    expect(j.toArray().map((e) => e.get('a'))).toEqual([2, undefined]);
    // A matched row carries the LEFT key, so the right key column is never
    // adopted — see the -0 and interval-label tests below.
    expect(j.keyColumn()).not.toBe(right.keyColumn());
    expect(Array.from(j.keyColumn().begin)).toEqual([10, 30]);
  });

  it('a matched row carries the left timestamp bit for bit (0 vs -0)', () => {
    const l = new TimeSeries({
      name: 'l',
      schema: lSchema,
      rows: [
        [0, 1, 'p'],
        [10, 2, 'q'],
      ],
    });
    const r = new TimeSeries({ name: 'r', schema: rSchema, rows: [[-0, 5]] });
    expect(Object.is(r.keyColumn().begin[0], -0)).toBe(true);
    for (const joinType of JOIN_TYPES) {
      const j = l.join(r, { type: joinType });
      expect(Object.is(j.keyColumn().begin[0], 0)).toBe(true);
    }
  });

  it('a one-for-one key match passes both sides through — the shared-grid joinMany case', () => {
    const other = new TimeSeries({
      name: 'other',
      schema: rSchema,
      rows: [
        [0, 5],
        [10, 6],
        [20, 7],
      ],
    });
    for (const joinType of JOIN_TYPES) {
      const j = left.join(other, { type: joinType });
      expect(j.keyColumn()).toBe(left.keyColumn());
      expect(j.column('a')).toBe(left.column('a'));
      expect(j.column('b')).toBe(other.column('b'));
    }
  });

  it('outer join gathers both sides when each has rows the other lacks', () => {
    const j = left.join(right);
    expect(j.column('a')).not.toBe(left.column('a'));
    expect(j.column('b')).not.toBe(right.column('b'));
    expect(Array.from(j.keyColumn().begin)).toEqual([0, 10, 20, 30]);
  });

  it('narrowing the other side with select + rename (the documented recipe) keeps the pass-through', () => {
    const bars = new TimeSeries({
      name: 'bars',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'close', kind: 'number' },
        { name: 'volume', kind: 'number' },
      ] as const,
      rows: [
        [0, 10, 100],
        [10, 11, 110],
      ],
    });
    const spy = new TimeSeries({
      name: 'spy',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'close', kind: 'number' },
        { name: 'volume', kind: 'number' },
      ] as const,
      rows: [[10, 400, 9]],
    });
    const j = bars.join(spy.select('close').rename({ close: 'spy' }), {
      type: 'left',
    });
    expect(j.schema.map((c) => c.name)).toEqual([
      'time',
      'close',
      'volume',
      'spy',
    ]);
    expect(j.column('close')).toBe(bars.column('close'));
    expect(j.column('volume')).toBe(bars.column('volume'));
    expect(j.toArray().map((e) => e.get('spy'))).toEqual([undefined, 400]);
  });

  it('the result is independent of later reads on its inputs', () => {
    const j = left.join(right, { type: 'left' });
    // Sharing is safe because columns are immutable; reading the inputs
    // (which materialises their events) must not disturb the joined series.
    void left.events;
    void right.events;
    expect(j.at(1)!.data()).toEqual({ a: 2, tag: 'q', b: 20 });
  });
});

describe('column-native join — row shape', () => {
  it("an unmatched row's data carries the other side's fields as undefined", () => {
    const left = new TimeSeries({
      name: 'l',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'a', kind: 'number' },
      ] as const,
      rows: [[0, 1]],
    });
    const right = new TimeSeries({
      name: 'r',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'b', kind: 'number' },
      ] as const,
      rows: [[10, 2]],
    });
    const j = left.join(right);
    // Every operator's events carry the full schema; the event walk used to
    // hand back the source event's partial data instead.
    expect(Object.keys(j.at(0)!.data())).toEqual(['a', 'b']);
    expect(j.at(0)!.data()).toStrictEqual({ a: 1, b: undefined });
    expect(j.at(1)!.data()).toStrictEqual({ a: undefined, b: 2 });
  });

  it('keeps the left name and optionalises every value column', () => {
    const left = new TimeSeries({
      name: 'left-name',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'a', kind: 'number' },
      ] as const,
      rows: [[0, 1]],
    });
    const right = new TimeSeries({
      name: 'right-name',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'b', kind: 'number' },
      ] as const,
      rows: [[0, 2]],
    });
    const j = left.join(right);
    expect(j.name).toBe('left-name');
    expect(j.schema).toEqual([
      { name: 'time', kind: 'time' },
      { name: 'a', kind: 'number', required: false },
      { name: 'b', kind: 'number', required: false },
    ]);
  });
});

describe('column-native join — interval labels', () => {
  const lSchema = [
    { name: 'interval', kind: 'interval' },
    { name: 'a', kind: 'number' },
  ] as const;
  const rSchema = [
    { name: 'interval', kind: 'interval' },
    { name: 'b', kind: 'number' },
  ] as const;

  it('a matched row keeps the left label even when the labels only collate equal', () => {
    // `compareIntervalValues` uses `localeCompare`, under which a precomposed
    // and a decomposed é are equal — so these keys match, and the matched row
    // must carry the LEFT label even on a right join, where the right key
    // column would otherwise be the tempting pass-through.
    const precomposed = 'é';
    const decomposed = 'é';
    expect(precomposed.localeCompare(decomposed)).toBe(0);
    // Each side also has a row the other lacks, so no join type is a
    // one-for-one match: `right` reaches the right-side pass-through, and
    // `inner` / `outer` reach the label gather.
    const left = new TimeSeries({
      name: 'l',
      schema: lSchema,
      rows: [
        [new Interval({ value: precomposed, start: 0, end: 10 }), 1],
        [new Interval({ value: 'x', start: 20, end: 30 }), 3],
      ],
    });
    const right = new TimeSeries({
      name: 'r',
      schema: rSchema,
      rows: [
        [new Interval({ value: decomposed, start: 0, end: 10 }), 2],
        [new Interval({ value: 'y', start: 10, end: 20 }), 4],
      ],
    });
    const expectedLength = { inner: 1, left: 2, right: 2, outer: 3 };
    for (const joinType of JOIN_TYPES) {
      const j = left.join(right, { type: joinType });
      expect(j.length).toBe(expectedLength[joinType]);
      expect((j.at(0)!.key() as Interval).value).toBe(precomposed);
      expect(j.at(0)!.data()).toEqual({ a: 1, b: 2 });
      expectSameAsEventWalk(left, right, joinType);
    }
  });

  it('numeric and string labels never match; an outer join keeping both is rejected', () => {
    const left = new TimeSeries({
      name: 'l',
      schema: lSchema,
      rows: [[new Interval({ value: 0, start: 0, end: 10 }), 1]],
    });
    const right = new TimeSeries({
      name: 'r',
      schema: rSchema,
      rows: [[new Interval({ value: '0', start: 0, end: 10 }), 2]],
    });
    expect(left.join(right, { type: 'inner' }).length).toBe(0);
    const lj = left.join(right, { type: 'left' });
    expect((lj.at(0)!.key() as Interval).value).toBe(0);
    expect(lj.at(0)!.get('b')).toBeUndefined();
    const rj = left.join(right, { type: 'right' });
    expect((rj.at(0)!.key() as Interval).value).toBe('0');
    expect(rj.at(0)!.get('a')).toBeUndefined();
    // The event walk produced the same mixed-label rows and threw when it
    // re-columnarised them; the column-native path rejects them directly.
    expect(() => left.join(right, { type: 'outer' })).toThrowError(
      /one label type throughout/,
    );
  });
});

describe('joinOp — storage edges', () => {
  it('gathers a chunked column, padding unmatched rows as missing', () => {
    const schema: ColumnSchema = [
      { name: 'time', kind: 'time' },
      { name: 'x', kind: 'number' },
    ];
    const rSchema: ColumnSchema = [
      { name: 'time', kind: 'time' },
      { name: 'y', kind: 'number' },
    ];
    const left = ColumnarStore.fromTrustedStore(
      schema,
      new TimeKeyColumn(Float64Array.from([0, 10, 20, 30]), 4),
      new Map([
        [
          'x',
          new ChunkedFloat64Column([
            new Float64Column(Float64Array.from([1, 2]), 2),
            new Float64Column(Float64Array.from([3, 4]), 2),
          ]),
        ],
      ]),
    );
    const right = ColumnarStore.fromTrustedStore(
      rSchema,
      new TimeKeyColumn(Float64Array.from([5, 20]), 2),
      new Map([['y', new Float64Column(Float64Array.from([50, 200]), 2)]]),
    );
    const out = joinOp(left, right, 'outer', [
      { name: 'time', kind: 'time' },
      { name: 'x', kind: 'number', required: false },
      { name: 'y', kind: 'number', required: false },
    ]);
    expect(Array.from(out.keys.begin)).toEqual([0, 5, 10, 20, 30]);
    const x = out.columns.get('x')!;
    const y = out.columns.get('y')!;
    expect([0, 1, 2, 3, 4].map((i) => x.read(i))).toEqual([
      1,
      undefined,
      2,
      3,
      4,
    ]);
    expect([0, 1, 2, 3, 4].map((i) => y.read(i))).toEqual([
      undefined,
      50,
      undefined,
      200,
      undefined,
    ]);
  });

  it('handles empty sides for every join type', () => {
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'a', kind: 'number' },
    ] as const;
    const empty = new TimeSeries({ name: 'e', schema, rows: [] });
    const full = new TimeSeries({
      name: 'f',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'b', kind: 'number' },
      ] as const,
      rows: [
        [0, 1],
        [10, 2],
      ],
    });
    for (const joinType of JOIN_TYPES) {
      expectSameAsEventWalk(empty, full, joinType);
      expectSameAsEventWalk(full, empty, joinType);
    }
  });
});
