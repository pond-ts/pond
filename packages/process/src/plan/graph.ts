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
  columnView,
  packColumn,
  type ColumnView,
} from '../column.js';
import { ProcessError } from '../errors.js';
import { defineNode, type Node } from '../node.js';
import { port } from '../types.js';
import { source, type SourceNode } from '../source.js';
import type { Column, SeriesSchema, TimeSeries } from 'pond-ts';
import { columnsOf, specId } from './identity.js';
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
function toColumns(op: OpDef, id: string, result: unknown): Column[] {
  const list =
    Array.isArray(result) && op.outputs.length > 1 ? result : [result];
  if (list.length !== op.outputs.length) {
    throw new ProcessError(
      `op '${op.name}' declares ${op.outputs.length} output(s) but returned ${list.length} for '${id}'`,
    );
  }
  return list.map((v) => {
    // A Column is already packed; loose values are packed once here
    // rather than retained boxed ([PND-PROCCOL]).
    if (v !== null && typeof v === 'object' && 'kind' in (v as object)) {
      return v as Column;
    }
    return packColumn(v as ArrayLike<number | undefined>);
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

/** A source plus every node compiled against it. */
export class BoundGraph {
  readonly registry: Registry;
  readonly units: Units;
  readonly #source: SourceNode<TimeSeries<SeriesSchema>>;
  readonly #nodes = new Map<string, Compiled>();

  constructor(
    series: TimeSeries<SeriesSchema>,
    options: { registry: Registry; units?: Units },
  ) {
    this.registry = options.registry;
    this.units = options.units ?? {};
    this.#source = source({ initial: series, kind: 'source' });
  }

  /** Replaces the bound data. Every node downstream goes dirty. */
  setSource(series: TimeSeries<SeriesSchema>): void {
    this.#source.set(series);
  }

  get series(): TimeSeries<SeriesSchema> {
    return this.#source.out.value.get();
  }

  /** Ids currently compiled. Node lifetime is a budget question — see [PND-PROCCACHE]. */
  get ids(): string[] {
    return [...this.#nodes.keys()];
  }

  get(id: string): Compiled | undefined {
    return this.#nodes.get(id);
  }

  /**
   * Compiles a spec (and its inputs) into nodes, memoized by `specId`.
   *
   * Validation happens here rather than at pull time so a bad plan is
   * rejected before any work: params first, then arity, then the typed
   * input check.
   */
  compile(spec: Spec): Compiled {
    const id = specId(this.registry, spec);
    const existing = this.#nodes.get(id);
    if (existing) return existing;

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
      const got =
        typeof raw === 'string'
          ? (this.units[raw] ?? null)
          : unitOfCompiled(this.registry, specOf(raw), this.units);
      if (got !== def.unit) {
        const name =
          typeof raw === 'string' ? raw : specId(this.registry, specOf(raw));
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
        const produced = op.run({ series, inputs: inputsByRole, params, id });
        const columns = toColumns(op, id, produced);
        return Object.fromEntries(
          op.outputs.map((o, n) => [outletKey(o), columns[n]!]),
        );
      },
    });

    const node = factory();
    for (const [key, outlet] of Object.entries(inlets)) {
      (outlet as { connect(i: unknown): void }).connect(node.in[key]);
    }

    const compiled: Compiled = {
      id,
      spec,
      params,
      node,
      fold: terminal,
      outlets: Object.fromEntries(declared.map((o) => [o.id, outletKey(o)])),
    };
    this.#nodes.set(id, compiled);
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

/** Unit fold that does not require the spec to be compiled yet. */
function unitOfCompiled(
  registry: Registry,
  spec: Spec,
  units: Units,
): string | null {
  const op = registry.get(spec.op);
  const declared = isFold(op) ? op.unit : (op.outputs[0]?.unit ?? 'inherit');
  if (declared !== 'inherit') return declared;
  const src = spec.inputs[0];
  if (src === undefined) return null;
  return typeof src === 'string'
    ? (units[src] ?? null)
    : unitOfCompiled(registry, specOf(src), units);
}

/**
 * Binds a dataset, producing a graph its plans resolve against.
 *
 * One graph per data binding — two instruments get two graphs and share
 * no nodes, even though their specs produce identical ids.
 */
export function bind(
  series: TimeSeries<SeriesSchema>,
  options: { registry: Registry; units?: Units },
): BoundGraph {
  return new BoundGraph(series, options);
}
