/**
 * Type tests for Phase 4.7 step 8a — the column-api public
 * re-exports. Pins that the symbols promised by
 * `docs/rfcs/column-api.md` are importable from the top-level
 * `pond-ts` barrel (in-tree path; the published `pond-ts` entry
 * resolves through the same `src/index.ts`).
 *
 * If any of these imports break, downstream consumers (chart
 * adapters, `@pond-ts/charts` future, the production-side dense-
 * viz work) lose the public Column surface and have to reach into
 * `pond-ts/columnar` — exactly the friction the RFC is meant to
 * eliminate.
 *
 * The deeper per-kind method-narrowing tests land in step 8b
 * alongside the implementation; this file only pins the symbol-
 * level public-export contract for 8a.
 */

import type {
  Column,
  ColumnKind,
  ColumnStorage,
  IntervalLabelKind,
  KeyColumn,
  ScanOptions,
  ValidityBitmap,
} from '../src/index.js';
import {
  ArrayColumn,
  BooleanColumn,
  ChunkedArrayColumn,
  ChunkedBooleanColumn,
  ChunkedFloat64Column,
  ChunkedStringColumn,
  Float64Column,
  IntervalKeyColumn,
  StringColumn,
  TimeKeyColumn,
  TimeRangeKeyColumn,
} from '../src/index.js';

// ─── Column union type is reachable ──────────────────────────────
//
// `Column` is the discriminated union over all four kinds × two
// storages. Consumers narrow on `.kind` and `.storage`.

declare const someColumn: Column;
// Compile-time: should narrow by kind.
if (someColumn.kind === 'number') {
  // After kind-narrowing, .storage tells you packed vs chunked.
  if (someColumn.storage === 'packed') {
    const _values: Float64Array = someColumn.values;
    void _values;
  }
}

// ─── Class types are reachable + instanceof-usable ───────────────

declare const maybeColumn: unknown;

if (maybeColumn instanceof Float64Column) {
  // narrowed to Float64Column at the type level
  const _kind: 'number' = maybeColumn.kind;
  void _kind;
}
if (maybeColumn instanceof BooleanColumn) {
  const _kind: 'boolean' = maybeColumn.kind;
  void _kind;
}
if (maybeColumn instanceof StringColumn) {
  const _kind: 'string' = maybeColumn.kind;
  void _kind;
}
if (maybeColumn instanceof ArrayColumn) {
  const _kind: 'array' = maybeColumn.kind;
  void _kind;
}

// ─── Chunked variants are reachable + discriminate via storage ───

if (maybeColumn instanceof ChunkedFloat64Column) {
  const _storage: 'chunked' = maybeColumn.storage;
  void _storage;
}
if (maybeColumn instanceof ChunkedBooleanColumn) {
  const _storage: 'chunked' = maybeColumn.storage;
  void _storage;
}
if (maybeColumn instanceof ChunkedStringColumn) {
  const _storage: 'chunked' = maybeColumn.storage;
  void _storage;
}
if (maybeColumn instanceof ChunkedArrayColumn) {
  const _storage: 'chunked' = maybeColumn.storage;
  void _storage;
}

// ─── KeyColumn union + variants ──────────────────────────────────

declare const someKeyColumn: KeyColumn;
if (someKeyColumn instanceof TimeKeyColumn) {
  const _begin: Float64Array = someKeyColumn.begin;
  void _begin;
}
if (someKeyColumn instanceof TimeRangeKeyColumn) {
  const _begin: Float64Array = someKeyColumn.begin;
  const _end: Float64Array = someKeyColumn.end;
  void _begin;
  void _end;
}
if (someKeyColumn instanceof IntervalKeyColumn) {
  const _begin: Float64Array = someKeyColumn.begin;
  const _end: Float64Array = someKeyColumn.end;
  void _begin;
  void _end;
}

// ─── Supporting types are reachable ──────────────────────────────

declare const kind: ColumnKind;
const _kindOk: 'number' | 'boolean' | 'string' | 'array' = kind;
void _kindOk;

declare const storage: ColumnStorage;
const _storageOk: 'packed' | 'chunked' = storage;
void _storageOk;

declare const validity: ValidityBitmap | undefined;
void validity;

declare const scanOpts: ScanOptions;
void scanOpts;

declare const labelKind: IntervalLabelKind;
const _labelKindOk: 'string' | 'number' = labelKind;
void _labelKindOk;
