/**
 * [PND-CATFIT] — the category axis's **measured** label fit. Filed from the
 * SPARC migration: the old fit estimated width by character count (capped at
 * 12 chars), let a kept label occupy its full pitch (no inter-label gap), and
 * measured the slot as `plotWidth / n` (wrong under `maxBandWidth` packing) —
 * so venue-tailed keys (`SYMBOL-VENUE-TYPE`) drew wider than their bands and
 * overprinted into a smear. At zero width it passed every label through
 * full-length (the collapsed-panel smear).
 *
 * These tests run on the no-canvas estimate path (happy-dom has no canvas
 * backend), so the widths asserted against are the same widths the fit
 * computed from — the *contract* under test is the geometry: no drawn label
 * may overrun `stride · slot − gap`, truncation is from the middle, and a
 * degenerate width draws nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ChartContainer } from '../src/ChartContainer.js';
import { ChartRow } from '../src/ChartRow.js';
import { Layers } from '../src/Layers.js';
import { BarChart } from '../src/BarChart.js';
import { YAxis } from '../src/YAxis.js';
import { thinCategoryLabels } from '../src/XAxis.js';
import { stubCanvasContext } from './canvas-mock.js';

afterEach(cleanup);

const FONT_SIZE = 11;
const FAMILY = 'sans-serif';
/** The estimate the no-canvas fallback uses — the test's width oracle. */
const est = (s: string) => s.length * FONT_SIZE * 0.62;

const ticksFor = (labels: readonly string[], slot: number) =>
  labels.map((label, i) => ({ x: (i + 0.5) * slot, label }));

describe('thinCategoryLabels — measured fit', () => {
  it('labels that fit draw whole, at every band', () => {
    const labels = ['EDGE01', 'APEX07', 'KRONOS', 'VULCAN', 'ORION3'];
    const slot = 82;
    const out = thinCategoryLabels(
      ticksFor(labels, slot),
      slot,
      slot * labels.length,
      FONT_SIZE,
      FAMILY,
    );
    expect(out.map((t) => t.label)).toEqual(labels);
  });

  it('no drawn label measures wider than its room (the overprint)', () => {
    // The confirmed SPARC shape: venue-tailed keys wider than their band.
    const labels = [
      'EDGE01-NMS-EQT',
      'APEX07-NMS-EQT',
      'KRONOS-ARCA-OPT',
      'VULCAN-NMS-EQT',
      'ORION3-BATS-EQT',
      'HELIX9-ARCA-OPT',
    ];
    const slot = 86;
    const out = thinCategoryLabels(
      ticksFor(labels, slot),
      slot,
      slot * labels.length,
      FONT_SIZE,
      FAMILY,
    );
    expect(out.length).toBeGreaterThan(0);
    // Infer the stride the fit chose from the kept tick positions; every kept
    // label must measure inside stride·slot minus the gap. This is the claim
    // the old code violated: its ellipsized labels measured wider than the
    // pitch they were drawn on.
    const stride =
      out.length > 1 ? Math.round((out[1]!.x - out[0]!.x) / slot) : 1;
    for (const t of out) {
      expect(est(t.label)).toBeLessThanOrEqual(stride * slot - 4);
    }
  });

  it('truncates from the middle, keeping the distinguishing tail', () => {
    const labels = [
      'EDGE01-NMS-EQT',
      'APEX07-NMS-EQT',
      'KRONOS-ARCA-OPT',
      'VULCAN-NMS-EQT',
      'ORION3-BATS-EQT',
      'HELIX9-ARCA-OPT',
    ];
    const slot = 86;
    const out = thinCategoryLabels(
      ticksFor(labels, slot),
      slot,
      slot * labels.length,
      FONT_SIZE,
      FAMILY,
    );
    const truncated = out.filter((t) => t.label.includes('…'));
    expect(truncated.length).toBeGreaterThan(0);
    for (const t of truncated) {
      // The ellipsis is interior: text survives on BOTH sides, so the head
      // (symbol) and the tail (venue/type) both stay identifying.
      expect(t.label).toMatch(/^\S+…\S+$/);
      expect(t.label.endsWith('T')).toBe(true); // …EQT / …OPT tail kept
    }
  });

  it('never splits a surrogate pair when ellipsizing', () => {
    // Astral-plane code points (each one UTF-16 surrogate PAIR): a naive
    // string slice through the middle emits a lone surrogate (mojibake).
    const labels = ['𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄', '𝕏𝕐ℤ𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛'];
    const slot = 40;
    const out = thinCategoryLabels(
      ticksFor(labels, slot),
      slot,
      slot * labels.length,
      FONT_SIZE,
      FAMILY,
    );
    expect(out.length).toBeGreaterThan(0);
    for (const t of out) {
      expect(t.label).toContain('…');
      // No lone high surrogate (a head slice cutting mid-pair leaves one at
      // the ellipsis)…
      expect(t.label).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      // …and no lone low surrogate (a tail slice cutting mid-pair starts
      // with one).
      expect(t.label).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });

  it('a degenerate width draws no labels instead of a full-length smear', () => {
    const labels = ['EDGE01-NMS-EQT', 'APEX07-NMS-EQT', 'KRONOS-ARCA-OPT'];
    // Pre-layout: zero plot width.
    expect(
      thinCategoryLabels(ticksFor(labels, 0), 0, 0, FONT_SIZE, FAMILY),
    ).toEqual([]);
    // Collapsed panel: a few px of width — not even the legibility floor fits.
    expect(
      thinCategoryLabels(ticksFor(labels, 5), 5, 15, FONT_SIZE, FAMILY),
    ).toEqual([]);
  });

  it('measures against the given slot pitch, not plotWidth / n', () => {
    // A packed axis: wide plot, narrow bands. The old fit divided plotWidth by
    // the category count and saw room to spare; the labels actually sat on a
    // 24px pitch.
    const labels = ['EDGE01-NMS-EQT', 'APEX07-NMS-EQT', 'KRONOS-ARCA-OPT'];
    const out = thinCategoryLabels(
      ticksFor(labels, 24),
      24,
      900,
      FONT_SIZE,
      FAMILY,
    );
    // On a 24px pitch a ~96px label must thin — every kept label still fits
    // its (stride-widened) room.
    expect(out.length).toBeLessThan(labels.length);
    const stride =
      out.length > 1 ? Math.round((out[1]!.x - out[0]!.x) / 24) : labels.length;
    for (const t of out) {
      expect(est(t.label)).toBeLessThanOrEqual(stride * 24 - 4);
    }
  });
});

describe('<XAxis> category fit wiring', () => {
  const venue = [
    { label: 'EDGE01-NMS-EQT', value: 42 },
    { label: 'APEX07-NMS-EQT', value: 31 },
    { label: 'KRONOS-ARCA-OPT', value: 55 },
    { label: 'VULCAN-NMS-EQT', value: 19 },
    { label: 'ORION3-BATS-EQT', value: 38 },
    { label: 'HELIX9-ARCA-OPT', value: 45 },
  ];

  const renderChart = (ui: React.ReactElement) => {
    const stub = stubCanvasContext();
    try {
      return render(ui);
    } finally {
      stub.restore();
    }
  };

  const axisLabels = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('div'))
      .filter((d) => d.children.length === 0) // leaf label divs only
      .map((d) => d.textContent ?? '')
      .filter((t) => /^(EDGE|APEX|KRONOS|VULCAN|ORION|HELIX)/.test(t));

  it('the venue-tail repro renders ellipsized labels, none overrunning', () => {
    const { container } = renderChart(
      <ChartContainer width={560}>
        <ChartRow height={160}>
          <YAxis id="v" label="" min={0} />
          <Layers>
            <BarChart categories={venue} gap={4} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    const labels = axisLabels(container);
    expect(labels.length).toBeGreaterThan(0);
    // Every drawn label is middle-ellipsized (they're all wider than a band)
    // and no two collapse to the same string — the symbol prefix and the
    // venue tail both survive.
    for (const t of labels) expect(t).toMatch(/^\S+…\S+$/);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('a maxBandWidth-packed axis thins on the packed pitch', () => {
    const { container } = renderChart(
      <ChartContainer width={900} maxBandWidth={24}>
        <ChartRow height={160}>
          <YAxis id="v" label="" min={0} />
          <Layers>
            <BarChart categories={venue} gap={4} />
          </Layers>
        </ChartRow>
      </ChartContainer>,
    );
    // plotWidth / n would be ~140px per label — room to spare, no thinning.
    // The real pitch is 24px, so the fit must drop labels.
    const labels = axisLabels(container);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThan(venue.length);
  });
});
