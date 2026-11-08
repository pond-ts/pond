/**
 * A personal grade curve fitted from a history's runs: how many heartbeats a
 * metre takes at each grade, relative to flat ground.
 *
 * Each run's digest keeps its steady minutes summed by 2 % grade band
 * (`digest.grades`). A run's heartbeats per metre also depend on the day
 * (fitness, heat, drift), so each run gets its own scale and the curve and
 * the scales are fitted together: a run with little flat ground still helps.
 * The fit is on logarithms, weighted by how many minutes each run has in a
 * band, and set to 1 on flat ground.
 */
import { GradeCurve, type GradeModel } from '../activity/grade.js';
import type { ActivityDigest } from './digest.js';

export interface GradeCurveOptions {
  /** Steady minutes a band needs across the history to be kept. Thinner
   *  bands are left to the fallback model. Default 20. */
  minWindows?: number;
  /** The curve's name. Default `'personal'`. */
  name?: string;
  /** The model whose shape the curve follows past its fitted bands.
   *  Default `'acsm-running'`. */
  fallback?: GradeModel;
}

/** One fitted grade band. */
export interface GradeCurveBand {
  /** Band centre as a fraction: 0.06 holds grades from 5 % to 7 %. */
  grade: number;
  /** Level-equivalent metres per metre: heartbeats per metre here over
   *  heartbeats per metre on flat ground. */
  factor: number;
  /** Steady minutes it rests on. */
  windows: number;
  /** Runs those minutes come from. */
  activities: number;
  /** How far apart the factor comes out when fitted from every other run
   *  (two halves of the history): a rough guide to how settled it is. Null
   *  when either half has too little in this band, or on flat ground. */
  spread: number | null;
}

export interface GradeCurveFit {
  /** Pass to `section.pace.adjustedForGrade({ model })` or to efficiency. */
  curve: GradeCurve;
  /** The bands the curve is made of, lowest grade first. */
  bands: GradeCurveBand[];
  /** Ids of the runs used. */
  activities: string[];
}

/** Steady minutes a run needs to count. */
const MIN_RUN_WINDOWS = 20;
/** Alternating rounds stop once no factor moves more than this (in log
 *  units), or at the cap. Runs that share few bands link the curve only
 *  loosely and take many rounds to settle. */
const TOLERANCE = 1e-9;
const MAX_ROUNDS = 20000;

interface Cell {
  run: number;
  band: number;
  /** log heartbeats per metre */
  y: number;
  w: number;
}

/** Log factor per band key, or null without enough flat ground. */
function solve(
  cells: readonly Cell[],
  runs: number,
): Map<number, number> | null {
  if (!cells.some((c) => c.band === 0)) return null;
  const scale = new Float64Array(runs);
  // Start each run's scale from its flattest minutes.
  for (let r = 0; r < runs; r++) {
    const own = cells.filter((c) => c.run === r);
    const flat = own.filter((c) => Math.abs(c.band) <= 1);
    scale[r] = mean(flat.length ? flat : own, (c) => c.y);
  }
  let f = new Map<number, number>();
  for (let it = 0; it < MAX_ROUNDS; it++) {
    const before = f;
    const sum = new Map<number, [number, number]>();
    for (const c of cells) {
      const s = sum.get(c.band) ?? [0, 0];
      s[0] += c.w * (c.y - scale[c.run]!);
      s[1] += c.w;
      sum.set(c.band, s);
    }
    f = new Map([...sum].map(([k, [a, w]]) => [k, a / w]));
    const flat = f.get(0)!;
    for (const [k, v] of f) f.set(k, v - flat);
    const acc = Array.from({ length: runs }, () => [0, 0]);
    for (const c of cells) {
      acc[c.run]![0]! += c.w * (c.y - f.get(c.band)!);
      acc[c.run]![1]! += c.w;
    }
    for (let r = 0; r < runs; r++)
      if (acc[r]![1]! > 0) scale[r] = acc[r]![0]! / acc[r]![1]!;
    let moved = 0;
    for (const [k, v] of f)
      moved = Math.max(moved, Math.abs(v - (before.get(k) ?? Infinity)));
    if (moved < TOLERANCE) break;
  }
  return f;
}

function mean<T>(xs: readonly T[], f: (x: T) => number): number {
  let s = 0;
  for (const x of xs) s += f(x);
  return xs.length ? s / xs.length : 0;
}

const BAND = 0.02;
const keyOf = (grade: number) => Math.round(grade / BAND);

/**
 * Cells for the runs given: one per run and band, keeping bands with at
 * least `min` minutes. A run with a single band says nothing about the
 * curve (its own scale absorbs it), so it is dropped; so are runs and bands
 * not linked to flat ground through runs they share, since their factors
 * couldn't be told apart from a run's scale.
 */
function cellsOf(
  runs: readonly ActivityDigest[],
  min: number,
): { cells: Cell[]; windows: Map<number, number>; seen: Map<number, number> } {
  let cells: Cell[] = [];
  runs.forEach((d, run) => {
    for (const b of d.grades!)
      if (b.metres > 0 && b.beats > 0)
        cells.push({
          run,
          band: keyOf(b.grade),
          y: Math.log(b.beats / b.metres),
          w: b.windows,
        });
  });
  for (;;) {
    const windows = new Map<number, number>();
    for (const c of cells)
      windows.set(c.band, (windows.get(c.band) ?? 0) + c.w);
    let kept = cells.filter((c) => windows.get(c.band)! >= min);
    const perRun = new Map<number, number>();
    for (const c of kept) perRun.set(c.run, (perRun.get(c.run) ?? 0) + 1);
    kept = kept.filter((c) => perRun.get(c.run)! >= 2);
    kept = linkedToFlat(kept);
    if (kept.length === cells.length) break;
    cells = kept;
  }
  const windows = new Map<number, number>();
  const seen = new Map<number, number>();
  for (const c of cells) {
    windows.set(c.band, (windows.get(c.band) ?? 0) + c.w);
    seen.set(c.band, (seen.get(c.band) ?? 0) + 1);
  }
  return { cells, windows, seen };
}

/** The cells reachable from the flat band, through runs and the bands they
 *  share. */
function linkedToFlat(cells: readonly Cell[]): Cell[] {
  const bands = new Set<number>([0]);
  const runs = new Set<number>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of cells) {
      if (bands.has(c.band) && !runs.has(c.run)) {
        runs.add(c.run);
        grew = true;
      }
      if (runs.has(c.run) && !bands.has(c.band)) {
        bands.add(c.band);
        grew = true;
      }
    }
  }
  return cells.filter((c) => runs.has(c.run));
}

/** @internal */
export function fitGradeCurve(
  digests: readonly ActivityDigest[],
  options: GradeCurveOptions = {},
): GradeCurveFit | null {
  const min = options.minWindows ?? 20;
  if (!(min >= 1) || !Number.isFinite(min))
    throw new RangeError('minWindows must be at least 1');
  const runs = digests.filter(
    (d) =>
      d.grades !== null &&
      d.grades.reduce((s, b) => s + b.windows, 0) >= MIN_RUN_WINDOWS,
  );
  const all = cellsOf(runs, min);
  const fit = solve(all.cells, runs.length);
  if (!fit) return null;
  // Every other run, in start order: two halves of the history.
  const half = Math.ceil(min / 2);
  const halves = [0, 1].map((p) => {
    const part = runs.filter((_, i) => i % 2 === p);
    return solve(cellsOf(part, half).cells, part.length);
  });
  const bands: GradeCurveBand[] = [...fit.keys()]
    .sort((a, b) => a - b)
    .map((k) => {
      const a = halves[0]?.get(k);
      const b = halves[1]?.get(k);
      return {
        grade: Math.round(k * BAND * 100) / 100,
        factor: Math.exp(fit.get(k)!),
        windows: all.windows.get(k)!,
        activities: all.seen.get(k)!,
        spread:
          k !== 0 && a !== undefined && b !== undefined
            ? Math.abs(Math.exp(a) - Math.exp(b))
            : null,
      };
    });
  const used = new Set(all.cells.map((c) => c.run));
  return {
    curve: new GradeCurve(
      bands.map((b) => ({ grade: b.grade, factor: b.factor })),
      {
        name: options.name ?? 'personal',
        fallback: options.fallback ?? 'acsm-running',
      },
    ),
    bands,
    activities: runs.filter((_, i) => used.has(i)).map((d) => d.id),
  };
}
