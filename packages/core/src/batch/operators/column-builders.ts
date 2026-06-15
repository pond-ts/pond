import {
  type Column,
  arrayColumnFromArray,
  booleanColumnFromArray,
  float64ColumnFromArray,
  stringColumnFromArray,
} from '../../columnar/index.js';
import { ValidationError } from '../../core/errors.js';

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

/**
 * Throw if any *defined* value fails the column's `kind` contract, mirroring
 * the constructor's strict intake (`validate.ts`): a `number` must be finite;
 * `string` / `boolean` must match `typeof`; an `array` must be a real array
 * whose elements are each a finite number, string, or boolean. `undefined`
 * (missing) values are allowed.
 *
 * Computed-writer paths that assemble via trusted construction bypass intake,
 * and {@link columnFromValuesByKind}'s `*FromArray` builders silently coerce a
 * kind mismatch to a *missing* cell — so a caller that must preserve the intake
 * rejection (e.g. columnar `rolling`, matching `mapColumns`) calls this first.
 * `label` is prefixed to the thrown message.
 */
export function assertColumnValuesMatchKind(
  kind: string,
  values: ReadonlyArray<unknown>,
  label: string,
): void {
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v === undefined) continue; // missing cell — allowed
    let ok: boolean;
    switch (kind) {
      case 'number':
        ok = typeof v === 'number' && Number.isFinite(v);
        break;
      case 'string':
        ok = typeof v === 'string';
        break;
      case 'boolean':
        ok = typeof v === 'boolean';
        break;
      case 'array': {
        if (!Array.isArray(v)) {
          ok = false;
          break;
        }
        // Indexed loop, NOT `.every` (which skips holes): a sparse array's
        // hole reads as `undefined`, an invalid element that intake's indexed
        // scan rejects. Match it exactly so sparse arrays throw here rather
        // than getting silently coerced to a missing cell by the builder.
        ok = true;
        for (let j = 0; j < v.length; j += 1) {
          const el = v[j];
          if (
            !(
              (typeof el === 'number' && Number.isFinite(el)) ||
              typeof el === 'string' ||
              typeof el === 'boolean'
            )
          ) {
            ok = false;
            break;
          }
        }
        break;
      }
      default:
        ok = false;
    }
    if (!ok) {
      // `ValidationError` (not `RangeError`) so the failure class matches the
      // constructor's strict intake — a caller that catches `ValidationError`
      // for bad user data sees columnar-rolling rejections identically.
      throw new ValidationError(
        `${label}: result ${String(v)} is not a valid '${kind}' value`,
      );
    }
  }
}
