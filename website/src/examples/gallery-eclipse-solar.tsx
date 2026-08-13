import { useState } from 'react';
import {
  Baseline,
  ChartContainer,
  ChartRow,
  Layers,
  Legend,
  LineChart,
  Marker,
  Region,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  ECLIPSE_BASELINE_DAYS,
  ECLIPSE_MARKS,
  eclipseSolar,
  eclipseSolarRange,
} from './lib/energy-fixtures';

const HOUR = 3_600_000;

type Mode = 'days' | 'anomaly';

/** The three ordinary days' mean, per quarter-hour, plus every curve's
 *  distance from it — the whole baseline is pond column math on the
 *  four-day fixture. `collapse` runs one reducer across named columns per
 *  row; `{ append: true }` keeps the inputs, so each step adds a column and
 *  one chain feeds both views. */
function withBaseline() {
  return eclipseSolar()
    .collapse(
      ['aug09', 'aug10', 'aug11'],
      'baseline',
      (v) => (v.aug09 + v.aug10 + v.aug11) / 3,
      { append: true },
    )
    .collapse(
      ['eclipseDay', 'baseline'],
      'delta',
      (v) => v.eclipseDay - v.baseline,
      { append: true },
    )
    .collapse(
      ['aug09', 'baseline'],
      'aug09Delta',
      (v) => v.aug09 - v.baseline,
      { append: true },
    )
    .collapse(
      ['aug10', 'baseline'],
      'aug10Delta',
      (v) => v.aug10 - v.baseline,
      { append: true },
    )
    .collapse(
      ['aug11', 'baseline'],
      'aug11Delta',
      (v) => v.aug11 - v.baseline,
      { append: true },
    );
}

/** Spain's solar generation through the 12 August 2026 eclipse, judged
 *  against the three days before it at the same clock time — with two ways
 *  of looking, one pond pipeline apart:
 *
 *  - **days** — the raw spaghetti: three grey evenings and the one the Moon
 *    interrupted. Honest about how alike the days are (and aren't: midday
 *    cloud moves the pack ±3 GW).
 *  - **anomaly** — the three days collapse into their mean, the axis becomes
 *    distance from it, and eclipse day is drawn relative to that baseline:
 *    −4.34 GW at 20:15, while the grey residuals show the sunset ramp is
 *    normally repeatable to a few hundred MW.
 *
 *  Every ordinary-day curve is plotted 1–3 days forward of when it happened
 *  (the same-clock-time overlay); the legend and page say so. The card
 *  renders the spaghetti with a 7-hour sweeping window; `controls` puts the
 *  mode toggle above the chart on the docs page. */
export default function GalleryEclipseSolar({
  width,
  phase,
  height = 220,
  legend = false,
  controls = false,
}: {
  width: number;
  phase?: number;
  height?: number;
  legend?: boolean;
  controls?: boolean;
}) {
  const theme = useSiteChartTheme();
  const [mode, setMode] = useState<Mode>('days');
  const series = withBaseline();
  const [begin, end] = eclipseSolarRange();

  const range: [number, number] =
    phase === undefined
      ? [begin, end]
      : scanWindow(begin, end, 7 * HOUR, phase);

  const anomaly = mode === 'anomaly';

  return (
    <div>
      {controls ? (
        <div
          style={{
            display: 'flex',
            gap: 6,
            marginBottom: 10,
            flexWrap: 'wrap',
          }}
        >
          {(
            [
              ['days', 'Four days'],
              ['anomaly', 'Anomaly vs baseline'],
            ] as const
          ).map(([m, title]) => (
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
              {title}
            </button>
          ))}
        </div>
      ) : null}
      <ChartContainer
        range={range}
        width={width}
        theme={theme}
        cursor="crosshair"
      >
        <ChartRow height={height}>
          {anomaly ? (
            <YAxis id="gw" label="GW vs baseline" format="+.1f" width={56} />
          ) : (
            <YAxis id="gw" label="GW" format=".1f" min={0} width={56} />
          )}
          <Layers>
            {/* The ordinary days go first so eclipse day draws over them —
                `muted` because the reference pack is context, not data of
                equal standing. In anomaly mode the same three days become
                their own residuals: the envelope the anomaly is judged
                against. */}
            {ECLIPSE_BASELINE_DAYS.map((column, i) => (
              <LineChart
                key={column}
                series={series}
                column={anomaly ? `${column}Delta` : column}
                axis="gw"
                as="muted"
                legend={i === 0 ? '9–11 Aug (shifted)' : false}
              />
            ))}
            <LineChart
              series={series}
              column={anomaly ? 'delta' : 'eclipseDay'}
              axis="gw"
              legend={anomaly ? 'Eclipse day − baseline' : 'Eclipse day'}
            />
            {anomaly ? (
              <Baseline value={0} axis="gw" label="3-day baseline" />
            ) : null}
            <Region
              from={ECLIPSE_MARKS.partialsBegin}
              to={ECLIPSE_MARKS.partialsEnd}
              label="eclipse"
            />
            <Marker at={ECLIPSE_MARKS.totality} label="totality" />
          </Layers>
        </ChartRow>
        {legend ? <Legend placement="top-left" /> : null}
      </ChartContainer>
    </div>
  );
}
