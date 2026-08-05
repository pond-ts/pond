import type { TrackerInfo, TrackerSample } from '@pond-ts/charts';
import styles from './tracker-readout.module.css';

/**
 * An **off-chart readout** driven by `<ChartContainer onTrackerChanged>`.
 *
 * Why the Gallery's finance charts need one. `cursor="crosshair"` draws a
 * *single* reticle per row — the shared vertical line, a dot, and **one** value
 * pill pinned to that row's y-axis. It is not a per-series fan-out: a row with
 * a band, a middle line and a candle still gets one pill, and a two-row chart
 * reads whichever row the pointer is in. Anything that needs *several* layers'
 * values at the same instant has to come off the chart, and `onTrackerChanged`
 * is the door: a `TrackerInfo` of `{ time, values }` where `values` carries one
 * {@link TrackerSample} per layer, each labelled with the series identity
 * (`as` ?? the column name) and already snapped to the cursor's sample.
 *
 * This component renders **every** sample the tracker reports, in the order the
 * chart reports them, rather than a hand-picked list — so it can't quietly
 * drift out of step with the layers above it.
 */
export function TrackerReadout({
  tracker,
  format,
  idle,
  only,
  rename,
}: {
  tracker: TrackerInfo | null;
  /** Render one sample's value. Defaults to a plain 2-dp number. */
  format?: (sample: TrackerSample) => string;
  /** Placeholder shown before the pointer has entered the chart. */
  idle: string;
  /** Optional allow-list of labels, in display order. Omitted ⇒ all of them. */
  only?: readonly string[];
  /**
   * Display names for labels. **A `TrackerSample.label` is the layer's `as`
   * value** — which is a *theme role* (`inner`, `secondary`), not a data name,
   * so a chart styled by role reports `secondary $142.99` and the reader has
   * no idea which column that is. Map them here.
   */
  rename?: Readonly<Record<string, string>>;
}) {
  const date = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    timeZone: 'America/New_York',
  });

  if (tracker === null) {
    return (
      <div className={styles.readout}>
        <span className={styles.idle}>{idle}</span>
      </div>
    );
  }

  const samples =
    only === undefined
      ? tracker.values
      : only
          .map((label) => tracker.values.find((v) => v.label === label))
          .filter((v): v is TrackerSample => v !== undefined);

  return (
    <div className={styles.readout}>
      <span className={styles.date}>{date.format(tracker.time)}</span>
      {samples.map((sample) => (
        <span className={styles.field} key={sample.label}>
          <span className={styles.name}>
            {rename?.[sample.label] ?? sample.label}
          </span>
          {format ? format(sample) : sample.value.toFixed(2)}
        </span>
      ))}
    </div>
  );
}
