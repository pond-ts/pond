/**
 * The registry, and the param vocabulary it is declared in.
 *
 * One declaration, four readers: **param validation**, a **JSON Schema
 * projection** so a tool caller can compose plans, a **UI picker**
 * (family + params + defaults is exactly a grouped menu), and **unit
 * propagation**.
 *
 * The internal param spec is the source of truth and the validator reads
 * it; JSON Schema is a *projection* emitted for callers, not the
 * authority ([PND-PROCREG]). Adopting JSON Schema as the source would
 * mean taking on a schema-validator dependency to do work a dozen lines
 * already do.
 */

import { ProcessError } from '../errors.js';
import type {
  BooleanParam,
  EnumParam,
  InputDef,
  NumberParam,
  OpDef,
  ParamDef,
  Params,
  ParamValue,
} from './types.js';

/** Thrown when a plan names an op the registry does not have. */
export class UnknownOpError extends ProcessError {}

/** Thrown when a param is missing, mistyped, or out of range. */
export class ParamError extends ProcessError {}

// ── param constructors ───────────────────────────────────────

export const int = (o: Omit<NumberParam, 'kind'>): NumberParam => ({
  kind: 'integer',
  ...o,
});
export const num = (o: Omit<NumberParam, 'kind'>): NumberParam => ({
  kind: 'number',
  ...o,
});
export const choice = (o: Omit<EnumParam, 'kind'>): EnumParam => ({
  kind: 'enum',
  ...o,
});
export const flag = (o: Omit<BooleanParam, 'kind'>): BooleanParam => ({
  kind: 'boolean',
  ...o,
});

/**
 * Validates one param and returns it.
 *
 * Reports what it actually received, including the type. A caller
 * composing JSON is the audience least able to debug `must be an
 * integer, got 20` when it sent `"20"`.
 */
function checkParam(
  op: string,
  key: string,
  def: ParamDef,
  v: ParamValue,
): ParamValue {
  const got = `${JSON.stringify(v)} (${typeof v})`;
  if (def.kind === 'integer' || def.kind === 'number') {
    if (typeof v !== 'number' || Number.isNaN(v)) {
      const article = def.kind === 'integer' ? 'an' : 'a';
      throw new ParamError(
        `${op}.${key} must be ${article} ${def.kind}, got ${got}`,
      );
    }
    if (def.kind === 'integer' && !Number.isInteger(v)) {
      throw new ParamError(`${op}.${key} must be an integer, got ${got}`);
    }
    if (def.min !== undefined && v < def.min) {
      throw new ParamError(`${op}.${key}=${v} is below minimum ${def.min}`);
    }
    if (def.max !== undefined && v > def.max) {
      throw new ParamError(`${op}.${key}=${v} is above maximum ${def.max}`);
    }
    return v;
  }
  if (def.kind === 'enum') {
    if (typeof v !== 'string' || !def.of.includes(v)) {
      throw new ParamError(
        `${op}.${key} must be one of ${def.of.map((o) => `'${o}'`).join(', ')}, got ${got}`,
      );
    }
    return v;
  }
  if (typeof v !== 'boolean') {
    throw new ParamError(`${op}.${key} must be a boolean, got ${got}`);
  }
  return v;
}

/** Op metadata as a picker or a tool catalog wants it. */
export interface OpDescriptor {
  readonly name: string;
  readonly family: string;
  readonly summary: string;
  readonly params: Readonly<Record<string, ParamDef>>;
  /**
   * The declared inputs, not a count of them.
   *
   * A count is enough to check arity and nothing else. A consumer
   * labelling a two-input op cannot say which side is which, and one
   * showing why a plan was rejected cannot name the unit an input
   * demands — both facts the registry holds and used to drop here. Found
   * by building a UI that wanted to label a node's wiring and could only
   * show how many wires there were.
   */
  readonly inputs: readonly InputDef[];
  readonly outputs: readonly {
    readonly suffix: string;
    readonly unit: string;
  }[];
}

export class Registry {
  readonly #ops = new Map<string, OpDef>();

  define(op: OpDef): this {
    if (op.outputs.length === 0) {
      throw new ProcessError(`op '${op.name}' declares no outputs`);
    }
    if (op.outputs.length > 1 && op.outputs.some((o) => o.id === '')) {
      throw new ProcessError(
        `op '${op.name}' is multi-output, so every output needs a suffix — '' would collide with the spec id`,
      );
    }
    this.#ops.set(op.name, op);
    return this;
  }

  has(name: string): boolean {
    return this.#ops.has(name);
  }

  /** @throws {UnknownOpError} naming what is available, so an agent can retry. */
  get(name: string): OpDef {
    const op = this.#ops.get(name);
    if (op === undefined) {
      throw new UnknownOpError(
        `unknown op '${name}' — have ${[...this.#ops.keys()].map((k) => `'${k}'`).join(', ')}`,
      );
    }
    return op;
  }

  /** Applies defaults, then validates every declared param. */
  resolveParams(
    op: OpDef,
    given: Readonly<Record<string, ParamValue>> = {},
  ): Params {
    const out: Record<string, ParamValue> = {};
    for (const [key, def] of Object.entries(op.params)) {
      const raw = Object.hasOwn(given, key) ? given[key]! : def.default;
      out[key] = checkParam(op.name, key, def, raw);
    }
    for (const key of Object.keys(given)) {
      if (!Object.hasOwn(op.params, key)) {
        throw new ParamError(
          `${op.name} has no param '${key}' — takes ${
            Object.keys(op.params)
              .map((k) => `'${k}'`)
              .join(', ') || 'none'
          }`,
        );
      }
    }
    return out;
  }

  /** Grouped for a picker. */
  byFamily(): Map<string, OpDescriptor[]> {
    const out = new Map<string, OpDescriptor[]>();
    for (const d of this.describe()) {
      const list = out.get(d.family) ?? [];
      list.push(d);
      out.set(d.family, list);
    }
    return out;
  }

  describe(): OpDescriptor[] {
    return [...this.#ops.values()].map((op) => ({
      name: op.name,
      family: op.family,
      summary: op.summary,
      params: op.params,
      inputs: op.inputs,
      outputs: op.outputs.map((o) => ({ suffix: o.id, unit: o.unit })),
    }));
  }

  /**
   * The tool contract: ops as a discriminated union of param objects.
   *
   * The spec schema is **recursive** — an input is a column name *or*
   * another spec — which is what lets a caller express *EMA of SMA of
   * px* from the schema alone, without being taught a nesting concept.
   * That recursion is the single most load-bearing thing here, and
   * getting it to travel took three attempts.
   *
   * It lives in `$defs`, and the recursion goes through
   * `#/$defs/<name>`. That is the only shape that is actually portable:
   *
   * - `#/items`, the original, dangles the moment the projection is
   *   nested inside a larger schema, because a `$ref` resolves against
   *   the **document root**. Silently — nothing requires a `$ref` to
   *   resolve ([PND-PROCREG], M2).
   * - `#/properties/process/items`, a pointer *into* the host document,
   *   fixes that and passes local validators — including OpenAI's own
   *   `toStrictJsonSchema` — but the API rejects it: *"reference can
   *   only point to definitions defined at the top level of the
   *   schema"* ([PND-PROCSCHEMA], M5).
   *
   * So a caller embedding this must lift `$defs` to its own root, where
   * `#/$defs/<name>` resolves from anywhere:
   *
   * ```ts
   * const plan = registry.toJsonSchema({ defs: 'spec' });
   * const { $defs, ...body } = plan;
   * const schema = {
   *   type: 'object',
   *   $defs,                                  // hoisted to the root
   *   properties: { process: body },
   * };
   * ```
   *
   * `$schema` is emitted only at the root — a nested subschema declaring
   * its own dialect is not what a caller means.
   *
   * Two more things learned by calling a real API rather than reading a
   * spec, both cases where a **client-side** strict validator accepted
   * what the server refused:
   *
   * - Unions are `anyOf`, not `oneOf`. Both branch sets here are
   *   disjoint — the op union is discriminated by a `const`, and an
   *   input is a string or an object, never both — so they are
   *   equivalent in meaning, and `anyOf` is the one tool APIs accept
   *   (*"'oneOf' is not permitted"*).
   * - A `const` carries its `type` alongside. Redundant to a validator,
   *   and required by the same API (*"schema must have a 'type' key"*).
   */
  toJsonSchema(
    options: { defs?: string; root?: boolean; shape?: 'nested' | 'slots' } = {},
  ): Record<string, unknown> {
    if (options.shape === 'slots') {
      return slotSchemaFor([...this.#ops.values()]);
    }
    const name = options.defs ?? 'spec';
    const ref = `#/$defs/${name}`;
    return {
      ...(options.root !== false && {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
      }),
      title: 'Plan',
      type: 'array',
      items: { $ref: ref },
      $defs: {
        [name]: {
          anyOf: [...this.#ops.values()].map((op) => ({
            title: op.name,
            description: op.summary,
            type: 'object',
            required: ['op', 'inputs'],
            additionalProperties: false,
            properties: {
              op: { type: 'string', const: op.name },
              inputs: {
                type: 'array',
                minItems: op.inputs.length,
                maxItems: op.inputs.length,
                items: {
                  anyOf: [{ type: 'string' }, { $ref: ref }],
                },
              },
              params: {
                type: 'object',
                additionalProperties: false,
                properties: Object.fromEntries(
                  Object.entries(op.params).map(([k, d]) => [
                    k,
                    jsonSchemaForParam(d),
                  ]),
                ),
              },
            },
          })),
        },
      },
    };
  }
}

/**
 * The slot projection — [PND-PROCSLOT].
 *
 * Worth noticing what is *not* here. The nested form's single most
 * load-bearing line is a recursive `$ref`, because an input may be
 * another spec — and making that portable took three rounds against a
 * live API: `oneOf` refused, every node needing an explicit `type`, and
 * a body pointer rejected in favour of a top-level `$defs`.
 *
 * With slots an input is a **string** — a column name, or another slot —
 * so the recursion is gone, and every one of those problems with it.
 * Flat, no `$defs`, no `$ref`, nothing to rebase when embedded.
 *
 * `nodes` projects as an **array** rather than an object keyed by slot
 * name: a caller-chosen key cannot be declared in `properties`, and
 * strict structured outputs require `additionalProperties: false`. The
 * array carries the name as a field instead, and the caller keys by it.
 */
function slotSchemaFor(ops: readonly OpDef[]): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'Nodes',
    type: 'array',
    items: {
      anyOf: ops.map((op) => ({
        title: op.name,
        description: op.summary,
        type: 'object',
        required: ['slot', 'op', 'in'],
        additionalProperties: false,
        properties: {
          slot: {
            type: 'string',
            description:
              'A short name you choose for this node, unique within the request. Used to wire it into other nodes and to name it in outputs. It must not be the name of a source column.',
          },
          op: { type: 'string', const: op.name },
          in: {
            type: 'array',
            minItems: op.inputs.length,
            maxItems: op.inputs.length,
            description:
              'Inputs in order. Each is a source column name, or the slot of another node in this request.',
            items: { type: 'string' },
          },
          params: {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(
              Object.entries(op.params).map(([k, d]) => [
                k,
                jsonSchemaForParam(d),
              ]),
            ),
          },
        },
      })),
    },
  };
}

function jsonSchemaForParam(d: ParamDef): Record<string, unknown> {
  if (d.kind === 'enum') {
    return { type: 'string', enum: [...d.of], default: d.default };
  }
  if (d.kind === 'boolean') {
    return { type: 'boolean', default: d.default };
  }
  return {
    type: d.kind === 'integer' ? 'integer' : 'number',
    default: d.default,
    ...(d.min !== undefined && { minimum: d.min }),
    ...(d.max !== undefined && { maximum: d.max }),
  };
}

export function createRegistry(): Registry {
  return new Registry();
}
