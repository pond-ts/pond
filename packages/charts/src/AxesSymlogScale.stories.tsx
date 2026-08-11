import type { Meta } from '@storybook/react-vite';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from './ChartContainer.js';
import { ChartRow } from './ChartRow.js';
import { Layers } from './Layers.js';
import { BarChart } from './BarChart.js';
import { YAxis } from './YAxis.js';

/**
 * **`<YAxis scale="symlog">`** — linear through zero, logarithmic beyond
 * ([PND-SYMLOG]).
 *
 * The shape it exists for: a **diverging** measure spanning orders of magnitude
 * on **both** sides of zero, where one extreme dwarfs the rest. `scale="log"`
 * cannot express it at all (no zero, no negatives), and `scale="linear"`
 * flattens everything outside the top decade onto the axis line — so the small
 * and mid-range values, which are usually the finding, become unreadable.
 *
 * The fan-out is a comparison first (the three scales on identical data, which is
 * the only way the problem is visible), then one story per knob.
 *
 * **"Linear through zero, logarithmic beyond" is how it reads, not two segments.**
 * The curve is the single smooth `sign(x) · log1p(|x / knee|)`. If you are
 * replacing a hand-rolled *piecewise* curve (exactly linear below the knee,
 * `log10` above), expect small values to sit materially lower — and no
 * `linearWindow` recovers the old shape, because the difference is the curve.
 * See `<YAxis scale>`'s docstring.
 *
 * No `theme` prop — these render `defaultTheme`, per CLAUDE.md.
 */
const meta = {
  title: 'Axes/Symlog scale',
  parameters: { layout: 'centered' },
} satisfies Meta;
export default meta;

const W = 620;

/**
 * A diverging series spanning ±10⁶ with most of its mass small — one tail
 * scenario dwarfing everything else, which is the case symlog is for.
 */
const diverging = () =>
  new TimeSeries({
    name: 'd',
    schema: [
      { name: 'timeRange', kind: 'timeRange' },
      { name: 'v', kind: 'number' },
    ],
    rows: [
      [[0, 1], -1_000_000],
      [[1, 2], -42_000],
      [[2, 3], -3_100],
      [[3, 4], -180],
      [[4, 5], 0],
      [[5, 6], 260],
      [[6, 7], 4_400],
      [[7, 8], 58_000],
      [[8, 9], 910_000],
    ],
  } as never);

const caption: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
  maxWidth: W,
  marginTop: 8,
  lineHeight: 1.5,
};

function Chart({
  scale,
  linearWindow,
  height = 220,
}: {
  scale?: 'linear' | 'log' | 'symlog';
  linearWindow?: number;
  height?: number;
}) {
  return (
    <ChartContainer range={[0, 9]} width={W} showAxis={false}>
      <ChartRow height={height}>
        <YAxis
          id="v"
          width={72}
          label=""
          {...(scale ? { scale } : {})}
          {...(linearWindow !== undefined ? { linearWindow } : {})}
        />
        <Layers>
          <BarChart series={diverging()} column="v" axis="v" id="d" gap={2} />
        </Layers>
      </ChartRow>
    </ChartContainer>
  );
}

/**
 * **The comparison** — the same data on a linear axis and a symlog one. This is
 * the story to look at first: on linear, every bar but the two extremes is a
 * hairline on the zero line, and the axis labels say nothing about them.
 */
export const LinearVsSymlog = {
  render: () => (
    <div style={{ display: 'grid', gap: 20 }}>
      <div>
        <div style={{ font: '12px system-ui', color: '#667' }}>
          scale=&quot;linear&quot;
        </div>
        <Chart />
      </div>
      <div>
        <div style={{ font: '12px system-ui', color: '#667' }}>
          scale=&quot;symlog&quot; (default 2% knee)
        </div>
        <Chart scale="symlog" />
      </div>
      <p style={caption}>
        Identical data. On <strong>linear</strong>, seven of the nine bars are
        indistinguishable from zero and no tick describes them. On{' '}
        <strong>symlog</strong> the small and mid values separate, and the ticks
        land on zero, the knee (±20k) and the decades beyond — so the region the
        scale opened up is also the region it labels.
      </p>
    </div>
  ),
};

/** **Default knee** — 2% of the domain's largest magnitude. */
export const DefaultWindow = {
  render: () => (
    <div>
      <Chart scale="symlog" />
      <p style={caption}>
        No <code>linearWindow</code>: the knee is <strong>2%</strong> of{' '}
        <code>maxAbs</code>, so a ±1M domain is linear through ±20k. Relative
        rather than absolute, so it survives a domain change with no arithmetic
        at the call site.
      </p>
    </div>
  ),
};

/** **A wider window** — more of the middle reads linearly. */
export const WideWindow = {
  render: () => (
    <div>
      <Chart scale="symlog" linearWindow={0.2} />
      <p style={caption}>
        <code>
          linearWindow={'{'}0.2{'}'}
        </code>{' '}
        — the knee moves out to 20% of <code>maxAbs</code> (±200k), so more of
        the range is linear and the log region compresses. Fewer decades remain
        past the knee, so the ladder thins accordingly.
      </p>
    </div>
  ),
};

/** **A narrow window** — closer to a pure log axis, but still admitting zero. */
export const NarrowWindow = {
  render: () => (
    <div>
      <Chart scale="symlog" linearWindow={0.001} />
      <p style={caption}>
        <code>
          linearWindow={'{'}0.001{'}'}
        </code>{' '}
        — a ±1k knee, so almost the whole range is logarithmic. Unlike{' '}
        <code>scale=&quot;log&quot;</code>, zero still has a real position
        rather than being dropped.
      </p>
    </div>
  ),
};

/**
 * **The window swallows the domain** — the degenerate case, kept because it must
 * degrade to something correct rather than to an empty axis.
 */
export const WindowSwallowsDomain = {
  render: () => (
    <div>
      <Chart scale="symlog" linearWindow={1} />
      <p style={caption}>
        <code>
          linearWindow={'{'}1{'}'}
        </code>{' '}
        puts the knee at <code>maxAbs</code>, so there is nothing left to grid
        logarithmically. The axis defers to the ordinary linear ticks — which is{' '}
        <em>correct</em>, not a fallback: inside the knee, symlog <em>is</em>{' '}
        linear.
      </p>
    </div>
  ),
};

/** **One-sided** — a domain that never crosses zero still works, and the ladder
 *  clips rather than sprouting ticks it has no room for. */
export const OneSidedDomain = {
  render: () => (
    <div>
      <ChartContainer range={[0, 9]} width={W} showAxis={false}>
        <ChartRow height={220}>
          <YAxis id="v" width={72} label="" scale="symlog" min={0} max={1e6} />
          <Layers>
            <BarChart series={diverging()} column="v" axis="v" id="d" gap={2} />
          </Layers>
        </ChartRow>
      </ChartContainer>
      <p style={caption}>
        <code>
          min={'{'}0{'}'}
        </code>{' '}
        — the mirrored half of the ladder falls outside the domain and is
        clipped, so no tick is drawn off-plot. The negative bars have no
        position and read as gaps.
      </p>
    </div>
  ),
};
