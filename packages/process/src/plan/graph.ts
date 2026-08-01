/**
 * `bind` and plan compilation — [PND-DEMOM0].
 *
 * A **bound graph** is one source plus the nodes compiled against it.
 * Identity is scoped to the binding, which is what makes `specId` safe as
 * a cache key: the id names the computation, not the data, so two
 * instruments sharing one id-space would answer for each other. One
 * graph per binding; hosts own graph lifecycle, the graph owns
 * memoization.
 */

import {
  appendColumn,
  columnBytes,
  columnView,
  packColumn,
  prepareRange,
  sealRange,
  type RangeOutput,
  type ColumnView,
} from '../column.js';
import { ProcessError } from '../errors.js';
import { defineNode, type Node } from '../node.js';
import { port } from '../types.js';
import { source, type SourceNode } from '../source.js';
import type { Column, SeriesSchema, TimeSeries } from 'pond-ts';
import { requiredHistory } from './history.js';
import { columnsOf, specId, unitOf } from './identity.js';
import type { Registry } from './registry.js';
import {
  isFold,
  isPicked,
  specOf,
  type FactBody,
  type OpDef,
  type Params,
  type Spec,
  type Units,
} from './types.js';

/** Thrown when an op demands an input unit its source does not carry. */
export class UnitError extends ProcessError {}

/** The per-output key a node's outlets are addressed by. */
function outletKey(output: { id: string }): string {
  return output.id === '' ? 'value' : output.id;
}

/** Normalizes an op's return into one column per declared output. */
function toColumns(
  op: OpDef,
  id: string,
  length: number,
  result: unknown,
): Column[] {
  const list =
    Array.isArray(result) && op.outputs.length > 1 ? result : [result];
  if (list.length !== op.outputs.length) {
    throw new ProcessError(
      `op '${op.name}' declares ${op.outputs.length} output(s) but returned ${list.length} for '${id}'`,
    );
  }
  return list.map((v, n) => {
    // A Column is already packed; loose values are packed once here
    // rather than retained boxed ([PND-PROCCOL]).
    const column =
      v !== null && typeof v === 'object' && 'kind' in (v as object)
        ? (v as Column)
        : packColumn(v as ArrayLike<number | undefined>);
    // Every output must match the bound series row-for-row — a warm-up
    // is expressed as gaps, never as a shorter column. Checked here, at
    // the producer, because the only other thing that catches it is
    // assembly's own length check, and `assemble: false` skips assembly:
    // a one-row result from a three-row source came back as a success.
    if (column.length !== length) {
      throw new ProcessError(
        `op '${op.name}' returned ${column.length} row(s) for output '${outletKey(op.outputs[n]!)}' of '${id}', expected ${length} — an output must match the bound series length, with warm-up as gaps`,
      );
    }
    return column;
  });
}

/** One node per spec, plus the spec and params it was compiled from. */
interface Compiled {
  readonly id: string;
  readonly spec: Spec;
  readonly params: Params;
  readonly node: Node<any, any>;
  readonly outlets: Readonly<Record<string, string>>;
  /** True when the node ends in a fact. Its `outlets` are then empty. */
  readonly fold: boolean;
  /** Ids this node reads from — for unwinding a chain on eviction. */
  readonly upstream: readonly string[];
  /** Ids reading from this node. Non-empty ⇒ evicting it frees nothing. */
  readonly dependents: Set<string>;
}

/** The outlet a fold's fact arrives on. Not a column, so not in `outlets`. */
const FACT = 'fact';

/** Reads a column into a dense array — done once per version, inside the memo. */
function densify(column: Column): (number | undefined)[] {
  const out = new Array<number | undefined>(column.length).fill(undefined);
  const anyCol = column as unknown as { at(i: number): number | undefined };
  for (let i = 0; i < column.length; i += 1) {
    const v = anyCol.at(i);
    if (v !== undefined && !Number.isNaN(v)) out[i] = v;
  }
  return out;
}

/**
 * A source plus every node compiled against it.
 *
 * ## The budget — [PND-PROCCACHE]
 *
 * Every distinct spec ever compiled used to be retained forever, so
 * memory scaled with *questions asked* rather than with anything
 * bounded. A session that walks a slider from period 20 to 200 leaves
 * 180 nodes holding 180 result columns, and nothing ever drops one.
 *
 * The ticket framed this as an op-level cache: an op declares which of
 * its inputs key a result, and the engine memoizes around `compute`.
 * **Half of that is already true here and should not be rebuilt.** A
 * spec's `specId` is content-addressed over its op, params and inputs,
 * so asking the same question twice hits the same node by construction —
 * there is nothing for an op to declare, and a per-op cache would be a
 * second key beside a correct one.
 *
 * What was genuinely missing is the other half, and the ticket is right
 * that it does not belong to the op: **a per-op capacity is a per-op
 * promise, and nothing supervises the total.** Measured at 20 nodes ×
 * 5 entries of a 200k-row result, a per-op cap held 100 entries and
 * 157 MB where one engine-wide cap held 10 and 35 MB.
 *
 * So the budget is graph-wide, in **bytes** rather than entries — the
 * unit that means anything, and only knowable since [PND-PROCCOL] made
 * node values columns with a reportable `columnBytes`. Eviction is LRU
 * with one constraint: a node feeding a retained node is skipped,
 * because dropping it frees nothing while its consumer still holds the
 * outlet.
 */
export class BoundGraph {
  readonly registry: Registry;
  readonly units: Units;
  readonly #source: SourceNode<TimeSeries<SeriesSchema>>;
  readonly #nodes = new Map<string, Compiled>();
  /** Insertion order is LRU order: a touch deletes and re-adds. */
  readonly #lru = new Set<string>();
  readonly #budgetBytes: number;
  #evicted = 0;
  /**
   * First changed row still owed to each node, by id.
   *
   * Per node, not graph-wide, and accumulated as a running **minimum**
   * until that node actually recomputes. A single global marker is wrong
   * because nodes compute lazily: one that is not pulled at V1 and is
   * pulled at V2 would patch its V0 output using V2's boundary and skip
   * everything V1 changed — silently, since the result is still defined.
   * Found by a Codex pass on PR #571, with a repro: rows 20–22 kept
   * `[57,60,63]` where a from-scratch pass gave `[1036,1039,1042]`.
   */
  readonly #pendingFrom = new Map<string, number>();
  /** Nodes owed a whole recompute, which no partial claim can downgrade. */
  readonly #fullDirty = new Set<string>();
  /** Ranged recomputes and full ones, for tests and for `explain`. */
  #ranged = 0;
  #full = 0;

  constructor(
    series: TimeSeries<SeriesSchema>,
    options: { registry: Registry; units?: Units; budgetBytes?: number },
  ) {
    this.registry = options.registry;
    this.units = options.units ?? {};
    this.#budgetBytes = options.budgetBytes ?? Number.POSITIVE_INFINITY;
    this.#source = source({ initial: series, kind: 'source' });
  }

  /** Bytes currently retained across every materialized node value. */
  get retainedBytes(): number {
    let total = 0;
    for (const c of this.#nodes.values()) total += this.#bytesOf(c);
    return total;
  }

  /**
   * A node's retained bytes, read from its ports rather than from a
   * field written when a value happens to be surfaced.
   *
   * Caching this in `columnOf` left an escape hatch: pulling a value
   * through `compile(spec).node.out[…].get()` materialized a column that
   * the budget could not see, so `retainedBytes` reported 0 while the
   * memory was real (Codex, PR #571). `peek()` never forces a compute,
   * so asking every node is cheap and cannot itself cause work.
   */
  #bytesOf(compiled: Compiled): number {
    let total = 0;
    for (const outlet of Object.values(compiled.outlets)) {
      const held = (
        compiled.node.out[outlet] as { peek?(): Column | undefined }
      ).peek?.();
      if (held !== undefined) total += columnBytes(held);
    }
    return total;
  }

  /** How many nodes the budget has dropped over this graph's life. */
  get evictions(): number {
    return this.#evicted;
  }

  /**
   * Recomputes that ran ranged, and that ran whole — [PND-PROCRANGE].
   *
   * Worth having as a counter rather than inferring it from timings: a
   * node silently falling back to a full recompute is the failure mode
   * here, and it looks exactly like "the optimisation did not help much".
   */
  get recomputes(): { ranged: number; full: number } {
    return { ranged: this.#ranged, full: this.#full };
  }

  /** Rows still owed per node, for tests and for `explain`. */
  get pendingFrom(): ReadonlyMap<string, number> {
    return this.#pendingFrom;
  }

  /**
   * Drops least-recently-used nodes until the graph is inside its byte
   * budget. Called after a run resolves; safe to call at any time.
   *
   * A node that feeds a retained node is skipped — its consumer holds
   * the outlet, so dropping the lookup frees nothing and would only
   * force a recompile on the next pull.
   */
  enforceBudget(): void {
    if (!Number.isFinite(this.#budgetBytes)) return;
    let total = this.retainedBytes;
    // Repeat until a whole pass frees nothing. Evicting a consumer
    // unpins its inputs, and a single pass over a snapshot of the LRU
    // has already walked past them — so a two-node chain under a 1-byte
    // budget kept 8,000 bytes and reported success (Codex, PR #571). The
    // loop terminates because every iteration that continues has evicted
    // at least one node, and nodes are finite.
    let progress = true;
    while (progress && total > this.#budgetBytes) {
      progress = false;
      for (const id of [...this.#lru]) {
        if (total <= this.#budgetBytes) break;
        const compiled = this.#nodes.get(id);
        if (compiled === undefined) continue;
        if (compiled.dependents.size > 0) continue;
        total -= this.#bytesOf(compiled);
        // Dropping the lookup is not eviction. `Outlet.#downstream` is a
        // strong `Set<Inlet>` and `Inlet.node` points back, so a node
        // left connected stays reachable from the source forever —
        // `#nodes.delete` alone freed NOTHING, and re-asking an evicted
        // spec compiled a second node onto the same source, so churn grew
        // memory without bound while `ids.length` stayed flat. Found by a
        // Layer 2 review of PR #571.
        for (const inlet of Object.values(
          compiled.node.in as Record<string, { disconnect(): unknown }>,
        )) {
          inlet.disconnect();
        }
        this.#nodes.delete(id);
        this.#lru.delete(id);
        this.#pendingFrom.delete(id);
        this.#fullDirty.delete(id);
        this.#evicted += 1;
        progress = true;
        // Its inputs may now be evictable in turn — the chain unwinds
        // from the consumer end, which is the only end that frees
        // anything.
        for (const upstream of compiled.upstream) {
          this.#nodes.get(upstream)?.dependents.delete(id);
        }
      }
    }
  }

  #touch(id: string): void {
    this.#lru.delete(id);
    this.#lru.add(id);
  }

  /** Replaces the bound data. Every node downstream goes dirty. */
  setSource(series: TimeSeries<SeriesSchema>): void {
    // "No claim", owed to every node — and it DOMINATES any later partial
    // claim. If a node misses a full replacement and is then handed a
    // `setSourceFrom`, it must still recompute wholly: the rows before
    // that boundary changed too, and nothing remembers by how much.
    for (const id of this.#nodes.keys()) {
      this.#fullDirty.add(id);
      this.#pendingFrom.delete(id);
    }
    this.#source.set(series);
  }

  /**
   * Replaces the bound data, declaring that rows before `changedFrom`
   * are unchanged — [PND-PROCRANGE].
   *
   * This is the whole input to ranged recompute: a node that declares a
   * `lookback` and a `runRange` then rebuilds only
   * `[changedFrom - lookback, length)` instead of the whole column.
   *
   * **The claim is the caller's to keep.** Nothing here verifies that
   * the earlier rows really are untouched, because verifying costs the
   * scan the whole feature exists to avoid. Pass a row that is genuinely
   * at or before the first difference — a live feed appending a bar
   * passes the old length, which is the case this is built for. Getting
   * it wrong yields a stale prefix rather than an error, so when in
   * doubt use {@link setSource}, which recomputes everything.
   */
  setSourceFrom(series: TimeSeries<SeriesSchema>, changedFrom: number): void {
    const from = Math.max(0, Math.floor(changedFrom));
    for (const id of this.#nodes.keys()) {
      if (this.#fullDirty.has(id)) continue; // a full dirty outranks this
      const owed = this.#pendingFrom.get(id);
      this.#pendingFrom.set(
        id,
        owed === undefined ? from : Math.min(owed, from),
      );
    }
    this.#source.set(series);
  }

  /**
   * The row a node must recompute from, and clears the debt.
   *
   * `undefined` means "no claim was made", which forces a full recompute
   * — the safe answer, and what a freshly compiled node gets.
   */
  #takePending(id: string): number | undefined {
    const owed = this.#pendingFrom.get(id);
    this.#pendingFrom.delete(id);
    if (this.#fullDirty.delete(id)) return undefined;
    return owed;
  }

  get series(): TimeSeries<SeriesSchema> {
    return this.#source.out.value.get();
  }

  /** Ids currently compiled. Node lifetime is a budget question — see [PND-PROCCACHE]. */
  get ids(): string[] {
    return [...this.#nodes.keys()];
  }

  get(id: string): Compiled | undefined {
    const hit = this.#nodes.get(id);
    if (hit !== undefined) this.#touch(id);
    return hit;
  }

  /**
   * Compiles a spec (and its inputs) into nodes, memoized by `specId`.
   *
   * **A returned handle is not durable under a byte budget.** Eviction
   * disconnects a node's inlets, so a `Compiled` held across a `run` can
   * throw `UnconnectedInputError` on a later pull, naming the input
   * rather than the budget that took it. `run` re-resolves through
   * `columnOf` and never hits this; a caller holding its own handle
   * should re-`compile` after any run, which is a memoized lookup when
   * the node survived. Only relevant with `budgetBytes` set — without
   * one, nothing is ever evicted.
   *
   * Validation happens here rather than at pull time so a bad plan is
   * rejected before any work: params first, then arity, then the typed
   * input check.
   */
  compile(spec: Spec): Compiled {
    const id = specId(this.registry, spec);
    const existing = this.#nodes.get(id);
    if (existing) {
      this.#touch(id);
      return existing;
    }

    const op = this.registry.get(spec.op);
    const params = this.registry.resolveParams(op, spec.params);

    if (spec.inputs.length !== op.inputs.length) {
      throw new ProcessError(
        `${spec.op} takes ${op.inputs.length} input(s), got ${spec.inputs.length}`,
      );
    }

    // Typed inputs: an op may demand a unit its source must already
    // carry. Checked before compiling so the reason names both sides.
    op.inputs.forEach((def, i) => {
      if (def.unit === undefined) return;
      const raw = spec.inputs[i]!;
      let got: string | null;
      if (typeof raw === 'string') {
        got = this.units[raw] ?? null;
      } else {
        // The unit of the output actually picked, not output 0. Dropping
        // the pick failed both ways: a picked `variance` was refused by
        // an op requiring variance, and accepted by one requiring price —
        // the second silently, which is the worse half. An output name
        // the upstream op does not declare defers to the binding pass
        // below, whose error names both sides.
        const from = specOf(raw);
        const declaredUp = this.registry.outputsOf(this.registry.get(from.op));
        const index = isPicked(raw)
          ? declaredUp.findIndex((o) => o.id === raw.output)
          : 0;
        if (isPicked(raw) && index === -1) return;
        got = unitOf(this.registry, from, this.units, index);
      }
      if (got !== def.unit) {
        const name =
          typeof raw === 'string'
            ? raw
            : specId(this.registry, specOf(raw)) +
              (isPicked(raw) ? `#${raw.output}` : '');
        throw new UnitError(
          `${spec.op} needs a '${def.unit}' input for '${def.role}', but '${name}' is '${got ?? 'unitless'}'`,
        );
      }
    });

    // Bind each input: a raw column reads off the source; a nested spec
    // reads its upstream node's first output.
    const bound = spec.inputs.map((raw, i) => {
      const role = op.inputs[i]!.role;
      if (typeof raw === 'string') {
        return { role, column: raw, outlet: undefined, nested: false as const };
      }
      // A fold ends in a fact, so it has nothing to hand onward. Caught
      // here rather than at pull time, and named on both sides, because
      // a caller composing from the schema has no other way to learn it.
      const from = specOf(raw);
      const upstreamDef = this.registry.get(from.op);
      if (isFold(upstreamDef)) {
        throw new ProcessError(
          `'${from.op}' produces a fact, not a series, so it cannot be the '${role}' input of '${spec.op}' — surface it in outputs instead`,
        );
      }
      const declaredUp = upstreamDef.outputs;
      const index = isPicked(raw)
        ? declaredUp.findIndex((o) => o.id === raw.output)
        : 0;
      if (index === -1) {
        const have = declaredUp.map((o) => `'${o.id}'`).join(', ');
        throw new ProcessError(
          `'${from.op}' has no output '${(raw as { output: string }).output}' (has ${have})`,
        );
      }
      const upstream = this.compile(from);
      const column = columnsOf(this.registry, from, upstream.id)[index]!;
      const key = outletKey(declaredUp[index]!);
      return {
        role,
        column,
        outlet: upstream.node.out[key] as { get(): Column },
        nested: true as const,
        upstreamId: upstream.id,
      };
    });

    const inlets: Record<string, any> = { src: this.#source.out.value };
    bound.forEach((b, i) => {
      if (b.nested) inlets[`in${i}`] = b.outlet;
    });

    const terminal = isFold(op);
    const declared = this.registry.outputsOf(op);
    const outputs = terminal
      ? { [FACT]: port<FactBody>() }
      : Object.fromEntries(declared.map((o) => [outletKey(o), port<Column>()]));

    // `undefined` when any op in this chain declares no lookback, which
    // is what disables ranging for it — the boundary is unknowable.
    const history = requiredHistory(this.registry, [spec]);
    const chainLookback = history.known ? history.rows : undefined;

    // The node's last output, held by the GRAPH and handed to `runRange`
    // as an argument. That split is the design: the graph is a cache and
    // was already stateful, while the op stays a pure function — of more
    // things than before, but declared ones, so `explain` still describes
    // what a value depends on.
    let previous: Column[] | undefined;

    const factory = defineNode({
      kind: spec.op,
      inputs: Object.fromEntries(
        Object.keys(inlets).map((k) => [k, port<any>()]),
      ),
      outputs,
      compute: (vals: Record<string, any>) => {
        const src = vals['src'] as TimeSeries<SeriesSchema>;
        const inputsByRole = Object.fromEntries(
          bound.map((b) => [b.role, b.column]),
        );
        if (isFold(op)) {
          // A fold reads columns; it never needs a series ([PND-PROCTERM]).
          //
          // Every node used to widen the source with `appendColumn` for
          // each nested input, so an op could call the corpus normally —
          // the studies take `(series, { column })`. For a fold that was
          // pure waste twice over: the column it wants is already sitting
          // in `vals`, and it was being packed into a `TimeSeries` only to
          // be read straight back out. Worse, `appendColumn` boxes a
          // GAPPED column on the way in (core's `withColumn` takes values,
          // not a column), which is 22.4 ms at 1M rows — and every rolling
          // study is gapped, so the expensive path was the common one.
          const columnOfRole = new Map<string, Column>(
            bound.map((b, i) => [
              b.role,
              b.nested
                ? (vals[`in${i}`] as Column)
                : (src.column(
                    b.column as Parameters<
                      TimeSeries<SeriesSchema>['column']
                    >[0],
                  ) as unknown as Column),
            ]),
          );
          // Both accessors resolve inside the memo, so whatever a fold
          // reads is prepared once per version rather than once per
          // request. The difference is what "prepared" costs.
          //
          // `numeric` is a zero-copy view: no allocation at any length.
          // `values` densifies into a boxed array and is therefore LAZY —
          // a getter per role, memoized — because it was the graph's
          // largest heap cost and `latest`, which reads a single cell,
          // was paying for 500,000 of them ([PND-PROCCOL]).
          const views = new Map<string, ColumnView | undefined>();
          const numeric = (role: string): ColumnView | undefined => {
            if (views.has(role)) return views.get(role);
            const col = columnOfRole.get(role);
            const view = col === undefined ? undefined : columnView(col);
            views.set(role, view);
            return view;
          };
          const values: Record<string, readonly (number | undefined)[]> = {};
          const densified = new Map<string, readonly (number | undefined)[]>();
          for (const b of bound) {
            Object.defineProperty(values, b.role, {
              enumerable: true,
              get: () => {
                let dense = densified.get(b.role);
                if (dense === undefined) {
                  dense = densify(columnOfRole.get(b.role)!);
                  densified.set(b.role, dense);
                }
                return dense;
              },
            });
          }
          // The source's key column, not a widened copy's — appending a
          // value column never changes it.
          const keyColumn = src.keyColumn() as unknown as {
            at(i: number): number;
          };
          return {
            [FACT]: op.fold({
              values,
              numeric,
              at: (i) => keyColumn.at(i),
              params,
              id,
            }),
          };
        }
        // Only a column-producing op needs the widened series, because the
        // corpus studies take `(series, { column })`.
        let series = src;
        bound.forEach((b, i) => {
          if (b.nested) {
            series = appendColumn(series, b.column, vals[`in${i}`] as Column);
          }
        });
        const ctx = { series, inputs: inputsByRole, params, id };

        // Ranged, or whole? Four things must hold, and any one missing
        // falls back to a full recompute — which is always correct and
        // merely slower ([PND-PROCRANGE]).
        //
        //   1. the caller declared which row changed (`setSourceFrom`),
        //   2. this op opted in with `runRange` — meaning it claims a
        //      patched result is bit-identical to a from-scratch one,
        //   3. it declared a `lookback`, which is what widens an upstream
        //      dirty range into this node's,
        //   4. there is a previous output to patch.
        //
        // The lookback is the ACCUMULATED one down this spec's whole
        // input chain, not this node's own. Using its own is wrong for a
        // non-causal chain: with `win(5)` over `win(30)`, a change at row
        // 70 reaches the outer node's row 37, but its own lookback only
        // walks back to 66. Found by a Codex pass on PR #571, which
        // produced exactly that — incremental 70, from-scratch 999. The
        // trailing-window tests all passed because a trailing change
        // propagates forward, where `to = length` already covers it.
        //
        // `requiredHistory` over this one spec is precisely that sum, so
        // the two tickets compose rather than each carrying their own
        // arithmetic.
        const changedFrom = this.#takePending(id);
        // Ranged, or whole? Every precondition below must hold, and any
        // one missing falls back to a full recompute — always correct,
        // merely slower ([PND-PROCRANGE]).
        const from =
          changedFrom === undefined || chainLookback === undefined
            ? undefined
            : Math.max(0, changedFrom - chainLookback);
        const to = series.length;
        // A prefix that cannot be VIEWED cannot be carried. `columnView`
        // declines anything not packed numeric — a chunked column, say —
        // and preparing from `undefined` seals `[0, from)` as ALL MISSING
        // and returns it as an answer: 16 of 21 cells wrong, no error
        // raised (Layer 2, PR #573). Every other precondition here falls
        // back; this one must too. Silence is the bug, not slowness.
        const views =
          from === undefined || previous === undefined
            ? undefined
            : previous.map((c) => columnView(c));
        const rangeable =
          from !== undefined &&
          op.runRange !== undefined &&
          previous !== undefined &&
          views !== undefined &&
          (from === 0 || views.every((v) => v !== undefined));

        let columns: Column[];
        if (rangeable) {
          const priors = views;
          // `out` is LAZY, and that does two jobs. A return-style
          // `runRange` never touches it, so it stops paying to prepare
          // and copy a prefix per output that is then discarded. And
          // touching an entry is the op's statement of intent, which is
          // what lets a partial write be caught below instead of
          // silently shipping.
          const prepared = new Array<RangeOutput | undefined>(
            op.outputs.length,
          );
          const out: RangeOutput[] = [];
          op.outputs.forEach((_, n) => {
            Object.defineProperty(out, n, {
              enumerable: true,
              configurable: true,
              get: () => (prepared[n] ??= prepareRange(to, from, priors[n])),
            });
          });
          out.length = op.outputs.length;
          const produced = op.runRange({
            ...ctx,
            from,
            to,
            previous: previous as readonly Column[],
            previousView: priors,
            out,
          });
          // Returning nothing means "written into `ctx.out`" — the path
          // that carries the prefix as a block. An op may still return a
          // whole result, which is simply the slower way to say it.
          if (produced === undefined || produced === null) {
            // Every declared output must have been written. Sealing an
            // untouched buffer produces a column that keeps its prefix
            // and reports the new rows as MISSING — a plausible, silent,
            // incomplete answer (Codex, PR #573). An op that writes
            // `out[0]` of three declared outputs is a contract error, so
            // it is one here rather than a wrong number downstream.
            const missing = op.outputs
              .map((o, n) => (prepared[n] === undefined ? o.id || `${n}` : ''))
              .filter(Boolean);
            if (missing.length > 0) {
              throw new ProcessError(
                `op '${spec.op}' wrote no ranged output for ${missing
                  .map((m) => `'${m}'`)
                  .join(', ')} — a \`runRange\` that returns nothing must ` +
                  `write every declared output through \`ctx.out\`, or ` +
                  `return a whole result instead`,
              );
            }
            columns = prepared.map(
              (o) => sealRange(o!, to) as unknown as Column,
            );
          } else {
            // The same length contract as a whole result: a ranged op
            // that returns a short column is as wrong as a full one.
            // (The `ctx.out` path above is exact by construction —
            // `sealRange(…, to)` cannot produce another length.)
            columns = toColumns(op, id, to, produced);
          }
          this.#ranged += 1;
        } else {
          columns = toColumns(op, id, series.length, op.run(ctx));
          this.#full += 1;
        }
        previous = columns;
        return Object.fromEntries(
          op.outputs.map((o, n) => [outletKey(o), columns[n]!]),
        );
      },
    });

    const node = factory();
    for (const [key, outlet] of Object.entries(inlets)) {
      (outlet as { connect(i: unknown): void }).connect(node.in[key]);
    }

    const upstream = bound
      .filter((b) => b.nested)
      .map((b) => (b as { upstreamId: string }).upstreamId);
    const compiled: Compiled = {
      id,
      spec,
      params,
      node,
      fold: terminal,
      outlets: Object.fromEntries(declared.map((o) => [o.id, outletKey(o)])),
      upstream,
      dependents: new Set<string>(),
    };
    for (const up of upstream) this.#nodes.get(up)?.dependents.add(id);
    this.#nodes.set(id, compiled);
    this.#touch(id);
    return compiled;
  }

  /** Reads one output column of a compiled spec, by output suffix. */
  columnOf(compiled: Compiled, suffix: string): Column {
    const key = compiled.outlets[suffix];
    if (key === undefined) {
      const have = Object.keys(compiled.outlets)
        .map((s) => `'${s}'`)
        .join(', ');
      throw new ProcessError(
        compiled.fold
          ? `'${compiled.spec.op}' is a fold — it produces a fact, not columns`
          : `'${compiled.spec.op}' has no output '${suffix}' (has ${have})`,
      );
    }
    return (compiled.node.out[key] as { get(): Column }).get();
  }

  /**
   * Reads a fold's fact.
   *
   * The same memoized pull `columnOf` does, which is the whole change:
   * the value is cached against the node's version like any column, so
   * asking twice costs a version check rather than a rescan.
   */
  factOf(compiled: Compiled): FactBody {
    if (!compiled.fold) {
      throw new ProcessError(
        `'${compiled.spec.op}' produces columns, not a fact`,
      );
    }
    return (compiled.node.out[FACT] as { get(): FactBody }).get();
  }
}

/**
 * Binds a dataset, producing a graph its plans resolve against.
 *
 * One graph per data binding — two instruments get two graphs and share
 * no nodes, even though their specs produce identical ids.
 */
export function bind(
  series: TimeSeries<SeriesSchema>,
  options: {
    registry: Registry;
    units?: Units;
    /**
     * Cap on retained node values, in bytes — [PND-PROCCACHE]. Unbounded
     * when omitted, which is the behaviour every existing caller has.
     *
     * Bytes rather than entries because entries are not the unit anyone
     * has a limit in: one node over 1M rows outweighs fifty over 5,000.
     * Enforced after each `run`, LRU, skipping any node whose consumer
     * still holds its outlet.
     */
    budgetBytes?: number;
  },
): BoundGraph {
  return new BoundGraph(series, options);
}
