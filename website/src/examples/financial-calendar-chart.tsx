import {
  Candlestick,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { marketBars, sessionWindow } from './lib/financial-fixtures';

export default function FinancialCalendarChart() {
  const theme = useSiteChartTheme();
  const set = marketBars();
  const { range, bars } = sessionWindow(set, 30);

  return (
    <ChartContainer
      range={range}
      width={560}
      theme={theme}
      calendar={set.calendar}
      cursor="crosshair"
    >
      <ChartRow height={220}>
        <YAxis id="price" side="right" format="$,.0f" width={50} />
        <Layers>
          <Candlestick series={bars} as={set.symbol} showOHLC />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
