#!/usr/bin/env node
/**
 * Derive the Gallery's CERN router-traffic fixture from the raw capture.
 *
 *     node website/scripts/fixtures/cern-traffic.mjs \
 *       > website/src/examples/lib/cern-traffic-samples.ts
 *
 * Run by hand, never by the build (see `src/examples/lib/README.md`). The raw
 * capture — `packages/charts/test-data/cern-network-traffic.json`, 1 MB, 24
 * SAPs × 718 points — stays where it is: `packages/charts/package.json` ships
 * only `dist`, so it never reaches npm, and it is far too big to hand a
 * browser on a docs page.
 *
 * What this does to it, and why:
 *
 * - **Keeps the top `--saps` interfaces by carried volume** (default 7). The
 *   tail is not a rounding detail: 11 of the 24 SAPs peak below 1 Mbps, and
 *   they would be invisible slivers in a stack. The kept set carries 99.9% of
 *   the bytes; the script prints the exact figure so the page can quote it.
 * - **Averages to a `--step`-minute grid** (default 1 min, from the source's
 *   30 s). A rate is a mean over its interval, so averaging pairs of samples
 *   is the honest reduction — but it does clip instantaneous peaks, and the
 *   script prints how much so the loss is on the record rather than assumed.
 * - **Converts bits/second to Gbps** and rounds to `--dp` places (default 2,
 *   i.e. 10 Mbps resolution). Four significant figures is more than a chart
 *   can draw and rounding is most of the file size.
 * - **Drops the timestamp column.** Every delta in the source is exactly
 *   30 000 ms across all 24 SAPs — a perfect grid — so an origin and a step
 *   carry the same information as 359 repeated near-identical integers.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW = path.resolve(
  HERE,
  '../../../packages/charts/test-data/cern-network-traffic.json',
);

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

const KEEP = flag('saps', 7);
const FACTOR = flag('factor', 2); // 30 s × 2 = 1 min
const DP = flag('dp', 2);

const raw = JSON.parse(readFileSync(RAW, 'utf8'));
const saps = raw.data.networkEntity.saps.map((s) => ({
  name: s.traffic.name.split('/').pop(),
  device: s.traffic.name.split('/')[1],
  category: s.traffic.type,
  points: s.traffic.points,
}));

// --- provenance figures, all computed ------------------------------------
const N = saps[0].points.length;
const step = saps[0].points[1][0] - saps[0].points[0][0];
for (const s of saps) {
  if (s.points.length !== N) throw new Error(`${s.name}: ragged length`);
  for (let i = 1; i < N; i++) {
    if (s.points[i][0] - s.points[i - 1][0] !== step) {
      throw new Error(`${s.name}: irregular grid at ${i}`);
    }
  }
}

const volume = (s) =>
  s.points.reduce((a, [, i, o]) => a + (i ?? 0) + (o ?? 0), 0);
const ranked = [...saps].sort((a, b) => volume(b) - volume(a));
const kept = ranked.slice(0, KEEP);
const totalVolume = ranked.reduce((a, s) => a + volume(s), 0);
const keptVolume = kept.reduce((a, s) => a + volume(s), 0);
const nearIdle = saps.filter(
  (s) => Math.max(...s.points.flatMap(([, i, o]) => [i ?? 0, o ?? 0])) < 1e6,
).length;

// --- reduce ---------------------------------------------------------------
const round = (x) => Number(x.toFixed(DP));
function downsample(points, col) {
  const out = [];
  for (let k = 0; k + FACTOR <= points.length; k += FACTOR) {
    let sum = 0;
    for (let j = 0; j < FACTOR; j++) sum += points[k + j][col] ?? 0;
    out.push(round(sum / FACTOR / 1e9));
  }
  return out;
}

const series = kept.map((s) => ({
  name: s.name,
  category: s.category,
  in: downsample(s.points, 1),
  out: downsample(s.points, 2),
}));

// Peak fidelity: what the averaging cost, at the site total.
const peakAt = (col) => {
  let m = 0;
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (const s of saps) sum += s.points[k][col] ?? 0;
    m = Math.max(m, sum);
  }
  return m / 1e9;
};
const reducedPeak = (key) => {
  let m = 0;
  for (let k = 0; k < series[0][key].length; k++) {
    let sum = 0;
    for (const s of series) sum += s[key][k];
    m = Math.max(m, sum);
  }
  return m;
};

const wrap = (nums) => {
  const lines = [];
  let line = '  ';
  for (const n of nums) {
    const tok = `${n},`;
    if (line.length + tok.length > 78) {
      lines.push(line.trimEnd());
      line = '  ';
    }
    line += `${tok} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join('\n');
};

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const t0 = saps[0].points[0][0];
const t1 = saps[0].points[N - 1][0];
const stepMs = step * FACTOR;
const n = series[0].in.length;

const out = [];
const w = (s = '') => out.push(s);

const topShare = (volume(ranked[0]) / totalVolume) * 100;

w('/**');
w(
  ` * Router traffic from CERN — ${KEEP} interfaces of one border router, in and`,
);
w(` * out, over ${((t1 - t0) / 3_600_000).toFixed(0)} hours.`);
w(' *');
w(' * **Real measured data, not modelled.** `cern773-cr6` is a CERN border');
w(` * router; the capture runs ${iso(t0)} → ${iso(t1)}`);
w(' * (07:51–13:49 local — CERN is UTC+2 in August) at a 30-second cadence.');
w(
  ' * Values are bits per second in each direction, per **SAP** (service access',
);
w(
  ' * point — one logical peer/customer attachment on a physical port), with the',
);
w(" * router's own `LHCONE` / `Other` traffic class on each.");
w(' *');
w(
  ' * **Where it came from, and what that does and does not license.** Supplied',
);
w(' * for use in these docs by the pond-ts maintainer, out of the production');
w(' * dashboard it drives. It is **not a published open-data release** and no');
w(
  ' * licence is asserted over it beyond its use as a documentation fixture here.',
);
w(' * Do not re-publish it as an open dataset.');
w(' *');
w(
  ' * **What was kept.** The capture carries **24 SAPs**; this fixture keeps the',
);
w(
  ` * **top ${KEEP} by carried volume**, which is **${((keptVolume / totalVolume) * 100).toFixed(2)}%** of all bytes in the file. The`,
);
w(
  ` * other ${saps.length - KEEP} are near-idle — **${nearIdle} of the 24 never exceed 1 Mbps in either`,
);
w(' * direction** — and would be invisible slivers in a stack, so they are');
w(' * described on the Gallery page rather than plotted.');
w(' *');
w(
  ' * **What was changed.** Three reductions, all to fit the docs-site fixture',
);
w(' * budget (`src/examples/lib/README.md`), none to flatter the shape:');
w(' *');
w(
  ` * 1. Averaged from the source's 30 s grid to **${stepMs / 60_000} min** (${n} points per`,
);
w(
  ` *    interface, from ${N}). A rate *is* a mean over its interval, so averaging`,
);
w(
  ' *    is the honest reduction — but it clips instantaneous peaks. Measured:',
);
w(
  ` *    the site's peak outbound goes ${peakAt(2).toFixed(1)} → ${reducedPeak('out').toFixed(1)} Gbps (−${((1 - reducedPeak('out') / peakAt(2)) * 100).toFixed(1)}%), peak inbound`,
);
w(
  ` *    ${peakAt(1).toFixed(1)} → ${reducedPeak('in').toFixed(1)} Gbps (−${((1 - reducedPeak('in') / peakAt(1)) * 100).toFixed(1)}%).`,
);
w(
  ` * 2. Converted **bits/s → Gbps**, rounded to ${DP} places (10 Mbps resolution).`,
);
w(' * 3. Dropped the timestamp column. Every delta in the source is exactly');
w(
  ` *    ${step} ms, across all 24 SAPs, with no gaps — so {@link START_MS} plus`,
);
w(` *    {@link STEP_MS} carries the same information as ${n} near-identical`);
w(' *    integers. `cern-traffic.ts` zips them back into row tuples.');
w(' *');
w(
  " * **The quirks that survived.** The router's own texture, untouched: a quiet",
);
w(
  ' * morning that steps up hard just after 09:00 UTC, minute-scale bursts on top',
);
w(
  ' * of it, and a wildly uneven scale between interfaces — the busiest SAP alone',
);
w(
  ` * carries **${topShare.toFixed(0)}%** of the bytes, more than the other ${saps.length - 1} together. In and out are`,
);
w(
  ' * strongly asymmetric, which is what a data-export site looks like. There are',
);
w(
  ' * **no nulls and no gaps**: the capture has none, so nothing was interpolated.',
);
w(' *');
w(' * **A note on the shape it arrived in.** Each SAP came as');
w(
  " * `{ name, columns: ['time','in','out'], points: [[ms, in, out], …] }` — row",
);
w(
  ' * tuples that `TimeSeries.fromJSON({ schema, rows: points })` reads with no',
);
w(' * transformation at all. That is the pondjs wire format, which is a fair');
w(
  ' * amount of history showing: ESnet built pondjs and react-timeseries-charts,',
);
w(' * of which pond-ts is the successor, and the tooling still emits it.');
w(' *');
w(' * **How it was made.** Generated once, offline, by');
w(' * `website/scripts/fixtures/cern-traffic.mjs` from');
w(
  ' * `packages/charts/test-data/cern-network-traffic.json` (the raw capture, kept',
);
w(
  ' * out of the site bundle), then committed. Re-run the script to re-derive.',
);
w(' */');
w();
w('/** First sample, epoch ms — the grid origin. */');
w(`export const START_MS = ${t0};`);
w();
w(
  '/** Grid step, ms. Exact: the source is a perfect grid, averaged in pairs. */',
);
w(`export const STEP_MS = ${stepMs};`);
w();
w('/** Samples per interface. */');
w(`export const COUNT = ${n};`);
w();
w('/** One kept interface: its SAP id, its traffic class, and Gbps in/out. */');
w('export interface SapSamples {');
w('  /** SAP id as the router reports it, e.g. `111-lag-3-522`. */');
w('  readonly name: string;');
w('  /** The traffic class the router reports for the attachment. */');
w("  readonly category: 'LHCONE' | 'Other';");
w('  /** Inbound, Gbps, one value per {@link STEP_MS}. */');
w('  readonly in: readonly number[];');
w('  /** Outbound, Gbps, same grid. */');
w('  readonly out: readonly number[];');
w('}');
w();
w(`/** The device every SAP here belongs to. */`);
w(`export const DEVICE = '${kept[0].device}';`);
w();
w('/** Interfaces in descending order of carried volume — which is also the');
w(' *  order a stacked chart wants them in (biggest slab on the bottom). */');
w('export const SAPS: readonly SapSamples[] = [');
for (const s of series) {
  w('  {');
  w(`    name: '${s.name}',`);
  w(`    category: '${s.category}',`);
  w('    // prettier-ignore');
  w('    in: [');
  w(wrap(s.in).replace(/^/gm, '    '));
  w('    ],');
  w('    // prettier-ignore');
  w('    out: [');
  w(wrap(s.out).replace(/^/gm, '    '));
  w('    ],');
  w('  },');
}
w('];');
w();

process.stdout.write(out.join('\n'));

process.stderr.write(
  [
    `saps kept        ${KEEP} of ${saps.length} (${((keptVolume / totalVolume) * 100).toFixed(3)}% of volume)`,
    `near-idle (<1M)  ${nearIdle}`,
    `grid             ${step} ms × ${N}  →  ${stepMs} ms × ${n}`,
    `site peak out    ${peakAt(2).toFixed(1)} → ${reducedPeak('out').toFixed(1)} Gbps`,
    `site peak in     ${peakAt(1).toFixed(1)} → ${reducedPeak('in').toFixed(1)} Gbps`,
    `emitted          ${(out.join('\n').length / 1024).toFixed(1)} KB`,
    '',
  ].join('\n'),
);
