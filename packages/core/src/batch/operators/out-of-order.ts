import { ValidationError } from '../../core/errors.js';
import type { OnOutOfOrder } from '../../schema/events.js';

const POLICIES: ReadonlySet<string> = new Set(['throw', 'sort', 'clamp']);

/**
 * Resolve a loader's `{ onOutOfOrder, sort }` pair to one policy.
 *
 * `sort` is the one-release deprecated alias (`sort: true` ≡ `'sort'`,
 * `sort: false` ≡ "don't sort"). When both are given they must agree —
 * `sort: true` with anything but `'sort'`, or `sort: false` with `'sort'`,
 * throws rather than silently letting one win. An unknown policy string (a
 * JS caller's typo) throws too, naming the valid ones.
 */
export function resolveOnOutOfOrder(
  op: string,
  input: { readonly onOutOfOrder?: OnOutOfOrder; readonly sort?: boolean },
): OnOutOfOrder {
  const { onOutOfOrder, sort } = input;
  if (onOutOfOrder !== undefined && !POLICIES.has(onOutOfOrder)) {
    throw new ValidationError(
      `${op}: onOutOfOrder must be 'throw', 'sort' or 'clamp'; got ` +
        `${JSON.stringify(onOutOfOrder)}`,
    );
  }
  if (sort === undefined) return onOutOfOrder ?? 'throw';
  if (onOutOfOrder === undefined) return sort ? 'sort' : 'throw';
  if (sort !== (onOutOfOrder === 'sort')) {
    throw new ValidationError(
      `${op}: conflicting options sort: ${sort} and onOutOfOrder: ` +
        `'${onOutOfOrder}' — \`sort\` is a deprecated alias for ` +
        `onOutOfOrder: 'sort'; pass onOutOfOrder alone`,
    );
  }
  return onOutOfOrder;
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
      `${op}: onOutOfOrder: 'clamp' supports 'time' and 'value' keys only; ` +
        `this key is '${keyKind}' — use 'sort', or clamp the key edges ` +
        `yourself before ingest`,
    );
  }
}

/** The tail every out-of-order error ends with, naming the escape hatches. */
export function outOfOrderHint(keyKind: string): string {
  return keyKind === 'time' || keyKind === 'value'
    ? "pass { onOutOfOrder: 'sort' } (or 'clamp'), or pre-sort the input"
    : "pass { onOutOfOrder: 'sort' }, or pre-sort the input";
}
