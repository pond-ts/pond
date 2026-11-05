# @pond-ts/fit

[![npm](https://img.shields.io/npm/v/@pond-ts/fit?label=%40pond-ts%2Ffit)](https://www.npmjs.com/package/@pond-ts/fit)
[![CI](https://github.com/pond-ts/pond/actions/workflows/ci.yml/badge.svg)](https://github.com/pond-ts/pond/actions/workflows/ci.yml)
[![docs](https://img.shields.io/badge/docs-pond--ts.org-1f6feb)](https://pond-ts.org/docs/fit/)

**Fitness & activity analytics on [pond-ts](https://www.npmjs.com/package/pond-ts).**

Read an activity file (FIT, GPX, TCX) into a typed, immutable `Activity` with
unit-safe quantities. Ask the same questions of the whole activity, a lap, or
any stretch of it. See [docs/rfcs/fit-api.md](../../docs/rfcs/fit-api.md) for
where the API is going.

```sh
npm install @pond-ts/fit pond-ts
```

`pond-ts` is a peer dependency.

## Quick start

```ts
import { km, minutes } from '@pond-ts/fit';
import { readActivity } from '@pond-ts/fit/files';

const run = readActivity(bytes); // FIT, GPX or TCX, told from the bytes

run.name; // "Morning Run"
run.sport; // "run"
run.startedAt; // Date

const stats = run.stats(); // elapsed time basis by default
stats.distance?.format('mi'); // "6.21 mi"
stats.time.elapsed?.format(); // "55:40"
stats.time.moving?.format(); // "52:14"
stats.heartRate.average?.format(); // "152 bpm"
run.stats({ time: 'moving' }).pace.average?.format('metric');

run.laps.at(2)?.stats();
run.section({ elapsed: { from: minutes(10), to: minutes(20) } }).stats();
for (const split of run.splits(km(1)))
  console.log(split.label, split.stats().pace.average?.format('metric'));

// your own labels for laps, kept by your app
for (const [label, laps] of run.laps.groupBy((lap) => labels.get(lap.id)))
  console.log(label, laps.stats()); // the chosen laps only, never the recovery between
```

A swim also has `stats.time.swimming` and `stats.time.rest`, and
`swim.stats({ time: 'swimming' })` leaves the rests at the wall out of every
number; a pool swim counts as moving only during its lengths.

```ts
if (swim.isPoolSwim()) {
  swim.pool?.course; // "25m"
  for (const segment of swim.segments)
    if (segment.kind === 'length')
      console.log(segment.stroke, segment.strokeCount, segment.stats());
    else console.log('rest', segment.duration.format());
  for (const rep of swim.repeats)
    console.log(rep.stats().pace.average, rep.recoveryAfter?.duration.format());
}
```

The athlete goes on an analysis, not on the activity. Pass a `Profile`, or
the stored profile with its dated history (resolved to the activity's date):

```ts
const a = ride.analyze({ athlete: profile });
a.power.intensityFactor; // null without FTP
a.power.variabilityIndex;
a.load; // { model: 'cycling-tss', value: 112 }, or null without FTP
a.zones.heartRate; // time in each zone; null without HR zones

ride.power.bestEffort(minutes(20))?.power.format(); // "291 W"
ride.power.curve(); // shortest first, never rising
run.pace.bestEffort(km(5))?.time.format(); // with .section: where it was
```

`null` means unavailable (no power meter, no timer data in the file); a real
zero stays zero. Timer time comes only from the file: GPX has none, so its
`time.timer` is `null`.

## What's in the box

- **Model** — `Activity`, `Section`, `Sections`: one `stats()` contract on a
  stated time basis (`'elapsed'`, `'moving'`, `'timer'`).
- **Readers** — `@pond-ts/fit/files`: `readActivity`, plus `parseFit` /
  `parseGpx` / `parseTcx` to the plain `ImportedActivity` record.
- **Quantities** — `Distance` / `Duration` / `Speed` / `Pace` / `Power` /
  `HeartRate` / `Cadence` / `Elevation`, with `.format()`, and the shorthands
  `km`, `miles`, `meters`, `seconds`, `minutes`, `hours`.
- **Functional layer** — power (NP / IF / TSS / curve), zones, best efforts,
  breaks and heart-rate recovery, lap groups, outlines, recording edits; each a
  plain function over the prepared activity (`activity.prepared()`).
- **Analysis** — `section.analyze({ athlete })`: intensity, load and zones
  from the athlete's settings; best efforts under `section.power` and
  `section.pace`. `Profile` resolves dated athlete settings (FTP, weight,
  zones).

## Documentation

Guides and the full API live at **<https://pond-ts.org/docs/fit/>**.
Source and issues: [github.com/pond-ts/pond](https://github.com/pond-ts/pond).

## Versioning

Released in lock-step with `pond-ts` and the other `@pond-ts/*` packages
under one version — keep them in step. Pre-1.0, a minor release may contain
breaking changes (each marked **breaking** in the
[CHANGELOG](https://github.com/pond-ts/pond/blob/main/CHANGELOG.md) with a
migration note); patch releases never break. From 1.0 the project follows
semver. See
[Versioning](https://pond-ts.org/docs/reference/versioning) for what
counts as the public API.

## License

MIT
