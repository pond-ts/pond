/**
 * Chunked value-column variants — one per `ColumnKind`.
 *
 * A chunked column composes a sequence of **plain** value columns
 * (`Float64Column`, `BooleanColumn`, `StringColumn`, `ArrayColumn`)
 * into a single logical column without copying the underlying
 * buffers. Use cases:
 *
 * - **`concatSorted`** of N temporally-disjoint stores — each input
 *   store's value column becomes one chunk of the output. Zero-copy.
 * - **Streaming append** (LiveSeries) — emitted batches are added
 *   as fresh chunks rather than reallocating-and-copying a single
 *   flat buffer.
 *
 * **Discriminator.** A chunked column shares `kind` with its plain
 * counterpart (`ChunkedFloat64Column.kind === 'number'`) and uses
 * `storage: 'chunked'` to distinguish itself from
 * `Float64Column` (`storage: 'packed'`). Hot-path callers (reducers
 * accessing `.values` etc.) narrow on both: `kind === 'number' &&
 * storage === 'packed'`. Callers using only `read`/`scan` /
 * `sliceByRange` / `sliceByIndices` work transparently across
 * either storage.
 *
 * **Aggregate validity.** `validity` is computed **eagerly** at
 * construction by walking each chunk's per-chunk validity. The
 * framework's "no bitmap ⇒ all cells defined" convention is
 * preserved: if every chunk's cell is defined, the aggregate is
 * `undefined`. Eager aggregate is the safe path — callers branching
 * "if `!col.validity`, all cells are defined" would otherwise
 * silently miss invalid cells in chunks that did carry per-chunk
 * bitmaps.
 * Cost: one byte-per-eight-rows over the lifetime of the chunked
 * column. For a 10M-row column with sparse missingness that's
 * ≈1.25 MB on top of the chunks' own validity bitmaps.
 *
 * **Chunks are plain.** Each chunk is a plain variant — nested
 * chunked columns are not permitted. `concatSorted` flattens chunked
 * inputs into their constituent chunks so the chunked-column data
 * structure stays shallow. This keeps row→chunk lookup O(log
 * chunks.length) and bounds memory analysis.
 *
 * **`sliceByIndices` materializes.** A gather pattern destroys chunk
 * locality, so each chunked variant's `sliceByIndices` returns a
 * plain column built from the gather. `sliceByRange` stays chunked
 * when the range spans multiple chunks (the common case after
 * `concatSorted`), and falls through to plain when the range lies
 * within a single chunk.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import { ArrayColumn } from './array-column.js';
import {
  BooleanColumn,
  Float64Column,
  type ColumnKind,
  type ScanOptions,
} from './column.js';
import { StringColumn, stringColumnFromArray } from './string-column.js';
import type { ArrayValue } from './types.js';
import {
  type ValidityBitmap,
  bitmapByteCount,
  validateColumnLength,
  validityFromBits,
} from './validity.js';

/* -------------------------------------------------------------------------- */
/* Shared helpers — chunk offsets, aggregate validity, row→chunk lookup.      */
/* -------------------------------------------------------------------------- */

/**
 * Builds the prefix-sum `chunkOffsets` array (length `chunks.length
 * + 1`) and aggregate validity bitmap for a sequence of plain
 * chunks. Returns `undefined` validity when every chunk's cell is
 * defined (matches the framework's "no bitmap ⇒ all defined"
 * convention).
 *
 * Validates that the total length is a representable column length
 * via `validateColumnLength`. The chunks array is **not** copied;
 * the chunked column constructor decides ownership.
 */
function buildOffsetsAndAggregateValidity(
  chunks: ReadonlyArray<{ length: number; validity?: ValidityBitmap }>,
  label: string,
): {
  length: number;
  chunkOffsets: Int32Array;
  validity?: ValidityBitmap;
} {
  const offsets = new Int32Array(chunks.length + 1);
  let total = 0;
  for (let c = 0; c < chunks.length; c += 1) {
    offsets[c] = total;
    const chunkLength = chunks[c]!.length;
    if (!Number.isInteger(chunkLength) || chunkLength < 0) {
      throw new RangeError(
        `${label}: chunk ${c} has invalid length ${chunkLength} (must be a non-negative integer)`,
      );
    }
    total += chunkLength;
  }
  offsets[chunks.length] = total;
  validateColumnLength(total, label);
  let anyValidity = false;
  for (let c = 0; c < chunks.length; c += 1) {
    if (chunks[c]!.validity !== undefined) {
      anyValidity = true;
      break;
    }
  }
  if (!anyValidity || total === 0) {
    return { length: total, chunkOffsets: offsets };
  }
  const bits = new Uint8Array(bitmapByteCount(total));
  let definedCount = 0;
  for (let c = 0; c < chunks.length; c += 1) {
    const chunk = chunks[c]!;
    const base = offsets[c]!;
    const cv = chunk.validity;
    if (cv === undefined) {
      // No per-chunk bitmap ⇒ every row in this chunk is defined.
      for (let j = 0; j < chunk.length; j += 1) {
        const i = base + j;
        bits[i >> 3]! |= 1 << (i & 7);
      }
      definedCount += chunk.length;
    } else {
      for (let j = 0; j < chunk.length; j += 1) {
        if (cv.isDefined(j)) {
          const i = base + j;
          bits[i >> 3]! |= 1 << (i & 7);
          definedCount += 1;
        }
      }
    }
  }
  if (definedCount === total) {
    return { length: total, chunkOffsets: offsets };
  }
  return {
    length: total,
    chunkOffsets: offsets,
    validity: validityFromBits(bits, total),
  };
}

/**
 * Returns the chunk index `c` such that `chunkOffsets[c] <= rowIndex
 * < chunkOffsets[c + 1]`. Assumes `rowIndex` is in `[0, total
 * length)` — callers bounds-check before calling.
 *
 * Linear scan when there are few chunks (the common case after
 * `concatSorted`); binary search when there are many. The crossover
 * threshold is chosen empirically — at small chunk counts the
 * branch overhead of binary search exceeds the linear scan, and at
 * large chunk counts (hundreds of streaming-append windows) binary
 * search dominates.
 */
function findChunkForRow(chunkOffsets: Int32Array, rowIndex: number): number {
  // `chunkOffsets.length` is `chunks.length + 1`. Valid chunk indices
  // are `[0, chunkOffsets.length - 2]`.
  const lastChunk = chunkOffsets.length - 2;
  if (chunkOffsets.length <= 9) {
    for (let c = 0; c < lastChunk; c += 1) {
      if (rowIndex < chunkOffsets[c + 1]!) return c;
    }
    return lastChunk;
  }
  let lo = 0;
  let hi = lastChunk;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (chunkOffsets[mid + 1]! <= rowIndex) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Validates that every chunk in `chunks` has the expected kind.
 * Caller error (e.g., passing a `BooleanColumn` to
 * `ChunkedFloat64Column`) surfaces here rather than at first read.
 */
function assertChunkKinds(
  chunks: ReadonlyArray<{ kind: string }>,
  expectedKind: ColumnKind,
  label: string,
): void {
  for (let c = 0; c < chunks.length; c += 1) {
    if (chunks[c]!.kind !== expectedKind) {
      throw new TypeError(
        `${label}: chunk ${c} has kind '${chunks[c]!.kind}', expected '${expectedKind}'`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* ChunkedFloat64Column                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Numeric chunked column. Same shape contract as `Float64Column`
 * (kind `'number'`, `read` / `scan` / `sliceByRange` / `sliceByIndices`)
 * but backed by a list of plain `Float64Column` chunks rather than
 * a single flat `Float64Array`. See the module header for the
 * design rationale (aggregate validity, sliceByRange staying
 * chunked across multi-chunk ranges, sliceByIndices materializing).
 *
 * `chunks` is defensively frozen + sliced at construction so
 * subsequent caller mutation of the source array can't corrupt
 * the column.
 */
export class ChunkedFloat64Column {
  readonly kind = 'number' as const;
  readonly storage = 'chunked' as const;
  readonly length: number;
  readonly chunks: ReadonlyArray<Float64Column>;
  readonly chunkOffsets: Int32Array;
  readonly validity?: ValidityBitmap;
  /**
   * `true` iff **every** chunk is itself `allFinite` — the merged
   * column is all-finite IFF each input is (an AND). Defaults to
   * `false` whenever any chunk's flag is `false` (or absent), which is
   * the safe direction: a chunk that didn't prove finiteness keeps the
   * whole column on the guarded reducer path. Mirrors
   * `Float64Column.allFinite`'s safety contract — see it for why a
   * wrong `true` is unsafe.
   */
  readonly allFinite: boolean;

  constructor(chunks: ReadonlyArray<Float64Column>) {
    assertChunkKinds(chunks, 'number', 'ChunkedFloat64Column');
    const { length, chunkOffsets, validity } = buildOffsetsAndAggregateValidity(
      chunks,
      'ChunkedFloat64Column',
    );
    this.length = length;
    // Defensive copy so callers can't mutate the chunks array after
    // construction (the `ReadonlyArray` is a TS marker only).
    this.chunks = Object.freeze(chunks.slice());
    this.chunkOffsets = chunkOffsets;
    if (validity !== undefined) this.validity = validity;
    // AND across chunks: all-finite IFF every chunk is. An empty chunk
    // list is vacuously all-finite (no non-finite cell exists).
    let allFinite = true;
    for (let c = 0; c < chunks.length; c += 1) {
      if (!chunks[c]!.allFinite) {
        allFinite = false;
        break;
      }
    }
    this.allFinite = allFinite;
  }

  /**
   * Reads cell `i` by binary-searching `chunkOffsets` to find the
   * containing chunk, then dereferencing its underlying
   * `Float64Array` directly. Aggregate validity short-circuits to
   * `undefined` before the chunk lookup — see the module header
   * for why we maintain that bitmap eagerly.
   */
  read(i: number): number | undefined {
    if (i < 0 || i >= this.length) return undefined;
    if (this.validity && !this.validity.isDefined(i)) return undefined;
    const c = findChunkForRow(this.chunkOffsets, i);
    const local = i - this.chunkOffsets[c]!;
    return this.chunks[c]!._values[local]!;
  }

  /**
   * Linear scan. Delegates to each chunk's own `scan` and rebases
   * the local row index to a global one — every chunk's per-chunk
   * validity and the shared `skipInvalid` contract are honored
   * naturally by the inner scan.
   */
  scan(fn: (value: number, i: number) => void, options?: ScanOptions): void {
    let globalBase = 0;
    for (let c = 0; c < this.chunks.length; c += 1) {
      const chunk = this.chunks[c]!;
      chunk.scan(
        (value, localIndex) => fn(value, globalBase + localIndex),
        options,
      );
      globalBase += chunk.length;
    }
  }

  /**
   * Returns a column covering rows `[start, end)`. Stays chunked when
   * the range spans multiple chunks; collapses to a plain
   * `Float64Column` when it lies within a single chunk. Empty range
   * → empty plain column.
   */
  sliceByRange(
    start: number,
    end: number,
  ): Float64Column | ChunkedFloat64Column {
    const lo = Math.max(0, start);
    const hi = Math.min(this.length, end);
    if (hi <= lo) {
      return new Float64Column(new Float64Array(0), 0);
    }
    const cStart = findChunkForRow(this.chunkOffsets, lo);
    const cEnd = findChunkForRow(this.chunkOffsets, hi - 1);
    if (cStart === cEnd) {
      const localStart = lo - this.chunkOffsets[cStart]!;
      const localEnd = hi - this.chunkOffsets[cStart]!;
      return this.chunks[cStart]!.sliceByRange(localStart, localEnd);
    }
    const newChunks: Float64Column[] = [];
    const leftLocalStart = lo - this.chunkOffsets[cStart]!;
    const leftChunk = this.chunks[cStart]!;
    newChunks.push(leftChunk.sliceByRange(leftLocalStart, leftChunk.length));
    for (let c = cStart + 1; c < cEnd; c += 1) {
      newChunks.push(this.chunks[c]!);
    }
    const rightLocalEnd = hi - this.chunkOffsets[cEnd]!;
    newChunks.push(this.chunks[cEnd]!.sliceByRange(0, rightLocalEnd));
    return new ChunkedFloat64Column(newChunks);
  }

  /**
   * Gather. Materializes — gather destroys chunk locality, so the
   * result is a plain `Float64Column` whose buffer is filled by
   * indexed reads across chunks.
   */
  sliceByIndices(indices: Int32Array): Float64Column {
    const out = new Float64Array(indices.length);
    let hasInvalid = false;
    const validBits = new Uint8Array(bitmapByteCount(indices.length));
    for (let i = 0; i < indices.length; i += 1) {
      const globalIdx = indices[i]!;
      if (globalIdx < 0 || globalIdx >= this.length) {
        hasInvalid = true;
        continue;
      }
      if (this.validity && !this.validity.isDefined(globalIdx)) {
        hasInvalid = true;
        continue;
      }
      const c = findChunkForRow(this.chunkOffsets, globalIdx);
      const local = globalIdx - this.chunkOffsets[c]!;
      out[i] = this.chunks[c]!._values[local]!;
      validBits[i >> 3]! |= 1 << (i & 7);
    }
    // A gather only reads existing defined cells (out-of-range / invalid
    // slots are skipped → marked invalid below), so the result is finite
    // whenever this chunked column is. Propagate the AND-of-chunks flag.
    if (!hasInvalid) {
      return new Float64Column(out, indices.length, undefined, this.allFinite);
    }
    return new Float64Column(
      out,
      indices.length,
      validityFromBits(validBits, indices.length),
      this.allFinite,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* ChunkedBooleanColumn                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Boolean chunked column. Structurally identical to
 * `ChunkedFloat64Column` — see that class (and the module header)
 * for the read/scan/slice algorithms. Chunks are plain
 * `BooleanColumn` (bit-packed `Uint8Array`).
 */
export class ChunkedBooleanColumn {
  readonly kind = 'boolean' as const;
  readonly storage = 'chunked' as const;
  readonly length: number;
  readonly chunks: ReadonlyArray<BooleanColumn>;
  readonly chunkOffsets: Int32Array;
  readonly validity?: ValidityBitmap;

  constructor(chunks: ReadonlyArray<BooleanColumn>) {
    assertChunkKinds(chunks, 'boolean', 'ChunkedBooleanColumn');
    const { length, chunkOffsets, validity } = buildOffsetsAndAggregateValidity(
      chunks,
      'ChunkedBooleanColumn',
    );
    this.length = length;
    this.chunks = Object.freeze(chunks.slice());
    this.chunkOffsets = chunkOffsets;
    if (validity !== undefined) this.validity = validity;
  }

  read(i: number): boolean | undefined {
    if (i < 0 || i >= this.length) return undefined;
    if (this.validity && !this.validity.isDefined(i)) return undefined;
    const c = findChunkForRow(this.chunkOffsets, i);
    const local = i - this.chunkOffsets[c]!;
    const chunk = this.chunks[c]!;
    return (chunk.values[local >> 3]! & (1 << (local & 7))) !== 0;
  }

  scan(fn: (value: boolean, i: number) => void, options?: ScanOptions): void {
    let globalBase = 0;
    for (let c = 0; c < this.chunks.length; c += 1) {
      const chunk = this.chunks[c]!;
      chunk.scan(
        (value, localIndex) => fn(value, globalBase + localIndex),
        options,
      );
      globalBase += chunk.length;
    }
  }

  sliceByRange(
    start: number,
    end: number,
  ): BooleanColumn | ChunkedBooleanColumn {
    const lo = Math.max(0, start);
    const hi = Math.min(this.length, end);
    if (hi <= lo) {
      return new BooleanColumn(new Uint8Array(0), 0);
    }
    const cStart = findChunkForRow(this.chunkOffsets, lo);
    const cEnd = findChunkForRow(this.chunkOffsets, hi - 1);
    if (cStart === cEnd) {
      const localStart = lo - this.chunkOffsets[cStart]!;
      const localEnd = hi - this.chunkOffsets[cStart]!;
      return this.chunks[cStart]!.sliceByRange(localStart, localEnd);
    }
    const newChunks: BooleanColumn[] = [];
    const leftLocalStart = lo - this.chunkOffsets[cStart]!;
    const leftChunk = this.chunks[cStart]!;
    newChunks.push(leftChunk.sliceByRange(leftLocalStart, leftChunk.length));
    for (let c = cStart + 1; c < cEnd; c += 1) {
      newChunks.push(this.chunks[c]!);
    }
    const rightLocalEnd = hi - this.chunkOffsets[cEnd]!;
    newChunks.push(this.chunks[cEnd]!.sliceByRange(0, rightLocalEnd));
    return new ChunkedBooleanColumn(newChunks);
  }

  sliceByIndices(indices: Int32Array): BooleanColumn {
    const outLength = indices.length;
    const bytes = new Uint8Array(bitmapByteCount(outLength));
    let hasInvalid = false;
    const validBits = new Uint8Array(bitmapByteCount(outLength));
    for (let i = 0; i < outLength; i += 1) {
      const globalIdx = indices[i]!;
      if (globalIdx < 0 || globalIdx >= this.length) {
        hasInvalid = true;
        continue;
      }
      if (this.validity && !this.validity.isDefined(globalIdx)) {
        hasInvalid = true;
        continue;
      }
      const c = findChunkForRow(this.chunkOffsets, globalIdx);
      const local = globalIdx - this.chunkOffsets[c]!;
      const chunk = this.chunks[c]!;
      if ((chunk.values[local >> 3]! & (1 << (local & 7))) !== 0) {
        bytes[i >> 3]! |= 1 << (i & 7);
      }
      validBits[i >> 3]! |= 1 << (i & 7);
    }
    if (!hasInvalid) {
      return new BooleanColumn(bytes, outLength);
    }
    return new BooleanColumn(
      bytes,
      outLength,
      validityFromBits(validBits, outLength),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* ChunkedStringColumn                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Chunked string column. Each chunk independently chooses dict-
 * encoded or fallback storage based on its own input; reads and
 * gathers route through `chunk.read(local)` to honor the chunk's
 * encoding without forcing a shared dictionary across chunks.
 *
 * **Cross-chunk dictionary unification is deferred.** Building a
 * union dictionary at construction would let dict-encoded reads
 * stay on the integer-index hot path even across chunks, but the
 * cost (rebuild + per-chunk index remapping) is paid eagerly even
 * when callers only ever do `read` / `scan`. The deferred path:
 * `materialize` rebuilds with `stringColumnFromArray` which makes
 * the dict-vs-fallback decision once across the whole compacted
 * column.
 */
/**
 * String chunked column. Same shape contract as the other chunked
 * variants; chunks are plain `StringColumn` and can have **per-
 * chunk dictionaries** that differ from one another. `read` and
 * `scan` route through each chunk's own `read` so the per-chunk
 * encoding (dict vs fallback) is handled transparently — no
 * cross-chunk dictionary unification at construction. See the
 * class-level comment below for why that's deferred.
 */
export class ChunkedStringColumn {
  readonly kind = 'string' as const;
  readonly storage = 'chunked' as const;
  readonly length: number;
  readonly chunks: ReadonlyArray<StringColumn>;
  readonly chunkOffsets: Int32Array;
  readonly validity?: ValidityBitmap;

  constructor(chunks: ReadonlyArray<StringColumn>) {
    assertChunkKinds(chunks, 'string', 'ChunkedStringColumn');
    const { length, chunkOffsets, validity } = buildOffsetsAndAggregateValidity(
      chunks,
      'ChunkedStringColumn',
    );
    this.length = length;
    this.chunks = Object.freeze(chunks.slice());
    this.chunkOffsets = chunkOffsets;
    if (validity !== undefined) this.validity = validity;
  }

  read(i: number): string | undefined {
    if (i < 0 || i >= this.length) return undefined;
    // Per-chunk `read` already does its own validity check; routing
    // through it correctly returns `undefined` for invalid cells
    // regardless of dict-vs-fallback encoding.
    const c = findChunkForRow(this.chunkOffsets, i);
    const local = i - this.chunkOffsets[c]!;
    return this.chunks[c]!.read(local);
  }

  scan(fn: (value: string, i: number) => void, options?: ScanOptions): void {
    let globalBase = 0;
    for (let c = 0; c < this.chunks.length; c += 1) {
      const chunk = this.chunks[c]!;
      chunk.scan(
        (value, localIndex) => fn(value, globalBase + localIndex),
        options,
      );
      globalBase += chunk.length;
    }
  }

  sliceByRange(start: number, end: number): StringColumn | ChunkedStringColumn {
    const lo = Math.max(0, start);
    const hi = Math.min(this.length, end);
    if (hi <= lo) {
      return new StringColumn(0, { fallback: [] });
    }
    const cStart = findChunkForRow(this.chunkOffsets, lo);
    const cEnd = findChunkForRow(this.chunkOffsets, hi - 1);
    if (cStart === cEnd) {
      const localStart = lo - this.chunkOffsets[cStart]!;
      const localEnd = hi - this.chunkOffsets[cStart]!;
      return this.chunks[cStart]!.sliceByRange(localStart, localEnd);
    }
    const newChunks: StringColumn[] = [];
    const leftLocalStart = lo - this.chunkOffsets[cStart]!;
    const leftChunk = this.chunks[cStart]!;
    newChunks.push(leftChunk.sliceByRange(leftLocalStart, leftChunk.length));
    for (let c = cStart + 1; c < cEnd; c += 1) {
      newChunks.push(this.chunks[c]!);
    }
    const rightLocalEnd = hi - this.chunkOffsets[cEnd]!;
    newChunks.push(this.chunks[cEnd]!.sliceByRange(0, rightLocalEnd));
    return new ChunkedStringColumn(newChunks);
  }

  /**
   * Gather → plain `StringColumn`. The result is built via
   * `stringColumnFromArray` so the dict-vs-fallback heuristic
   * runs once on the gathered values — matching what
   * `materialize`'s compact step would produce.
   */
  sliceByIndices(indices: Int32Array): StringColumn {
    const out = new Array<string | undefined>(indices.length);
    for (let i = 0; i < indices.length; i += 1) {
      const globalIdx = indices[i]!;
      if (globalIdx < 0 || globalIdx >= this.length) {
        out[i] = undefined;
        continue;
      }
      if (this.validity && !this.validity.isDefined(globalIdx)) {
        out[i] = undefined;
        continue;
      }
      const c = findChunkForRow(this.chunkOffsets, globalIdx);
      const local = globalIdx - this.chunkOffsets[c]!;
      out[i] = this.chunks[c]!.read(local);
    }
    return stringColumnFromArray(out);
  }
}

/* -------------------------------------------------------------------------- */
/* ChunkedArrayColumn                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Array chunked column. Structurally identical to
 * `ChunkedFloat64Column` — see that class (and the module header)
 * for the read/scan/slice algorithms. Chunks are plain
 * `ArrayColumn` whose cells are defensively frozen at the inner
 * column's construction; chunked reads return those frozen cells
 * directly (no extra freeze).
 */
export class ChunkedArrayColumn {
  readonly kind = 'array' as const;
  readonly storage = 'chunked' as const;
  readonly length: number;
  readonly chunks: ReadonlyArray<ArrayColumn>;
  readonly chunkOffsets: Int32Array;
  readonly validity?: ValidityBitmap;

  constructor(chunks: ReadonlyArray<ArrayColumn>) {
    assertChunkKinds(chunks, 'array', 'ChunkedArrayColumn');
    const { length, chunkOffsets, validity } = buildOffsetsAndAggregateValidity(
      chunks,
      'ChunkedArrayColumn',
    );
    this.length = length;
    this.chunks = Object.freeze(chunks.slice());
    this.chunkOffsets = chunkOffsets;
    if (validity !== undefined) this.validity = validity;
  }

  read(i: number): ArrayValue | undefined {
    if (i < 0 || i >= this.length) return undefined;
    if (this.validity && !this.validity.isDefined(i)) return undefined;
    const c = findChunkForRow(this.chunkOffsets, i);
    const local = i - this.chunkOffsets[c]!;
    return this.chunks[c]!.read(local);
  }

  scan(
    fn: (value: ArrayValue, i: number) => void,
    options?: ScanOptions,
  ): void {
    let globalBase = 0;
    for (let c = 0; c < this.chunks.length; c += 1) {
      const chunk = this.chunks[c]!;
      chunk.scan(
        (value, localIndex) => fn(value, globalBase + localIndex),
        options,
      );
      globalBase += chunk.length;
    }
  }

  sliceByRange(start: number, end: number): ArrayColumn | ChunkedArrayColumn {
    const lo = Math.max(0, start);
    const hi = Math.min(this.length, end);
    if (hi <= lo) {
      return new ArrayColumn(0, { fallback: [] });
    }
    const cStart = findChunkForRow(this.chunkOffsets, lo);
    const cEnd = findChunkForRow(this.chunkOffsets, hi - 1);
    if (cStart === cEnd) {
      const localStart = lo - this.chunkOffsets[cStart]!;
      const localEnd = hi - this.chunkOffsets[cStart]!;
      return this.chunks[cStart]!.sliceByRange(localStart, localEnd);
    }
    const newChunks: ArrayColumn[] = [];
    const leftLocalStart = lo - this.chunkOffsets[cStart]!;
    const leftChunk = this.chunks[cStart]!;
    newChunks.push(leftChunk.sliceByRange(leftLocalStart, leftChunk.length));
    for (let c = cStart + 1; c < cEnd; c += 1) {
      newChunks.push(this.chunks[c]!);
    }
    const rightLocalEnd = hi - this.chunkOffsets[cEnd]!;
    newChunks.push(this.chunks[cEnd]!.sliceByRange(0, rightLocalEnd));
    return new ChunkedArrayColumn(newChunks);
  }

  sliceByIndices(indices: Int32Array): ArrayColumn {
    const outLength = indices.length;
    const out = new Array<ArrayValue | undefined>(outLength);
    let hasInvalid = false;
    for (let i = 0; i < outLength; i += 1) {
      const globalIdx = indices[i]!;
      if (globalIdx < 0 || globalIdx >= this.length) {
        out[i] = undefined;
        hasInvalid = true;
        continue;
      }
      if (this.validity && !this.validity.isDefined(globalIdx)) {
        out[i] = undefined;
        hasInvalid = true;
        continue;
      }
      const c = findChunkForRow(this.chunkOffsets, globalIdx);
      const local = globalIdx - this.chunkOffsets[c]!;
      out[i] = this.chunks[c]!.read(local);
    }
    if (!hasInvalid) {
      // Every gathered cell is a real ArrayValue.
      return new ArrayColumn(outLength, {
        fallback: out as ReadonlyArray<ArrayValue>,
      });
    }
    // Some cells are undefined; let `ArrayColumn`'s constructor derive
    // the validity bitmap.
    const bits = new Uint8Array(bitmapByteCount(outLength));
    let definedCount = 0;
    for (let i = 0; i < outLength; i += 1) {
      if (out[i] !== undefined) {
        bits[i >> 3]! |= 1 << (i & 7);
        definedCount += 1;
      }
    }
    if (definedCount === outLength) {
      return new ArrayColumn(outLength, {
        fallback: out as ReadonlyArray<ArrayValue>,
      });
    }
    return new ArrayColumn(outLength, {
      fallback: out,
      validity: validityFromBits(bits, outLength),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Materialization — compact a chunked column into its plain counterpart.     */
/* -------------------------------------------------------------------------- */

/**
 * Compacts a `ChunkedFloat64Column` into a plain `Float64Column` by
 * concatenating chunk buffers into one owned `Float64Array` and
 * gathering an aggregate validity bitmap (already maintained by the
 * chunked column).
 */
export function materializeChunkedFloat64(
  chunked: ChunkedFloat64Column,
): Float64Column {
  const out = new Float64Array(chunked.length);
  let cursor = 0;
  for (let c = 0; c < chunked.chunks.length; c += 1) {
    const chunk = chunked.chunks[c]!;
    out.set(chunk._values.subarray(0, chunk.length), cursor);
    cursor += chunk.length;
  }
  // Compacting doesn't touch values, so finiteness carries over from
  // the chunked column (which is the AND of its chunks). This is what
  // lets a `concatSorted(...).reduce(...)` take the reducer fast path.
  return new Float64Column(
    out,
    chunked.length,
    chunked.validity,
    chunked.allFinite,
  );
}

/**
 * Compacts a `ChunkedBooleanColumn` into a plain `BooleanColumn`.
 * The output's bit buffer is built by walking each chunk's bytes
 * and re-packing into the destination at the correct global bit
 * offset.
 */
export function materializeChunkedBoolean(
  chunked: ChunkedBooleanColumn,
): BooleanColumn {
  const length = chunked.length;
  const bytes = new Uint8Array(bitmapByteCount(length));
  let globalBit = 0;
  for (let c = 0; c < chunked.chunks.length; c += 1) {
    const chunk = chunked.chunks[c]!;
    for (let j = 0; j < chunk.length; j += 1) {
      if ((chunk.values[j >> 3]! & (1 << (j & 7))) !== 0) {
        bytes[globalBit >> 3]! |= 1 << (globalBit & 7);
      }
      globalBit += 1;
    }
  }
  return new BooleanColumn(bytes, length, chunked.validity);
}

/**
 * Compacts a `ChunkedStringColumn` into a plain `StringColumn`.
 * Builds a `(string | undefined)[]` by reading each cell once, then
 * delegates to `stringColumnFromArray` so the dict-vs-fallback
 * heuristic makes the encoding decision on the whole compacted
 * column.
 *
 * **Aggregate validity is re-derived.** The chunked column's
 * eagerly-computed aggregate is discarded; `stringColumnFromArray`
 * derives a fresh validity bitmap by walking the gathered array
 * once more. The redundancy is intentional for 1g — bypassing it
 * would require teaching `stringColumnFromArray` to accept a
 * pre-computed validity hint, which adds API surface for what's
 * currently a one-off compact path. Future doors: a separate
 * `stringColumnFromArrayWithValidity` factory if benches flag the
 * extra walk.
 */
export function materializeChunkedString(
  chunked: ChunkedStringColumn,
): StringColumn {
  const out = new Array<string | undefined>(chunked.length);
  let cursor = 0;
  for (let c = 0; c < chunked.chunks.length; c += 1) {
    const chunk = chunked.chunks[c]!;
    for (let j = 0; j < chunk.length; j += 1) {
      out[cursor] = chunk.read(j);
      cursor += 1;
    }
  }
  return stringColumnFromArray(out);
}

/**
 * Compacts a `ChunkedArrayColumn` into a plain `ArrayColumn`.
 * Walks every cell via `chunk.read(j)` (which honors per-chunk
 * validity) and builds a `(ArrayValue | undefined)[]` for the
 * plain constructor.
 *
 * **Aggregate validity is re-derived.** Same trade-off as
 * `materializeChunkedString`: the eagerly-computed aggregate is
 * discarded and a fresh validity bitmap is derived from
 * `undefined` slots in the gathered array. Avoiding the redundant
 * walk would require a constructor path that trusts a pre-built
 * validity bitmap without re-validating cell shapes — a future
 * optimization gated by benchmarks.
 */
export function materializeChunkedArray(
  chunked: ChunkedArrayColumn,
): ArrayColumn {
  const length = chunked.length;
  const out = new Array<ArrayValue | undefined>(length);
  let hasInvalid = false;
  let cursor = 0;
  for (let c = 0; c < chunked.chunks.length; c += 1) {
    const chunk = chunked.chunks[c]!;
    for (let j = 0; j < chunk.length; j += 1) {
      const v = chunk.read(j);
      out[cursor] = v;
      if (v === undefined) hasInvalid = true;
      cursor += 1;
    }
  }
  if (!hasInvalid) {
    return new ArrayColumn(length, {
      fallback: out as ReadonlyArray<ArrayValue>,
    });
  }
  const bits = new Uint8Array(bitmapByteCount(length));
  let definedCount = 0;
  for (let i = 0; i < length; i += 1) {
    if (out[i] !== undefined) {
      bits[i >> 3]! |= 1 << (i & 7);
      definedCount += 1;
    }
  }
  if (definedCount === length) {
    return new ArrayColumn(length, {
      fallback: out as ReadonlyArray<ArrayValue>,
    });
  }
  return new ArrayColumn(length, {
    fallback: out,
    validity: validityFromBits(bits, length),
  });
}
