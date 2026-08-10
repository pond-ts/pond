import { useState } from 'react';
import type { Meta } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { MultiSelector, Selector } from './selectors.js';
import type { SelectInfo, SelectionEntry, SpanSelection } from './context.js';

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

/**
 * One tick per bin, at its centre. A numeric y axis would otherwise print the
 * raw epoch of each gridline — `<BarChart orientation="horizontal">` puts the
 * bin axis on a linear scale and leaves the labelling to `<YAxis ticks>`,
 * which is the documented seam for exactly this.
 */
const dayTicks = Array.from({ length: N }, (_, i) => ({
  at: D0 + (i + 0.5) * DAY,
  label: isoDay(D0 + i * DAY).slice(5),
}));

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
          onSelect={(hits, _mods, spans) =>
            setSelected(spans.length === 0 ? hits : [...spans])
          }
        />
        <ChartRow height={260}>
          <YAxis
            id="bins"
            min={D0}
            max={D0 + N * DAY}
            ticks={dayTicks}
            width={56}
            label=""
          />
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

/**
 * The funnel / ranking shape ([PND-HCAT]) — the same drag over an **ordinal**
 * bin axis.
 *
 * Worth its own story because it is the combination the transposed cut could
 * plausibly have got wrong. A *vertical* categorical chart puts its bins on a
 * d3 **band** scale, whose `invert` snaps a pixel to the slot centre — which
 * is why that path publishes `binIntervals`, so its band can still snap
 * outward to slot edges. Transposed, the bins land on y as a plain linear
 * scale over `[0, N]` and only the *ticks* are categorical, so no correction
 * is needed and the band lands on slot boundaries by construction.
 */
const STAGES = [
  { label: 'Visited', value: 12400 },
  { label: 'Signed up', value: 5200 },
  { label: 'Activated', value: 2100 },
  { label: 'Subscribed', value: 780 },
  { label: 'Renewed', value: 410 },
];

function CategoryDemo() {
  const [selected, setSelected] = useState<readonly SelectionEntry[]>([]);
  const readout =
    selected.length === 0
      ? '—'
      : selected
          .map((e) =>
            isSpan(e)
              ? `slots [${e.x[0]} → ${e.x[1]}) — ${STAGES.slice(e.x[0], e.x[1])
                  .map((c) => c.label)
                  .join(', ')}`
              : (e.label ?? String(e.key)),
          )
          .join(' | ');
  return (
    <div style={{ width: 520, fontFamily: 'system-ui, sans-serif' }}>
      {/* No `range`: a categorical horizontal chart derives its value extent
          from the data, and its slot domain `[0, N]` from the layer. */}
      <ChartContainer width={520} selected={selected}>
        <MultiSelector
          onSelect={(hits, _mods, spans) =>
            setSelected(spans.length === 0 ? hits : [...spans])
          }
        />
        <ChartRow height={220}>
          {/* A wider gutter — the category labels are words, not numbers. */}
          <YAxis id="stage" width={96} />
          <Layers>
            <BarChart
              categories={STAGES}
              orientation="horizontal"
              axis="stage"
              id="funnel"
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

/** The ordinal bin axis: the band lands on whole slots, and the span reads as
 *  a slot run. */
export const SweepCategories = { render: () => <CategoryDemo /> };

// ── Shared scaffolding for the stories below ───────────────────────────────

/** One horizontal time-bar chart, with whatever selector the story mounts. */
function HBars({
  selected,
  children,
}: {
  selected: readonly SelectionEntry[];
  children: React.ReactNode;
}) {
  return (
    <ChartContainer range={[0, 12]} width={420} selected={selected}>
      {children}
      <ChartRow height={240}>
        <YAxis
          id="bins"
          min={D0}
          max={D0 + N * DAY}
          ticks={dayTicks}
          width={56}
          label=""
        />
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
  );
}

const describeEntries = (sel: readonly SelectionEntry[]) =>
  sel.length === 0
    ? '—'
    : sel
        .map((e) =>
          isSpan(e)
            ? `span [${isoDay(e.x[0])} → ${isoDay(e.x[1])})`
            : isoDay(e.key),
        )
        .join(', ');

const caption: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
  maxWidth: 420,
  lineHeight: 1.5,
};

/**
 * **Additive sweeps and the modifier** — ⌘/Ctrl builds a selection up instead
 * of replacing it, over the transposed gesture.
 *
 * Nothing here is horizontal-specific, which is the point of including it:
 * `modifiers` arrives on the transposed release exactly as it does on an x
 * sweep, so a consumer's additive handling is the same code either way. Two
 * spans can coexist in `selected` because `SpanSelection` is one entry in a
 * plural selection, not a replacement for it — and `spanMatchesAny` tests a
 * mark against all of them.
 */
function AdditiveDemo() {
  const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
  return (
    <div>
      <HBars selected={sel}>
        <MultiSelector
          onSelect={(hits, mods, spans) => {
            const add = mods?.additive ?? false;
            if (spans.length > 0) {
              setSel((cur) => (add ? [...cur, ...spans] : [...spans]));
              return;
            }
            // A click with nothing under it clears, additive or not — the
            // deselect gesture stays reachable.
            if (hits.length === 0) return setSel([]);
            setSel((cur) => (add ? [...cur, hits[0]!] : [hits[0]!]));
          }}
        />
      </HBars>
      <p style={caption}>
        Sweep a range of bins, then <strong>⌘/Ctrl-drag</strong> a second one to
        add it — or ⌘/Ctrl-click a single bar. A plain drag or click replaces; a
        click on empty space clears.
        <br />
        <strong>selected:</strong> {describeEntries(sel)}
      </p>
    </div>
  );
}

export const SweepAdditive = { render: () => <AdditiveDemo /> };

/**
 * **`<Selector>` vs `<MultiSelector>`, side by side** — the same horizontal
 * chart under each, so the difference is the mount and nothing else.
 *
 * - **Left, `<Selector>`** — clicks only. There is no drag gesture to claim,
 *   so the row keeps its ordinary cursor and a vertical drag pans (or does
 *   nothing) rather than sweeping. One mark at a time.
 * - **Right, `<MultiSelector>`** — a strict *superset*. Below `DRAG_SLOP` the
 *   gesture is still a click reporting `([hit], modifiers, null)`; past it,
 *   the transposed sweep takes over and release carries a span.
 *
 * Worth pinning on the transposed chart specifically: the slop that separates
 * click from drag lives on **|dy|** here, the mirror of the x rule. So the
 * horizontal wobble that would arm a sweep on a vertical chart leaves this
 * one a click — and the vertical wobble that a vertical chart forgives is
 * exactly what starts a sweep here.
 */
function VersusDemo() {
  const [one, setOne] = useState<readonly SelectInfo[]>([]);
  const [many, setMany] = useState<readonly SelectionEntry[]>([]);
  return (
    <div style={{ display: 'flex', gap: 32 }}>
      <div>
        <HBars selected={one}>
          <Selector onSelect={(hit) => setOne(hit === null ? [] : [hit])} />
        </HBars>
        <p style={caption}>
          <strong>&lt;Selector&gt;</strong> — click a bar. Dragging sweeps
          nothing; there is no gesture mounted to claim it.
          <br />
          <strong>selected:</strong> {describeEntries(one)}
        </p>
      </div>
      <div>
        <HBars selected={many}>
          <MultiSelector
            onSelect={(hits, _mods, spans) =>
              setMany(spans.length > 0 ? [...spans] : hits.slice(0, 1))
            }
          />
        </HBars>
        <p style={caption}>
          <strong>&lt;MultiSelector&gt;</strong> — the same click still selects
          one bar, and a vertical drag sweeps a run of them.
          <br />
          <strong>selected:</strong> {describeEntries(many)}
        </p>
      </div>
    </div>
  );
}

export const SelectorVsMultiSelector = { render: () => <VersusDemo /> };
