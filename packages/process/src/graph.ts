/**
 * Graph-level inspection: enumerate what's wired to what, get a
 * topological order, dump the structure.
 *
 * Nodes work standalone — connections live on the ports, and evaluation
 * never consults a container. `Graph` is a read-only view over an
 * already-wired set of nodes, for the cases where you need the whole
 * picture: rendering a node editor, logging evaluation order, asserting
 * on structure in tests.
 */

import type { Inlet, Outlet } from './port.js';
import type { Node } from './node.js';

/** One connection between two nodes. */
export interface GraphEdge {
  readonly from: Outlet<any>;
  readonly to: Inlet<any>;
}

/** Serialized form of one node. Structure only — no values. */
export interface GraphNodeJson {
  readonly id: string;
  readonly kind: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

/** Serialized form of one edge, by node id and port name. */
export interface GraphEdgeJson {
  readonly from: { readonly node: string; readonly port: string };
  readonly to: { readonly node: string; readonly port: string };
}

/** Structural dump of a graph. See {@link Graph.toJSON}. */
export interface GraphJson {
  readonly nodes: readonly GraphNodeJson[];
  readonly edges: readonly GraphEdgeJson[];
}

/** A read-only view over a wired set of nodes. */
export class Graph {
  readonly #nodes: readonly Node<any, any>[];

  constructor(nodes: Iterable<Node<any, any>>) {
    this.#nodes = [...new Set(nodes)];
  }

  /**
   * Discovers every node reachable from `roots`, following connections
   * in both directions.
   *
   * ```ts
   * const graph = Graph.from(sink);
   * graph.order().map((node) => node.kind);
   * ```
   */
  static from(...roots: readonly Node<any, any>[]): Graph {
    const seen = new Set<Node<any, any>>();
    const queue: Node<any, any>[] = [...roots];
    while (queue.length > 0) {
      const node = queue.shift() as Node<any, any>;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const inlet of node.inletList()) {
        const upstream = inlet.source;
        if (upstream !== undefined) queue.push(upstream.node as Node<any, any>);
      }
      for (const outlet of node.outletList()) {
        for (const inlet of outlet.connections)
          queue.push(inlet.node as Node<any, any>);
      }
    }
    return new Graph(seen);
  }

  /** Every node in the graph, in discovery order. */
  get nodes(): readonly Node<any, any>[] {
    return this.#nodes;
  }

  /**
   * Every connection, grouped by producing node in {@link order}. Like
   * `order()`, the result is independent of how the graph was
   * discovered.
   */
  edges(): readonly GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const node of this.order()) {
      for (const outlet of node.outletList()) {
        const consumers = [...outlet.connections].sort((a, b) =>
          byId(a.node, b.node),
        );
        for (const inlet of consumers) edges.push({ from: outlet, to: inlet });
      }
    }
    return edges;
  }

  /**
   * Nodes in dependency order — every node appears after the nodes
   * feeding it. Evaluation doesn't need this (pulling is recursive and
   * finds its own order); it's for display and for reasoning about a
   * graph you didn't build.
   *
   * The DFS is seeded in node-id order rather than discovery order, so
   * the result depends only on which nodes are in the graph — not on
   * which node `Graph.from` happened to start from. Several topological
   * orders are usually valid; this picks the same one every time.
   */
  order(): readonly Node<any, any>[] {
    const known = new Set(this.#nodes);
    const visited = new Set<Node<any, any>>();
    const ordered: Node<any, any>[] = [];
    const seeds = [...this.#nodes].sort(byId);

    const visit = (node: Node<any, any>): void => {
      if (visited.has(node)) return;
      visited.add(node);
      for (const inlet of node.inletList()) {
        const upstream = inlet.source?.node as Node<any, any> | undefined;
        // Skip dependencies outside this graph — `order()` sorts the
        // nodes it was given, it doesn't silently widen the set.
        if (upstream !== undefined && known.has(upstream)) visit(upstream);
      }
      ordered.push(node);
    };

    for (const node of seeds) visit(node);
    return ordered;
  }

  /**
   * Structural dump: node ids, kinds, port names, and edges.
   *
   * Nodes come out in {@link order}, not discovery order, so the dump of
   * a given graph is the same whichever node `Graph.from` started at —
   * which is what makes it safe to diff two dumps against each other.
   *
   * This is a **description, not a serialization** — there is no
   * `fromJSON`. Rebuilding a graph from JSON needs a registry mapping
   * `kind` to a factory, plus per-node config in the dump; neither
   * exists yet. Use this for inspection, diffing, and rendering.
   */
  toJSON(): GraphJson {
    return {
      nodes: this.order().map((node) => ({
        id: node.id,
        kind: node.kind,
        inputs: node.inletList().map((inlet) => inlet.name),
        outputs: node.outletList().map((outlet) => outlet.name),
      })),
      edges: this.edges().map((edge) => ({
        from: { node: edge.from.node.id, port: edge.from.name },
        to: { node: edge.to.node.id, port: edge.to.name },
      })),
    };
  }
}

/**
 * Orders nodes by creation sequence. Node ids are `n1`, `n2`, … so a
 * plain string sort would put `n10` before `n2`; compare numerically.
 */
function byId(a: Node<any, any>, b: Node<any, any>): number {
  return a.id.localeCompare(b.id, undefined, { numeric: true });
}
