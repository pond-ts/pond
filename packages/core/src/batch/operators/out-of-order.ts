import { ValidationError } from '../../core/errors.js';
import type { BatchOrderingMode } from '../../schema/events.js';

const POLICIES: ReadonlySet<string> = new Set(['strict', 'reorder', 'clamp']);

/**
 * Resolve a loader's `{ ordering, sort }` pair to one policy.
 *
 * `sort` is the one-release deprecated alias (`sort: true` ≡ `'reorder'`,
 * `sort: false` ≡ "don't sort"). When both are given they must agree —
 * `sort: true` with anything but `'reorder'`, or `sort: false` with `'reorder'`,
 * throws rather than silently letting one win. An unknown policy string (a
 * JS caller's typo) throws too, naming the valid ones.
 */
export function resolveOrdering(
  op: string,
  input: { readonly ordering?: BatchOrderingMode; readonly sort?: boolean },
): BatchOrderingMode {
  const { ordering, sort } = input;
  if (ordering !== undefined && !POLICIES.has(ordering)) {
    throw new ValidationError(
      `${op}: ordering must be 'strict', 'reorder' or 'clamp'; got ` +
        `${JSON.stringify(ordering)}`,
    );
  }
  if (sort === undefined) return ordering ?? 'strict';
  if (ordering === undefined) return sort ? 'reorder' : 'strict';
  if (sort !== (ordering === 'reorder')) {
    throw new ValidationError(
      `${op}: conflicting options sort: ${sort} and ordering: ` +
        `'${ordering}' — \`sort\` is a deprecated alias for ` +
        `ordering: 'reorder'; pass ordering alone`,
    );
  }
  return ordering;
}

/**
 * `'clamp'` is defined for single-edged keys only (`time`, `value`). A
 * two-edged key has no one right clamp — moving `begin` alone can pass `end`,
 * and shifting the whole span is a duration-preserving guess — so it is
 * refused up front, regardless of whether the data happens to be ordered.
 */
export function assertClampableKey(op: string, keyKind: string): void {
  if (keyKind !== 'time' && keyKind !== 'value') {
    throw new ValidationError(
      `${op}: ordering: 'clamp' supports 'time' and 'value' keys only; ` +
        `this key is '${keyKind}' — use 'reorder', or clamp the key edges ` +
        `yourself before ingest`,
    );
  }
}

/** The tail every out-of-order error ends with, naming the escape hatches. */
export function outOfOrderHint(keyKind: string): string {
  return keyKind === 'time' || keyKind === 'value'
    ? "pass { ordering: 'reorder' } (or 'clamp'), or pre-sort the input"
    : "pass { ordering: 'reorder' }, or pre-sort the input";
}
