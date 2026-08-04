import { useMemo } from 'react';
import { BarList } from '@pond-ts/charts';
import { useSiteChartTheme } from '@site/src/theme/useSiteChartTheme';
import { marketBars } from './lib/financial-fixtures';
import styles from './gallery-volume-list.module.css';

/** The year's heaviest sessions, as a `<BarList>` rather than a table of
 *  numbers. Rows here are **entities** (one session each) rather than buckets
 *  on a time axis, which is exactly the case the list family exists for — the
 *  in-plot histogram is still `<BarChart orientation="horizontal">`.
 *
 *  Two things it demonstrates beyond the bar: an `after` cell carrying a
 *  second, differently-scaled quantity (the session's return, which has no
 *  business sharing the volume scale), and a `<ListMarker>` for the year's
 *  median volume — the list-family counterpart of `<Baseline>`, drawn in the
 *  annotation register rather than a data hue.
 *
 *  Prices are **modelled**, not measured — see `lib/financial-fixtures.ts`. */
export default function GalleryVolumeList({ count = 8 }: { count?: number }) {
  const theme = useSiteChartTheme();
  const set = marketBars();

  const { rows, median } = useMemo(() => {
    // Bars are point-keyed at each session's open and index-aligned with the
    // calendar, so the session list is the row's date without touching the key
    // column.
    const times = set.calendar.sessions().map((s) => s.open);
    const open = set.bars.column('open').toFloat64Array();
    const close = set.bars.column('close').toFloat64Array();
    const volume = set.bars.column('volume').toFloat64Array();

    const sorted = Float64Array.from(volume).sort();
    const mid = sorted.length >> 1;
    const med =
      sorted.length % 2 === 1
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;

    const fmt = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      timeZone: 'America/New_York',
    });

    const byVolume = Array.from(volume, (v, i) => i)
      .sort((a, b) => volume[b]! - volume[a]!)
      .slice(0, count)
      .map((i) => ({
        key: String(times[i]),
        label: fmt.format(new Date(times[i]!)),
        values: {
          volume: volume[i]!,
          ret: close[i]! / open[i]! - 1,
        },
      }));

    return { rows: byVolume, median: med };
  }, [set, count]);

  const pct = new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: 'exceptZero',
  });
  const shares = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  });

  return (
    <div className={styles.wrap}>
      <BarList
        rows={rows}
        theme={theme}
        columns={[{ column: 'volume' }]}
        sortBy="volume"
        sortDirection="desc"
        divided
        markers={[{ value: median, label: 'median session' }]}
        after={[
          {
            key: 'volume',
            align: 'right',
            render: (row) => shares.format(row.values.volume as number),
          },
          {
            key: 'ret',
            align: 'right',
            render: (row) => pct.format(row.values.ret as number),
          },
        ]}
      />
    </div>
  );
}
