import { useMemo, useState } from 'react';
import { TimeSeries } from 'pond-ts';
import type { SeriesSchema } from 'pond-ts';
import {
  ChartContainer,
  ChartRow,
  HeatMap,
  Layers,
  Marker,
  YAxis,
  type SelectInfo,
} from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import {
  CENSUS_YEARS,
  MEASLES_CASES,
  MEASLES_STATES,
  MEASLES_YEARS,
  STATE_POPULATION,
} from './lib/measles-samples';
import readout from './lib/tracker-readout.module.css';

/**
 * **ColorBrewer YlGnBu, reversed** — pale yellow at zero through green and blue
 * to near-black at the top. Eight steps, and against a `scale="log"` ramp each
 * one is a factor of roughly 3.7.
 *
 * Hard-coded rather than themed, and it does not flip with the light/dark
 * toggle. A ramp carrying four orders of magnitude *is* a specific set of
 * colours; re-tinting it per theme would change what the reader reads.
 */
const RAMP = [
  '#ffffd9',
  '#edf8b1',
  '#c7e9b4',
  '#7fcdbb',
  '#41b6c4',
  '#1d91c0',
  '#225ea8',
  '#0c2c84',
];

/** Rows bottom → top, so the list reads A→Z downward like the printed original. */
const ROWS = [...MEASLES_STATES].reverse();

/** Year `y` as an epoch ms, so the bins land on a real time axis. */
const yearTime = (y: number) => Date.UTC(y, 0, 1);

/**
 * Population in `year`, interpolated **geometrically** between census anchors.
 *
 * Compound growth, not linear: a state's population multiplies rather than
 * adding a fixed number of people a year, and a straight line visibly undershoots
 * mid-decade in the fast-growing ones. Decennial anchors are enough here because
 * the chart bands on a log scale — a few percent of interpolation error cannot
 * move a cell across a band worth a factor of 3.7.
 */
function populationAt(state: string, year: number): number | null {
  const anchors = STATE_POPULATION[state];
  if (anchors === undefined) return null;
  let lo: [number, number] | null = null;
  let hi: [number, number] | null = null;
  for (let i = 0; i < CENSUS_YEARS.length; i += 1) {
    const v = anchors[i];
    if (v === null || v === undefined) continue;
    const cy = CENSUS_YEARS[i]!;
    if (cy <= year) lo = [cy, v];
    if (cy >= year && hi === null) hi = [cy, v];
  }
  if (lo === null || hi === null) return null;
  if (lo[0] === hi[0]) return lo[1];
  const f = (year - lo[0]) / (hi[0] - lo[0]);
  return lo[1] * (hi[1] / lo[1]) ** f;
}

/**
 * **US measles, by state and year** — the chart that made the case for
 * vaccination, rebuilt on pond's own primitives.
 *
 * One row per state, one cell per year, colour carrying **reported cases per
 * 100,000 people**. The form is Tynan DeBold and Dov Friedman's 2015 Wall
 * Street Journal graphic; this reconstruction follows Our World in Data's, and
 * is not a reproduction of either — the window is 1921–2001, which is what the
 * Project Tycho record covers.
 *
 * Three things about the chart are doing real work:
 *
 * - **`scale="log"`.** Incidence runs from ~2,900 per 100k to zero. Linear
 *   banding over eight colours would put everything below ~360 in one band —
 *   the whole post-1965 record, which is the half that carries the finding.
 * - **`noData="hatch"`.** 400 state-years are *no data*, not *no cases*, and on
 *   a pale ramp painting nothing would read as the bottom of the scale. Alaska
 *   and Hawaii are the obvious ones; the late record is full of real zeros that
 *   must not look the same.
 * - **The markers** are the argument: 1963, 1971, 1980.
 */
export default function GalleryMeasles({
  width,
  height = 620,
}: {
  width: number;
  height?: number;
}) {
  const siteTheme = useSiteChartTheme();
  const [hit, setHit] = useState<SelectInfo | null>(null);

  // The three dates ARE the argument, so they have to survive a field of
  // saturated blue. Two things were making them recede: the site's annotation
  // colour is a warm orange that sits close to the ramp's pale end, and the
  // depth ramp draws a resting mark at 0.4 alpha — sensible when annotations
  // are secondary to a line, wrong when they carry the finding. A crimson is
  // the most separable hue available against a yellow-to-blue ramp, and the
  // flatter ramp keeps a resting marker legible while still letting a
  // selected one step forward.
  const theme = useMemo(
    () => ({
      ...siteTheme,
      annotation: {
        ...siteTheme.annotation,
        color: '#d81e5b',
        depth: [1, 0.95, 0.85] as [number, number, number],
      },
    }),
    [siteTheme],
  );

  const series = useMemo<TimeSeries<SeriesSchema>>(() => {
    const columns: Record<string, (number | null)[]> = {
      time: MEASLES_YEARS.map(yearTime),
    };
    for (const state of ROWS) {
      const counts = MEASLES_CASES[state] ?? [];
      columns[state] = MEASLES_YEARS.map((year, i) => {
        const n = counts[i];
        if (n === null || n === undefined) return null; // no data, stays a hole
        const p = populationAt(state, year);
        return p === null ? null : (n / p) * 100_000;
      });
    }
    return TimeSeries.fromColumns({
      name: 'measles',
      schema: [
        { name: 'time', kind: 'time' },
        ...ROWS.map((s) => ({ name: s, kind: 'number' as const })),
      ] as const,
      columns,
    });
  }, []);

  const first = yearTime(MEASLES_YEARS[0]!);
  const last = yearTime(MEASLES_YEARS[MEASLES_YEARS.length - 1]! + 1);

  return (
    <div style={{ width }}>
      <div className={readout.readout}>
        {hit === null ? (
          <span className={readout.idle}>
            Point at a cell to read its state, year and incidence
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
            <span className={readout.date}>{hit.label}</span>
            <span className={readout.field}>
              <span className={readout.name}>year</span>
              {new Date(hit.key as number).getUTCFullYear()}
            </span>
            <span className={readout.field}>
              <span className={readout.name}>per 100k</span>
              {hit.value < 1 ? hit.value.toFixed(2) : hit.value.toFixed(0)}
            </span>
          </>
        )}
      </div>

      <ChartContainer
        range={[first, last]}
        width={width}
        theme={theme}
        // The cell outline answers both axes; a shared vertical line would only
        // answer x, and on a grid that is a second, weaker cursor.
        cursor="none"
        onHover={setHit}
      >
        <ChartRow height={height}>
          <YAxis id="state" label="" width={92} />
          <Layers>
            <HeatMap
              series={series}
              columns={ROWS}
              colors={RAMP}
              scale="log"
              noData="hatch"
              // Pinned, so the colours mean the same thing at every zoom and
              // the ramp's floor sits exactly on zero.
              domain={[0, 3000]}
              axis="state"
              id="measles"
            />
            <Marker at={yearTime(1963)} label="1963 · vaccine licensed" />
            <Marker at={yearTime(1971)} label="1971 · MMR" />
            <Marker at={yearTime(1980)} label="1980 · school mandates" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </div>
  );
}
