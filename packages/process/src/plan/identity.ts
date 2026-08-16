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

import type { Registry } from './registry.js';
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
 * a second cache line. An id minted leniently for an *illegal* spec
 * cannot collide with a legal one either: the op name is in the id, and
 * within an op every difference that made it illegal is still in the
 * params.
 */
export function specId(
  registry: Registry,
  spec: Spec,
  options: SpecIdOptions = {},
): string {
  const lenient = options.validate === false;
  const op =
    lenient && !registry.has(spec.op) ? undefined : registry.get(spec.op);
  const params =
    op === undefined
      ? (spec.params ?? {})
      : registry.resolveParams(op, spec.params, options);
  const p = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${esc(v)}`)
    .join(',');
  const inputs = spec.inputs
    .map((i) => {
      if (typeof i === 'string') return esc(i);
      // `#Lower` rather than a separate field: an input picking a
      // different output is a different computation, and the id is what
      // says so.
      const base = specId(registry, specOf(i), options);
      return isPicked(i) ? `${base}#${esc(i.output)}` : base;
    })
    .join('+');
  return `${VERSION}:${spec.op}(${inputs};${p})`;
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
