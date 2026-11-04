import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  parseFit,
  parseGpx,
  parseTcx,
  fitSport,
  fitLocalStart,
  fitRecoveryFromBytes,
  recoveryFromFitReadings,
} from '../src/files/index.js';
import { Activity } from '../src/activity/index.js';
import type { FitData } from '../src/files/index.js';

/** A FIT fixture's bytes. These are made-up activities written with the
 *  Garmin FIT SDK (see fixtures/make-fit-fixtures.mjs). */
const fit = (name: string) =>
  gunzipSync(
    readFileSync(
      fileURLToPath(new URL(`./fixtures/${name}.fit.gz`, import.meta.url)),
    ),
  );

describe('parseFit: a run that found GPS after a minute', () => {
  const imp = parseFit(fit('gps-lock-run'));
  const s = imp.streams;

  it('keeps every record; the ones before the fix have no position', () => {
    expect(s.timeSeconds).toHaveLength(241);
    expect(s.latlng).toHaveLength(241);
    expect(s.latlng.slice(0, 60).every((p) => p === null)).toBe(true);
    expect(s.latlng[60]).not.toBeNull();
    expect(s.latlng[60]![0]).toBeCloseTo(41.38, 5);
  });

  it('keeps the watch’s distance, so the minute without GPS still counts', () => {
    expect(s.distanceMeters?.[240]).toBe(720);
    const act = Activity.fromStreams(imp);
    expect(act.distance().meters).toBeCloseTo(720, 6);
  });

  it('reads heart rate, cadence, and enhanced_altitude as the height', () => {
    expect(s.heartrate?.[0]).toBe(120);
    expect(s.cadence?.[10]).toBe(85);
    expect(s.altitudeMeters?.[0]).toBeCloseTo(100, 6);
  });

  it('sport, local start, id and source', () => {
    expect(imp.activity.sportType).toBe('Run');
    expect(imp.activity.startTimeUtc).toBe('2024-03-02T09:00:00.000Z');
    // the activity's local_timestamp is an hour ahead of UTC
    expect(imp.activity.startTimeLocal).toBe('2024-03-02T10:00:00');
    expect(imp.activity.source).toBe('file');
    expect(imp.activity.id).toBe('fit:2024-03-02T09:00:00.000Z');
    const named = parseFit(fit('gps-lock-run'), {
      id: 'x:1',
      name: 'Hill run',
      sportType: 'TrailRun',
      source: 'manual',
    });
    expect(named.activity).toMatchObject({
      id: 'x:1',
      name: 'Hill run',
      sportType: 'TrailRun',
      source: 'manual',
    });
  });

  it('laps, with start distance added up and no undefined fields', () => {
    expect(imp.laps).toHaveLength(2);
    expect(imp.laps![0]).toMatchObject({
      index: 1,
      startTimeUtc: '2024-03-02T09:00:00.000Z',
      startDistanceMeters: 0,
      distanceMeters: 360,
      elapsedSeconds: 120,
      movingSeconds: 120,
      avgHeartrate: 130,
      maxHeartrate: 160,
      elevationGainMeters: 6,
    });
    expect(imp.laps![1]!.startDistanceMeters).toBe(360);
    expect('avgWatts' in imp.laps![0]!).toBe(false);
  });

  it('the creator as the file states it', () => {
    expect(imp.creator).toEqual({ manufacturer: 'garmin', product: 1018 });
  });

  it('the heart rate the watch took two minutes after the stop', () => {
    expect(imp.recovery).toEqual({
      atStopBpm: 160,
      after: [{ sec: 120, bpm: 101 }],
    });
    expect(fitRecoveryFromBytes(fit('gps-lock-run'))).toEqual(imp.recovery);
  });

  it('no swim record on a run', () => {
    expect(imp.swim).toBeUndefined();
  });
});

describe('parseFit: a pool swim', () => {
  const imp = parseFit(fit('pool-swim'));

  it('no GPS: an empty track and the watch’s distance', () => {
    expect(imp.streams.latlng).toEqual([]);
    expect(imp.streams.distanceMeters?.at(-1)).toBe(150);
    expect(imp.streams.openWater).toBeUndefined();
  });

  it('the swim time, pool and every length, rests included', () => {
    expect(imp.activity.sportType).toBe('Swim');
    expect(imp.swim?.movingSeconds).toBe(180); // 124 + 56, not the 30 s rest lap
    expect(imp.swim?.pool).toEqual({ lengthMeters: 25, unit: 'm' });
    expect(imp.swim?.lengths).toHaveLength(7);
    expect(imp.swim?.lengths?.[0]).toEqual({
      startTimeUtc: '2024-03-02T09:00:00.000Z',
      seconds: 30,
      active: true,
      strokes: 18,
      stroke: 'freestyle',
    });
    expect(imp.swim?.lengths?.[4]).toMatchObject({ active: false });
    expect(imp.swim?.lengths?.[4]!.strokes).toBeUndefined();
  });

  it('the swim time is the activity’s moving time', () => {
    expect(Activity.fromStreams(imp).movingTime().seconds).toBe(180);
  });
});

describe('parseFit: an open water swim', () => {
  const imp = parseFit(fit('open-water-swim'));
  it('is marked open water and keeps the watch’s distance', () => {
    expect(imp.streams.openWater).toBe(true);
    expect(imp.streams.distanceMeters?.at(-1)).toBe(300);
    // the zigzagging fixes are far longer than the 300 m swum
    expect(Activity.fromStreams(imp).distance().meters).toBeCloseTo(300, 6);
  });
});

describe('parseFit: enhanced_altitude only', () => {
  it('reads the height from enhanced_altitude', () => {
    // Synthetic (Garmin FIT SDK): 10 records, height in enhanced_altitude only.
    expect(parseFit(fit('enhanced-altitude')).streams.altitudeMeters).toEqual([
      600, 601, 602, 603, 604, 605, 606, 607, 608, 609,
    ]);
  });
});

describe('parseFit: bad input', () => {
  it('throws on bytes that aren’t a FIT file', () => {
    expect(() => parseFit(new TextEncoder().encode('<gpx/>'))).toThrow();
  });
});

describe('fitSport and fitLocalStart', () => {
  const d = (o: Record<string, unknown>) => ({ records: [], ...o }) as FitData;
  it('maps FIT sports to Strava labels, else the profile name', () => {
    expect(fitSport(d({ sessions: [{ sport: 'cycling' }] }))).toBe('Ride');
    expect(fitSport(d({ sports: [{ sport: 'running' }] }))).toBe('Run');
    expect(
      fitSport(
        d({ sessions: [{ sport: 'generic', sub_sport: 'open_water' }] }),
      ),
    ).toBe('Swim');
    expect(
      fitSport(
        d({ sessions: [{ sport: 'generic', sport_profile_name: 'Yoga' }] }),
      ),
    ).toBe('Yoga');
    expect(
      fitSport(d({ sessions: [{ sport: 'stand_up_paddleboarding' }] })),
    ).toBe('Stand up paddleboarding');
    expect(fitSport(d({}))).toBeUndefined();
  });

  it('no local time when the file has none, or a nonsense offset', () => {
    const start = Date.parse('2024-01-01T10:00:00Z');
    expect(fitLocalStart(d({}), start)).toBeUndefined();
    expect(
      fitLocalStart(
        d({
          activity: {
            timestamp: '2024-01-01T11:00:00Z',
            local_timestamp: '2024-01-03T11:00:00Z',
          },
        }),
        start,
      ),
    ).toBeUndefined();
  });
});

const GPX = `<?xml version="1.0"?>
<gpx creator="StravaGPX iPhone" version="1.1">
 <trk><name>Lunch ride</name><type>cycling</type><trkseg>
  <trkpt lat="41.38" lon="2.17"><ele>10</ele><time>2024-05-01T09:00:00Z</time>
   <extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>130</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
  <trkpt lat="41.381" lon="2.17"><ele>12</ele><time>2024-05-01T09:00:10Z</time></trkpt>
  <trkpt lat="41.382" lon="2.17"><time>2024-05-01T09:00:20Z</time></trkpt>
 </trkseg></trk>
</gpx>`;

describe('parseGpx', () => {
  const imp = parseGpx(GPX);
  it('points, height, heart rate and time offsets', () => {
    expect(imp.streams.latlng).toEqual([
      [41.38, 2.17],
      [41.381, 2.17],
      [41.382, 2.17],
    ]);
    expect(imp.streams.altitudeMeters).toEqual([10, 12, NaN]);
    expect(imp.streams.heartrate).toEqual([130, NaN, NaN]);
    expect(imp.streams.timeSeconds).toEqual([0, 10, 20]);
  });
  it('name, sport, start, creator', () => {
    expect(imp.activity).toMatchObject({
      name: 'Lunch ride',
      sportType: 'cycling',
      startTimeUtc: '2024-05-01T09:00:00.000Z',
      source: 'file',
      id: 'gpx:2024-05-01T09:00:00.000Z',
    });
    expect(imp.creator).toEqual({ name: 'StravaGPX iPhone' });
  });
  it('a track with no times has no time stream', () => {
    const untimed = parseGpx(
      '<gpx><trk><trkseg><trkpt lat="1" lon="2"></trkpt></trkseg></trk></gpx>',
    );
    expect(untimed.streams.timeSeconds).toBeUndefined();
    expect(untimed.creator).toBeUndefined();
  });
  it('self-closing points, single quotes and a namespace prefix', () => {
    const odd = parseGpx(
      `<gpx:gpx creator='A &amp; B'><gpx:trk><gpx:name><![CDATA[Up & over]]></gpx:name>
       <gpx:trkseg>
        <gpx:trkpt lat='1' lon='2'/>
        <gpx:trkpt lat="1.001" lon="2"><gpx:time>2024-05-01T09:00:10Z</gpx:time></gpx:trkpt>
        <gpx:trkpt lat="1.002" lon="2"><gpx:time>2024-05-01T09:00:20Z</gpx:time></gpx:trkpt>
       </gpx:trkseg></gpx:trk></gpx:gpx>`,
    );
    expect(odd.streams.latlng).toEqual([
      [1, 2],
      [1.001, 2],
      [1.002, 2],
    ]);
    expect(odd.activity.name).toBe('Up & over');
    expect(odd.creator).toEqual({ name: 'A & B' });
    // the first point has no time: it takes the first time there is
    expect(odd.streams.timeSeconds).toEqual([0, 0, 10]);
    expect(odd.activity.startTimeUtc).toBe('2024-05-01T09:00:10.000Z');
  });
  it('a point with no time in the middle takes the time before it', () => {
    const gap = parseGpx(
      `<gpx><trk><trkseg>
        <trkpt lat="1" lon="2"><time>2024-05-01T09:00:00Z</time></trkpt>
        <trkpt lat="1.001" lon="2"></trkpt>
        <trkpt lat="1.002" lon="2"><time>2024-05-01T09:00:20Z</time></trkpt>
      </trkseg></trk></gpx>`,
    );
    expect(gap.streams.timeSeconds).toEqual([0, 0, 20]);
  });
  it('the name comes from the track, not a later waypoint', () => {
    const named = parseGpx(
      `<gpx><trk><trkseg><trkpt lat="1" lon="2"><name>pt</name></trkpt></trkseg></trk></gpx>`,
    );
    expect(named.activity.name).toBe('Untitled');
  });
});

const RICH_TCX = `<?xml version="1.0"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
 <Activities>
  <Activity Sport="Biking">
   <Id>2024-05-01T09:00:00Z</Id>
   <Notes>Morning intervals</Notes>
   <Lap StartTime="2024-05-01T09:00:00Z">
    <TotalTimeSeconds>20</TotalTimeSeconds>
    <DistanceMeters>200</DistanceMeters>
    <MaximumSpeed>11.5</MaximumSpeed>
    <Calories>15</Calories>
    <AverageHeartRateBpm><Value>150</Value></AverageHeartRateBpm>
    <MaximumHeartRateBpm><Value>162</Value></MaximumHeartRateBpm>
    <Track>
     <Trackpoint>
      <Time>2024-05-01T09:00:00Z</Time>
      <Position><LatitudeDegrees>37.5</LatitudeDegrees><LongitudeDegrees>-122.3</LongitudeDegrees></Position>
      <AltitudeMeters>10</AltitudeMeters><HeartRateBpm><Value>140</Value></HeartRateBpm>
      <Cadence>88</Cadence>
      <Extensions><ns3:TPX xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><ns3:Watts>200</ns3:Watts><ns3:Speed>10.0</ns3:Speed></ns3:TPX></Extensions>
     </Trackpoint>
     <Trackpoint>
      <Time>2024-05-01T09:00:10Z</Time>
      <Position><LatitudeDegrees>37.501</LatitudeDegrees><LongitudeDegrees>-122.3</LongitudeDegrees></Position>
      <AltitudeMeters>12</AltitudeMeters><HeartRateBpm><Value>160</Value></HeartRateBpm>
      <Cadence>92</Cadence>
      <Extensions><ns3:TPX xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><ns3:Watts>300</ns3:Watts></ns3:TPX></Extensions>
     </Trackpoint>
    </Track>
    <Extensions><ns3:LX xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2"><ns3:AvgWatts>250</ns3:AvgWatts><ns3:MaxWatts>300</ns3:MaxWatts><ns3:AvgSpeed>10.0</ns3:AvgSpeed></ns3:LX></Extensions>
   </Lap>
   <Lap StartTime="2024-05-01T09:00:20Z">
    <TotalTimeSeconds>10</TotalTimeSeconds>
    <DistanceMeters>100</DistanceMeters>
    <Track>
     <Trackpoint>
      <Time>2024-05-01T09:00:20Z</Time>
      <Position><LatitudeDegrees>37.502</LatitudeDegrees><LongitudeDegrees>-122.3</LongitudeDegrees></Position>
      <AltitudeMeters>11</AltitudeMeters>
     </Trackpoint>
    </Track>
   </Lap>
  </Activity>
 </Activities>
</TrainingCenterDatabase>`;

describe('parseTcx', () => {
  const imported = parseTcx(RICH_TCX);

  it('reads power + cadence streams from the activity-extension namespace', () => {
    expect(imported.streams.latlng.length).toBe(3);
    expect(imported.streams.watts).toEqual([200, 300, NaN]);
    expect(imported.streams.cadence).toEqual([88, 92, NaN]);
    expect(imported.streams.heartrate).toEqual([140, 160, NaN]);
    expect(imported.streams.altitudeMeters).toEqual([10, 12, 11]);
  });

  it('time offsets from the first sample, the absolute base on the activity', () => {
    expect(imported.streams.timeSeconds).toEqual([0, 10, 20]);
    expect(imported.activity.startTimeUtc).toBe('2024-05-01T09:00:00.000Z');
  });

  it('the creator from <Creator><Name>, none without one', () => {
    expect(imported.creator).toBeUndefined();
    const withCreator = RICH_TCX.replace(
      '</Activity>',
      '<Creator xsi:type="Device_t"><Name>Forerunner 310XT</Name></Creator></Activity>',
    );
    expect(parseTcx(withCreator).creator).toEqual({ name: 'Forerunner 310XT' });
  });

  it('name from <Notes>, sport from the Activity attribute', () => {
    expect(imported.activity.name).toBe('Morning intervals');
    expect(imported.activity.sportType).toBe('Biking');
  });

  it('every lap with start distance added up and its own stats', () => {
    const laps = imported.laps ?? [];
    expect(laps.length).toBe(2);
    expect(laps[0]).toMatchObject({
      index: 1,
      startDistanceMeters: 0,
      distanceMeters: 200,
      elapsedSeconds: 20,
      movingSeconds: 20,
      avgWatts: 250,
      maxWatts: 300,
      avgSpeedMps: 10.0,
      maxSpeedMps: 11.5,
      avgHeartrate: 150,
      maxHeartrate: 162,
      calories: 15,
    });
    expect(laps[1]).toMatchObject({ index: 2, startDistanceMeters: 200 });
    expect('avgWatts' in laps[1]!).toBe(false);
  });

  it('a lap with an empty HR summary doesn’t take a trackpoint’s HR', () => {
    const tcx =
      parseTcx(`<TrainingCenterDatabase><Activities><Activity Sport="Biking">
      <Id>2024-02-02T00:00:00Z</Id>
      <Lap StartTime="2024-02-02T00:00:00Z">
        <TotalTimeSeconds>10</TotalTimeSeconds><DistanceMeters>50</DistanceMeters>
        <MaximumHeartRateBpm></MaximumHeartRateBpm>
        <Track><Trackpoint><Time>2024-02-02T00:00:00Z</Time>
          <Position><LatitudeDegrees>1</LatitudeDegrees><LongitudeDegrees>2</LongitudeDegrees></Position>
          <HeartRateBpm><Value>145</Value></HeartRateBpm>
        </Trackpoint></Track>
      </Lap></Activity></Activities></TrainingCenterDatabase>`);
    expect(tcx.laps?.[0]!.maxHeartrate).toBeUndefined();
    expect(tcx.streams.heartrate).toEqual([145]);
  });

  it('GPS-less: every sample kept, the device distance as the axis', () => {
    const t =
      parseTcx(`<TrainingCenterDatabase><Activities><Activity Sport="Biking">
      <Id>2024-01-01T00:00:00Z</Id><Lap StartTime="2024-01-01T00:00:00Z"><Track>
        <Trackpoint><Time>2024-01-01T00:00:00Z</Time><DistanceMeters>0</DistanceMeters></Trackpoint>
        <Trackpoint><Time>2024-01-01T00:00:10Z</Time><DistanceMeters>80</DistanceMeters></Trackpoint>
      </Track></Lap></Activity></Activities></TrainingCenterDatabase>`);
    expect(t.streams.latlng).toEqual([]);
    expect(t.streams.distanceMeters).toEqual([0, 80]);
    expect(Activity.fromStreams(t).distance().meters).toBe(80);
  });
});

/**
 * A small FIT file built by hand, to reach what the fixture doesn't: a record
 * with a compressed time header, a big-endian event definition, and a
 * developer field. Times are FIT seconds; the last record is at T + 3.
 */
function syntheticFit(opts: { cut?: number } = {}): Uint8Array {
  const T = 1_000_000_000; // FIT seconds
  const body: number[] = [];
  const u16le = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const u32le = (v: number) => [
    v & 0xff,
    (v >> 8) & 0xff,
    (v >> 16) & 0xff,
    (v >>> 24) & 0xff,
  ];
  const u32be = (v: number) => u32le(v).reverse();
  // Definition, local 0: record (20), little-endian: timestamp (253, 4 B),
  // heart rate (3, 1 B), plus one 2-byte developer field.
  body.push(0x60, 0, 0, ...u16le(20), 2, 253, 4, 0x86, 3, 1, 0x02, 1, 0, 2, 0);
  body.push(0x00, ...u32le(T), 150, 0xaa, 0xbb); // record at T, 150 bpm
  // Definition, local 1: record with heart rate only (for compressed times).
  body.push(0x41, 0, 0, ...u16le(20), 1, 3, 1, 0x02);
  // Compressed header for local 1, 3 s on: 0x80 | (1 << 5) | ((T + 3) & 0x1f).
  body.push(0x80 | (1 << 5) | ((T + 3) & 0x1f), 148);
  // Definition, local 2: event (21), big-endian: timestamp, event (0), data (3).
  body.push(0x42, 0, 1, 0, 21, 3, 253, 4, 0x86, 0, 1, 0x00, 3, 4, 0x86);
  body.push(0x02, ...u32be(T + 123), 21, ...u32be(125)); // recovery_hr 125 bpm
  const header = [
    14,
    0x10,
    ...u16le(2100),
    ...u32le(body.length),
    0x2e,
    0x46,
    0x49,
    0x54,
    0,
    0,
  ];
  const all = new Uint8Array([...header, ...body, 0, 0]);
  return opts.cut ? all.subarray(0, opts.cut) : all;
}

describe('parseTcx: names, ids and missing times', () => {
  const tcx = parseTcx(
    `<TrainingCenterDatabase><Activities><Activity Sport="Running">
      <Id>2024-05-01T09:00:00Z</Id><Notes><![CDATA[Track & field]]></Notes>
      <Lap StartTime="2024-05-01T09:00:00Z"><Track>
       <Trackpoint><Time>2024-05-01T09:00:00Z</Time><HeartRateBpm><Value>120</Value></HeartRateBpm></Trackpoint>
       <Trackpoint><HeartRateBpm><Value>121</Value></HeartRateBpm></Trackpoint>
       <Trackpoint><Time>2024-05-01T09:00:10Z</Time><HeartRateBpm><Value>122</Value></HeartRateBpm></Trackpoint>
      </Track></Lap>
      <Creator><Name>Forerunner &amp; Co</Name></Creator>
    </Activity></Activities></TrainingCenterDatabase>`,
  );
  it('decodes CDATA and entities', () => {
    expect(tcx.activity.name).toBe('Track & field');
    expect(tcx.creator).toEqual({ name: 'Forerunner & Co' });
  });
  it('never runs backwards', () => {
    expect(tcx.streams.timeSeconds).toEqual([0, 0, 10]);
  });
  it('defaults the id to the start time', () => {
    expect(tcx.activity.id).toBe('tcx:2024-05-01T09:00:00.000Z');
  });
});

describe('fitRecoveryFromBytes on a file built by hand', () => {
  it('follows compressed times, big-endian messages and developer fields', () => {
    expect(fitRecoveryFromBytes(syntheticFit())).toEqual({
      atStopBpm: 148,
      after: [{ sec: 120, bpm: 125 }],
    });
  });

  it('throws on a file cut short or not a FIT file', () => {
    expect(() => fitRecoveryFromBytes(syntheticFit({ cut: 40 }))).toThrow();
    expect(() =>
      fitRecoveryFromBytes(new TextEncoder().encode('<gpx>not fit</gpx>')),
    ).toThrow();
  });

  it('none in a file without a reading', () => {
    expect(fitRecoveryFromBytes(fit('pool-swim'))).toBeUndefined();
  });
});

describe('recoveryFromFitReadings', () => {
  const end = 1_000_000;
  it('keeps only readings after the end, within five minutes', () => {
    const r = recoveryFromFitReadings(end, { ms: end - 1000, bpm: 150 }, [
      { ms: end - 600_000, bpm: 140 }, // a mid-activity stop
      { ms: end + 120_000, bpm: 118 },
      { ms: end + 3_600_000, bpm: 70 }, // far too late to be this activity's
    ]);
    expect(r).toEqual({ atStopBpm: 150, after: [{ sec: 120, bpm: 118 }] });
  });

  it('leaves out a heart rate at the stop taken long before the end', () => {
    const r = recoveryFromFitReadings(end, { ms: end - 120_000, bpm: 150 }, [
      { ms: end + 120_000, bpm: 118 },
    ]);
    expect(r).toEqual({ after: [{ sec: 120, bpm: 118 }] });
  });

  it('is undefined with no reading after the end', () => {
    expect(
      recoveryFromFitReadings(end, undefined, [{ ms: end - 5000, bpm: 120 }]),
    ).toBeUndefined();
    expect(recoveryFromFitReadings(undefined, undefined, [])).toBeUndefined();
  });

  it('drops readings that cannot be a heart rate', () => {
    expect(
      recoveryFromFitReadings(end, undefined, [{ ms: end + 120_000, bpm: 0 }]),
    ).toBeUndefined();
  });
});
