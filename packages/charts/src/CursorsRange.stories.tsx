import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { Sequence } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { RangeCursor } from './cursors.js';
import { priceSeries, RANGE } from './story-data.fixture.js';

/**
 * **`<RangeCursor>` drag** — step 3 of the interaction wave (RFC §6 / A4.2):
 * the drag props with honest names, on the single brush recognizer. One story
 * per knob, per the systematic-coverage rule: the drag with a `sequence`
 * (bucket-by-bucket) and without (freeform), `dragModifier` with pan on and
 * off, the `enableDrag` OFF switch, and the drag-to-zoom scenario
 * (`onDragRelease` → `setRange` — the payload's `x` is exactly what
 * `ChartContainer.range` accepts, which is the name-level coherence the
 * component is named for).
 *
 * The legacy `cursor="region"` + `onRegionSelect` stories remain under
 * `Cursors/Region` for the deprecation window — they pin the old surface;
 * these pin the new one.
 */
const W = 620;

const meta = {
  title: 'Cursors/Range',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;
type Story = StoryObj;

/** The released-span readout the drag stories share: shows the last
 *  `onDragRelease` payload so the one-shot fire (and the revert — the band
 *  does not persist) is observable. */
function SpanReadout({ span }: { span: readonly [number, number] | null }) {
  return (
    <div style={{ fontSize: 12, fontFamily: 'monospace', minHeight: 16 }}>
      {span
        ? `released: [${new Date(span[0]).toISOString().slice(11, 19)}, ${new Date(span[1]).toISOString().slice(11, 19)}]`
        : 'drag across the plot…'}
    </div>
  );
}

function Chart({
  children,
  ...props
}: { children?: React.ReactNode } & Partial<
  Parameters<typeof ChartContainer>[0]
>) {
  return (
    <ChartContainer width={W} range={RANGE} {...props}>
      {children}
      <ChartRow height={220}>
        <Layers>
          <LineChart series={priceSeries()} column="price" axis="p" />
        </Layers>
        <YAxis id="p" side="right" format=",.0f" />
      </ChartRow>
    </ChartContainer>
  );
}

/** **Drag with a `sequence`.** The band snaps to 10-minute buckets on hover,
 *  a drag extends **bucket by bucket**, and `onDragRelease` fires once on
 *  release with the covered span — then the cursor **reverts** to the
 *  single-bucket highlight (it does not keep the range). */
function DragWithSequenceDemo() {
  const [span, setSpan] = useState<readonly [number, number] | null>(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: W }}>
      <SpanReadout span={span} />
      <Chart>
        <RangeCursor
          sequence={Sequence.every('10m')}
          onDragRelease={(s) => setSpan(s.x)}
        />
      </Chart>
    </div>
  );
}
export const DragWithSequence: Story = {
  render: () => <DragWithSequenceDemo />,
};

/** **Freeform drag (no sequence).** Hover renders as a plain line; a drag
 *  shades and releases the **raw** `[lo, hi]` span, no bucket snapping. */
function FreeformDragDemo() {
  const [span, setSpan] = useState<readonly [number, number] | null>(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: W }}>
      <SpanReadout span={span} />
      <Chart>
        <RangeCursor onDragRelease={(s) => setSpan(s.x)} />
      </Chart>
    </div>
  );
}
export const FreeformDrag: Story = { render: () => <FreeformDragDemo /> };

/** **`dragModifier="shift"` with pan ON.** Plain drag **pans** the view;
 *  **shift-drag** selects. The modifier is how the two gestures share the
 *  surface — declare it whenever pan is also enabled. */
function DragModifierWithPanDemo() {
  const [span, setSpan] = useState<readonly [number, number] | null>(null);
  const [range, setRange] = useState<readonly [number, number]>(RANGE);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: W }}>
      <SpanReadout span={span} />
      <Chart range={range} panZoom="pan" onTimeRangeChange={(r) => setRange(r)}>
        <RangeCursor
          sequence={Sequence.every('10m')}
          dragModifier="shift"
          onDragRelease={(s) => setSpan(s.x)}
        />
      </Chart>
    </div>
  );
}
export const DragModifierWithPan: Story = {
  render: () => <DragModifierWithPanDemo />,
};

/** **`dragModifier="shift"` with pan OFF.** The modifier is only enforced
 *  while pan is enabled — with no pan there is no gesture conflict, so a
 *  plain drag selects too (shift also works). */
function DragModifierPanOffDemo() {
  const [span, setSpan] = useState<readonly [number, number] | null>(null);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: W }}>
      <SpanReadout span={span} />
      <Chart>
        <RangeCursor
          sequence={Sequence.every('10m')}
          dragModifier="shift"
          onDragRelease={(s) => setSpan(s.x)}
        />
      </Chart>
    </div>
  );
}
export const DragModifierPanOff: Story = {
  render: () => <DragModifierPanOffDemo />,
};

/** **`enableDrag={false}` — the OFF switch.** The callback stays wired but the
 *  gesture is frozen (no anchor, no release; with pan on, plain drag pans
 *  again). It exists as a *disabler* — the drag is already enabled by wiring
 *  `onDragRelease`, so you only ever set this to `false`. Toggle it live. */
function DragDisabledDemo() {
  const [span, setSpan] = useState<readonly [number, number] | null>(null);
  const [enabled, setEnabled] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: W }}>
      <label style={{ fontSize: 12, alignSelf: 'flex-start' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />{' '}
        enableDrag
      </label>
      <SpanReadout span={span} />
      <Chart>
        <RangeCursor
          sequence={Sequence.every('10m')}
          enableDrag={enabled}
          onDragRelease={(s) => setSpan(s.x)}
        />
      </Chart>
    </div>
  );
}
export const DragDisabled: Story = { render: () => <DragDisabledDemo /> };

/** **Drag to zoom** — the scenario the payload shape is built for:
 *  `onDragRelease={(s) => setRange(s.x)}`. The span's `x` is exactly what
 *  `ChartContainer.range` accepts (a RangeCursor emits what `range` takes),
 *  so drag-to-zoom is one line; **Reset** restores the full range. */
function DragToZoomDemo() {
  const full = RANGE;
  const [range, setRange] = useState<readonly [number, number]>(full);
  const zoomed = range[0] !== full[0] || range[1] !== full[1];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: W }}>
      <button
        type="button"
        onClick={() => setRange(full)}
        disabled={!zoomed}
        style={{ alignSelf: 'flex-start', padding: '2px 10px', fontSize: 12 }}
      >
        Reset zoom
      </button>
      <Chart range={range}>
        <RangeCursor
          sequence={Sequence.every('10m')}
          onDragRelease={(s) => setRange(s.x)}
        />
      </Chart>
    </div>
  );
}
export const DragToZoom: Story = { render: () => <DragToZoomDemo /> };
