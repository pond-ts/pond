import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  Zone,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  AIR_RANGE,
  AQI_BANDS,
  aqiBandTheme,
  airQuality,
} from './lib/science-fixtures';

/** A week of hourly PM2.5 at a Bronx monitor through the June 2023 Canadian
 *  wildfire smoke, read against the US AQI categories as `<Zone>` bands.
 *
 *  Threshold bands are what turn a concentration into a judgement: 40 µg/m³
 *  means nothing until you can see which category it sits in. Drawn as bands
 *  rather than as boundary lines, the category is a **colour** — legible at any
 *  size, and legible without reading a label — so the card can carry the whole
 *  scale where five labelled baselines could only fit the three the smoke
 *  actually crossed.
 *
 *  The palette lives in the theme (`aqiBandTheme`), beside the breakpoints it
 *  colours: a band names its category with `role`, never a colour. The top band
 *  is open-ended (`to: Infinity`) and the axis auto-fits the data, so the
 *  categories above the smoke's peak cull themselves — the table drives the
 *  chart rather than a hand-pruned copy of it.
 *
 *  `gaps="dashed"` bridges the one hour the monitor didn't report with a faint
 *  dashed connector instead of silently interpolating it. */
export default function GalleryAirQuality({
  width = 720,
  phase,
  height = 210,
}: {
  width?: number;
  phase?: number;
  height?: number;
}) {
  const theme = aqiBandTheme(useSiteChartTheme());
  const air = airQuality();

  const range =
    phase === undefined
      ? AIR_RANGE
      : scanWindow(AIR_RANGE[0], AIR_RANGE[1], 72 * 3_600_000, phase);

  // Every band draws at both sizes; only the *names* are size-dependent. Six
  // chips stacked down a 190px card is the thicket the labelled baselines were
  // — but the bands themselves cost nothing at that size, because a category
  // you read as a colour needs no room. (`phase` is the Gallery card's clock —
  // its absence means this is the full-size embed.)
  const labelled = phase === undefined;

  return (
    <ChartContainer range={range} width={width} theme={theme}>
      <ChartRow height={height}>
        <YAxis id="pm" label="PM2.5 (µg/m³)" format=",.0f" min={0} width={62} />
        <Layers>
          {AQI_BANDS.map((b) => (
            <Zone
              key={b.role}
              from={b.from}
              to={b.to}
              axis="pm"
              role={b.role}
              label={labelled ? b.label : undefined}
            />
          ))}
          <AreaChart series={air} column="pm25" axis="pm" gaps="dashed" />
          <LineChart series={air} column="pm25" axis="pm" gaps="dashed" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
