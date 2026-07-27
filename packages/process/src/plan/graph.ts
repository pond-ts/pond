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

import { appendColumn, packColumn } from '../column.js';
import { ProcessError } from '../errors.js';
import { defineNode, type Node } from '../node.js';
import { port } from '../types.js';
import { source, type SourceNode } from '../source.js';
import type { Column, SeriesSchema, TimeSeries } from 'pond-ts';
import { columnsOf, specId } from './identity.js';
import type { Registry } from './registry.js';
import type { OpDef, Params, Spec, Units } from './types.js';

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
          : unitOfCompiled(this.registry, raw, this.units);
      if (got !== def.unit) {
        const name = typeof raw === 'string' ? raw : specId(this.registry, raw);
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
      const upstream = this.compile(raw);
      const upstreamId = upstream.id;
      const first = columnsOf(this.registry, raw, upstreamId)[0]!;
      const key = outletKey(this.registry.get(raw.op).outputs[0]!);
      return {
        role,
        column: first,
        outlet: upstream.node.out[key] as { get(): Column },
        nested: true as const,
      };
    });

    const inlets: Record<string, any> = { src: this.#source.out.value };
    bound.forEach((b, i) => {
      if (b.nested) inlets[`in${i}`] = b.outlet;
    });

    const outputs = Object.fromEntries(
      op.outputs.map((o) => [outletKey(o), port<Column>()]),
    );

    const factory = defineNode({
      kind: spec.op,
      inputs: Object.fromEntries(
        Object.keys(inlets).map((k) => [k, port<any>()]),
      ),
      outputs,
      compute: (vals: Record<string, any>) => {
        // Widen the source with each nested input's column so the op can
        // call the corpus normally — the studies take (series, {column}).
        let series = vals['src'] as TimeSeries<SeriesSchema>;
        bound.forEach((b, i) => {
          if (b.nested) {
            series = appendColumn(series, b.column, vals[`in${i}`] as Column);
          }
        });
        const inputsByRole = Object.fromEntries(
          bound.map((b) => [b.role, b.column]),
        );
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
      outlets: Object.fromEntries(op.outputs.map((o) => [o.id, outletKey(o)])),
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
        `'${compiled.spec.op}' has no output '${suffix}' (has ${have})`,
      );
    }
    return (compiled.node.out[key] as { get(): Column }).get();
  }
}

/** Unit fold that does not require the spec to be compiled yet. */
function unitOfCompiled(
  registry: Registry,
  spec: Spec,
  units: Units,
): string | null {
  const op = registry.get(spec.op);
  const declared = op.outputs[0]?.unit ?? 'inherit';
  if (declared !== 'inherit') return declared;
  const src = spec.inputs[0];
  if (src === undefined) return null;
  return typeof src === 'string'
    ? (units[src] ?? null)
    : unitOfCompiled(registry, src, units);
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
