import { describe, expect, it } from 'vitest';
import { drawStacks } from '../src/bars.js';
import { recordingContext, type CtxCall } from './canvas-mock.js';
import type { StackedBarSeries } from '../src/data.js';
import type { StackStyle } from '../src/bars.js';

/**
 * [PND-CATEMPH] — the themed emphasis reaches the category path.
 *
 * `BarStyle` carries a three-step `fill → hover → highlight`. The `categories`
 * and horizontal charts route through the transposed stacked draw path, which
 * read none of it: the theme accepted `bar.hover` / `bar.highlight`, typed and
 * documented as the emphasis channel, and silently did nothing on the most
 * common categorical chart. A theme author set them, saw no change, and could
 * not tell whether they were wrong about the colour or about the mechanism.
 *
 * The *behaviour* for a per-bin-coloured bar was always defensible — swapping a
 * zone-coloured bar to one highlight hue erases what the colour encodes — so
 * that exclusion stays, and is pinned here as a deliberate one.
 */

const identity = (v: number) => v;

const one = (v: number): StackedBarSeries => ({
  begin: Float64Array.from([0]),
  end: Float64Array.from([1]),
  values: Float64Array.from([v]),
  groups: ['g'],
  marks: ['alpha'],
  length: 1,
});

const base: StackStyle = { fills: ['#rest'], opacity: 0.5, outlineWidth: 2 };
const sel = { id: 'c', key: 0, label: 'g', mark: 'alpha' };

function draw(style: StackStyle, selected = false, hovered = false) {
  const { ctx, calls } = recordingContext();
  drawStacks(
    ctx,
    one(5),
    'vertical',
    identity,
    identity,
    style,
    0,
    1,
    'c',
    selected ? sel : null,
    hovered ? sel : null,
  );
  return calls;
}

const setsOf = (calls: CtxCall[], name: string) =>
  calls
    .filter((c) => c.type === 'set' && c.name === name)
    .map((c) => c.args[0]);

describe('themed emphasis on the category path', () => {
  const themed: StackStyle = {
    ...base,
    highlight: '#sel',
    hover: '#hov',
  };

  it('draws the resting fill with no live state', () => {
    expect(setsOf(draw(themed), 'fillStyle')).toContain('#rest');
  });

  it('takes the themed highlight when selected', () => {
    expect(setsOf(draw(themed, true), 'fillStyle')).toContain('#sel');
  });

  it('takes the themed hover under the pointer', () => {
    expect(setsOf(draw(themed, false, true), 'fillStyle')).toContain('#hov');
  });

  it('falls back to highlight when the theme sets no hover', () => {
    const noHover: StackStyle = { ...base, highlight: '#sel' };
    expect(setsOf(draw(noHover, false, true), 'fillStyle')).toContain('#sel');
  });

  it('is unchanged when the theme sets neither — the shipped two-step', () => {
    expect(setsOf(draw(base, true), 'fillStyle')).toContain('#rest');
  });

  it('reads selection over hover on a bar that is both', () => {
    expect(setsOf(draw(themed, true, true), 'fillStyle')).toContain('#sel');
  });
});

describe('the binColors exclusion is deliberate, and stays', () => {
  const perBin: StackStyle = {
    ...base,
    highlight: '#sel',
    hover: '#hov',
    binFills: ['#own'],
  };

  it('keeps the bar its own colour when selected', () => {
    // A red/green volume bar must stay red/green while live.
    const fills = setsOf(draw(perBin, true), 'fillStyle');
    expect(fills).toContain('#own');
    expect(fills).not.toContain('#sel');
  });

  it('keeps the bar its own colour on hover', () => {
    const fills = setsOf(draw(perBin, false, true), 'fillStyle');
    expect(fills).toContain('#own');
    expect(fills).not.toContain('#hov');
  });
});

describe('the emphasis is now tunable, not hard-coded', () => {
  it('pops to full alpha by default', () => {
    expect(setsOf(draw(base, true), 'globalAlpha')).toContain(1);
  });

  it('honours a themed emphasisOpacity', () => {
    const subtle: StackStyle = { ...base, emphasisOpacity: 0.8 };
    const alphas = setsOf(draw(subtle, true), 'globalAlpha');
    expect(alphas).toContain(0.8);
    expect(alphas).not.toContain(1);
  });

  it('honours a themed selectedOutline', () => {
    // The only selection cue available when the fill cannot change.
    const outlined: StackStyle = {
      ...base,
      binFills: ['#own'],
      selectedOutline: '#ring',
    };
    expect(setsOf(draw(outlined, true), 'strokeStyle')).toContain('#ring');
  });

  it('outlines in the resolved fill when the theme sets no outline', () => {
    expect(setsOf(draw(base, true), 'strokeStyle')).toContain('#rest');
  });
});
