import { useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  YAxis,
  type GapMode,
} from '@pond-ts/charts';
import { TimeSeries } from 'pond-ts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';

const N = 48;
const BASE = Date.UTC(2026, 0, 12, 9, 0, 0);
const STEP = 60_000;

/** A sine with a deliberate coast (gap) at indices 14–19, on a **falling
 *  slope** so `step` (flat at the average) reads distinctly from `dashed`
 *  (a diagonal bridge). Missing cells are `undefined` → `NaN` on the column. */
function sineWithGap() {
  const rows: Array<[number, number | undefined]> = [];
  for (let i = 0; i < N; i += 1) {
    const inGap = i >= 14 && i < 20;
    rows.push([BASE + i * STEP, inGap ? undefined : 50 + 34 * Math.sin(i / 5)]);
  }
  return new TimeSeries({
    name: 'gap',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number', required: false },
    ] as const,
    rows: rows as never,
  });
}

const MODES: readonly GapMode[] = ['empty', 'none', 'dashed', 'step', 'fade'];

/** One gap, five renderings — switch the `gaps` mode and watch how the same
 *  coast draws. `empty` (default) breaks honestly; `none` bridges; `dashed` /
 *  `step` add a faint inferred connector; `fade` drops to the baseline. */
export default function ChartsGapModes() {
  const theme = useSiteChartTheme();
  const series = sineWithGap();
  const [mode, setMode] = useState<GapMode>('empty');

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
      <ChartContainer
        range={[BASE, BASE + (N - 1) * STEP]}
        width={560}
        theme={theme}
      >
        <ChartRow height={200}>
          <YAxis id="v" side="right" min={0} max={100} />
          <Layers>
            <LineChart series={series} column="v" axis="v" gaps={mode} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
