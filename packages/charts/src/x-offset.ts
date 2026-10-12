import { useMemo } from 'react';
import { ValueSeries } from 'pond-ts';
import type {
  DurationInput,
  SeriesSchema,
  TimeSeries,
  ValueSeriesSchema,
} from 'pond-ts';

/**
 * A layer's `xOffset`: how far after its key each row is **drawn** —
 * milliseconds or a duration string (`'1m'`, `'-30s'`). See
 * `LineChartCommon.xOffset`.
 */
export type XOffset = DurationInput;

/**
 * The series a layer draws, moved by `xOffset`. Every downstream read — the
 * drawn x, the auto-fit extent, session breaks, the tracker's nearest row and
 * dot, the sweep bounds — then sees one consistent axis. The move is pond's
 * `offsetTime`: one pass over the key, value columns shared.
 *
 * `undefined` / `0` return the source unchanged (same reference, so memo deps
 * downstream stay stable). A value series has no time to move, so a non-zero
 * offset on one throws.
 */
export function useXOffset<
  Sr extends TimeSeries<SeriesSchema> | ValueSeries<ValueSeriesSchema>,
>(series: Sr, xOffset: XOffset | undefined, layer: string): Sr {
  return useMemo(() => {
    if (xOffset === undefined || xOffset === 0) return series;
    if (series instanceof ValueSeries) {
      throw new TypeError(
        `<${layer}> xOffset moves a time axis; a ValueSeries has none`,
      );
    }
    return series.offsetTime(xOffset) as Sr;
  }, [series, xOffset, layer]);
}
