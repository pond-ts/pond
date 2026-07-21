import { TimeSeries } from 'pond-ts';
import {
  ChartContainer,
  ChartRow,
  Layers,
  ScatterChart,
  useChartLegend,
  YAxis,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';

const MINUTE = 60_000;
const BASE = Date.UTC(2026, 0, 12, 9, 0, 0);

/** Two latency series on one axis — the source the custom chip row reads
 *  its current-or-cursor values from. */
function latencies() {
  const rows = Array.from({ length: 80 }, (_, i) => [
    BASE + i * MINUTE,
    90 + 26 * Math.sin(i / 9),
    150 + 30 * Math.sin(i / 7 + 1),
  ]) as [number, number, number][];
  return new TimeSeries({
    name: 'latency',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'p50', kind: 'number' },
      { name: 'p95', kind: 'number' },
    ] as const,
    rows,
  });
}

/** A **custom** legend built on `useChartLegend()`: a horizontal chip row
 *  above the plot (aligned to it via `gutters`), each chip showing its
 *  current-or-cursor value — the hook's `cursorTime` (else the latest
 *  sample) looked up in the consumer's own series. Click a chip to toggle
 *  selection; hover the plot and the values track the cursor. */
export default function ChartsLegendHeadless({ width }: { width: number }) {
  const theme = useSiteChartTheme();
  const series = latencies();

  function ChipRow() {
    const { rows, gutters, cursorTime, hover, select } = useChartLegend();
    // One chart row here → flatten the groups to a flat chip list.
    const items = rows.flatMap((r) => r.items);
    const anySelected = items.some((it) => it.selected);
    // The hook hands over the cursor instant (null when not hovering); the
    // consumer owns the series, so the value lookup is theirs. Each scatter's
    // `id` is its column name, so the item identity keys straight into the data.
    const valueAt = (id: string | undefined): number | undefined => {
      if (id !== 'p50' && id !== 'p95') return undefined;
      const e =
        cursorTime !== null ? series.nearest(cursorTime) : series.last();
      return e?.get(id) as number | undefined;
    };

    return (
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: `0 ${gutters.right + 4}px 8px ${gutters.left + 4}px`,
        }}
      >
        {items.map((item) => {
          const color =
            item.swatch.kind === 'scatter' ? item.swatch.color : '#888';
          const v = valueAt(item.id);
          return (
            <button
              key={
                item.id !== undefined ? `${item.id} ${item.label}` : item.label
              }
              onPointerEnter={() => hover(item)}
              onPointerLeave={() => hover(null)}
              onClick={() => select(item)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                font: '12px system-ui',
                padding: '3px 10px',
                borderRadius: 999,
                border: `1px solid ${
                  item.selected ? color : 'var(--pond-viz-grid)'
                }`,
                background: 'var(--pond-surface)',
                color: 'var(--pond-body)',
                cursor: 'pointer',
                opacity: anySelected && !item.selected ? 0.45 : 1,
                fontWeight: item.selected ? 600 : 400,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: color,
                }}
              />
              {item.label}
              {v !== undefined && (
                <span style={{ opacity: 0.6 }}>{v.toFixed(0)}ms</span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <ChartContainer range={series.timeRange()} width={width} theme={theme}>
      <ChipRow />
      <ChartRow height={200}>
        <YAxis id="ms" label="latency (ms)" width={56} />
        <Layers>
          {/* Scatter carries the `id` (selectable + the value key); `as`
              picks the colour role, `legend` names the row. */}
          <ScatterChart
            series={series}
            column="p50"
            id="p50"
            as="primary"
            legend="p50"
            axis="ms"
          />
          <ScatterChart
            series={series}
            column="p95"
            id="p95"
            as="secondary"
            legend="p95"
            axis="ms"
          />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}
