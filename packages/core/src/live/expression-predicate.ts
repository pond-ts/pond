import { Expr, rowPredicate } from '../core/expression.js';

/**
 * A live `filter` argument as a per-event function: a function as is, an
 * expression ([PND-EXPR]) checked once against the schema's value columns.
 */
export function livePredicate<E>(
  test: ((event: E) => boolean) | Expr,
  schema: readonly { name: string; kind: string }[],
): (event: E) => boolean {
  if (!(test instanceof Expr)) return test;
  return rowPredicate(
    test,
    schema.slice(1).map((d) => ({ name: d.name, kind: d.kind })),
    'filter',
  ) as unknown as (event: E) => boolean;
}
