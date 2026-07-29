/**
 * Registry-bound fluent authoring.
 *
 * This is a compiler into the slot envelope, not a second execution path.
 * The registry's accumulated literal type supplies op names, params, input
 * roles and output suffixes; runtime plans still pass through normal registry
 * validation because requests may also arrive as JSON.
 */

import type { OpDef, ParamDef } from './types.js';
import { isFold } from './types.js';
import {
  BuilderError,
  PlanBuilder,
  type BuiltRequest,
  type InputRef,
  type NodeHandle,
  type OutputHandle,
} from './builder.js';
import type { DefMap, Registry } from './registry.js';
import type { SourceRef } from './source.js';

const INPUT = Symbol.for('@pond-ts/process/input');

type ValueFor<D extends ParamDef> = D extends {
  readonly kind: 'integer' | 'number';
}
  ? number
  : D extends { readonly kind: 'boolean' }
    ? boolean
    : D extends {
          readonly kind: 'enum';
          readonly of: readonly (infer V extends string)[];
        }
      ? V
      : never;

type ParamsFor<D extends OpDef> = {
  readonly [K in keyof D['params']]?: ValueFor<D['params'][K]>;
};

type TailInputs<D extends OpDef> = D['inputs'] extends readonly [
  unknown,
  ...infer Rest,
]
  ? Rest
  : readonly [];

type ExtraInputsFor<D extends OpDef> = {
  readonly [I in TailInputs<D>[number] as I extends {
    readonly role: infer Role extends string;
  }
    ? Role
    : never]: FluentColumnRef<any>;
};

export type BuildOptions<D extends OpDef> = Readonly<
  { as: string } & ParamsFor<D> & ExtraInputsFor<D>
>;

type OutputNames<D extends OpDef> = D['outputs'][number]['id'];

type OpMethods<Defs extends DefMap> = {
  readonly [Name in keyof Defs as Defs[Name] extends OpDef
    ? Name
    : never]: Defs[Name] extends OpDef
    ? (options: BuildOptions<Defs[Name]>) => NodeFor<Defs, Defs[Name]>
    : never;
};

interface Selection {
  readonly handle: NodeHandle;
  readonly output?: string;
}

interface ColumnOps<Defs extends DefMap> {
  /** Latest defined value, with its timestamp. */
  last(): FactRef;
  /** Minimum and maximum, each with its timestamp. */
  extremes(): FactRef;
  /** Where the latest value sits in its own history. */
  percentileRank(): FactRef;
  /** A bounded sample of the complete series. */
  shape(options?: { points?: number }): FactRef;
}

export type FluentColumnRef<Defs extends DefMap> = ColumnOps<Defs> &
  OpMethods<Defs>;

export type SelectedColumnRef<Defs extends DefMap> = FluentColumnRef<Defs> & {
  columns(): ColumnSelection;
};

export interface FactRef {
  readonly selection: Selection;
}

export type SingleColumnNode<Defs extends DefMap> = SelectedColumnRef<Defs> & {
  readonly slot: string;
};

export interface MultiColumnNode<Defs extends DefMap, Outputs extends string> {
  readonly slot: string;
  output<Name extends Outputs>(name: Name): SelectedColumnRef<Defs>;
  columns(): ColumnSelection;
}

export interface ColumnSelection {
  readonly selection: Selection;
}

type NodeFor<Defs extends DefMap, D extends OpDef> =
  '' extends OutputNames<D>
    ? SingleColumnNode<Defs>
    : MultiColumnNode<Defs, OutputNames<D>>;

export type FluentRequest<From extends string | SourceRef = string> =
  BuiltRequest<From>;

export class ProcessBuilder<
  Defs extends DefMap,
  From extends string | SourceRef = string,
> {
  readonly #registry: Registry<Defs>;
  readonly #builder: PlanBuilder<From>;
  readonly #folds = new Map<string, NodeHandle>();

  constructor(registry: Registry<Defs>, from: From) {
    this.#registry = registry;
    this.#builder = new PlanBuilder(from);
  }

  /** Refers to one raw numeric column of the bound source. */
  column(name: string): FluentColumnRef<Defs> {
    return this.#column(name);
  }

  /** Names the request so another request may refer to its result. */
  as(name: string): this {
    this.#builder.as(name);
    return this;
  }

  /**
   * Finishes the request and names its surfaced values in one place.
   *
   * The result is still the exact plain-data envelope accepted by `Host`.
   */
  outputs(
    outputs: Readonly<Record<string, ColumnSelection | FactRef>>,
  ): FluentRequest<From> {
    for (const [name, selected] of Object.entries(outputs)) {
      this.#builder.expose(
        name,
        selected.selection.handle,
        selected.selection.output === undefined
          ? undefined
          : { output: selected.selection.output },
      );
    }
    return this.#builder.toJSON();
  }

  #column(
    input: InputRef,
    node?: NodeHandle,
    selectedOutput?: string,
  ): FluentColumnRef<Defs> {
    const target: Record<PropertyKey, unknown> = {
      ...(node !== undefined && {
        slot: node.slot,
        columns: () => ({
          selection: {
            handle: node,
            ...(selectedOutput !== undefined && { output: selectedOutput }),
          },
        }),
      }),
      last: () => this.#fold(input, 'last'),
      extremes: () => this.#fold(input, 'extremes'),
      percentileRank: () => this.#fold(input, 'percentileRank'),
      shape: (options: { points?: number } = {}) =>
        this.#fold(input, 'shape', options),
    };
    Object.defineProperty(target, INPUT, { value: input });

    return new Proxy(target, {
      get: (base, property, receiver) => {
        if (Reflect.has(base, property)) {
          return Reflect.get(base, property, receiver);
        }
        if (typeof property !== 'string' || !this.#registry.has(property)) {
          return undefined;
        }
        const def = this.#registry.get(property);
        if (isFold(def)) return undefined;
        return (options: Record<string, unknown>) =>
          this.#apply(input, def, options);
      },
    }) as FluentColumnRef<Defs>;
  }

  #apply(
    input: InputRef,
    def: OpDef,
    options: Readonly<Record<string, unknown>>,
  ): SingleColumnNode<Defs> | MultiColumnNode<Defs, string> {
    const slot = options['as'];
    if (typeof slot !== 'string' || slot.length === 0) {
      throw new BuilderError(`${def.name} requires a non-empty 'as' slot`);
    }

    const inputs: InputRef[] = [input];
    for (const declared of def.inputs.slice(1)) {
      const ref = options[declared.role];
      if (!isFluentColumn(ref)) {
        throw new BuilderError(
          `${def.name} requires input '${declared.role}' to be a column reference`,
        );
      }
      inputs.push(ref[INPUT]);
    }

    const params = Object.fromEntries(
      Object.keys(def.params)
        .filter((key) => options[key] !== undefined)
        .map((key) => [key, options[key] as string | number | boolean]),
    );
    const handle = this.#builder.add(
      slot,
      def.name,
      Object.keys(params).length === 0 ? undefined : params,
      inputs,
    );

    if (def.outputs.length === 1 && def.outputs[0]!.id === '') {
      return this.#column(handle, handle) as SingleColumnNode<Defs>;
    }

    return {
      slot,
      output: (name: string) => {
        if (!def.outputs.some((output) => output.id === name)) {
          throw new BuilderError(
            `${def.name} has no output '${name}' — has ${def.outputs.map((o) => `'${o.id}'`).join(', ')}`,
          );
        }
        const picked: OutputHandle = { slot, output: name };
        return this.#column(picked, handle, name) as SelectedColumnRef<Defs>;
      },
      columns: () => ({ selection: { handle } }),
    };
  }

  #fold(
    input: InputRef,
    op: 'last' | 'extremes' | 'percentileRank' | 'shape',
    params: { points?: number } = {},
  ): FactRef {
    const inputName =
      typeof input === 'string'
        ? `$${input}`
        : 'output' in input
          ? `${input.slot}#${input.output}`
          : input.slot;
    const slot = `${inputName}:${op}`;
    let handle = this.#folds.get(slot);
    if (handle === undefined) {
      handle = this.#builder.add(
        slot,
        op,
        params.points === undefined ? undefined : { points: params.points },
        [input],
      );
      this.#folds.set(slot, handle);
    }
    return { selection: { handle } };
  }
}

interface InternalColumnRef {
  readonly [INPUT]: InputRef;
}

function isFluentColumn(value: unknown): value is InternalColumnRef {
  return (
    typeof value === 'object' && value !== null && Reflect.has(value, INPUT)
  );
}

export function process<const Defs extends DefMap>(
  registry: Registry<Defs>,
  from: string,
): ProcessBuilder<Defs, string>;
export function process<
  const Defs extends DefMap,
  const From extends SourceRef,
>(registry: Registry<Defs>, from: From): ProcessBuilder<Defs, From>;
export function process<
  const Defs extends DefMap,
  const From extends string | SourceRef,
>(registry: Registry<Defs>, from: From): ProcessBuilder<Defs, From> {
  return new ProcessBuilder(registry, from);
}
