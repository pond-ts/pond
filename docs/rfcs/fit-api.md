# The `@pond-ts/fit` API: records, sections, analysis

**Status:** design direction, adopted for the next release's priorities
(2026-11-04). Items moved into [PLAN.md](../../PLAN.md) are the commitments;
the rest of this note is the direction they come from.

**Authorship:** design by pjm17971 (2026-11-04), written in reply to a
walk-through of the API as it stood after the Estela extraction wave
(#883–#890). Mapping to the code, open questions and build order by the pond-ts
library agent (Claude). Later contributors: add sections, don't rewrite.

**Relationship to [fit.md](fit.md):** fit.md says what the package is for
(activity files in, the Strava-class metric suite out). This note says what
using it should feel like.

## 1. The promise

> An activity records what happened. Sections let you explore any part of it.
> Analysis explains what it means for the athlete.

Kept from today: `Activity`, `Section`, and quantities that carry their unit
(`Distance`, `Duration`, `Pace`, …). Changed: the promise is no longer "one
object answers every question", which would slowly turn `Activity` into a
catalogue of unrelated methods.

## 2. The objects

| Object     | Meaning                                                            |
| ---------- | ------------------------------------------------------------------ |
| `Activity` | The complete recording, with identity and metadata                 |
| `Section`  | One continuous stretch of an activity                              |
| `Sections` | A collection of stretches, such as laps, splits or a group of laps |
| `Analysis` | Results calculated with athlete settings and analysis rules        |

An activity supports the Section interface. A lap is a Section plus what is
special to a lap (its label, how its boundary was made).

**Properties for what the recording contains; methods for requests that
select, calculate or transform.** `run.name`, `run.sport`, `run.startedAt`,
`run.device`, `run.laps`, `run.route`, `run.series.heartRate` are properties;
`run.stats()`, `run.section(...)`, `run.splits(km(1))`, `run.analyze(...)`,
`run.edit(...)` are methods.

## 3. The everyday experience

```ts
import { readActivity, km, minutes } from '@pond-ts/fit';

const run = readActivity(bytes); // an Activity, not a record to wrap

run.name; // "Morning Run"
run.sport; // "run"
run.startedAt; // an instant
run.device; // manufacturer, model, ...

const stats = run.stats();
stats.distance.format('mi'); // "6.21 mi"
stats.time.elapsed.format(); // "55:40"
stats.time.moving?.format(); // "52:14"
stats.pace.average?.format('/mi');
stats.heartRate.average?.format(); // "152 bpm"
stats.elevation.gain?.format('ft');
```

Related answers sit together (`stats.heartRate.average`, `.max`) rather than
one top-level method per statistic.

## 4. Sections are the foundation

The same questions work on a whole activity, a lap, or any stretch:

```ts
run.stats();
run.laps.at(3)?.stats();
run.section({ elapsed: { from: minutes(10), to: minutes(20) } }).stats();
run.section({ distance: { from: km(4), to: km(5) } }).stats();

for (const split of run.splits(km(1)))
  console.log(split.label, split.stats().pace.average?.format('/km'));
```

A collection is not a section: six efforts with recoveries between them are not
one continuous stretch.

```ts
for (const [label, laps] of run.laps.groupBy((lap) => labels.get(lap.id)))
  console.log(label, laps.stats());
```

Group stats aggregate the selected laps only (never the recovery between them),
and pace is total distance over total time, not a mean of lap paces.

## 5. Time that can't be misunderstood

The most important change. A recording holds several clocks, and they stay
distinct:

| Clock      | Meaning                                    |
| ---------- | ------------------------------------------ |
| `elapsed`  | Wall-clock time from start to finish       |
| `timer`    | Time while the recording timer was running |
| `moving`   | Time classified as movement                |
| `swimming` | Time spent swimming, excluding pool rests  |

Ordinary stats use elapsed time; other bases are asked for and the result says
which it used:

```ts
run.stats(); // elapsed basis
run.stats({ time: 'timer' });
run.stats({ time: 'moving' });
swim.stats({ time: 'swimming' });
```

Missing timer events never turn into a claim that timer time is known: no
timer data means `time.timer` is `null`. Movement is decided by sport-specific
rules (§12), not one exported speed threshold: a slow uphill run, a coasting
bike and a swimmer resting at the wall are three different questions.

## 6. Each sport keeps its own nouns

Running and cycling fit a continuous recording. Pool swimming also has a
discrete structure: lengths, strokes, sets, rests. No nullable `.swim` on every
activity; the activity type narrows instead:

```ts
if (activity.sport === 'swim' && activity.environment === 'pool') {
  activity.pool.length.format(); // "25 yd" — a Distance
  for (const segment of activity.segments) {
    if (segment.kind === 'length') {
      segment.distance;
      segment.stroke;
      segment.strokeCount;
      segment.stats();
    } else if (segment.kind === 'rest') {
      segment.duration;
    }
  }
}
```

A rest is a rest, not an inactive length; `lengths` holds only lengths. The pool
length is a quantity (`Distance.yards(25)`), so `{ lengthMeters: 25, unit: 'yd' }`
— which can contradict itself — goes away. Open water exposes the route and says
where its distance came from; smoothing the route and estimating the distance
are separate decisions. The same shape leaves room for multisport: legs and
transitions, each a Section.

## 7. The athlete goes on an analysis, not on the activity

FTP, weight, zones and analysis rules change the interpretation, not the
recording:

```ts
ride.stats().power.average; // from the recording
const analysis = ride.analyze({ athlete: me }); // for this athlete

analysis.power.normalized?.format('W');
analysis.power.intensityFactor; // number | null
analysis.load; // { model: 'cycling-tss', value: 112 }
analysis.zones.power;
analysis.zones.heartRate;
analysis.athlete; // the settings actually used, resolved for the activity's date
```

Missing FTP makes only FTP-dependent results unavailable; average and
normalized power still come back. Best efforts live under the metric they
describe:

```ts
run.pace.bestEffort(km(5));
ride.power.bestEffort(minutes(20));
ride.power.curve();
```

## 8. Recorded data, analysis and presentation live apart

No all-in-one `summary()` returning stats, map, chart channels and splits; that
ties the domain object to one screen.

```ts
run.stats(); // numbers
run.series.heartRate; // measured values over time
run.route; // geographic data
run.laps; // recorded sections

import { chartData, mapData } from '@pond-ts/fit/views';
chartData(run, { x: 'distance', metrics: ['pace', 'heartRate'] });
mapData(run.route, { detail: 'thumbnail' });
```

The views still fit `@pond-ts/charts` directly. The way down to pond is an
explicit conversion from a series; most users never need it.

## 9. Uncertainty you can inspect

`null` means unavailable, zero is a real value, gaps stay gaps. For more:

```ts
run.explain('distance'); // source, method, coverage, edits
```

Distance can come from the device, GPS or pool lengths; an average can rest on
partial sensor coverage. That detail is available without wrapping every value
in a result type.

## 10. Edits: immutable, in domain words and units

```ts
const fixed = run.edit({
  crop: { from: minutes(0), to: minutes(52) },
  laps: { splitAt: [minutes(10)], removeBoundaryAt: [minutes(30)] },
});
```

Positions are relative to the original recording, so combined edits mean the
same thing in any order. The original data and the edit description are kept.

## 11. What exists today, and where it goes

_Library agent (Claude), from the code at #883–#890._

| Proposed                                    | Today                                                                                         | Note                                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `readActivity(bytes)` → `Activity`          | `parseFit` / `parseGpx` / `parseTcx` → plain record (#885), then `Activity.fromStreams`       | Tell the format from the bytes; the plain record stays as the data-transfer shape for other sources                                    |
| `run.name`, `sport`, `startedAt`, `device`  | `activity.meta.*`, `record.creator`                                                           | Strava-style `sportType` strings today; `sport` needs a small closed set (run, ride, swim, walk, hike, other) plus the original label  |
| `run.stats()`                               | `Activity` methods (`distance()`, `movingTime()`, …) and `sectionStats(prep, span)` (#883)    | `sectionStats` already computes per-channel first/last/min/max/avg and the moving variants; `stats()` is its typed, unit-carrying face |
| `section({ elapsed \| distance })`          | `Activity.range(from, to)` (time only), `Span` in #883                                        | Distance-bounded sections are new                                                                                                      |
| `laps`, `splits(km(1))`, `groupBy`          | `laps()`, `splits()` arrays; `groupLaps` (#890), `sectionGroupStats` (#883)                   | `Sections` type is new; group stats exist                                                                                              |
| Clocks                                      | `elapsedTimeSeconds`, `movingTimeSeconds`; `movingClock` (#883)                               | **The FIT reader fills `movingTimeSeconds` from `total_timer_time`**, i.e. timer time labelled as moving: the mix-up §5 rules out      |
| Pool swim model                             | `ImportedActivity.swim` = `{ movingSeconds, pool: { lengthMeters, unit }, lengths[] }` (#884) | `lengths[]` holds rests as `active: false`; becomes `segments` with kinds, and `pool.length` a `Distance`                              |
| `analyze({ athlete })`                      | `usingProfile(Profile)` → `ProfiledActivity` (shipped)                                        | Same idea, new name and result shape; `Profile.asOf` already resolves dated settings                                                   |
| `pace.bestEffort`, `power.bestEffort/curve` | `distanceBestEfforts()`, `bestEfforts()`, `powerCurve()` (shipped)                            | Rename and regroup                                                                                                                     |
| `edit({...})`                               | `editRecording(record, { from, to, splitLapsAt, joinLapsAt })` in seconds (#886)              | Already relative to the original recording; needs durations and the new names                                                          |
| `series`, `route`, `views`                  | `summary()`, `windowChannels`, `trackLine` (#887), `trackShape` / `trackLevels` (#888)        | Move the screen-shaped parts to `@pond-ts/fit/views`                                                                                   |
| `explain(...)`                              | nothing                                                                                       | Later                                                                                                                                  |

The algorithms in #883–#890 stay; the new surface sits on top of them. The
current `Activity` methods are replaced outright rather than kept beside the
new ones: the package is pre-1.0, and Estela, its only known user, is
switching to it anyway.

## 12. Open questions

1. **Moving rules per sport** (needs pjm17971). Today one rule serves every
   sport: moving above 0.5 m/s (`MOVING_SPEED_MPS`, #883). Proposed start:
   run / walk / hike keep the speed rule; ride counts coasting as moving (the
   speed rule already does, since it ignores cadence and power); pool swim
   moves only during lengths, so rests are its stopped time; open water keeps
   the speed rule. Whether ride wants a different threshold is open.
2. **Where timer time comes from.** FIT has it (session and lap
   `total_timer_time`); TCX laps carry `TotalTimeSeconds` (timer); GPX has
   none, so `time.timer` is `null` for GPX.
3. **Basis for channel stats.** On a moving basis, are heart rate average and
   max taken over moving time only? Proposed: yes, every number in one
   `stats()` result uses its basis, and the result says which.

## 13. Build order for the next release

pjm17971's priorities: the direct reader, one shared `stats()` contract,
explicit clocks, the typed pool-swim model. In order:

1. `readActivity`, `Activity` properties, `stats()` with a time basis,
   `section(...)`, `Sections` with `stats()` and `groupBy`.
2. Clocks: timer from the file only, moving by sport rule, swimming from
   lengths.
3. Pool swim model.
4. After the release: `analyze`, best efforts by metric, `edit` with durations,
   `views`, `explain`.
