/**
 * Typed ports and the wiring between them.
 *
 * An `Outlet<T>` is a node's typed output; an `Inlet<T>` is a typed
 * input. Because both are generic in the value type and the connect
 * signatures require a matching `T`, wiring a `string` output into a
 * `number` input is a compile error rather than a runtime surprise.
 *
 * Ports also carry the evaluation state. Each outlet holds the cached
 * value plus a **version stamp** that increments only when a recomputed
 * value actually differs (per the port's `equals`). Nodes record the
 * input versions they last computed against, which is what lets a node
 * that was marked dirty skip recomputation when nothing upstream really
 * changed. See `node.ts` for the pull algorithm that uses this.
 */

import {
  CycleError,
  MissingOutputError,
  UnconnectedInputError,
} from './errors.js';

/**
 * The part of a node the ports need to see. Declared here rather than
 * importing `Node` so `port.ts` and `node.ts` don't form an import
 * cycle.
 *
 * @internal
 */
export interface PortOwner {
  readonly id: string;
  readonly kind: string;
  /** @internal Bring this node's outlets up to date. */
  ensureFresh(): void;
  /** @internal Mark stale and propagate downstream. */
  markDirty(): void;
  /** @internal Force recompute on the next pull, ignoring input versions. */
  invalidate(): void;
  /** @internal Every declared inlet, for upstream traversal. */
  inletList(): readonly Inlet<any>[];
  /** @internal Every declared outlet, for downstream traversal. */
  outletList(): readonly Outlet<any>[];
}

/** A node's typed output port. */
export class Outlet<T> {
  readonly name: string;
  readonly node: PortOwner;

  #value: T | undefined;
  #hasValue = false;
  #version = 0;
  readonly #equals: (a: T, b: T) => boolean;
  readonly #downstream = new Set<Inlet<T>>();

  /** @internal Constructed by `Node`; not part of the public surface. */
  constructor(node: PortOwner, name: string, equals?: (a: T, b: T) => boolean) {
    this.node = node;
    this.name = name;
    this.#equals = equals ?? Object.is;
  }

  /**
   * Evaluates this outlet and returns its value.
   *
   * Pull-based: the owning node recomputes only if it is dirty *and* an
   * upstream version actually changed. A clean node returns the cached
   * value without touching the rest of the graph.
   */
  get(): T {
    this.node.ensureFresh();
    if (!this.#hasValue) {
      throw new MissingOutputError(
        `Node '${this.node.kind}' produced no value for output '${this.name}'`,
      );
    }
    return this.#value as T;
  }

  /**
   * Returns the cached value without evaluating anything, or `undefined`
   * if this outlet has never produced one. Use it to inspect graph state
   * (a debug view, a node inspector) without forcing computation.
   */
  peek(): T | undefined {
    return this.#value;
  }

  /**
   * How many times this outlet's value has actually changed. Downstream
   * nodes compare against this to decide whether a dirty mark was a real
   * change or a false alarm. `0` means nothing has been produced yet.
   */
  get version(): number {
    return this.#version;
  }

  /** The inlets this outlet feeds. */
  get connections(): readonly Inlet<T>[] {
    return [...this.#downstream];
  }

  /**
   * Wires this output into `inlet`.
   *
   * @throws {CycleError} if the edge would close a cycle.
   */
  connect(inlet: Inlet<T>): this {
    link(this, inlet);
    return this;
  }

  /** Removes the edge to `inlet`, if present. */
  disconnect(inlet: Inlet<T>): this {
    if (this.#downstream.has(inlet)) unlink(inlet);
    return this;
  }

  /** @internal Stores a computed value, bumping the version iff it changed. */
  produce(value: T): void {
    if (this.#hasValue && this.#equals(this.#value as T, value)) return;
    this.#value = value;
    this.#hasValue = true;
    this.#version += 1;
  }

  /** @internal */
  invalidateDownstream(): void {
    for (const inlet of this.#downstream) inlet.node.markDirty();
  }

  /** @internal */
  addDownstream(inlet: Inlet<T>): void {
    this.#downstream.add(inlet);
  }

  /** @internal */
  removeDownstream(inlet: Inlet<T>): void {
    this.#downstream.delete(inlet);
  }
}

/** A node's typed input port. */
export class Inlet<T> {
  readonly name: string;
  readonly node: PortOwner;

  #source: Outlet<T> | undefined;
  readonly #defaultValue: T | undefined;
  readonly #hasDefault: boolean;

  /** @internal Constructed by `Node`; not part of the public surface. */
  constructor(node: PortOwner, name: string, defaultValue?: T) {
    this.node = node;
    this.name = name;
    this.#defaultValue = defaultValue;
    this.#hasDefault = defaultValue !== undefined;
  }

  /**
   * Wires `outlet` into this input, replacing any existing connection.
   *
   * @throws {CycleError} if the edge would close a cycle.
   */
  connect(outlet: Outlet<T>): this {
    link(outlet, this);
    return this;
  }

  /** Removes the incoming edge, if any. Falls back to the default value. */
  disconnect(): this {
    unlink(this);
    return this;
  }

  /** Whether an outlet is wired into this input. */
  get connected(): boolean {
    return this.#source !== undefined;
  }

  /** The outlet feeding this input, or `undefined` if unconnected. */
  get source(): Outlet<T> | undefined {
    return this.#source;
  }

  /**
   * Pulls the upstream value, evaluating it if stale.
   *
   * @throws {UnconnectedInputError} if unconnected and no default was declared.
   */
  get(): T {
    if (this.#source !== undefined) return this.#source.get();
    if (this.#hasDefault) return this.#defaultValue as T;
    throw new UnconnectedInputError(
      `Input '${this.name}' of node '${this.node.kind}' is not connected and has no default value`,
    );
  }

  /**
   * The version of the upstream outlet, or `0` when unconnected. Nodes
   * record this to detect real changes.
   *
   * @internal
   */
  sourceVersion(): number {
    return this.#source?.version ?? 0;
  }

  /** @internal */
  setSource(outlet: Outlet<T> | undefined): void {
    this.#source = outlet;
  }
}

/**
 * Creates the edge `outlet -> inlet`, replacing whatever the inlet was
 * connected to. Both `Outlet.connect` and `Inlet.connect` route here, so
 * the two directions can't drift apart.
 */
function link<T>(outlet: Outlet<T>, inlet: Inlet<T>): void {
  if (inlet.source === outlet) return;
  if (wouldCycle(outlet.node, inlet.node)) {
    throw new CycleError(
      `Connecting '${outlet.node.kind}.${outlet.name}' to '${inlet.node.kind}.${inlet.name}' would create a cycle`,
    );
  }
  unlink(inlet);
  inlet.setSource(outlet);
  outlet.addDownstream(inlet);
  // `invalidate()`, not `markDirty()`: version stamps are per-outlet but
  // recorded per-inlet-name, so rewiring an inlet to a *different*
  // outlet that happens to sit at the same version number would look
  // like "nothing changed" and serve a stale cached value. A structural
  // change forces the recompute; the equality check in `produce()` still
  // stops the cascade there if the new value matches the old.
  inlet.node.invalidate();
}

/** Removes the edge feeding `inlet`, if any. */
function unlink<T>(inlet: Inlet<T>): void {
  const current = inlet.source;
  if (current === undefined) return;
  current.removeDownstream(inlet);
  inlet.setSource(undefined);
  inlet.node.invalidate();
}

/**
 * Whether `consumer` is reachable by walking upstream from `producer` —
 * i.e. whether feeding `producer`'s output into `consumer` would close a
 * loop. Runs at connect time, so the graph is acyclic by construction
 * and evaluation never has to guard against infinite recursion.
 */
function wouldCycle(producer: PortOwner, consumer: PortOwner): boolean {
  const seen = new Set<PortOwner>();
  const stack: PortOwner[] = [producer];
  while (stack.length > 0) {
    const current = stack.pop() as PortOwner;
    if (current === consumer) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const inlet of current.inletList()) {
      const upstream = inlet.source;
      if (upstream !== undefined) stack.push(upstream.node);
    }
  }
  return false;
}
