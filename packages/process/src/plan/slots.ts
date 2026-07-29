/**
 * Slots — [PND-PROCSLOT].
 *
 * A plan written as nested specs uses **one identity for two jobs**. A
 * node's id is derived from its op, params and inputs, so it keys the
 * cache correctly — and changes the moment a param does, even though the
 * topology has not. Moving a `period` from 20 to 50 leaves a
 * structurally identical plan in which every downstream id is different.
 *
 * A **slot** is the missing identity: a caller-assigned name for a
 * position in the graph, stable across a param edit.
 *
 * ```jsonc
 * {
 *   "bb": { "op": "bollinger", "params": { "period": 20 }, "in": ["px"] },
 *   "z":  { "op": "zscore", "params": { "period": 20 }, "in": ["px"] }
 * }
 * ```
 *
 * Slots are an **alias layer, not a replacement**. `specId` remains the
 * cache key, because it is what makes a node found again across requests,
 * sessions and callers — a saved view composed months ago and a fresh
 * compose land on the same node precisely because the id is derived
 * rather than assigned. One caller's `bb` means nothing to another's.
 *
 * That is why this file only **expands**: a slot graph becomes the nested
 * `Spec` form the rest of the layer already resolves, so a slot plan and
 * the equivalent nested plan produce identical ids by construction, and
 * neither `compile` nor `specId` needs to know slots exist.
 */

import { ProcessError } from '../errors.js';
import type { Input, ParamValue, Spec } from './types.js';

/** Thrown when a slot graph cannot be expanded. */
export class SlotError extends ProcessError {}

/** One node in a slot graph. `in` names source columns or other slots. */
export interface SlotDef {
  readonly op: string;
  readonly params?: Readonly<Record<string, ParamValue>>;
  /**
   * Inputs, in the op's declared order. Each entry is a source column
   * name or another slot's name — **not** an inline spec. Being unable
   * to nest here is the point: nesting is what slots replace.
   */
  readonly in: readonly string[];
}

/** A graph keyed by caller-assigned names. */
export type Slots = Readonly<Record<string, SlotDef>>;

/**
 * Expands a slot graph into the nested `Spec` form.
 *
 * `columns` is the bound source's column names, needed for two checks
 * that are far cheaper here than as a failure later:
 *
 * - a slot may not take the name of a column, because an input string
 *   would then be ambiguous and the column would be shadowed silently
 *   (the alternative, a sigil like `"@bb"`, adds syntax to a format that
 *   has none — [PND-PROCSLOT] prefers the validation);
 * - an input naming neither a slot nor a column is a typo, and saying so
 *   with both lists beats a downstream "column not found".
 *
 * @throws {SlotError} on a name collision, an unknown reference, or a cycle.
 */
export function expandSlots(
  slots: Slots,
  columns: readonly string[],
): Map<string, Spec> {
  const names = Object.keys(slots);
  const columnSet = new Set(columns);

  for (const name of names) {
    if (columnSet.has(name)) {
      throw new SlotError(
        `slot '${name}' collides with a source column of the same name — rename the slot, or an input naming '${name}' would be ambiguous`,
      );
    }
  }

  const done = new Map<string, Spec>();
  // Insertion-ordered, so the cycle message reads as a path rather than
  // an unordered set of names.
  const visiting: string[] = [];

  const expand = (name: string): Spec => {
    const cached = done.get(name);
    if (cached !== undefined) return cached;

    const at = visiting.indexOf(name);
    if (at !== -1) {
      throw new SlotError(
        `slot cycle: ${[...visiting.slice(at), name].join(' → ')}`,
      );
    }
    const def = slots[name]!;
    visiting.push(name);
    const inputs = def.in.map((ref): Input => {
      if (Object.hasOwn(slots, ref)) return expand(ref);
      if (columnSet.has(ref)) return ref;
      // `bb#Lower` — one named output of a multi-output slot. A suffix
      // rather than a nested object because `in` is a list of strings
      // and keeping it that way is what makes the slot schema flat, with
      // no recursive `$ref` to make portable ([PND-PROCSLOT]).
      const hash = ref.lastIndexOf('#');
      if (hash > 0) {
        const upstream = ref.slice(0, hash);
        if (Object.hasOwn(slots, upstream)) {
          return { from: expand(upstream), output: ref.slice(hash + 1) };
        }
      }
      // Name the `#` spelling when the reference looks like an attempt
      // at one. A model reaching for a band's upper line writes
      // `bb.Upper` on the first try — reasonably — and a list of valid
      // slots does not tell it what it got wrong.
      const guess = /^(.+)[.:/](.+)$/.exec(ref);
      const hint =
        guess !== null && Object.hasOwn(slots, guess[1]!)
          ? ` — to read one output of slot '${guess[1]!}', write '${guess[1]!}#${guess[2]!}'`
          : '';
      throw new SlotError(
        `slot '${name}' names '${ref}', which is neither a slot nor a column${hint} — slots are ${quoted(names)}; columns are ${quoted(columns)}`,
      );
    });
    visiting.pop();

    const spec: Spec = {
      op: def.op,
      ...(def.params !== undefined && { params: def.params }),
      inputs,
    };
    done.set(name, spec);
    return spec;
  };

  for (const name of names) expand(name);
  return done;
}

function quoted(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.map((v) => `'${v}'`).join(', ');
}
