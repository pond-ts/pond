import { useState } from 'react';
import {
  ChartContainer,
  ChartRow,
  HeatMap,
  Layers,
  Selector,
  YAxis,
  type SelectInfo,
} from '@pond-ts/charts';
import {
  useSequentialRamp,
  useSiteChartTheme,
} from '@site/src/theme/useSiteChartTheme';
import {
  COMMIT_ROWS,
  COMMIT_ROW_TICKS,
  commitActivity,
  commitActivityRange,
} from './lib/repo-fixtures';
import readout from './lib/tracker-readout.module.css';

const DAY_MS = 86_400_000;

/** The date a hovered cell covers: its week's Sunday (the x bin key) plus
 *  the weekday its row encodes. */
function cellDate(weekKey: number, row: string): string {
  const dow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(row);
  return new Date(weekKey + dow * DAY_MS).toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

/** **This repository, drawn by itself** — the GitHub contribution grid for
 *  pond's own default branch: one cell per UTC day, one row per weekday
 *  (Sunday on top, GitHub's reading), colour carrying the non-merge commit
 *  count. The same wide-series-into-`<HeatMap>` shape as the Niño 3.4 grid,
 *  seven rows instead of forty-five.
 *
 *  `compact` (the card) drops the hover readout line; the docs page keeps
 *  it, fed by `<Selector onHover>` — a real 2-D cell hit, which is what a
 *  grid needs and the 1-D tracker cannot give. */
export default function GalleryContributions({
  width,
  height = 190,
  compact = false,
}: {
  width: number;
  height?: number;
  compact?: boolean;
}) {
  const theme = useSiteChartTheme();
  const ramp = useSequentialRamp();
  const [hit, setHit] = useState<SelectInfo | null>(null);

  return (
    <div style={{ width }}>
      {compact ? null : (
        <div className={readout.readout}>
          {hit === null ? (
            <span className={readout.idle}>
              Point at a cell to read its day and commit count
            </span>
          ) : (
            <>
              <span
                aria-hidden="true"
                style={{
                  width: '0.7rem',
                  height: '0.7rem',
                  borderRadius: 2,
                  background: hit.color,
                  alignSelf: 'center',
                }}
              />
              <span className={readout.date}>
                {cellDate(hit.key as number, hit.label)}
              </span>
              <span className={readout.field}>
                <span className={readout.name}>commits</span>
                {hit.value}
              </span>
            </>
          )}
        </div>
      )}
      <ChartContainer range={commitActivityRange()} width={width} theme={theme}>
        <Selector onHover={setHit}>
          <ChartRow height={height}>
            {/* `label=""` — "dow" is plumbing, not a label; the three
                GitHub-style ticks carry the orientation. */}
            <YAxis id="dow" ticks={COMMIT_ROW_TICKS} label="" width={44} />
            <Layers>
              <HeatMap
                series={commitActivity()}
                columns={COMMIT_ROWS}
                colors={ramp}
                axis="dow"
                id="commits"
              />
            </Layers>
          </ChartRow>
        </Selector>
      </ChartContainer>
    </div>
  );
}
