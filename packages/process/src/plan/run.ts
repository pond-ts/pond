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
import { expandSlots, type Slots } from './slots.js';
import { specId } from './identity.js';
import type { Input, Plan, Spec, SpecRef } from './types.js';

/** What to do when a spec or a selector fails. Covers both, not just resolution. */
export type ErrorPolicy = 'throw' | 'skip' | 'collect';

/**
 * A caller's own name for a surfaced output.
 *
 * Set from the key when a request uses `outputs`, and settable directly
 * in the older `select` form too — naming does not require slots. It
 * rides back on the {@link Fact} and {@link OutputInfo} so a consumer
 * reads the name it chose rather than parsing a derived id
 * ([PND-PROCSLOT]).
 */
interface Named {
  readonly name?: string;
}

/** Ask for a spec's columns, for drawing. */
export interface ColumnSelect extends Named {
  readonly on: SpecRef;
  readonly columns: true;
}

/** Ask for a fact — a fold over one resolved column. */
export interface ReduceSelect extends Named {
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

/** Options common to both request forms. */
export interface RunOptions {
  readonly onError?: ErrorPolicy;
  /**
   * Whether a `columns` selector also assembles a widened `TimeSeries`.
   *
   * Defaults to `true`, which is right for an **in-process** renderer:
   * the chart layers take a series plus a column name, and assembling
   * once is cheaper than making every consumer do it.
   *
   * Pass `false` when the consumer is across a wire. Assembly there is
   * pure waste — the series cannot be serialized, and the columns can,
   * so the receiving side rebuilds one with `TimeSeries.fromColumns`,
   * which **adopts a `Float64Array` zero-copy**. Measured at 1M rows,
   * `appendColumn` costs 7.6 ms for a gapless column and 22.4 ms for a
   * gapped one — and every rolling study is gapped ([PND-PROCCOL]).
   */
  readonly assemble?: boolean;
}

/** A request written as nested specs — the original form. */
export interface PlanRequest extends RunOptions {
  readonly plan: Plan;
  readonly select?: readonly Select[];
}

/**
 * A request written as **slots** — [PND-PROCSLOT].
 *
 * `nodes` is keyed by caller-assigned names, and `outputs` is keyed by
 * the caller's name for each surfaced result. Both names ride back on
 * the response, so a consumer keys its UI on a slot that survives a
 * param edit and its cache reasoning on the derived id.
 *
 * Every slot becomes a plan entry, so a slot nothing selects is still
 * reported in {@link RunResult.nodes} — a pipeline view draws the graph
 * that was described, not the subset one selector reached.
 */
export interface SlotRequest extends RunOptions {
  readonly nodes: Slots;
  readonly outputs?: Readonly<Record<string, Select>>;
}

export type RunRequest = PlanRequest | SlotRequest;

export interface OutputInfo {
  readonly column: string;
  readonly unit: string | null;
  /** The caller's name for this output, when it gave one. */
  readonly name?: string;
}

export interface Fact {
  readonly id: string;
  /** The caller's name for this output, when it gave one. */
  readonly name?: string;
  readonly reduce: ReductionName;
  readonly unit: string | null;
  readonly [k: string]: unknown;
}

/** One node's contribution to a request — the per-node badge. */
export interface NodeTiming {
  readonly id: string;
  /**
   * The caller's name for this node's position, when the request was
   * written with slots. Stable across a param edit, unlike {@link id} —
   * which is the whole point of having both ([PND-PROCSLOT]).
   */
  readonly slot?: string;
  /**
   * Whether this request actually read the node's value.
   *
   * A plan may resolve specs nothing selects. They are compiled and they
   * are part of the pipeline, but no value was pulled through them, so
   * {@link ms} is zero and says nothing. Reporting only the pulled subset
   * made `nodes` a half-truth — the M4 pipeline view drew a plan with
   * whole branches missing, because the request had not asked for them.
   */
  readonly pulled: boolean;
  /**
   * False when the value was produced this call.
   *
   * Still meaningful when {@link pulled} is false: a node left clean by
   * an earlier request genuinely holds a cached value, this request just
   * had no reason to read it.
   */
  readonly cached: boolean;
  /** Milliseconds attributable to this node, to 3 decimal places. Zero when not pulled. */
  readonly ms: number;
  /**
   * Upstream node ids, in the op's declared input order. Raw source
   * columns are named by column, so an entry here is either an id in
   * {@link RunResult.nodes} or a column of the bound series.
   *
   * This is what makes the response a **graph** rather than a list.
   * A caller cannot derive it: the edges live in the specs, and turning
   * a spec into an id means reimplementing `specId`'s canonicalization —
   * which is exactly why a selector takes an inline spec rather than an
   * id string. Added for M4's pipeline view.
   */
  readonly inputs: readonly string[];
}

export interface Skipped {
  /**
   * The spec that failed, echoed back — including `inputs`, because a
   * plan may hold two specs of the same op and a caller retrying needs
   * to know which one it was.
   */
  readonly spec?: {
    op: string;
    params: Record<string, unknown>;
    inputs: readonly Input[];
  };
  readonly select?: Select;
  readonly reason: string;
}

export interface RunResult {
  /** Present only when a `columns` selector asked for it, and `assemble`. */
  readonly series?: TimeSeries<SeriesSchema>;
  /**
   * The resolved columns a `columns` selector asked for, keyed by the
   * name they carry in {@link outputs} — present whenever one did.
   *
   * This is the wire-shaped answer, and the one M3 settled on: a column
   * is a `Float64Array` plus a validity bitmap, so it encodes compactly
   * and the consumer reassembles for free. {@link series} is the
   * in-process convenience over the top of it.
   */
  readonly columns?: Readonly<Record<string, Column>>;
  readonly outputs: Readonly<Record<string, readonly OutputInfo[]>>;
  readonly facts: readonly Fact[];
  /**
   * Lineage per id, never hand-built. Covers every id in {@link nodes}
   * as well as the plan's own entries, so a caller labelling a node
   * always has a string for it.
   */
  readonly explain: Readonly<Record<string, string>>;
  readonly skipped: readonly Skipped[];
  /**
   * Every node the plan resolved, in dependency order, each with its
   * upstream ids and whether this request pulled it — and if so, whether
   * it was computed or served warm, and how long it took.
   *
   * Two things at once, and deliberately: it is the demo's explaining
   * device ([PND-DEMOM1]), without which the caching is true but
   * invisible, *and* it is the pipeline's shape ([PND-DEMOM4]), which no
   * caller can derive because turning a spec into an id means
   * reimplementing `specId`.
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

/**
 * Reduces either request form to the one the resolver already handles.
 *
 * A slot request expands to exactly the nested plan its equivalent would
 * have been written as, so both land on identical ids — that equality is
 * the contract, and it is why nothing downstream of here knows slots
 * exist ([PND-PROCSLOT]).
 */
function normalize(
  graph: BoundGraph,
  request: RunRequest,
): { plan: Plan; select: readonly Select[]; slotOf: Map<string, string> } {
  if (!('nodes' in request)) {
    return {
      plan: request.plan,
      select: request.select ?? [],
      slotOf: new Map(),
    };
  }
  const columns = graph.series.schema.slice(1).map((c) => c.name);
  const expanded = expandSlots(request.nodes, columns);

  const slotOf = new Map<string, string>();
  for (const [slot, spec] of expanded) {
    slotOf.set(specId(graph.registry, spec), slot);
  }

  const select = Object.entries(request.outputs ?? {}).map(([name, sel]) => {
    // `on` names a slot here. Anything else is left alone, so an id
    // string still works — a follow-up can cite what the last response
    // returned without re-deriving it.
    const on =
      typeof sel.on === 'string' && expanded.has(sel.on)
        ? expanded.get(sel.on)!
        : sel.on;
    return { ...sel, on, name } as Select;
  });

  return { plan: [...expanded.values()], select, slotOf };
}

export function run(graph: BoundGraph, request: RunRequest): RunResult {
  const { onError = 'throw', assemble = true } = request;
  const { plan, select, slotOf } = normalize(graph, request);
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
        spec: {
          op: spec.op,
          params: { ...(spec.params ?? {}) },
          inputs: spec.inputs,
        },
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
  /** The caller's name per id, for the columns branch. */
  const nameOf = new Map<string, string>();
  for (const sel of select) {
    let id: string;
    try {
      id = refToId(registry, sel.on);
      // An inline spec is a complete description of a computation, so
      // resolve it whether or not the plan also lists it at top level.
      // Requiring both was redundant bookkeeping that no schema could
      // express — so it lived in prose, and a caller composing against
      // the schema alone duly selected a spec it had not listed, and got
      // a skip instead of an answer ([PND-PROCSCHEMA], M5).
      if (typeof sel.on !== 'string' && graph.get(id) === undefined) {
        const compiled = graph.compile(sel.on);
        resolved.push({ id: compiled.id, spec: sel.on });
        explainMap[id] = explain(registry, sel.on);
      }
    } catch (e) {
      fail({ select: sel, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    selectors.push({ sel, id });
    if (sel.name !== undefined) nameOf.set(id, sel.name);
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
  let drawn: Record<string, Column> | undefined;
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
    // Lineage for the whole closure, not just the plan's top level. A
    // nested spec is a node in `nodes` and will be a node in the M4
    // pipeline view, and both label from here — leaving it out meant a
    // badge with a raw id under it.
    explainMap[id] ??= explain(registry, compiled.spec);
    // Resolved on the way down, so an edge names the id the consumer
    // will see in `nodes` rather than a spec it would have to hash.
    const upstream = compiled.spec.inputs.map((input) => {
      if (typeof input === 'string') return input;
      const upId = refToId(registry, input);
      warm(upId);
      return upId;
    });
    const suffix = registry.get(compiled.spec.op).outputs[0]!.id;
    const wasDirty = compiled.node.dirty;
    const t0 = performance.now();
    graph.columnOf(compiled, suffix);
    const ms = performance.now() - t0;
    timings.push({
      id,
      ...(slotOf.has(id) && { slot: slotOf.get(id)! }),
      pulled: true,
      cached: !wasDirty,
      ms: Math.round(ms * 1000) / 1000,
      inputs: upstream,
    });
  };

  /**
   * Records a resolved node the request never pulled, inputs first.
   *
   * The pipeline is the plan, not the subset one selector happened to
   * reach. Reading `node.dirty` is free — no value is produced — so this
   * costs nothing beyond the walk.
   */
  const record = (id: string): void => {
    if (timed.has(id)) return;
    timed.add(id);
    const compiled = graph.get(id);
    if (compiled === undefined) return;
    explainMap[id] ??= explain(registry, compiled.spec);
    const upstream = compiled.spec.inputs.map((input) => {
      if (typeof input === 'string') return input;
      const upId = refToId(registry, input);
      record(upId);
      return upId;
    });
    timings.push({
      id,
      ...(slotOf.has(id) && { slot: slotOf.get(id)! }),
      pulled: false,
      cached: !compiled.node.dirty,
      ms: 0,
      inputs: upstream,
    });
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

  // ── resolve the drawable columns, and assemble only if asked ───
  // The closure, not just the `columns: true` selectors — a reduction
  // reads a column too, and `crossings`'s `against` names a second one.
  const wantsAnyColumns = selectors.some((s) => 'columns' in s.sel);
  if (wantsAnyColumns) {
    drawn = {};
    if (assemble) assembled = graph.series;
    for (const [id, report] of needed) {
      const compiled = graph.get(id);
      if (compiled === undefined) continue;
      const cols = columnsOf(registry, compiled.spec, id);
      const op = registry.get(compiled.spec.op);
      if (report) outputs[id] = [];
      op.outputs.forEach((o, n) => {
        const col = columnFor(id, o.id);
        drawn![cols[n]!] = col;
        if (assemble) assembled = appendColumn(assembled!, cols[n]!, col);
        if (report) {
          outputs[id]!.push({
            column: cols[n]!,
            unit: unitOf(registry, compiled.spec, graph.units, n),
            ...(nameOf.has(id) && { name: nameOf.get(id)! }),
          });
        }
      });
    }
  }

  // ── facts read node values; no series is built for them ────
  const facts: Fact[] = [];
  const keys = keysOf(graph.series);
  for (const { sel, id } of selectors) {
    const wantsColumns = 'columns' in sel && sel.columns === true;
    if (wantsColumns && graph.get(id) === undefined) {
      fail({ select: sel, reason: `'${id}' is not in this plan` });
      continue;
    }
    // Not exclusive. A selector asking for both gets both — that is the
    // legend-chip case [PND-PROCTERM] exists for, a fact riding
    // alongside the columns it labels. Treating `columns` as a mode that
    // suppressed the reduction silently dropped a fact the caller had
    // plainly asked for, which is worse than refusing it.
    if (!('reduce' in sel)) continue;
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
        ...(reduceSel.name !== undefined && { name: reduceSel.name }),
        reduce: reduceSel.reduce,
        unit: unitOf(registry, compiled.spec, graph.units, Math.max(0, idx)),
        ...(reduceSel.against !== undefined && { against: reduceSel.against }),
        ...reduceColumn(reduceSel.reduce, column, keys, reduceSel, other),
      });
    } catch (e) {
      fail({ select: sel, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // Anything the plan resolved but nothing selected. After the pulls, so
  // a node that *was* read keeps its timing rather than being shadowed.
  for (const { id } of resolved) record(id);

  return {
    ...(assembled !== undefined && { series: assembled }),
    ...(drawn !== undefined && { columns: drawn }),
    outputs,
    facts,
    explain: explainMap,
    skipped,
    nodes: timings,
  };
}
