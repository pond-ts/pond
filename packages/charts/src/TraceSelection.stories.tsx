import { useState } from 'react';
import type { Meta } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { AreaChart } from './AreaChart.js';
import { YAxis } from './YAxis.js';
import { MultiSelector } from './selectors.js';
import { isSpanSelection, sameMark } from './span.js';
import type { SelectionEntry } from './context.js';

/**
 * **Selection on a continuous trace** ([PND-TRACESEL]) — the last two columns
 * of the selection matrix, and the ones whose currency had to be decided rather
 * than copied.
 *
 * A trace has **no marks**, and every choice here follows from taking that
 * seriously:
 *
 * - a **sweep** commits a `SpanSelection` with **no hits**. The span _is_ the
 *   selection. A trace's samples are usually undrawn and there are several per
 *   pixel, so "the samples you swept" is a set you never expressed — take the
 *   span and slice your own series with it, which is one call in pond;
 * - a **click** commits a **series-scoped** entry — `key`/`value` are `NaN`
 *   because no sample was selected, plus a stable `mark` so re-clicking
 *   deselects;
 * - the brush band **is** the live preview, because there are no marks to light.
 *
 * No `theme` prop — these render `defaultTheme` (see CLAUDE.md).
 */
const meta = {
  title: 'Interactions/MultiSelector/Traces',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const DAY = 86_400_000;
const D0 = Date.UTC(2026, 0, 1);
const N = 40;

const wave = (phase: number, scale: number) =>
  new TimeSeries({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows: Array.from({ length: N }, (_, i) => [
      D0 + i * DAY,
      scale * (2 + Math.sin(i / 4 + phase) + i / 30),
    ]) as [number, number][],
  });

const isoDay = (t: number) => new Date(t).toISOString().slice(5, 10);

const caption: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
  maxWidth: 560,
  marginTop: 10,
  lineHeight: 1.5,
};

const describe = (sel: readonly SelectionEntry[]) =>
  sel.length === 0
    ? '—'
    : sel
        .map((e) =>
          isSpanSelection(e)
            ? `span ${e.id} [${isoDay(e.x[0])} → ${isoDay(e.x[1])})`
            : `series ${e.id}`,
        )
        .join(', ');

function Demo({ kind }: { kind: 'line' | 'area' }) {
  const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
  const [note, setNote] = useState('—');
  return (
    <div style={{ width: 560 }}>
      <ChartContainer range={[D0, D0 + (N - 1) * DAY]} width={560}>
        <MultiSelector
          selected={sel}
          onSelect={(hits, _m, spans) => {
            // **`spans`, not `span`.** One sweep commits a span per trace, and
            // reading the singular would select whichever happened to be
            // topmost while the preview had lit both — the commit would show
            // less than the drag promised.
            if (spans.length > 0) {
              setNote(`sweep → ${spans.length} span(s), ${hits.length} marks`);
              setSel(spans);
              return;
            }
            const hit = hits[0];
            if (hit === undefined) {
              setNote('clicked away → cleared');
              return setSel([]);
            }
            // The deselect half of the toggle, which only works because the
            // trace's hit carries a stable `mark` — on `key` alone it could
            // not, since NaN never equals itself.
            setNote(
              `click → series-scoped (key ${Number.isNaN(hit.key) ? 'NaN' : hit.key})`,
            );
            setSel((cur) =>
              cur.some((e) => !isSpanSelection(e) && sameMark(e, hit))
                ? cur.filter((e) => isSpanSelection(e) || !sameMark(e, hit))
                : [hit],
            );
          }}
        >
          <ChartRow height={200}>
            <YAxis id="v" min={0} max={8} label="" />
            <Layers>
              {/* A keyed array, not a `<>…</>` — a fragment accepts no props, so
                  it would swallow the z-order index `<Layers>` injects and both
                  traces would register at 0. That matters most in this story:
                  `spans` is documented topmost-first, and topmost is decided by
                  the injected index. */}
              {kind === 'line' ? (
                [
                  <LineChart
                    key="cpu"
                    series={wave(0, 1)}
                    column="v"
                    axis="v"
                    id="cpu"
                  />,
                  <LineChart
                    key="mem"
                    series={wave(2.2, 0.7)}
                    column="v"
                    axis="v"
                    as="secondary"
                    id="mem"
                  />,
                ]
              ) : (
                <AreaChart series={wave(0, 1)} column="v" axis="v" id="net" />
              )}
            </Layers>
          </ChartRow>
        </MultiSelector>
      </ChartContainer>
      <p style={caption}>
        Drag across the plot to sweep a range — the band is the whole preview,
        because there are no marks to light. Click{' '}
        {kind === 'line' ? 'a line' : 'inside the fill'} to select the series;
        click it again to deselect.
        <br />
        <strong>selected:</strong> {describe(sel)}
        <br />
        <strong>last gesture:</strong> {note}
      </p>
    </div>
  );
}

/** A sweep over lines commits a range and no marks. */
export const LineSweep = { render: () => <Demo kind="line" /> };

/** The same currency on an area — only the hit test differs (fill, not stroke). */
export const AreaSweep = { render: () => <Demo kind="area" /> };
