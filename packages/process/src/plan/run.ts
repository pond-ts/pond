/**
 * `run` — one entry point, one response. [PND-DEMOM0], [PND-PROCTERM].
 *
 * The request carries a plan **and** what it wants back. A renderer asks
 * for columns; an agent asks for facts; a legend chip is a fact riding
 * alongside columns in the same pass. Collapsing the request rather than
 * forking the terminal is what makes that one call.
 *
 * Two things measured earlier are load-bearing here:
 *
 * - **Facts read node values directly.** Assembling a `TimeSeries` so a
 *   reduction has a column to read cost 52× more, and 441× once facts
 *   memoize. Assembly happens only when `columns` is asked for.
 * - **Assembly resolves a closure.** "Needed" is not "selected with
 *   `columns`": a reduction reads a column too, and `crossings`'s
 *   `against` names a second one. Assembling only the column-selectors
 *   produced a fact with *no value* rather than an error — silent, which
 *   is worse than a throw.
 */

import { appendColumn } from '../column.js';
import { ProcessError } from '../errors.js';
import type { Column, SeriesSchema, TimeSeries } from 'pond-ts';
import type { BoundGraph } from './graph.js';
import { columnsOf, explain, refToId, unitOf } from './identity.js';
import type { Plan, Spec, SpecRef } from './types.js';

/** What to do when a spec or a selector fails. Covers both, not just resolution. */
export type ErrorPolicy = 'throw' | 'skip' | 'collect';

/** Ask for a spec's columns, for drawing. */
export interface ColumnSelect {
  readonly on: SpecRef;
  readonly columns: true;
}

/** Ask for a fact — a fold over one resolved column. */
export interface ReduceSelect {
  readonly on: SpecRef;
  /** Which output of a multi-output op. Defaults to the first. */
  readonly output?: string;
  readonly reduce: ReductionName;
  /** For `crossings`: the id of the column to compare against. */
  readonly against?: string;
  /** For `shape`: roughly how many points to return. */
  readonly points?: number;
}

export type Select = ColumnSelect | ReduceSelect;

export type ReductionName = 'last' | 'extremes' | 'percentileRank' | 'shape';

export interface RunRequest {
  readonly plan: Plan;
  readonly select?: readonly Select[];
  readonly onError?: ErrorPolicy;
}

export interface OutputInfo {
  readonly column: string;
  readonly unit: string | null;
}

export interface Fact {
  readonly id: string;
  readonly reduce: ReductionName;
  readonly unit: string | null;
  readonly [k: string]: unknown;
}

/** One node's contribution to a request — the per-node badge. */
export interface NodeTiming {
  readonly id: string;
  /** False when the value was produced this call. */
  readonly cached: boolean;
  /** Milliseconds attributable to this node, to 3 decimal places. */
  readonly ms: number;
}

export interface Skipped {
  readonly spec?: { op: string; params: Record<string, unknown> };
  readonly select?: Select;
  readonly reason: string;
}

export interface RunResult {
  /** Present only when a `columns` selector asked for it. */
  readonly series?: TimeSeries<SeriesSchema>;
  readonly outputs: Readonly<Record<string, readonly OutputInfo[]>>;
  readonly facts: readonly Fact[];
  /** Lineage per resolved id — present on every response, never hand-built. */
  readonly explain: Readonly<Record<string, string>>;
  readonly skipped: readonly Skipped[];
  /**
   * Every node this request touched, in dependency order, with whether
   * it was computed or served warm and how long it took.
   *
   * This is the demo's explaining device ([PND-DEMOM1]): without it the
   * caching is true but invisible.
   */
  readonly nodes: readonly NodeTiming[];
}

// ── reductions: folds over a column, no series required ──────

const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
const round = (v: number): number => Math.round(v * 1e6) / 1e6;

/** Reads a column into a dense array once, for the folds that need indexing. */
function densify(column: Column): (number | undefined)[] {
  const out = new Array<number | undefined>(column.length).fill(undefined);
  const anyCol = column as unknown as { at(i: number): number | undefined };
  for (let i = 0; i < column.length; i += 1) {
    const v = anyCol.at(i);
    if (v !== undefined && !Number.isNaN(v)) out[i] = v;
  }
  return out;
}

function keysOf(series: TimeSeries<SeriesSchema>): number[] {
  const kc = series.keyColumn() as unknown as {
    length: number;
    at(i: number): number;
  };
  const out = new Array<number>(kc.length);
  for (let i = 0; i < kc.length; i += 1) out[i] = kc.at(i);
  return out;
}

function reduceColumn(
  name: ReductionName,
  column: Column,
  keys: number[],
  sel: ReduceSelect,
  other: Column | undefined,
): Record<string, unknown> {
  const v = densify(column);
  if (name === 'last') {
    for (let i = v.length - 1; i >= 0; i -= 1) {
      if (v[i] !== undefined) return { value: round(v[i]!), at: day(keys[i]!) };
    }
    return { value: null };
  }
  if (name === 'extremes') {
    let lo = Infinity;
    let hi = -Infinity;
    let loAt = 0;
    let hiAt = 0;
    for (let i = 0; i < v.length; i += 1) {
      const x = v[i];
      if (x === undefined) continue;
      if (x < lo) {
        lo = x;
        loAt = keys[i]!;
      }
      if (x > hi) {
        hi = x;
        hiAt = keys[i]!;
      }
    }
    if (lo === Infinity) return { min: null, max: null };
    return {
      min: { value: round(lo), at: day(loAt) },
      max: { value: round(hi), at: day(hiAt) },
    };
  }
  if (name === 'percentileRank') {
    const defined = v.filter((x): x is number => x !== undefined);
    if (defined.length === 0) return { value: null };
    const last = defined[defined.length - 1]!;
    const below = defined.filter((x) => x < last).length;
    return {
      value: round(below / defined.length),
      note: `${Math.round((below / defined.length) * 100)}th percentile of ${defined.length} observations`,
    };
  }
  // shape — the honest answer to "return the series" for a token-metered
  // caller: a bounded envelope instead of every point.
  const want = sel.points ?? 40;
  const step = Math.max(1, Math.floor(v.length / want));
  const pts: [string, number][] = [];
  for (let i = 0; i < v.length; i += step) {
    if (v[i] !== undefined) pts.push([day(keys[i]!), round(v[i]!)]);
  }
  void other;
  return { points: pts.length, series: pts };
}

// ── run ──────────────────────────────────────────────────────

export function run(graph: BoundGraph, request: RunRequest): RunResult {
  const { plan, select = [], onError = 'throw' } = request;
  const registry = graph.registry;
  const skipped: Skipped[] = [];
  const resolved: { id: string; spec: Spec }[] = [];

  const fail = (entry: Skipped): void => {
    if (onError === 'throw') throw new ProcessError(entry.reason);
    skipped.push(entry);
  };

  // ── resolve the plan ───────────────────────────────────────
  for (const spec of plan) {
    try {
      const compiled = graph.compile(spec);
      resolved.push({ id: compiled.id, spec });
    } catch (e) {
      fail({
        spec: { op: spec.op, params: { ...(spec.params ?? {}) } },
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const explainMap: Record<string, string> = {};
  for (const { id, spec } of resolved) explainMap[id] = explain(registry, spec);

  // ── work out what the selection actually needs ──────────────
  // Every id any selector mentions, including a `crossings` `against`.
  const needed = new Map<string, boolean>(); // id -> report in `outputs`
  const selectors: { sel: Select; id: string }[] = [];
  for (const sel of select) {
    let id: string;
    try {
      id = refToId(registry, sel.on);
    } catch (e) {
      fail({ select: sel, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    selectors.push({ sel, id });
    const wantsColumns = 'columns' in sel && sel.columns === true;
    needed.set(id, (needed.get(id) ?? false) || wantsColumns);
    if ('against' in sel && typeof sel.against === 'string') {
      needed.set(sel.against, needed.get(sel.against) ?? false);
    }
  }

  const outputs: Record<string, OutputInfo[]> = {};
  const timings: NodeTiming[] = [];
  const timed = new Set<string>();
  let assembled: TimeSeries<SeriesSchema> | undefined;
  const columnCache = new Map<string, Column>();

  /**
   * Pulls a node's inputs before the node itself, so the time recorded
   * against it is its own compute rather than an ancestor's. Without
   * this a leaf absorbs the whole subtree's cost and the badge lies.
   */
  const warm = (id: string): void => {
    if (timed.has(id)) return;
    timed.add(id);
    const compiled = graph.get(id);
    if (compiled === undefined) return;
    for (const input of compiled.spec.inputs) {
      if (typeof input !== 'string') warm(refToId(registry, input));
    }
    const suffix = registry.get(compiled.spec.op).outputs[0]!.id;
    const wasDirty = compiled.node.dirty;
    const t0 = performance.now();
    graph.columnOf(compiled, suffix);
    const ms = performance.now() - t0;
    timings.push({ id, cached: !wasDirty, ms: Math.round(ms * 1000) / 1000 });
  };

  const columnFor = (id: string, suffix: string): Column => {
    const key = id + suffix;
    const hit = columnCache.get(key);
    if (hit) return hit;
    const compiled = graph.get(id);
    if (compiled === undefined)
      throw new ProcessError(`'${id}' is not in this plan`);
    warm(id);
    const col = graph.columnOf(compiled, suffix);
    columnCache.set(key, col);
    return col;
  };

  // ── assemble, but only what was asked for ──────────────────
  const wantsAnyColumns = selectors.some((s) => 'columns' in s.sel);
  if (wantsAnyColumns) {
    assembled = graph.series;
    for (const [id, report] of needed) {
      const compiled = graph.get(id);
      if (compiled === undefined) continue;
      const cols = columnsOf(registry, compiled.spec, id);
      const op = registry.get(compiled.spec.op);
      if (report) outputs[id] = [];
      op.outputs.forEach((o, n) => {
        const col = columnFor(id, o.id);
        assembled = appendColumn(assembled!, cols[n]!, col);
        if (report) {
          outputs[id]!.push({
            column: cols[n]!,
            unit: unitOf(registry, compiled.spec, graph.units, n),
          });
        }
      });
    }
  }

  // ── facts read node values; no series is built for them ────
  const facts: Fact[] = [];
  const keys = keysOf(graph.series);
  for (const { sel, id } of selectors) {
    if ('columns' in sel && sel.columns === true) {
      if (graph.get(id) === undefined) {
        fail({ select: sel, reason: `'${id}' is not in this plan` });
      }
      continue;
    }
    const reduceSel = sel as ReduceSelect;
    try {
      const compiled = graph.get(id);
      if (compiled === undefined)
        throw new ProcessError(`'${id}' is not in this plan`);
      const suffix =
        reduceSel.output ?? registry.get(compiled.spec.op).outputs[0]!.id;
      const column = columnFor(id, suffix);
      const other =
        reduceSel.against !== undefined
          ? columnFor(reduceSel.against, '')
          : undefined;
      const idx = registry
        .get(compiled.spec.op)
        .outputs.findIndex((o) => o.id === suffix);
      facts.push({
        id: id + suffix,
        reduce: reduceSel.reduce,
        unit: unitOf(registry, compiled.spec, graph.units, Math.max(0, idx)),
        ...(reduceSel.against !== undefined && { against: reduceSel.against }),
        ...reduceColumn(reduceSel.reduce, column, keys, reduceSel, other),
      });
    } catch (e) {
      fail({ select: sel, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    ...(assembled !== undefined && { series: assembled }),
    outputs,
    facts,
    explain: explainMap,
    skipped,
    nodes: timings,
  };
}
