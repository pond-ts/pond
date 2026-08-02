# Fixtures — conventions

Every dataset a docs example draws lives here, committed. **The site fetches
nothing at build time and nothing at page load**: a fixture is a `.ts` module
exporting plain arrays or a `TimeSeries`, generated once, offline, and checked
in. That's what makes an example reproducible — the chart you see is the chart
everyone sees, on every visit, forever.

`ride-samples.ts` is the worked example of everything below.

## The header

Every fixture opens with a block comment answering five questions. Not a
formality — a reader who can't tell real data from generated data can't trust
either, and neither can we six months on.

1. **What it is** — in one sentence, in domain terms. "Samples from a real
   ride — Pinehurst loop, 20 July 2016: 1 h 54 m, 36.7 km, 712 m of climbing,
   recorded at 1 Hz by a Garmin head unit with a power meter."
2. **Where it came from, and the licence.** Name the source and link it. US
   government data (NOAA, USGS, EIA) is public domain — say so. CC-BY data
   (Open-Meteo, OpenAQ, Our World in Data) needs the attribution string the
   licence asks for, here _and_ on the page that draws it. Add the retrieval
   date; sources revise history.
3. **What was kept, and what was dropped and why.** "The file also carried GPS,
   speed, distance, cadence and temperature; none is needed here, and the
   position trace is not something to bake into a public fixture." Dropping
   columns is normal; dropping them silently is not.
4. **The quirks that survived on purpose.** Dropouts, zeros, weekends, a sensor
   that coasts. "The 38 `null`s are the recorder's own dropouts (12 of them,
   longest 17 s); they stay in rather than being interpolated, because missing
   data is a thing pond represents and a docs fixture shouldn't pretend
   otherwise." Real texture is the entire reason to use real data.
5. **How it was made** — "Generated once from the .fit file, then committed."
   Point at the generator if there is one (below).

### Modelled data says so, loudly

Where no clean source exists — most web analytics, and market prices, which are
almost universally non-redistributable — the fixture is **modelled**, and the
header's first line says the word. Modelled does not mean a sine wave with
noise on it: model the real _process_, with the weekday/weekend shape, the
diurnal cycle, the bursts, the outage, and the missing samples. Then say
plainly that it's modelled, in the fixture header **and** in the prose of any
page that draws it. Getting caught passing generated data off as measured costs
more credibility than the chart was ever going to earn.

Seed every generator (`mulberry32` in `gallery-fixtures.ts` is the house PRNG)
and never call `Math.random()` or `Date.now()` — SSR and the client have to
produce byte-identical output.

## Size budget

The repo carries these forever, and a browser parses them on every page load.

| Rule                                | Number                                                 |
| ----------------------------------- | ------------------------------------------------------ |
| Per fixture                         | **≤ 25 KB** on disk                                    |
| Per fixture, dense/large-data cards | **≤ 100 KB**, and only when the density _is_ the point |
| All gallery fixtures together       | **≤ 400 KB**                                           |

`ride-samples.ts` (92 KB, 6 857 samples at 1 Hz) predates the budget and is
grandfathered — it's also the reason for it.

Ways to come in under it, in order of preference:

- **Downsample.** A 1 Hz year of tide data is 31 M points; the chart reads
  identically at 6-minute sampling, which is what NOAA publishes anyway. Ask
  what the shape needs, not what the source offers.
- **Shorten the window.** Six weeks of daily bars makes the same point as six
  years, and the reader can actually see the candles.
- **Drop columns.** Keep the ones the chart draws plus the ones the prose
  mentions.
- **Round.** Four significant figures is plenty for a docs chart, and it's a
  large fraction of the file size.

**Numeric arrays: keep them dense.** Prettier explodes a long array to one
value per line, which roughly triples the file. Put `// prettier-ignore` on the
declaration and hand-wrap at ~80 columns:

```ts
// prettier-ignore
export const SAMPLES: readonly number[] = [
  0, 0, 0, 134, 134, 82, 82, 7, 7, 182, …
];
```

## Where generators live

Anything that had to be fetched, decoded, or downsampled to become a fixture
keeps its generator at `website/scripts/fixtures/<name>.mjs` (or `.py` where a
source library is Python-only, as the `@pond-ts/financial` pandas oracle does).
Generators are **run by hand, never by the build** — they print a `.ts` module
to stdout, you redirect it here, you commit the result. Two reasons the script
is worth keeping even though its output is committed: the next revision of the
source data can be re-pulled without reverse-engineering what you did, and the
script is the honest record of the transformation the header describes.

A fixture with no generator (hand-authored, or modelled inline with the house
PRNG) needs no script — `gallery-fixtures.ts` is generated by its own module at
import time and that's fine.

**Raw source data doesn't live here.** A full-resolution capture is an input to
a generator, not something the browser should download: keep it under
`packages/charts/test-data/` (which ships only `dist`, so it never reaches npm)
and downsample it into a module here. `cern-network-traffic.json` — 24 SAPs at
30 s over six hours, 1 MB — is the worked example: the raw file stays there, the
gallery fixture derived from it lives here and obeys the budget above.

## Naming

- `<domain>-fixtures.ts` — the family a track shares
  (`financial-fixtures.ts`, `ride-fixtures.ts`).
- `<name>-samples.ts` — raw sample arrays with no pond types, imported by the
  `-fixtures` module that shapes them (`ride-samples.ts` → `ride-fixtures.ts`).
  Splitting them keeps the 90 KB of numbers out of the file you actually read.
- One module per family, not per chart. A track's four charts share a fixture
  module; that's what makes them read as one dataset.
