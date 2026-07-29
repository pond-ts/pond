/**
 * Plan-layer types — [PND-DEMOM0].
 *
 * A plan is **data**: a DAG of `{ op, params, inputs }` specs that can
 * arrive as JSON from a saved view or an agent. This file defines that
 * shape and the op declarations it resolves against.
 */

import type { Column, TimeSeries, SeriesSchema } from 'pond-ts';

/** A JSON-safe param value. Params arrive off a wire, not from code. */
export type ParamValue = string | number | boolean;

/** One node in a plan: an op, its params, and where its inputs come from. */
export interface Spec {
  readonly op: string;
  readonly params?: Readonly<Record<string, ParamValue>>;
  /** A raw source column name, or a nested spec. Plural from the start. */
  readonly inputs: readonly Input[];
}

/**
 * One named output of an upstream spec.
 *
 * A nested input used to read output 0 and nothing else, so `sma` of a
 * Bollinger band could only ever smooth `Upper` — a limitation nobody
 * hit while `select.output` existed to pick one at the end. Folds made
 * it visible: a fold *is* the end, so with no way to say which output it
 * reads, the middle and lower bands became unreachable.
 */
export interface PickedOutput {
  readonly from: Spec;
  /** The output's declared suffix, e.g. `'Lower'`. */
  readonly output: string;
}

/** An input is a raw column name, another spec, or one output of one. */
export type Input = string | Spec | PickedOutput;

/** Narrows an input to the picked-output form. */
export function isPicked(input: Input): input is PickedOutput {
  return typeof input !== 'string' && 'from' in input;
}

/** The spec an input refers to, ignoring which output it picks. */
export function specOf(input: Spec | PickedOutput): Spec {
  return 'from' in input ? input.from : input;
}

/** A DAG. Declaration order is free; nesting is inline. */
export type Plan = readonly Spec[];

/** How a request refers to a resolved spec: inline, or by its id. */
export type SpecRef = string | Spec;

// ── param declarations ───────────────────────────────────────

export interface NumberParam {
  readonly kind: 'number' | 'integer';
  readonly default: number;
  /** The legal range. Outside it is an error. */
  readonly min?: number;
  readonly max?: number;
  /**
   * The **useful** range — `[lo, hi]`, within `[min, max]`.
   *
   * `min`/`max` answer "would this be rejected?", which is a different
   * question from "what would anyone actually pick?", and the gap between
   * them is usually enormous: a `period` legal to 5000 is interesting
   * below about 200, so a slider drawn on the legal range spends 96% of
   * its travel where nobody goes. Declaring the useful range is what lets
   * a control be drawn on it and a model be told it.
   *
   * Purely advisory — nothing rejects a value outside it, since a bound
   * that rejects is what `min`/`max` already are.
   */
  readonly suggest?: readonly [number, number];
  readonly label?: string;
}

export interface EnumParam {
  readonly kind: 'enum';
  readonly default: string;
  readonly of: readonly string[];
  readonly label?: string;
}

export interface BooleanParam {
  readonly kind: 'boolean';
  readonly default: boolean;
  readonly label?: string;
}

export type ParamDef = NumberParam | EnumParam | BooleanParam;

/** The resolved param record an op's `run` receives, post-defaults. */
export type Params = Readonly<Record<string, ParamValue>>;

// ── units ────────────────────────────────────────────────────

/**
 * A unit is either declared outright or inherited from input 0.
 *
 * Units are an **input to resolution**, not a property of a series: pond
 * series do not carry units, consumers do. Passing them in is what lets
 * an op demand a typed input (an annualiser wanting `variance`) and what
 * lets a response report concrete units.
 */
export type UnitSpec = 'inherit' | string;

/** Consumer-supplied units for the bound source's raw columns. */
export type Units = Readonly<Record<string, string>>;

// ── op declarations ──────────────────────────────────────────

export interface InputDef {
  /** Name the op's `run` reads this input by. */
  readonly role: string;
  /** A unit this input must already carry, if the op demands one. */
  readonly unit?: string;
}

export interface OutputDef {
  /**
   * Suffix appended to the spec's id to name this output's column.
   *
   * `''` for a single-output op, so the column *is* the id. A band
   * declares `'Upper' | 'Middle' | 'Lower'`, matching the corpus's own
   * `prefix` convention — one spec, three columns, moved and deleted as
   * a unit.
   */
  readonly id: string;
  readonly unit: UnitSpec;
  /**
   * Params this output depends on. When declared, a change to a param
   * *not* listed here leaves this output's version untouched, so
   * everything downstream of it skips ([PND-PROCSEL]). Omit to mean
   * "depends on everything", which is correct but never skips.
   */
  readonly dependsOn?: readonly string[];
}

/** What an op's `run` is handed. */
export interface OpContext {
  /**
   * The bound source, widened to carry this op's input columns under the
   * names in {@link inputs}. Prepared by the plan layer so an op can call
   * the corpus normally — the studies take `(series, { column })`.
   */
  readonly series: TimeSeries<SeriesSchema>;
  /** Column name per input role. */
  readonly inputs: Readonly<Record<string, string>>;
  readonly params: Params;
  /** This spec's id — the output column name, or a band's prefix. */
  readonly id: string;
}

/**
 * An op's result: one entry per declared output, in declaration order.
 *
 * A `Column` is returned as-is (already packed); loose values are packed
 * once by the plan layer rather than retained boxed ([PND-PROCCOL]).
 */
export type OpResult =
  | Column
  | ArrayLike<number | undefined>
  | readonly (Column | ArrayLike<number | undefined>)[];

export interface OpDef {
  /** Discriminates against {@link FoldDef}. Optional, because an op is the default. */
  readonly kind?: 'op';
  readonly name: string;
  readonly family: string;
  readonly summary: string;
  readonly params: Readonly<Record<string, ParamDef>>;
  readonly inputs: readonly InputDef[];
  readonly outputs: readonly OutputDef[];
  /**
   * Human lineage fragment, e.g. `SMA(20) of iv21`. Optional — a generic
   * `op(params) of inputs` is derived when absent, but a label reads far
   * better in a legend chip or a graph node.
   */
  readonly label?: (params: Params, inputs: string) => string;
  readonly run: (ctx: OpContext) => OpResult;
}

// ── folds ────────────────────────────────────────────────────

/**
 * What a fold returns: the body of a fact.
 *
 * Deliberately loose. `last` answers with a value and a timestamp,
 * `extremes` with two of each, `percentileRank` with a fraction and a
 * sentence explaining it. Forcing those into one shape would mean
 * inventing a lowest common denominator that suits none of them.
 */
export type FactBody = Readonly<Record<string, unknown>>;

export interface FoldContext {
  /**
   * Dense values per input role, gaps as `undefined`.
   *
   * Prepared by the graph rather than by each fold, and — the point of
   * the whole exercise — prepared **inside the memo**, so densifying a
   * 150,000-row column happens once per version rather than once per
   * request.
   */
  readonly values: Readonly<Record<string, readonly (number | undefined)[]>>;
  /**
   * Timestamp at a row index.
   *
   * A function rather than an array because a fold reports two or three
   * rows out of 150,000, and materializing the key column to answer that
   * was most of what a reduction used to cost.
   */
  readonly at: (index: number) => number;
  readonly params: Params;
  /** This fold's id — the fact's own cache key and citation. */
  readonly id: string;
}

/**
 * A **fold** — a node that ends in a fact rather than a column.
 *
 * Reductions used to be a fixed enum on the selector, computed after the
 * graph had finished: `last` rescanned 150,000 values on a total cache
 * hit, and `percentileRank` densified and filtered twice, every request,
 * forever. Measured at 10.85 ms of an 11.6 ms warm run — the graph
 * memoized every intermediate and then recomputed the only part anyone
 * actually read.
 *
 * A fold is an ordinary registry entry with an ordinary content-addressed
 * id, so it caches, it carries provenance, and a consumer adds one by
 * calling `define` rather than by editing this library. What it cannot do
 * is feed anything: a fold produces a fact, so it is always a leaf, and
 * naming one as an op's input is rejected at compile time.
 */
export interface FoldDef {
  readonly kind: 'fold';
  readonly name: string;
  readonly family: string;
  readonly summary: string;
  readonly params: Readonly<Record<string, ParamDef>>;
  readonly inputs: readonly InputDef[];
  /** The unit the fact carries. `'inherit'` takes input 0's. */
  readonly unit: UnitSpec;
  readonly label?: (params: Params, inputs: string) => string;
  readonly fold: (ctx: FoldContext) => FactBody;
}

/** Anything the registry holds. */
export type Def = OpDef | FoldDef;

/** Narrows a registry entry to the terminal kind. */
export function isFold(def: Def): def is FoldDef {
  return def.kind === 'fold';
}
