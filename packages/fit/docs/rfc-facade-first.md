# RFC: façade-first `@pond-ts/fit` surface

**Status:** in progress — slice 1 (the `Profile` / `usingProfile` foundation) lands
with this RFC; the rest is sequenced below.
**Supersedes** the [`api.md`](./api.md) tenet that the functional operator core is
public ("drop to the functional layer or stay fluent — both first-class"). This
RFC makes the **façade the surface** and demotes the operators to internal. That
is a deliberate reversal, recorded here.

## Why

The barrel grew to ~85 named bindings. Most are functional operators
(`computeActivitySummary`, `polylineCumulative`, `hrZoneDistribution`,
`convertDistance`, …) that exist as the inner layer beneath `Activity` / `Section`.
Exposing both layers doubles the surface, creates redundant entry points, and
leaks low-level vocabulary. The library should present **one ergonomic object
model** — `Activity` + `Section` + the quantities + a `Profile` — and keep the
operators as a tested private core.

This is free to do **now**: the package is private + unpublished and estela still
consumes its own local copy, so breaking the barrel costs nothing before the
first npm publish.

## Target surface

| Keep (public) | Demote (internal) |
| --- | --- |
| Quantities — `Distance`, `Elevation`, `Duration`, `Speed`, `Pace`, `Power`, `HeartRate`, `Cadence` (to own `.format()`) | `metersToFeet`, `metersToMiles`, `formatDuration`, `formatPace` → onto quantities |
| `Activity`, `Section` | `computeActivitySummary`, `prepareActivity`, `summaryFromPrepared`, `buildTrackFromStreams`, `windowChannels` → façade methods |
| **`Profile`** | `hydrateProfile`, `profileAsOf`, `hrZonesFrom`, `paceZonesFrom`, `powerZonesFrom` → `Profile` internals |
| **`ProfiledActivity`**, **`ProfiledSection`** | `computePower`, `powerBestEfforts`, `zoneDistributionByValue`, `hrZoneDistribution`, `paceZoneDistribution` → profiled-view methods |
| `Track` for bare-`GeoPoint[]` ops | `polylineCumulative`, `interpolateAtDistance`, `polylineSlice`, `boundsOf`, `bestEffortsByDistance`, `segmentsInRange` → `Track` / façade |
| **Result types** the façade returns (`ActivitySummary`, `Sample`, `SectionMetrics`, `Split`, `Segment`, `DistanceEffort`, `PowerSummary`, `PowerCurvePoint`, `PowerEffort`, `PowerZone`, `PowerBin`, `ZoneTime`, `ProfilePoint`/`ProfileSample`, `TrackSeries`/`TrackColumns`/`TrackPoint`) | — (hide the verbs, keep the nouns the façade returns) |
| Construction/data contract: `GeoPoint`, `ActivityStreams`, `ActivityMeta`, `Lap`, `ImportedActivity`, `ActivitySource` | `UnitPreferences`, `DistanceUnit`/…, `convert*`, `*UnitLabel`, `DEFAULT_UNITS` → estela (app concern) or a `Units` namespace |

Net: ~85 bindings → ~35–40, almost all nouns + a handful of classes.

## The profile model (slice 1 — implemented here)

Athlete-dependent analytics (FTP-relative power, W/kg, time-in-zone) are bound
once via a `Profile`, not threaded through each call:

```ts
const bob = Profile.asOf(athleteJson, activity.meta.startTimeUtc);

activity.usingProfile(bob).power();            // PowerSummary (NP/IF/TSS)
activity.usingProfile(bob).byPowerZone();      // PowerZone[]  (per-zone data)
activity.usingProfile(bob).byHeartRateZone();  // ZoneTime[]
activity.usingProfile(bob).byPaceZone();       // ZoneTime[]
activity.usingProfile(bob).bestEfforts();      // PowerEffort[] (+ W/kg)
```

- **Type-safe dependency.** The profile-dependent methods live only on
  `ProfiledActivity`, so you cannot ask for power zones without a profile. `power()`
  returning `undefined` now means exactly one thing — no power was recorded —
  rather than conflating that with "no FTP."
- **`powerZones` (ranges) vs `byPowerZone()` (data).** The zone *ranges* are a
  property of the profile (`bob.powerZones` / `bob.heartRateZones` /
  `bob.paceZones`, each a `ZoneDef`); the per-activity *time-in-zone* is the
  profiled activity's `by…Zone()`.
- **Turtles all the way down.** `usingProfile(bob).splits()` / `.range()` /
  `.laps()` return `ProfiledSection`s carrying the same profile, each exposing the
  same `by…Zone()` / `power()` computed over its own window.

`Profile` is profile-agnostic-by-construction: it carries only athlete data
resolved as-of the activity date, never an activity's evidence — so one `Profile`
is reused across every activity on its date. This keeps the original
"profile-agnostic `Activity`" tenet; it only upgrades "pass raw `ftp`/`ZoneDef`"
to "pass a `Profile`."

## Naming convention (adopted for all new code)

> Spell out domain concepts (`heartRate`, `elevation`, `temperature`, `average`,
> `cadence`). Allowed shortenings: `min`/`max`, standard unit symbols (`km`, `mi`,
> `m`, `ft`, `bpm`, `rpm`, `watts`, `kmh`, `mph`, `kj`), and acronyms (`UTC`). Fix
> stray casing (`heartrate` → `heartRate`). The canonical series columns are full
> words (`lat`/`lng`/`ele`/`hr`/`temp` → `latitude`/`longitude`/`elevation`/
> `heartRate`/`temperature`).

New code here already follows it (`usingProfile`, `byHeartRateZone`,
`heartRateZones`, `powerZones`). The rename of the existing surface (incl. the
column keys and the `avg…`/`…Mps`/`heartrate` metric fields) is a sequenced
follow-up — note it lands mostly on low-level bundles that the demotion makes
internal anyway, so the public bite is small.

## Façade homes still to build (before the demotion)

The functional layer can only be hidden once the façade covers what estela reads
from it today. To build first:

1. ✅ **Quantity formatting (slice 2, done).** Every quantity now renders itself:
   `Distance` / `Elevation` / `Speed` gained `.in(unit)` (dynamic-unit numeric)
   and `.format(unit, decimals?)` (labelled string); `Power` / `HeartRate` /
   `Cadence` gained `.format(decimals?)`; `Duration.format()` / `Pace.format(unit)`
   already existed. They reuse `units.ts` internally (one source of truth), so the
   bare `metersToFeet` / `formatDuration` / `formatPace` and most `convert* +
   *UnitLabel` call sites collapse to `quantity.format(unit)` on migration.
   **Residual** (not absorbed — genuinely app-level): the unit *preference* system
   — `UnitPreferences`, `DEFAULT_UNITS`, the standalone `*UnitLabel` helpers (for
   axis ticks that label once and format many values). That moves to estela (or a
   separate `DisplayPreferences`/`Units` object) in the demotion step — **not**
   onto `Profile`, which is performance parameters resolved as-of the activity
   date, a different axis from a display preference.
2. ✅ **`Track` (slice 3, done).** A value object over a bare `GeoPoint[]` for the
   GPS-only case (a stored route, a map overlay — no activity behind it):
   `Track.of(points)` → `.distance()` / `.bounds()` / `.pointAt(Distance)` /
   `.slice(from, to, { domainTotal? })` / `.cumulativeMeters()`, wrapping the geo
   polyline ops (`polylineCumulative` / `interpolateAtDistance` / `polylineSlice` /
   `boundsOf`). For a track WITH time/channels, `Activity` remains the home.
3. **`windowChannels` as a method** — `activity.range(...).channels()` (or
   `activity.windowChannels(...)`) for chart-zoom rebucketing.

## estela migration (not free — sequenced)

Unlike the namespace curation (PR #289), demotion forces estela off the
functional helpers it uses today: `convertDistance` (6 files), `formatDuration`
(8), `computeActivitySummary` (5), plus `windowChannels`, `hrZoneDistribution`,
`paceZoneDistribution`, `profileAsOf`, and the polyline geo functions. Plan:

1. **(this PR)** Add `Profile` / `usingProfile` / `ProfiledActivity`
   (additive — nothing removed; pond + estela both stay green).
2. Build the façade homes above.
3. Migrate estela onto the façade + `Profile`.
4. Demote the operators from the barrel; apply the no-abbreviation rename.
   **Demote ≠ delete:** the operators retreat to a `@pond-ts/fit/operators`
   sub-path export, still reachable for power users, the finance sibling, and
   estela's own edge cases — the headline is the façade, but the functional core
   stays accessible (the real value behind the old "both first-class" tenet).
5. Publish; swap estela to the npm package and delete its local copy.

### Confirmed façade replacements (for the migration)

- **`computeActivitySummary(imported)` → `Activity.fromStreams(imported).summary()`** —
  verified **deeply equal** for both empty and non-empty activities (the
  empty-streams guard in `computeActivitySummary` produces the same result the
  prepared path does). This is the home for estela's existing 5 call sites **and**
  the new Asset model (`assetFromImported`, which backfills listed metrics via
  `computeActivitySummary`).

## What slice 1 (this PR) delivers

- `Profile` (`profile/index.ts`) — `asOf` (history-aware) + `of` (history-less,
  for a bare FTP/weight fallback) + `ftpWatts` / `weightKg` / `heartRateZones` /
  `paceZones` / `powerZones`. The Coggan power-zone scheme moved
  here as `powerZonesFrom` (its canonical home alongside `hrZonesFrom` /
  `paceZonesFrom`); `power.powerZoneDef` now delegates to it (dedup).
- `Activity.usingProfile(profile)` → `ProfiledActivity`, with `ProfiledSection`
  turtles through `splits` / `range` / `laps`.
- Barrel: `Profile`, `ProfiledActivity`, `ProfiledSection` added. Nothing removed.
- Tests: `test/profiled.test.ts` (10) — power/IF, the three `by…Zone()`, W/kg,
  turtles, and the full-range-vs-whole-activity parity check.

Everything else in the target surface (demotion, rename, the new façade homes,
the estela migration) is **out of scope here** and tracked above.
