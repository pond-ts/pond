import {
  BarChart,
  ChartContainer,
  ChartRow,
  Layers,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { responseTimeDistribution } from './lib/gallery-fixtures';

/** Response-time distribution: a value-axis histogram (`byColumn`, 10ms-wide
 *  bins) — the x axis is inferred from the bins, not declared. */
export default function GalleryHistogram({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const bins = responseTimeDistribution();

  return (
    <ChartContainer range={[0, 280]} width={width} theme={theme}>
      <ChartRow height={220}>
        <YAxis id="count" label="samples" min={0} pad={0.06} width={44} />
        <Layers>
          <BarChart bins={bins} column="count" gap={2} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
