/**
 * Axis value formatting — the single formatter shared by an axis's tick labels
 * and the cursor readout, so a value reads the same in both places (the readout
 * "matches the axes"). d3-style: a format **specifier string** (e.g. `'.0%'`,
 * `',.2f'`) is applied through the scale's own `tickFormat` (the same path d3
 * uses for the ticks), a **function** is used verbatim, and `undefined` falls
 * back to the scale's default `tickFormat`.
 */

/**
 * How to format an axis's values — a d3 [format specifier]
 * (https://github.com/d3/d3-format#locale_format) string, or a custom
 * `(value) => string` function. Omit for the scale's d3 default.
 */
export type AxisFormat = string | ((value: number) => string);

/** The slice of a d3 scale {@link resolveAxisFormat} needs — `tickFormat` with an
 *  optional specifier. A d3 `ScaleLinear` / `ScaleTime` satisfies it. */
interface Tickable {
  tickFormat(count: number, specifier?: string): (value: number) => string;
}

/**
 * Resolve an {@link AxisFormat} (or `undefined`) to a `(value) => string`
 * formatter, given the `scale` it formats against and the axis `count` (so the
 * default formatter is calibrated to the tick density, exactly as the axis is):
 *
 * - a **function** → used as-is (the scale is ignored);
 * - a **specifier string** → `scale.tickFormat(count, specifier)` — d3 applies
 *   the specifier, so the readout matches ticks formatted the same way;
 * - **`undefined`** → `scale.tickFormat(count)` — the scale's default.
 */
export function resolveAxisFormat(
  scale: Tickable,
  count: number,
  format: AxisFormat | undefined,
): (value: number) => string {
  if (typeof format === 'function') return format;
  return format !== undefined
    ? scale.tickFormat(count, format)
    : scale.tickFormat(count);
}
