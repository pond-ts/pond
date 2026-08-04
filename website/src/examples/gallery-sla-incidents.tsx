import { useState } from 'react';
import {
  AreaChart,
  Baseline,
  ChartContainer,
  ChartRow,
  Layers,
  LineChart,
  Marker,
  Region,
  YAxis,
} from '@pond-ts/charts';
import { scanWindow } from '@site/src/lib/autoplay';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { errorBudget, SLA_MARKS, SLA_RANGE } from './lib/ops-fixtures';

/**
 * A week of error rate over the error budget it spent — the two rows an SLA
 * review argues over — annotated with everything that happened: the incident
 * windows (`Region`), the deploys (`Marker`), and the objective itself
 * (`Baseline`).
 *
 * Annotations are a **second register**, deliberately one hue that no series
 * ever takes, so a placed mark is never mistaken for data.
 *
 * With `editable` the marks become draggable: the container's
 * `editAnnotations` turns the affordances on, and each mark's `onChange`
 * reports where it was dragged to. This example holds the incident window and
 * the objective in React state and writes the edits straight back — which is
 * the whole contract. Nothing moves unless you store it.
 */
export default function GallerySlaIncidents({
  width,
  phase,
  height = 210,
  editable = false,
  showBudget = true,
}: {
  width: number;
  phase?: number;
  /** Total height of the plot rows — split ~62/38 when the budget row shows. */
  height?: number;
  editable?: boolean;
  showBudget?: boolean;
}) {
  const theme = useSiteChartTheme();
  const series = errorBudget();

  const [incident, setIncident] = useState({
    from: SLA_MARKS.incidentFrom,
    to: SLA_MARKS.incidentTo,
  });
  const [slo, setSlo] = useState<number>(SLA_MARKS.sloErrorRate);

  const range =
    phase === undefined
      ? SLA_RANGE
      : // Three days of the week, sweeping, so the Tuesday incident arrives.
        scanWindow(SLA_RANGE[0], SLA_RANGE[1], 3 * 86_400_000, phase);

  return (
    <ChartContainer
      range={range}
      width={width}
      theme={theme}
      cursor={editable ? 'none' : 'line'}
      editAnnotations={editable}
    >
      <ChartRow height={showBudget ? Math.round(height * 0.62) : height}>
        <YAxis id="err" side="right" format=".2%" width={52} />
        <Layers>
          <LineChart series={series} column="errorRate" axis="err" />
          <Region
            from={incident.from}
            to={incident.to}
            label="bad deploy"
            onChange={editable ? setIncident : undefined}
          />
          <Region
            from={SLA_MARKS.wobbleFrom}
            to={SLA_MARKS.wobbleTo}
            label="DNS"
          />
          {SLA_MARKS.deploys.map((at, i) => (
            <Marker key={at} at={at} label={`deploy ${i + 1}`} />
          ))}
          <Baseline
            value={slo}
            axis="err"
            label="99.9% objective"
            onChange={editable ? setSlo : undefined}
          />
        </Layers>
      </ChartRow>
      {showBudget ? (
        <ChartRow height={height - Math.round(height * 0.62)}>
          <YAxis id="budget" side="right" format=".0%" width={52} min={0} />
          <Layers>
            <AreaChart series={series} column="budgetLeft" axis="budget" />
          </Layers>
        </ChartRow>
      ) : null}
    </ChartContainer>
  );
}
