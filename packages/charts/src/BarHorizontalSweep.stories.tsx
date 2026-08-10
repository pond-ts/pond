import { useState } from 'react';
import type { Meta } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { MultiSelector } from './selectors.js';
import type { SelectionEntry, SpanSelection } from './context.js';

/**
 * **The transposed sweep** ([PND-HSWEEP]) — a horizontal `<BarChart>` whose
 * bins run down the screen, swept with a **vertical** drag.
 *
 * It is the same `<MultiSelector>` and the same 1-D cut a vertical bar chart
 * gets; only the axis moved. Drag up or down anywhere in the plot: the band
 * snaps to whole bins, and the horizontal position is deliberately inert
 * (that axis carries the *value*, and a vertical chart's sweep ignores the
 * value axis too).
 *
 * Not yet a full matrix column — the fixture-driven fan-out under
 * `Interactions/MultiSelector/*` still has no horizontal row. This is the
 * capability, visible; the column is the follow-up.
 */
const meta = {
  title: 'Interactions/MultiSelector/BarChart Horizontal',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 0, 1);
const N = 8;

const daily = () =>
  new TimeSeries({
    name: 'svc',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: Array.from({ length: N }, (_, i) => [
      [D0 + i * DAY, D0 + (i + 1) * DAY],
      3 + ((i * 7) % 9),
    ]) as [[number, number], number][],
  });

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);

const isSpan = (e: SelectionEntry): e is SpanSelection =>
  (e as SpanSelection).kind === 'span';

function Demo() {
  const [selected, setSelected] = useState<readonly SelectionEntry[]>([]);
  const readout =
    selected.length === 0
      ? '—'
      : selected
          .map((e) =>
            isSpan(e)
              ? `span [${isoDay(e.x[0])} → ${isoDay(e.x[1])})`
              : isoDay(e.key),
          )
          .join(', ');
  return (
    <div style={{ width: 520, fontFamily: 'system-ui, sans-serif' }}>
      {/* The two axes are swapped from the usual reading, and getting them
          the wrong way round is the first mistake to make here: the SHARED x
          carries the **value** on a horizontal chart, and the bins go on the
          row's own y. No `theme` prop — stories render `defaultTheme`
          (see CLAUDE.md). */}
      <ChartContainer range={[0, 12]} width={520} selected={selected}>
        <MultiSelector
          onSelect={(hits, _mods, span) =>
            setSelected(span === null ? hits : [span])
          }
        />
        <ChartRow height={260}>
          <YAxis id="bins" min={D0} max={D0 + N * DAY} label="" />
          <Layers>
            <BarChart
              series={daily()}
              column="v"
              axis="bins"
              id="svc"
              orientation="horizontal"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
      <div style={{ marginTop: 8, fontSize: 13 }}>selected: {readout}</div>
    </div>
  );
}

/** Drag vertically to sweep whole bins; the band snaps to bin edges. */
export const SweepVertically = { render: () => <Demo /> };
