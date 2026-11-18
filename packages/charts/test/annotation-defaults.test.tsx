import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TimeSeries } from 'pond-ts';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { LineChart } from '../src/LineChart.js';
import { YAxis } from '../src/YAxis.js';
import { Baseline, Marker, Region } from '../src/annotations.js';
import { defaultAnnotation as publicDefault } from '../src/index.js';
import {
  defaultAnnotation,
  defaultTheme,
  resolveAnnotation,
  type ChartTheme,
} from '../src/theme.js';

afterEach(cleanup);

/**
 * [PND-ANNOTATIONDEFAULTS] — a theme's `annotation` may be partial (or absent);
 * whatever it leaves out comes from the one exported `defaultAnnotation`, and
 * every place the charts read the register — the marks, the cross-row guides,
 * the x-axis marker pill — falls back to that same object.
 */

const series = new TimeSeries({
  name: 't',
  schema: [
    { name: 'time', kind: 'time' },
    { name: 'v', kind: 'number' },
  ] as const,
  rows: [
    [0, 1],
    [1, 5],
    [2, 9],
    [3, 4],
    [4, 7],
  ] as [number, number][],
});

/** `defaultTheme` with its register swapped for `annotation` (or removed). */
function withAnnotation(annotation: ChartTheme['annotation']): ChartTheme {
  const { annotation: _drop, ...rest } = defaultTheme;
  return annotation === undefined ? rest : { ...rest, annotation };
}

/** A CSS colour as the DOM reports it back from `style.background`. */
function cssColor(color: string): string {
  const el = document.createElement('div');
  el.style.background = color;
  return el.style.background;
}

/**
 * Two rows: the top one holds an indicator `<Marker>` (which casts a guide on
 * the bottom row and a pill on the x axis) and an inert `<Baseline>`, plus
 * `extra`. Returns the colour each of the three surfaces drew in.
 */
function draw(theme: ChartTheme, extra: ReactNode = null) {
  const { container, unmount } = render(
    <ChartContainer
      range={[0, 4]}
      width={300}
      theme={theme}
      timeFormat={() => 'M!'}
    >
      <ChartRow height={120}>
        <YAxis id="a" min={0} max={100} />
        <Layers>
          <LineChart series={series} column="v" axis="a" />
          <Marker at={2} indicator label={false} />
          <Baseline value={50} axis="a" selectable={false} label={false} />
          {extra}
        </Layers>
      </ChartRow>
      <ChartRow height={120}>
        <YAxis id="b" min={0} max={100} />
        <Layers>
          <LineChart series={series} column="v" axis="b" />
        </Layers>
      </ChartRow>
    </ChartContainer>,
  );
  const lines = Array.from(container.querySelectorAll('svg line'));
  const baseline = lines.find((l) => l.getAttribute('y1') === '60');
  const guide = lines.find((l) => l.getAttribute('stroke-dasharray') === '2 3');
  // The x-axis marker pill: the rounded chip (ticks share the 'M!' text).
  const pill = Array.from(container.querySelectorAll('div')).find(
    (d) => d.style.borderRadius === '3px' && d.style.transform.includes('X'),
  );
  const out = {
    baseline: baseline?.getAttribute('stroke'),
    baselineOpacity: Number(baseline?.getAttribute('opacity')),
    guide: guide?.getAttribute('stroke'),
    pill: pill?.style.background,
    lines,
  };
  unmount();
  return out;
}

describe('defaultAnnotation', () => {
  it('is exported from the public index', () => {
    expect(publicDefault).toBe(defaultAnnotation);
    expect(defaultAnnotation).toEqual({
      color: '#14b8a6',
      fillOpacity: 0.1,
      depth: [1, 0.7, 0.4],
    });
  });
});

describe('a partial theme.annotation fills from defaultAnnotation', () => {
  const rolesOnly = withAnnotation({ roles: { ref: { color: '#00aa00' } } });

  it('roles only: baseline, guide and x pill use the default colour', () => {
    const out = draw(rolesOnly);
    expect(out.baseline).toBe(defaultAnnotation.color);
    expect(out.guide).toBe(defaultAnnotation.color);
    expect(out.pill).toBe(cssColor(defaultAnnotation.color));
  });

  it('roles only: the role still restyles the mark that names it', () => {
    const out = draw(
      rolesOnly,
      <Baseline value={25} axis="a" role="ref" label={false} />,
    );
    const roled = out.lines.find((l) => l.getAttribute('y1') === '90');
    expect(roled?.getAttribute('stroke')).toBe('#00aa00');
  });

  it('roles only: an inert mark rests at the default depth[2]', () => {
    expect(draw(rolesOnly).baselineOpacity).toBe(defaultAnnotation.depth[2]);
  });

  it('depth only: its ramp applies; colour and fill are the default', () => {
    const depthOnly = withAnnotation({ depth: [1, 0.9, 0.6] });
    const out = draw(depthOnly);
    expect(out.baseline).toBe(defaultAnnotation.color);
    expect(out.baselineOpacity).toBe(0.6);
    // An inert region body draws at exactly the register's fillOpacity.
    const { container, unmount } = render(
      <ChartContainer range={[0, 4]} width={300} theme={depthOnly}>
        <ChartRow height={120}>
          <YAxis id="a" min={0} max={100} />
          <Layers>
            <LineChart series={series} column="v" axis="a" />
            <Region from={0.5} to={1.5} selectable={false} label={false} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const body = container.querySelector('svg rect');
    expect(body?.getAttribute('fill')).toBe(defaultAnnotation.color);
    expect(Number(body?.getAttribute('opacity'))).toBe(
      defaultAnnotation.fillOpacity,
    );
    unmount();
  });

  it('no annotation at all draws in the default too', () => {
    const out = draw(withAnnotation(undefined));
    expect(out.baseline).toBe(defaultAnnotation.color);
    expect(out.guide).toBe(defaultAnnotation.color);
    expect(out.pill).toBe(cssColor(defaultAnnotation.color));
  });

  it("a theme's own fields still win", () => {
    const out = draw(withAnnotation({ color: '#808080' }));
    expect(out.baseline).toBe('#808080');
    expect(out.guide).toBe('#808080');
    expect(out.pill).toBe(cssColor('#808080'));
  });

  it('changing the exported default changes every surface together', () => {
    const mutable = defaultAnnotation as { color: string };
    const original = mutable.color;
    mutable.color = '#123456';
    try {
      for (const theme of [rolesOnly, withAnnotation(undefined)]) {
        const out = draw(theme);
        expect(out.baseline).toBe('#123456');
        expect(out.guide).toBe('#123456');
        expect(out.pill).toBe(cssColor('#123456'));
      }
    } finally {
      mutable.color = original;
    }
  });
});

describe('resolveAnnotation', () => {
  it('returns the default itself for an absent register', () => {
    expect(resolveAnnotation(undefined)).toBe(defaultAnnotation);
  });

  it('keeps the optional fields a theme sets and fills the base ones', () => {
    expect(
      resolveAnnotation({ dash: [4, 2], lineWidth: 2, roles: { a: {} } }),
    ).toEqual({
      ...defaultAnnotation,
      dash: [4, 2],
      lineWidth: 2,
      roles: { a: {} },
    });
  });
});
