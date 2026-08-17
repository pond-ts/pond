import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { AreaChart } from './AreaChart.js';
import { YAxis } from './YAxis.js';
import { XAxis } from './XAxis.js';
import { twoSeries, hrSeries, RANGE } from './story-data.fixture.js';

/**
 * `<ChartContainer height>` + `<ChartRow flex>` — container-owned vertical
 * layout ([PND-HEIGHT]).
 *
 * The thing to check in every story: **nobody subtracts the axis strip.** The
 * container is a flex column, the strip keeps its natural height, and flex
 * rows take what CSS says is left — so the layout stays right when the strip
 * changes height (a label, calendar bands, marker pills), which is exactly
 * when a hand-carried constant goes wrong.
 */
const s = twoSeries();
const hr = hrSeries();

const meta = {
  title: 'Layout/Container height',
  parameters: { layout: 'padded' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** A bordered box with a definite height, so `height="auto"` has a parent. */
function Frame({
  height,
  children,
}: {
  height: number;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        height,
        resize: 'vertical',
        overflow: 'auto',
        minHeight: 160,
        border: '1px dashed #94a3b8',
        borderRadius: 6,
      }}
    >
      {children}
    </div>
  );
}

/**
 * **SingleRowZeroProps** — the consumer's whole ask in one story: a bare
 * `<ChartRow>` (implicit `flex={1}`) filling a resizable box, **no arithmetic
 * anywhere**. Drag the box's bottom edge: the row absorbs every pixel the
 * axis strip doesn't take.
 */
export const SingleRowZeroProps: Story = {
  render: () => (
    <Frame height={320}>
      <ChartContainer range={RANGE} width="auto" height="auto">
        <ChartRow>
          <YAxis id="v" min={140} max={230} />
          <Layers>
            <LineChart series={s} column="fast" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </Frame>
  ),
};

/**
 * **FlexRatios** — `flex={3}` over `flex={1}`: the price-over-volume ratio
 * without a pixel in sight. Resize the box and the 3:1 holds.
 */
export const FlexRatios: Story = {
  render: () => (
    <Frame height={400}>
      <ChartContainer range={RANGE} width="auto" height="auto" rowGap={8}>
        <ChartRow flex={3}>
          <YAxis id="v" min={140} max={230} />
          <Layers>
            <LineChart series={s} column="fast" axis="v" />
          </Layers>
        </ChartRow>
        <ChartRow flex={1}>
          <YAxis id="w" min={140} max={230} />
          <Layers>
            <AreaChart series={s} column="slow" axis="w" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </Frame>
  ),
};

/**
 * **MixedFixedFlex** — a fixed 90px strip row under a flex main row. The
 * fixed row keeps its pixels at every box size; only the flex row moves.
 */
export const MixedFixedFlex: Story = {
  render: () => (
    <Frame height={380}>
      <ChartContainer range={RANGE} width="auto" height="auto" rowGap={8}>
        <ChartRow>
          <YAxis id="v" min={140} max={230} />
          <Layers>
            <LineChart series={s} column="fast" axis="v" />
          </Layers>
        </ChartRow>
        <ChartRow height={90}>
          <YAxis id="hr" min={40} max={190} />
          <Layers>
            <AreaChart series={hr} column="bpm" axis="hr" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </Frame>
  ),
};

/**
 * **NumericHeight** — a managed container doesn't need `'auto'`: a numeric
 * `height={360}` gets the same flex column, for callers who already know the
 * pixels (a fixed panel, a test).
 */
export const NumericHeight: Story = {
  render: () => (
    <ChartContainer range={RANGE} width={620} height={360}>
      <ChartRow>
        <YAxis id="v" min={140} max={230} />
        <Layers>
          <LineChart series={s} column="fast" axis="v" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **StripChangesHeight** — the case every hand-carried constant gets wrong.
 * Same markup twice: a bare axis strip, and one with a `label` (16px taller).
 * Both charts are exactly 300px tall; the flex row absorbs the difference,
 * because CSS is doing the subtraction and nobody wrote the strip's height
 * down.
 */
export const StripChangesHeight: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 16 }}>
      {[undefined, 'Session time (UTC)'].map((label) => (
        <div key={label ?? 'bare'} style={{ flex: 1, minWidth: 0 }}>
          <ChartContainer
            range={RANGE}
            width="auto"
            height={300}
            showAxis={label === undefined}
          >
            <ChartRow>
              <YAxis id="v" min={140} max={230} />
              <Layers>
                <LineChart series={s} column="fast" axis="v" />
              </Layers>
            </ChartRow>
            {label !== undefined && <XAxis label={label} />}
          </ChartContainer>
        </div>
      ))}
    </div>
  ),
};

/**
 * **ResizablePanels** — the splitter recipe, rebuilt on the managed column.
 * One flex row absorbs slack, one fixed row the drag resizes, a plain
 * `<div role="separator">` between them. Compare with the shipped
 * recipe: `AXIS_H`, `useMeasuredSize`, and both clamps' plot arithmetic are
 * gone — the drag clamps its own row and CSS handles everything else.
 */
export const ResizablePanels: Story = {
  render: () => {
    function PriceOverIndicator() {
      const [bottomH, setBottomH] = useState(120);
      const dragY = useRef(0);
      const dragging = useRef(false);
      return (
        <Frame height={420}>
          <ChartContainer range={RANGE} width="auto" height="auto">
            <ChartRow>
              <YAxis id="price" side="right" min={140} max={230} />
              <Layers>
                <LineChart series={s} column="fast" as="price" axis="price" />
              </Layers>
            </ChartRow>
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize panels"
              style={{
                height: 7,
                cursor: 'row-resize',
                touchAction: 'none',
                background:
                  'linear-gradient(#0000 45%, #94a3b8 45% 55%, #0000 55%)',
              }}
              onPointerDown={(e) => {
                dragging.current = true;
                dragY.current = e.clientY;
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!dragging.current) return;
                const dy = e.clientY - dragY.current;
                dragY.current = e.clientY;
                // Drag down grows the top (the flex row absorbs it) by
                // shrinking the bottom. Clamp only this row; CSS guards the
                // rest.
                if (dy) setBottomH((h) => Math.max(60, h - dy));
              }}
              onPointerUp={(e) => {
                dragging.current = false;
                e.currentTarget.releasePointerCapture(e.pointerId);
              }}
            />
            <ChartRow height={bottomH}>
              <YAxis id="hr" side="right" min={40} max={190} />
              <Layers>
                <AreaChart series={hr} column="bpm" as="hr" axis="hr" />
              </Layers>
            </ChartRow>
          </ChartContainer>
        </Frame>
      );
    }
    return <PriceOverIndicator />;
  },
};

/**
 * **TooShort** — a 170px box. `minHeight: 0` on the flex chain means the row
 * genuinely shrinks rather than overflowing; a consumer who needs a floor
 * puts a `min-height` on their own wrapper, one CSS property instead of a
 * clamp expression.
 */
export const TooShort: Story = {
  render: () => (
    <Frame height={170}>
      <ChartContainer range={RANGE} width="auto" height="auto">
        <ChartRow>
          <YAxis id="v" min={140} max={230} />
          <Layers>
            <LineChart series={s} column="fast" axis="v" />
          </Layers>
        </ChartRow>
      </ChartContainer>
    </Frame>
  ),
};
