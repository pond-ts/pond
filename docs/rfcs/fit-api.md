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
import { km, minutes } from '@pond-ts/fit';
import { readActivity } from '@pond-ts/fit/files'; // keeps the FIT decoder out of apps that don't read files

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
activity; the activity type narrows instead (`environment` says `'pool'`,
but only the `isPoolSwim()` guard narrows the type, because TypeScript can't
narrow a class through a getter's value):

```ts
if (activity.isPoolSwim()) {
  activity.pool.length; // a Distance (a yards display unit comes later)
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
   `total_timer_time`); GPX has none, so `time.timer` is `null` for GPX.
   TCX laps carry `TotalTimeSeconds`, which may be timer time on Garmin
   exports; that is unverified, so the TCX reader treats it as elapsed and
   leaves `time.timer` `null` until checked against real files.
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

## 14. Cycling depth: ride analysis, history, models

**Authorship:** direction by pjm17971 (2026-11-04), in reply to §7. Mapping to
the code by the pond-ts library agent (Claude). References Peter gave:
TrainingPeaks' metric glossary, efficiency-factor and decoupling article and
Performance Manager article; GoldenCheetah's features, `WPrime.cpp` and chart
guide; WKO's power-duration model notes.

Basic ride numbers are covered (§7). Matching TrainingPeaks or GoldenCheetah
takes three more layers: **better analysis of one ride, analysis across rides,
and explicit performance models**. The largest addition is a first-class
`TrainingHistory`.

| Capability                      | Question it answers                                          | Priority   |
| ------------------------------- | ------------------------------------------------------------ | ---------- |
| Pacing and aerobic response     | How steady was the ride? Did heart rate drift against power? | Essential  |
| Power and cadence distributions | Time coasting, grinding, spinning, above threshold?          | Essential  |
| Effort detection and comparison | Where were the intervals? Did power fade across repeats?     | Essential  |
| Historical power records        | Personal best? This month against last season?               | Essential  |
| Training-load timeline          | How have recent and longer-term loads changed?               | Essential  |
| Workout execution               | How closely did the ride match its planned intervals?        | Next       |
| Power-duration modelling        | What do efforts suggest about critical power and W′?         | Next       |
| W′ balance and repeated surges  | How did modelled work capacity drain and recover?            | Next       |
| Durability                      | What power after substantial prior work?                     | Next       |
| Pedalling and aerodynamics      | Cadence, torque, pedal force, field testing                  | Specialist |

### 14.1 One ride

```ts
const a = ride.analyze({ athlete: me });
a.power.variabilityIndex; // NP / average power
a.aerobic.efficiencyFactor; // NP / average heart rate (cycling)
a.distribution('power', { binWidth: watts(25) });
a.distribution('cadence', { binWidth: rpm(5) });
a.coasting.duration;
```

Decoupling works on a chosen section with its method named, and says whether
the stretch suits the question, so an erratic interval session does not produce
an authoritative-looking endurance verdict:

```ts
const endurance = ride.section({
  elapsed: { from: minutes(20), to: minutes(100) },
});
const d = endurance.analyze({ athlete: me }).aerobic.decoupling({
  method: 'efficiency-factor-halves',
});
d.change;
d.firstHalf;
d.secondHalf;
d.coverage; // + suitability
```

### 14.2 Efforts

Best efforts return the section that produced them, and repeated
non-overlapping efforts are supported. Detected efforts are ordinary
`Section`s, so stats and grouping work on them at once.

```ts
a.power.bestEffort(minutes(5)); // { power, section, coverage }
a.power.bestEfforts({ duration: minutes(5), count: 5, overlap: 'none' });
a.efforts.detect({
  powerAbove: watts(300),
  minimumDuration: seconds(30),
  mergeGapsUnder: seconds(5),
});
```

Comparing repeats: average power, cadence, heart rate and recovery time; first
to last power change and spread; time inside the target range; missing,
short or long repeats. Workout execution needs a separate **planned workout**
model; recorded laps and planned steps stay distinct, with an explicit match.

### 14.3 `TrainingHistory`

Promotes the walk-through's tentative season idea to a core object; a season is
a date-filtered history.

```ts
const history = TrainingHistory.of(rides);
const season = history.between({ from: '2026-01-01', to: '2026-11-05' });
const s = season.analyze({ athlete: me });
s.power.curve();
s.power.records({
  durations: [seconds(5), minutes(1), minutes(5), minutes(20)],
});
```

Every record keeps its activity and winning section; every curve point traces
back to the effort behind it. Also: period comparisons, rolling records, W/kg
using the rider's weight **on the effort's date**.

```ts
const timeline = history.analyze({ athlete: me }).load.timeline({
  score: 'power-tss',
  chronicTimeConstant: days(42),
  acuteTimeConstant: days(7),
  timezone: 'Europe/Madrid',
});
timeline.points; // date, dailyLoad, chronicLoad, acuteLoad, balance
```

Exponentially weighted, 42 and 7 days by convention. Expose the plain meanings
alongside the familiar CTL / ATL / TSB labels. The spec must state: how the
model starts, where day boundaries fall, whether balance is start or end of
day, and the difference between **a known rest day and a gap in the history**.

### 14.4 Observed curves apart from fitted models

```ts
const observed = s.power.curve();
const model = s.power.fit({
  model: 'critical-power-2p',
  fitRange: { from: minutes(3), to: minutes(20) },
});
model.parameters.criticalPower;
model.parameters.wPrime;
model.diagnostics;
model.predict(minutes(10));
```

Observed = the rider did average this. Modelled = a named model estimates it
from supplied efforts. Return fit range, supporting efforts, residuals and
whether the data is enough. **FTP and critical power stay separate
parameters.** Other models (WKO's mFTP, FRC, Pmax) are named models with their
own outputs.

```ts
const reserve = a.wPrime.balance({ model: 'skiba-2012' });
reserve.series;
reserve.minimum;
```

Rule: **a lap's W′ balance inherits what happened before the lap.** Selecting
lap five never resets capacity to full.

### 14.5 Durability

```ts
s.power.curve({ afterWork: kilojoules(1500) });
s.power.bestEffort(minutes(5), { afterWork: kilojoules(2000) });
```

Each candidate effort lies wholly after the threshold. Also prior elapsed time
and work per kilogram. It stays an observed comparison: a lower number may just
mean fewer hard attempts late in rides.

### 14.6 Specialist modules, later

Power against cadence, quadrant analysis, crank torque, recorded left/right
balance, field aerodynamics (GoldenCheetah's Aerolab). Optional modules; each
needs extra inputs and provenance: measured or inferred, crank length, where
the measurement was taken.

### 14.7 Rules across every calculation

Keep real zero-power samples; tell sensor dropouts from pauses; report coverage
and the algorithm version. Needed before comparisons with other software mean
anything.

### 14.8 First release of this layer (pjm17971)

VI, aerobic decoupling, distributions, effort comparison, historical power
records, the training-load timeline.

### 14.9 What exists today

_Library agent (Claude), from `packages/fit/src` on the integration branch._

| Proposed                          | Today                                                                    | Note                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| VI, efficiency factor             | `normalizedPower`, `averagePower`; average HR in `sectionStats`          | Ratios only; nothing missing underneath                                                                                     |
| Decoupling                        | nothing                                                                  | New; works on any `Section` once §4 lands                                                                                   |
| Power distribution                | `powerDistribution(time, watts, binWatts)` (`PowerBin`)                  | Cadence distribution and coasting are new                                                                                   |
| Best effort with its section      | `powerCurve` / `powerBestEfforts` return `startIndex` / `endIndex`       | Turning the indexes into a `Section` is small; repeated non-overlapping efforts and detection are new                       |
| Intensity factor, load            | `intensityFactor`, `trainingLoad` (TSS on elapsed seconds)               | **Both return `0` when FTP is missing**, not `null`; breaks §7's rule and must change. Load is per ride; no timeline exists |
| W/kg on the effort date           | `profileAsOf` resolves dated weight; `powerBestEfforts({ weightKg })`    | Per ride today; history needs it per effort                                                                                 |
| `TrainingHistory`, records, curve | nothing in pond; Estela builds season curves app-side                    | New object                                                                                                                  |
| CP / W′ fit, W′ balance           | nothing                                                                  | New                                                                                                                         |
| Durability                        | nothing; the curve's cumulative-work pass could start from a work offset | New option on curve / best effort                                                                                           |
| Zero power vs dropout             | readers keep gaps as `null` (#887); power curve clamps gaps              | Coverage and algorithm version are not reported yet                                                                         |

Dependency: everything here sits on `analyze()` and `Section` (§13 steps 1 and
4). Build order for this layer follows §14.8 once those exist.

## 15. Running depth: pace, aerobic response, workouts, endurance

**Authorship:** direction by pjm17971 (2026-11-04), after §14. Mapping to the
code by the pond-ts library agent (Claude). References Peter gave:
TrainingPeaks on normalized graded pace, its trail-running limits and its
advanced metrics; RUNALYZE on marathon shape and effective VO₂max; research on
critical speed from training data; Garmin's running dynamics definitions;
Stryd's critical-power guidance.

Centre running on **pace, aerobic response, workout execution and endurance
across distance**. Power is an optional input. Already covered (walk-through):
splits, laps, distance best efforts, pace zones, walk breaks, heart-rate
recovery.

| Capability                        | Question it answers                                             | Priority  |
| --------------------------------- | --------------------------------------------------------------- | --------- |
| Grade-adjusted pace               | How does this hilly effort compare with a flat run?             | Essential |
| Aerobic efficiency and decoupling | Faster at the same heart rate? Does that slip during a run?     | Essential |
| Interval detection and comparison | Were the reps consistent? How did recovery affect the next one? | Essential |
| Historical performances           | Are mile, 5K and longer efforts improving?                      | Essential |
| Training volume and load          | How are distance, frequency, intensity and long runs changing?  | Essential |
| Workout execution                 | Planned distances, paces and recoveries done?                   | Next      |
| Durability                        | Pace and mechanics late in a long run?                          | Next      |
| Performance models                | Critical speed, race potential?                                 | Next      |
| Running dynamics                  | Cadence, step length, ground contact against pace and fatigue?  | Next      |
| Trail and hill analysis           | Climbing, descending, terrain and hiking in the session?        | Next      |

### 15.1 Trustworthy pace first

```ts
const a = run.analyze({ athlete: me });
a.pace.average;
a.pace.bestEffort(km(5));
a.pace.adjustedForGrade({ model: gradeModel });
```

Three things stay distinct: **recorded pace** (from the chosen distance and
time sources), **grade-adjusted pace** (equivalent level-ground pace, an
estimate), **normalized graded pace** (a named workout-level calculation;
TrainingPeaks uses it for running load and documents its limits on technical
trails). Calculate with speed and duration, format as pace at the edge.
Average pace = total time over total distance. Expose the distance source:
GPS, footpod, treadmill, or a supplied track distance; it matters most for
short reps.

### 15.2 Aerobic analysis on a section

```ts
const steady = run.section({ elapsed: { from: minutes(15), to: minutes(60) } });
const aerobic = steady.analyze({ athlete: me }).aerobic;
aerobic.efficiency({ output: 'grade-adjusted-speed' });
aerobic.decoupling({ output: 'grade-adjusted-speed', method: 'halves' });
```

Returns the speed-to-heart-rate relationship, its change across the section,
and coverage. Use **speed**, not minutes per km, so higher always means more
output (TrainingPeaks: normalized graded speed over average heart rate). Across
runs: speed at comparable heart rate, heart rate at comparable speed,
decoupling in comparable steady efforts; filterable by route, terrain and
conditions.

### 15.3 Workouts as the session the runner did

```ts
const reps = a.efforts.detect({
  kind: 'interval',
  distance: metres(400),
  tolerance: metres(30),
});
reps.compare();
```

Distance is one hint; also recorded laps, time-based efforts, pace changes,
strides, hill reps. For 6 × 400 m with 200 m jog: each rep's duration, pace,
cadence and heart-rate response; the recovery right after it; pace spread and
first-to-last change; target compliance when a planned workout exists. The
model is **effort plus recovery**, with warm-up and cool-down explicit; every
part stays a `Section`.

### 15.4 History: performances and exposure

```ts
const h = TrainingHistory.of(runs).analyze({ athlete: me });
h.pace.records({ distances: [metres(400), km(1), miles(1), km(5), km(10)] });
h.volume.weekly(); // distance, duration, ascent, run count, longest run
h.load.timeline({ score: 'running-tss' });
```

Also rolling mileage, run frequency, long-run progression, time in intensity
zones, each its own output beside any composite score. Named load methods
(pace, heart rate, perceived effort) keep their inputs and assumptions.
Running thresholds are dated separately from cycling ones. Records tell apart
**best recorded section** (inside training), **race result** (an explicit
event) and **modelled performance**. Default records use elapsed time,
stops included; moving-time records are a separately labelled query.

### 15.5 Durability

```ts
a.pace.bestEffort(km(5), { afterDistance: km(20) });
a.durability.compare({
  first: { from: km(5), to: km(10) },
  second: { from: km(25), to: km(30) },
  metrics: ['pace', 'heartRate', 'cadence'],
});
```

Across history, tie it to long-run exposure (RUNALYZE's marathon shape weighs
weekly distance and long runs).

### 15.6 Models, explicit

```ts
const model = h.speed.fit({
  model: 'critical-speed-2p',
  efforts: selectedPerformances,
});
model.parameters.criticalSpeed;
model.parameters.dPrime;
model.diagnostics;
```

Return supporting performances, fit range and diagnostics. Race prediction is
a separate API with a named model, supporting results and stated assumptions.
A watch's reported VO₂max and a library's estimated performance index are
different values.

### 15.7 Running dynamics as channels

```ts
a.dynamics.cadence;
a.dynamics.stepLength;
a.dynamics.groundContactTime;
a.dynamics.groundContactBalance;
a.dynamics.verticalOscillation;
a.dynamics.verticalRatio;
```

Availability depends on sensors. Keep the source field; normalize conventions,
especially steps per minute against strides per minute. Running power keeps
its provider, and thresholds stay tied to that provider (Stryd warns against
carrying them across systems).

### 15.8 First release of this layer (pjm17971)

Grade adjustment, aerobic decoupling, effort/recovery comparisons, historical
performances, weekly volume and load.

### 15.9 What exists today

_Library agent (Claude), from `packages/fit/src` on the integration branch._

| Proposed                     | Today                                                                                                         | Note                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grade-adjusted / graded pace | nothing                                                                                                       | New; needs a grade model and smoothed elevation                                                                                                            |
| Distance source              | `prepareActivity` picks GPS or the device's distance (open water, pre-GPS-lock minutes) but doesn't say which | Expose the choice; footpod and treadmill aren't told apart by the readers yet                                                                              |
| Efficiency, decoupling       | average speed and HR per section in `sectionStats`                                                            | Ratios and halves are new                                                                                                                                  |
| Distance best efforts        | `bestEffortsByDistance`: fastest **elapsed** time over any window, with mean HR                               | Already elapsed-based, as §15.4 wants; `afterDistance` is new                                                                                              |
| Effort + recovery            | breaks (`findBreaks`, #889), lap groups (#890)                                                                | Detection by distance/pace and the effort-recovery pairing are new                                                                                         |
| Volume, records over history | nothing in pond; Estela's year strip and totals do it app-side                                                | Shares `TrainingHistory` with §14                                                                                                                          |
| Running dynamics             | the FIT reader keeps `cadence` only, passed through unchanged                                                 | For runs FIT records cadence per leg (half of steps per minute), so it isn't normalized yet; step length, ground contact, vertical oscillation aren't read |

Shared with §14: `analyze()`, `TrainingHistory`, effort detection, named load
methods, observed-versus-modelled. Building those once serves both sports.

## 16. Swimming depth: lengths, repeats, sets, rests

**Authorship:** direction by pjm17971 (2026-11-04), after §15. Mapping to the
code by the pond-ts library agent (Claude). References Peter gave: Garmin's
swim terminology and SWOLF note, Garmin's pool recording guidance,
TrainingPeaks on swim threshold and swim TSS.

Swimming needs the most distinctive model. The analytics explain both
performance and **how the session was structured**. Already covered
(walk-through): pool lengths, rests, swimming time, open-water routes.

| Capability                    | Question it answers                                          | Priority  |
| ----------------------------- | ------------------------------------------------------------ | --------- |
| Repeat and set analysis       | How did my 10 × 100 compare across repeats?                  | Essential |
| Pacing consistency            | Did I start too fast? Where did I slow down?                 | Essential |
| Stroke metrics                | How did stroke count and rate change at a comparable pace?   | Essential |
| Critical swim speed and zones | What training paces do recent tests support?                 | Essential |
| Historical performances       | Are my 100, 400 and 1,500 improving?                         | Essential |
| Volume and training load      | How are distance, intensity and frequency changing?          | Essential |
| Recording correction          | Can I repair a missed length without inventing measurements? | Essential |
| Workout execution             | Did I meet the prescribed pace, rest and send-off?           | Next      |
| Technique durability          | Did holding pace take more strokes late in the set?          | Next      |
| Open-water analysis           | How consistent were pace, stroke rate and navigation?        | Next      |

### 16.1 Structure made explicit

| Object     | Meaning                                    |
| ---------- | ------------------------------------------ |
| `Length`   | One traversal of the pool                  |
| `Repeat`   | One effort, possibly several lengths       |
| `Recovery` | Rest belonging to an effort                |
| `Set`      | An ordered group of repeats and recoveries |
| `Workout`  | The prescribed session, when there is one  |

For 10 × 100 m freestyle on 2:00 the model knows ten efforts, their lengths
and their recoveries. Recorded lap boundaries stay intact; sets and repeats
can come from the workout, annotations or detection, and **keep which source
supplied them**. Drills are explicit: a 200 m kick block may have a distance
and duration but no per-length times or stroke counts, and those stay
unavailable.

### 16.2 Swimming time, rest and send-off apart

```ts
const stats = swim.stats({ time: 'swimming' });
stats.distance;
stats.time.elapsed;
stats.time.swimming;
stats.time.rest;
stats.pace.average?.format('/100m');

repeat.stats().pace.average;
repeat.recoveryAfter?.duration;
repeat.execution.swimTime;
repeat.execution.startToStart;
repeat.execution.targetSendOff;
repeat.execution.sendOffDeviation;
```

100 m in 1:40 on a 2:00 send-off leaves 20 s; in 1:50 it leaves 10 s. That
difference is central to reading the session. Wall rest, timer pauses and
unclassified time stay distinguishable.

### 16.3 Repeat comparison is the main experience

```ts
const repeats = a.repeats.detect({ distance: metres(100) });
repeats.compare({
  metrics: ['swimTime', 'pace', 'strokeRate', 'strokesPerLength', 'recovery'],
});
```

Returns fastest, slowest and typical repeat; spread and first-to-last change;
length-by-length pacing inside each repeat; recovery and send-off
consistency; target compliance when a workout is supplied. Medleys keep each
length's stroke; "mixed" describes an aggregate without losing the sequence.

### 16.4 Stroke metrics with their counting convention

```ts
a.technique.strokeRate;
a.technique.strokesPerLength;
a.technique.distancePerCycle;
a.technique.swolf;
```

Counts carry provenance: Garmin counts cycles of the watch arm, not every arm
pull. Keep the reported convention; normalize only where the mapping is known.
SWOLF (length seconds + strokes) is compared only within the same pool length,
stroke and convention, and stays descriptive, not a technique score. Better
history questions: faster at a similar stroke count? More strokes to hold the
same pace? Does that change late in a set?

### 16.5 Critical swim speed tests

```ts
const test = SwimTests.criticalSpeed({
  protocol: '400m-200m',
  efforts: [test400, test200],
});
test.speed;
test.pace.format('/100m');
test.diagnostics;
```

Distance difference over time difference. Keep the test date, stroke, course
and supporting efforts. A test **proposes** a threshold; adopting it into the
dated profile is explicit. Zones and targets relative to it, e.g. CSS + 5 s
per 100 m.

### 16.6 Course and equipment in history

```ts
const h = TrainingHistory.of(swims).analyze({ athlete: me });
h.pace.records({
  distances: [metres(100), metres(400), metres(1500)],
  stroke: 'freestyle',
  course: '25m',
  equipment: 'none',
});
h.volume.weekly();
h.load.timeline({ score: 'swim-tss' });
```

25 m, 50 m and 25 yd courses stay distinct (converting units doesn't account
for the number of turns). Annotations for fins, paddles, pull buoy, kickboard,
wetsuit. Pool best efforts default to **whole lengths**; estimating a partial
length is an explicit, labelled option. Swim TSS (threshold pace, distance,
moving time without rests) sits beside swimming time, rest, distance by
stroke, drill volume and frequency; thresholds scoped to stroke and context.

### 16.7 Open water

Distance splits with GPS coverage; pace and stroke-rate change over long
sections; stops where the recording supports them; navigation deviation
against an intended course; comparisons by wetsuit, venue and known
conditions. Raw positions and the processed route are exposed separately;
smoothing keeps its method and never implies the exact path, currents or
drafting are known.

### 16.8 Recording repair in the core

Correct pool length, stroke labels, false boundaries, missed lengths and drill
distance; dependent stats recalculate while uncertainty is kept: **adding a
missed length supplies distance, not its time or stroke count.**

### 16.9 First release of this layer (pjm17971)

Repeats and recoveries, set comparisons, stroke-count conventions, CSS tests,
course-specific records, recording repair.

### 16.10 What exists today

_Library agent (Claude), from `packages/fit/src` on the integration branch._

| Proposed                       | Today                                                                                                                              | Note                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Length` with stroke and count | `SwimLength { startTimeUtc, seconds, active, strokes?, stroke? }` from FIT `length` messages (`fitSwim`)                           | Rests are `active: false` lengths (§6 wants them separate). Counts are FIT `total_strokes` as given; the convention isn't recorded     |
| Repeat / Recovery              | Garmin pool laps: a lap with distance is an effort, a lap with none is the rest after it                                           | Pairing is a small step from the laps; detection by distance is new                                                                    |
| Set, Workout, send-off         | nothing; FIT workout steps aren't read                                                                                             | New. Sets need a source (workout, annotation, detection)                                                                               |
| Swimming time / rest           | `SwimData.movingSeconds` = timer time of laps with distance (`swimMovingSeconds`); matched Strava within a second on 20 real swims | Whole activity only today; per repeat and per section comes with the swimming clock. Timer pauses aren't told apart from wall rest yet |
| Pool and course                | `pool: { lengthMeters, unit }` from the session's `pool_length` / `pool_length_unit`                                               | Becomes `pool.length` as a `Distance` plus a course label (25m / 50m / 25yd)                                                           |
| Drills                         | lengths with stroke `drill` keep no strokes; manual drill blocks aren't modelled                                                   | Explicit drill blocks are new                                                                                                          |
| Stroke rate, SWOLF, DPS        | nothing                                                                                                                            | Derivable from lengths once the convention is kept                                                                                     |
| CSS tests, swim TSS, records   | nothing                                                                                                                            | New; history shares `TrainingHistory`                                                                                                  |
| Repair                         | `editRecording` crops, splits and joins laps (#886; swim crop is new there)                                                        | Length-level repair (missed length, pool size, stroke label) is new and must not invent time or strokes                                |
| Open water                     | cleaned swim line apart from raw fixes (`trackLine`, #887); distance from the watch when present                                   | Coverage and smoothing method aren't reported yet                                                                                      |

**Effect on §13 step 3 (the typed pool-swim model, this release):** build it
with these nouns from the start. `segments` stays the bottom layer (each a
`Length` or a rest, with drills explicit), repeats and recoveries come from the
recorded laps with their source marked, and `pool.length` is a `Distance` with
a course label. Sets, workouts, send-offs and repair follow in the swimming
release.

## 17. Editing: Estela's timeline editor as the reference

**Authorship:** prompt by pjm17971 (2026-11-04: "estela's activity editor,
crop, split, etc."). Comparison with the code by the pond-ts library agent
(Claude), from Estela's `packages/core/src/version/index.ts` and pond's
`packages/fit/src/edit/index.ts` (#886).

§10 sets the shape (`run.edit({...})`, immutable, positions on the original
recording). Estela's editor is the working version of it, used on real
activities since 2026-10-22, and does more than #886 ported:

| Estela edit (`ActivityVersion`)                             | What it does                                                                                                                     | In pond                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `from` / `to`                                               | Crop either end                                                                                                                  | Yes: `editRecording({ from, to })`                                   |
| `lapCuts`                                                   | Split a lap at a second                                                                                                          | Yes: `splitLapsAt`                                                   |
| `lapJoins`                                                  | Join a recorded lap to the one before                                                                                            | Yes: `joinLapsAt`                                                    |
| `splits` (`firstPart`, `versionParts`, `partVersion`)       | Split one recording into several activities (a run, then the walk home); each part gets its own crop and the lap edits inside it | No                                                                   |
| `versionChanges`                                            | The edit as a list (crop start, crop end, split, join, part) for showing what changed                                            | No                                                                   |
| `stretchOnVersion`, `stretchOnRecording`, `recordingSecond` | Move a stretch (a custom segment, a note) between the recording's clock and the edited one's                                     | No (the edited record's clock starts at the crop; nothing maps back) |
| `totals`                                                    | Totals saved with the edit for lists that don't load the recording                                                               | No, and shouldn't be: an app cache, not library                      |

Proposed additions to §10, all in durations on the original recording:

```ts
const fixed = run.edit({
  crop: { from: minutes(2), to: minutes(58) },
  laps: { splitAt: [minutes(10)], removeBoundaryAt: [minutes(30)] },
  parts: { splitAt: [minutes(52)] }, // the walk home becomes its own activity
});

fixed.parts; // Activity[]: the first is `fixed` itself
fixed.edit; // the description, kept, in the original's terms
fixed.changes; // [{ kind: 'crop-start', at }, …] for a "what changed" list
fixed.original; // the untouched recording
fixed.toOriginal(section); // a stretch on the edited clock, on the original's
fixed.fromOriginal({ from, to }); // a saved stretch on the edited clock, or null if cropped off
```

The clock mapping matters because apps keep their own marks (custom segments,
notes, lap labels) on the original recording so they survive re-editing;
Estela needed exactly these three functions. The swimming repair edits in
§16.8 (missed length, pool size, stroke label) join the same `edit()` as
further kinds, with the same rule that an edit never invents a measurement.

## 18. Metrics: athlete values over time

**Authorship:** idea and the zone design by pjm17971 (2026-11-09: "I actually
wonder if we need a new library primitive called a metric"; "Zone boundaries
as the metrics (within a metric group) and max hr computes and stores the
boundaries. Time series visualization would show the boundaries."). Written
up by the pond-ts library agent (Claude).

### 18.1 Why

The athlete profile (`AthleteProfileJson`, `profileAsOf`) holds four dated
lists: weight, FTP, heart-rate zone basis, 5 k time. Each answers "what was in
force on this date?" through a private pond series and `atOrBefore`. That
works for a handful of typed values, and stops working when values are
measured:

- Estela's "Get weight" from Apple Health (Estela PR #289) turned years of
  daily weigh-ins into thousands of "from this date" entries. The fix there
  (one value a week, a paged list) is a workaround: a weigh-in is a reading,
  and holding one reading until the next is the wrong rule for a noisy value.
- Resting heart rate (needed for heart-rate load), HRV, VO2max and sleep are
  the same kind of thing and have nowhere to go.
- Estela copies the dated-list logic three more times (the first value
  covering earlier dates, editing the list, the Swift weight merge), because
  pond keeps it private.

### 18.2 A metric

One named series of dated numbers with a unit, and a rule for answering a
date.

```ts
const weight = Metric.of('weight', {
  unit: 'kg',
  rule: 'interpolate', // a line between readings; the last value after the last
  entries: [
    { at: '2026-11-02T07:10:00Z', value: 71.4, source: 'apple-health' },
    { at: '2026-11-03T07:05:00Z', value: 71.1, source: 'apple-health' },
    { at: '2026-10-01', value: 72, source: 'typed' },
  ],
});

weight.on('2026-11-02T19:00:00Z'); // { value: 71.25, readings: 2, age: Duration, sources: [...] } | null
weight.entries; // as stored, date order
weight.between({ from, to }); // a pond series, for charts
weight.smoothed(days(7)).on(date); // the week's average, what analysis reads
```

- **Rules.** `'hold'` (the last value stays in force until the next: FTP,
  max HR, 5 k time) and `'interpolate'` (weight, resting HR, HRV). Interpolate
  draws a straight line between the readings either side of the date; with
  no later reading it uses the last value (Peter, 2026-11-10: "If there's no
  future value then last value, otherwise interpolated"). The rule is part of
  the metric, with a default per known metric, so callers ask `on(date)` and
  don't repeat it.
- **Before the first entry.** `before: 'first' | 'none'`. Estela's
  `reachBack` (the first value covers everything earlier) becomes this option
  instead of app code.
- **Each entry says where it came from**: typed, a device or app, a race
  result, an estimate from activities (an FTP from rides, a 5 k from a run).
  The answer to `on(date)` carries the age of what it used, so a W/kg from a
  weight eight months old can say so (§9).
- **Same-day entries.** Two entries at one moment: the later write wins.
  Typed and measured entries on one day both stay; the rule decides.

### 18.3 Metric groups: zones

Some values only make sense together. A **metric group** is a set of metrics
that change together: one dated entry sets every member.

Zones are groups of their **boundaries**:

| Group            | Members                          | Set from           |
| ---------------- | -------------------------------- | ------------------ |
| Heart-rate zones | Z1/Z2, Z2/Z3, Z3/Z4, Z4/Z5 (bpm) | max HR, or typed   |
| Power zones      | the boundaries, in watts         | FTP, or typed      |
| Pace zones       | the boundaries, as speed         | 5 k time, or typed |

All three store their boundaries, the same way (Peter, 2026-11-10).

- The boundaries are the stored truth. An input such as max HR is a metric
  of its own; entering one **computes the boundaries and stores them** in the
  group on that date, with the source saying how (`{ from: 'maxHr', value:
186, method: 'percent-of-max' }`). Typing boundaries is an entry with
  source `typed`.
- Stored, not worked out each time: a later change of method doesn't rewrite
  past zones, and the boundaries are what a chart shows.
- A chart of the group over time draws each boundary as a stepped line, so
  the zones read as bands that move when the athlete changed them.
- A group entry must be complete and rising (Z1/Z2 < Z2/Z3 < …); one that
  isn't is refused, not stored.

### 18.4 The profile as metrics

`Profile.asOf(date)` stays the call analysis makes. Underneath, the profile
becomes a set of metrics and groups: weight, FTP, max HR, 5 k time, resting
HR, and the three zone groups. Today's `AthleteProfileJson` maps over
directly:

- `weightKg`, `ftpWatts`, `paceThreshold` → metrics with `rule: 'hold'`
  (weight moves to `interpolate` once readings arrive).
- `hrZone` `{ maxHr }` entries → a max HR entry plus the computed boundaries;
  `{ bounds }` entries → typed boundaries.

`TrainingHistory` reads W/kg and heart-rate load from these, with the value
in force on each activity's date, as it does now. For weight (and other
measured metrics) that value is the rolling week's average, not the day's
reading.

### 18.5 Decided

- **Measured metrics interpolate** between readings, and keep the last value
  after the last reading (2026-11-10). This replaces an averaging window and
  its question of whether to use readings after the date. Interpolating does
  use the next reading when there is one; the answer's `sources` names both.
- **Analysis reads measured metrics smoothed** (Peter, 2026-11-10: "I do
  like the idea of consumers of weight data taking a rolling week avg though,
  otherwise i could imagine the underlying variability causing issues
  elsewhere"). The metric keeps every reading and interpolates between them,
  for charts and for `on(date)`; the profile, and so W/kg and anything else
  derived, reads `smoothed(days(7))`: the average of the interpolated line
  over the 7 days up to the date. A day-to-day swing of a kilo then moves a
  W/kg by a seventh as much. The window is part of the metric's definition
  (default a week for weight, resting HR and HRV), so every consumer gets the
  same number.
- **Power and pace zones store boundaries** like heart-rate zones
  (2026-11-10). A new FTP or 5 k time writes new boundaries on its date.

### 18.6 Open questions

1. **Where the entries live** for a large history: raw weigh-ins for ten
   years are about 3,600 entries. Fine in one file or document; an app could
   still choose to keep one per day.
2. **Estimated values** (FTP from rides, max HR seen in activities): entries
   with an `estimate` source the athlete accepts, or a separate suggestion
   the app shows? Accepting keeps the metric the single answer.
