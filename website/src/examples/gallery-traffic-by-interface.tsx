import {
  AreaChart,
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { rampRoles } from './lib/ramp-roles';
import {
  stackColumn,
  stackedTraffic,
  stackOrder,
  TRAFFIC_RANGE,
  type Direction,
} from './lib/cern-traffic';

/**
 * The same six hours as the mirrored chart, asked a different question: of the
 * traffic crossing this router, **which interface is it?**
 *
 * A stacked area is drawn from **cumulative** columns, largest first. Each
 * `<AreaChart>` fills from zero to its running total; the next one paints over
 * it, and the strip left visible between two edges is one interface's
 * contribution. That works only because the `seq*` area roles fill **flat** —
 * a graded fill would let the slabs behind show through their neighbours.
 *
 * Seven series is past the point where distinct hues help, so the colours step
 * **tonally** through one brand hue (dark at the bottom, light at the top)
 * rather than introducing seven competing ones.
 *
 * Defaults to **inbound**, where the composition question has an interesting
 * answer — four interfaces carry 10% or more of it. Outbound is 82.5% a single
 * SAP, so its stack is one slab and six slivers: a true picture, and a poor
 * demonstration of stacking.
 */
export default function GalleryTrafficByInterface({
  width,
  phase,
  height = 200,
  direction = 'in',
  legend = false,
}: {
  width: number;
  phase?: number;
  height?: number;
  direction?: Direction;
  legend?: boolean;
}) {
  const theme = useSiteChartTheme();
  const stacked = stackedTraffic(direction);
  const names = stackOrder(direction);
  const roles = rampRoles(names.length);

  const range =
    phase === undefined
      ? TRAFFIC_RANGE
      : scanWindow(TRAFFIC_RANGE[0], TRAFFIC_RANGE[1], 100 * 60_000, phase);

  // Back to front: the biggest running total first (it is the tallest, so it
  // sets the axis), each smaller one drawn over it.
  const order = names.map((_, i) => i).reverse();

  return (
    <ChartContainer range={range} width={width} theme={theme} cursor="line">
      <ChartRow height={height}>
        <YAxis
          id="gbps"
          side="right"
          label="Gbps"
          labelPlacement="top"
          format=",.0f"
          width={52}
        />
        <Layers>
          {order.map((i) => (
            <AreaChart
              key={names[i]}
              series={stacked}
              column={stackColumn(i)}
              as={roles[i]}
              axis="gbps"
              baseline={0}
              legend={names[i]}
            />
          ))}
        </Layers>
      </ChartRow>
      {/* Outside the row: seven entries is a tall box, and in-plot it eats the
          top-left quarter — where the 08:20 burst is. */}
      {legend ? <Legend /> : null}
    </ChartContainer>
  );
}
