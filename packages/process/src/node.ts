/**
 * Nodes: units of computation with typed ports, and the pull-based
 * evaluation that drives them.
 *
 * ## Evaluation model
 *
 * Two mechanisms, doing two different jobs:
 *
 * - **Dirty marking (push)** tells a node "something upstream moved,
 *   revalidate before answering." It propagates from the changed node
 *   through every downstream edge, cutting off at nodes already marked,
 *   so a change costs O(affected nodes) regardless of graph size. A
 *   clean node answers `get()` from cache without walking anything.
 *
 * - **Version stamps (pull)** tell a node whether the change was real.
 *   Each outlet's version increments only when a recomputed value
 *   actually differs, and each node records the input versions it last
 *   computed against. A dirty node whose input versions all match skips
 *   `compute` entirely and stays cached.
 *
 * The second is what makes the layer worth having over plain function
 * calls: setting a source that happens to produce an identical
 * downstream value stops the cascade there, so expensive transforms
 * further down never run. Dirty marking alone (as in a naive dataflow
 * graph) would recompute the whole subtree on every touch.
 */

import { CycleError, MissingOutputError } from './errors.js';
import { Inlet, Outlet, type PortOwner } from './port.js';
import type { PortSpec, PortSpecMap, PortValue, PortValues } from './types.js';

/** The inlet map exposed as `node.in`. */
export type InletsFor<In extends PortSpecMap> = {
  readonly [K in keyof In]: Inlet<PortValue<In[K]>>;
};

/** The outlet map exposed as `node.out`. */
export type OutletsFor<Out extends PortSpecMap> = {
  readonly [K in keyof Out]: Outlet<PortValue<Out[K]>>;
};

/** Declares a reusable node type. Passed to {@link defineNode}. */
export interface NodeSpec<In extends PortSpecMap, Out extends PortSpecMap> {
  /** Stable identifier for this node type, used in errors and `toJSON()`. */
  readonly kind: string;
  readonly inputs: In;
  readonly outputs: Out;
  /**
   * Produces every declared output from the current input values.
   *
   * Called only when an input version actually changed. Must be a pure
   * function of its inputs — the engine caches the result and will not
   * call it again until something upstream moves.
   */
  compute(inputs: PortValues<In>): PortValues<Out>;
}

let nextNodeId = 1;

/**
 * A unit of computation with typed input and output ports.
 *
 * Construct via {@link defineNode} or {@link derive} rather than
 * directly — both wire the port maps up from the spec.
 */
export class Node<
  In extends PortSpecMap = PortSpecMap,
  Out extends PortSpecMap = PortSpecMap,
> implements PortOwner {
  /** Unique within the process. Stable across a graph's lifetime. */
  readonly id: string;
  /** The node type's name, from its spec. */
  readonly kind: string;
  /** Typed input ports, keyed as declared. */
  readonly in: InletsFor<In>;
  /** Typed output ports, keyed as declared. */
  readonly out: OutletsFor<Out>;

  readonly #compute: (inputs: PortValues<In>) => PortValues<Out>;
  readonly #inlets: readonly Inlet<any>[];
  readonly #outlets: readonly Outlet<any>[];

  #dirty = true;
  #computed = false;
  #evaluating = false;
  #inputVersions = new Map<string, number>();
  #error: unknown = undefined;
  #hasError = false;

  constructor(spec: NodeSpec<In, Out>) {
    this.id = `n${nextNodeId++}`;
    this.kind = spec.kind;
    this.#compute = (inputs) => spec.compute(inputs);

    const inlets: Record<string, Inlet<any>> = {};
    for (const [name, portSpec] of Object.entries(spec.inputs) as [
      string,
      PortSpec<any>,
    ][]) {
      inlets[name] = new Inlet(this, name, portSpec.defaultValue);
    }
    const outlets: Record<string, Outlet<any>> = {};
    for (const [name, portSpec] of Object.entries(spec.outputs) as [
      string,
      PortSpec<any>,
    ][]) {
      outlets[name] = new Outlet(this, name, portSpec.equals);
    }

    this.in = Object.freeze(inlets) as InletsFor<In>;
    this.out = Object.freeze(outlets) as OutletsFor<Out>;
    this.#inlets = Object.values(inlets);
    this.#outlets = Object.values(outlets);
  }

  /** Whether this node will revalidate on the next pull. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /**
   * The error thrown by the most recent `compute`, or `undefined` if the
   * last evaluation succeeded (or none has run). Cached alongside the
   * value: an errored node rethrows without re-running `compute` until
   * an input changes, so a broken node stays cheap to poll — useful when
   * rendering a graph where one node is misconfigured.
   */
  get error(): unknown {
    return this.#error;
  }

  /**
   * Forces this node to recompute on the next pull, even if no input
   * version changed, and marks everything downstream dirty.
   *
   * Needed when a node's output depends on something the graph can't
   * see — a settable source value, an external mutable resource.
   */
  invalidate(): void {
    this.#computed = false;
    this.markDirty();
  }

  /** @internal Marks stale and propagates downstream, cutting off at nodes already dirty. */
  markDirty(): void {
    if (this.#dirty) return;
    this.#dirty = true;
    for (const outlet of this.#outlets) outlet.invalidateDownstream();
  }

  /** @internal */
  inletList(): readonly Inlet<any>[] {
    return this.#inlets;
  }

  /** @internal */
  outletList(): readonly Outlet<any>[] {
    return this.#outlets;
  }

  /** @internal Brings this node's outlets up to date. See the module docstring. */
  ensureFresh(): void {
    if (!this.#dirty) {
      if (this.#hasError) throw this.#error;
      return;
    }
    if (this.#evaluating) {
      // Unreachable while `connect()` rejects cycles, but a node whose
      // `compute` reaches back into the graph and pulls itself lands
      // here — which is the same defect, found a step later.
      throw new CycleError(
        `Node '${this.kind}' was pulled while it was still evaluating — its compute re-entered the graph`,
      );
    }
    this.#evaluating = true;
    try {
      // Refresh upstream first, then compare versions: a dirty mark says
      // "maybe stale", the versions say whether anything really moved.
      const versions = new Map<string, number>();
      let changed = !this.#computed;
      for (const inlet of this.#inlets) {
        inlet.source?.node.ensureFresh();
        const version = inlet.sourceVersion();
        versions.set(inlet.name, version);
        if (this.#inputVersions.get(inlet.name) !== version) changed = true;
      }

      this.#dirty = false;
      if (!changed) {
        if (this.#hasError) throw this.#error;
        return;
      }

      this.#inputVersions = versions;
      this.#computed = true;

      // Reading inputs, computing, and storing outputs share one catch:
      // all three can fail, and a node that fails any of them must end
      // up in the same state — error cached, rethrown on every pull
      // until an input changes. Catching only around `compute` left a
      // node that threw while reading an unconnected input marked clean
      // with no value and no error, so the second pull reported a
      // misleading "produced no value" instead of the real cause.
      try {
        const inputs: Record<string, unknown> = {};
        for (const inlet of this.#inlets) inputs[inlet.name] = inlet.get();

        const produced = this.#compute(inputs as PortValues<In>);
        if (produced === null || typeof produced !== 'object') {
          throw new MissingOutputError(
            `Node '${this.kind}' compute must return an object of output values`,
          );
        }
        const values = produced as Record<string, unknown>;
        for (const outlet of this.#outlets) {
          if (!(outlet.name in values)) {
            throw new MissingOutputError(
              `Node '${this.kind}' compute did not return output '${outlet.name}'`,
            );
          }
          outlet.produce(values[outlet.name]);
        }
        this.#error = undefined;
        this.#hasError = false;
      } catch (error) {
        this.#error = error;
        this.#hasError = true;
        throw error;
      }
    } finally {
      this.#evaluating = false;
    }
  }
}

/** Creates instances of a declared node type. */
export interface NodeFactory<In extends PortSpecMap, Out extends PortSpecMap> {
  (): Node<In, Out>;
  /** The `kind` of the nodes this factory produces. */
  readonly kind: string;
}

/**
 * Declares a reusable node type and returns a factory for it.
 *
 * ```ts
 * const Stats = defineNode({
 *   kind: 'stats',
 *   inputs: { series: port<TimeSeries<Schema>>() },
 *   outputs: { mean: port<number>(), max: port<number>() },
 *   compute: ({ series }) => ({
 *     mean: series.column('cpu').mean(),
 *     max: series.column('cpu').max(),
 *   }),
 * });
 *
 * const stats = Stats();
 * raw.out.value.connect(stats.in.series);
 * stats.out.mean.get();
 * ```
 *
 * For a node type that needs per-instance configuration, close over it:
 * `const smoother = (span: number) => defineNode({ ... })();`
 */
export function defineNode<In extends PortSpecMap, Out extends PortSpecMap>(
  spec: NodeSpec<In, Out>,
): NodeFactory<In, Out> {
  const factory = (): Node<In, Out> => new Node(spec);
  return Object.assign(factory, { kind: spec.kind });
}

/** Extracts the value type carried by an {@link Outlet}. */
export type OutletValue<O> = O extends Outlet<infer T> ? T : never;

/** The spec map implied by a record of source outlets. */
export type SpecsForOutlets<M> = {
  [K in keyof M]: PortSpec<OutletValue<M[K]>>;
};

/** The single-output spec map produced by {@link derive}. */
export type DerivedOutput<R> = { readonly value: PortSpec<R> };

/**
 * Builds a single-output node and wires it to its sources in one step —
 * the shape most graph edges take.
 *
 * ```ts
 * const smoothed = derive({ series: raw.out.value }, ({ series }) =>
 *   series.smooth('cpu', { method: 'ema', alpha: 0.3 }),
 * );
 * smoothed.out.value.get();
 * ```
 *
 * Equivalent to {@link defineNode} with one output named `value`, an
 * input per source key, and the connections already made. Reach for
 * `defineNode` when a node has several outputs, or when the node type is
 * reused across graphs and deserves a name.
 */
export function derive<
  Sources extends Readonly<Record<string, Outlet<any>>>,
  R,
>(
  sources: Sources,
  compute: (inputs: { [K in keyof Sources]: OutletValue<Sources[K]> }) => R,
  options: {
    /** Node type name for errors and `toJSON()`. Defaults to `'derive'`. */
    readonly kind?: string;
    /** Change test for the output. Defaults to `Object.is`. */
    readonly equals?: (a: R, b: R) => boolean;
  } = {},
): Node<SpecsForOutlets<Sources>, DerivedOutput<R>> {
  const inputs: Record<string, PortSpec<any>> = {};
  for (const name of Object.keys(sources)) inputs[name] = {};
  const outputValue: PortSpec<R> = options.equals
    ? { equals: options.equals }
    : {};

  const node = new Node({
    kind: options.kind ?? 'derive',
    inputs: inputs as SpecsForOutlets<Sources>,
    outputs: { value: outputValue } as DerivedOutput<R>,
    compute: (values) => ({
      value: compute(
        values as { [K in keyof Sources]: OutletValue<Sources[K]> },
      ),
    }),
  });

  for (const [name, outlet] of Object.entries(sources)) {
    const inlet = (node.in as Record<string, Inlet<any>>)[name];
    if (inlet === undefined) {
      // Unreachable: the inputs above are built from these same keys.
      throw new MissingOutputError(
        `Node '${node.kind}' has no input named '${name}'`,
      );
    }
    outlet.connect(inlet);
  }
  return node;
}
