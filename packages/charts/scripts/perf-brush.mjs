// Perf bench for the brush recognizer + the range drag's per-move path
// (interaction wave step 3 — `<RangeCursor>` drag on the single brush engine).
//
// COMPLEXITY. The drag runs per pointermove, so the per-move path is the one
// that matters:
//
//   - pointer-DOWN (once per gesture): `effectiveCursorEntries` +
//     `gestureOwner` are O(C) over the registered cursor entries (C is
//     single-digit in practice — one entry per mounted preset per scope),
//     then `resolveRangeDrag` + `resolveBrushClaim` are O(1) property
//     compares. This replaces main's inline O(1) legacy check, so the honest
//     "before → after" is exactly this delta, measured below at realistic and
//     absurd C.
//   - pointer-MOVE (per frame, mid-drag): `regionSpan` is two binary
//     searches over the B snap buckets (`bucketAt`, O(log B)); `bandRect`
//     adds two scale calls and a clamp. NOTHING here walks events, allocates
//     per bucket, or scales linearly with B — the allocations are the one
//     `{start,end}` + `{x0,x1}` pair per move.
//   - RELEASE (once): one more `regionSpan` + the payload `{ x: [lo, hi] }`.
//
// The B sweep below (24 → 100k buckets) is the check that the move path is
// genuinely logarithmic — a hidden linear scan would show as ~4000× from
// B=24 to B=100k instead of ~2.5×.
//
// Run: node scripts/perf-brush.mjs   (build first: npm run build)

import { performance } from 'node:perf_hooks';
import { scaleLinear } from 'd3-scale';
import { Interval } from 'pond-ts';
import { regionSpan, bandRect } from '../dist/tracker.js';
import { resolveBrushClaim, resolveRangeDrag } from '../dist/brush.js';
import { effectiveCursorEntries, gestureOwner } from '../dist/cursors.js';

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function benchmark(label, fn, repeats = 60) {
  for (let i = 0; i < 8; i += 1) fn();
  const samples = [];
  for (let i = 0; i < repeats; i += 1) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  return { label, medianMs: Number(median(samples).toFixed(4)) };
}

/** B contiguous unit buckets over [0, B). */
function makeBuckets(B) {
  const out = new Array(B);
  for (let i = 0; i < B; i += 1) {
    out[i] = new Interval({ value: i, start: i, end: i + 1 });
  }
  return out;
}

const MOVES = 240; // a generous drag: ~4s of pointermove at 60Hz
const PLOT_W = 800;
const results = [];

// ── The per-move drag path: regionSpan + bandRect across bucket counts. ─────
for (const B of [24, 1_000, 100_000]) {
  const buckets = makeBuckets(B);
  const xScale = scaleLinear().domain([0, B]).range([0, PLOT_W]);
  const anchor = B * 0.31 + 0.5;
  let sink = 0;
  const r = benchmark(`MOVE   B=${B} regionSpan+bandRect x${MOVES}`, () => {
    for (let i = 0; i < MOVES; i += 1) {
      const t = (B * i) / MOVES + 0.25;
      const rect = bandRect(buckets, t, xScale, PLOT_W, anchor);
      if (rect) sink += rect.x1 - rect.x0;
    }
  });
  results.push({
    ...r,
    perMoveUs: Number(((r.medianMs * 1e3) / MOVES).toFixed(3)),
  });
  if (sink < 0) console.log('unreachable', sink);
}

// ── The freeform per-move path (no buckets — the degenerate case). ──────────
{
  const xScale = scaleLinear().domain([0, 1000]).range([0, PLOT_W]);
  let sink = 0;
  const r = benchmark(`MOVE   B=0 freeform x${MOVES}`, () => {
    for (let i = 0; i < MOVES; i += 1) {
      const rect = bandRect([], i * 4 + 1, xScale, PLOT_W, 310);
      if (rect) sink += rect.x1 - rect.x0;
    }
  });
  results.push({
    ...r,
    perMoveUs: Number(((r.medianMs * 1e3) / MOVES).toFixed(3)),
  });
  if (sink < 0) console.log('unreachable', sink);
}

// ── The pointer-down claim: before (main's inline check) vs after (the
//    recognizer). C = registered cursor entries; realistic is 1–3. ──────────
const legacyC = {
  cursor: 'region',
  onRegionSelect: () => {},
  regionSelectModifier: undefined,
  xKind: 'time',
};
const mkEntry = (ownsGesture, legacy) => ({
  spec: {},
  rowKey: null,
  legacy,
  ownsGesture,
  wants: {
    samples: false,
    flags: false,
    band: false,
    pointer: false,
    time: false,
  },
  onDragRelease: ownsGesture ? () => {} : undefined,
  enableDrag: ownsGesture,
  dragModifier: undefined,
});
const DOWNS = 10_000;
{
  // BEFORE: what main did per press — the inline legacy property checks.
  const r = benchmark(`DOWN   before: inline legacy check x${DOWNS}`, () => {
    let n = 0;
    for (let i = 0; i < DOWNS; i += 1) {
      if (
        legacyC.cursor === 'region' &&
        legacyC.onRegionSelect &&
        (legacyC.xKind === 'time' || legacyC.xKind === 'value')
      )
        n += 1;
    }
    if (n < 0) console.log(n);
  });
  results.push({
    ...r,
    perDownUs: Number(((r.medianMs * 1e3) / DOWNS).toFixed(3)),
  });
}
for (const C of [2, 8]) {
  const rowKey = Symbol('row');
  const entries = Array.from({ length: C }, (_, i) =>
    mkEntry(i === C - 1, i === 0),
  );
  const r = benchmark(
    `DOWN   after: resolve claim, C=${C} entries x${DOWNS}`,
    () => {
      let n = 0;
      for (let i = 0; i < DOWNS; i += 1) {
        const claim = resolveBrushClaim({
          creating: false,
          drag: resolveRangeDrag(
            legacyC,
            gestureOwner(effectiveCursorEntries(entries, rowKey)),
          ),
          shiftKey: false,
          panEnabled: true,
          canPan: true,
        });
        if (claim.kind === 'range') n += 1;
      }
      if (n < 0) console.log(n);
    },
  );
  results.push({
    ...r,
    perDownUs: Number(((r.medianMs * 1e3) / DOWNS).toFixed(3)),
  });
}

// ── A whole gesture: down + MOVES moves + release, B=100k. ──────────────────
{
  const B = 100_000;
  const buckets = makeBuckets(B);
  const xScale = scaleLinear().domain([0, B]).range([0, PLOT_W]);
  const rowKey = Symbol('row');
  const entries = [mkEntry(false, true), mkEntry(true, false)];
  const r = benchmark(`DRAG   full gesture, B=${B}, ${MOVES} moves`, () => {
    const claim = resolveBrushClaim({
      creating: false,
      drag: resolveRangeDrag(
        legacyC,
        gestureOwner(effectiveCursorEntries(entries, rowKey)),
      ),
      shiftKey: false,
      panEnabled: true,
      canPan: true,
    });
    const anchor = B * 0.2;
    let sink = 0;
    for (let i = 0; i < MOVES; i += 1) {
      const t = B * 0.2 + (B * 0.6 * i) / MOVES;
      const rect = bandRect(buckets, t, xScale, PLOT_W, anchor);
      if (rect) sink += rect.x1 - rect.x0;
    }
    const span = regionSpan(buckets, anchor, B * 0.8);
    if (claim.kind === 'range' && span)
      claim.drag.release(span.start, span.end);
    if (sink < 0) console.log(sink);
  });
  results.push(r);
}

console.log(JSON.stringify(results, null, 2));
