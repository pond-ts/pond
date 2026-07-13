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

/** The slice of a d3 **time** scale {@link resolveTimeFormat} needs. A d3
 *  `ScaleTime` satisfies it; its formatter takes a `Date`. */
interface TimeTickable {
  tickFormat(count?: number, specifier?: string): (date: Date) => string;
}

/**
 * The time analog of {@link resolveAxisFormat} — resolve an {@link AxisFormat}
 * (here the string is a d3 [time specifier](https://github.com/d3/d3-time-format#locale_format),
 * e.g. `'%H:%M'`) to an `(epochMs) => string` formatter against a d3 `scaleTime`,
 * so the cursor-time readout matches the time-axis ticks:
 *
 * - a **function** → used as-is (called with epoch ms);
 * - a **specifier string** → `scale.tickFormat(count, specifier)` (one format for
 *   every value), wrapped to take epoch ms;
 * - **`undefined`** → `scale.tickFormat(count)` — the scale's default. On a d3
 *   `scaleTime` that is the **multi-scale** time format (which ignores `count`);
 *   a trading-time scale picks its **anchor grain** from `count`, so passing the
 *   axis's count here is what keeps the labels on the same grain as the ticks.
 *
 * The cursor time is epoch ms, so the resolved formatter wraps the d3 `Date`
 * formatter in `new Date(ms)`.
 */
export function resolveTimeFormat(
  scale: TimeTickable,
  count: number,
  format: AxisFormat | undefined,
): (epochMs: number) => string {
  if (typeof format === 'function') return format;
  const tf =
    format !== undefined
      ? scale.tickFormat(count, format)
      : scale.tickFormat(count);
  return (ms) => tf(new Date(ms));
}
