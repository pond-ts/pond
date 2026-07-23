import {
  ColumnarStore,
  type Column as ColumnarColumn,
  type ColumnSchema,
  Float64Column,
  type KeyColumn,
  stringColumnFromArray,
  validityFromPredicate,
} from '../../columnar/index.js';
import { ValidationError } from '../../core/errors.js';

/**
 * The per-column raw input the `fromColumns` doors accept. A `'number'` column
 * is a `number[]` (adopted-if-`Float64Array`); a `'string'` column is a
 * `string[]` (`null`/`undefined` → missing). The kind is taken from the
 * matching schema entry — the engine dispatches on it.
 */
export type RawColumns = Record<
  string,
  | ReadonlyArray<number | null | undefined>
  | Float64Array
  | ReadonlyArray<string | null | undefined>
>;

/**
 * The shared columnar-ingress engine behind `TimeSeries.fromColumns` and
 * `ValueSeries.fromColumns`. Both doors are the same machine — normalize the
 * key column (adopt a `Float64Array` zero-copy, convert a `number[]`),
 * optionally sort by key (stable permutation, disables adoption), enforce the
 * non-decreasing-key invariant, pack each value column by its schema kind
 * (`'number'` → `Float64Column`, `null`/`undefined`/non-finite → `NaN` gap;
 * `'string'` → `StringColumn` via the shared dict-encode heuristic,
 * `null`/`undefined` → missing) — and differ only in the key column they mint
 * (`TimeKeyColumn` vs `ValueKeyColumn`) and the words their errors use. `op` prefixes every message (so a throw names
 * the door the caller went through) and `keyNoun` names the key in the
 * out-of-order error (`timestamps` / `axis values`).
 *
 * `makeKey` runs **before** the ordering scan, matching the original inline
 * order of checks: a non-finite key fails in the key-column constructor first,
 * ordering second. The per-element loops are the measured hot path
 * (`scripts/perf-from-columns.mjs`) — moved here verbatim, including the
 * manual copy loops (see the inline notes on why not `Float64Array.from`).
 *
 * The caller owns what stays door-specific: the schema[0] kind gate (with its
 * own message) and wrapping the returned store in its series type.
 */
export function ingestColumnsToStore(input: {
  op: string;
  keyNoun: string;
  schema: ColumnSchema;
  columns: RawColumns;
  sort: boolean;
  makeKey: (begin: Float64Array, count: number) => KeyColumn;
}): ColumnarStore<ColumnSchema> {
  const { op, keyNoun, schema, columns, sort, makeKey } = input;

  const keyDef = schema[0];
  if (keyDef === undefined) {
    throw new ValidationError(`${op}: schema must have at least a key column`);
  }
  const keyRaw = columns[keyDef.name];
  if (keyRaw === undefined) {
    throw new ValidationError(`${op}: missing key column '${keyDef.name}'`);
  }
  // Key buffer; the key-column constructor asserts all finite. A manual loop,
  // not `Float64Array.from(arr, mapFn)`: supplying a map function forces V8's
  // generic iterable-protocol path even for a plain array, ~15-20x slower
  // than a preallocated-buffer copy at 100k-element scale — measured, not
  // theoretical (see the pond-columnar-ingest spike's ingest regression).
  let rawBegin: Float64Array;
  if (keyRaw instanceof Float64Array) {
    rawBegin = keyRaw;
  } else {
    rawBegin = new Float64Array(keyRaw.length);
    for (let j = 0; j < keyRaw.length; j += 1) {
      const v = keyRaw[j];
      rawBegin[j] = v == null ? NaN : Number(v);
    }
  }
  const count = rawBegin.length;

  // `sort: true` — reorder every column by ascending key before construction.
  // Compute the row permutation once (a stable sort of the index array; V8's
  // Array.sort is stable, so equal keys keep input order, matching fromJSON's
  // stable intake), then remap the key + each value column through it below.
  // `order` stays null on the (default) trusted fast path, so no allocation /
  // copy is paid unless asked. A non-finite key is left for the key column's
  // constructor to reject — sorting can't make it valid.
  let begin: Float64Array;
  let order: Uint32Array | null = null;
  if (sort) {
    const idx = Array.from({ length: count }, (_, i) => i);
    idx.sort((a, b) => rawBegin[a]! - rawBegin[b]!);
    order = Uint32Array.from(idx);
    begin = new Float64Array(count);
    for (let j = 0; j < count; j += 1) begin[j] = rawBegin[order[j]!]!;
  } else {
    begin = rawBegin;
  }

  // Throws on any non-finite key value.
  const keys = makeKey(begin, count);
  // Enforce the non-decreasing-key invariant that `fromJSON`'s
  // `validateAndNormalize` guarantees. Trusted construction skips row
  // materialization + kind re-validation, but NOT this correctness contract:
  // bisect-based operators (crop, `atTime`, range queries) rely on it, so an
  // unsorted columnar input must fail loudly here rather than build a silently
  // broken series. One O(N) scan over already-finite values — negligible next
  // to decode. (When `sort` is set the keys are now non-decreasing, so this is
  // a cheap post-condition check rather than a rejection.)
  for (let j = 1; j < count; j += 1) {
    if (begin[j]! < begin[j - 1]!) {
      throw new ValidationError(
        `${op}: key column '${keyDef.name}' is out of order at index ${j} ` +
          `(${begin[j]} < ${begin[j - 1]}) — ${keyNoun} must be non-decreasing; ` +
          `pass { sort: true } or pre-sort the columns`,
      );
    }
  }

  // Value columns — packed directly (missing-aware) from the arrays,
  // dispatched by the schema kind.
  const columnMap = new Map<string, ColumnarColumn>();
  for (let i = 1; i < schema.length; i += 1) {
    const def = schema[i]!;
    if (def.kind !== 'number' && def.kind !== 'string') {
      throw new ValidationError(
        `${op}: supports 'number' and 'string' value columns; column ` +
          `'${def.name}' is '${def.kind}'`,
      );
    }
    const raw = columns[def.name];
    if (raw === undefined) {
      throw new ValidationError(`${op}: missing column '${def.name}'`);
    }
    if (raw.length !== count) {
      throw new ValidationError(
        `${op}: column '${def.name}' length ${raw.length} does not match key length ${count}`,
      );
    }

    if (def.kind === 'string') {
      // String column → StringColumn (dict-encoded when it pays; see
      // `stringColumnFromArray`). `null`/`undefined` are missing. When sorting,
      // reorder into a fresh array through the key permutation first — strings
      // are heap objects, so there's no zero-copy story to preserve anyway.
      const rawStrings = raw as ReadonlyArray<string | null | undefined>;
      let source: ReadonlyArray<string | null | undefined>;
      if (order !== null) {
        const reordered = new Array<string | null | undefined>(count);
        for (let j = 0; j < count; j += 1) reordered[j] = rawStrings[order[j]!];
        source = reordered;
      } else {
        source = rawStrings;
      }
      columnMap.set(def.name, stringColumnFromArray(source));
      continue;
    }

    // Normalize to a Float64Array either way — adopt if already typed (the
    // fast path a protobuf / fixed-point decoder hits, zero-copy), else
    // convert (`null`/`undefined` -> `NaN`) — then apply ONE validity rule
    // to both: a cell is a gap iff it's non-finite. This must be identical
    // regardless of input type: an earlier version used `float64ColumnFromArray`
    // for the `number[]` branch, which treats a `NaN` *value* (as opposed to
    // `null`) as defined-but-non-finite rather than missing, diverging from
    // the `Float64Array` branch's `Number.isFinite` gap signal — the same
    // wire value would silently mean different things depending on which
    // array type decoded it.
    // Manual loop, not `Float64Array.from(arr, mapFn)` — see the key-column
    // comment above; the cost applies identically here.
    const numeric = raw as
      | ReadonlyArray<number | null | undefined>
      | Float64Array;
    let values: Float64Array;
    if (order !== null) {
      // Sorting: reorder into a fresh buffer through the key permutation (no
      // zero-copy adoption — the rows are being moved). Same missing rule
      // (`null`/`undefined` → NaN) applied while remapping.
      values = new Float64Array(count);
      if (numeric instanceof Float64Array) {
        for (let j = 0; j < count; j += 1) values[j] = numeric[order[j]!]!;
      } else {
        for (let j = 0; j < count; j += 1) {
          const v = numeric[order[j]!];
          values[j] = v == null ? NaN : v;
        }
      }
    } else if (numeric instanceof Float64Array) {
      values = numeric;
    } else {
      values = new Float64Array(count);
      for (let j = 0; j < count; j += 1) {
        const v = numeric[j];
        values[j] = v == null ? NaN : v;
      }
    }
    const validity = validityFromPredicate(count, (j) =>
      Number.isFinite(values[j]!),
    );
    columnMap.set(
      def.name,
      new Float64Column(values, count, validity, validity === undefined),
    );
  }

  return ColumnarStore.fromTrustedStore(schema, keys, columnMap);
}
