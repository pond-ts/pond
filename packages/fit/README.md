# @pond-ts/fit

**Fitness & activity analytics on [pond-ts](https://www.npmjs.com/package/pond-ts).**

Turn raw activity streams (GPS, power, heart rate, cadence, …) into a typed,
immutable activity model with unit-safe quantities and the analytics you'd
expect — splits, power (NP / IF / TSS / curve), zones, elevation, best efforts —
behind a small `Activity` / `Section` façade.

```sh
npm install @pond-ts/fit pond-ts
```

`pond-ts` is a peer dependency.

## Quick start

```ts
import { Activity, Distance } from '@pond-ts/fit';

// `imported` is an ImportedActivity — your raw streams (time, lat/lon, power, hr, …)
const activity = Activity.fromStreams(imported);

activity.summary(); // { distance, duration, elevation, avg/max metrics, … }
activity.splits(Distance.km(1)); // per-kilometre Section[]
activity.power(260); // PowerSummary at FTP 260 W — NP, IF, TSS, curve, zones
```

Attach an athlete `Profile` for zone-aware, type-safe analytics — the
`ProfiledActivity` knows the athlete, so power/zone calls need no thresholds
passed in:

```ts
import { Profile } from '@pond-ts/fit';

const profiled = activity.usingProfile(
  Profile.of({ ftpWatts: 260, weightKg: 72 }),
);
profiled.power(); // zone-aware — FTP comes from the profile
profiled.splits(Distance.km(1)); // ProfiledSection[] — slices carry the profile through
```

Quantities are unit-safe and format themselves:

```ts
import { Speed } from '@pond-ts/fit';

Speed.mps(5.5).format('imperial'); // "12.3 mph"
```

## What's in the box

- **Façade** — `Activity` / `Section`: load once, then ask for summary / splits /
  laps / ranges.
- **Quantities** — `Distance` / `Speed` / `Pace` / `Power` / `HeartRate` /
  `Cadence` / … with unit conversions and `.format()`.
- **Analytics** — geo (distance, elevation, best efforts), power (NP / IF / TSS /
  curve), and zone distributions.
- **Profiles** — `Profile` + `usingProfile()` → type-safe `ProfiledActivity` /
  `ProfiledSection`.

## Documentation

Guides and the full API live at **<https://pjm17971.github.io/pond-ts/>**.
Source and issues: [github.com/pjm17971/pond-ts](https://github.com/pjm17971/pond-ts).

## License

MIT
