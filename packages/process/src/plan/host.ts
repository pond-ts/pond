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
export interface Envelope {
  readonly from: string;
  readonly process: Plan;
  readonly as?: string;
  readonly select?: readonly Select[];
  readonly onError?: ErrorPolicy;
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
  readonly #graphs = new Map<string, BoundGraph>();
  readonly #sources = new Map<string, TimeSeries<SeriesSchema>>();

  constructor(options: { registry: Registry; units?: Units }) {
    this.registry = options.registry;
    this.#units = options.units ?? {};
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
    const graph = bind(series, { registry: this.registry, units: this.#units });
    this.#graphs.set(id, graph);
    return graph;
  }

  /** Resolves an envelope against its dataset's long-lived graph. */
  run(envelope: Envelope): RunResult {
    const graph = this.graphFor(envelope.from);
    return run(graph, {
      plan: envelope.process,
      ...(envelope.select !== undefined && { select: envelope.select }),
      ...(envelope.onError !== undefined && { onError: envelope.onError }),
    });
  }
}

export function createHost(options: {
  registry: Registry;
  units?: Units;
}): Host {
  return new Host(options);
}

/** A response with the in-process series dropped — what crosses a wire. */
export interface WireResult extends Omit<RunResult, 'series'> {
  readonly as?: string;
  /** Columns the caller asked to draw, when it asked. */
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
  const { series, ...rest } = result;
  return {
    ...rest,
    ...(as !== undefined && { as }),
    hasSeries: series !== undefined,
  };
}
