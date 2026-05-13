import { describe, expect, it } from 'vitest';

import {
  ArrayColumn,
  ArrayColumnBuilder,
  BooleanColumn,
  BooleanColumnBuilder,
  EMPTY_ARRAY_SENTINEL,
  Float64Column,
  Float64ColumnBuilder,
  StringColumn,
  StringColumnBuilder,
  columnBuilderForKind,
} from '../../src/columnar/index.js';

/* -------------------------------------------------------------------------- */
/* Float64ColumnBuilder                                                       */
/* -------------------------------------------------------------------------- */

describe('Float64ColumnBuilder', () => {
  it('appends dense values and finalizes without validity', () => {
    const b = new Float64ColumnBuilder();
    b.append(10);
    b.append(20);
    b.append(30);
    const col = b.finalize();
    expect(col).toBeInstanceOf(Float64Column);
    expect(col.length).toBe(3);
    expect(col.validity).toBeUndefined();
    expect(col.read(0)).toBe(10);
    expect(col.read(2)).toBe(30);
  });

  it('appends undefined and produces a validity bitmap', () => {
    const b = new Float64ColumnBuilder();
    b.append(10);
    b.append(undefined);
    b.append(30);
    const col = b.finalize();
    expect(col.validity).toBeDefined();
    expect(col.validity!.definedCount).toBe(2);
    expect(col.read(1)).toBeUndefined();
  });

  it('grows capacity beyond the initial size (amortized append)', () => {
    const b = new Float64ColumnBuilder(2);
    for (let i = 0; i < 100; i += 1) b.append(i);
    const col = b.finalize();
    expect(col.length).toBe(100);
    expect(col.read(99)).toBe(99);
  });

  it('appendAt fills sparse rows; gaps become invalid', () => {
    const b = new Float64ColumnBuilder();
    b.appendAt(5, 99);
    const col = b.finalize();
    expect(col.length).toBe(6);
    expect(col.read(0)).toBeUndefined();
    expect(col.read(4)).toBeUndefined();
    expect(col.read(5)).toBe(99);
  });

  it('finalize is one-shot — subsequent operations throw', () => {
    const b = new Float64ColumnBuilder();
    b.append(1);
    b.finalize();
    expect(b.consumed).toBe(true);
    expect(() => b.append(2)).toThrow(/already been finalized/);
    expect(() => b.appendAt(10, 5)).toThrow(/already been finalized/);
    expect(() => b.finalize()).toThrow(/already been finalized/);
  });

  it('appendAt rejects non-integer / negative / too-large rowIndex', () => {
    const b = new Float64ColumnBuilder();
    expect(() => b.appendAt(-1, 0)).toThrow(RangeError);
    expect(() => b.appendAt(1.5, 0)).toThrow(RangeError);
    expect(() => b.appendAt(2 ** 31, 0)).toThrow(RangeError);
  });

  it('overwriting a defined cell with undefined clears the validity bit (L2 round-1 finding)', () => {
    // Pre-fix: appendAt(0, undefined) after append(7) left validity
    // marking row 0 as defined; finalize produced a column where
    // read(0) returned 0, not undefined.
    const b = new Float64ColumnBuilder();
    b.append(7);
    b.appendAt(0, undefined);
    const col = b.finalize();
    expect(col.read(0)).toBeUndefined();
    expect(col.validity).toBeDefined();
    expect(col.validity!.definedCount).toBe(0);
  });

  it('overwriting an undefined cell with a defined value sets the validity bit', () => {
    const b = new Float64ColumnBuilder();
    b.append(undefined);
    b.append(20);
    b.appendAt(0, 99);
    const col = b.finalize();
    expect(col.read(0)).toBe(99);
    expect(col.read(1)).toBe(20);
    // Both cells now defined — bitmap may still be present, but
    // definedCount should equal length.
    if (col.validity) {
      expect(col.validity.definedCount).toBe(2);
    }
  });

  it('append after appendAt tracks length correctly', () => {
    const b = new Float64ColumnBuilder();
    b.appendAt(3, 99);
    b.append(42);
    const col = b.finalize();
    expect(col.length).toBe(5);
    expect(col.read(3)).toBe(99);
    expect(col.read(4)).toBe(42);
    expect(col.read(0)).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* BooleanColumnBuilder                                                       */
/* -------------------------------------------------------------------------- */

describe('BooleanColumnBuilder', () => {
  it('appends dense booleans and finalizes without validity', () => {
    const b = new BooleanColumnBuilder();
    b.append(true);
    b.append(false);
    b.append(true);
    const col = b.finalize();
    expect(col).toBeInstanceOf(BooleanColumn);
    expect(col.length).toBe(3);
    expect(col.validity).toBeUndefined();
    expect(col.read(0)).toBe(true);
    expect(col.read(1)).toBe(false);
    expect(col.read(2)).toBe(true);
  });

  it('appends undefined and produces a validity bitmap', () => {
    const b = new BooleanColumnBuilder();
    b.append(true);
    b.append(undefined);
    b.append(false);
    const col = b.finalize();
    expect(col.validity).toBeDefined();
    expect(col.read(1)).toBeUndefined();
  });

  it('grows across byte boundaries (1 byte → multi-byte)', () => {
    const b = new BooleanColumnBuilder(8);
    for (let i = 0; i < 25; i += 1) b.append(i % 2 === 0);
    const col = b.finalize();
    expect(col.length).toBe(25);
    expect(col.read(0)).toBe(true);
    expect(col.read(7)).toBe(false);
    expect(col.read(24)).toBe(true);
  });

  it('appendAt with sparse fill marks gaps invalid', () => {
    const b = new BooleanColumnBuilder();
    b.appendAt(3, true);
    const col = b.finalize();
    expect(col.read(0)).toBeUndefined();
    expect(col.read(3)).toBe(true);
  });

  it('overwriting a defined cell with undefined clears the validity bit (L2 round-1 finding)', () => {
    const b = new BooleanColumnBuilder();
    b.append(true);
    b.appendAt(0, undefined);
    const col = b.finalize();
    expect(col.read(0)).toBeUndefined();
    expect(col.validity).toBeDefined();
    expect(col.validity!.definedCount).toBe(0);
  });

  it('overwriting an undefined cell with a defined value sets the validity bit', () => {
    const b = new BooleanColumnBuilder();
    b.append(undefined);
    b.append(true);
    b.appendAt(0, false);
    const col = b.finalize();
    expect(col.read(0)).toBe(false);
    expect(col.read(1)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* StringColumnBuilder                                                        */
/* -------------------------------------------------------------------------- */

describe('StringColumnBuilder', () => {
  it('low-cardinality input dict-encodes at finalize', () => {
    const b = new StringColumnBuilder();
    for (let i = 0; i < 30; i += 1) b.append(['a', 'b'][i % 2]!);
    const col = b.finalize();
    expect(col).toBeInstanceOf(StringColumn);
    expect(col.isDictEncoded).toBe(true);
    expect(col.dictionary).toEqual(['a', 'b']);
    expect(col.length).toBe(30);
  });

  it('high-cardinality input falls back', () => {
    const b = new StringColumnBuilder();
    for (let i = 0; i < 30; i += 1) b.append(`unique-${i}`);
    const col = b.finalize();
    expect(col.isDictEncoded).toBe(false);
  });

  it('forceFallback option overrides the heuristic', () => {
    const b = new StringColumnBuilder({ forceFallback: true });
    for (let i = 0; i < 30; i += 1) b.append('same');
    const col = b.finalize();
    expect(col.isDictEncoded).toBe(false);
  });

  it('forceDict option overrides the heuristic', () => {
    const b = new StringColumnBuilder({ forceDict: true });
    for (let i = 0; i < 3; i += 1) b.append(`unique-${i}`);
    const col = b.finalize();
    expect(col.isDictEncoded).toBe(true);
  });

  it('handles undefined entries via validity', () => {
    const b = new StringColumnBuilder();
    b.append('a');
    b.append(undefined);
    b.append('b');
    const col = b.finalize();
    expect(col.length).toBe(3);
    expect(col.read(0)).toBe('a');
    expect(col.read(1)).toBeUndefined();
    expect(col.read(2)).toBe('b');
  });

  it('rejects both forceDict and forceFallback', () => {
    expect(
      () => new StringColumnBuilder({ forceDict: true, forceFallback: true }),
    ).toThrow(/mutually exclusive/);
  });
});

/* -------------------------------------------------------------------------- */
/* ArrayColumnBuilder                                                         */
/* -------------------------------------------------------------------------- */

describe('ArrayColumnBuilder', () => {
  it('appends arrays and finalizes with defensive freeze', () => {
    const b = new ArrayColumnBuilder();
    b.append([1, 2, 3]);
    b.append(['a', 'b']);
    b.append([true]);
    const col = b.finalize();
    expect(col).toBeInstanceOf(ArrayColumn);
    expect(col.length).toBe(3);
    expect(col.read(0)).toEqual([1, 2, 3]);
    expect(Object.isFrozen(col.read(0))).toBe(true);
  });

  it('appends undefined and produces a validity bitmap', () => {
    const b = new ArrayColumnBuilder();
    b.append([1]);
    b.append(undefined);
    b.append([3]);
    const col = b.finalize();
    expect(col.validity).toBeDefined();
    expect(col.read(1)).toBeUndefined();
  });

  it('rejects malformed array elements at finalize (via arrayColumnFromArray contract)', () => {
    // arrayColumnFromArray treats malformed slots as invalid cells,
    // so the builder's output marks them invalid rather than throwing.
    const b = new ArrayColumnBuilder();
    b.append([1, 2]);
    b.append([NaN] as unknown as readonly number[]);
    b.append([3]);
    const col = b.finalize();
    expect(col.read(0)).toEqual([1, 2]);
    expect(col.read(1)).toBeUndefined(); // marked invalid by factory
    expect(col.read(2)).toEqual([3]);
  });

  it('mutating source array after append does not affect column', () => {
    const b = new ArrayColumnBuilder();
    const source: number[] = [1, 2];
    b.append(source);
    source.push(99);
    const col = b.finalize();
    expect(col.read(0)).toEqual([1, 2]);
  });

  it('scan(skipInvalid:false) on a column with invalid cells emits the EMPTY_ARRAY_SENTINEL', () => {
    const b = new ArrayColumnBuilder();
    b.append([1]);
    b.append(undefined);
    const col = b.finalize();
    const seen: Array<readonly unknown[]> = [];
    col.scan((v) => seen.push(v), { skipInvalid: false });
    expect(seen.length).toBe(2);
    expect(seen[1]).toBe(EMPTY_ARRAY_SENTINEL);
  });
});

/* -------------------------------------------------------------------------- */
/* columnBuilderForKind polymorphic factory                                   */
/* -------------------------------------------------------------------------- */

describe('columnBuilderForKind', () => {
  it("returns Float64ColumnBuilder for 'number'", () => {
    expect(columnBuilderForKind('number')).toBeInstanceOf(Float64ColumnBuilder);
  });

  it("returns BooleanColumnBuilder for 'boolean'", () => {
    expect(columnBuilderForKind('boolean')).toBeInstanceOf(
      BooleanColumnBuilder,
    );
  });

  it("returns StringColumnBuilder for 'string'", () => {
    expect(columnBuilderForKind('string')).toBeInstanceOf(StringColumnBuilder);
  });

  it("returns ArrayColumnBuilder for 'array'", () => {
    expect(columnBuilderForKind('array')).toBeInstanceOf(ArrayColumnBuilder);
  });

  it('throws on unknown kind', () => {
    expect(() =>
      columnBuilderForKind('mystery' as unknown as 'number'),
    ).toThrow(/unknown column kind/);
  });
});
