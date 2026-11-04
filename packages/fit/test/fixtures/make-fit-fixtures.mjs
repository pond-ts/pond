/**
 * Writes the synthetic FIT files the file-reader tests read. Made-up
 * activities (no real person's data), written with the Garmin FIT SDK:
 *
 *   npx -p @garmin/fitsdk@21.218.0 node test/fixtures/make-fit-fixtures.mjs
 *
 * (run in packages/fit; it writes the .fit.gz files beside this script).
 */
import { Encoder, Profile } from '@garmin/fitsdk';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const M = Profile.MesgNum;
const START = Date.parse('2024-03-02T09:00:00Z');
const at = (s) => new Date(START + s * 1000);
const semi = (deg) => Math.round((deg * 2 ** 31) / 180);

function write(name, build) {
  const enc = new Encoder();
  build(enc);
  const bytes = enc.close();
  const out = fileURLToPath(new URL(`./${name}.fit.gz`, import.meta.url));
  writeFileSync(out, gzipSync(bytes));
  console.log(name, bytes.length, 'bytes');
}

// A 4-minute run whose watch found GPS after 60 s: the first 60 records
// have no position but carry distance (3 m/s) and heart rate. Two laps, a
// local time 1 h ahead of UTC, a Garmin Forerunner 310XT, and the watch's
// heart rate 120 s after the stop.
write('gps-lock-run', (e) => {
  e.onMesg(M.FILE_ID, {
    type: 'activity',
    manufacturer: 'garmin',
    product: 1018,
    timeCreated: at(0),
    serialNumber: 1,
  });
  e.onMesg(M.EVENT, { timestamp: at(0), event: 'timer', eventType: 'start' });
  for (let s = 0; s <= 240; s++) {
    const rec = {
      timestamp: at(s),
      distance: s * 3,
      heartRate: 120 + Math.round(s / 6),
      enhancedAltitude: 100 + s / 10,
      cadence: 85,
    };
    if (s >= 60) {
      rec.positionLat = semi(41.38);
      rec.positionLong = semi(2.17 + ((s - 60) * 3) / 83500);
    }
    e.onMesg(M.RECORD, rec);
  }
  e.onMesg(M.EVENT, {
    timestamp: at(240),
    event: 'timer',
    eventType: 'stopAll',
  });
  e.onMesg(M.EVENT, {
    timestamp: at(360),
    event: 'recoveryHr',
    eventType: 'marker',
    data: 101,
  });
  for (const [i, from, to] of [
    [0, 0, 120],
    [1, 120, 240],
  ]) {
    e.onMesg(M.LAP, {
      messageIndex: i,
      timestamp: at(to),
      startTime: at(from),
      totalElapsedTime: to - from,
      totalTimerTime: to - from,
      totalDistance: (to - from) * 3,
      avgHeartRate: 130,
      maxHeartRate: 160,
      totalAscent: 6,
    });
  }
  e.onMesg(M.SESSION, {
    timestamp: at(240),
    startTime: at(0),
    totalElapsedTime: 240,
    totalTimerTime: 240,
    totalDistance: 720,
    sport: 'running',
    subSport: 'trail',
    firstLapIndex: 0,
    numLaps: 2,
  });
  e.onMesg(M.ACTIVITY, {
    timestamp: at(240),
    localTimestamp: Math.round(
      (START + 240_000 + 3600_000 - Date.parse('1989-12-31T00:00:00Z')) / 1000,
    ),
    numSessions: 1,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
  });
});

// A pool swim with no GPS: four 25 m lengths, a rest at the wall, two more.
// One sample per length. Laps: 100 m swum, a 30 s rest lap, 50 m swum.
write('pool-swim', (e) => {
  e.onMesg(M.FILE_ID, {
    type: 'activity',
    manufacturer: 'garmin',
    product: 1499,
    timeCreated: at(0),
    serialNumber: 1,
  });
  const lengths = [
    [0, 30, true],
    [30, 30, true],
    [60, 32, true],
    [92, 32, true],
    [124, 30, false],
    [154, 28, true],
    [182, 28, true],
  ];
  let dist = 0;
  e.onMesg(M.RECORD, { timestamp: at(0), distance: 0 });
  lengths.forEach(([from, secs, active], i) => {
    if (active) dist += 25;
    e.onMesg(M.RECORD, { timestamp: at(from + secs), distance: dist });
    e.onMesg(M.LENGTH, {
      messageIndex: i,
      timestamp: at(from + secs),
      startTime: at(from),
      totalElapsedTime: secs,
      totalTimerTime: secs,
      lengthType: active ? 'active' : 'idle',
      ...(active ? { totalStrokes: 18, swimStroke: 'freestyle' } : {}),
    });
  });
  for (const [i, from, secs, d] of [
    [0, 0, 124, 100],
    [1, 124, 30, 0],
    [2, 154, 56, 50],
  ]) {
    e.onMesg(M.LAP, {
      messageIndex: i,
      timestamp: at(from + secs),
      startTime: at(from),
      totalElapsedTime: secs,
      totalTimerTime: secs,
      totalDistance: d,
    });
  }
  e.onMesg(M.SESSION, {
    timestamp: at(210),
    startTime: at(0),
    totalElapsedTime: 210,
    totalTimerTime: 210,
    totalDistance: 150,
    sport: 'swimming',
    subSport: 'lapSwimming',
    poolLength: 25,
    poolLengthUnit: 'metric',
    firstLapIndex: 0,
    numLaps: 3,
  });
});

// An open water swim: a fix only now and then, zigzagging, while the
// watch's own distance runs smoothly at 1 m/s for 300 s.
write('open-water-swim', (e) => {
  e.onMesg(M.FILE_ID, {
    type: 'activity',
    manufacturer: 'garmin',
    product: 1499,
    timeCreated: at(0),
    serialNumber: 1,
  });
  for (let s = 0; s <= 300; s += 5) {
    const zig = (s / 5) % 2 ? 0.0002 : -0.0002;
    e.onMesg(M.RECORD, {
      timestamp: at(s),
      distance: s,
      positionLat: semi(41.38 + zig),
      positionLong: semi(2.2 + s / 83500),
    });
  }
  e.onMesg(M.LAP, {
    messageIndex: 0,
    timestamp: at(300),
    startTime: at(0),
    totalElapsedTime: 300,
    totalTimerTime: 300,
    totalDistance: 300,
  });
  e.onMesg(M.SESSION, {
    timestamp: at(300),
    startTime: at(0),
    totalElapsedTime: 300,
    totalTimerTime: 300,
    totalDistance: 300,
    sport: 'swimming',
    subSport: 'openWater',
    firstLapIndex: 0,
    numLaps: 1,
  });
});
