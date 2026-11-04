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
