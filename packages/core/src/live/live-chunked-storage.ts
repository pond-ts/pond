/**
 * `ChunkedColumnarLiveStorage<S>` — the column-native live buffer.
 *
 * The OOM fix for `LiveSeries` at high partition count. Instead of
 * retaining a window of `Event` objects (one `Event` + `Time` +
 * frozen data dict per row — ~31 MB for a 200k window, tenured), it
 * holds each `pushMany` batch as a `ColumnarStore` **chunk** of
 * typed-array columns (~7 MB for the same window) and retains **zero
 * `Event` objects**. Measured 4.6× less retained heap; see
 * `scripts/investigate-batch.mjs` and
 * `docs/briefs/column-native-live-pipeline.md`.
 *
 * **Append is batch-granular.** A whole `pushMany` batch validates
 * directly into columns (`validateAndNormalizeColumnar` — the Step 2c
 * intake) and becomes one chunk. No per-row `Event` is created on
 * this path — that's the entire point (creating + decomposing an
 * `Event` per row was the Step 7 ring's 9× loss).
 *
 * **Retention is exact via boundary-slice.** `evictPrefix(n)` /
 * `dropPrefix(n)` drop whole chunks off the front, then slice the
 * boundary chunk (zero-copy `sliceByRange` on Float64 columns) so
 * `length` stays exactly `total - n` — no batch-granular fuzz. This
 * keeps `maxEvents` / `maxAge` exact at the row level, matching the
 * array backing.
 *
 * **`Event`s materialize lazily** on `at(i)` and cache for reference
 * stability (`at(i) === at(i)`); the cache remaps on eviction so
 * identity survives the logical-index shift.
 *
 * **Append-only.** No sorted mid-stream insertion. The class itself
 * supports `time` and `timeRange` keys, but `LiveSeries` currently
 * routes only **top-level `strict` time-keyed** series here (the OOM
 * case). `drop` (needs per-row out-of-order filtering), `timeRange`
 * (strict order is `(begin, end)` — deferred), `reorder`, interval
 * keys, and internally-created series keep the `Event[]` backing.
 *
 * Framework-internal; not exported from `packages/core/src/index.ts`.
 */

import { Event } from '../core/event.js';
import { Time } from '../core/time.js';
import { TimeRange } from '../core/time-range.js';
import { TimeSeries } from '../batch/time-series.js';
import { validateAndNormalizeColumnar } from '../batch/validate.js';
import { ColumnarStore } from '../columnar/store.js';
import type { Column } from '../columnar/column.js';
import type { EventKey } from '../core/temporal.js';
import type {
  EventForSchema,
  RowForSchema,
  SeriesSchema,
} from '../schema/index.js';
import type { ReadableLiveStorage } from './live-storage.js';

/**
 * Materialize a fresh `Event[]` from a (time / timeRange) store —
 * used by `LiveSeries`'s transient `'event'` / `'batch'` fan-out on
 * the chunked path. These events are NOT cached (young-gen, GC'd
 * after the listeners run), so they don't defeat the heap win.
 */
export function materializeEventsFromStore<S extends SeriesSchema>(
  store: ColumnarStore<S>,
  schema: S,
): EventForSchema<S>[] {
  const keyKind = schema[0].kind;
  const valueNames: string[] = [];
  for (let i = 1; i < schema.length; i += 1) {
    valueNames.push((schema[i] as { name: string }).name);
  }
  const out: EventForSchema<S>[] = new Array(store.length);
  for (let i = 0; i < store.length; i += 1) {
    const begin = store.beginAt(i);
    const key =
      keyKind === 'time'
        ? new Time(begin)
        : new TimeRange({ start: begin, end: store.endAt(i) });
    const data: Record<string, unknown> = {};
    for (let v = 0; v < valueNames.length; v += 1) {
      data[valueNames[v]!] = store.valueAt(i, valueNames[v]!);
    }
    out[i] = new Event(key, data) as unknown as EventForSchema<S>;
  }
  return out;
}

/**
 * Like {@link materializeEventsFromStore} but over a subset of rows
 * (`indices`, in order) — the transient `'event'` / `'batch'` fan-out
 * for the column-native partition router's staged slice. NOT cached
 * (young-gen), so it doesn't defeat the heap win.
 */
export function materializeEventsFromStoreAt<S extends SeriesSchema>(
  store: ColumnarStore<S>,
  indices: ArrayLike<number>,
  schema: S,
): EventForSchema<S>[] {
  const keyKind = schema[0].kind;
  const valueNames: string[] = [];
  for (let i = 1; i < schema.length; i += 1) {
    valueNames.push((schema[i] as { name: string }).name);
  }
  const out: EventForSchema<S>[] = new Array(indices.length);
  for (let j = 0; j < indices.length; j += 1) {
    const i = indices[j]!;
    const begin = store.beginAt(i);
    const key =
      keyKind === 'time'
        ? new Time(begin)
        : new TimeRange({ start: begin, end: store.endAt(i) });
    const data: Record<string, unknown> = {};
    for (let v = 0; v < valueNames.length; v += 1) {
      data[valueNames[v]!] = store.valueAt(i, valueNames[v]!);
    }
    out[j] = new Event(key, data) as unknown as EventForSchema<S>;
  }
  return out;
}

/** Row-range slice of a store: sliced keys + each column sliced in lockstep. */
function sliceStore<S extends SeriesSchema>(
  store: ColumnarStore<S>,
  start: number,
  end: number,
): ColumnarStore<S> {
  const keys = store.keys.sliceByRange(start, end);
  const columns = new Map<string, Column>();
  for (let i = 1; i < store.schema.length; i += 1) {
    const name = (store.schema[i] as { name: string }).name;
    columns.set(name, store.columns.get(name)!.sliceByRange(start, end));
  }
  return ColumnarStore.fromTrustedStore(store.schema, keys, columns);
}

export class ChunkedColumnarLiveStorage<
  S extends SeriesSchema,
> implements ReadableLiveStorage<S> {
  readonly #schema: S;
  readonly #keyKind: 'time' | 'timeRange';
  readonly #valueNames: ReadonlyArray<string>;
  #chunks: ColumnarStore<S>[] = [];
  /** Rows committed to `#chunks` (excludes the pending staging tier). */
  #committed = 0;
  /**
   * Staging tier — gathered row tuples not yet compacted into a chunk.
   * The coalescing fix for thin partition routing (scatter delivers ~1
   * row per partition per source batch; one chunk each would be ~23×
   * the object count of the Events it replaces — see PLAN "Deferred").
   * Rows accumulate here (cheap pushes, no per-batch `ColumnarStore`),
   * then flush as ONE packed chunk at `#flushThreshold`. Readable in
   * place so the live series' `length` / `at(i)` / retention see staged
   * rows immediately. Bounded to `[0, #flushThreshold)` at any instant.
   */
  #pending: RowForSchema<S>[] = [];
  readonly #flushThreshold: number;
  /** Lazy event materialization cache, keyed by logical index. */
  #cache = new Map<number, EventForSchema<S>>();

  constructor(schema: S, flushThreshold = 256) {
    this.#schema = schema;
    const keyKind = schema[0].kind;
    if (keyKind !== 'time' && keyKind !== 'timeRange') {
      throw new Error(
        `ChunkedColumnarLiveStorage: unsupported key kind '${keyKind}' (expected 'time' | 'timeRange')`,
      );
    }
    if (!Number.isInteger(flushThreshold) || flushThreshold < 1) {
      throw new Error(
        `ChunkedColumnarLiveStorage: flushThreshold must be a positive integer, got ${flushThreshold}`,
      );
    }
    this.#keyKind = keyKind;
    this.#flushThreshold = flushThreshold;
    this.#valueNames = schema.slice(1).map((c) => c.name);
  }

  get length(): number {
    return this.#committed + this.#pending.length;
  }

  /**
   * Number of committed (compacted) chunks. Test/bench observability for
   * the coalescing win — under thin partition routing this stays bounded
   * (≈ rows / flushThreshold) instead of one chunk per source batch.
   */
  get committedChunkCount(): number {
    return this.#chunks.length;
  }

  /** Rows currently in the un-flushed staging tier (`< flushThreshold`). */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /**
   * Validate a batch of rows directly into columns and append it as a
   * chunk. No per-row `Event` is created. The caller (`LiveSeries`)
   * has already enforced the ordering policy (the batch is in-order
   * and `>=` the current last key).
   */
  appendChunkFromRows(rows: ReadonlyArray<RowForSchema<S>>): void {
    if (rows.length === 0) return;
    const { keys, columns } = validateAndNormalizeColumnar<S>({
      name: 'live-chunk',
      schema: this.#schema,
      rows,
    });
    this.appendStore(
      ColumnarStore.fromTrustedStore(this.#schema, keys, columns),
    );
  }

  /**
   * Append a pre-validated `ColumnarStore` as a chunk (the mechanic).
   * `LiveSeries`'s `pushMany` validates + order-checks the batch, then
   * calls this; `appendChunkFromRows` is the validate-and-append
   * convenience used by the isolated tests.
   */
  appendStore(store: ColumnarStore<S>): void {
    if (store.length === 0) return;
    // A direct chunk lands logically AFTER any staged rows, so flush
    // pending first to keep committed order correct. (In practice a
    // storage uses either appendStore — the source's big batches — or
    // stageRows — partition routing — not both; the guard keeps the
    // order contract unconditional.)
    if (this.#pending.length > 0) this.#flushPending();
    this.#chunks.push(store);
    this.#committed += store.length;
  }

  /**
   * Stage a partition's slice of a source chunk: gather rows `indices`
   * from `store` into the pending tier (cheap tuples — NO per-batch
   * `ColumnarStore`), flushing one packed chunk when the tier reaches
   * `#flushThreshold`. The column-native partition-routing path
   * (`LivePartitionedSeries.#routeChunk`); the coalescing fix for thin
   * scatter (gRPC V7: naive one-chunk-per-slice was 23.5× the object
   * count + a throughput collapse). The caller guarantees the gathered
   * rows are `>=` the current last key (strict source + order-preserving
   * scatter). Time-keyed only — the chunked routing gate is strict+time.
   */
  stageRows(store: ColumnarStore<S>, indices: ArrayLike<number>): void {
    if (this.#keyKind !== 'time') {
      throw new Error(
        `ChunkedColumnarLiveStorage.stageRows: only 'time' keys are stageable (got '${this.#keyKind}')`,
      );
    }
    const k = indices.length;
    if (k === 0) return;
    const valueNames = this.#valueNames;
    for (let j = 0; j < k; j += 1) {
      const i = indices[j]!;
      const row: unknown[] = [store.beginAt(i)];
      for (let v = 0; v < valueNames.length; v += 1) {
        row.push(store.valueAt(i, valueNames[v]!));
      }
      this.#pending.push(row as RowForSchema<S>);
    }
    if (this.#pending.length >= this.#flushThreshold) this.#flushPending();
  }

  /**
   * Compact the pending tier into one packed chunk. Rows are trusted
   * (gathered from a validated source store), but reusing
   * `validateAndNormalizeColumnar` is fine — it runs once per
   * `#flushThreshold` rows (amortized O(N)), and avoids re-implementing
   * per-kind column + validity construction.
   */
  #flushPending(): void {
    if (this.#pending.length === 0) return;
    const { keys, columns } = validateAndNormalizeColumnar<S>({
      name: 'live-chunk',
      schema: this.#schema,
      rows: this.#pending,
    });
    this.#chunks.push(
      ColumnarStore.fromTrustedStore(this.#schema, keys, columns),
    );
    this.#committed += this.#pending.length;
    this.#pending = [];
  }

  /**
   * Locate a COMMITTED logical index `i` as `[chunkIndex, localIndex]`,
   * or null if out of the committed range. Pending-tier indices
   * (`i >= #committed`) are handled by the callers, not here.
   */
  #locate(i: number): [number, number] | null {
    if (i < 0 || i >= this.#committed) return null;
    let acc = 0;
    for (let c = 0; c < this.#chunks.length; c += 1) {
      const len = this.#chunks[c]!.length;
      if (i < acc + len) return [c, i - acc];
      acc += len;
    }
    return null; // unreachable given the range guard
  }

  at(index: number): EventForSchema<S> | undefined {
    if (index < 0 || index >= this.length) return undefined;
    let event = this.#cache.get(index);
    if (event === undefined) {
      if (index < this.#committed) {
        const loc = this.#locate(index)!;
        event = this.#materializeAt(loc[0], loc[1]);
      } else {
        event = this.#materializePending(index - this.#committed);
      }
      this.#cache.set(index, event);
    }
    return event;
  }

  keyAt(index: number): EventKey | undefined {
    if (index < 0 || index >= this.length) return undefined;
    const cached = this.#cache.get(index);
    if (cached !== undefined) return cached.key();
    if (index < this.#committed) {
      const loc = this.#locate(index)!;
      return this.#keyAt(loc[0], loc[1]);
    }
    return new Time(
      this.#pending[index - this.#committed]![0] as number,
    ) as unknown as EventKey;
  }

  beginAt(index: number): number | undefined {
    if (index < 0 || index >= this.length) return undefined;
    if (index < this.#committed) {
      const loc = this.#locate(index)!;
      return this.#chunks[loc[0]]!.beginAt(loc[1]);
    }
    return this.#pending[index - this.#committed]![0] as number;
  }

  last(): EventForSchema<S> | undefined {
    return this.at(this.length - 1);
  }

  evictPrefix(n: number): ReadonlyArray<EventForSchema<S>> {
    if (n <= 0) return [];
    const evicted: EventForSchema<S>[] = new Array(n);
    for (let i = 0; i < n; i += 1) evicted[i] = this.at(i)!;
    this.#evictExact(n);
    this.#shiftCacheBy(n);
    return evicted;
  }

  dropPrefix(n: number): void {
    if (n <= 0) return;
    this.#evictExact(n);
    this.#shiftCacheBy(n);
  }

  clear(): ReadonlyArray<EventForSchema<S>> {
    const len = this.length;
    if (len === 0) return [];
    const all: EventForSchema<S>[] = new Array(len);
    for (let i = 0; i < len; i += 1) all[i] = this.at(i)!;
    this.#chunks = [];
    this.#committed = 0;
    this.#pending = [];
    this.#cache.clear();
    return all;
  }

  snapshot(name: string): TimeSeries<S> {
    // Walk committed chunks then the pending tier, materializing rows.
    // (A columnar fast-path snapshot — concatSorted(chunks) → trusted
    // TimeSeries — is a deferred follow-up; snapshot isn't the hot path.)
    const schema = this.#schema;
    const rows: unknown[][] = new Array(this.length);
    let r = 0;
    for (let c = 0; c < this.#chunks.length; c += 1) {
      const store = this.#chunks[c]!;
      for (let i = 0; i < store.length; i += 1) {
        const row: unknown[] = [this.#keyAt(c, i)];
        for (let v = 0; v < this.#valueNames.length; v += 1) {
          row.push(store.valueAt(i, this.#valueNames[v]!));
        }
        rows[r] = row;
        r += 1;
      }
    }
    for (let p = 0; p < this.#pending.length; p += 1) {
      const pr = this.#pending[p]!;
      rows[r] = [new Time(pr[0] as number), ...(pr as unknown[]).slice(1)];
      r += 1;
    }
    return new TimeSeries({ name, schema, rows: rows as RowForSchema<S>[] });
  }

  /**
   * Drop exactly the oldest `n` rows: whole committed chunks, then a
   * boundary slice, then the pending tier (only reached when the
   * retention window is smaller than the pending tail — tiny windows).
   */
  #evictExact(n: number): void {
    let toEvict = n;
    while (toEvict > 0 && this.#chunks.length > 0) {
      const c0 = this.#chunks[0]!;
      if (c0.length <= toEvict) {
        toEvict -= c0.length;
        this.#committed -= c0.length;
        this.#chunks.shift();
      } else {
        // Partial: slice the oldest `toEvict` rows off the boundary chunk.
        this.#chunks[0] = sliceStore(c0, toEvict, c0.length);
        this.#committed -= toEvict;
        toEvict = 0;
      }
    }
    if (toEvict > 0 && this.#pending.length > 0) {
      this.#pending.splice(0, Math.min(toEvict, this.#pending.length));
    }
  }

  /** Remap the cache after evicting `n` head rows: drop `<n`, shift the rest down. */
  #shiftCacheBy(n: number): void {
    if (this.#cache.size === 0) return;
    const next = new Map<number, EventForSchema<S>>();
    for (const [index, event] of this.#cache) {
      if (index >= n) next.set(index - n, event);
    }
    this.#cache = next;
  }

  #keyAt(chunkIdx: number, localIdx: number): EventKey {
    const store = this.#chunks[chunkIdx]!;
    const begin = store.beginAt(localIdx);
    if (this.#keyKind === 'time') {
      return new Time(begin) as unknown as EventKey;
    }
    return new TimeRange({
      start: begin,
      end: store.endAt(localIdx),
    }) as unknown as EventKey;
  }

  /** Materialize an Event from a pending-tier row tuple (time-keyed). */
  #materializePending(p: number): EventForSchema<S> {
    const row = this.#pending[p]!;
    const key = new Time(row[0] as number);
    const data: Record<string, unknown> = {};
    for (let v = 0; v < this.#valueNames.length; v += 1) {
      data[this.#valueNames[v]!] = (row as unknown[])[v + 1];
    }
    return new Event(key, data) as unknown as EventForSchema<S>;
  }

  #materializeAt(chunkIdx: number, localIdx: number): EventForSchema<S> {
    const store = this.#chunks[chunkIdx]!;
    const begin = store.beginAt(localIdx);
    const key =
      this.#keyKind === 'time'
        ? new Time(begin)
        : new TimeRange({ start: begin, end: store.endAt(localIdx) });
    const data: Record<string, unknown> = {};
    for (let v = 0; v < this.#valueNames.length; v += 1) {
      const name = this.#valueNames[v]!;
      data[name] = store.valueAt(localIdx, name);
    }
    return new Event(key, data) as unknown as EventForSchema<S>;
  }
}
