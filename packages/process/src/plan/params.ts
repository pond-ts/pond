/**
 * The param vocabulary, in its own module.
 *
 * Split out of the registry because `folds.ts` needs `int` to declare
 * `shape`'s `points`, and the registry needs `folds.ts` to pre-register
 * the standard folds — a cycle that ESM resolves by handing one side an
 * uninitialised binding, which surfaces as `int is not a function` at
 * import time rather than anywhere near the cause.
 */

import type { BooleanParam, EnumParam, NumberParam } from './types.js';

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
