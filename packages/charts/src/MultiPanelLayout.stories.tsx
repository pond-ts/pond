import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import type { ChartTheme } from './theme.js';
import { docsTheme } from './docs-theme.fixture.js';

/**
 * A **full multi-panel layout** the way a financial tool assembles it (the Tidal
 * direction): a vol panel with three series on **dual L/R axes**, a **draggable
 * splitter**, and a price panel below — the whole thing **fills its container**
 * and **reflows on resize**, with the bottom panel absorbing the remaining space.
 *
 * Everything here is buildable on today's primitives with **no library change** —
 * `ChartContainer` renders `{children}` as a plain flex column and rows
 * self-register through context, so a splitter `<div>` dropped *between* the
 * `<ChartRow>`s just lives in the stack (it never calls `registerRow`, so the
 * gutter/scale machinery ignores it). Each drag frame's new `height` flows into
 * the row's `height`-keyed scale memo, so it repaints with no explicit invalidate.
 *
 * **The one rough edge (drives PLAN #14 — responsive sizing / fill).** The
 * container has no `height` prop; it sizes to `sum(rows) + time-axis`. To *fill*
 * an area the consumer must measure the box (ResizeObserver) and back out the
 * flexible row's height — which means knowing the time-axis reserved height
 * (`AXIS_H` below, the internal `TICK_STRIP = 22`). That magic number + the
 * measure-and-subtract boilerplate is exactly what a container `height` / fill
 * mode would remove.
 */

// ---------------------------------------------------------------------------
// deterministic sample data — daily bars, a calm ~20% vol regime with an event
// spike (~49%) decaying back, GARCH as a slow model line that lags, price drifting up
// ---------------------------------------------------------------------------
const SCHEMA = [
  { name: 'time', kind: 'time' },
  { name: 'atm', kind: 'number' },
  { name: 'realized', kind: 'number' },
  { name: 'garch', kind: 'number' },
  { name: 'price', kind: 'number' },
] as const;

const DAYS = 520;
const DAY_MS = 86_400_000;
const BASE = Date.UTC(2024, 0, 1);
const SPIKE_AT = 330;

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSeries(): TimeSeries<typeof SCHEMA> {
  const rnd = mulberry32(42);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  const rows: Array<[number, number, number, number, number]> = [];
  let atm = 0.21;
  let garch = 0.21;
  let price = 160;
  for (let i = 0; i < DAYS; i += 1) {
    if (i === SPIKE_AT) atm = 0.49; // event shock — a near-vertical vol spike
    atm += (0.2 - atm) * 0.06 + (rnd() - 0.5) * 0.012; // decay toward 20% + noise
    atm = Math.max(0.08, atm);
    const realized = Math.max(0.06, atm + (rnd() - 0.5) * 0.02); // tracks atm
    garch += (atm - garch) * 0.08; // slow EMA — the smooth model line, lags atm
    price *= 1 + (rnd() - 0.455) * 0.013; // drifting random walk, gentle uptrend
    rows.push([BASE + i * DAY_MS, r4(atm), r4(realized), r4(garch), r2(price)]);
  }
  return new TimeSeries({ name: 'vol', schema: SCHEMA, rows });
}

// A theme mapping each series' semantic identifier to a distinct line colour.
// (GARCH would read as *dashed* — "a model estimate, not observed" — once
// per-series line style lands; today LineStyle is { color, width } only, so it's
// a distinct hue instead. That gap is the sibling ask to this story.)
const chartTheme: ChartTheme = {
  ...docsTheme,
  line: {
    ...docsTheme.line,
    // The docs ramp, by role: blue / violet / rose / amber.
    atm: { color: '#3d76c2', width: 1.3 },
    realized: { color: '#8168b8', width: 1.3 },
    garch: { color: '#c25450', width: 1.3 },
    price: { color: '#c99a2e', width: 1.6 },
  },
};

// ---------------------------------------------------------------------------
// measure the available box so the layout can fill + reflow
// ---------------------------------------------------------------------------
function useMeasuredSize<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Synchronous initial measurement — doesn't depend on ResizeObserver's
    // first callback firing (its timing isn't guaranteed). RO then keeps it
    // live on later resizes. The setState guard avoids a re-measure loop.
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

const AXIS_H = 22; // TimeAxis TICK_STRIP — the number PLAN #14 would remove
const SPLITTER_H = 7;
const MIN_VOL = 120;
const MIN_PRICE = 90;

function Chip({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '5px 11px',
        borderRadius: 999,
        border: '1px solid #e3e6ee',
        background: '#fff',
        fontSize: 12.5,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        color: '#3b4252',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{ width: 9, height: 9, borderRadius: 2, background: color }}
      />
      {label}
      <strong style={{ fontVariantNumeric: 'tabular-nums', color: '#1b2333' }}>
        {value}
      </strong>
    </span>
  );
}

function MultiPanelDemo() {
  const series = useMemo(buildSeries, []);
  const [boxRef, { width, height }] = useMeasuredSize<HTMLDivElement>();

  // Top (vol) height is user-controlled via the splitter; the bottom (price)
  // panel is flexible — it absorbs whatever space is left, so the layout always
  // fills the box and reflows when the box resizes.
  const [volH, setVolH] = useState(300);
  const plot = Math.max(0, height - AXIS_H - SPLITTER_H);
  const volHeight = Math.min(
    Math.max(volH, MIN_VOL),
    Math.max(MIN_VOL, plot - MIN_PRICE),
  );
  const priceHeight = Math.max(MIN_PRICE, plot - volHeight);

  const dragY = useRef(0);
  const dragging = useRef(false);
  const ready = width > 0 && height > 0;

  const latest = series.at(series.length - 1)?.data();
  const pct = (v: number | undefined) =>
    v == null ? '—' : `${(v * 100).toFixed(2)}%`;
  const usd = (v: number | undefined) => (v == null ? '—' : `$${v.toFixed(2)}`);

  return (
    <div
      style={{
        // Explicit, resizable height rather than 100vh — self-contained (doesn't
        // depend on an ancestor/viewport height) and the resize handle lets you
        // drag the whole demo taller/shorter to watch the panels reflow.
        height: 560,
        minHeight: 280,
        resize: 'vertical',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        padding: 16,
        boxSizing: 'border-box',
        background: '#f6f7fb',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
    >
      <div
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}
      >
        <Chip
          color={chartTheme.line.atm!.color}
          label="ATM Vol"
          value={pct(latest?.atm)}
        />
        <Chip
          color={chartTheme.line.realized!.color}
          label="Realized Vol"
          value={pct(latest?.realized)}
        />
        <Chip
          color={chartTheme.line.garch!.color}
          label="GARCH Vol"
          value={pct(latest?.garch)}
        />
        <Chip
          color={chartTheme.line.price!.color}
          label="Price"
          value={usd(latest?.price)}
        />
      </div>

      <div
        style={{
          fontSize: 12,
          color: '#7b8394',
          marginBottom: 10,
        }}
      >
        Drag the divider to resize the panels · the bottom panel fills the
        remaining space · resize the window and both reflow.
      </div>

      <div ref={boxRef} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
        {ready && (
          <ChartContainer width={width} theme={chartTheme}>
            <ChartRow height={volHeight}>
              <YAxis
                id="vol"
                side="left"
                label="ATM / GARCH"
                format=".1%"
                width={58}
              />
              <YAxis
                id="rvol"
                side="right"
                label="Realized"
                format=".1%"
                width={58}
              />
              <Layers>
                <LineChart series={series} column="atm" as="atm" axis="vol" />
                <LineChart
                  series={series}
                  column="garch"
                  as="garch"
                  axis="vol"
                />
                <LineChart
                  series={series}
                  column="realized"
                  as="realized"
                  axis="rvol"
                />
              </Layers>
            </ChartRow>

            {/* The splitter: a plain child between the rows. It never registers
                as a row, so the container ignores it; it just occupies the flex
                column. Dragging transfers height to the top panel; the bottom
                panel (flexible) reflows to fill. */}
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize panels"
              tabIndex={0}
              onPointerDown={(e) => {
                dragging.current = true;
                dragY.current = e.clientY;
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!dragging.current) return;
                const dy = e.clientY - dragY.current;
                dragY.current = e.clientY;
                if (dy) setVolH((h) => h + dy);
              }}
              onPointerUp={(e) => {
                dragging.current = false;
                e.currentTarget.releasePointerCapture(e.pointerId);
              }}
              style={{
                height: SPLITTER_H,
                cursor: 'row-resize',
                touchAction: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <div
                style={{
                  width: 44,
                  height: 3,
                  borderRadius: 2,
                  background: '#c3c9d6',
                }}
              />
            </div>

            <ChartRow height={priceHeight}>
              <YAxis id="price" side="right" format="$,.0f" width={58} />
              <Layers>
                <LineChart
                  series={series}
                  column="price"
                  as="price"
                  axis="price"
                />
              </Layers>
            </ChartRow>
          </ChartContainer>
        )}
      </div>
    </div>
  );
}

const meta = {
  title: 'Layout/Multi-Panel',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * Vol (dual-axis, 3 series) over Price, with a draggable splitter; fills the
 * viewport and reflows on resize. See the file-level doc for why this needs no
 * library change today and where it motivates PLAN #14.
 */
export const ResizableFill: Story = {
  render: () => <MultiPanelDemo />,
};
