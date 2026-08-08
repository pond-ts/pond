import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { BandChart } from './BandChart.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';
import { Baseline, Marker } from './annotations.js';
import { estelaTheme, type ChartTheme } from './theme.js';
import { docsTheme, docsThemeDark } from './docs-theme.fixture.js';
import { twoSeries, RANGE, BASE, STEP } from './story-data.fixture.js';

/**
 * **The deliberate theming exceptions.** Every other story in this Storybook
 * renders the shipped `defaultTheme` — the fallback a consumer who passes no
 * `theme` actually gets — so the default look is what gets reviewed and
 * regression-tested. This group is the curated set that demonstrates theming
 * *as a feature*: the project's own docs brand (light + dark) and the estela
 * consumer palette on its dark ground, each on one representative chart
 * (line + variance band + placed marks + a bar sub-panel).
 *
 * The third leg — re-theming through CSS custom properties — is the
 * `Theming/CssVars` story next door.
 */
const meta = {
  title: 'Theming/Showcase',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** Hourly-ish volume bars under the price row — one series, 30 buckets. */
function volumeSeries() {
  const rows: Array<[[number, number], number]> = [];
  const bucket = 3 * STEP;
  for (let i = 0; i < 30; i += 1) {
    const begin = BASE + i * bucket;
    rows.push([
      [begin, begin + bucket],
      Math.round(40 + 26 * Math.sin(i / 4) + 9 * Math.sin(i * 1.9)),
    ]);
  }
  return new TimeSeries({
    name: 'volume',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ] as const,
    rows,
  });
}

/** One representative composition, restyled purely by swapping `theme`. */
function Showcase({ theme }: { theme: ChartTheme }) {
  const s = twoSeries();
  return (
    <ChartContainer range={RANGE} width={640} theme={theme}>
      <ChartRow height={200}>
        <YAxis id="usd" side="right" format=",.0f" min={120} max={240} />
        <Layers>
          <BandChart series={s} lower="slow" upper="fast" axis="usd" />
          <LineChart series={s} column="fast" as="primary" axis="usd" />
          <Baseline value={185} label="ref 185" />
          <Marker at={BASE + 62 * STEP} label="event" />
        </Layers>
      </ChartRow>
      <ChartRow height={90}>
        <YAxis id="vol" side="right" min={0} />
        <Layers>
          <BarChart series={volumeSeries()} column="v" gap={2} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}

/** The docs-site / deployed-Storybook brand look on its light ground —
 *  `docsTheme` is dev-only (a `*.fixture.ts`, never shipped); the docs site is
 *  a *consumer* of the library like any other. */
export const DocsTheme: Story = {
  render: () => <Showcase theme={docsTheme} />,
};

/** The same docs design on the dark terminal ground (docs-site dark mode). */
export const DocsThemeDark: Story = {
  render: () => (
    <div style={{ background: docsThemeDark.background, padding: 16 }}>
      <Showcase theme={docsThemeDark} />
    </div>
  ),
};

/** The estela consumer palette — the proving ground for "one engine, restyled
 *  by swapping the theme": brand-teal data on the dark `--es-bg` ground. */
export const EstelaDark: Story = {
  render: () => (
    <div style={{ background: estelaTheme.background, padding: 16 }}>
      <Showcase theme={estelaTheme} />
    </div>
  ),
};
