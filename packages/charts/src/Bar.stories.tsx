import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { MultiSelector, Selector } from './selectors.js';
import { defaultTheme } from './theme.js';
import type { SelectInfo, SelectionEntry } from './context.js';

const N = 24;
/** Fixed base epoch (2026-01-01 00:00 UTC) + hourly buckets → deterministic. */
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const HOUR = 3_600_000;
const TIME_RANGE: readonly [number, number] = [BASE, BASE + N * HOUR];

const bucketSchema = [
  { name: 'timeRange', kind: 'timeRange' },
  { name: 'count', kind: 'number' },
] as const;

/**
 * Hourly request volume as a **timeRange-keyed** series: each event's key spans
 * one hour `[h, h+1)`, so each bar fills its bucket. The shape is a daily
 * traffic curve (quiet overnight, a morning ramp, a midday peak). The kind of
 * series a pond `window`/`aggregate` rollup produces.
 */
function hourlyVolume() {
  const rows: Array<[[number, number], number]> = [];
  for (let i = 0; i < N; i += 1) {
    const begin = BASE + i * HOUR;
    // Deterministic daily curve: a broad daytime hump + a smaller wiggle.
    const hump = 60 * Math.max(0, Math.sin(((i - 6) / 18) * Math.PI));
    const wiggle = 8 + 6 * Math.sin(i * 1.7);
    rows.push([[begin, begin + HOUR], Math.round(hump + wiggle)]);
  }
  return new TimeSeries({ name: 'volume', schema: bucketSchema, rows });
}

/**
 * The same daily traffic curve as a **point-keyed** series — one sample per
 * hour, no bucket span. The bars get their width from neighbour spacing (each
 * centred on its timestamp, reaching halfway to each neighbour), so a bar's
 * `begin` is derived geometry the caller never computed — the case the stable
 * `mark` identity exists for (the MarkSelection story).
 */
function hourlySamples() {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    const hump = 60 * Math.max(0, Math.sin(((i - 6) / 18) * Math.PI));
    const wiggle = 8 + 6 * Math.sin(i * 1.7);
    rows.push([BASE + i * HOUR, Math.round(hump + wiggle)]);
  }
  return new TimeSeries({
    name: 'volume',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'count', kind: 'number' },
    ] as const,
    rows,
  });
}

/**
 * A net-flow series straddling zero (timeRange-keyed): hourly inflow minus
 * outflow, some hours net-positive, some net-negative. Drives the diverging-bar
 * baseline — `barExtent` pulls `0` into the domain so the bars grow up from /
 * hang down off the zero line.
 */
function netFlow() {
  const rows: Array<[[number, number], number]> = [];
  for (let i = 0; i < N; i += 1) {
    const begin = BASE + i * HOUR;
    const v = Math.round(
      40 * Math.sin((i / N) * 2 * Math.PI) + 12 * Math.sin(i * 1.3),
    );
    rows.push([[begin, begin + HOUR], v]);
  }
  return new TimeSeries({ name: 'flow', schema: bucketSchema, rows });
}

const meta = {
  title: 'Charts/BarChart',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * The primary form: an interval-keyed series, one bar per bucket spanning its
 * hour, resting on the zero line (the auto-fit domain includes `0`). The `gap`
 * insets each bar so the buckets read as discrete columns.
 */
export const Buckets: Story = {
  render: () => {
    const v = hourlyVolume();
    return (
      <ChartContainer range={TIME_RANGE} width={640}>
        <ChartRow height={240}>
          <YAxis id="count" label="req" min={0} />
          <Layers>
            <BarChart series={v} column="count" gap={3} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * Diverging bars: a series that straddles zero grows up for positive values and
 * hangs down for negative ones, both off the zero baseline (pulled into the
 * domain). No per-bar colour here — sign is read from position, not hue (to
 * *also* colour by sign, derive a `binColors` array — the BinColors story).
 */
export const Diverging: Story = {
  render: () => {
    const f = netFlow();
    return (
      <ChartContainer range={TIME_RANGE} width={640}>
        <ChartRow height={240}>
          <YAxis id="flow" label="net" />
          <Layers>
            <BarChart series={f} column="count" gap={3} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Per-bar colours (`binColors`)** on a time-axis series: `binColors[i]` fills
 * bar `i`, overriding the theme fill (an `undefined` entry falls back). Here the
 * net-flow bars are coloured **by sign** — the array is derived from the series'
 * own data, the same recipe as a direction-coloured financial **volume** row
 * (rising / falling off open vs close; see `Charts/Candlestick`'s price+volume
 * scenario). Hover / click read out the bar's **own** colour, and the highlight
 * pops opacity instead of swapping the fill, so a red / green bar keeps its
 * meaning while live. Per-bar colours draw every visible bar (the dense-bar
 * envelope decimation is skipped — it can't carry more than one colour).
 */
export const BinColors: Story = {
  render: () => {
    const f = netFlow();
    const count = f.column('count');
    const bySign = Array.from({ length: f.length }, (_, i) =>
      (count.at(i) ?? 0) >= 0 ? '#15B3A6' : '#C96A5B',
    );
    return (
      <ChartContainer range={TIME_RANGE} width={640}>
        <ChartRow height={240}>
          <YAxis id="flow" label="net" />
          <Layers>
            <BarChart
              series={f}
              column="count"
              gap={3}
              binColors={bySign}
              id="flow"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Hover + select.** Hover the plot — the bar **under the cursor** lights up
 * (hover-highlight) and a flag rises from its top-centre with the value
 * (`cursor='flag'`). Click a bar — it stays lit **with an outline** and the panel
 * above shows the selection; click empty space to clear. Hover and select both
 * resolve by containment (the flag reads the same bar you click) and match the
 * bar's key **and** this series' label, so they're unambiguous across series
 * sharing a timestamp.
 */
function HoverSelectDemo() {
  const v = hourlyVolume();
  const [sel, setSel] = useState<SelectInfo | null>(null);
  const clock =
    sel === null ? '' : new Date(sel.key).toISOString().slice(11, 16);
  return (
    <div>
      <div
        style={{
          height: '18px',
          marginBottom: '8px',
          display: 'flex',
          gap: '16px',
          fontFamily: defaultTheme.font.family,
          fontSize: '12px',
          color: defaultTheme.axis.label,
        }}
      >
        {sel === null ? (
          <span style={{ opacity: 0.5 }}>click a bar…</span>
        ) : (
          <span style={{ color: sel.color }}>
            {clock} UTC · {sel.label} {sel.value}
          </span>
        )}
      </div>
      <ChartContainer range={TIME_RANGE} width={640} cursor="flag">
        <Selector onSelect={setSel}>
          <ChartRow height={240}>
            <YAxis id="count" label="req" min={0} />
            <Layers>
              <BarChart series={v} column="count" id="count" gap={3} />
            </Layers>
          </ChartRow>
        </Selector>
      </ChartContainer>
    </div>
  );
}

export const HoverSelect: Story = {
  render: () => <HoverSelectDemo />,
};

/**
 * **Controlled selection.** The other half of the select API: the app pins the
 * selection via the `selected` prop (here the 12:00 bar), the way a master/detail
 * view or a deep-link would. The matching bar draws highlighted with no click —
 * the select-analog of the controlled tracker. The `SelectInfo` carries the bar's
 * key (its `begin`), value, the resolved fill colour, and the series label.
 */
export const ControlledSelection: Story = {
  render: () => {
    const v = hourlyVolume();
    const key = BASE + 12 * HOUR;
    const value = v.nearest(key)!.get('count') as number;
    const pinned: SelectInfo = {
      id: 'count',
      key,
      value,
      color: defaultTheme.bar.default.fill,
      label: 'count',
    };
    return (
      <ChartContainer range={TIME_RANGE} width={640}>
        <Selector enabled={false} selected={pinned}>
          <ChartRow height={240}>
            <YAxis id="count" label="req" min={0} />
            <Layers>
              <BarChart series={v} column="count" id="count" gap={3} />
            </Layers>
          </ChartRow>
        </Selector>
      </ChartContainer>
    );
  },
};

/**
 * **Controlled selection by `mark`** — the stable per-bar identity, on a
 * **point-keyed** series (one sample per hour, no bucket span). Here the bar
 * widths are *derived*: each bar is centred on its timestamp and reaches halfway
 * to each neighbour, so its `begin` is `t - 30min` — a number the app never
 * computed. Pinning by `key` alone would mean re-deriving that spacing.
 *
 * `mark` is the sample's own key stringified (`String(t)`), which the app
 * already owns, so the pin is exact with no geometry: the 12:00 bar lights up
 * even though its span starts at 11:30. `key` still rides along as click
 * provenance. A click echoes the same `mark` back, so an app can round-trip a
 * selection — and it survives a data update that re-derives every span.
 */
export const MarkSelection: Story = {
  render: () => {
    const v = hourlySamples();
    const key = BASE + 12 * HOUR;
    const value = v.nearest(key)!.get('count') as number;
    const pinned: SelectInfo = {
      id: 'count',
      key, // provenance — the sample's own time, not the bar's begin edge
      value,
      color: defaultTheme.bar.default.fill,
      label: 'count',
      mark: String(key), // the identity the highlight matches on
    };
    return (
      <ChartContainer range={TIME_RANGE} width={640}>
        <Selector enabled={false} selected={pinned}>
          <ChartRow height={240}>
            <YAxis id="count" label="req" min={0} />
            <Layers>
              <BarChart series={v} column="count" id="count" gap={3} />
            </Layers>
          </ChartRow>
        </Selector>
      </ChartContainer>
    );
  },
};

/**
 * **Three-step emphasis (`BarStyle.hover`).** A theme may set an optional
 * `hover` colour so a bar reads *rest → hover → selected* as three distinct
 * states, instead of one `highlight` shared by both live states (which then
 * differ only by the selected bar's outline). This is the bar analogue of
 * `ScatterStyle`'s `outline` vs `selectedOutline`, and it exists so a chart can
 * match the interaction vocabulary of the list beside it (estela's splits list
 * is teal at rest → preview on hover → foam on select).
 *
 * Hover a bar to see the middle step; click one for the third. Bar 12:00 is
 * pinned selected so all three are visible at once. The default theme sets
 * `hover` (the brighter teal), so this renders with no theme override; a theme
 * that omits `hover` falls back to `highlight` and reads two-step instead.
 */
export const HoverVsSelectColours: Story = {
  render: () => {
    const v = hourlyVolume();
    const key = BASE + 12 * HOUR;
    const value = v.nearest(key)!.get('count') as number;
    const pinned: SelectInfo = {
      id: 'count',
      key,
      value,
      color: defaultTheme.bar.default.fill,
      label: 'count',
    };
    return (
      <ChartContainer range={TIME_RANGE} width={640}>
        <Selector enabled={false} selected={pinned}>
          <ChartRow height={240}>
            <YAxis id="count" label="req" min={0} />
            <Layers>
              <BarChart series={v} column="count" id="count" gap={3} />
            </Layers>
          </ChartRow>
        </Selector>
      </ChartContainer>
    );
  },
};

/**
 * **The default theme's interaction-state palette**, all five states in one
 * walkthrough — what a consumer who passes no `theme` (or spreads
 * `defaultTheme`) actually gets.
 *
 * `defaultTheme.bar.default` encodes bar state as a **hue** difference, not as
 * shades of one colour:
 *
 * | state     | value                                    |
 * | --------- | ---------------------------------------- |
 * | rest      | `#2A9D8F` (teal), α 1                    |
 * | hover     | `#3FBFAE` (brighter teal)                |
 * | selected  | `#3F5BE0` (blue) + outline               |
 * | dimmed    | `rgba(42,157,143,0.32)`                  |
 * | drag band | `theme.brush` — that blue at 7%, 1px edges |
 *
 * Blue is reserved for *committed* selection, which is why hover is a brighter
 * teal rather than a pale blue: a passing pointer and a real selection must not
 * read as the same act. The shared drag band is that same blue at 7% for the
 * mirror-image reason — a live sweep **is** a selection being made.
 *
 * A `<MultiSelector>` is mounted so all five states are reachable: hover for
 * the middle step, click for the third (everything else recedes to `dimmed`),
 * drag for the band.
 */
export const DefaultThemeStates: Story = {
  render: function DefaultThemeStatesStory() {
    const v = hourlyVolume();
    const [sel, setSel] = useState<readonly SelectionEntry[]>([]);
    return (
      <div>
        <ChartContainer range={TIME_RANGE} width={640}>
          <MultiSelector
            selected={sel}
            onSelect={(hits, _mods, spans) =>
              setSel(spans.length > 0 ? [...spans] : hits.slice(0, 1))
            }
          >
            <ChartRow height={240}>
              <YAxis id="count" label="req" min={0} />
              <Layers>
                <BarChart series={v} column="count" id="count" gap={3} />
              </Layers>
            </ChartRow>
          </MultiSelector>
        </ChartContainer>
        <p
          style={{
            font: '13px system-ui',
            color: '#667',
            marginTop: 4,
            maxWidth: 640,
          }}
        >
          Hover for the brighter teal · click a bar to select it (blue; the rest
          recede) · drag for the band · click away to clear.
        </p>
      </div>
    );
  },
};

/**
 * **`maxBarWidth`** — the *absolute* half of the width vocabulary
 * ([PND-BARWIDTH]). `gap` is a **relative** inset, so with it alone a bar is
 * always `slot - gap` and fattens as the plot widens. A fixed ink width is what
 * makes a measure comparable **between** panes: bars that widen with their pane
 * read as different weights of the same thing.
 *
 * The two panes below are deliberately different widths and show the same data.
 * Uncapped, the bars are visibly different weights; capped, they match — which
 * is the whole point of the prop.
 */
export const MaxBarWidth: Story = {
  render: () => {
    const v = hourlyVolume();
    const pane = (width: number, capped: boolean) => (
      <div>
        <div style={{ font: '12px system-ui', color: '#667', marginBottom: 4 }}>
          {width}px pane · {capped ? 'maxBarWidth={14}' : 'uncapped'}
        </div>
        <ChartContainer range={TIME_RANGE} width={width}>
          <ChartRow height={160}>
            <YAxis id="count" label="req" min={0} />
            <Layers>
              <BarChart
                series={v}
                column="count"
                id="count"
                gap={3}
                {...(capped ? { maxBarWidth: 14 } : {})}
              />
            </Layers>
          </ChartRow>
        </ChartContainer>
      </div>
    );
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        {pane(620, false)}
        {pane(380, false)}
        {pane(620, true)}
        {pane(380, true)}
        <p
          style={{
            font: '13px system-ui',
            color: '#667',
            maxWidth: 620,
            lineHeight: 1.5,
          }}
        >
          Top two: the same bars at two pane widths, uncapped — the wider
          pane&apos;s bars are visibly heavier. Bottom two:{' '}
          <code>maxBarWidth={14}</code> — the ink matches across panes while the
          slots still spread to fill each one. The{' '}
          <strong>hit target stays the whole slot</strong>, so the narrower ink
          costs nothing in clickability.
        </p>
      </div>
    );
  },
};
