import { useMemo } from 'react';
import { normalizeThresholds, type BandLadder } from './bars.js';
import { isDev } from './dev.js';

/**
 * Resolve a component's `thresholds` / `bandColors` props against its theme
 * role's band ramp into a {@link BandLadder} — or `undefined` when there is no
 * usable ladder, so the caller keeps its flat path.
 *
 * Extracted from `<BarChart>`'s [PND-BANDBAR2] block verbatim when
 * `<AreaChart thresholds>` arrived ([PND-BANDAREA]): the resolution rules and
 * every dev warning are one contract across banded marks, differing only in
 * the component named by the warning text.
 *
 * Resolved once here rather than per mark per frame: normalize the breakpoints
 * (sort, drop non-finite / non-positive), then pair them with `bandColors` →
 * the role's `bands`. Everything that can go wrong with the pairing is a
 * *silent* wrong-looking chart, so each case dev-warns — this feature exists
 * because a quietly-unbanded mark was the workaround's failure mode.
 *
 * The two array props are **value-compared** rather than identity-compared:
 * `thresholds={[1, 2]}` inline is the documented usage and the shape every
 * story and doc example uses — and a fresh array each render would rebuild
 * the ladder, hence the caller's layer entry, hence a `registerLayer` call
 * **every render**. That is a repaint treadmill, not just a noisy warning.
 * The same value-compare-on-registration reasoning `<YAxis ticks>` applies.
 *
 * A short colour supply pads with `styleFill` (the role's flat fill) so the
 * draw path can index freely; `undefined` comes back only when there are no
 * usable breakpoints or no colours at all.
 */
export function useBandLadder(
  component: 'BarChart' | 'AreaChart',
  thresholds: readonly number[] | undefined,
  bandColors: readonly string[] | undefined,
  styleBands: readonly string[] | undefined,
  styleFill: string,
): BandLadder | undefined {
  const thresholdKey = thresholds === undefined ? '' : thresholds.join(',');
  const bandColorKey = bandColors === undefined ? '' : bandColors.join(',');
  return useMemo<BandLadder | undefined>(() => {
    const steps = normalizeThresholds(thresholds);
    if (steps === null) {
      if (isDev && thresholds !== undefined && thresholds.length > 0) {
        console.warn(
          `<${component} thresholds>: no usable breakpoints, so no banding ` +
            'was applied — each must be finite and greater than zero. The ' +
            'chart draws in the flat fill.',
        );
      }
      return undefined;
    }
    // Some, but not all, entries dropped. Silently banding on a subset of what
    // the caller wrote is exactly the class of quiet wrongness this feature is
    // meant to remove, so say so.
    if (isDev && thresholds !== undefined && steps.length < thresholds.length) {
      console.warn(
        `<${component} thresholds>: dropped ${thresholds.length - steps.length} ` +
          'breakpoint(s) that were not finite and greater than zero. The ' +
          'ladder is walked on the magnitude and mirrored onto whichever side ' +
          `of zero the value is on, so a negative breakpoint has no meaning; ` +
          `banding on [${steps.join(', ')}].`,
      );
    }
    const want = steps.length + 1;
    const supplied = bandColors ?? styleBands;
    if (supplied === undefined || supplied.length === 0) {
      if (isDev) {
        console.warn(
          `<${component} thresholds>: ${steps.length} breakpoint(s) need ` +
            `${want} band colours, but neither \`bandColors\` nor the theme ` +
            `role’s \`bands\` supplies any. The chart draws in the flat fill.`,
        );
      }
      return undefined;
    }
    if (supplied.length < want && isDev) {
      console.warn(
        `<${component} thresholds>: ${steps.length} breakpoint(s) need ` +
          `${want} band colours but only ${supplied.length} were supplied; ` +
          'bands above the last colour fall back to the flat fill.',
      );
    }
    // Pad a short ladder with the flat fill so the draw path can index freely.
    const resolved =
      supplied.length >= want
        ? supplied.slice(0, want)
        : [
            ...supplied,
            ...Array.from({ length: want - supplied.length }, () => styleFill),
          ];
    return { thresholds: steps, colors: resolved };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `thresholdKey` /
    // `bandColorKey` are the value-compared stand-ins for the array props.
  }, [component, thresholdKey, bandColorKey, styleBands, styleFill]);
}
