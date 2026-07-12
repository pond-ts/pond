import {
  Candlestick,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  demoCalendar,
  demoDailyBars,
  demoRange,
} from './lib/financial-fixtures';

export default function FinancialCalendarChart() {
  const theme = useSiteChartTheme();
  const cal = demoCalendar();
  const series = demoDailyBars(cal);

  return (
    <ChartContainer
      range={demoRange(cal)}
      width={560}
      theme={theme}
      calendar={cal}
      cursor="crosshair"
    >
      <ChartRow height={220}>
        <YAxis id="price" side="right" format="$,.0f" width={50} />
        <Layers>
          <Candlestick series={series} as="demo" showOHLC />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
