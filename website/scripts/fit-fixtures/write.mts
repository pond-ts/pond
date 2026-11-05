/**
 * Writes the modelled activities in `src/examples/lib/fit-fixtures.ts` as the
 * files the @pond-ts/fit guides read: a `.fit` file for each (with the Garmin
 * FIT SDK), and CSV for the Python examples.
 *
 *   npm install --prefix /tmp/fitsdk @garmin/fitsdk@21.218.0
 *   cd website
 *   FITSDK=/tmp/fitsdk/node_modules/@garmin/fitsdk \
 *     node --experimental-strip-types scripts/fit-fixtures/write.mts
 *
 * (The SDK is only needed here, so it isn't a dependency of the site.)
 *
 * Writes to `static/data/fit/`, so the site serves them at `/data/fit/…`.
 * Run it again after changing the model; the files are committed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hillRideRecording,
  intervalRunRecording,
  poolSwimRecording,
  type FixtureRecording,
} from '../../src/examples/lib/fit-fixtures.ts';

const sdk = process.env.FITSDK;
if (!sdk)
  throw new Error('set FITSDK to the @garmin/fitsdk folder (see above)');
const { Encoder, Profile } = await import(join(sdk, 'src/index.js'));

const OUT = fileURLToPath(new URL('../../static/data/fit/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const M = Profile.MesgNum;
const toSemi = (deg: number) => Math.round((deg * 2 ** 31) / 180);

function writeFit(rec: FixtureRecording): number {
  const at = (s: number) => new Date(rec.startMs + s * 1000);
  const e = new Encoder();
  e.onMesg(M.FILE_ID, {
    type: 'activity',
    manufacturer: 'development',
    product: 0,
    productName: 'pond fixture',
    timeCreated: at(0),
    serialNumber: 1,
  });
  e.onMesg(M.EVENT, { timestamp: at(0), event: 'timer', eventType: 'start' });
  const pauses = [...rec.pauses];
  let lengthIndex = 0;
  const lengths = rec.lengths ?? [];
  for (const r of rec.records) {
    // a pause: the timer stopped before the first sample after it
    while (pauses.length && pauses[0]![1] <= r.t) {
      const [a, b] = pauses.shift()!;
      e.onMesg(M.EVENT, {
        timestamp: at(a),
        event: 'timer',
        eventType: 'stop',
      });
      e.onMesg(M.EVENT, {
        timestamp: at(b),
        event: 'timer',
        eventType: 'start',
      });
    }
    const m: Record<string, unknown> = { timestamp: at(r.t) };
    if (r.lat !== undefined) m.positionLat = toSemi(r.lat);
    if (r.lng !== undefined) m.positionLong = toSemi(r.lng);
    if (r.altitude !== undefined) m.altitude = r.altitude;
    if (r.heartRate !== undefined) m.heartRate = r.heartRate;
    if (r.power !== undefined) m.power = r.power;
    if (r.cadence !== undefined) m.cadence = r.cadence;
    if (r.distance !== undefined) m.distance = r.distance;
    e.onMesg(M.RECORD, m);
    // a swim's length messages go with the sample that ends them
    while (
      lengthIndex < lengths.length &&
      lengths[lengthIndex]!.from + lengths[lengthIndex]!.seconds <= r.t
    ) {
      const l = lengths[lengthIndex]!;
      e.onMesg(M.LENGTH, {
        messageIndex: lengthIndex,
        timestamp: at(l.from + l.seconds),
        startTime: at(l.from),
        totalElapsedTime: l.seconds,
        totalTimerTime: l.seconds,
        lengthType: l.active ? 'active' : 'idle',
        ...(l.active && l.strokes !== undefined
          ? { totalStrokes: l.strokes }
          : {}),
        ...(l.active && l.stroke ? { swimStroke: l.stroke } : {}),
      });
      lengthIndex++;
    }
  }
  const end = rec.elapsed;
  e.onMesg(M.EVENT, {
    timestamp: at(end),
    event: 'timer',
    eventType: 'stopAll',
  });
  rec.laps.forEach((l, i) => {
    e.onMesg(M.LAP, {
      messageIndex: i,
      timestamp: at(l.to),
      startTime: at(l.from),
      totalElapsedTime: l.to - l.from,
      totalTimerTime: l.timer,
      totalDistance: l.distance,
    });
  });
  e.onMesg(M.SESSION, {
    timestamp: at(end),
    startTime: at(0),
    totalElapsedTime: end,
    totalTimerTime: rec.timer,
    totalDistance: rec.distance,
    sport: rec.sport,
    subSport: rec.subSport,
    firstLapIndex: 0,
    numLaps: rec.laps.length,
    ...(rec.poolMeters
      ? { poolLength: rec.poolMeters, poolLengthUnit: 'metric' }
      : {}),
  });
  e.onMesg(M.ACTIVITY, {
    timestamp: at(end),
    numSessions: 1,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
  });
  const bytes: Uint8Array = e.close();
  writeFileSync(join(OUT, `${rec.slug}.fit`), bytes);
  return bytes.length;
}

/** One row per sample; an empty cell is a sample without that channel. */
function writeCsv(rec: FixtureRecording): number {
  const cols = [
    ['lat', 'lat'],
    ['lng', 'lng'],
    ['altitude', 'altitude_m'],
    ['heartRate', 'heart_rate'],
    ['power', 'power'],
    ['cadence', 'cadence'],
    ['distance', 'distance_m'],
  ] as const;
  const used = cols.filter(([k]) =>
    rec.records.some((r) => r[k] !== undefined),
  );
  const lines = [['time', ...used.map(([, h]) => h)].join(',')];
  for (const r of rec.records) {
    const time = new Date(rec.startMs + r.t * 1000).toISOString();
    const cells = used.map(([k]) => {
      const v = r[k];
      if (v === undefined) return '';
      return k === 'lat' || k === 'lng' ? v.toFixed(9) : String(v);
    });
    lines.push([time, ...cells].join(','));
  }
  const text = lines.join('\n') + '\n';
  writeFileSync(join(OUT, `${rec.slug}.csv`), text);
  return text.length;
}

/** The recorded laps, for the Python examples that use them. */
function writeLapsCsv(rec: FixtureRecording): void {
  const lines = ['lap,start,end,distance_m,timer_s'];
  rec.laps.forEach((l, i) =>
    lines.push(
      [
        i + 1,
        new Date(rec.startMs + l.from * 1000).toISOString(),
        new Date(rec.startMs + l.to * 1000).toISOString(),
        l.distance,
        l.timer,
      ].join(','),
    ),
  );
  writeFileSync(join(OUT, `${rec.slug}-laps.csv`), lines.join('\n') + '\n');
}

for (const rec of [
  hillRideRecording(),
  intervalRunRecording(),
  poolSwimRecording(),
]) {
  const fit = writeFit(rec);
  const csv = writeCsv(rec);
  writeLapsCsv(rec);
  console.log(`${rec.slug}: ${fit} bytes of FIT, ${csv} bytes of CSV`);
}
