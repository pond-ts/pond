/**
 * Axis value formatting — the single formatter shared by an axis's tick labels
 * and the cursor readout, so a value reads the same in both places (the readout
 * "matches the axes"). d3-style: a format **specifier string** (e.g. `'.0%'`,
 * `',.2f'`) is applied through the scale's own `tickFormat` (the same path d3
 * uses for the ticks), a **function** is used verbatim, and `undefined` falls
 * back to the scale's default `tickFormat`.
 */

import type { TimeGrain } from './tickLadder.js';

/**
 * How to format an axis's values — a d3 [format specifier]
 * (https://github.com/d3/d3-format#locale_format) string, or a custom
 * `(value) => string` function. Omit for the scale's d3 default.
 */
export type AxisFormat = string | ((value: number) => string);

/**
 * How to format the **cursor / marker readout** on the x axis
 * ({@link ChartContainerProps.cursorFormat}) — time or value kind. Either:
 *
 * - a d3 specifier **string** applied uniformly: a [time specifier]
 *   (https://github.com/d3/d3-time-format#locale_format) on a time axis
 *   (e.g. `'%b %-d'`), a [number specifier]
 *   (https://github.com/d3/d3-format#locale_format) on a value axis
 *   (e.g. `'+.2f'`); or
 * - a **function** `(value, ctx) => string` — `value` is epoch ms on a time
 *   axis, the data-unit x value on a value axis. On a **time** axis
 *   `ctx.grain` is the axis's resolved coarse {@link TimeGrain}
 *   (`year` … `second`) and `ctx.defaultText` is the library's grain-aware
 *   default readout for that instant — so a consumer can branch on the zoom
 *   level (`grain === 'year' ? … : …`) and pass `defaultText` through for the
 *   grains they don't want to override. On a **value** axis there is no time
 *   grain — `ctx.grain` is `undefined` and `ctx.defaultText` is the
 *   **container's** label-formatter text (`timeFormat`-shaped, else the d3
 *   default; an explicit `<XAxis format>` shapes only that axis's own
 *   channel, never this default).
 *
 * The library hands you the grain because it already resolved it — you never
 * re-derive it from the range.
 */
export type CursorFormat =
  | string
  | ((
      value: number,
      ctx: {
        readonly grain: TimeGrain | undefined;
        readonly defaultText: string;
      },
    ) => string);

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
