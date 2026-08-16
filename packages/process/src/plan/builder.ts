/**
 * A programmable API that **emits** a plan — [PND-PROCBUILD].
 *
 * Plans-as-data is right for a wire format and required for a cache key,
 * but it is not how an application wants to *author* a graph. A consumer
 * building studies over its own metrics should not be assembling nested
 * JSON by hand.
 *
 * ```ts
 * const g = plan('ACME_5m').as('bands_and_stretch');
 * const bb = g.add('bb', 'bollinger', { period: 20 }, ['px']);
 * const z = g.add('z', 'zscore', { period: 20 }, ['px']);
 *
 * g.expose('upper_band', bb.last({ output: 'Upper' }));
 * g.expose('stretch', z.percentileRank());
 * g.expose('band_series', bb.columns());
 *
 * host.run(g.toJSON());
 * ```
 *
 * **Slots are what make this possible**, which is why this depends on
 * [PND-PROCSLOT] rather than standing alone: a builder needs a stable
 * handle to refer back to, and a content-addressed id cannot be one — it
 * changes the moment a param does. A slot is exactly a handle, and
 * passing `bb` rather than the string `'bb'` is what turns a typo into a
 * compile error.
 *
 * **The builder emits a plan; it does not replace one.** `toJSON()`
 * produces the same envelope a model would compose, so there is one
 * resolution path, one cache, and one thing to test — a graph built in
 * code and one composed by a model land on the same nodes.
 *
 * It deliberately knows nothing about the registry: no op-name checking,
 * no param typing. That keeps it a pure authoring layer with no
 * dependency on the op corpus, and leaves the resolver as the single
 * place a bad plan is diagnosed. Typing params off `ParamDef` is the
 * open question in the ticket, not a gap this file is hiding.
 */

import { ProcessError } from '../errors.js';
import type { Select } from './run.js';
import type { SourceRef } from './source.js';
import type { SlotDef, Slots } from './slots.js';
import type { ParamValue } from './types.js';

/** Thrown when a graph is built wrong — before it is ever sent. */
export class BuilderError extends ProcessError {
  static override readonly code = 'BuilderError';
}

/**
 * The derived slot for a fold over `on` — a function of the node, the
 * fold, **and its params**. Params used to be omitted, so
 * `shape({points: 20})` followed by `shape({points: 100})` landed on one
 * slot and the second call silently kept 20. Sorted by key so two
 * spellings of one param set collide deliberately, the same rule
 * `specId` applies one layer down.
 *
 * One asymmetry is inherent: this builder holds no registry, so it
 * cannot resolve defaults — `shape()` and `shape({points: 40})` derive
 * two slots here even though `specId` resolves them to one computation.
 * That is safe: resolution collapses them to one node, and the response
 * labels it with the first slot that named it. The registry-bound
 * fluent layer canonicalizes params before calling this, so it does not
 * split.
 */
export function foldSlot(
  on: string,
  op: string,
  params?: Readonly<Record<string, ParamValue>>,
): string {
  const entries = Object.entries(params ?? {});
  if (entries.length === 0) return `${on}:${op}`;
  const p = entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(',');
  return `${on}:${op}(${p})`;
}

/** One named output of a multi-output node. */
export interface OutputHandle {
  readonly slot: string;
  readonly output: string;
}

/** What a node's inputs may be: a source column, a node, or one named output. */
export type InputRef = string | NodeHandle | OutputHandle;

/**
 * A reference to a node in the graph under construction.
 *
 * The fold methods **add a node** and hand back a handle to it, rather
 * than producing a selector as they used to. That is the whole shape of
 * [PND-PROCFOLD] at the authoring layer: `z.percentileRank()` always
 * read like an op call, and now it is one.
 *
 * The derived slot is `<slot>:<fold>` — with the fold's params folded in
 * when it has any, e.g. `<slot>:shape(points=100)`. Deterministic in all
 * three, so calling `.last()` twice on the same node returns the same
 * node rather than colliding, while `shape({points: 20})` and
 * `shape({points: 100})` are two nodes rather than the second silently
 * answering with the first's 20. Safe against a source column name,
 * which cannot contain a colon.
 */
export interface NodeHandle {
  readonly slot: string;
  /** Latest defined value, with when. */
  last(): NodeHandle;
  /** Minimum and maximum, each with when. */
  extremes(): NodeHandle;
  /** Where the latest value sits in its own history. */
  percentileRank(): NodeHandle;
  /** A bounded sample of the whole series. */
  shape(options?: { points?: number }): NodeHandle;
}

/** The envelope a builder produces — what `Host.run` takes. */
export interface BuiltRequest<From extends string | SourceRef = string> {
  readonly from: From;
  readonly as?: string;
  readonly nodes: Slots;
  readonly outputs: Readonly<Record<string, Select>>;
}

export class PlanBuilder<From extends string | SourceRef = string> {
  readonly #from: From;
  #as: string | undefined;
  readonly #nodes = new Map<string, SlotDef>();
  readonly #outputs = new Map<string, Select>();

  constructor(from: From) {
    this.#from = from;
  }

  /** Names the result, so a later request can refer back to it. */
  as(name: string): this {
    this.#as = name;
    return this;
  }

  /**
   * Adds a node under a caller-chosen slot name.
   *
   * The name is required rather than derived, because it *is* the stable
   * identity — deriving `sma2` from a counter would renumber the moment
   * a node is inserted above it, which is the property slots exist to
   * provide.
   *
   * @throws {BuilderError} if the slot is already taken.
   */
  add(
    slot: string,
    op: string,
    params: Readonly<Record<string, ParamValue>> | undefined,
    inputs: readonly InputRef[],
  ): NodeHandle {
    if (this.#nodes.has(slot)) {
      throw new BuilderError(
        `slot '${slot}' is already used by a '${this.#nodes.get(slot)!.op}' node`,
      );
    }
    this.#nodes.set(slot, {
      op,
      ...(params !== undefined && { params }),
      in: inputs.map((i) =>
        typeof i === 'string'
          ? i
          : 'output' in i
            ? `${i.slot}#${i.output}`
            : i.slot,
      ),
    });
    return this.#handle(slot);
  }

  /**
   * Adds a fold over `on`, or returns the one already added.
   *
   * Idempotent because the derived slot is a function of the node, the
   * fold and its params: writing `z.percentileRank()` in two places is
   * one node, which is the same thing content-addressing does one layer
   * down — while two different param sets are two nodes.
   */
  #fold(
    on: string,
    op: string,
    params?: Readonly<Record<string, ParamValue>>,
  ): NodeHandle {
    const slot = foldSlot(on, op, params);
    if (!this.#nodes.has(slot)) {
      this.#nodes.set(slot, {
        op,
        ...(params !== undefined && { params }),
        in: [on],
      });
    }
    return this.#handle(slot);
  }

  #handle(slot: string): NodeHandle {
    return {
      slot,
      last: () => this.#fold(slot, 'last'),
      extremes: () => this.#fold(slot, 'extremes'),
      percentileRank: () => this.#fold(slot, 'percentileRank'),
      shape: (options = {}) =>
        this.#fold(
          slot,
          'shape',
          options.points !== undefined ? { points: options.points } : undefined,
        ),
    };
  }

  /**
   * Surfaces a node under the caller's own name.
   *
   * Takes a handle, because a selector's only remaining job is to point
   * at a node — what comes back is whatever that node produces.
   *
   * @throws {BuilderError} if the name is already used.
   */
  expose(name: string, node: NodeHandle, options?: { output?: string }): this {
    if (this.#outputs.has(name)) {
      throw new BuilderError(`output '${name}' is already exposed`);
    }
    this.#outputs.set(name, {
      on: node.slot,
      ...(options?.output !== undefined && { output: options.output }),
    });
    return this;
  }

  /** The envelope. Plain JSON — nothing here survives into the request. */
  toJSON(): BuiltRequest<From> {
    return {
      from: this.#from,
      ...(this.#as !== undefined && { as: this.#as }),
      nodes: Object.fromEntries(this.#nodes),
      outputs: Object.fromEntries(this.#outputs),
    };
  }
}

export function plan<const From extends string | SourceRef>(
  from: From,
): PlanBuilder<From> {
  return new PlanBuilder(from);
}
