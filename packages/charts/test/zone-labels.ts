import { identityProvider, scaleTradingTime } from '../src/tradingTimeScale.js';

/**
 * Derive-don't-pin helpers for time-axis assertions ([PND-TZTEST]).
 *
 * A charts test must never hard-code a formatted date literal: the axis
 * formats in the runner's zone unless told otherwise, so a literal encodes
 * `local == <the author's zone>` and fails elsewhere (#540 finding 4, #721 —
 * CI now runs a `TZ=Australia/Sydney` leg for exactly this). Instead, ask the
 * same code path the renderer uses what it would print.
 */

/**
 * What the time axis prints for `ms` under the d3 time specifier `spec` in
 * `timeZone` (`undefined` = the runner's local zone, as a container with no
 * `timeZone` renders). Goes through `scaleTradingTime(...).tickFormat`, the
 * exact formatter the axis and pills use.
 */
export function expectedLabel(
  ms: number,
  spec: string,
  timeZone?: string,
): string {
  return scaleTradingTime(identityProvider({ timeZone }), { timeZone })
    .domain([ms - 1, ms + 1])
    .tickFormat(
      1,
      spec,
    )(new Date(ms));
}

/**
 * The tick / band / pill texts currently in a rendered container: every leaf
 * element whose text looks like an axis label (`14:00`, `Mar 9`, a bare
 * day-of-month, a month or year), as a set. For "the labels changed / are
 * back" assertions that need no literal at all.
 */
export function axisLabels(root: ParentNode): Set<string> {
  return new Set(
    Array.from(root.querySelectorAll('*'))
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent ?? '')
      .filter((t) =>
        /^\d{2}:\d{2}(:\d{2})?$|^[A-Z][a-z]{2,8}( \d{1,2}(, \d{4})?)?$|^\d{1,2}$|^\d{4}$/.test(
          t,
        ),
      ),
  );
}
