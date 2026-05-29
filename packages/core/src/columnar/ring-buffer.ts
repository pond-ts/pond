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
      // Validate every value column kind at construction. Without
      // this, an upstream schema-drift bug (e.g. a 'timeRange'
      // value column) would survive ring construction and surface
      // only at first `snapshot()` via `fromTrustedStore` — far
      // from the schema-misconfiguration site. Closed Codex round
      // 4's medium finding on PR #149.
      const valueKind = def.kind;
      if (
        valueKind !== 'number' &&
        valueKind !== 'boolean' &&
        valueKind !== 'string' &&
        valueKind !== 'array'
      ) {
        throw new RangeError(
          `ColumnarRingBuffer: schema[${i}].kind '${valueKind}' is not a valid value-column kind ('number' | 'boolean' | 'string' | 'array')`,
        );
      }
      this.#values.set(
        def.name,
        initValueRing(valueKind as ColumnKind, initialCapacity),
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
    // **Failure-atomic ordering.** Plan the final layout first
    // (no mutation), then GROW BEFORE applying destructive ops
    // (clear / evict). Growth is the only step that can throw on
    // memory pressure; doing it first means a failed append leaves
    // the ring unchanged. Closed Codex round 3's high finding on
    // PR #149 — the previous order destroyed retained rows before
    // calling `#grow`, so an OOM mid-append would lose data the
    // caller still expected to be present.
    //
    // **Retention overflow.** When a single batch's length exceeds
    // retention, only the last `retention` rows make it into the
    // ring. Skip the earlier rows entirely — no point writing
    // them just to immediately evict.
    let batchStart = 0;
    let toAppend = batchLength;
    let willClearAll = false;
    let willEvict = 0;
    if (batchLength > this.retention) {
      batchStart = batchLength - this.retention;
      toAppend = this.retention;
      willClearAll = true;
    } else {
      const overflow = this.#length + toAppend - this.retention;
      if (overflow > 0) {
        willEvict = overflow;
      }
    }
    // **Pre-stage all throwing work BEFORE destructive ops.**
    // Two operations in the append flow can throw under memory
    // pressure: (1) typed-array allocation in `#grow`, and (2)
    // `slice()` + `Object.freeze` on array-column cells in
    // `writeValueCell`. Both happen before `#length += toAppend`
    // — so a throw between the destructive op and the commit
    // would leave retained rows discarded and new rows
    // uncommitted. Closed Codex round 4's high finding: pre-walk
    // every array-kind value column and gather its frozen cells
    // into a temporary `Map` while the ring is still intact;
    // the write phase then assigns those pre-frozen cells with
    // a plain reference copy (no realistic throw).
    const stagedArrayCells = this.#stageArrayCellsForAppend(
      batch,
      batchStart,
      toAppend,
    );
    // After the planned destructive op, the remaining live rows
    // will be `willClearAll ? 0 : #length - willEvict`. We need
    // enough capacity for that plus the `toAppend` new rows.
    const remainingAfter = willClearAll ? 0 : this.#length - willEvict;
    const required = remainingAfter + toAppend;
    if (required > this.#capacity) {
      // `#grow` is itself failure-atomic — leaves the ring
      // unchanged if any allocation throws.
      this.#grow(required);
    }
    // Growth succeeded. From here on every operation is O(N)
    // walks without allocation; no realistic throw path.
    if (willClearAll) {
      this.#length = 0;
      this.#head = 0;
      this.#clearAllSlots();
    } else if (willEvict > 0) {
      this.evictPrefix(willEvict);
    }
    // **Vectorized write per column.** Walk the batch's rows once
    // per column; for each, compute the destination physical
    // position and write. Array-kind columns use the pre-staged
    // frozen cells; other kinds read directly from the source
    // column (no allocation, can't throw).
    this.#writeBatch(batch, batchStart, toAppend, stagedArrayCells);
    this.#length += toAppend;
  }

  /**
   * @internal — trusted per-row append for streaming row-shape sources.
   *
   * Accepts a single row's key + value primitives directly, skipping
   * the `ColumnarStore` wrapper that `appendBatch` requires. Schema
   * validation happens once at ring construction; trusted-append
   * skips per-call structural checks and writes directly to circular
   * buffers in one pass.
   *
   * **Trust contract.** The caller guarantees:
   *
   * 1. `values.length === schema.length - 1` (positional, matches
   *    the schema's value columns in declaration order).
   * 2. Each `values[c - 1]` is assignment-compatible with
   *    `schema[c].kind`:
   *    - `'number'`: `typeof === 'number'` or `undefined`
   *    - `'boolean'`: `typeof === 'boolean'` or `undefined`
   *    - `'string'`: `typeof === 'string'` or `undefined`
   *    - `'array'`: `Array.isArray(value)` (will be sliced + frozen)
   *      or `undefined`
   * 3. For `interval` rings, `keyLabel` is a `string` if
   *    `labelKind === 'string'`, a finite `number` if
   *    `labelKind === 'number'`. For non-interval rings, `keyLabel`
   *    is ignored (pass `undefined`).
   * 4. For `time` rings, `keyEnd === keyBegin` (the caller is
   *    responsible for matching the `time` kind's
   *    `end === begin` invariant; the ring stores only `begin`
   *    for `time` keys but the caller must still pass a value).
   *
   * Misuse is the caller's bug; the ring may produce silently
   * incorrect data rather than throwing on misuse. Use `appendBatch`
   * if you need schema validation.
   *
   * **Failure-atomic.** Mirrors `appendBatch`'s discipline:
   *
   * - For array-kind value columns, the slice + freeze of the
   *   incoming `ArrayValue` happens BEFORE any destructive ring
   *   mutation (growth, eviction, length advance). Closed Codex
   *   round 4's high finding on PR #149 for batch path; same
   *   discipline applied here.
   * - `#grow` is the only typed-array allocation in the flow and
   *   is itself failure-atomic.
   * - A throw mid-call leaves the ring unchanged.
   *
   * **Use case.** `LiveSeries.pushMany` calls this per row inside
   * its row-validation loop. Preserves the per-row `'event'`
   * listener fan-out contract while skipping the per-row
   * ColumnarStore wrapper allocation that the batch path would
   * pay. The row-shape API matches the workload the ring buffer
   * was designed for ("streaming sources emit rows
   * continuously").
   *
   * Not exported from `packages/core/src/index.ts`; reach via the
   * `ColumnarRingBuffer` class only from in-package trusted
   * callers.
   */
  _appendRowTrusted(
    keyBegin: number,
    keyEnd: number,
    keyLabel: string | number | undefined,
    values: ReadonlyArray<unknown>,
  ): void {
    const schemaLen = this.schema.length;

    // Stage any array-column cells BEFORE destructive ops. Mirrors
    // `#stageArrayCellsForAppend`'s role on the batch path: copy +
    // freeze can throw under memory pressure, and we want any throw
    // to land before we mutate the ring. Single-row path stages at
    // most one cell per array column.
    let stagedArrayCells: Map<string, ArrayValue | undefined> | null = null;
    for (let c = 1; c < schemaLen; c += 1) {
      const def = this.schema[c]!;
      if (def.kind !== 'array') continue;
      if (stagedArrayCells === null) stagedArrayCells = new Map();
      const value = values[c - 1];
      stagedArrayCells.set(
        def.name,
        Array.isArray(value)
          ? (Object.freeze((value as ArrayValue).slice()) as ArrayValue)
          : undefined,
      );
    }

    // Eviction-by-1 needed when length === retention and we're
    // about to add one more row.
    const willEvict = this.#length + 1 > this.retention ? 1 : 0;

    // Capacity required after the planned eviction.
    const remainingAfter = this.#length - willEvict;
    const required = remainingAfter + 1;
    if (required > this.#capacity) {
      // `#grow` is failure-atomic — leaves the ring unchanged on
      // any throw.
      this.#grow(required);
    }

    // Apply eviction (post-grow; no throws remaining).
    if (willEvict > 0) this.evictPrefix(willEvict);

    // Write the row. All operations from here are non-throwing.
    const dst = (this.#head + this.#length) % this.#capacity;
    this.#keys.begin[dst] = keyBegin;
    if (this.#keys.kind === 'timeRange' || this.#keys.kind === 'interval') {
      this.#keys.end[dst] = keyEnd;
    }
    if (this.#keys.kind === 'interval') {
      if (this.#keys.labelKind === 'string') {
        (this.#keys.labels as Array<string | undefined>)[dst] =
          keyLabel as string;
      } else {
        (this.#keys.labels as Float64Array)[dst] = keyLabel as number;
      }
    }

    // Value columns. Array kind uses the pre-staged cell; other
    // kinds write through the shared `writeValueCell` helper.
    for (let c = 1; c < schemaLen; c += 1) {
      const def = this.schema[c]!;
      const ring = this.#values.get(def.name)!;
      if (ring.kind === 'array') {
        const cell = stagedArrayCells!.get(def.name);
        (ring as MutableArrayRing).values[dst] = cell;
        // Array columns derive validity from undefined slots during
        // snapshot (per `snapshotValueColumn`'s array path); no
        // per-cell validity-bit write needed here.
        continue;
      }
      writeValueCell(ring, dst, values[c - 1]);
    }

    this.#length += 1;
  }

  /**
   * Pre-stages array-column cells before any destructive ring
   * mutation. For each `kind: 'array'` value column in the
   * schema, walks the batch's rows in `[batchStart, batchStart +
   * toAppend)` and copies + freezes each defined cell into a
   * fresh list. Returns a `Map<columnName, Array<ArrayValue |
   * undefined>>` indexed by `j` (the row offset within the
   * `toAppend` window).
   *
   * **Why this exists.** `writeValueCell` for array kind does
   * `Object.freeze((value as ArrayValue).slice())` — both
   * `Array.prototype.slice()` and the freeze-result allocation
   * can throw under memory pressure. Performing those throws
   * BEFORE the destructive `clear` / `evict` keeps `appendBatch`
   * failure-atomic for array columns (matching what `#grow` does
   * for typed-array allocations). After this returns, the write
   * phase just assigns the pre-frozen cell with no realistic
   * throw path.
   *
   * Returns an empty `Map` when the schema has no array columns —
   * the common case, no extra cost for non-array workloads.
   */
  #stageArrayCellsForAppend(
    batch: ColumnarStore<S>,
    batchStart: number,
    toAppend: number,
  ): Map<string, Array<ArrayValue | undefined>> {
    const staged = new Map<string, Array<ArrayValue | undefined>>();
    for (let c = 1; c < this.schema.length; c += 1) {
      const def = this.schema[c]!;
      if (def.kind !== 'array') continue;
      const sourceCol = batch.columns.get(def.name)!;
      const cells = new Array<ArrayValue | undefined>(toAppend);
      for (let j = 0; j < toAppend; j += 1) {
        const value = sourceCol.read(batchStart + j);
        cells[j] = Array.isArray(value)
          ? (Object.freeze((value as ArrayValue).slice()) as ArrayValue)
          : undefined;
      }
      staged.set(def.name, cells);
    }
    return staged;
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

  /**
   * Validates that the incoming batch's schema matches the ring's
   * structurally (same length, same `name` / `kind` per position).
   * Short-circuits on reference equality — the common case when
   * a producer constructs every batch with the same schema literal.
   * For `interval` rings, also validates that the batch's
   * `labelKind` matches the ring's; otherwise the per-row label
   * write would route into a wrong-typed slot.
   *
   * Internal to `appendBatch`. Throws `RangeError` on any
   * mismatch.
   */
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

  /**
   * Per-row write loop: copies key fields and every value column
   * from the batch into the ring at the correct physical
   * positions, using circular indexing
   * (`(head + length + j) % capacity`). Assumes
   * `#validateBatchSchema` has run, capacity is sufficient
   * (`#grow` was called if needed), `stagedArrayCells` has been
   * built from the source (pre-frozen by
   * `#stageArrayCellsForAppend`), and any necessary eviction
   * has already advanced `#head` / `#length`.
   *
   * **Key kinds:**
   * - `time` — writes `begin` only.
   * - `timeRange` — writes `begin` + `end`.
   * - `interval` — writes `begin` + `end` + `labels` (per
   *   `labelKind`, either a string slot or a Float64 slot).
   *
   * Value-column writes delegate to `writeValueColumnRows` for
   * per-kind branching; array-kind columns use the pre-staged
   * frozen cells so the inner write is a plain reference copy
   * with no allocation.
   */
  #writeBatch(
    batch: ColumnarStore<S>,
    batchStart: number,
    toAppend: number,
    stagedArrayCells: Map<string, Array<ArrayValue | undefined>>,
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
      if (ring.kind === 'array') {
        // Array columns use the pre-frozen cells gathered before
        // any destructive op.
        const cells = stagedArrayCells.get(def.name)!;
        writeArrayColumnFromStaged(
          ring,
          cells,
          toAppend,
          this.#head,
          this.#length,
          this.#capacity,
        );
        continue;
      }
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

  /**
   * Grows the ring's physical capacity to at least `required`,
   * capped at `retention`. Computes the target by doubling
   * (`max(currentCap * 2, required)`) and clamping, then unrolls
   * the current circular buffer into fresh linear buffers at the
   * new capacity. Head resets to 0; length is unchanged.
   *
   * No-op when the current capacity already covers `required`,
   * or when the ring is already at retention (the eviction path
   * is responsible for keeping `length <= retention` so growth
   * is unnecessary at that point).
   *
   * **Failure-atomic.** All replacement key + value buffers are
   * built into local variables first; only after every allocation
   * has succeeded do we commit by swapping the ring's fields in
   * one block. If any intermediate allocation throws under memory
   * pressure, the ring is left exactly as it was — no half-grown
   * state where keys point at a linear buffer while value columns
   * still describe the old circular layout. Closed Codex round 2's
   * medium finding on PR #149.
   *
   * Cost: O(length) per grow, amortized O(1) over many appends
   * (the doubling schedule means each row is copied at most
   * O(log retention) times across the ring's lifetime).
   */
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
    // Build all replacements into local variables. Any throw here
    // (e.g. typed-array allocation OOM) leaves the ring untouched.
    const newKeys = this.#buildRegrownKeys(newCapacity);
    const newValues = new Map<string, MutableValueRing>();
    for (const [name, ring] of this.#values) {
      newValues.set(
        name,
        buildRegrownValueRing(
          ring,
          newCapacity,
          this.#head,
          this.#length,
          this.#capacity,
        ),
      );
    }
    // Atomic commit. From here on every assignment is O(1) and
    // can't throw.
    this.#keys = newKeys;
    this.#values = newValues;
    this.#head = 0;
    this.#capacity = newCapacity;
  }

  /**
   * Returns a fresh `MutableKeyRing` sized to `newCapacity` with
   * every live row copied from the current circular buffer in
   * logical order. **Does not mutate `this.#keys`** — the caller
   * (`#grow`) holds the new ring in a local and commits it as
   * part of the atomic swap.
   *
   * Per key kind:
   * - `time` — copy `begin` only.
   * - `timeRange` — copy `begin` + `end`.
   * - `interval` — copy `begin` + `end` + `labels` (per
   *   `labelKind`, either into a new string array or a fresh
   *   `Float64Array`).
   */
  #buildRegrownKeys(newCapacity: number): MutableKeyRing {
    const length = this.#length;
    const capacity = this.#capacity;
    const head = this.#head;
    if (this.#keys.kind === 'time') {
      const newBegin = new Float64Array(newCapacity);
      for (let i = 0; i < length; i += 1) {
        newBegin[i] = this.#keys.begin[(head + i) % capacity]!;
      }
      return { kind: 'time', begin: newBegin };
    }
    if (this.#keys.kind === 'timeRange') {
      const newBegin = new Float64Array(newCapacity);
      const newEnd = new Float64Array(newCapacity);
      for (let i = 0; i < length; i += 1) {
        const p = (head + i) % capacity;
        newBegin[i] = this.#keys.begin[p]!;
        newEnd[i] = this.#keys.end[p]!;
      }
      return { kind: 'timeRange', begin: newBegin, end: newEnd };
    }
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
    return {
      kind: 'interval',
      labelKind: this.#keys.labelKind,
      begin: newBegin,
      end: newEnd,
      labels: newLabels,
    };
  }

  /**
   * Builds an immutable `KeyColumn` for the ring's snapshot.
   * Walks the live circular window in logical order into fresh
   * typed buffers (and a fresh gathered label array for interval
   * string labels, fed through `stringColumnFromArray` so the
   * dict-vs-fallback heuristic runs once on the snapshot window).
   *
   * Decoupled from the ring: the returned `KeyColumn` owns its
   * buffers — subsequent mutations of `this.#keys` don't affect
   * the snapshot.
   */
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

/**
 * Builds the mutable storage for the key column at the ring's
 * current capacity. Per key kind:
 *
 * - `time` — just a `begin` `Float64Array`. `end === begin`
 *   semantically; the snapshot's `TimeKeyColumn` re-aliases them.
 * - `timeRange` — `begin` + `end` `Float64Array`s.
 * - `interval` — `begin` + `end` + a labels buffer that's either
 *   `(string | undefined)[]` or `Float64Array` per
 *   `intervalLabelKind`. The constructor's `keyKind === 'interval'`
 *   branch validates that `intervalLabelKind` is set; this helper
 *   trusts it (non-null assertion below).
 */
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

/**
 * Builds the mutable storage for one value column at the ring's
 * current capacity. Each kind gets the typed-array shape that
 * matches its plain-column counterpart:
 *
 * - `number` — `Float64Array` for values, `Uint8Array` of
 *   `ceil(capacity / 8)` bytes for validity bits.
 * - `boolean` — bit-packed `Uint8Array` for both values and
 *   validity (1 bit per cell each).
 * - `string` — plain `(string | undefined)[]`. Snapshot rebuilds
 *   dict-vs-fallback encoding via `stringColumnFromArray`.
 * - `array` — plain `(ArrayValue | undefined)[]`. Cells are
 *   defensively frozen at append time.
 *
 * Validity is allocated unconditionally for number/boolean even
 * if every cell will be defined — the per-cell write path needs
 * a buffer to flip bits against, and lazily allocating would
 * complicate the eviction/growth bookkeeping for marginal
 * memory savings.
 */
function initValueRing(kind: ColumnKind, capacity: number): MutableValueRing {
  switch (kind) {
    case 'number':
      return {
        kind: 'number',
        values: new Float64Array(capacity),
        validity: new Uint8Array(bitmapByteCount(capacity)),
      };
    case 'boolean':
      return {
        kind: 'boolean',
        values: new Uint8Array(bitmapByteCount(capacity)),
        validity: new Uint8Array(bitmapByteCount(capacity)),
      };
    case 'string':
      return {
        kind: 'string',
        values: new Array<string | undefined>(capacity),
      };
    case 'array':
      return {
        kind: 'array',
        values: new Array<ArrayValue | undefined>(capacity),
      };
    default: {
      // Exhaustiveness — the constructor validates `kind` upstream,
      // so reaching here means a caller bypassed the public API.
      const exhaust: never = kind;
      throw new RangeError(
        `initValueRing: unsupported column kind '${exhaust as string}'`,
      );
    }
  }
}

/**
 * Returns a fresh `MutableValueRing` sized to `newCapacity` with
 * every live row copied from the source ring's circular buffer
 * in logical order. **Does not mutate `ring`** — the caller
 * (`#grow`) holds the new ring in a local and commits it as
 * part of the atomic swap, so a mid-loop throw under memory
 * pressure can't leave the original ring half-grown.
 *
 * Per kind:
 * - `number` — fresh `Float64Array` + new validity `Uint8Array`,
 *   bits copied physical-to-logical.
 * - `boolean` — same shape with bit-packed `values` too.
 * - `string` / `array` — fresh `Array` of the slot type, cells
 *   copied by reference (already defensively frozen at original
 *   write time for arrays; strings are immutable).
 */
function buildRegrownValueRing(
  ring: MutableValueRing,
  newCapacity: number,
  head: number,
  length: number,
  oldCapacity: number,
): MutableValueRing {
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
    return { kind: 'number', values: newValues, validity: newValidity };
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
    return { kind: 'boolean', values: newValues, validity: newValidity };
  }
  if (ring.kind === 'string') {
    const newValues = new Array<string | undefined>(newCapacity);
    for (let i = 0; i < length; i += 1) {
      newValues[i] = ring.values[(head + i) % oldCapacity];
    }
    return { kind: 'string', values: newValues };
  }
  // array
  const newValues = new Array<ArrayValue | undefined>(newCapacity);
  for (let i = 0; i < length; i += 1) {
    newValues[i] = ring.values[(head + i) % oldCapacity];
  }
  return { kind: 'array', values: newValues };
}

/**
 * Per-row write loop for one value column. Reads rows `[batchStart,
 * batchStart + toAppend)` from `source` and writes them into the
 * ring's circular storage at physical positions `(head +
 * ringLengthBefore + j) % capacity`. Each cell goes through
 * `writeValueCell`, which encodes the per-kind validity update.
 *
 * `source.read(srcRow)` returns `undefined` for invalid cells; the
 * per-kind branch in `writeValueCell` translates that into the
 * ring's defined-state discriminator (validity-bit-clear for
 * number/boolean; `undefined` slot for string/array).
 */
function writeValueColumnRows(
  ring: MutableFloat64Ring | MutableBooleanRing | MutableStringRing,
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

/**
 * Writes one cell at physical position `physical`. Per kind:
 *
 * - `number` — store the float (or 0 for invalid) and toggle the
 *   validity bit.
 * - `boolean` — store the boolean bit (or 0) and the validity
 *   bit (or 0).
 * - `string` — store the string or `undefined`. The slot's
 *   truthiness IS the defined discriminator (no separate
 *   validity bitmap).
 *
 * Array-kind columns do NOT route through this function — they
 * use `writeArrayColumnFromStaged` with cells pre-frozen by
 * `#stageArrayCellsForAppend` so the throwing slice/freeze
 * happens before the ring's destructive ops.
 *
 * Idempotent and clobber-safe: callers don't need to track
 * whether `physical` was previously defined — the writes set or
 * clear bits / values based purely on `value`'s type. No
 * allocations; this function can't throw on memory pressure.
 */
function writeValueCell(
  ring: MutableFloat64Ring | MutableBooleanRing | MutableStringRing,
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
  // string
  ring.values[physical] = typeof value === 'string' ? value : undefined;
}

/**
 * Array-column write path: assigns each pre-staged frozen cell
 * directly into the ring at the correct physical position. No
 * allocation, no slice, no freeze — those happened during
 * `#stageArrayCellsForAppend` before the ring's destructive ops.
 * This function can't throw on memory pressure, which is what
 * makes the array-column `appendBatch` flow failure-atomic.
 */
function writeArrayColumnFromStaged(
  ring: MutableArrayRing,
  cells: ReadonlyArray<ArrayValue | undefined>,
  toAppend: number,
  head: number,
  ringLengthBefore: number,
  capacity: number,
): void {
  for (let j = 0; j < toAppend; j += 1) {
    const dst = (head + ringLengthBefore + j) % capacity;
    ring.values[dst] = cells[j];
  }
}

/**
 * Builds an immutable `Column` snapshot of one value-column ring.
 * Allocates fresh typed-array buffers sized to `length` and walks
 * the ring's circular storage in logical order
 * (`(head + i) % capacity`). For each kind:
 *
 * - `number` — copies values into a `Float64Array` and gathers
 *   validity bits into a fresh bitmap; drops the bitmap if every
 *   cell is defined (matching the framework convention).
 * - `boolean` — same shape using bit-packed values + validity.
 * - `string` — gathers into `(string | undefined)[]` and runs
 *   `stringColumnFromArray` so the snapshot's encoding (dict vs
 *   fallback) is chosen freshly on the snapshot window — no
 *   stale per-batch dictionaries bleed through.
 * - `array` — gathers into `(ArrayValue | undefined)[]` and
 *   derives validity from `undefined` slots; drops the bitmap if
 *   every cell is defined.
 *
 * The returned column owns its buffers — subsequent ring
 * mutations don't affect it.
 */
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
