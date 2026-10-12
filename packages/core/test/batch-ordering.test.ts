import { describe, expect, it } from 'vitest';
import { TimeSeries, ValidationError, ValueSeries } from '../src/index.js';

/* -------------------------------------------------------------------------- */
/* [PND-INGEST] — `ordering: 'strict' | 'reorder' | 'clamp'` on every loader, */
/* with `sort: true` kept as a one-release deprecated alias.                  */
/* -------------------------------------------------------------------------- */

const timeSchema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

const rangeSchema = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'v', kind: 'number' },
] as const;

const intervalSchema = [
  { name: 'interval', kind: 'interval' },
  { name: 'v', kind: 'number' },
] as const;

const axisSchema = [
  { name: 'strike', kind: 'value' },
  { name: 'v', kind: 'number' },
] as const;

const keys = (s: { keyColumn(): { begin: ArrayLike<number> } }) =>
  Array.from(s.keyColumn().begin);

/** Every time-keyed loader, built from the same (time, v) pairs. */
const timeDoors = {
  constructor: (t: number[], v: number[], opts: object) =>
    new TimeSeries({
      name: 's',
      schema: timeSchema,
      rows: t.map((ti, i) => [ti, v[i]!]) as any,
      ...opts,
    }),
  fromJSON: (t: number[], v: number[], opts: object) =>
    TimeSeries.fromJSON({
      name: 's',
      schema: timeSchema,
      rows: t.map((ti, i) => [ti, v[i]!]) as any,
      ...opts,
    }),
  fromColumns: (t: number[], v: number[], opts: object) =>
    TimeSeries.fromColumns({
      name: 's',
      schema: timeSchema,
      columns: { time: t, v },
      ...opts,
    }),
};

describe.each(Object.entries(timeDoors))(
  "ordering: 'clamp' — TimeSeries %s",
  (_door, make) => {
    it('carries a lone backwards blip forward to its predecessor', () => {
      const s = make([0, 10, 5, 20], [1, 2, 3, 4], { ordering: 'clamp' });
      expect(keys(s)).toEqual([0, 10, 10, 20]);
      // rows stay in input order; values are untouched
      expect(s.events.map((e) => e.get('v'))).toEqual([1, 2, 3, 4]);
    });

    it('clamps to the running max, not the raw predecessor', () => {
      // 7 < 10 (already-clamped 5's key) — clamps to 10, not to 5.
      const s = make([0, 10, 5, 7, 12], [1, 2, 3, 4, 5], {
        ordering: 'clamp',
      });
      expect(keys(s)).toEqual([0, 10, 10, 10, 12]);
    });

    it('passes ties through unchanged', () => {
      const s = make([0, 5, 5, 5, 6], [1, 2, 3, 4, 5], {
        ordering: 'clamp',
      });
      expect(keys(s)).toEqual([0, 5, 5, 5, 6]);
    });

    it('plateaus after an early forward outlier (documented sharp edge)', () => {
      const s = make([0, 1000, 2, 3], [1, 2, 3, 4], { ordering: 'clamp' });
      expect(keys(s)).toEqual([0, 1000, 1000, 1000]);
    });

    it('is a no-op on already-ordered input, and handles empty / 1 row', () => {
      expect(keys(make([1, 2, 3], [1, 2, 3], { ordering: 'clamp' }))).toEqual([
        1, 2, 3,
      ]);
      expect(make([], [], { ordering: 'clamp' }).length).toBe(0);
      expect(keys(make([5], [1], { ordering: 'clamp' }))).toEqual([5]);
    });

    it("'strict' is the default and names the escape hatches", () => {
      expect(() => make([0, 10, 5], [1, 2, 3], {})).toThrow(/out of order/);
      expect(() => make([0, 10, 5], [1, 2, 3], {})).toThrow(
        /ordering: 'reorder'.*'clamp'/,
      );
      expect(() => make([0, 10, 5], [1, 2, 3], { ordering: 'strict' })).toThrow(
        ValidationError,
      );
    });

    it("'reorder' reorders rather than rewriting keys", () => {
      const s = make([0, 10, 5], [1, 2, 3], { ordering: 'reorder' });
      expect(keys(s)).toEqual([0, 5, 10]);
      expect(s.events.map((e) => e.get('v'))).toEqual([1, 3, 2]);
    });

    it('`sort: true` is a deprecated alias for ordering: reorder', () => {
      const s = make([0, 10, 5], [1, 2, 3], { sort: true });
      expect(keys(s)).toEqual([0, 5, 10]);
      // agreeing pairs are accepted
      expect(
        keys(make([0, 10, 5], [1, 2, 3], { sort: true, ordering: 'reorder' })),
      ).toEqual([0, 5, 10]);
      expect(
        keys(make([0, 10, 5], [1, 2, 3], { sort: false, ordering: 'clamp' })),
      ).toEqual([0, 10, 10]);
      // `sort: false` alone is today's default
      expect(() => make([0, 10, 5], [1, 2, 3], { sort: false })).toThrow(
        /out of order/,
      );
    });

    it('throws on conflicting sort / ordering', () => {
      expect(() =>
        make([0, 1], [1, 2], { sort: true, ordering: 'clamp' }),
      ).toThrow(/conflicting options/);
      expect(() =>
        make([0, 1], [1, 2], { sort: true, ordering: 'strict' }),
      ).toThrow(/conflicting options/);
      expect(() =>
        make([0, 1], [1, 2], { sort: false, ordering: 'reorder' }),
      ).toThrow(/conflicting options/);
    });

    it('rejects an unknown policy string', () => {
      expect(() => make([0, 1], [1, 2], { ordering: 'drop' })).toThrow(
        /ordering must be/,
      );
    });
  },
);

describe("ordering: 'clamp' — columnar specifics", () => {
  it('never mutates an adopted Float64Array key buffer', () => {
    const time = new Float64Array([0, 10, 5]);
    const s = TimeSeries.fromColumns({
      name: 's',
      schema: timeSchema,
      columns: { time, v: new Float64Array([1, 2, 3]) },
      ordering: 'clamp',
    });
    expect(keys(s)).toEqual([0, 10, 10]);
    expect(Array.from(time)).toEqual([0, 10, 5]);
  });

  it('keeps value-column Float64Arrays adopted (rows never move)', () => {
    const v = new Float64Array([1, 2, 3]);
    const s = TimeSeries.fromColumns({
      name: 's',
      schema: timeSchema,
      columns: { time: [0, 10, 5], v },
      ordering: 'clamp',
    });
    v[2] = 99;
    expect(s.at(2)!.get('v')).toBe(99);
  });

  it('does not launder a non-finite key into a clamped one', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 's',
        schema: timeSchema,
        columns: { time: [0, 10, -Infinity], v: [1, 2, 3] },
        ordering: 'clamp',
      }),
    ).toThrow(RangeError);
    expect(() =>
      TimeSeries.fromColumns({
        name: 's',
        schema: timeSchema,
        columns: { time: [0, 10, NaN, 5], v: [1, 2, 3, 4] },
        ordering: 'clamp',
      }),
    ).toThrow(RangeError);
  });
});

describe("ordering: 'clamp' — two-edged keys are refused", () => {
  it('fromColumns throws for timeRange and interval keys, even when ordered', () => {
    expect(() =>
      TimeSeries.fromColumns({
        name: 's',
        schema: rangeSchema,
        columns: { timeRange: [0, 10], timeRangeEnd: [5, 15], v: [1, 2] },
        ordering: 'clamp',
      }),
    ).toThrow(/'clamp' supports 'time' and 'value' keys only/);
    expect(() =>
      TimeSeries.fromColumns({
        name: 's',
        schema: intervalSchema,
        columns: {
          interval: [0, 10],
          intervalEnd: [5, 15],
          intervalLabel: ['a', 'b'],
          v: [1, 2],
        },
        ordering: 'clamp',
      }),
    ).toThrow(/'clamp' supports 'time' and 'value' keys only/);
  });

  it('the row constructor and fromJSON throw for a timeRange key', () => {
    const rows = [
      [[0, 5], 1],
      [[10, 15], 2],
    ] as any;
    expect(
      () =>
        new TimeSeries({
          name: 's',
          schema: rangeSchema,
          rows,
          ordering: 'clamp',
        }),
    ).toThrow(/'clamp' supports 'time' and 'value' keys only/);
    expect(() =>
      TimeSeries.fromJSON({
        name: 's',
        schema: rangeSchema,
        rows,
        ordering: 'clamp',
      }),
    ).toThrow(/'clamp' supports 'time' and 'value' keys only/);
  });

  it("a two-edged out-of-order error does not suggest 'clamp'", () => {
    let message = '';
    try {
      TimeSeries.fromColumns({
        name: 's',
        schema: rangeSchema,
        columns: { timeRange: [10, 0], timeRangeEnd: [15, 5], v: [1, 2] },
      });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/ordering: 'reorder'/);
    expect(message).not.toMatch(/clamp/);
  });
});

describe('ValueSeries loaders', () => {
  it("fromColumns / fromJSON accept 'clamp' on the value axis", () => {
    const c = ValueSeries.fromColumns({
      name: 's',
      schema: axisSchema,
      columns: { strike: [100, 110, 105], v: [1, 2, 3] },
      ordering: 'clamp',
    });
    expect(Array.from(c.axisValues())).toEqual([100, 110, 110]);
    const j = ValueSeries.fromJSON({
      name: 's',
      schema: axisSchema,
      rows: [
        [100, 1],
        [110, 2],
        [105, 3],
      ],
      ordering: 'clamp',
    });
    expect(Array.from(j.axisValues())).toEqual([100, 110, 110]);
  });

  it('`sort: true` alias + conflict on ValueSeries.fromColumns', () => {
    const s = ValueSeries.fromColumns({
      name: 's',
      schema: axisSchema,
      columns: { strike: [110, 100], v: [2, 1] },
      sort: true,
    });
    expect(Array.from(s.axisValues())).toEqual([100, 110]);
    expect(() =>
      ValueSeries.fromColumns({
        name: 's',
        schema: axisSchema,
        columns: { strike: [110, 100], v: [2, 1] },
        sort: true,
        ordering: 'clamp',
      }),
    ).toThrow(/conflicting options/);
  });
});
