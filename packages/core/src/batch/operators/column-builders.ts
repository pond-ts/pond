import {
  type Column,
  arrayColumnFromArray,
  booleanColumnFromArray,
  float64ColumnFromArray,
  stringColumnFromArray,
} from '../../columnar/index.js';

/**
 * Build a typed {@link Column} from a per-row value array, dispatching on the
 * column's `kind`. An `undefined` cell becomes missing (its validity bit is
 * left unset, so `read(i)` returns `undefined`). Numeric arrays reject
 * non-finite values at construction (`float64ColumnFromArray`) — packed
 * numeric columns stay NaN-free.
 *
 * This is the shared form of the kind→builder dispatch that `fill`
 * (`buildFilledColumn`), `map` (its inline builder), and `collapse`
 * (`buildScalarColumn`) each carry a local copy of — flagged there as a
 * follow-up to converge. Columnar `rolling` is the fourth caller and uses
 * this one directly; retrofitting the other three onto it is a separate
 * (optional) cleanup.
 */
export function columnFromValuesByKind(
  kind: string,
  values: unknown[],
): Column {
  switch (kind) {
    case 'number':
      return float64ColumnFromArray(values as (number | undefined)[]);
    case 'string':
      return stringColumnFromArray(values as (string | undefined)[]);
    case 'boolean':
      return booleanColumnFromArray(values as (boolean | undefined)[]);
    case 'array':
      // ArrayValue cells; the cast is the kind dispatch's trust point.
      return arrayColumnFromArray(values as never);
    default:
      throw new TypeError(`columnFromValuesByKind: unsupported kind '${kind}'`);
  }
}
