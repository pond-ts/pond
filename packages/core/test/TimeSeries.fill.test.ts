import { describe, expect, it } from 'vitest';
import { TimeSeries } from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'value', kind: 'number', required: false },
  { name: 'host', kind: 'string', required: false },
] as const;

function makeGappy() {
  return new TimeSeries({
    name: 'gappy',
    schema,
    rows: [
      [1000, 10, 'a'],
      [2000, undefined, undefined],
      [3000, undefined, undefined],
      [4000, 40, 'b'],
      [5000, 50, 'c'],
    ],
  });
}

describe('TimeSeries.fill', () => {
  describe('hold strategy', () => {
    it('forward fills undefined values', () => {
      const filled = makeGappy().fill('hold');
      expect(filled.at(0)?.get('value')).toBe(10);
      expect(filled.at(1)?.get('value')).toBe(10);
      expect(filled.at(2)?.get('value')).toBe(10);
      expect(filled.at(3)?.get('value')).toBe(40);
      expect(filled.at(4)?.get('value')).toBe(50);
    });

    it('forward fills string columns', () => {
      const filled = makeGappy().fill('hold');
      expect(filled.at(0)?.get('host')).toBe('a');
      expect(filled.at(1)?.get('host')).toBe('a');
      expect(filled.at(2)?.get('host')).toBe('a');
      expect(filled.at(3)?.get('host')).toBe('b');
    });

    it('leaves leading undefined unfilled', () => {
      const ts = new TimeSeries({
        name: 'leading',
        schema,
        rows: [
          [1000, undefined, undefined],
          [2000, undefined, undefined],
          [3000, 30, 'a'],
        ],
      });
      const filled = ts.fill('hold');
      expect(filled.at(0)?.get('value')).toBeUndefined();
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBe(30);
    });

    it('respects limit (all-or-nothing — gap of 2 with limit 1 leaves both unfilled)', () => {
      // makeGappy has a 2-cell gap. With all-or-nothing semantics, a
      // limit of 1 leaves the entire gap unfilled.
      const filled = makeGappy().fill('hold', { limit: 1 });
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
    });

    it('limit large enough to cover the gap fills the whole gap', () => {
      const filled = makeGappy().fill('hold', { limit: 2 });
      expect(filled.at(1)?.get('value')).toBe(10);
      expect(filled.at(2)?.get('value')).toBe(10);
    });
  });

  describe('bfill strategy', () => {
    it('backward fills undefined values', () => {
      const filled = makeGappy().fill('bfill');
      expect(filled.at(0)?.get('value')).toBe(10);
      expect(filled.at(1)?.get('value')).toBe(40);
      expect(filled.at(2)?.get('value')).toBe(40);
      expect(filled.at(3)?.get('value')).toBe(40);
      expect(filled.at(4)?.get('value')).toBe(50);
    });

    it('backward fills string columns', () => {
      const filled = makeGappy().fill('bfill');
      expect(filled.at(1)?.get('host')).toBe('b');
      expect(filled.at(2)?.get('host')).toBe('b');
      expect(filled.at(3)?.get('host')).toBe('b');
    });

    it('leaves trailing undefined unfilled', () => {
      const ts = new TimeSeries({
        name: 'trailing',
        schema,
        rows: [
          [1000, 10, 'a'],
          [2000, undefined, undefined],
          [3000, undefined, undefined],
        ],
      });
      const filled = ts.fill('bfill');
      expect(filled.at(0)?.get('value')).toBe(10);
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
    });

    it('respects limit (all-or-nothing — gap of 2 with limit 1 leaves both unfilled)', () => {
      const filled = makeGappy().fill('bfill', { limit: 1 });
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
    });

    it('works in per-column mode', () => {
      const filled = makeGappy().fill({ value: 'bfill', host: 'hold' });
      expect(filled.at(1)?.get('value')).toBe(40);
      expect(filled.at(1)?.get('host')).toBe('a');
    });
  });

  describe('zero strategy', () => {
    it('fills undefined with 0', () => {
      const filled = makeGappy().fill('zero');
      expect(filled.at(1)?.get('value')).toBe(0);
      expect(filled.at(2)?.get('value')).toBe(0);
    });

    it('fills leading undefined — `zero` only applies to numeric columns', () => {
      // Pre-columnar (pre-2a), `fill('zero')` indiscriminately set
      // every missing cell to the number `0`, including string
      // columns. The columnar substrate rejects type-broken cells
      // (a string column with a number 0 cell), so `'zero'` is now
      // explicitly kind-sensitive: numeric columns fill with `0`,
      // non-numeric columns stay undefined. Callers who want
      // explicit per-column fills can use the object form, e.g.
      // `fill({ value: 'zero', host: 'literal-value' })`.
      const ts = new TimeSeries({
        name: 'leading',
        schema,
        rows: [
          [1000, undefined, undefined],
          [2000, 20, 'a'],
        ],
      });
      const filled = ts.fill('zero');
      expect(filled.at(0)?.get('value')).toBe(0);
      expect(filled.at(0)?.get('host')).toBeUndefined();
    });

    it('respects limit (all-or-nothing — gap of 2 with limit 1 leaves both unfilled)', () => {
      const filled = makeGappy().fill('zero', { limit: 1 });
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
    });
  });

  describe('linear strategy', () => {
    it('interpolates between known values', () => {
      const filled = makeGappy().fill('linear');
      expect(filled.at(0)?.get('value')).toBe(10);
      expect(filled.at(1)?.get('value')).toBe(20);
      expect(filled.at(2)?.get('value')).toBe(30);
      expect(filled.at(3)?.get('value')).toBe(40);
    });

    it('leaves leading undefined unfilled', () => {
      const ts = new TimeSeries({
        name: 'leading',
        schema,
        rows: [
          [1000, undefined, undefined],
          [2000, undefined, undefined],
          [3000, 30, 'a'],
          [4000, 40, 'b'],
        ],
      });
      const filled = ts.fill('linear');
      expect(filled.at(0)?.get('value')).toBeUndefined();
      expect(filled.at(1)?.get('value')).toBeUndefined();
    });

    it('leaves trailing undefined unfilled', () => {
      const ts = new TimeSeries({
        name: 'trailing',
        schema,
        rows: [
          [1000, 10, 'a'],
          [2000, 20, 'b'],
          [3000, undefined, undefined],
          [4000, undefined, undefined],
        ],
      });
      const filled = ts.fill('linear');
      expect(filled.at(2)?.get('value')).toBeUndefined();
      expect(filled.at(3)?.get('value')).toBeUndefined();
    });

    it('handles non-uniform time spacing', () => {
      const ts = new TimeSeries({
        name: 'nonuniform',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'value', kind: 'number', required: false },
        ] as const,
        rows: [
          [0, 0],
          [1000, undefined],
          [3000, undefined],
          [4000, 40],
        ],
      });
      const filled = ts.fill('linear');
      expect(filled.at(1)?.get('value')).toBe(10);
      expect(filled.at(2)?.get('value')).toBe(30);
    });

    it('respects limit (all-or-nothing — gap of 3 with limit 1 leaves all three unfilled)', () => {
      const ts = new TimeSeries({
        name: 'long-gap',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'value', kind: 'number', required: false },
        ] as const,
        rows: [
          [0, 0],
          [1000, undefined],
          [2000, undefined],
          [3000, undefined],
          [4000, 40],
        ],
      });
      const filled = ts.fill('linear', { limit: 1 });
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
      expect(filled.at(3)?.get('value')).toBeUndefined();
    });

    it('limit large enough to cover the gap fills the whole gap', () => {
      const ts = new TimeSeries({
        name: 'long-gap',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'value', kind: 'number', required: false },
        ] as const,
        rows: [
          [0, 0],
          [1000, undefined],
          [2000, undefined],
          [3000, undefined],
          [4000, 40],
        ],
      });
      const filled = ts.fill('linear', { limit: 3 });
      expect(filled.at(1)?.get('value')).toBe(10);
      expect(filled.at(2)?.get('value')).toBe(20);
      expect(filled.at(3)?.get('value')).toBe(30);
    });

    it('handles same-time events', () => {
      const ts = new TimeSeries({
        name: 'same-time',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'value', kind: 'number', required: false },
        ] as const,
        rows: [
          [1000, 10],
          [1000, undefined],
          [1000, 30],
        ],
      });
      const filled = ts.fill('linear');
      expect(filled.at(1)?.get('value')).toBe(10);
    });
  });

  describe('per-column strategies', () => {
    it('applies different strategies per column', () => {
      const filled = makeGappy().fill({ value: 'linear', host: 'hold' });
      expect(filled.at(1)?.get('value')).toBe(20);
      expect(filled.at(1)?.get('host')).toBe('a');
    });

    it('leaves unmentioned columns as-is', () => {
      const filled = makeGappy().fill({ value: 'hold' });
      expect(filled.at(1)?.get('value')).toBe(10);
      expect(filled.at(1)?.get('host')).toBeUndefined();
    });

    it('supports literal fill values', () => {
      const filled = makeGappy().fill({ value: -1, host: 'unknown' });
      expect(filled.at(1)?.get('value')).toBe(-1);
      expect(filled.at(1)?.get('host')).toBe('unknown');
      expect(filled.at(2)?.get('value')).toBe(-1);
    });

    it('literal with limit (all-or-nothing — gap of 2 with limit 1 leaves both unfilled)', () => {
      const filled = makeGappy().fill({ value: -1 }, { limit: 1 });
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
    });
  });

  describe('maxGap option', () => {
    it('fills a gap entirely when its temporal span fits maxGap', () => {
      // makeGappy: 1s spacing, 2-cell gap from 1000 to 4000 — span = 3s
      const filled = makeGappy().fill('linear', { maxGap: '5s' });
      expect(filled.at(1)?.get('value')).toBe(20);
      expect(filled.at(2)?.get('value')).toBe(30);
    });

    it('leaves the gap fully unfilled when temporal span exceeds maxGap', () => {
      const filled = makeGappy().fill('linear', { maxGap: '2s' });
      // span = 3s exceeds 2s cap → leave both unfilled
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
    });

    it('limit and maxGap compose — most restrictive wins (limit fails)', () => {
      // span 3s ≤ 5s OK, but limit 1 < 2 cells fails
      const filled = makeGappy().fill('hold', { limit: 1, maxGap: '5s' });
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
    });

    it('limit and maxGap compose — most restrictive wins (maxGap fails)', () => {
      // limit 5 ≥ 2 cells OK, but span 3s exceeds 1s cap
      const filled = makeGappy().fill('hold', { limit: 5, maxGap: '1s' });
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
    });

    it('limit and maxGap both pass — gap is filled', () => {
      const filled = makeGappy().fill('hold', { limit: 5, maxGap: '5s' });
      expect(filled.at(1)?.get('value')).toBe(10);
      expect(filled.at(2)?.get('value')).toBe(10);
    });

    it('maxGap with hold: caps trailing carry-forward distance', () => {
      // Trailing gap: events at 1000 (10), 2000 (undef), 3000 (undef).
      // For hold trailing, span = last_gap_cell - prev_known = 3000 - 1000 = 2s
      const ts = new TimeSeries({
        name: 'trailing',
        schema,
        rows: [
          [1000, 10, 'a'],
          [2000, undefined, undefined],
          [3000, undefined, undefined],
        ],
      });
      // 2s cap allows the trailing gap
      const ok = ts.fill('hold', { maxGap: '2s' });
      expect(ok.at(1)?.get('value')).toBe(10);
      expect(ok.at(2)?.get('value')).toBe(10);
      // 1s cap rejects it
      const blocked = ts.fill('hold', { maxGap: '1s' });
      expect(blocked.at(1)?.get('value')).toBeUndefined();
      expect(blocked.at(2)?.get('value')).toBeUndefined();
    });

    it('maxGap exact-boundary is inclusive (length === cap fills)', () => {
      // makeGappy gap span = 3s (1000 → 4000). maxGap of exactly '3s' must fill.
      const filled = makeGappy().fill('linear', { maxGap: '3s' });
      expect(filled.at(1)?.get('value')).toBe(20);
      expect(filled.at(2)?.get('value')).toBe(30);
    });

    it('limit and maxGap compose — both gates fail', () => {
      // gap is 2 cells over 3s span; both caps below threshold
      const filled = makeGappy().fill('hold', { limit: 1, maxGap: '1s' });
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
    });
  });

  describe('limit edge cases', () => {
    it('limit: 0 leaves every gap unfilled', () => {
      // Every nonempty gap exceeds limit 0 → all-or-nothing leaves all unfilled.
      const filled = makeGappy().fill('hold', { limit: 0 });
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
    });

    it('zero strategy fills an all-undefined column without neighbors', () => {
      // No prev or next known values — strategyOk is true for zero/literal
      // (no neighbor required), so the entire run is filled.
      const ts = new TimeSeries({
        name: 'all-undef',
        schema,
        rows: [
          [1000, undefined, undefined],
          [2000, undefined, undefined],
          [3000, undefined, undefined],
        ],
      });
      const filled = ts.fill('zero');
      expect(filled.at(0)?.get('value')).toBe(0);
      expect(filled.at(1)?.get('value')).toBe(0);
      expect(filled.at(2)?.get('value')).toBe(0);
    });

    it('literal fill on an all-undefined column fills entirely', () => {
      const ts = new TimeSeries({
        name: 'all-undef',
        schema,
        rows: [
          [1000, undefined, undefined],
          [2000, undefined, undefined],
        ],
      });
      const filled = ts.fill({ host: 'unknown' });
      expect(filled.at(0)?.get('host')).toBe('unknown');
      expect(filled.at(1)?.get('host')).toBe('unknown');
    });
  });

  describe('edge cases', () => {
    it('empty series returns itself', () => {
      const empty = new TimeSeries({ name: 'e', schema, rows: [] });
      const filled = empty.fill('hold');
      expect(filled.length).toBe(0);
    });

    it('no undefined values returns equivalent series', () => {
      const ts = new TimeSeries({
        name: 'full',
        schema,
        rows: [
          [1000, 10, 'a'],
          [2000, 20, 'b'],
        ],
      });
      const filled = ts.fill('hold');
      expect(filled.at(0)?.get('value')).toBe(10);
      expect(filled.at(1)?.get('value')).toBe(20);
    });

    it('single event with undefined stays undefined for hold', () => {
      const ts = new TimeSeries({
        name: 's',
        schema,
        rows: [[1000, undefined, undefined]],
      });
      const filled = ts.fill('hold');
      expect(filled.at(0)?.get('value')).toBeUndefined();
    });

    it('single event with undefined fills with zero', () => {
      const ts = new TimeSeries({
        name: 's',
        schema,
        rows: [[1000, undefined, undefined]],
      });
      const filled = ts.fill('zero');
      expect(filled.at(0)?.get('value')).toBe(0);
    });

    it('all undefined with hold stays undefined', () => {
      const ts = new TimeSeries({
        name: 'all-undef',
        schema,
        rows: [
          [1000, undefined, undefined],
          [2000, undefined, undefined],
          [3000, undefined, undefined],
        ],
      });
      const filled = ts.fill('hold');
      expect(filled.at(0)?.get('value')).toBeUndefined();
      expect(filled.at(1)?.get('value')).toBeUndefined();
      expect(filled.at(2)?.get('value')).toBeUndefined();
    });

    it('all undefined with linear stays undefined', () => {
      const ts = new TimeSeries({
        name: 'all-undef',
        schema,
        rows: [
          [1000, undefined, undefined],
          [2000, undefined, undefined],
        ],
      });
      const filled = ts.fill('linear');
      expect(filled.at(0)?.get('value')).toBeUndefined();
      expect(filled.at(1)?.get('value')).toBeUndefined();
    });

    it('preserves event keys', () => {
      const filled = makeGappy().fill('hold');
      expect(filled.at(0)?.begin()).toBe(1000);
      expect(filled.at(1)?.begin()).toBe(2000);
      expect(filled.at(4)?.begin()).toBe(5000);
    });

    it('composes with diff', () => {
      const ts = new TimeSeries({
        name: 'diff-fill',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'value', kind: 'number' },
        ] as const,
        rows: [
          [1000, 10],
          [2000, 30],
          [3000, 60],
        ],
      });
      const diffed = ts.diff('value');
      expect(diffed.at(0)?.get('value')).toBeUndefined();
      const filled = diffed.fill('zero');
      expect(filled.at(0)?.get('value')).toBe(0);
      expect(filled.at(1)?.get('value')).toBe(20);
      expect(filled.at(2)?.get('value')).toBe(30);
    });

    it('composes with groupBy', () => {
      const ts = new TimeSeries({
        name: 'grouped',
        schema,
        rows: [
          [1000, 10, 'a'],
          [1000, 100, 'b'],
          [2000, undefined, 'a'],
          [2000, undefined, 'b'],
          [3000, 30, 'a'],
          [3000, undefined, 'b'],
        ],
      });
      const groups = ts.groupBy('host', (group) => group.fill('hold'));
      expect(groups.get('a')!.at(1)?.get('value')).toBe(10);
      expect(groups.get('b')!.at(1)?.get('value')).toBe(100);
      expect(groups.get('b')!.at(2)?.get('value')).toBe(100);
    });

    it('multiple gaps with linear', () => {
      const ts = new TimeSeries({
        name: 'multi-gap',
        schema: [
          { name: 'time', kind: 'time' },
          { name: 'value', kind: 'number', required: false },
        ] as const,
        rows: [
          [0, 0],
          [1000, undefined],
          [2000, 20],
          [3000, undefined],
          [4000, 40],
        ],
      });
      const filled = ts.fill('linear');
      expect(filled.at(1)?.get('value')).toBe(10);
      expect(filled.at(3)?.get('value')).toBe(30);
    });
  });
});
