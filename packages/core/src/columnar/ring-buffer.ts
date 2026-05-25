/**
 * `ColumnarRingBuffer<S>` — mutable, append-only circular buffer
 * backing the framework's streaming surface.
 *
 * **Use case.** Streaming sources (LiveSeries, gRPC ingest,
 * websocket feeds) emit rows continuously. Re-allocating a flat
 * buffer on every append is wasteful; a ring buffer with O(1)
 * amortized append + bounded retention is the right shape. The
 * row-API adapter (`LiveSeries`) wraps a `ColumnarRingBuffer`
 * with the ordering / drop / strict semantics from RFC V4 — the
 * framework's ring is **ordering-agnostic**, accepting whatever
 * the caller pushes.
 *
 * **Storage layout.** Per-column typed-array buffers sized to the
 * current `capacity`. A logical row at index `i` lives at
 * physical position `(head + i) % capacity`. Growth unrolls the
 * circular buffer into a fresh linear buffer at the new capacity
 * (O(length) once; amortized O(1) over appends). Retention caps
 * the maximum length — once `length === retention`, subsequent
 * appends advance `head` to evict the oldest row.
 *
 * **Lazy growth.** Default initial capacity is `min(retention, 64)`.
 * Each growth doubles capacity, capped at `retention`. Set
 * `lazyGrowth: false` in options to pre-allocate `retention`
 * immediately — useful when steady-state retention is known and
 * the per-doubling copy cost would matter (large rings ingesting
 * burst traffic).
 *
 * **Interval rings need a `labelKind`.** `IntervalKeyColumn`'s
 * label storage is discriminated `string | number` at runtime. The
 * ring needs to know which up front so its label buffer is the
 * right shape (and so `snapshot()` on an empty ring can produce a
 * well-typed empty store). Pass `intervalLabelKind: 'string' |
 * 'number'` in options for `interval`-keyed rings; the option is
 * rejected as unused for `time` / `timeRange` schemas.
 *
 * **Trust boundary.** `appendBatch` validates the batch's schema
 * matches the ring's structurally; it does not re-validate row
 * data (the batch is itself a `ColumnarStore` whose factories
 * already validated). It does not enforce temporal ordering —
 * that's a `LiveSeries`-layer concern, per RFC V4.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import { ArrayColumn } from './array-column.js';
import { BooleanColumn, Float64Column, type ColumnKind } from './column.js';
import {
  IntervalKeyColumn,
  type IntervalLabelKind,
  TimeKeyColumn,
  TimeRangeKeyColumn,
  type KeyColumn,
} from './key-column.js';
import { StringColumn, stringColumnFromArray } from './string-column.js';
import { ColumnarStore } from './store.js';
import type { ArrayValue, ColumnSchema, KeyKind } from './types.js';
import {
  bitmapByteCount,
  validateColumnLength,
  validityFromBits,
} from './validity.js';
import type { Column } from './column.js';

/** Initial capacity when `lazyGrowth` is enabled (default). */
const DEFAULT_INITIAL_CAPACITY = 64;

export interface ColumnarRingBufferOptions {
  /** Maximum number of rows the ring retains. Required. */
  retention: number;
  /**
   * If true (default), start at small capacity and double on
   * append up to `retention`. If false, pre-allocate `retention`
   * immediately.
   */
  lazyGrowth?: boolean;
  /**
   * Required when `schema[0].kind === 'interval'`. Rejects with
   * `RangeError` if the schema's key kind doesn't match (e.g. an
   * `intervalLabelKind` passed for a `'time'` schema, or an
   * `interval` schema with no `intervalLabelKind` provided).
   */
  intervalLabelKind?: IntervalLabelKind;
}

/* -------------------------------------------------------------------------- */
/* Internal mutable storage shapes — one per kind, sized to the ring's        */
/* current `capacity`. `validity` is allocated for every value column         */
/* regardless of whether any cell is missing — it's a bit per cell at the     */
/* same scale as the data buffer, and tracking presence lazily would         */
/* complicate the eviction/growth bookkeeping.                                */
/* -------------------------------------------------------------------------- */

/**
 * No `definedCount` field on these mutable rings. `snapshot()`
 * computes it locally per column when it builds the validity
 * bitmap, and nothing outside the ring needs an O(1) defined-
 * count query at the framework layer. A maintained field would
 * drift on edge paths (full-clear leaves stale string/array
 * cells; batch-larger-than-retention resets length+head without
 * touching the counter) and add bookkeeping nobody reads.
 * Future LiveSeries-layer query needs can reintroduce a
 * cached counter with a single source-of-truth update site.
 */
interface MutableFloat64Ring {
  readonly kind: 'number';
  values: Float64Array;
  validity: Uint8Array;
}
interface MutableBooleanRing {
  readonly kind: 'boolean';
  /** Bit-packed: `bit_i = values[physical_i >> 3] & (1 << (physical_i & 7))`. */
  values: Uint8Array;
  validity: Uint8Array;
}
interface MutableStringRing {
  readonly kind: 'string';
  values: Array<string | undefined>;
}
interface MutableArrayRing {
  readonly kind: 'array';
  values: Array<ArrayValue | undefined>;
}
type MutableValueRing =
  | MutableFloat64Ring
  | MutableBooleanRing
  | MutableStringRing
  | MutableArrayRing;

interface MutableTimeKeyRing {
  readonly kind: 'time';
  begin: Float64Array;
}
interface MutableTimeRangeKeyRing {
  readonly kind: 'timeRange';
  begin: Float64Array;
  end: Float64Array;
}
interface MutableIntervalKeyRing {
  readonly kind: 'interval';
  readonly labelKind: IntervalLabelKind;
  begin: Float64Array;
  end: Float64Array;
  /** Discriminated by `labelKind` — string array OR Float64Array. */
  labels: Array<string | undefined> | Float64Array;
}
type MutableKeyRing =
  | MutableTimeKeyRing
  | MutableTimeRangeKeyRing
  | MutableIntervalKeyRing;

/* -------------------------------------------------------------------------- */
/* ColumnarRingBuffer                                                          */
/* -------------------------------------------------------------------------- */

export class ColumnarRingBuffer<S extends ColumnSchema = ColumnSchema> {
  readonly schema: S;
  readonly retention: number;
  readonly lazyGrowth: boolean;
  #length: number = 0;
  #head: number = 0;
  #capacity: number;
  #keys: MutableKeyRing;
  #values: Map<string, MutableValueRing>;

  constructor(schema: S, options: ColumnarRingBufferOptions) {
    validateColumnLength(options.retention, 'ColumnarRingBuffer.retention');
    if (schema.length === 0) {
      throw new RangeError(
        'ColumnarRingBuffer: schema must have at least one entry (the key column)',
      );
    }
    const keyKind = schema[0]!.kind as KeyKind | string;
    if (
      keyKind !== 'time' &&
      keyKind !== 'timeRange' &&
      keyKind !== 'interval'
    ) {
      throw new RangeError(
        `ColumnarRingBuffer: schema[0].kind must be 'time' / 'timeRange' / 'interval'; got '${keyKind}'`,
      );
    }
    // intervalLabelKind required iff key is interval. Reject mismatch.
    if (keyKind === 'interval') {
      if (
        options.intervalLabelKind !== 'string' &&
        options.intervalLabelKind !== 'number'
      ) {
        throw new RangeError(
          `ColumnarRingBuffer: schema[0].kind is 'interval' but options.intervalLabelKind was not provided (must be 'string' or 'number')`,
        );
      }
    } else if (options.intervalLabelKind !== undefined) {
      throw new RangeError(
        `ColumnarRingBuffer: options.intervalLabelKind is only valid for 'interval' keys; got schema[0].kind = '${keyKind}'`,
      );
    }
    this.schema = schema;
    this.retention = options.retention;
    this.lazyGrowth = options.lazyGrowth !== false;
    const initialCapacity = this.lazyGrowth
      ? Math.min(options.retention, DEFAULT_INITIAL_CAPACITY)
      : options.retention;
    this.#capacity = initialCapacity;
    this.#keys = initKeyRing(
      keyKind as KeyKind,
      initialCapacity,
      options.intervalLabelKind,
    );
    this.#values = new Map();
    for (let i = 1; i < schema.length; i += 1) {
      const def = schema[i]!;
      this.#values.set(
        def.name,
        initValueRing(def.kind as ColumnKind, initialCapacity),
      );
    }
  }

  /** Current row count. Capped at `retention`. */
  get length(): number {
    return this.#length;
  }

  /** Current physical capacity. Bounded by `retention`. */
  get capacity(): number {
    return this.#capacity;
  }

  /**
   * Append a batch of rows. The batch's schema must structurally
   * match this ring's schema (same length, same `name` and `kind`
   * per position).
   *
   * **Eviction.** If appending would push `length` past
   * `retention`, the oldest rows are evicted (head advances). The
   * ring's `length` after the call is `min(length + batch.length,
   * retention)`. Net new rows kept = `batch.length` (or `retention`
   * if batch alone exceeds retention; the *last* `retention` rows
   * win).
   *
   * **Growth.** If appending requires more physical capacity, the
   * ring grows (doubling up to `retention`).
   *
   * **Interval labelKind matching.** For interval-keyed rings, the
   * incoming batch's `labelKind` must match the ring's. Reject
   * otherwise.
   */
  appendBatch(batch: ColumnarStore<S>): void {
    this.#validateBatchSchema(batch);
    const batchLength = batch.length;
    if (batchLength === 0) return;
    // **Retention overflow.** When a single batch's length exceeds
    // retention, only the last `retention` rows make it into the
    // ring. Skip the earlier rows entirely — no point writing
    // them just to immediately evict.
    let batchStart = 0;
    let toAppend = batchLength;
    if (batchLength > this.retention) {
      batchStart = batchLength - this.retention;
      toAppend = this.retention;
      // Existing rows are entirely replaced — clear position state
      // AND wipe every slot's defined-state. Without the slot
      // wipe, the upcoming writes would inherit the prior batch's
      // defined-state on slots whose new value is undefined, and
      // string/array slots would leak prior cells. Matches the
      // full-clear branch in `evictPrefix`.
      this.#length = 0;
      this.#head = 0;
      this.#clearAllSlots();
    }
    // **Eviction before grow.** If we're already at retention,
    // appending toAppend rows means advancing head by `toAppend`
    // (clamped). This frees physical slots without needing growth.
    const overflow = this.#length + toAppend - this.retention;
    if (overflow > 0) {
      // Drop the oldest `overflow` rows.
      this.evictPrefix(overflow);
    }
    // **Growth.** After eviction, we need enough capacity for
    // current length + the rows about to be appended.
    const required = this.#length + toAppend;
    if (required > this.#capacity) {
      this.#grow(required);
    }
    // **Vectorized write per column.** Walk the batch's rows once
    // per column; for each, compute the destination physical
    // position and write. Per-cell write goes through `column.read`
    // which handles per-batch validity transparently.
    this.#writeBatch(batch, batchStart, toAppend);
    this.#length += toAppend;
  }

  /**
   * Drop the oldest `n` rows. If `n >= length`, the ring is
   * cleared (head reset to 0, length 0). Negative or non-integer
   * `n` throws.
   */
  evictPrefix(n: number): void {
    if (!Number.isInteger(n) || n < 0) {
      throw new RangeError(
        `ColumnarRingBuffer.evictPrefix: n must be a non-negative integer, got ${n}`,
      );
    }
    if (n === 0) return;
    if (n >= this.#length) {
      // Full clear: reset position state AND wipe every slot's
      // defined-state. Without the slot wipe, future writes to
      // previously-occupied slots would mis-read the prior
      // defined-state and (for string/array) leak stale cells
      // back into the snapshot. See `#clearAllSlots`.
      this.#length = 0;
      this.#head = 0;
      this.#clearAllSlots();
      return;
    }
    // Walk the n evicted rows; wipe each value column's
    // defined-state at that physical slot. Without this, a slot
    // reused by a later append would inherit the evicted row's
    // string/array value as "previously defined" — fine if the
    // overwrite is also defined, but if it's undefined the slot
    // would silently keep the evicted data via the validity-bit
    // path. Cheap: O(n × value-columns).
    for (let i = 0; i < n; i += 1) {
      const physical = (this.#head + i) % this.#capacity;
      this.#clearValidityForRow(physical);
    }
    this.#head = (this.#head + n) % this.#capacity;
    this.#length -= n;
  }

  /**
   * Build an immutable `ColumnarStore<S>` snapshot from the ring's
   * current state. Allocates fresh typed-array buffers sized to
   * `length` and copies rows in logical order. The snapshot is
   * decoupled from the ring — subsequent appends / evictions /
   * growths don't affect it, and mutating the snapshot (which
   * `ColumnarStore` doesn't expose, but the underlying buffers
   * could be reached) doesn't affect the ring.
   */
  snapshot(): ColumnarStore<S> {
    const length = this.#length;
    const keys = this.#snapshotKeys(length);
    const columns = new Map<string, Column>();
    for (let i = 1; i < this.schema.length; i += 1) {
      const def = this.schema[i]!;
      const ring = this.#values.get(def.name)!;
      columns.set(
        def.name,
        snapshotValueColumn(ring, length, this.#head, this.#capacity),
      );
    }
    return ColumnarStore.fromTrustedStore(this.schema, keys, columns);
  }

  /* ------------------------------------------------------------------------ */
  /* Internal                                                                  */
  /* ------------------------------------------------------------------------ */

  #validateBatchSchema(batch: ColumnarStore<S>): void {
    if (batch.schema === this.schema) {
      // Same schema reference — structurally guaranteed equal.
    } else {
      if (batch.schema.length !== this.schema.length) {
        throw new RangeError(
          `ColumnarRingBuffer.appendBatch: batch schema length ${batch.schema.length} does not match ring schema length ${this.schema.length}`,
        );
      }
      for (let i = 0; i < this.schema.length; i += 1) {
        const ringDef = this.schema[i]!;
        const batchDef = batch.schema[i]!;
        if (ringDef.name !== batchDef.name) {
          throw new RangeError(
            `ColumnarRingBuffer.appendBatch: batch schema[${i}].name '${batchDef.name}' does not match ring '${ringDef.name}'`,
          );
        }
        if (ringDef.kind !== batchDef.kind) {
          throw new RangeError(
            `ColumnarRingBuffer.appendBatch: batch schema[${i}].kind '${batchDef.kind}' does not match ring '${ringDef.kind}'`,
          );
        }
      }
    }
    // For interval rings, validate label kind alignment.
    if (this.#keys.kind === 'interval') {
      const batchKeys = batch.keys as IntervalKeyColumn;
      if (batchKeys.labelKind !== this.#keys.labelKind) {
        throw new RangeError(
          `ColumnarRingBuffer.appendBatch: batch interval labelKind '${batchKeys.labelKind}' does not match ring labelKind '${this.#keys.labelKind}'`,
        );
      }
    }
  }

  #writeBatch(
    batch: ColumnarStore<S>,
    batchStart: number,
    toAppend: number,
  ): void {
    // Key buffers.
    const batchKeys = batch.keys;
    for (let j = 0; j < toAppend; j += 1) {
      const srcRow = batchStart + j;
      const dst = (this.#head + this.#length + j) % this.#capacity;
      this.#keys.begin[dst] = batchKeys.beginAt(srcRow);
      if (this.#keys.kind === 'timeRange' || this.#keys.kind === 'interval') {
        this.#keys.end[dst] = batchKeys.endAt(srcRow);
      }
      if (this.#keys.kind === 'interval') {
        const label = (batchKeys as IntervalKeyColumn).labelAt(srcRow);
        if (this.#keys.labelKind === 'string') {
          (this.#keys.labels as Array<string | undefined>)[dst] =
            label as string;
        } else {
          (this.#keys.labels as Float64Array)[dst] = label as number;
        }
      }
    }
    // Value columns.
    for (let c = 1; c < this.schema.length; c += 1) {
      const def = this.schema[c]!;
      const ring = this.#values.get(def.name)!;
      const srcCol = batch.columns.get(def.name)!;
      writeValueColumnRows(
        ring,
        srcCol,
        batchStart,
        toAppend,
        this.#head,
        this.#length,
        this.#capacity,
      );
    }
  }

  #grow(required: number): void {
    let newCapacity = this.#capacity;
    while (newCapacity < required) {
      newCapacity = Math.min(
        this.retention,
        Math.max(newCapacity * 2, required),
      );
      if (newCapacity === this.#capacity) {
        // Defensive — shouldn't loop if capacity already at retention.
        break;
      }
    }
    newCapacity = Math.min(newCapacity, this.retention);
    if (newCapacity === this.#capacity) return;
    // Unroll the circular buffer into a fresh linear buffer at
    // the new capacity. Head resets to 0; length stays the same.
    this.#regrowKeys(newCapacity);
    for (const [, ring] of this.#values) {
      regrowValueRing(
        ring,
        newCapacity,
        this.#head,
        this.#length,
        this.#capacity,
      );
    }
    this.#head = 0;
    this.#capacity = newCapacity;
  }

  #regrowKeys(newCapacity: number): void {
    const length = this.#length;
    const capacity = this.#capacity;
    const head = this.#head;
    if (this.#keys.kind === 'time') {
      const newBegin = new Float64Array(newCapacity);
      for (let i = 0; i < length; i += 1) {
        newBegin[i] = this.#keys.begin[(head + i) % capacity]!;
      }
      this.#keys = { kind: 'time', begin: newBegin };
    } else if (this.#keys.kind === 'timeRange') {
      const newBegin = new Float64Array(newCapacity);
      const newEnd = new Float64Array(newCapacity);
      for (let i = 0; i < length; i += 1) {
        const p = (head + i) % capacity;
        newBegin[i] = this.#keys.begin[p]!;
        newEnd[i] = this.#keys.end[p]!;
      }
      this.#keys = { kind: 'timeRange', begin: newBegin, end: newEnd };
    } else {
      const newBegin = new Float64Array(newCapacity);
      const newEnd = new Float64Array(newCapacity);
      let newLabels: Array<string | undefined> | Float64Array;
      if (this.#keys.labelKind === 'string') {
        newLabels = new Array<string | undefined>(newCapacity);
        const srcLabels = this.#keys.labels as Array<string | undefined>;
        for (let i = 0; i < length; i += 1) {
          const p = (head + i) % capacity;
          newBegin[i] = this.#keys.begin[p]!;
          newEnd[i] = this.#keys.end[p]!;
          newLabels[i] = srcLabels[p];
        }
      } else {
        newLabels = new Float64Array(newCapacity);
        const srcLabels = this.#keys.labels as Float64Array;
        for (let i = 0; i < length; i += 1) {
          const p = (head + i) % capacity;
          newBegin[i] = this.#keys.begin[p]!;
          newEnd[i] = this.#keys.end[p]!;
          (newLabels as Float64Array)[i] = srcLabels[p]!;
        }
      }
      this.#keys = {
        kind: 'interval',
        labelKind: this.#keys.labelKind,
        begin: newBegin,
        end: newEnd,
        labels: newLabels,
      };
    }
  }

  #snapshotKeys(length: number): KeyColumn {
    const capacity = this.#capacity;
    const head = this.#head;
    if (this.#keys.kind === 'time') {
      const begin = new Float64Array(length);
      for (let i = 0; i < length; i += 1) {
        begin[i] = this.#keys.begin[(head + i) % capacity]!;
      }
      return new TimeKeyColumn(begin, length);
    }
    if (this.#keys.kind === 'timeRange') {
      const begin = new Float64Array(length);
      const end = new Float64Array(length);
      for (let i = 0; i < length; i += 1) {
        const p = (head + i) % capacity;
        begin[i] = this.#keys.begin[p]!;
        end[i] = this.#keys.end[p]!;
      }
      return new TimeRangeKeyColumn(begin, end, length);
    }
    const begin = new Float64Array(length);
    const end = new Float64Array(length);
    let labels: StringColumn | Float64Column;
    if (this.#keys.labelKind === 'string') {
      const srcLabels = this.#keys.labels as Array<string | undefined>;
      const gathered = new Array<string | undefined>(length);
      for (let i = 0; i < length; i += 1) {
        const p = (head + i) % capacity;
        begin[i] = this.#keys.begin[p]!;
        end[i] = this.#keys.end[p]!;
        gathered[i] = srcLabels[p];
      }
      labels = stringColumnFromArray(gathered);
    } else {
      const srcLabels = this.#keys.labels as Float64Array;
      const flat = new Float64Array(length);
      for (let i = 0; i < length; i += 1) {
        const p = (head + i) % capacity;
        begin[i] = this.#keys.begin[p]!;
        end[i] = this.#keys.end[p]!;
        flat[i] = srcLabels[p]!;
      }
      labels = new Float64Column(flat, length);
    }
    return new IntervalKeyColumn(begin, end, labels, length);
  }

  /**
   * Clears every value column's per-cell defined-state so the
   * ring is consistent at "all slots empty." Called when
   * `evictPrefix(n >= length)` and when a batch larger than
   * retention forces a full reset. **Must clear string/array
   * values too**, not just the validity bitmaps — the per-slot
   * undefined check is the defined-state discriminator for those
   * kinds, and leaving stale data would mislead a later write's
   * decision about whether the slot was previously occupied.
   */
  #clearAllSlots(): void {
    for (const [, ring] of this.#values) {
      if (ring.kind === 'number' || ring.kind === 'boolean') {
        ring.validity.fill(0);
        continue;
      }
      // string / array — re-initialize so every slot is undefined.
      for (let i = 0; i < ring.values.length; i += 1) {
        ring.values[i] = undefined;
      }
    }
  }

  #clearValidityForRow(physical: number): void {
    for (const [, ring] of this.#values) {
      if (ring.kind === 'number' || ring.kind === 'boolean') {
        ring.validity[physical >> 3]! &= ~(1 << (physical & 7));
      } else {
        // String / Array: the slot's truthiness lives in `values[physical]`.
        ring.values[physical] = undefined;
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers — kind-specific init / grow / write / snapshot.                    */
/* -------------------------------------------------------------------------- */

function initKeyRing(
  kind: KeyKind,
  capacity: number,
  intervalLabelKind: IntervalLabelKind | undefined,
): MutableKeyRing {
  if (kind === 'time') {
    return { kind: 'time', begin: new Float64Array(capacity) };
  }
  if (kind === 'timeRange') {
    return {
      kind: 'timeRange',
      begin: new Float64Array(capacity),
      end: new Float64Array(capacity),
    };
  }
  // interval — intervalLabelKind has been validated as defined by the constructor.
  const labels: Array<string | undefined> | Float64Array =
    intervalLabelKind === 'string'
      ? new Array<string | undefined>(capacity)
      : new Float64Array(capacity);
  return {
    kind: 'interval',
    labelKind: intervalLabelKind!,
    begin: new Float64Array(capacity),
    end: new Float64Array(capacity),
    labels,
  };
}

function initValueRing(kind: ColumnKind, capacity: number): MutableValueRing {
  if (kind === 'number') {
    return {
      kind: 'number',
      values: new Float64Array(capacity),
      validity: new Uint8Array(bitmapByteCount(capacity)),
    };
  }
  if (kind === 'boolean') {
    return {
      kind: 'boolean',
      values: new Uint8Array(bitmapByteCount(capacity)),
      validity: new Uint8Array(bitmapByteCount(capacity)),
    };
  }
  if (kind === 'string') {
    return {
      kind: 'string',
      values: new Array<string | undefined>(capacity),
    };
  }
  return {
    kind: 'array',
    values: new Array<ArrayValue | undefined>(capacity),
  };
}

function regrowValueRing(
  ring: MutableValueRing,
  newCapacity: number,
  head: number,
  length: number,
  oldCapacity: number,
): void {
  if (ring.kind === 'number') {
    const newValues = new Float64Array(newCapacity);
    const newValidity = new Uint8Array(bitmapByteCount(newCapacity));
    for (let i = 0; i < length; i += 1) {
      const p = (head + i) % oldCapacity;
      newValues[i] = ring.values[p]!;
      if ((ring.validity[p >> 3]! & (1 << (p & 7))) !== 0) {
        newValidity[i >> 3]! |= 1 << (i & 7);
      }
    }
    ring.values = newValues;
    ring.validity = newValidity;
    return;
  }
  if (ring.kind === 'boolean') {
    const newValues = new Uint8Array(bitmapByteCount(newCapacity));
    const newValidity = new Uint8Array(bitmapByteCount(newCapacity));
    for (let i = 0; i < length; i += 1) {
      const p = (head + i) % oldCapacity;
      if ((ring.values[p >> 3]! & (1 << (p & 7))) !== 0) {
        newValues[i >> 3]! |= 1 << (i & 7);
      }
      if ((ring.validity[p >> 3]! & (1 << (p & 7))) !== 0) {
        newValidity[i >> 3]! |= 1 << (i & 7);
      }
    }
    ring.values = newValues;
    ring.validity = newValidity;
    return;
  }
  // string / array
  if (ring.kind === 'string') {
    const newValues = new Array<string | undefined>(newCapacity);
    for (let i = 0; i < length; i += 1) {
      newValues[i] = ring.values[(head + i) % oldCapacity];
    }
    ring.values = newValues;
    return;
  }
  // array
  const newValues = new Array<ArrayValue | undefined>(newCapacity);
  for (let i = 0; i < length; i += 1) {
    newValues[i] = ring.values[(head + i) % oldCapacity];
  }
  ring.values = newValues;
}

function writeValueColumnRows(
  ring: MutableValueRing,
  source: Column,
  batchStart: number,
  toAppend: number,
  head: number,
  ringLengthBefore: number,
  capacity: number,
): void {
  for (let j = 0; j < toAppend; j += 1) {
    const srcRow = batchStart + j;
    const dst = (head + ringLengthBefore + j) % capacity;
    const value = source.read(srcRow);
    writeValueCell(ring, dst, value);
  }
}

function writeValueCell(
  ring: MutableValueRing,
  physical: number,
  value: unknown,
): void {
  if (ring.kind === 'number') {
    if (typeof value === 'number') {
      ring.values[physical] = value;
      ring.validity[physical >> 3]! |= 1 << (physical & 7);
    } else {
      ring.values[physical] = 0;
      ring.validity[physical >> 3]! &= ~(1 << (physical & 7));
    }
    return;
  }
  if (ring.kind === 'boolean') {
    if (typeof value === 'boolean') {
      if (value) {
        ring.values[physical >> 3]! |= 1 << (physical & 7);
      } else {
        ring.values[physical >> 3]! &= ~(1 << (physical & 7));
      }
      ring.validity[physical >> 3]! |= 1 << (physical & 7);
    } else {
      ring.values[physical >> 3]! &= ~(1 << (physical & 7));
      ring.validity[physical >> 3]! &= ~(1 << (physical & 7));
    }
    return;
  }
  if (ring.kind === 'string') {
    ring.values[physical] = typeof value === 'string' ? value : undefined;
    return;
  }
  // array — defensive copy + freeze matching `ArrayColumn`'s constructor
  // invariant.
  ring.values[physical] = Array.isArray(value)
    ? (Object.freeze((value as ArrayValue).slice()) as ArrayValue)
    : undefined;
}

function snapshotValueColumn(
  ring: MutableValueRing,
  length: number,
  head: number,
  capacity: number,
): Column {
  if (ring.kind === 'number') {
    const values = new Float64Array(length);
    let definedCount = 0;
    const validityBits = new Uint8Array(bitmapByteCount(length));
    for (let i = 0; i < length; i += 1) {
      const p = (head + i) % capacity;
      values[i] = ring.values[p]!;
      if ((ring.validity[p >> 3]! & (1 << (p & 7))) !== 0) {
        validityBits[i >> 3]! |= 1 << (i & 7);
        definedCount += 1;
      }
    }
    if (definedCount === length) {
      return new Float64Column(values, length);
    }
    return new Float64Column(
      values,
      length,
      validityFromBits(validityBits, length),
    );
  }
  if (ring.kind === 'boolean') {
    const values = new Uint8Array(bitmapByteCount(length));
    const validityBits = new Uint8Array(bitmapByteCount(length));
    let definedCount = 0;
    for (let i = 0; i < length; i += 1) {
      const p = (head + i) % capacity;
      if ((ring.values[p >> 3]! & (1 << (p & 7))) !== 0) {
        values[i >> 3]! |= 1 << (i & 7);
      }
      if ((ring.validity[p >> 3]! & (1 << (p & 7))) !== 0) {
        validityBits[i >> 3]! |= 1 << (i & 7);
        definedCount += 1;
      }
    }
    if (definedCount === length) {
      return new BooleanColumn(values, length);
    }
    return new BooleanColumn(
      values,
      length,
      validityFromBits(validityBits, length),
    );
  }
  if (ring.kind === 'string') {
    const gathered = new Array<string | undefined>(length);
    for (let i = 0; i < length; i += 1) {
      gathered[i] = ring.values[(head + i) % capacity];
    }
    return stringColumnFromArray(gathered);
  }
  // array
  const gathered = new Array<ArrayValue | undefined>(length);
  let definedCount = 0;
  for (let i = 0; i < length; i += 1) {
    const v = ring.values[(head + i) % capacity];
    gathered[i] = v;
    if (v !== undefined) definedCount += 1;
  }
  if (definedCount === length) {
    return new ArrayColumn(length, {
      fallback: gathered as ReadonlyArray<ArrayValue>,
    });
  }
  const validityBits = new Uint8Array(bitmapByteCount(length));
  for (let i = 0; i < length; i += 1) {
    if (gathered[i] !== undefined) {
      validityBits[i >> 3]! |= 1 << (i & 7);
    }
  }
  return new ArrayColumn(length, {
    fallback: gathered,
    validity: validityFromBits(validityBits, length),
  });
}
