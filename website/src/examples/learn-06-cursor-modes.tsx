import { useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  LineCursor,
  PointCursor,
  InlineCursor,
  FlagCursor,
  CrosshairCursor,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { singleHostSeries } from './lib/server-metrics';

// One cursor component per mode — mount one to get that cursor.
const CURSORS = {
  line: <LineCursor />,
  point: <PointCursor />,
  inline: <InlineCursor />,
  flag: <FlagCursor />,
  crosshair: <CrosshairCursor />,
} as const;
type CursorMode = keyof typeof CURSORS;
const MODES = Object.keys(CURSORS) as CursorMode[];

export default function LearnCursorModes() {
  const theme = useSiteChartTheme();
  const series = singleHostSeries();
  const [mode, setMode] = useState<CursorMode>('line');

  return (
    <div>
      <div
        style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}
      >
        {MODES.map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--site-surface-border)',
              background:
                m === mode ? 'var(--ifm-color-primary)' : 'transparent',
              color: m === mode ? '#fff' : 'inherit',
              cursor: 'pointer',
              fontSize: 13,
            }}
          >
            {m}
          </button>
        ))}
      </div>
      <ChartContainer range={series.timeRange()} width={560} theme={theme}>
        {CURSORS[mode]}
        <ChartRow height={220}>
          <YAxis id="pct" side="right" format=".0%" />
          <Layers>
            <LineChart series={series} column="cpu" axis="pct" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
