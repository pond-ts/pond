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
  readonly inputs: number;
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
      inputs: op.inputs.length,
      outputs: op.outputs.map((o) => ({ suffix: o.id, unit: o.unit })),
    }));
  }

  /**
   * The tool contract: ops as a discriminated union of param objects.
   *
   * `inputs.items` is **recursive** (`$ref: '#/items'`), which is what
   * lets a caller express *EMA of SMA of px* from the schema alone —
   * without being taught a separate nesting concept. That recursion is
   * the single most load-bearing line here.
   *
   * That recursion is also why the schema has to know where it lives. A
   * `$ref` is resolved against the **document root**, so a projection
   * emitted at `#` and then dropped inside a tool's `input_schema` has a
   * dangling pointer — silently, since nothing validates the reference
   * ([PND-PROCREG], found in M2). Pass `base` naming the pointer this
   * subschema will sit at:
   *
   * ```ts
   * const schema = {
   *   type: 'object',
   *   properties: {
   *     process: registry.toJsonSchema({ base: '#/properties/process' }),
   *   },
   * };
   * ```
   *
   * `$schema` is emitted only at the root — a nested subschema declaring
   * its own dialect is not what a caller means.
   */
  toJsonSchema(options: { base?: string } = {}): Record<string, unknown> {
    const base = options.base ?? '#';
    return {
      ...(base === '#' && {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
      }),
      title: 'Plan',
      type: 'array',
      items: {
        oneOf: [...this.#ops.values()].map((op) => ({
          title: op.name,
          description: op.summary,
          type: 'object',
          required: ['op', 'inputs'],
          additionalProperties: false,
          properties: {
            op: { const: op.name },
            inputs: {
              type: 'array',
              minItems: op.inputs.length,
              maxItems: op.inputs.length,
              items: {
                oneOf: [{ type: 'string' }, { $ref: `${base}/items` }],
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
    };
  }
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
