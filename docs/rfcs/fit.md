# Activity analytics (`@pond-ts/fit`)

**Status:** planning note. Adopted from the estela experiment's reframe
proposal (`geo.md` §12), 2026-06-15.

**Relationship to PLAN.md:** This RFC is strategic context, not a commitment.
[PLAN.md](../../PLAN.md) is the binding source of truth; items adopted into
PLAN are commitments, the rest is forward-looking. See
[CLAUDE.md → Strategic RFCs](../../CLAUDE.md) for the layering.

**Authorship:** pjm17971 + pond-ts library agent (Claude), adopting the
**estela experiment agent (Claude)** proposal in [geo.md](geo.md) §12. This is
the umbrella; [geo.md](geo.md) is the first module RFC under it.

**Audience:** the estela experiment agent and pond-ts contributors building the
activity-analytics layer.

**Thesis:** `@pond-ts/fit` is an activity-analytics library on pond's **public
surface** — FIT / GPX / TCX in, the Strava-class metric suite out — with
**geo** as its first module. It is the reframe of what started as
`@pond-ts/geo`: two estela milestones showed the category is **activity-file
analysis, not space**. M1 was geo (distance, elevation, splits); M2 went
straight into **power** (normalized power, FTP zones, the mean-maximal curve,
work, TSS) — none of it geospatial. geo is one module among several. pond core
stays the timeseries substrate; `fit` is the domain layer; the only thing the
experiment asks of _core_ is one **general** primitive (`byColumn`).

## The three layers

- **pond core** — the timeseries substrate. The experiment's single core ask is
  `byColumn` value-axis aggregation — general, not fitness-specific (see the
  friction split below and [geo.md §13](geo.md)).
- **`@pond-ts/fit`** — activity analytics on pond's public surface. Modules:
  **geo** ([geo.md](geo.md) — distance / elevation / simplify / bbox), **power**
  (NP, FTP zones, mean-maximal curve, work, TSS — from estela M2), and later
  hr / pace / splits / segments, plus FIT/GPX/TCX parsing.
- **estela** — the first consumer: _"Strava, as an API"_ — headless and
  **files-first** (analytics on the user's _own_ FIT/GPX exports, which is what
  keeps it clean vs Strava's API terms).

## Modules

| Module  | Status                                                       | Doc                          |
| ------- | ------------------------------------------------------------ | ---------------------------- |
| `geo`   | v0 validated in estela M1 (123 km ride, vs-Strava)           | [geo.md](geo.md)             |
| `power` | validated in estela M2 (power-meter FIT, exact zones / work) | _(power.md, when extracted)_ |

## Friction split — core-bound vs fit-bound

The estela friction ([geo.md](geo.md) §10–§13; estela's `docs/pond-friction.md`)
divides cleanly:

- **core-bound** (land in pond): `byColumn` value-axis aggregation (the
  headline — confirmed ×3); `withColumn` / `fromTrustedColumns` (double-signalled
  with the chart carry-forwards, [#107]); `RowForSchema` honoring
  `required: false` (the known greenfield F4 / ARCHITECTURE §4 limitation);
  the `'mean'` → `'avg'` reducer alias.
- **fit-bound** (land in `@pond-ts/fit`): the geo + power operators / reducers
  themselves.

## Column-kind extensibility — unaffected

[geo.md §7](geo.md)'s caution stands: `fit` is all operators over `number`
columns, **no new column kind**. estela M1's data point — a packed geo column
earns _nothing_ on perf at GPS-track scale (the two-`number`-column model runs
the spatial hot path in <0.3 ms on 15k points) — is the first concrete evidence
_against_ opening the kind system for this domain.

## Build + sequencing

estela builds geo + power inside its own `core` and extracts them into
`@pond-ts/fit` once the API stabilizes — friction-driven, not up front. On the
pond side, the core-bound asks land **after** the in-flight NaN-policy → rolling
sequence; `byColumn` + `withColumn` are the next core wave after that. estela
keeps its (fast) hand-rolled value-axis walks until `byColumn` lands — they're
an expressiveness gap, not a perf one.
