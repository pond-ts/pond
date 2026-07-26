/**
 * `@pond-ts/process` — a typed dataflow graph over pond values.
 *
 * Where the rest of pond is chain-first (`series.rolling(...).aggregate(...)`),
 * this package is for the case chaining can't express: when the pipeline
 * itself is **data** — assembled at runtime, reshaped by a user, rendered
 * as a node editor, or shared as one computation with several outputs.
 *
 * The chain API remains the primary way to use pond. Reach for a graph
 * only when the topology isn't known at authoring time.
 *
 * ```ts
 * import { source, derive } from '@pond-ts/process';
 *
 * const raw = source<TimeSeries<Schema>>();
 * const hourly = derive({ s: raw.out.value }, ({ s }) =>
 *   s.aggregate(Sequence.every('1h'), { cpu: 'avg' }),
 * );
 *
 * raw.set(series);
 * hourly.out.value.get();
 * ```
 */

export { Inlet, Outlet } from './port.js';
export { Node, defineNode, derive } from './node.js';
export type {
  NodeSpec,
  NodeFactory,
  InletsFor,
  OutletsFor,
  OutletValue,
  SpecsForOutlets,
  DerivedOutput,
} from './node.js';
export { port } from './types.js';
export type { PortSpec, PortSpecMap, PortValue, PortValues } from './types.js';
export {
  source,
  fromLive,
  SourceNode,
  LiveSourceNode,
  UnsetSourceError,
} from './source.js';
export type { NoInputs, GraphSource, SnapshotSource } from './source.js';
export { Graph } from './graph.js';
export type {
  GraphEdge,
  GraphJson,
  GraphNodeJson,
  GraphEdgeJson,
} from './graph.js';
export {
  ProcessError,
  CycleError,
  UnconnectedInputError,
  MissingOutputError,
} from './errors.js';
