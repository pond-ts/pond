import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import type { CreateSpec } from './context.js';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { LineChart } from './LineChart.js';
import { YAxis } from './YAxis.js';
import { Region } from './annotations.js';
import { Baseline } from './annotations.js';
import { Marker } from './annotations.js';
import { estelaTheme } from './theme.js';

/** A 40-minute interval on a 1-minute grid (5:00–5:40), so the x is wall-clock. */
const BASE = Date.UTC(2026, 0, 1, 5, 0, 0);
const STEP = 60_000;
const N = 41;
const INTERVAL: readonly [number, number] = [BASE, BASE + (N - 1) * STEP];

/** A wavy power trace (W) over the interval — the foam (data) line. */
function power() {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([
      BASE + i * STEP,
      165 + 60 * Math.sin(i / 3) + 22 * Math.sin(i * 1.4),
    ]);
  }
  return new TimeSeries({
    name: 'power',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'watts', kind: 'number' },
    ] as const,
    rows,
  });
}

/** A heart-rate trace over the same interval — a second row to show guides on. */
function hr() {
  const rows: Array<[number, number]> = [];
  for (let i = 0; i < N; i += 1) {
    rows.push([BASE + i * STEP, 140 + 30 * Math.sin(i / 4)]);
  }
  return new TimeSeries({
    name: 'hr',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'bpm', kind: 'number' },
    ] as const,
    rows,
  });
}

/** HR re-keyed onto cumulative distance (metres) — drives the value-axis variant. */
function rideByDistance() {
  const rows: Array<[number, number, number]> = [];
  let cum = 0;
  for (let i = 0; i < 50; i += 1) {
    cum += 90 + 40 * Math.sin(i / 6);
    rows.push([BASE + i * STEP, cum, 140 + 28 * Math.sin(i / 7)]);
  }
  return new TimeSeries({
    name: 'ride',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'cumDist', kind: 'number' },
      { name: 'hr', kind: 'number' },
    ] as const,
    rows,
  }).byValue('cumDist');
}

const meta = {
  title: 'Charts/Annotations',
  parameters: { layout: 'centered' },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * **In context** — the data stays **foam** (white), the marks you place are
 * **turquoise**: a selected `<Region>` (5:15–5:35, with edge handles), a
 * `<Baseline>` at 225 W, and a `<Marker>` at 5:28. They render above the data,
 * inert to the pointer (pan/zoom keeps the surface). Move the pointer over the
 * region / marker to see it brighten — luminosity = attention.
 */
export const InContext: Story = {
  render: () => (
    <ChartContainer range={INTERVAL} width={680} theme={estelaTheme}>
      <ChartRow height={280}>
        <YAxis id="power" label="W" min={0} max={300} />
        <Layers>
          <LineChart series={power()} column="watts" as="foam" />
          <Region
            from={BASE + 15 * STEP}
            to={BASE + 35 * STEP}
            label="5:15–5:35"
            selected
          />
          <Baseline value={225} label="225 W" />
          <Marker at={BASE + 28 * STEP} label="5:28" />
        </Layers>
      </ChartRow>
    </ChartContainer>
  ),
};

/**
 * **The names generalize past time.** Same `<Marker>` / `<Region>`, now on a
 * **value** x axis (HR over cumulative distance) — a `<Marker at={3000}>` is a
 * lap boundary, a `<Region>` is a zone. The mockup called the vertical mark a
 * "time line"; it's really a marker at an x, time or value.
 */
export const ValueAxis: Story = {
  render: () => {
    const ride = rideByDistance();
    return (
      <ChartContainer width={680} theme={estelaTheme} timeFormat=",.0f">
        <ChartRow height={260}>
          <YAxis id="hr" label="bpm" />
          <Layers>
            <LineChart series={ride} column="hr" as="foam" />
            <Region from={2000} to={3200} label="Climb" />
            <Marker at={3000} label="Lap 3" selected />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Selection state** — toggle `selected` to flip a region between `rest` (calm,
 * the data reads through) and `selected` (brighter, edge handles out). Live
 * select + drag-to-edit is a later phase (an explicit edit mode); here it's a
 * controlled input.
 */
export const Selectable: Story = {
  args: { selected: true },
  argTypes: { selected: { control: 'boolean' } },
  render: (args) => {
    const selected = (args as { selected?: boolean }).selected ?? false;
    return (
      <ChartContainer range={INTERVAL} width={680} theme={estelaTheme}>
        <ChartRow height={260}>
          <YAxis id="power" label="W" min={0} max={300} />
          <Layers>
            <LineChart series={power()} column="watts" as="foam" />
            <Region
              from={BASE + 15 * STEP}
              to={BASE + 35 * STEP}
              label="interval"
              selected={selected}
            />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Editable (Phase 2).** Pass `onChange` and a mark becomes draggable — grab a
 * handle and it follows the pointer, reporting the new position (controlled, held
 * in `useState` here). The `<Marker>` moves whole; the `<Region>`'s edges resize
 * independently; the `<Baseline>` drags vertically (its label tracks the value).
 * Grabbing a handle **claims the gesture**, so it never starts a pan; hover a
 * handle to see the resize cursor + the mark lift.
 */
export const Editable: Story = {
  render: () => {
    const [markerAt, setMarkerAt] = useState(BASE + 28 * STEP);
    const [region, setRegion] = useState({
      from: BASE + 14 * STEP,
      to: BASE + 33 * STEP,
    });
    const [threshold, setThreshold] = useState(225);
    return (
      <ChartContainer
        range={INTERVAL}
        width={680}
        theme={estelaTheme}
        editAnnotations
      >
        <ChartRow height={280}>
          <YAxis id="power" label="W" min={0} max={300} />
          <Layers>
            <LineChart series={power()} column="watts" as="foam" />
            <Region
              from={region.from}
              to={region.to}
              label="interval"
              onChange={setRegion}
            />
            <Baseline
              value={threshold}
              label={`${Math.round(threshold)} W`}
              onChange={setThreshold}
            />
            <Marker at={markerAt} onChange={setMarkerAt} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Live selection.** In edit mode, click a mark to select it — it reports its
 * `id` through `onSelectAnnotation`, brightens, and keeps its handles out (where
 * `Selectable` drove that from a control, this is the real click). Click empty
 * canvas to deselect. **Double-click** a region's span (even outside edit mode)
 * selects it — the shortcut into region editing. Markers and baselines always win
 * over a region they sit on.
 */
export const Select: Story = {
  render: () => {
    const [edit, setEdit] = useState(true);
    const [selectedId, setSelectedId] = useState<string | null>('region');
    const [markerAt, setMarkerAt] = useState(BASE + 28 * STEP);
    const [region, setRegion] = useState({
      from: BASE + 15 * STEP,
      to: BASE + 35 * STEP,
    });
    const [threshold, setThreshold] = useState(225);
    return (
      <div>
        <button
          type="button"
          onClick={() => setEdit((v) => !v)}
          style={{
            marginBottom: 10,
            padding: '4px 10px',
            borderRadius: 6,
            border: `1px solid ${edit ? '#7FE2D2' : '#2c4a4a'}`,
            background: edit ? '#0B4E58' : 'transparent',
            color: '#a9d6cf',
            font: '12px ui-monospace, monospace',
            cursor: 'pointer',
          }}
        >
          ✎ Edit {edit ? 'on' : 'off'}
        </button>
        <ChartContainer
          range={INTERVAL}
          width={680}
          theme={estelaTheme}
          editAnnotations={edit}
          onSelectAnnotation={setSelectedId}
        >
          <ChartRow height={280}>
            <YAxis id="power" label="W" min={0} max={300} />
            <Layers>
              <LineChart series={power()} column="watts" as="foam" />
              <Region
                id="region"
                from={region.from}
                to={region.to}
                label="interval"
                selected={selectedId === 'region'}
                onChange={setRegion}
              />
              <Baseline
                id="baseline"
                value={threshold}
                label={`${Math.round(threshold)} W`}
                selected={selectedId === 'baseline'}
                onChange={setThreshold}
              />
              <Marker
                id="marker"
                at={markerAt}
                label="5:28"
                selected={selectedId === 'marker'}
                onChange={setMarkerAt}
              />
            </Layers>
          </ChartRow>
        </ChartContainer>
      </div>
    );
  },
};

/**
 * **Multi-row guides.** A `<Marker>` / `<Region>` lives on *one* row (the power
 * row), but the container throws each mark's x across the **other** row as a faint
 * dashed guide — so you can read how the interval / marker line up against the HR
 * trace and the shared x axis. Edit the power-row marks (drag) and the guides on
 * the HR row track them. (Guides come from the registry — a row draws the *other*
 * rows' mark positions, never its own.)
 */
export const MultiRow: Story = {
  render: () => {
    const [markerAt, setMarkerAt] = useState(BASE + 24 * STEP);
    const [region, setRegion] = useState({
      from: BASE + 8 * STEP,
      to: BASE + 18 * STEP,
    });
    const [hrMarkerAt, setHrMarkerAt] = useState(BASE + 14 * STEP);
    const [hrRegion, setHrRegion] = useState({
      from: BASE + 28 * STEP,
      to: BASE + 36 * STEP,
    });
    return (
      <ChartContainer
        range={INTERVAL}
        width={680}
        theme={estelaTheme}
        editAnnotations
      >
        <ChartRow height={170}>
          <YAxis id="power" label="W" min={0} max={300} />
          <Layers>
            <LineChart series={power()} column="watts" as="foam" />
            <Region
              from={region.from}
              to={region.to}
              label="interval"
              onChange={setRegion}
            />
            <Marker at={markerAt} onChange={setMarkerAt} />
          </Layers>
        </ChartRow>
        <ChartRow height={170}>
          <YAxis id="hr" label="bpm" min={80} max={200} />
          <Layers>
            <LineChart series={hr()} column="bpm" as="hr" />
            <Region
              from={hrRegion.from}
              to={hrRegion.to}
              label="zone"
              onChange={setHrRegion}
            />
            <Marker at={hrMarkerAt} onChange={setHrMarkerAt} />
          </Layers>
        </ChartRow>
      </ChartContainer>
    );
  },
};

/**
 * **Creating annotations.** The library owns the *gesture*; the consumer owns the
 * toolbar + state (the buttons here stand in for the network-traffic example's).
 * Arm a tool, then on the plot: click or drag places a `Marker`/`Baseline`;
 * press-drag-release draws a `Region`. A preview tracks the pointer (with the
 * cross-row guide on other rows). On release the mark is added and the tool
 * disarms — spring-loaded back to idle, where the fresh mark is editable.
 */
export const Create: Story = {
  render: () => {
    const [tool, setTool] = useState<CreateSpec['kind'] | null>(null);
    const [snap, setSnap] = useState(true);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [marks, setMarks] = useState<Array<{ id: number } & CreateSpec>>([]);
    const nextId = useRef(0);
    const replace = (id: number, next: { id: number } & CreateSpec) =>
      setMarks((ms) => ms.map((m) => (m.id === id ? next : m)));
    const toolBtn = (k: CreateSpec['kind'], label: string) => (
      <button
        type="button"
        onClick={() => setTool((t) => (t === k ? null : k))}
        style={{
          padding: '4px 10px',
          borderRadius: 6,
          border: `1px solid ${tool === k ? '#7FE2D2' : '#2c4a4a'}`,
          background: tool === k ? '#0B4E58' : 'transparent',
          color: '#a9d6cf',
          font: '12px ui-monospace, monospace',
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    );
    return (
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {toolBtn('baseline', 'Baseline')}
          {toolBtn('marker', 'Marker')}
          {toolBtn('region', 'Region')}
          <button
            type="button"
            onClick={() => setSnap((s) => !s)}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid #2c4a4a',
              background: snap ? '#0B4E58' : 'transparent',
              color: '#a9d6cf',
              font: '12px ui-monospace, monospace',
              cursor: 'pointer',
            }}
          >
            Snap {snap ? '✓' : '✗'}
          </button>
        </div>
        <ChartContainer
          range={INTERVAL}
          width={680}
          theme={estelaTheme}
          editAnnotations
          creating={tool}
          snap={snap}
          onSelectAnnotation={setSelectedId}
          onCreate={(spec) => {
            const id = nextId.current++;
            setMarks((ms) => [...ms, { id, ...spec }]);
            setSelectedId(String(id)); // creation also selects
            setTool(null); // spring-loaded — disarm after one
          }}
        >
          <ChartRow height={280}>
            <YAxis id="power" label="W" min={0} max={300} />
            <Layers>
              <LineChart series={power()} column="watts" as="foam" />
              {marks.map((m) =>
                m.kind === 'marker' ? (
                  <Marker
                    key={m.id}
                    id={String(m.id)}
                    at={m.at}
                    selected={selectedId === String(m.id)}
                    onChange={(at) =>
                      replace(m.id, { id: m.id, kind: 'marker', at })
                    }
                  />
                ) : m.kind === 'region' ? (
                  <Region
                    key={m.id}
                    id={String(m.id)}
                    from={m.from}
                    to={m.to}
                    selected={selectedId === String(m.id)}
                    onChange={(next) =>
                      replace(m.id, { id: m.id, kind: 'region', ...next })
                    }
                  />
                ) : (
                  <Baseline
                    key={m.id}
                    id={String(m.id)}
                    value={m.value}
                    axis={m.axis}
                    selected={selectedId === String(m.id)}
                    onChange={(value) =>
                      replace(m.id, {
                        id: m.id,
                        kind: 'baseline',
                        value,
                        axis: m.axis,
                      })
                    }
                  />
                ),
              )}
            </Layers>
          </ChartRow>
        </ChartContainer>
      </div>
    );
  },
};
