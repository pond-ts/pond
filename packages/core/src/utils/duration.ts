/**
 * Unit suffix recognised by {@link parseDuration}. Kept in lock-step
 * with the runtime regex `^(\d+)(ms|s|m|h|d)$`.
 */
export type DurationUnit = 'ms' | 's' | 'm' | 'h' | 'd';

/**
 * Template-literal duration string. The `${number}` prefix is
 * intentionally permissive — TS rejects non-numeric prefixes
 * (`'min'`, `'abch'`, `'1min'`) but accepts fractional / negative /
 * exponential shapes (`'1.5m'`, `'-1m'`, `'1e3s'`) that the runtime
 * regex `^(\d+)(ms|s|m|h|d)$` rejects. Fully tightening to integer-
 * only requires either a 50+ deep recursive template (TS errors with
 * "circularly references itself") or a bounded union of 10^N digit
 * strings (TS errors with "union type is too complex" past ~5
 * digits). The runtime parse is the strict gate; the type is the
 * documentation hint.
 */
export type DurationLiteral = `${number}${DurationUnit}`;

export type DurationInput = number | DurationLiteral;

export function parseDuration(value: DurationInput): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(
        'duration must be a positive finite number of milliseconds',
      );
    }
    return value;
  }

  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) {
    throw new TypeError(`unsupported duration '${value}'`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier =
    unit === 'ms'
      ? 1
      : unit === 's'
        ? 1_000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;
  return amount * multiplier;
}
