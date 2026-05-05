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

/**
 * Per-window state inside a partitioned fused rolling. Mirrors the
 * non-partitioned `LiveFusedRolling`'s `WindowState`, but each
 * partition has its own copy.
 */
type WindowState = {
  readonly id: string;
  readonly windowMs: number;
  readonly states: RollingReducerState[];
  /** Reducer column-spec metadata, shared across partitions. */
  readonly columns: AggregateColumnSpec[];
  readonly minSamples: number;
  /** Absolute event index of oldest event still in this window's state. */
  head: number;
};

/**
 * Per-partition state. Each partition has its own shared deque and
 * its own array of per-window states (one entry per declared
 * window).
 */
type PartitionState = {
  /** Shared deque for this partition (sized by longest window). */
  entries: FusedEntry[];
  /** Per-window state in declared order. */
  windows: WindowState[];
  /** Monotonic event index across this partition's lifetime. */
  nextIndex: number;
};

type FusedEntry = {
  readonly absIdx: number;
  readonly timestamp: number;
  readonly data: Record<string, ColumnValue | undefined>;
};

type EventListener = (event: any) => void;

/**
 * Per-partition column-spec template. Captured once at construction
 * from each window's normalized mapping; used by `#ensurePartition`
 * to spin up per-partition reducer state without re-parsing the
 * mapping each time.
 */
type WindowSpec = {
  readonly id: string;
  readonly windowMs: number;
  readonly columns: AggregateColumnSpec[];
  readonly minSamples: number;
};

/**
 * Synchronised partitioned fused multi-window rolling. Maintains N
 * windows per partition in one ingest pass over a single shared
 * deque per partition. Driven by a clock trigger; emits a
 * synchronised burst of one merged event per partition per boundary
 * crossing.
 *
 * **Why fused matters here.** The gRPC experiment's V6→V7 profile-
 * diff (PR #19) showed that running two separate
 * `LivePartitionedSyncRolling` instances doubled every per-event
 * pond hop in inclusive time (`#routeEvent` 15→29%, `ingest`
 * 12→25%). A single fused rolling does the per-event work once.
 *
 * Output schema is `[time, <byColumn>, ...mergedColumns]` — same
 * partition-column auto-injection as the existing single-window
 * partitioned sync rolling. Duplicate output column names across
 * windows are rejected at construction.
 *
 * **Single trigger, clock only.** Per-window cadence is not
 * supported; cross-partition boundary detection requires a single
 * trigger anyway. Event/count triggers don't make sense for synced
 * cross-partition emission and are not accepted.
 *
 * Public API: constructed via the `partitionBy('host').rolling(
 * fusedMapping, { trigger })` keyed-form overload on
 * `LivePartitionedSeries`. User code doesn't import this class
 * directly.
 */
export class LivePartitionedFusedRolling<
  S extends SeriesSchema,
  K extends string,
  Out extends SeriesSchema,
> implements LiveSource<Out> {
  readonly name: string;
  readonly schema: Out;

  readonly #byColumn: string;
  readonly #trigger: ClockTrigger;
  readonly #windowSpecs: WindowSpec[];
  /** Output column specs in merged-emit order; flat union across windows. */
  readonly #emitColumns: AggregateColumnSpec[];

  readonly #partitions: Map<K, PartitionState>;
  readonly #partitionOrder: K[];
  #lastBucketIdx: number | undefined;

  readonly #outputEvents: EventForSchema<Out>[];
  readonly #onEvent: Set<EventListener>;
  readonly #unsubscribes: Set<() => void>;
  #disposed: boolean;

  /**
   * @internal — constructed by `LivePartitionedSeries.rolling`'s
   * keyed-form clock-trigger overload.
   */
  constructor(
    upstreamName: string,
    byColumn: string,
    byColumnKind: string,
    reducerInputSchema: SeriesSchema,
    fusedMapping: FusedMapping<SeriesSchema>,
    trigger: ClockTrigger,
    options: { minSamples?: number; declaredGroups?: ReadonlyArray<K> } = {},
  ) {
    this.name = upstreamName;
    this.#byColumn = byColumn;
    this.#trigger = trigger;

    const topMinSamples = options.minSamples ?? 0;
    if (!Number.isInteger(topMinSamples) || topMinSamples < 0) {
      throw new TypeError(
        'rolling minSamples must be a non-negative integer (default 0)',
      );
    }

    const windowKeys = Object.keys(fusedMapping);
    if (windowKeys.length === 0) {
      throw new TypeError(
        'fused rolling: at least one window must be declared',
      );
    }

    // Build window specs once — reused by #ensurePartition for each
    // new partition's state. The reducer state is per-partition; the
    // column-spec metadata (output names, kinds) is shared.
    const specs: WindowSpec[] = [];
    for (const key of windowKeys) {
      const value = fusedMapping[key]!;
      const { innerMapping, perWindowMinSamples } =
        unwrapFusedMappingValue(value);
      const windowMs = resolveWindowKey(key);
      const columns = normalizeAggregateColumns(
        reducerInputSchema,
        innerMapping as
          | AggregateMap<SeriesSchema>
          | AggregateOutputMap<SeriesSchema>,
      );
      specs.push({
        id: key,
        windowMs,
        columns,
        minSamples: perWindowMinSamples ?? topMinSamples,
      });
    }
    this.#windowSpecs = specs;

    // Build merged emit-column list and detect duplicate output names
    // across windows. Same rule as non-partitioned LiveFusedRolling.
    const seenOutputs = new Set<string>();
    const emitColumns: AggregateColumnSpec[] = [];
    for (const spec of specs) {
      for (const col of spec.columns) {
        if (col.output === byColumn) {
          throw new TypeError(
            `LivePartitionedFusedRolling: partition column '${byColumn}' collides ` +
              `with a reducer-output column of the same name in window '${spec.id}'. ` +
              `Rename the alias (e.g. \`{ ${byColumn}_avg: { from: '${byColumn}', using: 'avg' } }\`) ` +
              `or partition by a different column.`,
          );
        }
        if (col.output === 'time') {
          throw new TypeError(
            `LivePartitionedFusedRolling: output column '${col.output}' in window ` +
              `'${spec.id}' collides with the reserved 'time' first column.`,
          );
        }
        if (seenOutputs.has(col.output)) {
          throw new TypeError(
            `fused rolling: duplicate output column '${col.output}' across windows. ` +
              `Each output column name must be unique across the merged schema.`,
          );
        }
        seenOutputs.add(col.output);
        emitColumns.push(col);
      }
    }
    this.#emitColumns = emitColumns;

    this.schema = Object.freeze([
      { name: 'time', kind: 'time' },
      { name: byColumn, kind: byColumnKind, required: false },
      ...emitColumns.map((c) => ({
        name: c.output,
        kind: c.kind,
        required: false,
      })),
    ]) as unknown as Out;

    this.#partitions = new Map();
    this.#partitionOrder = [];
    this.#lastBucketIdx = undefined;
    this.#outputEvents = [];
    this.#onEvent = new Set();
    this.#unsubscribes = new Set();
    this.#disposed = false;

    if (options.declaredGroups) {
      for (const k of options.declaredGroups) {
        this.#ensurePartition(k);
      }
    }
  }

  // ── LiveSource<Out> contract ────────────────────────────────

  get length(): number {
    return this.#outputEvents.length;
  }

  at(index: number): EventForSchema<Out> | undefined {
    if (index < 0) index = this.#outputEvents.length + index;
    return this.#outputEvents[index];
  }

  on(type: 'event', fn: EventListener): () => void {
    if (type !== 'event') {
      throw new TypeError(
        `LivePartitionedFusedRolling.on: unsupported event type '${String(type)}'`,
      );
    }
    this.#onEvent.add(fn);
    return () => {
      this.#onEvent.delete(fn);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const unsub of this.#unsubscribes) unsub();
    this.#unsubscribes.clear();
  }

  /**
   * @internal — used by `LivePartitionedSeries.rolling` to register
   * each per-partition `'event'` listener disposer so this fused
   * rolling can detach them on `dispose()`.
   */
  _registerUnsubscribe(unsub: () => void): void {
    this.#unsubscribes.add(unsub);
  }

  // ── Wiring entry point ──────────────────────────────────────

  /**
   * Called by `LivePartitionedSeries` for each event arriving on a
   * partition's `LiveSource`. Updates that partition's per-window
   * state in one pass, then if the bucket index advances, emits a
   * synchronised burst of one merged event per known partition at
   * the new boundary timestamp.
   */
  ingest(partitionKey: K, event: EventForSchema<S>): void {
    if (this.#disposed) return;
    const state = this.#ensurePartition(partitionKey);
    const data = event.data() as Record<string, ColumnValue | undefined>;
    const absIdx = state.nextIndex++;
    const ts = event.begin();
    const entry: FusedEntry = { absIdx, timestamp: ts, data };
    state.entries.push(entry);

    // Per-window: advance head while leading entries are out of
    // window; add the new event to every column's reducer state.
    this.#advanceAndAddPartition(state, ts, entry);

    // Compact the partition's shared deque to the leftmost head.
    this.#compactPartitionFront(state);

    // Boundary detection: only the partition that received the
    // boundary-crossing event drives emission. Quiet partitions are
    // evicted-and-snapshot-only inside #emitTick.
    const bucketIdx = bucketIndexFor(this.#trigger, ts);
    if (this.#lastBucketIdx === undefined) {
      this.#lastBucketIdx = bucketIdx;
      return;
    }
    if (bucketIdx > this.#lastBucketIdx) {
      this.#emitTick(bucketIdx, ts);
      this.#lastBucketIdx = bucketIdx;
    }
  }

  // ── Internal ────────────────────────────────────────────────

  #ensurePartition(key: K): PartitionState {
    let state = this.#partitions.get(key);
    if (state) return state;

    // Spin up per-window reducer state for this new partition. The
    // column-spec metadata is shared from #windowSpecs.
    const windows: WindowState[] = this.#windowSpecs.map((spec) => ({
      id: spec.id,
      windowMs: spec.windowMs,
      columns: spec.columns,
      states: spec.columns.map((c) => rollingStateFor(c.reducer)),
      minSamples: spec.minSamples,
      head: 0,
    }));
    state = {
      entries: [],
      windows,
      nextIndex: 0,
    };
    this.#partitions.set(key, state);
    this.#partitionOrder.push(key);
    return state;
  }

  /**
   * For one partition: advance every window's head past entries
   * that have aged out, then add `entry` to every window's reducer
   * state. Called on every ingest AND on every emit (for quiet
   * partitions that need eviction-against-now without a fresh
   * event).
   *
   * `entry` may be undefined for the eviction-only case (during
   * `#emitTick` for a quiet partition); pass undefined to skip the
   * add step.
   */
  #advanceAndAddPartition(
    state: PartitionState,
    cutoffTs: number,
    entry: FusedEntry | undefined,
  ): void {
    for (const win of state.windows) {
      const cutoff = cutoffTs - win.windowMs;
      while (win.head < state.nextIndex) {
        const old = this.#getEntry(state, win.head);
        if (!old || old.timestamp >= cutoff) break;
        for (let i = 0; i < win.columns.length; i++) {
          win.states[i]!.remove(old.absIdx, old.data[win.columns[i]!.source]);
        }
        win.head++;
      }
      if (entry) {
        for (let i = 0; i < win.columns.length; i++) {
          win.states[i]!.add(entry.absIdx, entry.data[win.columns[i]!.source]);
        }
      }
    }
  }

  #getEntry(state: PartitionState, absIdx: number): FusedEntry | undefined {
    if (state.entries.length === 0) return undefined;
    const front = state.entries[0]!.absIdx;
    const offset = absIdx - front;
    if (offset < 0 || offset >= state.entries.length) return undefined;
    return state.entries[offset];
  }

  #compactPartitionFront(state: PartitionState): void {
    if (state.entries.length === 0) return;
    let minHead = state.windows[0]!.head;
    for (let i = 1; i < state.windows.length; i++) {
      const h = state.windows[i]!.head;
      if (h < minHead) minHead = h;
    }
    while (state.entries.length > 0 && state.entries[0]!.absIdx < minHead) {
      state.entries.shift();
    }
  }

  /**
   * Walk every known partition (in observation / declared-groups
   * order), evict each partition's per-window state against the
   * triggering event's `latestTs`, then emit one merged event per
   * partition keyed at the new bucket's boundary timestamp.
   *
   * **Why eviction here?** The partition that received the
   * boundary-crossing event was already evicted in `ingest()`, but
   * other (quiet) partitions haven't been touched since their last
   * event. A 30s window can still emit a 90s-old value from a
   * partition that went silent, without this pass.
   */
  #emitTick(bucketIdx: number, latestTs: number): void {
    const boundaryMs = boundaryTimestampFor(this.#trigger, bucketIdx);
    const time = new Time(boundaryMs);
    const order = this.#partitionOrder;
    const partitions = this.#partitions;
    const byCol = this.#byColumn;
    const out = this.#outputEvents;
    const listeners = this.#onEvent;
    const orderLen = order.length;

    for (let p = 0; p < orderLen; p++) {
      const key = order[p]!;
      const state = partitions.get(key)!;
      // Evict-only against latestTs (no new entry to add).
      this.#advanceAndAddPartition(state, latestTs, undefined);
      this.#compactPartitionFront(state);

      const record: Record<string, ColumnValue | undefined> = {};
      record[byCol] = key;
      for (const win of state.windows) {
        const warmup = this.#windowSizeIn(state, win) < win.minSamples;
        for (let i = 0; i < win.columns.length; i++) {
          record[win.columns[i]!.output] = warmup
            ? undefined
            : win.states[i]!.snapshot();
        }
      }
      const evt = new Event(time, record) as unknown as EventForSchema<Out>;
      out.push(evt);
      if (listeners.size > 0) {
        for (const fn of listeners) fn(evt);
      }
    }
  }

  /**
   * Number of events currently in window `w`'s reducer state for
   * partition `state`. Used for the per-window minSamples gate.
   */
  #windowSizeIn(state: PartitionState, w: WindowState): number {
    if (state.entries.length === 0) return 0;
    const frontAbsIdx = state.entries[0]!.absIdx;
    return state.entries.length - (w.head - frontAbsIdx);
  }
}

// ── Helpers (module-private; mirror LiveFusedRolling's) ──────────

function resolveWindowKey(key: string): number {
  if (key === 'buffer') {
    throw new TypeError(
      `fused rolling: 'buffer' sentinel key is reserved for live.reduce(); ` +
        `not yet implemented.`,
    );
  }
  try {
    return parseDuration(key as `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`);
  } catch {
    throw new TypeError(
      `fused rolling: invalid window key '${key}'. Keys must be duration ` +
        `strings (e.g. '1m', '200ms', '5s').`,
    );
  }
}

/**
 * Mirror of {@link LiveFusedRolling}'s helper. Disambiguates the
 * elaborated wrapper from a bare AggregateOutputMap entry named
 * `mapping`. See the non-partitioned class's docstring for the
 * full explanation.
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
