import type { Meta } from '@storybook/react-vite';
import { BarList } from './BarList.js';
import { BoxList } from './BoxList.js';
import { defaultTheme } from './theme.js';
import type { ListRow } from './list.js';

/**
 * **The row-chart state ladder** — rest, dimmed, hover, selected, and the
 * single- vs multi-metric split, one story each.
 *
 * A row chart cannot signal state the way a column chart does, for two
 * reasons that shape everything below:
 *
 * - **The row is the target, not the bar.** A vertical bar can be its own hit
 *   area because every mark spans the full column width. A row's mark is as
 *   short as its value, so a 4% row would be a 30px sliver to aim at — the
 *   label gutter, the track and the trailing value are one target, and the
 *   thing that lights is the whole **band**.
 * - **The band carries selection alone.** In a multi-metric row the fill *is*
 *   the metric's identity, so it cannot also carry state. Band + rail must
 *   read as selected with no help from the fill — and designing the
 *   single-metric case that way too means one treatment covers every row
 *   chart in the library.
 *
 * Two further rules fall out of those. **The track never dims:** the unfilled
 * remainder is a *scale*, not a measurement, and receding it alongside the
 * fill destroys the shared baseline that makes rows comparable. **Blue is
 * reserved even from markers:** on a bullet row a target tick sits inside the
 * mark that selection recolors, so a blue tick is the one collision the rest
 * of the language cannot absorb.
 *
 * No `theme` prop anywhere here — these render `defaultTheme`, which is what
 * a consumer who themes nothing actually gets (see CLAUDE.md).
 */
const meta = {
  title: 'Lists/Row states',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const hosts: ListRow[] = [
  { key: 'web-1', label: 'web-1', values: { in: 62, out: 21 } },
  { key: 'web-2', label: 'web-2', values: { in: 95, out: 44 } },
  { key: 'db-1', label: 'db-1', values: { in: 40, out: 12 } },
  { key: 'db-2', label: 'db-2', values: { in: 18, out: 6 } },
];
const oneMetric = [{ column: 'in' }];
// Two metrics in DIFFERENT hues, which is the whole point: with one hue the
// multi-metric story would not show why hue is identity, and recolouring the
// fill would look harmless.
const twoMetrics = [
  { column: 'in' },
  { column: 'out', as: 'secondary' },
] as const;

const note: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
  color: '#555',
  maxWidth: 460,
  marginTop: 10,
  lineHeight: 1.5,
};

function Frame({
  children,
  caption,
}: {
  children: React.ReactNode;
  caption: React.ReactNode;
}) {
  return (
    // A white ground on purpose. The band tints are near-white by design —
    // a hover lift should not shout — so on Storybook's grey canvas the hover
    // band all but vanishes and the story would understate what a consumer
    // sees. This is the ground the register was drawn against.
    <div
      style={{ width: 460, background: '#fff', padding: 20, borderRadius: 6 }}
    >
      {children}
      <p style={note}>{caption}</p>
    </div>
  );
}

/** Nothing selected anywhere: transparent band, the metric's own fill. */
export const Rest = {
  render: () => (
    <Frame caption="Nothing selected in the chart. The band is transparent and every fill is the metric's resting hue.">
      <BarList rows={hosts} columns={oneMetric} onRowClick={() => {}} />
    </Frame>
  ),
};

/** The whole band lights, label gutter included — the row is the target. */
export const Hover = {
  render: () => (
    <Frame caption="The whole band lights up, label gutter included, plus a teal rail. Never blue: blue is reserved for committed state.">
      <BarList rows={hosts} columns={oneMetric} hovered="web-2" />
    </Frame>
  ),
};

/** Single metric: chrome says it, and the fill is free to agree. */
export const Selected = {
  render: () => (
    <Frame caption="Band, rail, and — because there is only one metric here — the fill agrees too. The fill is decorative: strip it and the row still reads as selected.">
      <BarList rows={hosts} columns={oneMetric} selected="web-2" />
    </Frame>
  ),
};

/**
 * The rule's real case: hue is identity, so chrome carries selection alone.
 */
export const MultiMetricSelected = {
  render: () => (
    <Frame caption="Two metrics, so the fill cannot move — recolouring it would trade a distinction the reader needs for one the chrome already gave them. Band and rail carry it alone.">
      <BarList rows={hosts} columns={twoMetrics} selected="web-2" />
    </Frame>
  ),
};

/**
 * Dimmed is a *consequence*, not a prop: it means something else is selected.
 */
export const Dimmed = {
  render: () => (
    <Frame caption="Every row except the selected one recedes to 0.32 — but look at the tracks: they hold full strength. The unfilled remainder is a scale, not a measurement, and dimming it would destroy the shared baseline that makes these rows comparable.">
      <BarList rows={hosts} columns={oneMetric} selected="web-2" />
    </Frame>
  ),
};

/** Nothing to recede from, so nothing recedes. */
export const NothingSelectedNothingDims = {
  render: () => (
    <Frame caption="The pair to Dimmed. With an empty selection there is nothing to recede from, so no row dims — the same rule the canvas bars follow.">
      <BarList rows={hosts} columns={oneMetric} selected={[]} />
    </Frame>
  ),
};

/** A plural selection — the currency a range gesture will commit. */
export const MultipleSelected = {
  render: () => (
    <Frame caption="`selected` takes a set, matching `hovered`. Two rows carry the band and rail; the rest dim around them.">
      <BarList rows={hosts} columns={oneMetric} selected={['web-2', 'db-1']} />
    </Frame>
  ),
};

/** Selection outranks hover: committed beats transient. */
export const SelectedAndHovered = {
  render: () => (
    <Frame caption="One row both selected and hovered. Selection wins the band, so a hovered selected row never reads as merely hovered.">
      <BarList
        rows={hosts}
        columns={oneMetric}
        selected="web-2"
        hovered="web-2"
      />
    </Frame>
  ),
};

/** The sister component: same chrome, and its own answer to the track rule. */
export const BoxRows = {
  render: () => (
    <Frame caption="A <BoxList> takes the identical band and rail. Its dimmed rows recede the body, median and tick — but not the range band, which is this chart's track.">
      <BoxList
        rows={hosts.map((r) => ({
          key: r.key,
          label: r.label,
          values: { lower: 5, q1: 22, median: 41, q3: 63, upper: 88 },
        }))}
        columns={[
          {
            lower: 'lower',
            q1: 'q1',
            median: 'median',
            q3: 'q3',
            upper: 'upper',
          },
        ]}
        selected="web-2"
      />
    </Frame>
  ),
};

/**
 * The back-compatibility case — a theme predating the register.
 *
 * Explicitly themed, and grouped here deliberately: this story's *subject* is
 * the absence of the `list` slot, which is the one thing a `defaultTheme`
 * story cannot show.
 */
export const NoListRegister = {
  render: () => (
    <Frame caption="A hand-built theme with no `list` slot keeps exactly the pre-token look: the old borrowed hover band, the annotation-register rail, and no dimmed state at all — it did not exist before the register did.">
      <BarList
        rows={hosts}
        columns={oneMetric}
        selected="web-2"
        theme={{ ...defaultTheme, list: undefined }}
      />
    </Frame>
  ),
};
