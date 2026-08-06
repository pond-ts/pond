/**
 * **Which Arrow types pond will read, decided from the declared type.**
 *
 * The reader in `./from-arrow.ts` works out what a column holds from the
 * *runtime shape* of `vector.toArray()` — a `Float64Array` is numbers, a plain
 * `Array` of strings is a string column, and so on. That is correct for every
 * type in the allowlist below, and **silently wrong** outside it, because
 * Arrow's physical layouts do not all put one machine word per logical value:
 *
 * - a **`Decimal128`** is four `uint32` words per value, so `toArray()` hands
 *   back a `Uint32Array` four times too long. Read as numbers, that is either
 *   a length mismatch (caught, but blamed on the wrong thing) or — for a
 *   null-bearing column, which takes the per-element path — the **raw unscaled
 *   integer**: `123.45` ingesting as `12345`.
 * - a **`Float16`** is one `uint16` word that is not an integer, so the length
 *   check passes and `1.5` ingests as `15872`, its IEEE-754 half bit pattern.
 *
 * Neither is exotic. So the shape is no longer trusted on its own: this module
 * gates the reader on the field's **declared** type first, and anything not on
 * the list is refused by name rather than misread.
 *
 * ## The stand-in exemption
 *
 * `ArrowTableLike` is duck-typed on purpose — a caller can hand pond an
 * Arrow-shaped object without depending on `apache-arrow`, and the structural
 * fakes in `test/from-arrow.test.ts` do exactly that. Such a stand-in has no
 * `typeId`, so there is nothing to gate on; those fall back to shape reading
 * (plus the width check in `from-arrow.ts`, which is what actually catches a
 * Decimal-shaped buffer). **Every real `apache-arrow` table carries `typeId`**,
 * so the strict path is the one real data takes.
 */
import { ValidationError } from '../../core/errors.js';

/**
 * Arrow's `Type` enum ordinals, for the types this module reasons about. A
 * stable wire-level contract — the same values `resolveMsScale` already reads
 * to detect a `Timestamp`.
 */
const TYPE_DICTIONARY = -1;
const TYPE_NULL = 1;
const TYPE_INT = 2;
const TYPE_FLOAT = 3;
const TYPE_UTF8 = 5;
const TYPE_BOOL = 6;
const TYPE_DECIMAL = 7;
const TYPE_DATE = 8;
const TYPE_TIME = 9;
const TYPE_TIMESTAMP = 10;
const TYPE_LARGE_UTF8 = 20;
const TYPE_UTF8_VIEW = 24;

/** `Precision.HALF` — the one `Float` width pond cannot read (see the note above). */
const PRECISION_HALF = 0;

/** Names for the error message, so a refusal says `Decimal`, not `typeId 7`. */
const TYPE_NAMES: Record<number, string> = {
  [-1]: 'Dictionary',
  0: 'NONE',
  1: 'Null',
  2: 'Int',
  3: 'Float',
  4: 'Binary',
  5: 'Utf8',
  6: 'Bool',
  7: 'Decimal',
  8: 'Date',
  9: 'Time',
  10: 'Timestamp',
  11: 'Interval',
  12: 'List',
  13: 'Struct',
  14: 'Union',
  15: 'FixedSizeBinary',
  16: 'FixedSizeList',
  17: 'Map',
  18: 'Duration',
  19: 'LargeBinary',
  20: 'LargeUtf8',
  21: 'LargeList',
  22: 'RunEndEncoded',
  23: 'BinaryView',
  24: 'Utf8View',
  25: 'ListView',
  26: 'LargeListView',
};

/** The slice of an Arrow `DataType` this gate reads. All optional — see the module note. */
export interface ArrowTypeLike {
  readonly typeId?: number;
  readonly unit?: number;
  /** `Float`'s width (`Precision`) — and, on a `Decimal`, its decimal precision. */
  readonly precision?: number;
  /** A `Dictionary`'s value type. Only a dictionary of strings is readable. */
  readonly dictionary?: { readonly typeId?: number };
}

/** Where the column sits, which decides whether a string type is acceptable. */
export type ArrowColumnRole = 'key' | 'value';

function typeName(type: ArrowTypeLike): string {
  const id = type.typeId;
  if (id === undefined) return 'unknown';
  return TYPE_NAMES[id] ?? `typeId ${id}`;
}

function isStringType(type: ArrowTypeLike): boolean {
  const id = type.typeId;
  // `Utf8View` is the layout newer Arrow producers emit for strings; its
  // `toArray()` yields the same plain array of JS strings as `Utf8`.
  return id === TYPE_UTF8 || id === TYPE_LARGE_UTF8 || id === TYPE_UTF8_VIEW;
}

function isNumericType(type: ArrowTypeLike): boolean {
  const id = type.typeId;
  if (id === TYPE_INT) return true;
  // `Float16` is a `Float` whose `toArray()` is a `Uint16Array` of raw half
  // bit patterns — numeric-looking and completely wrong. Single and double
  // read correctly.
  if (id === TYPE_FLOAT) return type.precision !== PRECISION_HALF;
  // `Date` normalizes to epoch-ms JS numbers. `Timestamp` and `Time` read as
  // their raw int values (a `Timestamp` key is unit-scaled to ms — see
  // `resolveMsScale` — but neither is scaled as a value column).
  return id === TYPE_DATE || id === TYPE_TIMESTAMP || id === TYPE_TIME;
}

/**
 * A `Dictionary` is an **encoding, not a type**: `toArray()` resolves the
 * indices against the dictionary, so what pond sees is whatever the *value*
 * type would have given it. Readability therefore follows the value type —
 * `Dictionary<Utf8>` reads as strings, `Dictionary<Float64>` as numbers, and
 * `Dictionary<Decimal>` is refused for the same reason a bare `Decimal` is.
 */
function unwrapDictionary(type: ArrowTypeLike): ArrowTypeLike {
  return type.typeId === TYPE_DICTIONARY && type.dictionary !== undefined
    ? type.dictionary
    : type;
}

/**
 * Refuse a field whose declared Arrow type pond cannot read faithfully.
 *
 * Returns silently for a readable type, **and** for a type carrying no
 * `typeId` (a structural stand-in — see the module note). Throws otherwise,
 * naming the type and what the door does accept.
 *
 * A `'key'` column additionally rejects the string types: a key must be an
 * axis, and pond has no ordering to give a `Utf8` one.
 */
export function assertReadableArrowType(
  type: ArrowTypeLike | undefined,
  columnName: string,
  role: ArrowColumnRole,
): void {
  // No declared type ⇒ a duck-typed stand-in, not a real Arrow table. Nothing
  // to gate on; the shape reader (and its width check) takes it from here.
  if (type?.typeId === undefined) return;

  // A dictionary is judged by what it decodes to, not by being a dictionary.
  const effective = unwrapDictionary(type);
  if (isNumericType(effective)) return;
  // String and all-`Null` columns are readable as values but not as a key:
  // a key must be an ordered axis, and neither can supply one.
  if (role === 'value' && isStringType(effective)) return;
  if (role === 'value' && effective.typeId === TYPE_NULL) return;

  const name = typeName(effective);
  const accepted =
    role === 'key'
      ? `an Int, Float32/64, Date, Time or Timestamp column`
      : `an Int, Float32/64, Date, Time, Timestamp, Utf8/Utf8View, Null, or ` +
        `a Dictionary of any of those`;

  // Name the fix where there is an obvious one — these are the types a caller
  // is most likely to actually be holding.
  let hint = '';
  if (effective.typeId === TYPE_DECIMAL) {
    hint =
      ` — pond stores numbers as float64, so a Decimal cannot round-trip ` +
      `exactly; cast it in Arrow first if that precision loss is acceptable`;
  } else if (effective.typeId === TYPE_FLOAT) {
    hint = ` — cast it to Float32 or Float64 in Arrow first`;
  } else if (effective.typeId === TYPE_BOOL) {
    hint =
      ` — the columnar ingest engine carries 'number' and 'string' value ` +
      `columns only; use the row doors, or cast to Int in Arrow`;
  } else if (effective.typeId === TYPE_NULL) {
    // Only reachable for a key — an all-null column is a legitimate
    // all-missing *value* column, but nothing can be keyed on it.
    hint = ` — a key cannot be all-null`;
  }

  // No indefinite article: 'Utf8' and 'Union' read as consonant-initial
  // however their first letter looks, so naming the type outright avoids
  // getting it wrong.
  throw new ValidationError(
    `fromArrow: column '${columnName}' has Arrow type ${name}, which pond ` +
      `cannot read as ${role === 'key' ? 'a key' : 'a value column'}; ` +
      `${role === 'key' ? 'a key must be' : 'value columns must be'} ` +
      `${accepted}${hint}`,
  );
}
