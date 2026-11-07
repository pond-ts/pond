/**
 * Editing a recording: crop it to the stretch you keep (the warm-up and the
 * walk home off), split a lap at a second, or join a lap to the one before.
 * Works on the imported activity, so the result goes straight into
 * `Activity.from` and every number downstream (totals, splits, laps,
 * stats) follows the edit.
 *
 * The edit is seconds on the recording's own clock (seconds from its first
 * sample, the clock `streams.timeSeconds` uses), so it can be stored beside
 * the untouched recording and re-applied whenever it's shown.
 *
 * Extracted from Estela's timeline editor (estela-app/estela,
 * `packages/core/src/version/index.ts`).
 */
import { polylineCumulative } from '../geo/index.js';
import { computeActivitySummary } from '../summary/index.js';
import { movingRuleOf } from '../activity/moving.js';
import { swimMovingSeconds } from '../swim.js';
import type { ImportedActivity, Lap, SwimData } from '../types.js';

/** An edit to a recording, all in seconds on its own clock. */
export interface RecordingEdit {
  /** Keep from this second (crop before it). */
  from?: number | undefined;
  /** Keep up to this second (crop after it). */
  to?: number | undefined;
  /** Split laps here: a new lap starts at each of these seconds. */
  splitLapsAt?: readonly number[] | undefined;
  /** Join laps: the recorded lap starting at each of these seconds (within
   *  a second) is joined to the lap before it. */
  joinLapsAt?: readonly number[] | undefined;
}

/** Whether an edit changes nothing. */
export function isEmptyEdit(edit: RecordingEdit | undefined): boolean {
  return (
    !edit ||
    (edit.from === undefined &&
      edit.to === undefined &&
      !(edit.splitLapsAt?.length ?? 0) &&
      !(edit.joinLapsAt?.length ?? 0))
  );
}

/** The recording's length on its own clock: its last sample, else its
 *  elapsed time. */
export function recordingSeconds(imported: ImportedActivity): number {
  const t = imported.streams.timeSeconds;
  const last = t && t.length ? t[t.length - 1]! : NaN;
  return Number.isFinite(last) ? last : imported.activity.elapsedTimeSeconds;
}

/** Each recorded lap's start on the recording's clock, in lap order: from
 *  its own start time, else where the lap before it ended. */
export function lapStartSeconds(imported: ImportedActivity): number[] {
  const t0 = Date.parse(imported.activity.startTimeUtc);
  let next = 0;
  return (imported.laps ?? []).map((l) => {
    const at = l.startTimeUtc ? Date.parse(l.startTimeUtc) : NaN;
    const s =
      Number.isFinite(at) && Number.isFinite(t0) ? (at - t0) / 1000 : next;
    next = s + l.elapsedSeconds;
    return s;
  });
}

/** Cumulative distance along the recording at each sample: the device's
 *  own distance when it recorded one, else measured along the GPS line. */
function sampleDistances(imported: ImportedActivity): number[] | undefined {
  const s = imported.streams;
  const n = s.timeSeconds?.length ?? 0;
  if (!n) return undefined;
  if (s.distanceMeters?.length === n && s.distanceMeters.some((d) => d > 0)) {
    // carry the last good value over gaps
    let last = 0;
    return s.distanceMeters.map((d) =>
      Number.isFinite(d) ? (last = Math.max(last, d)) : last,
    );
  }
  if (s.latlng.length === n && s.latlng.every((p) => p != null))
    return polylineCumulative(s.latlng as [number, number][]);
  return undefined;
}

/** The first index whose time is at or after `sec`. */
function indexAt(times: readonly number[], sec: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A per-sample series' value at `sec`, read between the samples either
 *  side. */
function valueAt(
  times: readonly number[],
  values: readonly number[],
  sec: number,
): number {
  if (!times.length) return 0;
  const i = indexAt(times, sec);
  if (i <= 0) return values[0] ?? 0;
  if (i >= times.length) return values[times.length - 1] ?? 0;
  const t0 = times[i - 1]!;
  const t1 = times[i]!;
  const v0 = values[i - 1]!;
  const v1 = values[i]!;
  return t1 === t0 ? v1 : v0 + ((v1 - v0) * (sec - t0)) / (t1 - t0);
}

/** Two seconds this close count as the same. */
const SAME_SECOND = 1;

/** The lap boundaries after the edit, on the recording's clock: the
 *  recorded laps' starts, less the joined ones, plus the splits, inside
 *  [from, to). The first is `from`. */
function boundaries(
  starts: readonly number[],
  edit: RecordingEdit,
  from: number,
  to: number,
): number[] {
  const joined = (s: number) =>
    (edit.joinLapsAt ?? []).some(
      (j) => Math.abs(j - Math.round(s)) <= SAME_SECOND,
    );
  const all = [
    ...starts.filter((s, i) => i === 0 || !joined(s)),
    ...(edit.splitLapsAt ?? []),
  ]
    .filter((s) => Number.isFinite(s) && s > from && s < to - SAME_SECOND)
    .sort((a, b) => a - b);
  // two boundaries within a second of each other are one, and none sits
  // within a second of either end
  const out = [from];
  for (const s of all) if (s - out[out.length - 1]! > SAME_SECOND) out.push(s);
  return out;
}

/** Where the laps start after the edit, on the recording's clock (the
 *  first at the kept part's start) — the lap lines an editor draws.
 *  `starts` are the recorded laps' starts ({@link lapStartSeconds}); with
 *  none, the recording is one lap. */
export function editedLapStarts(
  starts: readonly number[],
  edit: RecordingEdit | undefined,
  total: number,
): number[] {
  const from = Math.max(0, edit?.from ?? 0);
  const to = Math.min(total, edit?.to ?? total);
  return boundaries(starts.length ? starts : [0], edit ?? {}, from, to);
}

interface Piece {
  lap: Lap;
  /** The part of the lap in the new one, on the recording's clock. */
  from: number;
  to: number;
  /** The lap's own stretch. */
  lapFrom: number;
  lapTo: number;
}

/** The share of a recorded lap's distance in [a, b], by the distance the
 *  recording covered (by time when it covered none). */
function share(p: Piece, dist: (sec: number) => number | undefined): number {
  if (p.from <= p.lapFrom && p.to >= p.lapTo) return 1;
  const whole = (dist(p.lapTo) ?? 0) - (dist(p.lapFrom) ?? 0);
  const part = (dist(p.to) ?? 0) - (dist(p.from) ?? 0);
  if (whole > 0) return Math.min(1, Math.max(0, part / whole));
  const span = p.lapTo - p.lapFrom;
  return span > 0 ? (p.to - p.from) / span : 0;
}

/** Mean and max of a channel over [a, b) on the recording's clock. */
function channelStats(
  times: readonly number[],
  values: readonly number[] | undefined,
  a: number,
  b: number,
): { avg: number; max: number } | undefined {
  if (!values || values.length !== times.length) return undefined;
  let sum = 0;
  let n = 0;
  let max = -Infinity;
  for (let i = indexAt(times, a); i < times.length && times[i]! < b; i++) {
    const x = values[i]!;
    if (!Number.isFinite(x)) continue;
    sum += x;
    n++;
    if (x > max) max = x;
  }
  return n ? { avg: sum / n, max } : undefined;
}

/**
 * The recording as the edit shows it. Cropped to the kept part: its clock
 * and distance start again from zero there, its start time (UTC and local)
 * moves on by what was cropped, and its totals are the recording's own
 * shared out by how much the kept part holds. Laps split and joined: a lap
 * the edit doesn't touch is kept as recorded; a split, joined or cropped one
 * is worked out from the recorded laps it covers, each sharing out its
 * distance, time, work, calories and climb by how much of it is kept, with
 * heart rate and power averaged from the samples where there are any. A
 * swim keeps the lengths inside the kept part, and its swim time is worked
 * out again from the new laps.
 *
 * `keepClock` keeps the whole recording on its own clock and only changes
 * the laps (for an editor that draws the new laps over the whole
 * recording). An empty edit returns the recording as it is.
 *
 * The kept part starts at the first sample at or after `from`, so after a
 * crop between samples the first time and distance can be a little above
 * zero. A lap boundary within a second of another, or of either end, is
 * dropped. A lap the edit made has no max speed (the recorded laps' maxima
 * don't say where in the lap they fell).
 *
 * Throws a `RangeError` when `from` or `to` is not a finite number, when
 * the edit keeps nothing (`from` at or past `to`, after holding both to the
 * recording), or when cropping a recording with no `timeSeconds`.
 * Non-finite seconds in `splitLapsAt` / `joinLapsAt` are ignored.
 */
export function editRecording<T extends ImportedActivity>(
  imported: T,
  edit: RecordingEdit | undefined,
  options: { keepClock?: boolean } = {},
): T {
  if (!edit || isEmptyEdit(edit)) return imported;
  for (const [k, v] of [
    ['from', edit.from],
    ['to', edit.to],
  ] as const)
    if (v !== undefined && !Number.isFinite(v))
      throw new RangeError(`editRecording: ${k} must be a finite number`);
  const times = imported.streams.timeSeconds ?? [];
  const cropping = edit.from !== undefined || edit.to !== undefined;
  if (cropping && !times.length && !options.keepClock)
    throw new RangeError(
      'editRecording: a recording with no time stream cannot be cropped',
    );
  const total = recordingSeconds(imported);
  const from = Math.max(0, edit.from ?? 0);
  const to = Math.min(total, edit.to ?? total);
  if (!(to > from))
    throw new RangeError(
      `editRecording: the edit keeps nothing (from ${from} s, to ${to} s, recording ${total} s)`,
    );
  const cum = sampleDistances(imported);
  const dist = (sec: number) => (cum ? valueAt(times, cum, sec) : undefined);
  const t0 = Date.parse(imported.activity.startTimeUtc);
  const iso = (sec: number) =>
    Number.isFinite(t0)
      ? new Date(t0 + Math.round(sec * 1000)).toISOString()
      : undefined;

  // Laps. Without recorded laps the whole recording is one lap, so a split
  // still makes two.
  const recorded = imported.laps ?? [];
  const lapEdits =
    (edit.splitLapsAt?.length ?? 0) + (edit.joinLapsAt?.length ?? 0) > 0;
  const starts = lapStartSeconds(imported);
  const spans = recorded.length
    ? recorded.map((l, i) => ({
        lap: l,
        lapFrom: starts[i]!,
        lapTo:
          i + 1 < recorded.length
            ? starts[i + 1]!
            : starts[i]! + l.elapsedSeconds,
      }))
    : lapEdits
      ? [{ lap: wholeLap(imported, total), lapFrom: 0, lapTo: total }]
      : [];
  let laps: Lap[] | undefined = imported.laps;
  if (spans.length) {
    // An end not cropped is where the device's laps start or end, which can
    // be a little past the samples, so the laps there stay as recorded.
    const lapsFrom =
      edit.from === undefined ? Math.min(from, spans[0]!.lapFrom) : from;
    const lapsTo =
      edit.to === undefined ? Math.max(to, spans[spans.length - 1]!.lapTo) : to;
    const edges = boundaries(
      spans.map((s) => s.lapFrom),
      edit,
      lapsFrom,
      lapsTo,
    );
    const hr = imported.streams.heartrate;
    const watts = imported.streams.watts;
    let odometer = options.keepClock ? (dist(from) ?? 0) : 0;
    const out: Lap[] = [];
    edges.forEach((a, i) => {
      const b = i + 1 < edges.length ? edges[i + 1]! : lapsTo;
      const pieces: Piece[] = spans
        .filter((s) => s.lapTo > a && s.lapFrom < b)
        .map((s) => ({
          ...s,
          from: Math.max(a, s.lapFrom),
          to: Math.min(b, s.lapTo),
        }));
      if (!pieces.length) return;
      const only = pieces.length === 1 ? pieces[0]! : undefined;
      const lap: Lap =
        only && only.from === only.lapFrom && only.to === only.lapTo
          ? { ...only.lap }
          : combine(pieces, (p) => share(p, dist), times, hr, watts);
      lap.index = out.length + 1;
      const start = iso(a);
      if (start) lap.startTimeUtc = start;
      else delete lap.startTimeUtc;
      lap.startDistanceMeters = odometer;
      odometer += lap.distanceMeters;
      out.push(lap);
    });
    laps = out;
  }

  if (!cropping) return { ...imported, laps };
  // the file's session timer covers the whole recording, not the kept part
  const { timerSeconds: _timer, recovery, ...rest } = imported;
  // heart rate recovery is measured from the finish: it only still applies
  // when the crop keeps the finish
  const uncropped = (to < total ? rest : { ...rest, recovery }) as Omit<
    T,
    'timerSeconds'
  >;
  if (uncropped.recovery === undefined) delete uncropped.recovery;
  if (options.keepClock) return { ...uncropped, laps } as T;

  // Crop the streams to [from, to], their clock and distance from zero.
  const i0 = indexAt(times, from);
  let i1 = indexAt(times, to);
  if (i1 < times.length && times[i1] === to) i1++;
  const streams = { ...imported.streams };
  for (const k of Object.keys(streams) as (keyof typeof streams)[]) {
    const s = streams[k];
    if (Array.isArray(s) && s.length === times.length)
      (streams as Record<string, unknown>)[k] = s.slice(i0, i1);
  }
  if (streams.timeSeconds)
    streams.timeSeconds = streams.timeSeconds.map((t) => t - from);
  if (streams.distanceMeters) {
    const d0 = dist(from) ?? 0;
    streams.distanceMeters = streams.distanceMeters.map((d) =>
      Number.isFinite(d) ? Math.max(0, d - d0) : d,
    );
  }
  const cropped = { ...uncropped, streams, laps } as T;
  const swim = imported.swim
    ? croppedSwim(imported.swim, laps, from, to, t0, total)
    : undefined;
  if (swim) cropped.swim = swim;
  else delete cropped.swim;
  const local = shiftLocal(imported.activity.startTimeLocal, from);
  cropped.activity = {
    ...imported.activity,
    ...croppedTotals(imported, cropped, from, to, dist),
    ...(local ? { startTimeLocal: local } : {}),
  };
  return cropped;
}

/** A swim's record cut to [from, to]: the lengths that start inside it, and
 *  the swim time from the new laps, else from the swum lengths kept, else
 *  shared out by time. */
function croppedSwim(
  swim: SwimData,
  laps: readonly Lap[] | undefined,
  from: number,
  to: number,
  t0: number,
  total: number,
): SwimData | undefined {
  const fromLaps = laps?.length ? swimMovingSeconds(laps) : undefined;
  const lengths = swim.lengths?.filter((l) => {
    const s = (Date.parse(l.startTimeUtc) - t0) / 1000;
    return Number.isFinite(s) && s >= from - SAME_SECOND && s < to;
  });
  // with no laps: the swum lengths kept, else shared out by time
  const fromLengths = lengths?.length
    ? lengths.reduce((t, l) => t + (l.active ? l.seconds : 0), 0)
    : undefined;
  const byTime = total > 0 ? (swim.movingSeconds * (to - from)) / total : 0;
  const out: SwimData = {
    movingSeconds: Math.min(to - from, fromLaps ?? fromLengths ?? byTime),
  };
  if (swim.pool) out.pool = swim.pool;
  if (lengths?.length) out.lengths = lengths;
  return out.movingSeconds > 0 ? out : undefined;
}

/** A local wall-clock start ("2026-06-01T07:08:00", or with a Z) moved on
 *  by `sec`, written the same way; `undefined` when it can't be read. */
function shiftLocal(
  local: string | undefined,
  sec: number,
): string | undefined {
  if (!local || local.startsWith('1970-01-01')) return undefined;
  const z = local.endsWith('Z');
  const base = z ? local.slice(0, -1) : local;
  const ms = Date.parse(base + 'Z');
  if (!Number.isFinite(ms)) return undefined;
  const iso = new Date(ms + Math.round(sec * 1000)).toISOString();
  return (
    (base.length === 19 ? iso.slice(0, 19) : iso.slice(0, -1)) + (z ? 'Z' : '')
  );
}

/** The whole recording as one lap, for an activity that has none. */
function wholeLap(imported: ImportedActivity, total: number): Lap {
  const a = imported.activity;
  return {
    index: 1,
    startTimeUtc: a.startTimeUtc,
    startDistanceMeters: 0,
    distanceMeters: a.distanceMeters,
    elapsedSeconds: total,
    movingSeconds: a.movingTimeSeconds,
    ...(a.distanceMeters && a.movingTimeSeconds
      ? { avgSpeedMps: a.distanceMeters / a.movingTimeSeconds }
      : {}),
  };
}

/** One lap made of parts of recorded laps. */
function combine(
  pieces: readonly Piece[],
  shareOf: (p: Piece) => number,
  times: readonly number[],
  hr: readonly number[] | undefined,
  watts: readonly number[] | undefined,
): Lap {
  let distanceMeters = 0;
  let elapsedSeconds = 0;
  let movingSeconds = 0;
  let work = 0;
  let workKnown = false;
  let calories = 0;
  let caloriesKnown = false;
  let gain = 0;
  let gainKnown = false;
  for (const p of pieces) {
    const f = shareOf(p);
    distanceMeters += p.lap.distanceMeters * f;
    elapsedSeconds += p.to - p.from;
    const span = p.lapTo - p.lapFrom;
    movingSeconds +=
      span > 0 ? (p.lap.movingSeconds * (p.to - p.from)) / span : 0;
    if (p.lap.totalWorkKj !== undefined) {
      work += p.lap.totalWorkKj * f;
      workKnown = true;
    }
    if (p.lap.calories !== undefined) {
      calories += p.lap.calories * f;
      caloriesKnown = true;
    }
    if (p.lap.elevationGainMeters !== undefined) {
      gain += p.lap.elevationGainMeters * f;
      gainKnown = true;
    }
  }
  const a = pieces[0]!.from;
  const b = pieces[pieces.length - 1]!.to;
  const lap: Lap = {
    index: 0,
    startDistanceMeters: 0,
    distanceMeters,
    elapsedSeconds,
    movingSeconds: Math.min(movingSeconds, elapsedSeconds),
  };
  if (movingSeconds > 0 && distanceMeters > 0)
    lap.avgSpeedMps = distanceMeters / movingSeconds;
  const h = channelStats(times, hr, a, b);
  if (h) {
    lap.avgHeartrate = Math.round(h.avg);
    lap.maxHeartrate = Math.round(h.max);
  }
  const w = channelStats(times, watts, a, b);
  if (w) {
    lap.avgWatts = Math.round(w.avg);
    lap.maxWatts = Math.round(w.max);
  }
  if (workKnown) lap.totalWorkKj = work;
  if (caloriesKnown) lap.calories = Math.round(calories);
  if (gainKnown) lap.elevationGainMeters = gain;
  return lap;
}

/** The cropped activity's totals: its time from the clock, and its
 *  distance, moving time and climb as the recording's own totals shared out
 *  by how much of each the kept part holds (so the shares add back up to
 *  the recording's totals). A swim timed by its lengths, laps or the watch's
 *  swim time moves for its cropped swim time; one moving by speed shares out
 *  like any other sport. */
function croppedTotals(
  imported: ImportedActivity,
  cropped: ImportedActivity,
  from: number,
  to: number,
  dist: (sec: number) => number | undefined,
) {
  const a = imported.activity;
  const total = recordingSeconds(imported);
  const whole = (dist(total) ?? 0) - (dist(0) ?? 0);
  const part = (dist(to) ?? 0) - (dist(from) ?? 0);
  const timeShare = total > 0 ? (to - from) / total : 1;
  const distShare = whole > 0 ? part / whole : timeShare;
  const before = safeSummary(imported);
  const after = safeSummary(cropped);
  const ratio = (x?: number, y?: number) =>
    x && y !== undefined ? y / x : timeShare;
  const t0 = Date.parse(a.startTimeUtc);
  return {
    startTimeUtc: Number.isFinite(t0)
      ? new Date(t0 + Math.round(from * 1000)).toISOString()
      : a.startTimeUtc,
    distanceMeters: a.distanceMeters * distShare,
    // A swim timed by its lengths, laps or the watch's swim time (a pool
    // swim, or one with no GPS) moves for its swim time, as the summary
    // takes it. One moving by speed (open water, or any swim with GPS and no
    // pool) shares out the recording's own moving time like any other
    // sport. The kept part's rule decides, so the totals agree with the
    // cropped activity's own stats.
    movingTimeSeconds: Math.round(
      Math.min(
        to - from,
        cropped.swim && movingRuleOf(cropped).rule !== 'speed'
          ? cropped.swim.movingSeconds
          : a.movingTimeSeconds * ratio(before?.moving, after?.moving),
      ),
    ),
    elapsedTimeSeconds: Math.round(to - from),
    elevationGainMeters:
      a.elevationGainMeters * ratio(before?.gain, after?.gain),
  };
}

function safeSummary(
  imported: ImportedActivity,
): { moving: number; gain: number } | undefined {
  try {
    const s = computeActivitySummary(imported);
    return { moving: s.movingTimeSeconds, gain: s.elevationGainMeters };
  } catch {
    return undefined;
  }
}
