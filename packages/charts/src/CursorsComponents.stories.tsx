import type { Meta, StoryObj } from '@storybook/react-vite';
import { Sequence } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import {
  LineCursor,
  PointCursor,
  InlineCursor,
  FlagCursor,
  CrosshairCursor,
  RangeCursor,
} from './cursors.js';
import {
  twoSeries,
  hrSeries,
  BASE,
  STEP,
  RANGE,
} from './story-data.fixture.js';

/**
 * **Cursor components** — the mounted-preset successors of the `cursor` string
 * modes (interaction RFC §4 / A4.1). Mount one as a child of
 * `<ChartContainer>` (the default for every row) or **inside a `<ChartRow>`**
 * (the per-row override, replacing `<ChartRow cursor>`). Mount nothing for no
 * cursor (during the deprecation window the legacy default still synthesizes
 * a `<LineCursor>`; `cursor="none"` opts out).
 *
 * One story per preset (each mounted at the container), then the mount-point
 * axis (in-row, the multi-row override), stacking, and the no-cursor case.
 * The multi-row override story is the regression net for the x-axis pill
 * seam: a row-level crosshair now gets its time pill — the old string gate
 * (`container.cursor === 'crosshair'`) never let a per-row override reach
 * the axis.
 */
const W = 620;
const PIN = BASE + 40 * STEP;
const s = twoSeries();

const meta = {
  title: 'Cursors/Components',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** `<LineCursor />` — the synced vertical line (the container default's
 *  component form). Hover to see it track. */
export const Line: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <LineCursor />
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** `<PointCursor />` — a dot on each series at the cursor, no line. */
export const Point: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <PointCursor />
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
          <LineChart series={s} column="slow" as="secondary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** `<InlineCursor />` — dots + a value chip beside each. */
export const Inline: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <InlineCursor />
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
          <LineChart series={s} column="slow" as="secondary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** `<FlagCursor showTime />` — staffed value flags stacked near the top, the
 *  shared time atop the stack (`showTime`, the `cursorTime` successor). */
export const Flag: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <FlagCursor showTime />
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
          <LineChart series={s} column="slow" as="secondary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** `<CrosshairCursor />` — the inspection reticle: dashed cross lines, the
 *  value pinned to its y axis, the time pinned to the x axis. Snap default. */
export const Crosshair: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <CrosshairCursor />
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** `<CrosshairCursor snap={false} />` — the **free** reticle: the horizontal
 *  line + value follow the pointer y (the `crosshairSnap={false}` successor).
 *  Hover-driven — hover the plot to see it. */
export const CrosshairFree: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <CrosshairCursor snap={false} />
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** `<RangeCursor sequence />` — the hover-time **band**: the 15-minute bucket
 *  under the pointer, snapped to the sequence (the `cursor="region"` +
 *  `cursorSequence` successor). The drag lands in the next step. */
export const Range: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <RangeCursor sequence={Sequence.every('15m')} />
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** `<RangeCursor />` with **no sequence** — the freeform degenerate case: a
 *  plain line on hover (a drag would shade the raw span). */
export const RangeFreeform: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <RangeCursor />
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** `showTime` on a render-only preset — the shared time atop the readout,
 *  once, on the first row (the `cursorTime` successor). */
export const ShowTime: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <LineCursor showTime />
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** Mounted **inside the row** rather than at the container — same cursor,
 *  row-scoped: the single-row form of the per-row override. */
export const MountedInRow: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <ChartRow height={220}>
        <InlineCursor />
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** The **multi-row per-row override** — a container-level `<LineCursor>` with
 *  a `<CrosshairCursor>` mounted in the bottom row only. Hover the bottom row:
 *  the reticle + its y pill draw there, **and the x-axis time pill appears** —
 *  the seam this wave fixes (the old string gate read only the container
 *  default, so a row-level crosshair never got its time pill). Hover the top
 *  row: the plain line, no pill. */
export const RowOverride: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W}>
      <LineCursor />
      <ChartRow height={150}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
      <ChartRow height={150}>
        <CrosshairCursor />
        <Layers>
          <LineChart series={hrSeries()} column="bpm" axis="bpm" />
        </Layers>
        <YAxis id="bpm" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **Stacked render-only presets** (RFC A2.5): `<LineCursor>` + `<PointCursor>`
 *  compose — the line and the dots draw together in mount order. Only
 *  gesture-owning cursors (crosshair, range) are one-per-scope. */
export const StackedRenderOnly: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} trackerPosition={PIN}>
      <LineCursor />
      <PointCursor />
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
          <LineChart series={s} column="slow" as="secondary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};

/** **No cursor.** During the deprecation window mounting nothing still keeps
 *  the legacy `'line'` default (the shim), so opting out is `cursor="none"`;
 *  once the window closes, mounting nothing IS the no-cursor case. */
export const NoCursor: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={W} cursor="none">
      <ChartRow height={220}>
        <Layers>
          <LineChart series={s} column="fast" as="primary" axis="usd" />
        </Layers>
        <YAxis id="usd" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  ),
};
