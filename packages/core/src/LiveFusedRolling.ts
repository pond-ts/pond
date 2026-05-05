import {
  normalizeAggregateColumns,
  type AggregateColumnSpec,
} from './aggregate-columns.js';
import { Event } from './Event.js';
import { Time } from './Time.js';
import { rollingStateFor, type RollingReducerState } from './reducers/index.js';
import {
  bucketIndexFor,
  boundaryTimestampFor,
  type Trigger,
  type ClockTrigger,
} from './triggers.js';
import { parseDuration } from './utils/duration.js';
import type {
  AggregateMap,
  AggregateOutputMap,
  ColumnValue,
  EventForSchema,
  LiveSource,
  SeriesSchema,
} from './types.js';
import type { FusedMapping, FusedMappingValue } from './types-fused-rolling.js';
import type { LiveRollingOptions } from './LiveRollingAggregation.js';

/**
 * Per-window state inside a {@link LiveFusedRolling}. Each window
 * has its own column-spec list, reducer states, and head cursor
 * into the shared deque.
 */
type WindowState = {
  /** The window key as declared by the user (for diagnostics only). */
  readonly id: string;
  /** Resolved window duration in ms. */
  readonly windowMs: number;
  /** Per-column reducer state for this window. */
  readonly states: RollingReducerState[];
  /** Resolved column specs (output-name + reducer + source-column). */
  readonly columns: AggregateColumnSpec[];
  /** Per-window minSamples gate (defaults to top-level options.minSamples). */
  readonly minSamples: number;
  /**
   * Absolute event index of the oldest event still in this window's
   * reducer state. Stable across deque compaction; advances when
   * events age out of this window's `windowMs`.
   */
  head: number;
};

/**
 * One entry in the shared deque. Stored once per source event,
 * regardless of how many windows reference it. Each window's
 * `add`/`remove` pulls only the columns its mapping declares.
 */
type FusedEntry = {
  /** Monotonic event index across the rolling's lifetime. */
  readonly absIdx: number;
  /** `event.begin()` — the event's timestamp. */
  readonly timestamp: number;
  /** Source event data — keyed by column name. */
  readonly data: Record<string, ColumnValue | undefined>;
};

type EventListener = (event: any) => void;

/**
 * Multi-window rolling that maintains N windows in one ingest pass
 * over a single shared deque. Replaces the workaround of multiple
 * separate `LiveRollingAggregation`s sharing the same source — the
 * gRPC experiment's V6→V7 profile-diff (PR #19) showed every per-
 * event pond hop roughly doubled when running two rollings.
 *
 * Each declared window has:
 *  - Its own resolved duration (clipped to retention; see PLAN.md)
 *  - Its own column-spec list and reducer states
 *  - Its own head cursor into the shared deque
 *
 * Output is ONE merged stream: one event per trigger boundary, with
 * all windows' columns concatenated into one record. Duplicate
 * output column names across windows are rejected at construction
 * with a clear error (compile-time detection is queued as a
 * follow-up).
 *
 * **Single trigger.** All windows share the configured trigger.
 * Per-window cadence is explicitly NOT supported — that's what
 * fusion saves. Users who need per-window cadence fall back to two
 * separate `rolling()` calls and pay the V7 cost.
 *
 * **Time-based windows only.** Object keys are duration strings.
 * Count-based windows stay on the existing single-window
 * `LiveRollingAggregation`. This constraint keeps the
 * window-clip-to-retention rule and boundary-detection logic clean.
 *
 * Public API: constructed via the `live.rolling(fusedMapping, opts)`
 * keyed-form overload on `LiveSeries` / `LiveView`. User code
 * doesn't import this class directly.
 */
export class LiveFusedRolling<
  S extends SeriesSchema,
  Out extends SeriesSchema = SeriesSchema,
> implements LiveSource<Out> {
  readonly name: string;
  readonly schema: Out;

  /** Shared deque sized by the longest declared window. */
  readonly #entries: FusedEntry[];
  /** Per-window state, in declared order. */
  readonly #windows: WindowState[];
  /**
   * Longest declared window in ms — bounds the shared deque. Equal
   * to `max(windows[i].windowMs)`.
   */
  readonly #longestWindowMs: number;
  /**
   * Output column specs in declared order — flat union across all
   * windows. Used to assemble emit records and the output schema.
   */
  readonly #emitColumns: AggregateColumnSpec[];

  readonly #trigger: Trigger;
  /**
   * For clock triggers: the bucket index of the most recently
   * crossed boundary. Undefined until the first event is ingested.
   */
  #lastClockBucketIdx: number | undefined;
  /**
   * For count triggers: the number of events ingested since the
   * most recent emission.
   */
  #countSinceLastEmit: number;

  #nextIndex: number;

  readonly #outputEvents: EventForSchema<Out>[];
  readonly #onEvent: Set<EventListener>;
  readonly #unsubscribe: () => void;

  constructor(
    source: LiveSource<S>,
    fusedMapping: FusedMapping<S>,
    options: LiveRollingOptions = {},
  ) {
    this.name = source.name;
    const topMinSamples = options.minSamples ?? 0;
    if (!Number.isInteger(topMinSamples) || topMinSamples < 0) {
      throw new TypeError(
        'rolling minSamples must be a non-negative integer (default 0)',
      );
    }
    this.#trigger = options.trigger ?? { kind: 'event' };
    this.#lastClockBucketIdx = undefined;
    this.#countSinceLastEmit = 0;
    this.#nextIndex = 0;
    this.#entries = [];
    this.#outputEvents = [];
    this.#onEvent = new Set();

    // Resolve each window: parse the duration key, normalize the
    // mapping (handles bare AggregateMap, AggregateOutputMap, and the
    // elaborated `{ mapping, minSamples }` wrapper), build per-column
    // reducer state.
    const windowKeys = Object.keys(fusedMapping);
    if (windowKeys.length === 0) {
      throw new TypeError(
        'fused rolling: at least one window must be declared',
      );
    }

    const windows: WindowState[] = [];
    let longestMs = 0;
    for (const key of windowKeys) {
      const value = fusedMapping[key]!;
      const { innerMapping, perWindowMinSamples } =
        unwrapFusedMappingValue(value);

      const windowMs = resolveWindowKey(key);
      if (windowMs > longestMs) longestMs = windowMs;

      // Reuse the same column-normalisation helper used by the
      // single-window rolling — keeps reducer-state behavior
      // identical to today's-shape `LiveRollingAggregation`.
      const columns = normalizeAggregateColumns(
        source.schema,
        innerMapping as
          | AggregateMap<SeriesSchema>
          | AggregateOutputMap<SeriesSchema>,
      );
      const states = columns.map((c) => rollingStateFor(c.reducer));

      windows.push({
        id: key,
        windowMs,
        columns,
        states,
        minSamples: perWindowMinSamples ?? topMinSamples,
        head: 0,
      });
    }
    this.#windows = windows;
    this.#longestWindowMs = longestMs;

    // Build the merged output schema. Reject duplicate output column
    // names across windows. (Compile-time detection is a follow-up;
    // runtime check keeps shipping unblocked.)
    const seenOutputs = new Set<string>();
    const emitColumns: AggregateColumnSpec[] = [];
    for (const win of this.#windows) {
      for (const col of win.columns) {
        if (seenOutputs.has(col.output)) {
          throw new TypeError(
            `fused rolling: duplicate output column '${col.output}' across windows. ` +
              `Each output column name must be unique across the merged schema. ` +
              `Either rename the alias (use AggregateOutputMap with a distinct \`from\` ` +
              `→ alias mapping) or drop one of the duplicating windows.`,
          );
        }
        seenOutputs.add(col.output);
        emitColumns.push(col);
      }
    }
    this.#emitColumns = emitColumns;

    this.schema = Object.freeze([
      source.schema[0],
      ...emitColumns.map((c) => ({
        name: c.output,
        kind: c.kind,
        required: false,
      })),
    ]) as unknown as Out;

    // Replay the source's existing events through the same ingest
    // path, so a fused rolling created on a non-empty source matches
    // the streaming-from-construction shape.
    for (let i = 0; i < source.length; i++) {
      this.#ingest(source.at(i)!);
    }

    this.#unsubscribe = source.on('event', (event) => {
      this.#ingest(event);
    });
  }

  // ── LiveSource<Out> contract ────────────────────────────────

  get length(): number {
    return this.#outputEvents.length;
  }

  at(index: number): EventForSchema<Out> | undefined {
    if (index < 0) index = this.#outputEvents.length + index;
    return this.#outputEvents[index];
  }

  /**
   * Read the current merged snapshot — every window's reducer
   * outputs concatenated into one record. Useful for live-display
   * patterns where the consumer wants the latest values without
   * waiting for the next trigger fire.
   */
  value(): Record<string, ColumnValue | undefined> {
    const result: Record<string, ColumnValue | undefined> = {};
    for (const win of this.#windows) {
      const warmup = this.#windowSize(win) < win.minSamples;
      for (let i = 0; i < win.columns.length; i++) {
        result[win.columns[i]!.output] = warmup
          ? undefined
          : win.states[i]!.snapshot();
      }
    }
    return result;
  }

  on(type: 'event', fn: EventListener): () => void {
    if (type !== 'event') {
      throw new TypeError(
        `LiveFusedRolling.on: unsupported event type '${String(type)}'`,
      );
    }
    this.#onEvent.add(fn);
    return () => {
      this.#onEvent.delete(fn);
    };
  }

  dispose(): void {
    this.#unsubscribe();
  }

  // ── Private ─────────────────────────────────────────────────

  /**
   * Number of events currently in window `w`'s reducer state.
   * Equals `entries.length - (w.head - frontAbsIdx)` where
   * `frontAbsIdx = entries[0].absIdx`. Used for minSamples gating.
   */
  #windowSize(w: WindowState): number {
    if (this.#entries.length === 0) return 0;
    const frontAbsIdx = this.#entries[0]!.absIdx;
    return this.#entries.length - (w.head - frontAbsIdx);
  }

  #ingest(event: EventForSchema<S>): void {
    const data = event.data() as Record<string, ColumnValue | undefined>;
    const absIdx = this.#nextIndex++;
    const ts = event.begin();
    const entry: FusedEntry = { absIdx, timestamp: ts, data };
    this.#entries.push(entry);

    // Per-window: advance head while leading entries are out-of-window,
    // then add the new event to every column's reducer state.
    for (const win of this.#windows) {
      const cutoff = ts - win.windowMs;
      while (
        win.head < absIdx &&
        this.#getEntry(win.head)!.timestamp < cutoff
      ) {
        const old = this.#getEntry(win.head)!;
        for (let i = 0; i < win.columns.length; i++) {
          win.states[i]!.remove(old.absIdx, old.data[win.columns[i]!.source]);
        }
        win.head++;
      }
      for (let i = 0; i < win.columns.length; i++) {
        win.states[i]!.add(absIdx, data[win.columns[i]!.source]);
      }
    }

    // Compact the shared deque: drop entries before the leftmost
    // window head. The longest window's head IS this leftmost head
    // in steady state.
    this.#compactFront();

    // Emission gated by the configured trigger.
    switch (this.#trigger.kind) {
      case 'event':
        this.#emitEvent(event.key());
        return;
      case 'clock':
        this.#emitClock(ts, this.#trigger);
        return;
      case 'count':
        this.#emitCount(event.key(), this.#trigger.n);
        return;
    }
  }

  /**
   * Translate an absolute event index to its current position in
   * the shared deque. Returns `undefined` if the entry has been
   * compacted out of the front.
   */
  #getEntry(absIdx: number): FusedEntry | undefined {
    if (this.#entries.length === 0) return undefined;
    const front = this.#entries[0]!.absIdx;
    const offset = absIdx - front;
    if (offset < 0 || offset >= this.#entries.length) return undefined;
    return this.#entries[offset];
  }

  /**
   * Drop entries from the front of the shared deque whose absIdx
   * is less than every window's head. The longest window's head
   * defines the leftmost-still-live cursor.
   *
   * Uses `Array.shift()` for now (matches today's
   * `LiveRollingAggregation`); the head-index-pointer ring-buffer
   * optimization is queued as a separate tactical fix in PLAN.md.
   */
  #compactFront(): void {
    if (this.#entries.length === 0) return;
    let minHead = this.#windows[0]!.head;
    for (let i = 1; i < this.#windows.length; i++) {
      const h = this.#windows[i]!.head;
      if (h < minHead) minHead = h;
    }
    while (this.#entries.length > 0 && this.#entries[0]!.absIdx < minHead) {
      this.#entries.shift();
    }
  }

  #emitCount(key: any, n: number): void {
    this.#countSinceLastEmit++;
    if (this.#countSinceLastEmit < n) return;
    this.#countSinceLastEmit = 0;
    this.#emitEvent(key);
  }

  /**
   * Build one merged event with every window's reducer snapshot
   * concatenated into one record, then push to outputs and notify
   * listeners.
   */
  #emitEvent(key: any): void {
    const record: Record<string, ColumnValue | undefined> = {};
    for (const win of this.#windows) {
      const warmup = this.#windowSize(win) < win.minSamples;
      for (let i = 0; i < win.columns.length; i++) {
        record[win.columns[i]!.output] = warmup
          ? undefined
          : win.states[i]!.snapshot();
      }
    }
    const outputEvent = new Event(
      key,
      record,
    ) as unknown as EventForSchema<Out>;
    this.#outputEvents.push(outputEvent);
    for (const fn of this.#onEvent) fn(outputEvent);
  }

  #emitClock(eventTs: number, trigger: ClockTrigger): void {
    const bucketIdx = bucketIndexFor(trigger, eventTs);
    if (this.#lastClockBucketIdx === undefined) {
      this.#lastClockBucketIdx = bucketIdx;
      return;
    }
    if (bucketIdx > this.#lastClockBucketIdx) {
      const boundaryMs = boundaryTimestampFor(trigger, bucketIdx);
      this.#emitEvent(new Time(boundaryMs));
      this.#lastClockBucketIdx = bucketIdx;
    }
  }
}

// ── Helpers (module-private) ──────────────────────────────────

/**
 * Resolve a fused-mapping window key (duration string or `'buffer'`
 * sentinel) to a duration in ms. The `'buffer'` sentinel is reserved
 * for future use by `live.reduce()` and not yet implemented; throws
 * a clear error for now.
 */
function resolveWindowKey(key: string): number {
  if (key === 'buffer') {
    throw new TypeError(
      `fused rolling: 'buffer' sentinel key is reserved for live.reduce(); ` +
        `not yet implemented. Use an explicit duration string ` +
        `(e.g. '1m', '200ms') for now.`,
    );
  }
  // parseDuration's input type is `number | DurationString` — at runtime it
  // throws on bad input. Cast to satisfy the type and let parseDuration
  // surface a clear error if the key isn't a valid duration string. Wrap
  // the throw to point at the fused-rolling context.
  try {
    return parseDuration(key as `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`);
  } catch {
    throw new TypeError(
      `fused rolling: invalid window key '${key}'. Keys must be duration ` +
        `strings (e.g. '1m', '200ms', '5s'). Count-based windows stay on ` +
        `the existing single-window overload.`,
    );
  }
}

/**
 * Peel off the elaborated wrapper if present, returning the inner
 * mapping and the per-window minSamples (if specified).
 */
/**
 * True when `v` looks like an `AggregateOutputSpec` — i.e., a bare
 * `{ from: string, using: ... }` shape. Used to disambiguate the
 * elaborated-wrapper detection: a user with an `AggregateOutputMap`
 * entry literally named `'mapping'` (e.g. `{ '1m': { mapping: { from:
 * 'cpu', using: 'avg' } } }`) must NOT be unwrapped as the wrapper.
 *
 * The wrapper's `mapping` field carries a whole record of column
 * specs; the colliding-name AggregateOutputMap entry's `mapping` key
 * carries one spec. This check distinguishes the two by looking for
 * the `from` + `using` discriminators that only exist on a spec.
 */
function isAggregateOutputSpec(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof (v as { from?: unknown }).from === 'string' &&
    'using' in (v as object)
  );
}

function unwrapFusedMappingValue<S extends SeriesSchema>(
  value: FusedMappingValue<S>,
): {
  innerMapping: AggregateMap<S> | AggregateOutputMap<S>;
  perWindowMinSamples: number | undefined;
} {
  if (
    value !== null &&
    typeof value === 'object' &&
    'mapping' in value &&
    typeof (value as { mapping?: unknown }).mapping === 'object' &&
    // Disambiguation: if `.mapping` is itself an AggregateOutputSpec,
    // the user named an alias `mapping` in an AggregateOutputMap —
    // this is NOT the elaborated wrapper. Fall through to the bare
    // mapping branch.
    !isAggregateOutputSpec((value as { mapping?: unknown }).mapping)
  ) {
    const elaborated = value as {
      mapping: AggregateMap<S> | AggregateOutputMap<S>;
      minSamples?: number;
    };
    if (elaborated.minSamples !== undefined) {
      if (
        !Number.isInteger(elaborated.minSamples) ||
        elaborated.minSamples < 0
      ) {
        throw new TypeError(
          'fused rolling: per-window minSamples must be a non-negative integer',
        );
      }
    }
    return {
      innerMapping: elaborated.mapping,
      perWindowMinSamples: elaborated.minSamples,
    };
  }
  return {
    innerMapping: value as AggregateMap<S> | AggregateOutputMap<S>,
    perWindowMinSamples: undefined,
  };
}
