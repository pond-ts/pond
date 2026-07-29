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
export { columnBytes, packColumn, appendColumn } from './column.js';
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

// ─── Plan layer ([PND-DEMOM0]) ──────────────────────────────────
export {
  createRegistry,
  Registry,
  int,
  num,
  choice,
  flag,
} from './plan/registry.js';
export { UnknownOpError, ParamError } from './plan/registry.js';
export { isFold } from './plan/types.js';
export {
  STANDARD_FOLDS,
  last,
  extremes,
  percentileRank,
  shape,
} from './plan/folds.js';
export type { OpDescriptor } from './plan/registry.js';
export {
  specId,
  refToId,
  explain,
  unitOf,
  columnsOf,
  dependsOn,
  outputKey,
} from './plan/identity.js';
export { bind, BoundGraph, UnitError } from './plan/graph.js';
export { expandSlots, SlotError } from './plan/slots.js';
export { plan, PlanBuilder, BuilderError } from './plan/builder.js';
export type { NodeHandle, InputRef, BuiltRequest } from './plan/builder.js';
export type { SlotDef, Slots } from './plan/slots.js';
export { createHost, Host, toWire, UnknownDatasetError } from './plan/host.js';
export type {
  Envelope,
  PlanEnvelope,
  SlotEnvelope,
  DatasetInfo,
  WireResult,
} from './plan/host.js';
export { run } from './plan/run.js';
export type {
  ErrorPolicy,
  RunOptions,
  PlanRequest,
  SlotRequest,
  Select,
  RunRequest,
  RunResult,
  NodeTiming,
  OutputInfo,
  Fact,
  Skipped,
} from './plan/run.js';
export type {
  Spec,
  Plan,
  Input,
  SpecRef,
  ParamValue,
  ParamDef,
  NumberParam,
  EnumParam,
  BooleanParam,
  Params,
  Units,
  UnitSpec,
  InputDef,
  OutputDef,
  OpContext,
  OpResult,
  OpDef,
  Def,
  FoldDef,
  FoldContext,
  FactBody,
} from './plan/types.js';
