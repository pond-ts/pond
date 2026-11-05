/**
 * A Garmin watch's heart rate recovery reading.
 * Many Garmin watches keep measuring heart rate after the stop button and save
 * one reading, two minutes later, as a FIT `recovery_hr` event (event number
 * 21, the bpm in its `data` field). Checked on 1,238 FIT files of a real
 * Strava export: about 170 Garmin files have one, at 120 to 122 s after the
 * last record; files recorded by phone apps have none.
 *
 * The heart rate at the stop is the last record's. A `recovery_hr` event
 * before the last record (a mid-activity stop, then the activity went on) is
 * left out: only the reading after the final stop counts.
 */
import type { HeartRateRecovery } from '../types.js';
import type { FitData } from './fitParser.js';
import { RECOVERY_MAX_SECONDS } from '../recovery/index.js';

export { RECOVERY_MAX_SECONDS };

/** FIT's event number for `recovery_hr`. */
const RECOVERY_HR_EVENT = 21;
/** The last heart rate counts as "at the stop" only this close to the end. */
const AT_STOP_SECONDS = 30;
/** FIT's epoch (1989-12-31T00:00:00Z) in Unix ms. */
const FIT_EPOCH_MS = 631065600_000;

const plausible = (bpm: number) =>
  Number.isFinite(bpm) && bpm >= 25 && bpm <= 250;

/**
 * The recovery from the moments a FIT file gives: when its last record was,
 * its last heart rate, and its `recovery_hr` readings. Undefined when no
 * reading falls after the end.
 */
export function recoveryFromFitReadings(
  lastRecordMs: number | undefined,
  lastHeartRate: { ms: number; bpm: number } | undefined,
  readings: readonly { ms: number; bpm: number }[],
): HeartRateRecovery | undefined {
  if (lastRecordMs === undefined) return undefined;
  const after = readings
    .map((r) => ({ sec: Math.round((r.ms - lastRecordMs) / 1000), bpm: r.bpm }))
    .filter(
      (r) => r.sec > 0 && r.sec <= RECOVERY_MAX_SECONDS && plausible(r.bpm),
    )
    .sort((a, b) => a.sec - b.sec);
  if (!after.length) return undefined;
  const atStop =
    lastHeartRate &&
    lastRecordMs - lastHeartRate.ms <= AT_STOP_SECONDS * 1000 &&
    plausible(lastHeartRate.bpm)
      ? lastHeartRate.bpm
      : undefined;
  return { ...(atStop !== undefined ? { atStopBpm: atStop } : {}), after };
}

const ms = (v: unknown): number =>
  v instanceof Date || typeof v === 'string' ? new Date(v).getTime() : NaN;

/** The recovery in a FIT file already decoded by fit-file-parser. */
export function fitRecovery(data: FitData): HeartRateRecovery | undefined {
  const records = (data.records ?? []).filter((r) =>
    Number.isFinite(ms(r.timestamp)),
  );
  const last = records[records.length - 1];
  let lastHr: { ms: number; bpm: number } | undefined;
  for (let i = records.length - 1; i >= 0; i--) {
    const hr = records[i]!.heart_rate;
    if (typeof hr === 'number' && Number.isFinite(hr)) {
      lastHr = { ms: ms(records[i]!.timestamp), bpm: hr };
      break;
    }
  }
  const events = (data.events as Record<string, unknown>[] | undefined) ?? [];
  const readings = events
    .filter((e) => e.event === 'recovery_hr' && typeof e.data === 'number')
    .map((e) => ({ ms: ms(e.timestamp), bpm: e.data as number }))
    .filter((r) => Number.isFinite(r.ms));
  return recoveryFromFitReadings(
    last ? ms(last.timestamp) : undefined,
    lastHr,
    readings,
  );
}

interface MessageDef {
  global: number;
  little: boolean;
  fields: { num: number; size: number }[];
  size: number;
  /** Bytes of the timestamp field (253) in the definition, 0 without one.
   *  A message with a compressed time leaves them out of its payload. */
  tsSize: number;
}

/**
 * The recovery in a FIT file's bytes, walking its messages without decoding
 * them all (a re-dropped export reads every FIT file for this; a full decode
 * of each is far slower). Only record (20) and event (21) messages are read.
 * Undefined when the file has no reading after the stop; throws when the
 * bytes aren't a whole FIT file, so the caller can try it again later rather
 * than mark it read.
 */
export function fitRecoveryFromBytes(
  b: Uint8Array,
): HeartRateRecovery | undefined {
  if (
    b.length < 14 ||
    b[8] !== 0x2e ||
    b[9] !== 0x46 ||
    b[10] !== 0x49 ||
    b[11] !== 0x54
  )
    throw new Error('Not a FIT file'); // no ".FIT" in the header
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const end = b[0]! + view.getUint32(4, true);
  if (end > b.length) throw new Error('FIT file is cut short');
  const broken = () => new Error('FIT file is damaged');
  const defs = new Map<number, MessageDef>();
  let pos = b[0]!;
  let ts = 0; // the last full timestamp, FIT seconds
  let lastRecord: number | undefined;
  let lastHr: { ms: number; bpm: number } | undefined;
  const readings: { ms: number; bpm: number }[] = [];
  const toMs = (s: number) => FIT_EPOCH_MS + s * 1000;

  const read = (d: MessageDef, at: number, compressedTs?: number) => {
    const v = new Map<number, number>();
    let p = at;
    for (const f of d.fields) {
      // a compressed-time message has no timestamp bytes of its own
      if (compressedTs !== undefined && f.num === 253) continue;
      if (f.size === 1) v.set(f.num, b[p]!);
      else if (f.size === 2) v.set(f.num, view.getUint16(p, d.little));
      else if (f.size === 4) v.set(f.num, view.getUint32(p, d.little));
      p += f.size;
    }
    const own = v.get(253);
    if (own !== undefined && own !== 0xffffffff) ts = own;
    const t = own !== undefined && own !== 0xffffffff ? own : compressedTs;
    if (t === undefined) return;
    if (d.global === 20) {
      lastRecord = toMs(t);
      const hr = v.get(3);
      if (hr !== undefined && hr !== 0xff) lastHr = { ms: toMs(t), bpm: hr };
    } else if (d.global === 21 && v.get(0) === RECOVERY_HR_EVENT) {
      const data = v.get(3);
      const data16 = v.get(2);
      const bpm =
        data !== undefined && data !== 0xffffffff
          ? data
          : data16 !== undefined && data16 !== 0xffff
            ? data16
            : undefined;
      if (bpm !== undefined) readings.push({ ms: toMs(t), bpm });
    }
  };

  while (pos < end) {
    const h = b[pos++]!;
    if (h & 0x80) {
      // A data message with a compressed time: 5 bits of seconds on the last.
      const d = defs.get((h >> 5) & 3);
      const size = d ? d.size - d.tsSize : 0;
      if (!d || pos + size > end) throw broken();
      const off = h & 0x1f;
      let t = (ts & ~0x1f) + off;
      if (off < (ts & 0x1f)) t += 0x20;
      ts = t;
      read(d, pos, t);
      pos += size;
      continue;
    }
    const local = h & 0x0f;
    if (h & 0x40) {
      if (pos + 5 > end) throw broken();
      const little = b[pos + 1] === 0;
      const global = view.getUint16(pos + 2, little);
      const n = b[pos + 4]!;
      pos += 5;
      if (pos + 3 * n > end) throw broken();
      const fields: MessageDef['fields'] = [];
      let size = 0;
      for (let i = 0; i < n; i++, pos += 3) {
        fields.push({ num: b[pos]!, size: b[pos + 1]! });
        size += b[pos + 1]!;
      }
      if (h & 0x20) {
        const dev = b[pos++]!;
        if (pos + 3 * dev > end) throw broken();
        for (let i = 0; i < dev; i++, pos += 3) size += b[pos + 1]!;
      }
      const tsSize = fields.find((f) => f.num === 253)?.size ?? 0;
      defs.set(local, { global, little, fields, size, tsSize });
      continue;
    }
    const d = defs.get(local);
    if (!d || pos + d.size > end) throw broken();
    read(d, pos);
    pos += d.size;
  }
  return recoveryFromFitReadings(lastRecord, lastHr, readings);
}
