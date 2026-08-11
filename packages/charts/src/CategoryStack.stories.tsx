import { useState } from 'react';
import type { Meta } from '@storybook/react-vite';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { CategoryAxis } from './CategoryAxis.js';
import { Legend } from './Legend.js';
import { Selector } from './selectors.js';
import { YAxis } from './YAxis.js';
import type { SelectInfo } from './context.js';

/**
 * **A stacked category chart** — `<BarChart categories columns>`
 * ([PND-CATSTACK]). The same relationship `series` + `columns` already has,
 * applied to the ordinal axis: each datum is `{ label, values }` and `columns`
 * names the groups to stack, bottom → top.
 *
 * It replaces composing the picture from one `categories` layer per *cumulative
 * total* (drawn outermost-first so each overpaints the one beneath), which cost
 * a hand-assembled legend, label thinning blind to the sibling layers, and — once
 * selection landed — a controlled set replicated across every segment layer.
 *
 * The fan-out below walks one knob at a time, in the order they interact:
 * groups, then the colour source (which changes both the selected *and* the
 * receded treatment), then gaps, then selection, then orientation.
 *
 * No `theme` prop anywhere — these render `defaultTheme`, which is what a
 * consumer who passes no theme actually gets (see CLAUDE.md).
 */
const meta = {
  title: 'Charts/BarChart/Category stack',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const W = 620;

const CATS = [
  { label: 'alpha', values: { pass: 32, warn: 9, fail: 4 } },
  { label: 'beta', values: { pass: 18, warn: 14, fail: 11 } },
  { label: 'gamma', values: { pass: 41, warn: 5, fail: 2 } },
  { label: 'delta', values: { pass: 25, warn: 11, fail: 7 } },
];
const COLS = ['pass', 'warn', 'fail'];

const caption: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
  maxWidth: W,
  marginTop: 10,
  lineHeight: 1.5,
};

/** One chart, wired identically in every cell — only the props under test vary. */
function Chart({
  children,
  height = 240,
  ...bar
}: {
  children?: React.ReactNode;
  height?: number;
  [k: string]: unknown;
}) {
  return (
    <ChartContainer width={W}>
      {children}
      <ChartRow height={height}>
        <YAxis id="n" min={0} label="" />
        <Layers>
          <BarChart
            categories={CATS}
            columns={COLS}
            axis="n"
            id="checks"
            {...bar}
          />
        </Layers>
        <CategoryAxis />
      </ChartRow>
    </ChartContainer>
  );
}

/** **Default** — three groups, coloured by the theme's group ramp. */
export const Default = {
  render: () => (
    <div>
      <Chart />
      <p style={caption}>
        `columns={'{'}['pass', 'warn', 'fail']{'}'}` stacks bottom → top.
        Colours come from <code>defaultTheme</code>&apos;s group ramp — no{' '}
        <code>colors</code> passed.
      </p>
    </div>
  ),
};

/** **Two groups** — the smallest real stack, to confirm the ramp doesn't need
 *  its full length. */
export const TwoGroups = {
  render: () => (
    <div>
      <ChartContainer width={W}>
        <ChartRow height={240}>
          <YAxis id="n" min={0} label="" />
          <Layers>
            <BarChart
              categories={CATS}
              columns={['pass', 'fail']}
              axis="n"
              id="checks"
            />
          </Layers>
          <CategoryAxis />
        </ChartRow>
      </ChartContainer>
      <p style={caption}>
        A two-group stack. The ramp cycles, so group count and ramp length are
        independent.
      </p>
    </div>
  ),
};

/** **One group** — degenerate on purpose: `G === 1` takes the single-value path,
 *  so it must look exactly like `categories` with a plain `value`. */
export const OneGroup = {
  render: () => (
    <div>
      <ChartContainer width={W}>
        <ChartRow height={240}>
          <YAxis id="n" min={0} label="" />
          <Layers>
            <BarChart
              categories={CATS}
              columns={['pass']}
              axis="n"
              id="checks"
            />
          </Layers>
          <CategoryAxis />
        </ChartRow>
      </ChartContainer>
      <p style={caption}>
        One group is not a stack: it resolves on the single-value path and keeps{' '}
        <code>fill</code>, since a ramp exists to tell groups apart and there is
        nothing to tell apart.
      </p>
    </div>
  ),
};

/** **`colors`** — call-site segment colours, the shape a consumer with a
 *  spec-supplied palette passes. */
export const CallSiteColors = {
  render: () => (
    <div>
      <Chart colors={{ pass: '#3d8f5f', warn: '#d9a13b', fail: '#c05a4d' }} />
      <p style={caption}>
        <code>colors</code> names each group&apos;s colour at the call site,
        overriding the ramp. This also opts out of the ramp&apos;s{' '}
        <em>derived</em> companions — see <strong>SelectedWithColors</strong>{' '}
        below, where recede is the flat <code>dimmed</code> rather than
        per-group.
      </p>
    </div>
  ),
};

/** **A gap** — a group missing from one category is a hole, not a zero. */
export const GapInAGroup = {
  render: () => (
    <div>
      <ChartContainer width={W}>
        <ChartRow height={240}>
          <YAxis id="n" min={0} label="" />
          <Layers>
            <BarChart
              categories={[
                { label: 'alpha', values: { pass: 32, warn: 9, fail: 4 } },
                // `fail` absent entirely, `warn` explicitly non-finite.
                { label: 'beta', values: { pass: 18, warn: Number.NaN } },
                { label: 'gamma', values: { pass: 41, warn: 5, fail: 2 } },
              ]}
              columns={COLS}
              axis="n"
              id="checks"
            />
          </Layers>
          <CategoryAxis />
        </ChartRow>
      </ChartContainer>
      <p style={caption}>
        <strong>beta</strong> is missing <code>fail</code> and carries a
        non-finite <code>warn</code>. Both read as gaps — no segment, rather
        than a zero-height one that would still claim presence in the legend.
      </p>
    </div>
  ),
};

/** **The legend comes for free** — one layer means one set of group rows. */
export const WithLegend = {
  render: () => (
    <div>
      <Chart>
        <Legend />
      </Chart>
      <p style={caption}>
        A real stack registers one legend row per group, with each swatch the
        colour the canvas actually drew. The composed workaround had to assemble
        this by hand, because a per-bar-coloured layer reports its base theme
        fill ([PND-BINSWATCH]).
      </p>
    </div>
  ),
};

function SelectDemo({ colors }: { colors?: Record<string, string> }) {
  const [sel, setSel] = useState<readonly SelectInfo[]>([]);
  return (
    <div>
      <Chart
        {...(colors ? { colors } : {})}
        // eslint-disable-next-line react/jsx-no-useless-fragment
      >
        <Selector
          selected={sel}
          onSelect={(hit) => setSel(hit === null ? [] : [hit])}
        />
      </Chart>
      <p style={caption}>
        Click a bar. <strong>One entry selects the whole bar</strong> — the
        payload is <code>(id, mark)</code> where <code>mark</code> is the
        category name, and <code>marks</code> is indexed by bar rather than by
        segment. The composed workaround needed the set replicated across every
        segment layer; miss one and a selected bar receded{' '}
        <em>from the waist up</em>.
        <br />
        <strong>selected:</strong> {sel.map((m) => m.mark).join(', ') || '—'}
      </p>
    </div>
  );
}

/** **Selection, theme ramp** — the unselected bars recede *per group*, because
 *  the ramp supplies a derived counterpart (`groupsDimmed`). */
export const Selected = { render: () => <SelectDemo /> };

/** **Selection, `colors`** — same gesture, two differences worth seeing side by
 *  side with `Selected`: the selected bar keeps its own segment colours, and
 *  the receded bars go to one flat `dimmed`. */
export const SelectedWithColors = {
  render: () => (
    <SelectDemo
      colors={{ pass: '#3d8f5f', warn: '#d9a13b', fail: '#c05a4d' }}
    />
  ),
};

/** **Horizontal** — categories on `y` as unit slots, the stack running along
 *  `x`. The `<YAxis>` labels one tick per category with no explicit `ticks`. */
export const Horizontal = {
  render: () => (
    <div>
      <ChartContainer width={W}>
        <ChartRow height={260}>
          <YAxis id="cat" width={70} label="" />
          <Layers>
            <BarChart
              categories={CATS}
              columns={COLS}
              axis="cat"
              id="checks"
              orientation="horizontal"
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
      <p style={caption}>
        <code>orientation=&quot;horizontal&quot;</code> transposes it — same
        reader, same slots, the stack running along the value axis ([PND-HCAT]).
      </p>
    </div>
  ),
};
