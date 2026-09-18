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
import { specOf } from './types.js';
import type { Plan, Spec, SpecRef } from './types.js';

/** What to do when a spec or a selector fails. Covers both, not just resolution. */
export type ErrorPolicy = 'throw' | 'skip' | 'collect';

/**
 * A selector says **what to surface**, not what to compute.
 *
 * It used to say both: `{ on, reduce: 'percentileRank' }` named a node
 * *and* a fold to run over it, from an enum this file owned. The fold is
 * a node now ([PND-PROCFOLD]), so a selector's whole job is to point at
 * one and name it — and what comes back is whatever that node produces:
 * a fact from a fold, columns from anything else.
 *
 * That is the simplification the change was for. There is no `reduce`,
 * no `points`, and no `columns: true`; asking for a bounded sample means
 * pointing at a `shape` node, which is a thing with an id that caches.
 */
export interface Select {
  readonly on: SpecRef;
  /**
   * Which output of a multi-output op. Defaults to all of them.
   *
   * Only meaningful for a column-producing node — a fact has one shape.
   */
  readonly output?: string;
  /**
   * The caller's own name for this output.
   *
   * Set from the key when a request uses `outputs`. It rides back on the
   * {@link Fact} and {@link OutputInfo} so a consumer reads the name it
   * chose rather than parsing a derived id ([PND-PROCSLOT]).
   */
  readonly name?: string;
}

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
  /**
   * Which slots to surface, under the caller's own names.
   *
   * Purely a projection of {@link nodes}: every result here is produced
   * by a node the request declared, so nothing is computed that the plan
   * does not already describe.
   */
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
  /** The fold that produced it — a registry name, not a fixed enum. */
  readonly op: string;
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
   * The spec that failed, echoed back **verbatim** — including `inputs`,
   * because a plan may hold two specs of the same op and a caller
   * retrying needs to know which one it was.
   *
   * `params` and `inputs` are typed `unknown` because this is an echo of
   * whatever arrived, and what arrives is exactly what may be malformed.
   * The plan pass used to normalize — `params: null` came back as `{}` —
   * which was not merely lossy: recomputing an id from the echo then
   * produced the **defaulted spec's valid id**, so a broken persisted
   * entry's report keyed onto a legitimate node (Tidal, on 0.62.0). The
   * selector pass echoed the original all along, so the two disagreed.
   */
  readonly spec?: {
    op: string;
    params?: unknown;
    inputs?: unknown;
  };
  readonly select?: Select;
  readonly reason: string;
  /**
   * The failure's kind — {@link ProcessError.code}, e.g.
   * `'UnknownColumnError'`. Absent when the throw did not come from this
   * package, which is itself the useful signal: op code failed, not the
   * plan layer.
   *
   * `reason` is prose for a human and its wording is not a contract.
   * Under `onError: 'skip' | 'collect'` nothing is thrown, so without
   * this a consumer branching on the kind — a dropped feed column is a
   * dimmed, removable chip; a bad persisted param is a broken one — was
   * left matching on that prose (Tidal,
   * `docs/notes/tidal-process-adoption-friction-2026-08.md`).
   */
  readonly code?: string;
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

  // First slot wins. Two slots may legally resolve to ONE id — the
  // registry-free builder cannot canonicalize defaults, so `shape()`
  // and `shape({points: 40})` arrive as two slots naming the same
  // computation. Attribution must not depend on which happened to be
  // declared last; "the first slot to name it labels it" is the rule.
  const slotOf = new Map<string, string>();
  for (const [slot, spec] of expanded) {
    const id = specId(graph.registry, spec);
    if (!slotOf.has(id)) slotOf.set(id, slot);
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

/**
 * The `reason` and `code` a caught throw contributes to a {@link Skipped}.
 *
 * One place, so every failure path reports its kind the same way — the
 * column loop and the fact loop already diverged once on `onError`
 * itself, which is the argument for not writing this twice.
 */
function describe(e: unknown): { reason: string; code?: string } {
  return {
    reason: e instanceof Error ? e.message : String(e),
    ...(e instanceof ProcessError && { code: e.code }),
  };
}

export function run(graph: BoundGraph, request: RunRequest): RunResult {
  const { onError = 'throw', assemble = true } = request;
  const registry = graph.registry;
  const skipped: Skipped[] = [];
  const resolved: { id: string; spec: Spec }[] = [];

  // Slot expansion happens before anything resolves, so its failures
  // used to escape the error policy entirely — a mistyped input came
  // back as a thrown 500 rather than a `skipped` reason an agent could
  // read and retry against. Every other class of bad plan is
  // collectable; there was no argument for this one being different.
  let normalized: ReturnType<typeof normalize>;
  try {
    normalized = normalize(graph, request);
  } catch (e) {
    if (onError === 'throw') throw e;
    return {
      outputs: {},
      facts: [],
      explain: {},
      skipped: [describe(e)],
      nodes: [],
    };
  }
  const { plan, select, slotOf } = normalized;

  /**
   * Reports a failure, or rethrows it — the ORIGINAL error, not a
   * reconstruction.
   *
   * Rebuilding it as a base `ProcessError` from `entry.reason` erased the
   * class on the default policy: `graph.compile` threw
   * `UnknownColumnError` and `run` turned it into a `ProcessError`, so a
   * consumer catching could not branch on the very class this PR added,
   * and the documented "`code` matches what a throw would have carried"
   * was false in one direction (Codex, PR #667).
   */
  const fail = (error: unknown, entry: Omit<Skipped, 'reason' | 'code'>) => {
    if (onError === 'throw') throw error;
    skipped.push({ ...entry, ...describe(error) });
  };

  // ── resolve the plan ───────────────────────────────────────
  for (const spec of plan) {
    try {
      const compiled = graph.compile(spec);
      resolved.push({ id: compiled.id, spec });
    } catch (e) {
      fail(e, {
        spec: { op: spec.op, params: spec.params, inputs: spec.inputs },
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
      fail(e, { select: sel });
      continue;
    }
    selectors.push({ sel, id });
    // Surfacing a column-producing node means surfacing its columns.
    // There is no longer a `columns: true` to opt into, because what a
    // selector yields is decided by the node it points at.
    const compiled = graph.get(id);
    const isFoldNode = compiled?.fold === true;
    if (!isFoldNode) needed.set(id, true);
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
      const upId = refToId(registry, specOf(input));
      warm(upId);
      return upId;
    });
    const declared = registry.outputsOf(registry.get(compiled.spec.op));
    const wasDirty = compiled.node.dirty;
    const t0 = performance.now();
    // A fold is pulled exactly like a column node — same memo, same
    // version check. That equivalence is the point of [PND-PROCFOLD]:
    // the badge row now covers the part callers actually read.
    if (compiled.fold) graph.factOf(compiled);
    else graph.columnOf(compiled, declared[0]!.id);
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
      const upId = refToId(registry, specOf(input));
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

  // ── resolve the surfaced columns, and assemble only if asked ───
  if (needed.size > 0) {
    drawn = {};
    if (assemble) assembled = graph.series;
    for (const [id, report] of needed) {
      const compiled = graph.get(id);
      if (compiled === undefined) continue;
      const cols = columnsOf(registry, compiled.spec, id);
      if (report) outputs[id] = [];
      const selections = selectors.filter((selection) => selection.id === id);
      for (const { sel } of selections) {
        const declared = registry.outputsOf(registry.get(compiled.spec.op));
        // A selector naming an output the node does not declare used to
        // filter every iteration below and surface NOTHING — no columns,
        // no error, no `skipped` entry. Silent is the worst of the three.
        if (
          sel.output !== undefined &&
          !declared.some((o) => o.id === sel.output)
        ) {
          const have = declared.map((o) => `'${o.id}'`).join(', ');
          // Built here rather than caught, so the kind is stated rather
          // than derived — a `Skipped` from the plan layer always
          // carries one, and the throw policy raises the same object.
          fail(
            new ProcessError(
              `'${compiled.spec.op}' has no output '${sel.output}' (has ${have})`,
            ),
            { select: sel },
          );
          continue;
        }
        // Pulling a column runs op code, which can throw like anything
        // else a request does — so it answers to the same error policy
        // the fact loop already honours. Under 'throw' the original
        // error propagates untouched.
        try {
          declared.forEach((o, n) => {
            if (sel.output !== undefined && o.id !== sel.output) return;
            const columnName = cols[n]!;
            const col = columnFor(id, o.id);
            // Several selectors may surface the same node or column under
            // different caller names. Report every selection, but materialize
            // each physical column once.
            if (drawn![columnName] === undefined) {
              drawn![columnName] = col;
              if (assemble)
                assembled = appendColumn(assembled!, columnName, col);
            }
            if (report) {
              outputs[id]!.push({
                column: columnName,
                unit: unitOf(registry, compiled.spec, graph.units, n),
                ...(sel.name !== undefined && { name: sel.name }),
              });
            }
          });
        } catch (e) {
          fail(e, { select: sel });
        }
      }
    }
  }

  // ── facts are pulled from fold nodes, like any other value ──
  const facts: Fact[] = [];
  for (const { sel, id } of selectors) {
    const compiled = graph.get(id);
    if (compiled === undefined) {
      fail(new ProcessError(`'${id}' is not in this plan`), { select: sel });
      continue;
    }
    if (!compiled.fold) continue;
    try {
      warm(id);
      // Provenance wins. The body is spread FIRST and its reserved keys
      // are dropped, so a custom fold cannot masquerade as another node,
      // rename an output the caller did not, or forge a unit — `id`,
      // `name`, `op` and `unit` always mean what the graph says.
      const body: Record<string, unknown> = { ...graph.factOf(compiled) };
      for (const key of ['id', 'name', 'op', 'unit']) delete body[key];
      facts.push({
        ...body,
        id,
        ...(sel.name !== undefined && { name: sel.name }),
        op: compiled.spec.op,
        unit: unitOf(registry, compiled.spec, graph.units),
      });
    } catch (e) {
      fail(e, { select: sel });
    }
  }

  // Anything the plan resolved but nothing selected. After the pulls, so
  // a node that *was* read keeps its timing rather than being shadowed.
  for (const { id } of resolved) record(id);

  // The budget is enforced once the run has resolved, not during it:
  // evicting a node this run is about to read would only recompile it.
  graph.enforceBudget();

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
