/**
 * `run.edit({...})` (RFC §10, §17): an edit in durations, every position on
 * the original recording's clock, so combined edits mean the same thing in
 * any order. This module turns one into the record edits for each part;
 * `Activity.edit` builds the activities.
 */
import {
  editRecording,
  recordingSeconds,
  type RecordingEdit,
} from '../edit/index.js';
import { Duration } from '../quantities.js';
import type { ImportedActivity } from '../types.js';

/** An edit, every position a duration from the original recording's start. */
export interface ActivityEdit {
  /** Keep only this stretch. Either end may be left out. */
  crop?: { from?: Duration; to?: Duration };
  laps?: {
    /** A new lap starts at each of these. */
    splitAt?: readonly Duration[];
    /** The recorded lap starting at each of these (within a second) joins
     *  the lap before it. */
    removeBoundaryAt?: readonly Duration[];
  };
  /** Split the recording into several activities: a new one starts at each
   *  of these (a run, then the walk home). */
  parts?: { splitAt: readonly Duration[] };
}

/** One change an edit makes, for a "what changed" list. */
export interface EditChange {
  kind: 'crop-start' | 'crop-end' | 'lap-split' | 'lap-join' | 'part-split';
  /** Where, on the original recording's clock. */
  at: Duration;
}

/** One part of an edit: its record, and where its clock starts on the
 *  original's. @internal */
export interface EditedPart {
  record: ImportedActivity;
  offset: number;
  from: number;
  to: number;
}

const secs = (d: Duration, what: string): number => {
  const s = d.seconds;
  if (!Number.isFinite(s)) throw new RangeError(`edit: ${what} must be finite`);
  return s;
};

const list = (ds: readonly Duration[] | undefined, what: string) =>
  [...(ds ?? [])].map((d) => secs(d, what)).sort((a, b) => a - b);

/** Whether an edit changes nothing. */
export function isNoEdit(edit: ActivityEdit): boolean {
  return (
    edit.crop?.from === undefined &&
    edit.crop?.to === undefined &&
    !edit.laps?.splitAt?.length &&
    !edit.laps?.removeBoundaryAt?.length &&
    !edit.parts?.splitAt.length
  );
}

/** The changes an edit makes, in order along the recording. */
export function changesOf(edit: ActivityEdit): EditChange[] {
  const out: EditChange[] = [];
  const add = (kind: EditChange['kind'], s: number) =>
    out.push({ kind, at: Duration.seconds(s) });
  if (edit.crop?.from !== undefined)
    add('crop-start', secs(edit.crop.from, 'crop.from'));
  if (edit.crop?.to !== undefined)
    add('crop-end', secs(edit.crop.to, 'crop.to'));
  for (const s of list(edit.laps?.splitAt, 'laps.splitAt')) add('lap-split', s);
  for (const s of list(edit.laps?.removeBoundaryAt, 'laps.removeBoundaryAt'))
    add('lap-join', s);
  for (const s of list(edit.parts?.splitAt, 'parts.splitAt'))
    add('part-split', s);
  return out.sort((a, b) => a.at.seconds - b.at.seconds);
}

/**
 * The record of each part. With no crop and one part, the clock is the
 * original's; otherwise each part's clock starts again at its own start.
 * Throws a `RangeError` on a non-finite position, a crop that keeps
 * nothing, or a part split outside the kept stretch.
 */
export function editParts(
  record: ImportedActivity,
  edit: ActivityEdit,
): EditedPart[] {
  const total = recordingSeconds(record);
  const cropFrom =
    edit.crop?.from !== undefined
      ? secs(edit.crop.from, 'crop.from')
      : undefined;
  const cropTo =
    edit.crop?.to !== undefined ? secs(edit.crop.to, 'crop.to') : undefined;
  const from = Math.max(0, cropFrom ?? 0);
  const to = Math.min(total, cropTo ?? total);
  if (!(to > from))
    throw new RangeError(
      `edit: the crop keeps nothing (from ${from} s, to ${to} s)`,
    );
  const cuts = list(edit.parts?.splitAt, 'parts.splitAt');
  for (const c of cuts)
    if (!(c > from && c < to))
      throw new RangeError(
        `edit: a part split at ${c} s is outside the kept stretch`,
      );
  const splits = list(edit.laps?.splitAt, 'laps.splitAt');
  const joins = list(edit.laps?.removeBoundaryAt, 'laps.removeBoundaryAt');
  const edges = [from, ...cuts, to];
  const cropping =
    cropFrom !== undefined || cropTo !== undefined || cuts.length > 0;
  const out: EditedPart[] = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const a = edges[k]!;
    const b = edges[k + 1]!;
    const inside = (s: number) => s > a && s < b;
    const e: RecordingEdit = {
      splitLapsAt: splits.filter(inside),
      joinLapsAt: joins.filter(inside),
    };
    if (cropping) {
      if (cuts.length || cropFrom !== undefined) e.from = a;
      if (cuts.length || cropTo !== undefined) e.to = b;
    }
    const cropped = e.from !== undefined || e.to !== undefined;
    out.push({
      record: editRecording(record, e),
      offset: cropped ? Math.max(0, e.from ?? 0) : 0,
      from: a,
      to: b,
    });
  }
  return out;
}
