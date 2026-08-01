/**
 * The long-lived host — [PND-DEMOM1].
 *
 * A `Host` owns `Map<datasetId, BoundGraph>` and **outlives requests**.
 * That is the whole architectural claim: a graph built per request starts
 * cold, and a cold graph is a fold with extra steps. Every caching figure
 * behind this design assumes a warm binding.
 *
 * Where the host runs is a separate question — a long-lived worker proves
 * client-side execution with an unblocked main thread; a server process
 * proves one cache shared across sessions. Both satisfy the invariant;
 * neither is expressed here, because this is the part they share.
 */

import { ProcessError } from '../errors.js';
import type { SeriesSchema, TimeSeries } from 'pond-ts';
import { bind, BoundGraph } from './graph.js';
import type { Registry } from './registry.js';
import { run, type RunResult, type Select, type ErrorPolicy } from './run.js';
import type { Slots } from './slots.js';
import {
  sourceId,
  type LoadedSource,
  type SourceRef,
  type SourceRegistry,
} from './source.js';
import type { Plan, Units } from './types.js';

/** Thrown when a request names a dataset the host has not been given. */
export class UnknownDatasetError extends ProcessError {}

/**
 * A request as it arrives over a wire.
 *
 * `from` is the binding key, and the multi-source hook — widening it to
 * an array later ([PND-PROCJOIN]) should be an addition rather than a
 * break. `as` **names** the output so a later request can refer to it; it
 * deliberately does not window one, or the request would have two places
 * that slice time and they would eventually disagree.
 */
interface EnvelopeBase<From extends string | SourceRef> {
  readonly from: From;
  readonly as?: string;
  readonly onError?: ErrorPolicy;
  /** See {@link RunOptions.assemble}. A wire consumer wants `false`. */
  readonly assemble?: boolean;
}

/** The original form: a plan of nested specs, selected inline. */
export interface PlanEnvelope extends EnvelopeBase<string> {
  readonly process: Plan;
  readonly select?: readonly Select[];
}

/**
 * The slot form — [PND-PROCSLOT].
 *
 * `nodes` is keyed by names the caller owns and `outputs` by names it
 * will read back, so both survive a param edit that moves every derived
 * id. What a `PlanBuilder` emits.
 */
export interface SlotEnvelope extends EnvelopeBase<string> {
  readonly nodes: Slots;
  readonly outputs?: Readonly<Record<string, Select>>;
}

export type Envelope = PlanEnvelope | SlotEnvelope;

/** Nested-plan request whose source must be resolved asynchronously. */
export interface AsyncPlanEnvelope extends EnvelopeBase<SourceRef> {
  readonly process: Plan;
  readonly select?: readonly Select[];
}

/** Slot request whose source must be resolved asynchronously. */
export interface AsyncSlotEnvelope extends EnvelopeBase<SourceRef> {
  readonly nodes: Slots;
  readonly outputs?: Readonly<Record<string, Select>>;
}

/** What `Host.runAsync` accepts: local requests too, for composable callers. */
export type AsyncEnvelope = Envelope | AsyncPlanEnvelope | AsyncSlotEnvelope;

function isLocalEnvelope(envelope: AsyncEnvelope): envelope is Envelope {
  return typeof envelope.from === 'string';
}

export interface DatasetInfo {
  readonly id: string;
  readonly rows: number;
  readonly columns: readonly string[];
  /** Nodes compiled against this binding so far. */
  readonly nodes: number;
}

export class Host {
  readonly registry: Registry;
  readonly #units: Units;
  readonly #budgetBytes: number | undefined;
  readonly #graphs = new Map<string, BoundGraph>();
  readonly #sources = new Map<string, TimeSeries<SeriesSchema>>();
  readonly #sourceRegistry: SourceRegistry | undefined;
  readonly #loadedSources = new Map<string, LoadedSource>();
  readonly #loadingSources = new Map<string, Promise<void>>();

  constructor(options: {
    registry: Registry;
    units?: Units;
    sources?: SourceRegistry;
    /**
     * Cap on retained node values **per bound graph**, in bytes — see
     * {@link bind}. Without one, a host accepting runtime plans retains
     * every distinct spec ever asked of every dataset, so memory scales
     * with questions asked rather than with anything bounded. A host
     * whose plans arrive from callers it does not control should set
     * this; the total across the host is `budgetBytes × datasets`, since
     * datasets are added by the host's own author, not by requests.
     */
    budgetBytes?: number;
  }) {
    this.registry = options.registry;
    this.#units = options.units ?? {};
    this.#budgetBytes = options.budgetBytes;
    this.#sourceRegistry = options.sources;
  }

  /**
   * Registers a dataset. The graph is built lazily on first use, so
   * seeding many datasets is cheap.
   */
  add(id: string, series: TimeSeries<SeriesSchema>): this {
    this.#sources.set(id, series);
    const existing = this.#graphs.get(id);
    // Rebinding an existing dataset updates it in place rather than
    // discarding the graph — the nodes stay, and dirty marking handles
    // the rest. Dropping the graph would throw away the cache on every
    // data refresh, which is exactly what this class exists to avoid.
    if (existing) existing.setSource(series);
    return this;
  }

  has(id: string): boolean {
    return this.#sources.has(id);
  }

  get datasets(): DatasetInfo[] {
    return [...this.#sources.entries()].map(([id, series]) => ({
      id,
      rows: series.length,
      columns: series.schema.slice(1).map((c) => c.name),
      nodes: this.#graphs.get(id)?.ids.length ?? 0,
    }));
  }

  /** The bound graph for a dataset, built on first use and kept. */
  graphFor(id: string): BoundGraph {
    const existing = this.#graphs.get(id);
    if (existing) return existing;
    const series = this.#sources.get(id);
    if (series === undefined) {
      const have = [...this.#sources.keys()].map((k) => `'${k}'`).join(', ');
      throw new UnknownDatasetError(
        `unknown dataset '${id}'${have ? ` — have ${have}` : ''}`,
      );
    }
    const graph = bind(series, {
      registry: this.registry,
      units: this.#units,
      ...(this.#budgetBytes !== undefined && {
        budgetBytes: this.#budgetBytes,
      }),
    });
    this.#graphs.set(id, graph);
    return graph;
  }

  /**
   * Forgets a dataset: its source, its graph, and every cached node
   * value with them. The explicit end of a binding's lifecycle — the
   * counterpart to {@link add} for a host that cycles datasets, where
   * "kept until the process dies" is not a policy.
   *
   * Returns whether the dataset was known. An in-flight `runAsync`
   * against the same source id may re-register it when its load lands.
   */
  remove(id: string): boolean {
    const known = this.#sources.delete(id);
    this.#graphs.delete(id);
    this.#loadedSources.delete(id);
    return known;
  }

  /** Resolves an envelope against its dataset's long-lived graph. */
  run(envelope: Envelope): RunResult {
    const graph = this.graphFor(envelope.from);
    const options = {
      ...(envelope.onError !== undefined && { onError: envelope.onError }),
      ...(envelope.assemble !== undefined && { assemble: envelope.assemble }),
    };
    return 'nodes' in envelope
      ? run(graph, {
          nodes: envelope.nodes,
          ...(envelope.outputs !== undefined && { outputs: envelope.outputs }),
          ...options,
        })
      : run(graph, {
          plan: envelope.process,
          ...(envelope.select !== undefined && { select: envelope.select }),
          ...options,
        });
  }

  /**
   * Resolves either a preloaded dataset or an opaque asynchronous source.
   *
   * Equal revisions preserve the graph untouched. A changed revision updates
   * its source in place, retaining compiled nodes while normal invalidation
   * propagates from the new value.
   */
  async runAsync(envelope: AsyncEnvelope): Promise<RunResult> {
    if (isLocalEnvelope(envelope)) return this.run(envelope);
    if (this.#sourceRegistry === undefined) {
      throw new ProcessError(
        `source '${envelope.from.source}' cannot load — this host has no source registry`,
      );
    }

    const id = sourceId(envelope.from);
    let loading = this.#loadingSources.get(id);
    if (loading === undefined) {
      loading = this.#refreshSource(id, envelope.from);
      this.#loadingSources.set(id, loading);
    }
    try {
      await loading;
    } finally {
      if (this.#loadingSources.get(id) === loading) {
        this.#loadingSources.delete(id);
      }
    }
    return this.run({ ...envelope, from: id });
  }

  /**
   * Loads and applies one source revision as a single in-flight operation.
   *
   * `runAsync` shares this promise per canonical source identity. Keeping the
   * state update inside it means concurrent callers cannot each invalidate the
   * graph or race to install an older revision.
   */
  async #refreshSource(id: string, ref: SourceRef): Promise<void> {
    const previous = this.#loadedSources.get(id);
    const loaded = await this.#sourceRegistry!.load(ref, previous);
    if (previous === undefined || previous.revision !== loaded.revision) {
      this.#loadedSources.set(id, loaded);
      this.add(id, loaded.value);
    }
  }
}

export function createHost(options: {
  registry: Registry;
  units?: Units;
  sources?: SourceRegistry;
  /** Per-graph cap on retained node values, in bytes — see {@link Host}. */
  budgetBytes?: number;
}): Host {
  return new Host(options);
}

/** A response with the in-process values dropped — what crosses a wire. */
export interface WireResult extends Omit<RunResult, 'series' | 'columns'> {
  readonly as?: string;
  /** Whether a `columns` selector asked for drawable values. */
  readonly hasSeries: boolean;
}

/**
 * Projects a result for transport.
 *
 * The renderer path hands back a live `TimeSeries` on purpose — a chart
 * draws every point, and serializing 10⁶ of them per frame is the failure
 * this split exists to avoid. `toWire` is for the other caller, and the
 * useful property is that it is **only lossy when columns were asked
 * for**: a facts-only response is already JSON-safe, so this is a no-op
 * on exactly the requests that cross a wire.
 */
export function toWire(result: RunResult, as?: string): WireResult {
  const { series, columns, ...rest } = result;
  return {
    ...rest,
    ...(as !== undefined && { as }),
    hasSeries: series !== undefined || columns !== undefined,
  };
}
