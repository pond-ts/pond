/**
 * Identity, lineage, and units — and the [PND-PROCIDENT] decision.
 *
 * ## Identity is content-addressed, and that is forced
 *
 * The investigation weighed content-addressed ids against params-as-Ins
 * and measured the latter far cheaper under a parameter sweep (1 node vs
 * 200, 6 MB of buffers vs 310 MB). But writing `run()` settles it the
 * other way, because the *plan format* decides it:
 *
 * A plan may hold `sma(px, 20)` **and** `sma(px, 50)` at once. They are
 * two entries, they need two nodes, and — decisively — they need two
 * distinct output **column names**. A column is named by its spec's id,
 * so an id that excluded params would collide. Params must be in the id.
 *
 * The sweep result is still real; it is just an argument about
 * **lifetime**, not identity. Dragging a slider mints a node per
 * position, and those nodes stop being referenced by the current plan the
 * moment it moves on. The answer is a retained set plus a budget
 * ([PND-PROCCACHE]) — not a different identity model.
 *
 * So: **content-addressed identity, budgeted lifetime.**
 *
 * ## Two properties that must not regress
 *
 * Both are requirements rather than accidents, because a persisted saved
 * view and a freshly composed request have to land on the same cache
 * entry:
 *
 * - `specId` is **invariant under param key order** — a caller's JSON
 *   preserves insertion order and two callers will not agree on one.
 * - An **omitted param collides with its explicit default**, so
 *   `{op:'sma'}` and `{op:'sma',params:{period:20}}` are one node.
 *
 * Both are pinned by tests.
 */

import { ProcessError } from '../errors.js';
import { ParamError, type Registry } from './registry.js';
import { isFold, isPicked, specOf } from './types.js';
import type { Params, Spec, SpecRef, UnitSpec, Units } from './types.js';

/** Id format version. Bumping it invalidates persisted ids deliberately. */
const VERSION = 'p1';

/**
 * Escapes the separators an id is built from, so a string param cannot
 * forge one. `sma(a\)b;…)` stays one id rather than closing early.
 */
function esc(v: unknown): string {
  return String(v).replace(/[\\;,()=+]/g, (c) => `\\${c}`);
}

/**
 * Marks an id whose spec did **not** validate — see {@link specId}.
 *
 * A valid id is `p1:…`, so an unvalidated one differs at the character
 * after the version and can never equal one, whatever its params say.
 */
const UNVALIDATED = '?';

/**
 * Key under which a malformed `params` or `inputs` value is recorded in
 * an unvalidated id, so the shape it actually had survives.
 *
 * Only ever emitted inside a `p1?:` id, so it cannot be confused with a
 * declared param — and it is escaped like any other key there.
 */
const MALFORMED = '!malformed';

/**
 * Type-preserving encoding, used **only** inside an unvalidated id.
 *
 * `esc` is `String(v)`, which erases type — so `{period: '20'}` and
 * `{period: 20}` encode identically. Strict mode is safe from that
 * because `checkParam` rejects the string before it is ever encoded;
 * leniency removes that guard, and a JSON or form round-trip turning a
 * number into a string is precisely the broken persisted spec this whole
 * mode exists to name (found by the Layer 2 and Codex reviews of
 * PR #667, which reproduced `'20'` colliding with `20`).
 *
 * Applied to keys too, because leniency carries an **undeclared** param
 * through: a key spelled `a=1,b` would otherwise forge the encoding of
 * two params. Neither change touches a valid id, which is the property
 * that must not move.
 */
function typedEsc(v: unknown): string {
  return esc(`${typeof v}:${String(v)}`);
}

/** Options for {@link specId}. */
export interface SpecIdOptions {
  /**
   * Whether the op must exist and its params must be legal — default
   * `true`.
   *
   * Pass `false` to name a spec that would not compile. See
   * {@link specId} for why identity is separable from validity.
   */
  readonly validate?: boolean;
}

/**
 * Canonical, versioned id for a spec — simultaneously the **column
 * name**, the **cache key**, and the **provenance citation**.
 *
 * Params are sorted by key and materialized post-defaults, so two
 * spellings of one computation collide deliberately.
 *
 * ## Identity is separable from validity — [PND-PROCTOTAL]
 *
 * By default this validates as it goes, because it resolves params to
 * canonicalize them and an id built from a rejected param would be a
 * cache key for a node that cannot exist.
 *
 * But the moments a consumer most needs an id for an **invalid** spec
 * are exactly the failure paths: labelling the chip it is skipping,
 * keying the "this one is broken" UI state, logging which persisted
 * entry was rejected. Coupling the two left the consumer
 * re-implementing canonicalization — the one thing this function exists
 * to own — or carrying a second key beside a correct one (Tidal,
 * `docs/notes/tidal-process-adoption-friction-2026-08.md`).
 *
 * So `specId(registry, spec, { validate: false })` is **total**: an
 * unknown op keeps its given params verbatim, a known one still gets
 * its defaults applied and its keys sorted, and nothing throws.
 * Validity stays `compile`'s job.
 *
 * **A valid spec has one id under either mode.** Canonicalization is
 * the same code path and `checkParam` never coerces, so the lenient id
 * of a legal spec is the strict one — a consumer may key on it without
 * a second cache line.
 *
 * **An unvalidated id cannot collide with a valid one**, and that takes
 * more than putting the params in: it is marked `p1?:` rather than
 * `p1:`, and its params are encoded type-preservingly. Without both, a
 * spec whose param arrived as `"20"` instead of `20` — a JSON round
 * trip, the very case this mode is for — named the *working* node, since
 * `String(v)` erases the difference `checkParam` would have caught. A
 * valid id is unaffected by either measure, which is why they are
 * confined to this branch.
 *
 * The mark rides **up** a chain: a spec whose nested input did not
 * validate cannot compile either, so it is unvalidated too.
 */
export function specId(
  registry: Registry,
  spec: Spec,
  options: SpecIdOptions = {},
): string {
  return build(registry, spec, options.validate === false).id;
}

/** True for an object literal a spec's `params` could legally be. */
function isParamBag(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True for an input that is a nested spec or a picked output. */
function isSpecLike(v: unknown): v is Spec | { from: Spec; output: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    ('op' in v || 'from' in v) &&
    !Array.isArray(v)
  );
}

/**
 * An id, and whether anything in its closure failed validation.
 *
 * **Totality is over arbitrary JSON, not over well-typed `Spec`s.** The
 * whole reason a consumer reaches for leniency is a persisted object
 * that no longer fits — a dropped `inputs` key, a `null` where a param
 * bag belongs, an input that came back as a bare `null`. Answering those
 * with a `TypeError` is the same failure as throwing `ParamError`, one
 * layer down, so each malformed shape is **named** here rather than
 * crashed on: marked unvalidated, and encoded distinctly enough that two
 * differently-broken specs stay two ids (Tidal, on 0.62.0).
 */
function build(
  registry: Registry,
  spec: Spec,
  lenient: boolean,
): { id: string; unvalidated: boolean } {
  let unvalidated = false;
  const bad = (): void => {
    unvalidated = true;
  };

  // The op first, because arity needs it. An unknown op under leniency
  // leaves `op` undefined and nothing further is decidable about params
  // or arity — both are declared BY the definition.
  const op =
    lenient && !registry.has(spec.op) ? undefined : registry.get(spec.op);
  if (op === undefined) bad();

  // Arity is part of validity, and decidable from the registry alone —
  // so a spec that fails it must not be named in the valid namespace.
  // It used to be checked only at `compile`, which meant `p1:sma(;…)`
  // named a spec that could not exist, and then `compile` read `.length`
  // off `undefined` and raised a codeless `TypeError` (Tidal, 0.62.0).
  if (op !== undefined) {
    try {
      registry.checkArity(op, spec.inputs);
    } catch (e) {
      if (!lenient) throw e;
      bad();
    }
  }

  // Inputs next: a nested spec that did not validate marks this one, and
  // the mark has to be known before the params are encoded.
  const rawInputs: readonly unknown[] = Array.isArray(spec.inputs)
    ? spec.inputs
    : spec.inputs === undefined
      ? // The key was dropped. Reads as an empty input list, which is
        // what it is — the arity check above has already marked it.
        (bad(), [])
      : // Present but not a list. Encoded as one token so the shape it
        // actually had survives rather than being flattened to "empty".
        (bad(), [{ [MALFORMED]: spec.inputs }]);
  const inputs = rawInputs
    .map((i) => {
      if (typeof i === 'string') return esc(i);
      if (isSpecLike(i)) {
        // `#Lower` rather than a separate field: an input picking a
        // different output is a different computation, and the id is
        // what says so.
        const base = build(registry, specOf(i as never), lenient);
        if (base.unvalidated) unvalidated = true;
        return isPicked(i as never)
          ? `${base.id}#${esc((i as { output: string }).output)}`
          : base.id;
      }
      // Neither a column name nor a spec — `null`, a number, an array.
      if (!lenient) {
        throw new ProcessError(
          `input of '${spec.op}' must be a column name or a spec, got ${JSON.stringify(i) ?? typeof i}`,
        );
      }
      bad();
      return typedEsc(
        isParamBag(i) && MALFORMED in i
          ? (i as Record<string, unknown>)[MALFORMED]
          : i,
      );
    })
    .join('+');

  // Params last, so the mark is settled before they are encoded.
  let entries: [string, unknown][];
  if (op === undefined) {
    entries = Object.entries(isParamBag(spec.params) ? spec.params : {});
    if (spec.params !== undefined && !isParamBag(spec.params)) {
      bad();
      entries = [[MALFORMED, spec.params]];
    }
  } else if (spec.params !== undefined && !isParamBag(spec.params)) {
    // `resolveParams` would read keys off it and throw a `TypeError`.
    if (!lenient) {
      throw new ParamError(
        `${spec.op} params must be an object, got ${JSON.stringify(spec.params) ?? typeof spec.params}`,
      );
    }
    bad();
    entries = [[MALFORMED, spec.params]];
  } else {
    try {
      // The strict resolve first even under leniency: when it succeeds
      // the id is byte-identical to the validating one, which is the
      // whole contract. Only its failure moves this spec into the
      // unvalidated namespace.
      entries = Object.entries(registry.resolveParams(op, spec.params));
    } catch (e) {
      if (!lenient) throw e;
      bad();
      entries = Object.entries(
        registry.resolveParams(op, spec.params, { validate: false }),
      );
    }
  }

  const encodeKey = unvalidated ? esc : (k: string) => k;
  const encodeValue = unvalidated ? typedEsc : esc;
  const p = entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeKey(k)}=${encodeValue(v)}`)
    .join(',');
  const mark = unvalidated ? UNVALIDATED : '';
  return {
    id: `${VERSION}${mark}:${spec.op}(${inputs};${p})`,
    unvalidated,
  };
}

/** Resolves a reference that may be an inline spec or an id string. */
export function refToId(registry: Registry, ref: SpecRef): string {
  return typeof ref === 'string' ? ref : specId(registry, ref);
}

/**
 * Human lineage, folded from the plan and the registry.
 *
 * Derived rather than reconstructed by hand — hand-built lineage is
 * exactly what loses the inner `sma` in `ema(sma(x))`, which the RFC
 * cites as a live consumer bug.
 */
export function explain(registry: Registry, spec: Spec): string {
  const op = registry.get(spec.op);
  const params = registry.resolveParams(op, spec.params);
  const inputs = spec.inputs
    .map((i) => {
      if (typeof i === 'string') return i;
      const base = explain(registry, specOf(i));
      return isPicked(i) ? `${i.output} of ${base}` : base;
    })
    .join(', ');
  if (op.label) return op.label(params, inputs);
  const p = Object.entries(params)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(', ');
  return p ? `${op.name}(${p}) of ${inputs}` : `${op.name} of ${inputs}`;
}

/**
 * Unit of a spec's output `n` — declared outright, or folded from input 0.
 *
 * `null` means unitless: the consumer supplied no unit for the raw column
 * at the root of the chain. That is reported rather than guessed.
 */
export function unitOf(
  registry: Registry,
  spec: Spec,
  units: Units,
  outputIndex = 0,
): string | null {
  const op = registry.get(spec.op);
  const declared: UnitSpec = isFold(op)
    ? op.unit
    : (op.outputs[outputIndex]?.unit ?? 'inherit');
  if (declared !== 'inherit') return declared;
  const src = spec.inputs[0];
  if (src === undefined) return null;
  if (typeof src === 'string') return units[src] ?? null;
  const upstream = specOf(src);
  const index = isPicked(src)
    ? registry
        .outputsOf(registry.get(upstream.op))
        .findIndex((o) => o.id === src.output)
    : 0;
  return unitOf(registry, upstream, units, Math.max(0, index));
}

/**
 * Column names a spec produces, in output-declaration order.
 *
 * A single-output op declares suffix `''`, so its column *is* the id; a
 * band's three columns share the id as a prefix, which is the corpus's
 * own convention and needs no mapping layer.
 */
export function columnsOf(
  registry: Registry,
  spec: Spec,
  id: string,
): string[] {
  const def = registry.get(spec.op);
  return registry.outputsOf(def).map((o) => id + o.id);
}

/**
 * Which params an output depends on, defaulting to all of them.
 *
 * Declaring a narrower set is what lets a change to one param leave
 * another output's version untouched ([PND-PROCSEL]).
 */
export function dependsOn(
  registry: Registry,
  spec: Spec,
  outputIndex: number,
): string[] {
  const op = registry.get(spec.op);
  const declared = isFold(op) ? undefined : op.outputs[outputIndex]?.dependsOn;
  return declared ? [...declared] : Object.keys(op.params);
}

/** Params reduced to the subset an output depends on — its cache key. */
export function outputKey(params: Params, keys: readonly string[]): string {
  return [...keys]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => `${k}=${esc(params[k])}`)
    .join(',');
}
