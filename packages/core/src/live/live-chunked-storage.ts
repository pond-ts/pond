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
import type { Column, Float64Column } from '../columnar/column.js';
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
  #total = 0;
  /** Lazy event materialization cache, keyed by logical index. */
  #cache = new Map<number, EventForSchema<S>>();

  constructor(schema: S) {
    this.#schema = schema;
    const keyKind = schema[0].kind;
    if (keyKind !== 'time' && keyKind !== 'timeRange') {
      throw new Error(
        `ChunkedColumnarLiveStorage: unsupported key kind '${keyKind}' (expected 'time' | 'timeRange')`,
      );
    }
    this.#keyKind = keyKind;
    this.#valueNames = schema.slice(1).map((c) => c.name);
  }

  get length(): number {
    return this.#total;
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
    this.#chunks.push(store);
    this.#total += store.length;
  }

  /** Locate logical index `i` as `[chunkIndex, localIndex]`, or null if out of range. */
  #locate(i: number): [number, number] | null {
    if (i < 0 || i >= this.#total) return null;
    let acc = 0;
    for (let c = 0; c < this.#chunks.length; c += 1) {
      const len = this.#chunks[c]!.length;
      if (i < acc + len) return [c, i - acc];
      acc += len;
    }
    return null; // unreachable given the range guard
  }

  at(index: number): EventForSchema<S> | undefined {
    const loc = this.#locate(index);
    if (loc === null) return undefined;
    let event = this.#cache.get(index);
    if (event === undefined) {
      event = this.#materializeAt(loc[0], loc[1]);
      this.#cache.set(index, event);
    }
    return event;
  }

  keyAt(index: number): EventKey | undefined {
    const loc = this.#locate(index);
    if (loc === null) return undefined;
    const cached = this.#cache.get(index);
    if (cached !== undefined) return cached.key();
    return this.#keyAt(loc[0], loc[1]);
  }

  beginAt(index: number): number | undefined {
    const loc = this.#locate(index);
    if (loc === null) return undefined;
    return this.#chunks[loc[0]]!.beginAt(loc[1]);
  }

  last(): EventForSchema<S> | undefined {
    return this.at(this.#total - 1);
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
    const len = this.#total;
    if (len === 0) return [];
    const all: EventForSchema<S>[] = new Array(len);
    for (let i = 0; i < len; i += 1) all[i] = this.at(i)!;
    this.#chunks = [];
    this.#total = 0;
    this.#cache.clear();
    return all;
  }

  snapshot(name: string): TimeSeries<S> {
    // Walk chunks in order, materializing rows. (A columnar fast-path
    // snapshot — concatSorted(chunks) → trusted TimeSeries — is a
    // deferred follow-up; snapshot isn't the hot path. Matches the
    // array backing's row-rebuild for now.)
    const schema = this.#schema;
    const rows: unknown[][] = new Array(this.#total);
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
    return new TimeSeries({ name, schema, rows: rows as RowForSchema<S>[] });
  }

  /**
   * §A increment 2 substrate — zero-copy windowed column read. Returns the
   * values of one numeric column over the row range `[startIdx, endIdx)` as
   * a `Float64Array`, read straight off the chunk buffers: interior chunks
   * are referenced whole, boundary chunks `subarray`'d. **No `Event` is
   * materialized** — this is the read that increment 1's per-tick
   * `Event.get()` gather replaces.
   *
   * When the window lands inside a single chunk the result is a **zero-copy
   * `subarray` view** of that chunk's buffer; spanning chunks, it is a
   * single `Float64Array` concat (one memcpy of contiguous typed arrays).
   *
   * **The view is read-only.** The single-chunk path aliases live storage —
   * mutating the returned array corrupts the buffer. Consumers feed it to a
   * chart; they do not write to it. (The real surface decides whether to
   * copy defensively.)
   *
   * Numeric value columns only (the chart-feed case). Indices clamp to
   * `[0, length]`; an empty resolved range throws (a windowed read with no
   * rows is a caller error in the spike — the real surface will decide the
   * empty-window contract).
   */
  windowColumn(name: string, startIdx: number, endIdx: number): Float64Array {
    const def = this.#schema.find(
      (c) => (c as { name: string }).name === name,
    ) as { name: string; kind: string } | undefined;
    if (def === undefined) {
      throw new Error(`windowColumn: no column '${name}' in schema`);
    }
    if (def.kind !== 'number') {
      throw new Error(
        `windowColumn: column '${name}' has kind '${def.kind}' (numeric value columns only)`,
      );
    }
    const lo = Math.max(0, Math.min(startIdx, this.#total));
    const hi = Math.max(lo, Math.min(endIdx, this.#total));
    if (hi <= lo) {
      throw new RangeError(
        `windowColumn: empty range [${startIdx}, ${endIdx}) over length ${this.#total}`,
      );
    }
    const slices: Float64Array[] = [];
    let acc = 0;
    for (let c = 0; c < this.#chunks.length; c += 1) {
      const chunk = this.#chunks[c]!;
      const cStart = acc;
      const cEnd = acc + chunk.length;
      acc = cEnd;
      if (cEnd <= lo) continue;
      if (cStart >= hi) break;
      const sLo = Math.max(0, lo - cStart);
      const sHi = Math.min(chunk.length, hi - cStart);
      const col = chunk.columns.get(name) as Float64Column;
      slices.push(col._values.subarray(sLo, sHi));
    }
    // Single chunk → zero-copy view; multiple → one concat.
    if (slices.length === 1) return slices[0]!;
    let total = 0;
    for (let i = 0; i < slices.length; i += 1) total += slices[i]!.length;
    const out = new Float64Array(total);
    let cursor = 0;
    for (let i = 0; i < slices.length; i += 1) {
      out.set(slices[i]!, cursor);
      cursor += slices[i]!.length;
    }
    return out;
  }

  /** Drop exactly the oldest `n` rows: whole chunks then a boundary slice. */
  #evictExact(n: number): void {
    let toEvict = n;
    while (toEvict > 0 && this.#chunks.length > 0) {
      const c0 = this.#chunks[0]!;
      if (c0.length <= toEvict) {
        toEvict -= c0.length;
        this.#total -= c0.length;
        this.#chunks.shift();
      } else {
        // Partial: slice the oldest `toEvict` rows off the boundary chunk.
        this.#chunks[0] = sliceStore(c0, toEvict, c0.length);
        this.#total -= toEvict;
        toEvict = 0;
      }
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
