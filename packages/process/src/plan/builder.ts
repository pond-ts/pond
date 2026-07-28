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
import type { SlotDef, Slots } from './slots.js';
import type { ParamValue } from './types.js';

/** Thrown when a graph is built wrong — before it is ever sent. */
export class BuilderError extends ProcessError {}

/** What a node's inputs may be: a source column name, or another node. */
export type InputRef = string | NodeHandle;

/**
 * A reference to a node in the graph under construction.
 *
 * The reduction methods return selectors rather than registering them,
 * so a caller decides what to surface and under what name — `expose` is
 * the only thing that adds to the request.
 */
export interface NodeHandle {
  readonly slot: string;
  /** Ask for this node's columns, for drawing. */
  columns(): Select;
  /** Latest defined value, with when. */
  last(options?: { output?: string }): Select;
  /** Minimum and maximum, each with when. */
  extremes(options?: { output?: string }): Select;
  /** Where the latest value sits in its own history. */
  percentileRank(options?: { output?: string }): Select;
  /** A bounded sample of the whole series. */
  shape(options?: { output?: string; points?: number }): Select;
}

/** The envelope a builder produces — what `Host.run` takes. */
export interface BuiltRequest {
  readonly from: string;
  readonly as?: string;
  readonly nodes: Slots;
  readonly outputs: Readonly<Record<string, Select>>;
}

function handleFor(slot: string): NodeHandle {
  const reduce =
    (name: 'last' | 'extremes' | 'percentileRank' | 'shape') =>
    (options: { output?: string; points?: number } = {}): Select => ({
      on: slot,
      reduce: name,
      ...(options.output !== undefined && { output: options.output }),
      ...(options.points !== undefined && { points: options.points }),
    });
  return {
    slot,
    columns: () => ({ on: slot, columns: true }),
    last: reduce('last'),
    extremes: reduce('extremes'),
    percentileRank: reduce('percentileRank'),
    shape: reduce('shape'),
  };
}

export class PlanBuilder {
  readonly #from: string;
  #as: string | undefined;
  readonly #nodes = new Map<string, SlotDef>();
  readonly #outputs = new Map<string, Select>();

  constructor(from: string) {
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
      in: inputs.map((i) => (typeof i === 'string' ? i : i.slot)),
    });
    return handleFor(slot);
  }

  /**
   * Surfaces a selector under the caller's own name.
   *
   * @throws {BuilderError} if the name is already used.
   */
  expose(name: string, selector: Select): this {
    if (this.#outputs.has(name)) {
      throw new BuilderError(`output '${name}' is already exposed`);
    }
    this.#outputs.set(name, selector);
    return this;
  }

  /** The envelope. Plain JSON — nothing here survives into the request. */
  toJSON(): BuiltRequest {
    return {
      from: this.#from,
      ...(this.#as !== undefined && { as: this.#as }),
      nodes: Object.fromEntries(this.#nodes),
      outputs: Object.fromEntries(this.#outputs),
    };
  }
}

export function plan(from: string): PlanBuilder {
  return new PlanBuilder(from);
}
