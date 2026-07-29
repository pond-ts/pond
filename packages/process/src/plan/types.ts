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

/** An input is a raw column name or another spec. */
export type Input = string | Spec;

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
