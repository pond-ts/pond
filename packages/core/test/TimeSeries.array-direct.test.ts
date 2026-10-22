/**
 * `arrayAggregate` / `arrayExplode` build their output columns directly
 * ([PND-ARRAYSLOW]) instead of through row intake. These pin the parts of
 * the old behaviour that only row intake used to guarantee: every row owns
 * its own array (no two rows share one, so `keep` — which compares arrays
 * by reference — answers as before), arrays are frozen, a custom reducer's
 * array is copied rather than frozen in place, and kind errors are the same.
 */
import { describe, expect, it } from 'vitest';
import {
  Event,
  Sequence,
  Time,
  TimeSeries,
  ValidationError,
} from '../src/index.js';

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'tags', kind: 'array', required: false },
  { name: 'v', kind: 'number' },
] as const;

function makeSeries() {
  return new TimeSeries({
    name: 's',
    schema,
    rows: [
      [0, ['a', 'b'], 1],
      [1000, undefined, 2],
      [2000, [], 3],
      [3000, ['c'], 4],
    ],
  });
}

describe('arrayExplode builds columns directly', () => {
  it('gives each exploded row its own copy of a kept array', () => {
    const out = makeSeries().arrayExplode('tags', { as: 'tag' });
    expect(out.toArray().map((e) => [e.begin(), e.get('tag')])).toEqual([
      [0, 'a'],
      [0, 'b'],
      [3000, 'c'],
    ]);
    const first = out.at(0)!.get('tags');
    const second = out.at(1)!.get('tags');
    expect(first).toEqual(['a', 'b']);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    // `keep` compares by reference, so two equal-but-distinct arrays are
    // not "the same value" — as before.
    expect(out.reduce('tags', 'keep')).toBeUndefined();
  });

  it('rejects elements that do not fit the kind, with the intake error', () => {
    expect(() => makeSeries().arrayExplode('tags', { kind: 'number' })).toThrow(
      new ValidationError('row 0 col 1: expected finite number'),
    );
  });
});

describe('arrayAggregate builds columns directly', () => {
  it('shares the other columns and fills gaps for missing arrays', () => {
    const s = makeSeries();
    const out = s.arrayAggregate('tags', 'count', { as: 'n' });
    expect(out.toArray().map((e) => e.get('n'))).toEqual([2, undefined, 0, 1]);
    expect(out.column('v')).toBe(s.column('v'));
  });

  it('copies a custom reducer’s array instead of freezing it', () => {
    const mine: string[] = ['x'];
    const out = makeSeries().arrayAggregate('tags', () => mine, {
      kind: 'array',
    });
    expect(Object.isFrozen(mine)).toBe(false);
    const cell = out.at(0)!.get('tags');
    expect(cell).toEqual(['x']);
    expect(cell).not.toBe(mine);
    expect(Object.isFrozen(cell)).toBe(true);
  });

  it('rejects a result that does not fit the kind, with the intake error', () => {
    expect(() =>
      makeSeries().arrayAggregate('tags', () => 'x', {
        kind: 'number',
        as: 'n',
      }),
    ).toThrow(new ValidationError('row 0 col 3: expected finite number'));
  });

  it('an `as` naming an existing column keeps the row-intake error', () => {
    // `count` gives a gap for the missing array, and `v` is required.
    expect(() =>
      makeSeries().arrayAggregate('tags', 'count', { as: 'v' }),
    ).toThrow(new ValidationError('row 1 col 2 (v) is required'));
  });

  it('with `as`, the untouched array column is shared with the input', () => {
    // Like `select` / `rename`: columns the operator doesn't change are
    // reused, so the kept array is the input's own (frozen) array.
    const s = makeSeries();
    const out = s.arrayAggregate('tags', 'count', { as: 'n' });
    expect(out.at(0)!.get('tags')).toBe(s.at(0)!.get('tags'));
  });

  it('freezes built-in array results', () => {
    const out = makeSeries().arrayAggregate('tags', 'unique');
    expect(Object.isFrozen(out.at(0)!.get('tags'))).toBe(true);
  });

  it('aggregate array results stay frozen and per-bucket', () => {
    const out = makeSeries().aggregate(Sequence.every(2000), {
      u: { from: 'v', using: 'unique' },
    });
    const cells = out.toArray().map((e) => e.get('u'));
    expect(cells).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(cells.every((c) => Object.isFrozen(c))).toBe(true);
  });
});

describe('arrayContains* read the array column', () => {
  it('keeps the same rows, and each kept row is the source row', () => {
    const s = new TimeSeries({
      name: 's',
      schema: [
        { name: 'time', kind: 'time' },
        { name: 'tags', kind: 'array', required: false },
        { name: 'name', kind: 'string', required: false },
      ] as const,
      rows: [
        [0, ['a', 0], 'a'],
        [1, [-0, 'b'], 'b'],
        [2, undefined, 'a'],
        [3, [], 'a'],
        [4, [true, 'a'], undefined],
      ],
    });
    const times = (t: TimeSeries<any>) => t.toArray().map((e) => e.begin());
    expect(times(s.arrayContains('tags', 'a'))).toEqual([0, 4]);
    // `includes` treats 0 and -0 as equal, as before.
    expect(times(s.arrayContains('tags', -0))).toEqual([0, 1]);
    expect(times(s.arrayContainsAll('tags', []))).toEqual([0, 1, 3, 4]);
    expect(times(s.arrayContainsAny('tags', []))).toEqual([]);
    expect(times(s.arrayContainsAny('tags', [true, 'b']))).toEqual([1, 4]);
    // A text column or an unknown name keeps nothing.
    expect(s.arrayContains('name' as never, 'a').length).toBe(0);
    expect(s.arrayContains('nope' as never, 'a').length).toBe(0);
    // Result event built first, then the source's: one object.
    const r = s.arrayContains('tags', 'a');
    const kept = r.at(1)!;
    expect(s.at(4)).toBe(kept);
    expect(kept.get('tags')).toBe(s.at(4)!.get('tags'));
  });

  it('reads the events of a fromEvents series, as before', () => {
    // Its events can hold arrays its column stores differently (a null or
    // NaN element), so these filters keep reading the events there.
    const schema = [
      { name: 'time', kind: 'time' },
      { name: 'tags', kind: 'array', required: false },
    ] as const;
    const s = TimeSeries.fromEvents(
      [
        new Event(new Time(0), { tags: [null, 'a'] as never }),
        new Event(new Time(1), { tags: [NaN, 1] }),
      ],
      { name: 's', schema },
    );
    expect(s.arrayContains('tags', 'a').length).toBe(1);
    expect(s.arrayContainsAny('tags', [1]).length).toBe(1);
    expect(s.arrayContainsAll('tags', [NaN]).length).toBe(1);
  });
});
