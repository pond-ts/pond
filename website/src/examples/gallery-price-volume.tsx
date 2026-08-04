import { useMemo, useState } from 'react';
import {
  AreaChart,
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
  type TrackerInfo,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  marketBars,
  rangeWindow,
  sessionScan,
  sessionWindow,
} from './lib/financial-fixtures';
import { TrackerReadout } from './lib/tracker-readout';

/** The two-row price-and-volume layout every trading screen opens with: price
 *  filled against a dollar axis, share volume on its own axis underneath.
 *  **One** `<ChartContainer>` — so the two rows share the x range, the pan/zoom
 *  and the cursor, while each `<YAxis id>` fits its own scale.
 *
 *  Volume bars are coloured by the bar's own direction (close ≥ open) via
 *  `binColors`, reading the up/down colours **off the theme** rather than
 *  naming hues — the same pair the candles use.
 *
 *  **Interaction.** `panZoom="panZoom"` is drag-to-pan and wheel-to-zoom; there
 *  is no drag-to-zoom gesture (drag-to-select is `cursor="region"`, and
 *  `cursor` takes one value, so it can't coexist with the crosshair). The range
 *  is **controlled** — held here, fed back through `onTimeRangeChange` —
 *  because the layers are handed a series cropped to the view, and an
 *  uncontrolled pan would move the view without moving the crop.
 *
 *  The in-chart crosshair pins its value pill to the axis of whichever row the
 *  pointer is in, one row at a time. Reading *both* quantities for the same
 *  session at once is what `onTrackerChanged` is for, so the strip above the
 *  chart is fed from that.
 *
 *  Prices are **modelled**, not measured — see `lib/financial-fixtures.ts`. */
export default function GalleryPriceVolume({
  width = 680,
  priceHeight = 170,
  volumeHeight = 74,
  phase,
}: {
  width?: number;
  priceHeight?: number;
  volumeHeight?: number;
  phase?: number;
}) {
  const theme = useSiteChartTheme();
  const set = marketBars();
  // A Gallery card is autoplaying a scan; it must not fight a live gesture, so
  // interaction is on only when there's no `phase` driving the view.
  const live = phase === undefined;

  const initial = useMemo(() => sessionWindow(set, 90).range, [set]);
  const [panned, setPanned] = useState<[number, number]>(initial);
  const range = live ? panned : sessionScan(set, 46, phase).range;

  // `range` is the view; `bars` is the set cropped to it, because a `<YAxis>`
  // auto-fits every point of the series it's handed rather than the ones on
  // screen. Re-cropping per range is what keeps the fit honest under a pan.
  const bars = useMemo(() => rangeWindow(set, range), [set, range]);

  // One colour per bar, in the cropped series' order — `binColors[i]` fills
  // bar `i`, so it has to be built from the same series the layer draws.
  const volumeColors = useMemo(() => {
    const open = bars.column('open').toFloat64Array();
    const close = bars.column('close').toFloat64Array();
    const { rising, falling } = theme.candle.default;
    return Array.from(close, (c, i) =>
      c >= open[i]! ? rising.body : falling.body,
    );
  }, [bars, theme]);

  const [tracker, setTracker] = useState<TrackerInfo | null>(null);
  const price = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  });
  const shares = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  });

  return (
    <div style={{ width }}>
      {live ? (
        <TrackerReadout
          tracker={tracker}
          idle={`Hover for ${set.symbol}; drag to pan, wheel to zoom`}
          format={(s) =>
            s.label === 'volume'
              ? shares.format(s.value)
              : price.format(s.value)
          }
        />
      ) : null}
      <ChartContainer
        range={range}
        width={width}
        theme={theme}
        calendar={set.calendar}
        cursor="crosshair"
        panZoom={live ? 'panZoom' : 'none'}
        onTimeRangeChange={setPanned}
        onTrackerChanged={setTracker}
      >
        <ChartRow height={priceHeight}>
          <YAxis id="price" side="right" format={set.priceFormat} width={62} />
          <Layers>
            <AreaChart series={bars} column="close" axis="price" />
          </Layers>
        </ChartRow>
        <ChartRow height={volumeHeight}>
          <YAxis
            id="volume"
            side="right"
            format={set.volumeFormat}
            width={62}
          />
          <Layers>
            <BarChart
              series={bars}
              column="volume"
              axis="volume"
              binColors={volumeColors}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
