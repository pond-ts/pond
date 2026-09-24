import {
  Baseline,
  Candlestick,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  CrosshairCursor,
} from '@pond-ts/charts';
import '@pond-ts/financial/fluent';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { marketBars, sessionWindow } from './lib/financial-fixtures';

/** Oscillators live in their own rows. `.rsi()` and `.macd()` append columns
 *  to the same bar series the candles read, so each `<ChartRow>` below is just a
 *  different column of one `TimeSeries` on its own y-axis — RSI on a fixed
 *  0–100 axis with its 30/70 baselines, MACD line + signal on an auto-scaled
 *  one. The warm-up rows are `undefined`, which the line renders as a clean
 *  gap at the left rather than a spike from zero.
 *
 *  Prices are **modelled**, not measured — see `lib/financial-fixtures.ts`.
 *  This window is the 160 sessions spanning the year's −23.5% drawdown,
 *  which is where an oscillator has something to say: RSI drops below 30 in
 *  two clusters during the sell-off and above 70 on the run-up either side,
 *  and the MACD line crosses its signal four times (measured, not eyeballed —
 *  the numbers are in the PR that added this example). */
export default function ChartsFinancialOscillators({
  width,
}: {
  width: number;
}) {
  const theme = useSiteChartTheme();
  const set = marketBars();
  const { range, bars } = sessionWindow(set, 160, 40);
  const study = bars
    .rsi({ period: 14 })
    .macd({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      calendar={set.calendar}
    >
      <CrosshairCursor />
      <ChartRow height={170}>
        <YAxis id="price" side="right" format={set.priceFormat} width={62} />
        <Layers>
          <Candlestick series={bars} as={set.symbol} showOHLC gap={1} />
        </Layers>
      </ChartRow>
      <ChartRow height={90}>
        <YAxis
          id="rsi"
          side="right"
          format=".0f"
          min={0}
          max={100}
          width={62}
        />
        <Layers>
          <Baseline value={70} axis="rsi" label="70" />
          <Baseline value={30} axis="rsi" label="30" />
          <LineChart series={study} column="rsi" axis="rsi" as="rsi" />
        </Layers>
      </ChartRow>
      <ChartRow height={90}>
        <YAxis id="macd" side="right" format=".2f" width={62} />
        <Layers>
          <Baseline value={0} axis="macd" />
          <LineChart series={study} column="macdLine" axis="macd" as="macd" />
          <LineChart
            series={study}
            column="macdSignal"
            axis="macd"
            as="secondary"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
