# estela · swapping the local fit copy for `@pond-ts/fit` — 2026-10

Handoff for [PND-FITPUB]. `@pond-ts/fit` has published lock-step with the
rest of pond since 0.70.0. The last open item was the export decision, which
is now made and pinned by `packages/fit/test/exports.test.ts`. Nothing below
needs a pond change. If a swap needs one, that is friction to report back.

## What to import instead

| estela's local call                           | From `@pond-ts/fit`                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `geo.simplify(latlng, m)`                     | `Track.of(latlng).simplify(Distance.meters(m)).points`                    |
| `geo.elevationProfile(cum, ele, b)`           | `activity.summary({ profileBucketMeters: b }).channels` → `'elevation'`   |
| `geo.profileByDistance(cum, values, b)`       | the matching `ChannelProfile` in `summary().channels`                     |
| `geo.profileByDistanceWindow(…)`              | `activity.windowChannels({ startMeters, endMeters, … })`                  |
| `geo.rollingSpread(…)`                        | `ChannelSample.bandLo/bandHi/innerLo/innerHi` (or core `rollingByColumn`) |
| `computeActivitySummary(imported)`            | `Activity.fromStreams(imported).summary()` (verified deeply equal)        |
| `convertDistance` / `formatDuration` / labels | unchanged: `units.ts` exports, or `quantity.format(unit)`                 |
| `UnitPreferences`, `DEFAULT_UNITS`            | unchanged: the display-preference home stays in fit, not on `Profile`     |

## Then

Adopt `@pond-ts/charts` from npm in the same pass, drop the local copy and
its overrides, and file anything that did not map cleanly as friction. The
`theme.annotation` override in particular should now be `<Region
role="wash">` ([PND-ANNROLE]).
