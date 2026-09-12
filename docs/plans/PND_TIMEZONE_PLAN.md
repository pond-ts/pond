# PND_TIMEZONE_PLAN — arbitrary time zones on the axis and in the buckets

> Breakout plan for the **Time zones** roadmap section in
> [PLAN.md](../../PLAN.md). Cross-cutting: `pond-ts` (core),
> `@pond-ts/charts`, `@pond-ts/financial`, docs. Design context:
> [trading-calendar.md §3.3](../rfcs/trading-calendar.md) ("rules local,
> instants UTC"), the TZ/DST section of
> [technical-audit-2026-06-v2.md](../notes/technical-audit-2026-06-v2.md), and
> the deferred exchange-/display-tz items previously parked under
> [PND-TCAL] in [PND_FINANCIAL_PLAN.md](PND_FINANCIAL_PLAN.md).

_Opened 2026-09-13._

## The ask

Two things, in priority order:

1. **An arbitrary IANA time zone on the time axis of a chart.** Ticks land on
   that zone's midnights, Mondays, month starts and year starts; labels, grid,
   zebra bands, session dividers and the cursor / tracker readouts all read in
   that zone. Today every one of those is runtime-local, with no knob.
2. **Aggregations in that zone.** `Sequence.calendar(unit, { timeZone })`
   already buckets day / week / month DST-correctly in any zone, in the batch
   path. The gaps are around it: no `quarter` / `year`, no unit validation, the
   live path rejects calendar sequences outright, the zone is unrecoverable from
   the output, and the docs contradict the code on the default.

The two halves must agree: the boundary that `aggregate` used for a Berlin day
and the tick that labels it on the axis have to be the same instant, computed
by the same code. That is the organising decision below.

## What exists today (verified 2026-09-13)

**Core.**

- `Sequence.calendar(unit, { timeZone?, weekStartsOn? })` —
  `packages/core/src/sequence/sequence.ts:119`. Zone defaults to **`'UTC'`**,
  never runtime-local (`core/calendar.ts:17-19`). Boundaries via Temporal
  `ZonedDateTime.startOfDay()` per step, so 23 h / 25 h days fall out
  correctly (spring-forward pinned in `test/Sequence.test.ts:153-179`; the
  audit's three-zone probe passed 2 178/2 178).
- `CalendarUnit = 'day' | 'week' | 'month'` only. **No runtime validation**:
  the two unit dispatchers have mismatched fallbacks, so
  `Sequence.calendar('hour')` silently yields garbage (audit v2 §6).
- `Sequence.every` / `hourly` / `daily` take `{ anchor }` only — absolute ms,
  no zone. `Duration` units stop at `d` = 86 400 000 ms.
- `parse.timeZone` on `fromJSON` / `pushJson` / `Time.parse` /
  `TimeRange.fromDate` etc. — wall-clock strings resolve in the zone, default
  UTC. `website/docs/pond-ts/creating.mdx:210,240,641` says a bare wall-clock
  string **throws** without it. It does not; it defaults to UTC.
- `Time`, `TimeRange`, `Interval` carry no zone; bucket keys are the numeric
  start ms (`sequence.ts:250,303`). A series bucketed in `America/New_York` is
  indistinguishable from a UTC one downstream. `Sequence.timeZone()` exists
  (`sequence.ts:152`) but nothing downstream reads it.
- **Live path rejects calendar sequences**: `LiveAggregation` calls
  `stepMs()` / `anchor()` unconditionally (`live/live-aggregation.ts:96-97`,
  throws from `sequence.ts:134/144`); `Trigger.clock` refuses explicitly
  (`live/triggers.ts:105-110`); `LiveRollingAggregation` same constraint.
- No `Date` local-time methods and no `Intl` anywhere in core. Zero runtime-TZ
  dependence. `@js-temporal/polyfill` is the package's only runtime dependency,
  imported statically by `core/calendar.ts:1`.

**Charts.**

- **No `timeZone` anywhere** in `packages/charts/src` (grep: zero hits).
- Every time axis (continuous and trading) is `scaleTradingTime`
  (`ChartContainer.tsx:2095,2111`); a private d3 `scaleTime()` exists only to
  format (`tradingTimeScale.ts:273`, nine `base.tickFormat` sites).
  d3-time-format is **local-time only**; no `scaleUtc` path, no `Intl`.
- Tick grain, alignment, bands and the identity provider all use
  `Date.getFullYear/Month/Date/Day` — `tickLadder.ts` `bucketKey:107`,
  `alignedToGrain:527`, `nextAligned:568`, `daysInLocalMonth:163`,
  `subdivideMonthsByDay:220`, `subdivideMonthsBySession:281`,
  `bandShaded:857`, `bandStartOf:876`, `bandNext:886`;
  `tradingTimeScale.ts` `identityProvider:239` ("every **local** midnight is a
  session open"). `bucketKey`'s own docstring names exchange-tz grain as "the
  deferred refinement".
- Two format channels, `timeFormat` (labels) and `cursorFormat` (readouts),
  both d3 specifier strings or `(ms) => string` functions
  (`format.ts:44-158`, `ChartContainer.tsx:1920-2127`, context
  `context.ts:298-330`). No theme-level time tokens.
- Tests derive local-calendar expectations directly in ~40 places
  (`tickLadder.test.ts`, `tradingTimeScale.test.ts`, …); the e2e suite pins
  Playwright `timezoneId: 'UTC'`. PR #721 (open) adds a
  `TZ=Australia/Sydney` CI leg; `main` has no TZ matrix yet.

**Financial.**

- `SessionRules.timeZone` (`calendar/rules.ts:22`) is the only zone in the
  package; `fromRules` resolves wall-clock sessions per day via Temporal and
  then **discards the zone** — `TradingCalendar` has no `timeZone` accessor.
  The chart's `DiscontinuityProvider` boundary therefore never learns the
  exchange zone, which is exactly why the trading axis buckets its grain
  runtime-locally.
- Daily bars are keyed to the session `[open, close)`, not midnight
  (`trading-calendar.ts:174-186`) — a zone on the axis changes how those bars
  are _labelled_, not where they sit.

**Consumers and friction.** Tidal is the one named consumer: the
`dailyTime` day-floor workaround (RFC §612), the F-charts-7 `02 AM` pill on
`America/New_York` daily bars (fixed by the grain-aware readout, #485, with
"timezone control is the deferred follow-on" recorded), the exchange-tz tick
grain. `website/src/examples/lib/tracker-readout.tsx:43` hard-codes an
`Intl.DateTimeFormat(…, { timeZone: 'America/New_York' })` because the readout
has no zone knob, and Track D declined to reuse it on a German grid chart.
Prior-art shapes: Grafana (dashboard zone: browser / UTC / named), Highcharts
`time.timezone`, TradingView's chart zone — all a **single named zone per
view**, viewer-local by default, with instants untouched underneath.

## Design decisions

1. **Instants stay UTC ms. A zone is a parameter, never state on a value.**
   `Time` / `TimeRange` / `Interval` / events do not grow a zone field. The zone
   lives on the thing that _interprets_ instants: a `Sequence`, a formatter, a
   chart container. Consistent with RFC §3.3 and with how every prior-art
   library above works; it also keeps `TimeSeries` variance ([PND-TSVAR])
   untouched.
2. **One implementation of zone arithmetic, in core, consumed by charts.**
   Core already has correct Temporal zone math in `core/calendar.ts`; charts
   has a second, local-only calendar written in `Date` methods. Growing a
   third (an `Intl.formatToParts` calendar inside charts) would give the axis
   and the aggregate different answers on the DST divergence weeks. Core
   exposes a small public primitive ([PND-TZCAL]); `Sequence.calendar` moves
   onto it internally (no behaviour change); charts threads it through the
   ladder ([PND-TZAXIS]). Charts already peers on `pond-ts`, so the Temporal
   polyfill is a sunk cost for every charts consumer.
3. **Defaults do not move.** Core calendar sequences stay **UTC** by default
   (deterministic, documented, what every test and Tidal's monthly rollups
   encode). Charts stay **runtime-local** by default (what a viewer expects,
   what every screenshot and local-calendar test encodes). Both become
   explicit opt-ins to a named zone through the same option name,
   **`timeZone`** — already the name on `TimeZoneOptions`, `parse.timeZone`
   and `SessionRules.timeZone`. The asymmetry is documented once, loudly, in
   the docs task rather than papered over with a shared default.
4. **The charts default path is bit-for-bit today's code.** The zone-aware
   ladder is introduced behind a two-implementation seam: a `local` calendar
   backed by the existing `Date` methods (the default when `timeZone` is
   unset) and a `zoned` calendar backed by the core primitive. This keeps the
   ~40 local-calendar test assertions and the 74 e2e baselines valid without
   edits, isolates the perf question to the opt-in path, and lets the local
   implementation be collapsed onto the zoned one later, measured, if it earns
   it.
5. **The d3 specifier vocabulary stays the formatting API.** `timeFormat`,
   `cursorFormat` and `<XAxis format>` keep accepting the same strings.
   Zoned rendering applies `utcFormat(spec)` to a civil-shifted `Date`
   (`Date.UTC(zone-local parts)`), which makes every `%Y %m %d %H %M %S %a %b
%p …` directive read in the zone for free; `%Z` / `%z` are special-cased to
   the zone's abbreviation / offset via `Intl` because the shifted date would
   print `+0000`. Function formatters `(ms) => string` are unchanged and can
   read the resolved zone from context.
6. **The trading axis inherits the exchange zone.** `TradingCalendarLike`
   gains an optional `timeZone?: string`; `TradingCalendar.fromRules` keeps
   `rules.timeZone` and exposes it. When the container has a `calendar` with a
   zone and no explicit `timeZone` prop, the axis renders in the exchange
   zone. An explicit prop always wins (the "display-tz vs exchange-tz" split
   the F-charts-7 note asked for). This closes two of [PND-TCAL]'s four items.
7. **Ambiguous and skipped wall times resolve `'compatible'`** (Temporal's
   default: a skipped 02:30 moves forward, a repeated 01:30 takes the first).
   Documented, tested, not configurable — no consumer has asked, and the
   sub-day grid work that would need it is Phase 2.

## Tasks

### Phase 1 — the ask

#### [PND-TZCAL] — core: a public zone-calendar primitive, `quarter` / `year`, unit validation

**In review as [#728](https://github.com/pond-ts/pond/pull/728) (opened
2026-09-13).** Landed as designed, with three decisions made in the build:
the name is `TimeZone` (not `Zone` / `ZoneCalendar` — it reads as the noun
`Sequence.calendar` and the charts' `timeZone` prop already use, and the
collision with `Temporal.TimeZone` is moot since Temporal removed that class);
`abbreviation(t, { locale })` takes a locale because `Intl` short names are a
locale question (`en-US` knows `EST` but reports Sydney as `GMT+11`; `en-AU`
the reverse) — pretending one locale is neutral would have baked a US-centric
`%Z` into the axis; and the offset-transition cache is a sorted array of
half-open segments discovered via `getTimeZoneTransition`, with a
last-hit fast path. Measured (before = v0.68.0 dist): `startOf('day')`
~24 µs → ~23 ns per call warm; a three-year hourly series to New York days
37.96 ms → 0.54 ms; Lord Howe 39.21 ms → 0.19 ms. Pinned against Temporal on
eight zones including a day with no midnight (São Paulo 2018) and a skipped
day (Apia 2011). Not done here: the lazy polyfill import (parked below).

**Scope.** Export one small object that answers every zone question the
library and the axis need, implemented on the existing Temporal helpers in
`core/calendar.ts` with a per-zone **offset-transition cache** (IANA offsets
change at most a handful of times a year; once the transitions bracketing an
instant are known, `startOfDay` / `parts` are integer arithmetic, so the tick
ladder never pays Temporal per call in steady state). Working name
`TimeZone`; the name is a PR-time decision (candidates: `TimeZone`, `Zone`,
`ZoneCalendar` — avoid `Calendar`, which collides with `Sequence.calendar` and
`TradingCalendar`).

Surface (tentative):

```ts
const tz = TimeZone.of('Europe/Berlin'); // also TimeZone.UTC, TimeZone.local()
tz.id; // 'Europe/Berlin'
tz.offsetAt(ms); // minutes east of UTC at that instant
tz.parts(ms); // { year, month, day, hour, minute, second, millisecond, weekday }
tz.instant(parts, { disambiguation: 'compatible' }); // ms
tz.startOf('day' | 'week' | 'month' | 'quarter' | 'year', ms, { weekStartsOn });
tz.next(unit, ms); // first instant of the following unit
tz.abbreviation(ms); // 'CEST' — for %Z
```

Also in this task:

- `CalendarUnit` gains `'quarter'` and `'year'` (the axis ladder already has
  both grains; zone-correct yearly / quarterly rollups are unrepresentable as
  fixed steps). `Sequence.calendar` throws `RangeError` on any unknown unit —
  closes the audit v2 §6 finding and the [PND-AUDIT] #118 item.
- `Sequence.calendar`'s `toPlainDateStart` / `nextCalendarStart` walk moves
  onto the primitive. **No behaviour change** for existing units — pin with the
  existing tests plus the new ones in [PND-TZTEST] before the swap.
- API.md rows: new export; `Sequence` row says "calendar buckets in an IANA
  zone (default UTC)".

**Perf check applies** (new code on a per-bucket path): analytical cost
(O(1) amortised per query after the transition cache warms; O(log T) bisection
on a cold zone), `scripts/perf-timezone.mjs` covering `startOf('day')` over
100 k instants in `UTC`, `America/New_York`, `Australia/Lord_Howe` (+10:30 /
+11, 30-minute DST shift) against the current Temporal-per-call path, and a
before/after table on `perf-aggregate.mjs`'s calendar scenario.

**Human gate.** New public export and a widened `CalendarUnit` union — both
additive, but `CalendarUnit` appears in user-facing signatures. Ask before
merging.

#### [PND-TZAXIS] — charts: `timeZone` on `ChartContainer`, zone-aware ladder, labels and readouts

**In review as [#732](https://github.com/pond-ts/pond/pull/732) (opened
2026-09-13), one PR rather than three — the seam, the formatting and the
prop each stayed small enough.** Held to decisions 3–5: the local path is
the pre-seam `Date` arithmetic verbatim behind a `TickCalendar` interface
(six calendar ops plus `nextAligned`), zoned formatting is `utcFormat` on a
civil-shifted date with `%Z` / `%z` substituted, defaults unchanged. One
thing the build settled beyond the plan: **sub-day alignment is a calendar
operation** — the local calendar keeps its documented fixed-ms drift across
a DST day, the zoned one aligns to the wall clock (00 / 06 / 12 / 18 on both
sides of the jump), which is the behaviour the plan promised and the first
cut did not deliver until `stepAnchors` re-aligned each anchor through the
calendar instead of `t += step`. Measured: a warm zoned ladder frame is at
or below the local one at 30 d / 365 d / 3650 d domains; a cold first frame
is 1–4 ms. The cross-package agreement test ([PND-TZTEST]'s item) landed
here. Baselines for the two zoned e2e stories are CI-generated.

**Scope.** `ChartContainer` gains `timeZone?: string` (undefined = runtime
local, `'UTC'` or any IANA id otherwise). The resolved zone flows through the
existing `useMemo` at `ChartContainer.tsx:1920` into `scaleTradingTime(provider,
{ timeZone })` and onto `ChartContext` next to `formatTime` / `formatReadout`,
so every consumer of those (axis ticks, grid levels, zebra bands, session
dividers, crosshair and in-plot readouts, annotation auto-labels, tracker
pills) follows with no per-component prop.

Work items, in landing order (three PRs, or one if the middle one stays
small):

1. **The calendar seam in the ladder.** Define a `TickCalendar` interface
   covering exactly the operations the nine local-calendar helpers use
   (`startOfDay`, `startOfWeek`, `startOfMonth`, `addDays`, `addMonths`,
   `parts`, `daysInMonth`, `dayParity`), with `localTickCalendar` (today's
   `Date` code, verbatim) and `zonedTickCalendar(TimeZone)` implementations.
   Thread it through `bucketKey`, `alignedToGrain`, `nextAligned`,
   `daysInLocalMonth`, `subdivideMonthsByDay`, `subdivideMonthsBySession`,
   `bandShaded`, `bandStartOf`, `bandNext` and `identityProvider`. Sub-day
   anchors become zone-local-midnight + k·step, so a 6 h grid reads 00 / 06 /
   12 / 18 in the zone across a DST day (one 5 h or 7 h gap, once), instead of
   drifting by an hour for six months. Zebra parity stays pan/zoom-stable
   because it keys on the zone-local day / month ordinal, not the instant.
   Default path unchanged; existing tests untouched.
2. **Zoned formatting.** `format.ts` and the nine `base.tickFormat` sites
   route through one `makeTimeFormatter(spec, timeZone)`: `timeFormat` when
   the zone is local (unchanged), `utcFormat` on the civil-shifted `Date`
   otherwise, `%Z` / `%z` rewritten from `TimeZone.abbreviation` /
   `offsetAt`. `resolveTimeFormat` / `resolveAxisFormat` take the zone.
   Context exposes `timeZone` so function formatters can honour it.
3. **The prop, the trading-axis default and the docs.** `ChartContainer
timeZone`, `TradingCalendarLike.timeZone?` (optional — additive),
   container resolves `timeZone ?? calendar?.timeZone ?? local`. API.md rows
   for `ChartContainer` and `XAxis`. Storybook feature-axis group
   `Axes/TimeAxis/TimeZone` with a story per state: `Local`, `UTC`,
   `NewYork`, `Sydney` (southern-hemisphere DST), `Kolkata` (half-hour
   offset), `FromCalendar`, `CursorReadout`, `StackedBands`; all on
   `defaultTheme`. One zoned story joins the e2e baselines (Playwright's UTC
   pin makes it deterministic).

**Not in scope here.** A per-`<XAxis>` zone override (belongs with
[PND-XAXISOWN], where a mounted axis learns to win over the container at all);
a `'local'` sentinel string (undefined already means local; add the sentinel
only if a consumer needs to _reset_ an inherited zone); a theme token.

**Perf check applies.** The ladder runs per pan/zoom frame. Bench the zoned
path against local on the existing tick-ladder timings (a
`scripts/perf-tickladder.mjs` if none exists) at 1 k / 10 k boundaries; the
budget is "indistinguishable from local" once the transition cache is warm.
If Temporal cold-start on a fresh zone shows in first paint, warm the cache
for the visible domain in the same memo.

**Tests.** Every new assertion derives its expected text through the same
`TimeZone` it renders with — never a hardcoded literal (the #721 lesson,
which also found an assertion passing for the wrong reason). Fixtures:
`America/New_York` spring-forward and fall-back days on a 6 h and a daily
grain; `Australia/Sydney` October / April; `Asia/Kolkata`; a month boundary
that is a different day in the zone and in UTC (the F-charts-7 shape);
readout precedence on a TIME axis in a zone; `%Z` renders `CEST` / `AEDT`.

**Human gate.** New `ChartContainer` prop and a widened `TradingCalendarLike`
interface — additive. Ask before merging per the "adds a method / prop to the
React hook surface" rule.

#### [PND-TZFIN] — financial: `TradingCalendar` keeps its zone

`fromRules` stores `rules.timeZone`; `TradingCalendar` exposes `timeZone:
string | undefined` (undefined for explicit-list calendars built without one;
the constructor gains an optional `timeZone` for that path). Satisfies the
widened `TradingCalendarLike` so `<ChartContainer calendar={cal}>` renders in
the exchange zone with no further wiring. Trivial; may ride in the
[PND-TZAXIS] PR 3 if the review prefers one diff. Closes the "exchange-tz
tick grain" and "cursor timezone control" items of [PND-TCAL]; the remaining
two (point-key slot widths, overnight sessions) stay there.

#### [PND-TZTEST] — tests and CI for zone correctness

- **Land the CI matrix.** Merge #721's `TZ=Australia/Sydney` leg on the
  `24.x` job (the PR is review-complete; it is the matrix the audit asked
  for). Keep the rule it records: no `TZ` pin in any vitest config.
- **Core gaps** (all currently untested): fall-back 25 h day for `'day'` and
  `'week'`; half-hour zone (`Asia/Kolkata`) and 30-minute-DST zone
  (`Australia/Lord_Howe`); southern-hemisphere `'month'` across October;
  `aggregate`, `align`, `materialize` over a **non-UTC** calendar sequence
  (today every aggregate test passes `timeZone: 'UTC'`); `weekStartsOn` in a
  zone where Monday 00:00 local is Sunday UTC; `'quarter'` / `'year'` in a
  zone; `Sequence.calendar('hour')` throws.
- **Cross-package agreement test.** One test in charts asserts that the tick
  instants `zonedTickCalendar` places for `'day'` over a DST month equal the
  bucket starts `Sequence.calendar('day', { timeZone })` emits for the same
  range — the contract of design decision 2, pinned executable.
- **Test helper.** A shared `expectedLabel(ms, spec, timeZone)` in charts'
  test utils that formats via the same path the renderer uses, so the
  derive-don't-pin discipline has a one-liner.

#### [PND-TZDOCS] — docs: state the contract once, fix the contradiction

- `website/docs/pond-ts/creating.mdx:205-247, 637-652`: a bare wall-clock
  string **defaults to UTC**; it does not throw. Rewrite the pitfall as "you
  probably meant a zone, and here is how you would notice" (the air-quality
  guide's "pin the timezone where the text becomes an epoch" rule is the
  model). Decision recorded here: keep default-UTC rather than start throwing
  — throwing is a breaking change nobody asked for, and a UTC default is at
  least deterministic across machines.
- New section on `website/docs/charts/axes/index.mdx`, "Time zones": the
  default is the viewer's zone; `timeZone` sets a named one; the trading axis
  follows its calendar; the one idiom that keeps aggregate and axis aligned:

  ```ts
  const timeZone = 'Europe/Berlin';
  const daily = series.aggregate(Sequence.calendar('day', { timeZone }), { kwh: 'sum' });
  <ChartContainer timeZone={timeZone} …>
  ```

  Plus the asymmetry of defaults (core UTC, charts local) and why.

- `website/docs/pond-ts/concepts/sequences.mdx`: `quarter` / `year`, the
  throw on unknown units.
- `website/src/examples/lib/tracker-readout.tsx`: replace the hard-coded New
  York `Intl` formatter with the container's zone (or a `time` formatter prop
  defaulting to it), which un-blocks the Track D reuse noted in
  [PND_CHARTS_PLAN.md](PND_CHARTS_PLAN.md).
- `docs/agents/USING_POND.md`, `AGENTS.md`, `llms.txt`: one rule — "pass the
  same `timeZone` to `Sequence.calendar` and to `ChartContainer`".
- Land #359 (cross-link `Sequence.calendar` from the aggregate examples —
  issue #358 item 1) in the same sweep.
- API.md rows are owned by the code PRs above; this task is the prose.

### Phase 2 — consumer-gated

Named here so the design is on record; none starts without a consumer
asking, per the road-to-1.0 rule that discovery work waits for signal.

#### [PND-TZLIVE] — calendar sequences on the live path

`LiveAggregation`, `LiveRollingAggregation` and `Trigger.clock` accept a
calendar sequence: bucket-of(ts) = `tz.startOf(unit, ts)`, next boundary =
`tz.next(unit, ts)`, in place of the `floor((ts − anchor) / step)` arithmetic.
The use case is a live dashboard's "today so far, in Berlin" tile; the
current failure is a `TypeError` from `stepMs()`. Likely the first Phase 2
item to earn its way in — the gRPC / dashboard experiments are the probable
source of the signal. Watch for: a DST fall-back bucket that is 25 h long must
not be split by a clock trigger that assumed a fixed period.

#### [PND-TZFLOW] — the zone flows from the sequence to the output

Today the result of `aggregate(Sequence.calendar('day', { timeZone: 'X' }))`
does not know it was bucketed in `X`. Two candidate mechanisms, neither
adopted yet: (a) the library-built `interval` column def carries
`timeZone?` (and the unit), which `ChartContainer` could read as a default
when no `timeZone` prop is given; (b) an opt-in `series.timeZone()` hint
set by `aggregate` / `align` / `materialize`. (a) keeps the fact next to the
key it describes but touches the schema types; (b) is simpler but is exactly
the kind of instance state decision 1 rules out unless it is clearly a hint.
Phase 1's contract is "pass the zone to both"; this task exists so that
contract can be relaxed deliberately rather than by accident.

#### [PND-TZDAYGRID] — sub-day grids anchored to zone-local midnight

`Sequence.calendar('hour', { timeZone, every: 6 })` (or `Sequence.every('6h',
{ timeZone })`): boundaries at wall-clock 00:00 + k·step within each
zone-local day, step dividing 24 h, resolved `'compatible'` across DST (one
5 h / 7 h bucket per transition). pandas keeps sub-day offsets fixed and only
`'D'` and up calendar-aware; TradingView / Grafana align intraday bars to the
local day. Financial's `barSequence` already covers the exchange-session case,
which is why this waits.

#### Also parked

- `'local'` sentinel and per-`<XAxis>` zone (with [PND-XAXISOWN]).
- Lazy-loading `@js-temporal/polyfill` behind the first zone call, and a
  native-`Temporal` fast path once V8 ships it unflagged — a bundle-size item
  for [PND-AUDIT] #108, listed here because [PND-TZCAL] is where the import
  would move.
- `TimeRange.toString()` / `Interval.asString()` in a zone — no consumer;
  `Time.parse` already takes the zone on the way in.

## Sequencing and size

| Order | Task           | Size             | Depends on               |
| ----- | -------------- | ---------------- | ------------------------ |
| 1     | [PND-TZCAL]    | in review (#728) | —                        |
| 2     | [PND-TZAXIS] 1 | in review (#732) | TZCAL                    |
| 3     | [PND-TZAXIS] 2 | in #732          | TZAXIS 1                 |
| 4     | [PND-TZFIN]    | hours            | —                        |
| 5     | [PND-TZAXIS] 3 | in #732          | TZAXIS 2, TZFIN          |
| 6     | [PND-TZTEST]   | ~1 day           | TZCAL, TZAXIS (parallel) |
| 7     | [PND-TZDOCS]   | ~1 day           | all of the above         |

Phase 1 is roughly one and a half weeks of focused work, five to six PRs, two
human gates (TZCAL's export + `CalendarUnit`; TZAXIS's prop). Each code PR
gets Layer 2 review; TZCAL and TZAXIS 1 should expect **medium** confidence
(DST arithmetic, a refactor across ~10 helpers) and a Codex pass.

## Risks

- **Temporal polyfill cost in a per-frame path.** Mitigated by the transition
  cache and by keeping the local default off Temporal entirely; measured, not
  assumed — the perf check is part of both TZCAL and TZAXIS.
- **d3 `%Z` / `%z`.** The civil-shift trick prints `+0000`; the special case
  must cover both directives and their use inside longer specifiers.
- **Southern hemisphere and non-hour offsets** are where hand-rolled zone code
  usually breaks (DST in October, `+10:30`). They are in the fixtures for
  that reason.
- **Test debt in charts.** ~40 assertions compute local-calendar expectations
  inline. They stay valid because the default path is unchanged, but any later
  collapse of `localTickCalendar` onto the zoned implementation must convert
  them to the shared helper first.
- **Two defaults.** Core UTC, charts local is the right pair and also a trap
  for the unwary; the docs task carries the weight. If cold-start agents keep
  tripping on it ([PND-COLDSTART] runs), revisit — with data, not by fiat.

## Decisions log

- **2026-09-13 — plan opened.** Zone is a parameter, not value state; one
  implementation in core, consumed by charts; defaults unchanged (core UTC,
  charts local); d3 specifiers stay the format API via `utcFormat` on a
  civil-shifted date; trading axis inherits the exchange zone with an explicit
  prop winning; `'compatible'` disambiguation; sub-day zone grids, live-path
  calendar sequences and zone-on-output are Phase 2 pending a consumer.
  Alternatives considered and not taken: an `Intl.formatToParts` calendar
  inside charts (second implementation, divergence risk); switching charts'
  default to UTC (breaks every viewer's expectation and every baseline);
  making a bare wall-clock string throw (breaking, unasked); a theme token
  for the zone (a zone is data about the view, not a look).
