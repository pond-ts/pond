import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { AreaChart } from '../src/AreaChart.js';
import { BarChart } from '../src/BarChart.js';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { docsTheme, docsThemeDark } from '../src/docs-theme.fixture.js';
import { stubCanvasContext, type CtxCall } from './canvas-mock.js';

afterEach(cleanup);

/**
 * The sequential ramp's roles must reach the **canvas**, not merely the theme
 * object.
 *
 * Theme roles resolve per-primitive (`line[semantic] ?? line.default`), and a
 * role a layer doesn't consult falls back **silently** — no warning, no visual
 * cue beyond "that colour didn't change." Two roles shipped dead this way
 * during the charts wave (`bar.muted`, `area.context`) precisely because the
 * theme entry existed and nobody checked the pixels. `seq1…seq8` was added for
 * the docs gallery's many-series charts, so it gets the check the other two
 * didn't: mount each layer with `as="seqN"` and assert the ramp hex shows up as
 * a `strokeStyle` / `fillStyle` on the recording context.
 *
 * The website's `useSiteChartTheme` defines the same role names over the same
 * `--pond-viz-seq-*` values (guarded by `docs-theme-sync.test.ts`), so this
 * covers both.
 */

const schema = [
  { name: 'time', kind: 'time' },
  { name: 'v', kind: 'number' },
] as const;

const series = () =>
  new TimeSeries({
    name: 's',
    schema,
    rows: [
      [0, 1],
      [1, 3],
      [2, 2],
    ] as [number, number][],
  });

/** Every colour string assigned to `fillStyle` / `strokeStyle`, lowercased. */
function paintedColours(calls: CtxCall[]): string[] {
  return calls
    .filter(
      (c) =>
        c.type === 'set' &&
        (c.name === 'fillStyle' || c.name === 'strokeStyle'),
    )
    .map((c) => c.args[0])
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.toLowerCase());
}

function paint(node: React.ReactElement): string[] {
  const stub = stubCanvasContext();
  try {
    render(node);
    return paintedColours(stub.calls);
  } finally {
    stub.restore();
  }
}

describe('docsTheme sequential-ramp roles reach the canvas', () => {
  it('<LineChart as="seq3"> strokes the ramp step, not the default', () => {
    const painted = paint(
      <ChartContainer range={[0, 2]} width={300} theme={docsTheme}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} />
          <Layers>
            <LineChart series={series()} column="v" axis="a" as="seq3" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(painted).toContain('#0d7474'); // docsPalette.light.vizSeq3
    expect(painted).not.toContain(docsTheme.line.default.color.toLowerCase());
  });

  it('<AreaChart as="seq6"> fills and outlines with the ramp step', () => {
    const painted = paint(
      <ChartContainer range={[0, 2]} width={300} theme={docsTheme}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} />
          <Layers>
            <AreaChart series={series()} column="v" axis="a" as="seq6" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    // The outline strokes the step directly; the fill goes through a gradient
    // whose stops are built from the same colour.
    expect(painted).toContain('#38c2af'); // docsPalette.light.vizSeq6
  });

  it('<BarChart as="seq2"> fills the ramp step', () => {
    const painted = paint(
      <ChartContainer range={[0, 3]} width={300} theme={docsTheme}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} />
          <Layers>
            <BarChart series={series()} column="v" axis="a" as="seq2" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(painted).toContain('#0d5c60'); // docsPalette.light.vizSeq2
  });

  it('a stacked <BarChart> picks the roles up by group name', () => {
    // The stacked path reads `colors[g] ?? theme.bar[g]?.fill ?? default` — a
    // group *named* for a ramp step is coloured with no `colors` prop at all.
    const groups = new Map([
      ['seq1', series()],
      ['seq5', series()],
      ['seq8', series()],
    ]);
    const painted = paint(
      <ChartContainer range={[0, 3]} width={300} theme={docsTheme}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={12} />
          <Layers>
            <BarChart series={groups} column="v" axis="a" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(painted).toContain('#0c444b'); // seq1
    expect(painted).toContain('#27a79a'); // seq5
    expect(painted).toContain('#bbe8df'); // seq8
  });

  it('the dark ramp paints the dark steps', () => {
    const painted = paint(
      <ChartContainer range={[0, 2]} width={300} theme={docsThemeDark}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} />
          <Layers>
            <LineChart series={series()} column="v" axis="a" as="seq3" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(painted).toContain('#1e7270'); // docsPalette.dark.vizSeq3
  });

  it('an unknown step falls back to `default` rather than painting nothing', () => {
    const painted = paint(
      <ChartContainer range={[0, 2]} width={300} theme={docsTheme}>
        <ChartRow height={100}>
          <YAxis id="a" min={0} max={4} />
          <Layers>
            <LineChart series={series()} column="v" axis="a" as="seq99" />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    expect(painted).toContain(docsTheme.line.default.color.toLowerCase());
  });
});
