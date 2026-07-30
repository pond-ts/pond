# Agent workloads: personas, questions, and the benchmark that has to answer them

**Purpose.** Decide where pond is defensible by measuring the questions
practitioners actually ask, composed the way an agent would compose them —
not by op-by-op timings, which implicitly concede that throughput is the
deciding axis.

**Acceptance gate:** a question answered in **< 100 ms** over a
**500k–1M point** working set, warm, single process. Below that a person
experiences an answer; above it they experience a query.

**Scope note.** The data shapes below are distilled to **vendor-neutral
generic types** from a real derivatives-analytics catalog. No vendor,
product, dataset or column names appear here by design.

---

## 1. The generic data shapes

Six shapes cover the catalog, and they are not all time series in pond's
current sense. That is the interesting part.

| #      | Shape                           | Grain                       | Notes                                                                                                    |
| ------ | ------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| **S1** | **Wide term structure**         | symbol × date × session     | ~12 fixed tenors as _column families_ (`atm_21d`, `slope_21d`, …). One row is a whole term structure.    |
| **S2** | **Tall measure history**        | symbol × **measure** × date | The measure is a _row dimension_. Needs a **pivot** before it looks like S1.                             |
| **S3** | **Per-expiry surface snapshot** | expiry × date               | Carries a **skew curve as discrete points** across moneyness — a _value-axis_ series, not a time series. |
| **S4** | **Intraday bars**               | symbol-or-expiry × minute   | The volume shape: 1M+ rows for a few weeks.                                                              |
| **S5** | **Prints / trades**             | tick                        | Irregular, bursty, needs bucketing before anything else.                                                 |
| **S6** | **Reference / calendar**        | symbol or date              | Trading calendar, market hours, earnings and dividend dates. Joins and annotations.                      |

Three properties of this catalog matter more than the shapes themselves:

- **Session is a key dimension, not a filter.** A naive query over S1/S3
  returns several rows per date. Any question is wrong unless a session
  is pinned or grouped.
- **Tall and wide coexist.** S2 must be pivoted to be comparable with
  S1. One adapter does not fit both.
- **The most valuable object is 2-D.** A surface is time × tenor (S1) or
  time × moneyness (S3). pond's key is 1-D.

## 2. Personas

| P      | Who               | What they are optimising                  | Time budget                   |
| ------ | ----------------- | ----------------------------------------- | ----------------------------- |
| **P1** | Volatility trader | Is the surface mispriced _right now_?     | seconds; many small questions |
| **P2** | Quant researcher  | Does this signal survive?                 | minutes; few large questions  |
| **P3** | Risk manager      | What breaks, and when did it start?       | seconds; threshold-shaped     |
| **P4** | Derivatives PM    | What drove the P&L?                       | minutes; attribution-shaped   |
| **P5** | Execution / TCA   | Did we trade well against a benchmark?    | seconds; join-heavy           |
| **P6** | Platform engineer | **Should we use this library or polars?** | the whole evaluation          |

P6 is not a joke. That persona reads the benchmark page, runs one
command, and decides. Everything here is ultimately aimed at them.

## 3. The questions

Each is written as an agent would receive it, with the plan an agent
would compose, what it stresses, and whether pond can do it today.

### Q1 — "Is 21-day implied vol rich or cheap versus its own history?" (P1)

```
in: wide(symbol, session=Regular) → pick atm_21d
  → zScore{period:252} → last                       → fact
  → percentileRank{of: atm_21d, window: 504}        → fact
```

**Stresses:** single-series rolling + two folds. **Status:** ✅ shipped,
fast. This is the benchmarked path.

### Q2 — "Show me the term structure today, and how it moved this week." (P1)

```
in: wide(symbol, session) → row@today → unpivot 12 tenor columns → ValueSeries(tenor)
  ⋈ row@today-5d → same
  → difference per tenor                            → 2 curves + delta
```

**Stresses:** **wide-row → value axis**, a 12-point series keyed by
tenor, then a pairwise difference. **Status:** ⚠️ `byValue` exists;
_unpivoting a wide row into a value-axis series has no operator._

### Q3 — "Which of my 500 names have the steepest skew right now?" (P2/P1)

```
in: surface(all symbols, date=today, session) → skew points D..U
  → slope per symbol (fit or endpoint difference)
  → rank across symbols → top 20                    → table
```

**Stresses:** **cross-sectional** — 500 symbols × 1 date, a per-symbol
reduce then a rank _across_ series. **Status:** ⚠️ `partitionBy` exists;
cross-sectional rank across partitions is unmeasured and probably
unbuilt.

### Q4 — "Is realized vol diverging from implied, and since when?" (P1/P3)

```
in: tall(symbol, measures=[cc, iv63]) → PIVOT measure → columns
  → align(daily grid) → spread = iv63 − cc
  → zScore{period:63} → crossings{above: 2}         → dated events
```

**Stresses:** **tall→wide pivot**, then join, spread, rolling, and a
**discretising** terminal. **Status:** ❌ no pivot operator. And the
crossing is `D`-class over a `B` input — the RFC's exact hazard.

### Q5 — "What did the surface look like the day before each earnings?" (P2)

```
in: reference(earnings dates for symbol)
  → as-of join onto wide(symbol) at date−1
  → collect term structures                          → N curves
```

**Stresses:** **event-driven as-of lookup** — irregular keys against a
dense series. **Status:** ⚠️ `align`+hold approximates; a true as-of
join against an event list is the missing primitive.

### Q6 — "Bucket the last month of prints by size and show where volume traded." (P5)

```
in: prints(symbol, 1mo) → byColumn(price, {width}) → {vol: sum, n: count}
  → histogram                                        → bars
```

**Stresses:** **value-domain binning** at tick scale. **Status:** ✅
`byColumn` exists and explicitly supports non-monotonic sources. Volume
profile works today. Unmeasured at 1M+ prints.

### Q7 — "Roll these ticks to 1-minute, then to daily, and show the gaps." (P5/P6)

```
in: prints → aggregate(1m, OHLCV) → aggregate(1d, OHLCV)
  → against tradingCalendar → missing sessions       → fact + series
```

**Stresses:** **two-stage aggregation** plus a **calendar** join.
**Status:** ✅ both shipped; the calendar engine is a genuine
differentiator (polars has nothing equivalent).

### Q8 — "How correlated are these two names' vols over 60 days?" (P2/P4)

```
in: wide(A) ⋈ align ⋈ wide(B) → rolling bivariate moments{60}
  → correlation                                      → series + last
```

**Stresses:** **two-series align + join + K8**. **Status:** ❌ K8
unbuilt, and **`U`-class** per the numerical RFC — correlation divides
by a product of two σ.

### Q9 — "Did any position breach its vol limit intraday, and for how long?" (P3)

```
in: minute(expiries) → partitionBy(expiry) → per-partition threshold test
  → run-length of breaches → total minutes            → fact per expiry
```

**Stresses:** **partitioned** + **discretising** + run-length. **Status:**
⚠️ `partitionBy` shipped; run-length encoding of a boolean has no
operator.

### Q10 — "Attribute last month's vol P&L to level, slope and curvature." (P4)

```
in: wide(symbol, 1mo) → per-date fit level/slope/curve over tenors
  → diff each factor → × sensitivities                → 3 series + facts
```

**Stresses:** **per-row fit across a value axis** — a regression _within_
each row, not along time. **Status:** ❌ needs Q2's unpivot plus K7,
which is **`U`-class**.

### Q11 — "Which names have the most unusual vol move today?" (P1/P3)

```
in: wide(all symbols, 60d) → partitionBy(symbol)
  → per-symbol zScore{60} → last → rank across symbols → top 20
```

**Stresses:** **the flurry shape** — N symbols × rolling study ×
cross-sectional rank. **Status:** ⚠️ the composition an agent reaches
for constantly, and the least measured thing in the library.

### Q12 — "Same question, 20 more times, varying the window." (P2, and every agent)

```
repeat Q1/Q11 with period ∈ {5,10,21,42,63,126,252} …
```

**Stresses:** **the process graph's whole reason to exist** — shared
sub-expression reuse across a flurry. **Status:** ✅ this is what
content-addressed nodes + the op cache are for; **measured at 0.09 ms
warm** for reductions, but never at flurry scale over real shapes.

## 4. What the catalog says pond is missing

Ranked by how many questions they block:

| Gap                                        | Blocks  | Note                                                                                                |
| ------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------- |
| **Unpivot a wide row → value-axis series** | Q2, Q10 | The single highest-value missing primitive. A term structure _is_ the object these people think in. |
| **Tall → wide pivot**                      | Q4      | Without it, half the catalog cannot be compared with the other half.                                |
| **Cross-sectional rank across partitions** | Q3, Q11 | `partitionBy` gets you per-symbol; nothing ranks _across_.                                          |
| **As-of join against an event list**       | Q5      | Earnings/dividends are the natural annotation axis.                                                 |
| **Run-length / episode detection**         | Q9      | "For how long" is a risk question, not an analytics one.                                            |
| **Bivariate rolling moments (K8)**         | Q8      | Also `U`-class — see the numerical RFC.                                                             |

Note what is _not_ on that list: rolling studies, aggregation, calendars,
histograms, folds. The things pond already does well are the things
these questions lean on hardest — the gaps are all **shape** problems,
not speed problems.

## 5. What this means for the benchmark

The current benchmarks page measures **one shape**: a single dense
series, rolled and reduced. That is Q1 and half of Q12. It says nothing
about the other ten.

A defensible suite needs one entry per **stress class**, not per op:

| Class                                     | Representative | Currently measured? |
| ----------------------------------------- | -------------- | ------------------- |
| Single-series rolling                     | Q1             | ✅                  |
| Wide-row → value axis                     | Q2             | ❌                  |
| Cross-sectional over N symbols            | Q3, Q11        | ❌                  |
| Pivot + join + spread                     | Q4             | ❌                  |
| Event-driven as-of                        | Q5             | ❌                  |
| Value-domain binning at tick scale        | Q6             | ❌                  |
| Multi-stage aggregation + calendar        | Q7             | ❌                  |
| Repeat-flurry with shared sub-expressions | Q12            | ❌                  |

**Q11 and Q12 are the two that matter most commercially.** They are the
shapes an agent produces without being asked to, they are where the
process graph's caching is supposed to pay, and they are the two nobody
has ever timed.

## 6. Where the sub-100 ms budget stands

Measured today, 500k bars, warm:

| Question              | Sequential   | 8 workers    |
| --------------------- | ------------ | ------------ |
| Q1 (`zScore` + folds) | ~18 ms       | ~7 ms        |
| Q12 as 5-study pass   | **64.75 ms** | **32.97 ms** |

So the _shipped_ shapes already clear 100 ms, with headroom. The budget
risk is entirely in the unmeasured classes — particularly Q11, where 500
symbols × a rolling study is 500 partitioned sweeps, and where nothing
in the current numbers predicts the answer.

## 8. The ClickHouse boundary: what the API should parameterise

Assumed architecture: an API in front of the cluster runs a parameterised
query and returns **Arrow** to pond's ingest. That makes "where does the
work happen" a design choice rather than a given, and three of §4's gaps
turn out to be **query-side reshaping, not missing pond primitives**.

### The principle

> **Push down what is invariant across a flurry. Keep local what
> varies.**

An agent asks twenty questions about the same working set. Anything
re-parameterised between questions — window lengths, thresholds, grains,
rankings — must stay local, or every question becomes a network round
trip and the sub-100 ms budget is gone on the first hop. Anything fixed
for the whole session — the symbol universe, the date range, the session
enum, the _shape_ of the data — should be done once, in the query, where
it also collapses bytes on the wire.

That line is not arbitrary. It is exactly where pond's value is: holding
a resident working set and answering many questions about it cheaply.
Push analytics down and pond becomes a renderer; push nothing down and
we ship gigabytes to reshape them in JS.

### Three gaps that are really query parameters

**Unpivot a wide row → value-axis series** (Q2, Q10 — §4's highest-value
gap). ClickHouse does this natively, and the result is exactly the tall
shape a `ValueSeries` wants:

```sql
SELECT ts, p.1 AS tenorDays, p.2 AS atm
FROM (
  SELECT tradingDate AS ts,
         arrayZip([5,10,21,42,63,84,105,126,189,252,378,504],
                  [atm_5d, atm_10d, atm_21d, atm_42d, atm_63d, atm_84d,
                   atm_105d, atm_126d, atm_189d, atm_252d, atm_378d, atm_504d])
           AS pairs
  FROM surface_fixed_term
  WHERE ticker = {symbol:String}
    AND tradingSession = {session:String}
    AND tradingDate = {date:Date}
) ARRAY JOIN pairs AS p
ORDER BY tenorDays
FORMAT Arrow
```

→ API parameter `shape: 'long' | 'wide'`. A term structure arrives as a
12-row value-axis series and pond never needs an unpivot operator.

**Tall → wide pivot** (Q4). Conditional aggregation, the canonical
ClickHouse idiom:

```sql
SELECT date AS ts,
       anyIf(value, windowType = 'cc')   AS cc,
       anyIf(value, windowType = 'iv63') AS iv63
FROM hist_vol
WHERE ticker = {symbol:String}
  AND date BETWEEN {from:Date} AND {to:Date}
  AND windowType IN {measures:Array(String)}
GROUP BY ts ORDER BY ts
FORMAT Arrow
```

→ API parameter `measures: string[]`. The tall/wide split in the catalog
stops being pond's problem.

**Session pinning.** A `WHERE` clause. It must be a _required_ parameter
rather than an optional filter, because omitting it silently returns
several rows per date — the quiet correctness trap in §1.

### Two that are a genuine trade, not a free win

**Pre-binning a histogram** (Q6) collapses 1M prints to ~200 bins before
they cross the wire:

```sql
SELECT floor(price / {width:Float64}) * {width:Float64} AS bin,
       sum(size) AS vol, count() AS n
FROM prints
WHERE ticker = {symbol:String} AND ts BETWEEN {from:DateTime} AND {to:DateTime}
GROUP BY bin ORDER BY bin FORMAT Arrow
```

Enormous byte saving — and it **freezes the bin width**. An agent that
re-bins at a different resolution pays a round trip. Same story for
pre-rolling ticks to 1-minute (Q7): it freezes the grain.

So both should be _available_ and neither should be the default. The
right call depends on whether the flurry will re-parameterise them,
which the plan knows and the API does not.

**Cross-sectional reduction** (Q3, Q11) is the sharpest case. Pushed
down it is one query and a tiny result:

```sql
SELECT ticker, argMax(skewSlope, tradingDate) AS slope
FROM surface_atm
WHERE tradingDate = {date:Date} AND tradingSession = {session:String}
  AND ticker IN {universe:Array(String)}
GROUP BY ticker ORDER BY slope DESC LIMIT {n:UInt32}
FORMAT Arrow
```

But Q11 is the _flurry_ shape — the same 500 symbols re-examined with
varying windows. Pushed down, that is N round trips. Held resident, it
is N cache hits over one panel. **This is the question that decides
whether the architecture is "pond as client" or "pond as viewer",** and
it is also `[PND-AGENTBENCH]`. Measure before choosing.

### The parameter surface that falls out

| Parameter                 | Purpose                                    | Pushdown                      |
| ------------------------- | ------------------------------------------ | ----------------------------- |
| `dataset`                 | which shape (S1–S6)                        | —                             |
| `universe: string[]`      | symbols; one, a list, or a screen          | **always**                    |
| `from` / `to`             | date or timestamp range                    | **always**                    |
| `session`                 | **required** — key dimension, not a filter | **always**                    |
| `columns` / `measures`    | projection; `measures` triggers the pivot  | **always**                    |
| `shape: 'wide' \| 'long'` | unpivot tenor/strike into a value axis     | **always**                    |
| `grain`                   | pre-roll ticks → bar interval              | opt-in; freezes grain         |
| `bin`                     | pre-bin to a value-domain histogram        | opt-in; freezes width         |
| `reduce`                  | cross-sectional aggregate + top-N          | opt-in; forecloses the flurry |

The first six are session-invariant and should always be pushed down.
The last three are the flurry trade.

### Why the Arrow handoff is already built

ClickHouse's `FORMAT Arrow` lands directly on the ingest work shipped
this session: `fromArrow` adopts a `Float64Array` values buffer
zero-copy, and — since [PND-ARROWNULL] — adopts the **validity bitmap**
too, which matters because query results are full of nulls. A 500k-row
result becomes a resident `TimeSeries` in ~1.5 ms with no per-element
walk. `toArrow` closes the loop if a result ever needs to go back out.

That was built for a polars sidecar and turns out to be the ingest path
for this architecture. Worth noting only because it means the boundary
above costs nothing to cross.

### What must never be pushed down

Rolling studies, folds, and crossings stay in pond — not for
performance, but because they are **oracle-pinned**. `@pond-ts/financial`
guarantees bar-for-bar agreement with a documented pandas convention
(`ddof=0`, `adjust=False`, linear quantile interpolation). A ClickHouse
window function is a _different_ implementation of "the same" study, and
the divergence would be silent, unversioned, and impossible to
reconcile. One definition of a study, in one place.

## 7. Proposed order of work

1. **Build the Q11/Q12 benchmark first** — cross-sectional and flurry,
   over synthetic data in these shapes. It is the commercially decisive
   number, the one most likely to surprise, **and it decides the
   `reduce` pushdown question in §8**: if a resident panel answers a
   flurry faster than N round trips, pond is the client; if not, it is a
   viewer.
2. **Then cross-sectional rank** (Q3/Q11), which step 1 will have forced
   a shape for.
3. **Unpivot and pivot are now query parameters, not pond operators**
   (§8) — so `[PND-UNPIVOT]` narrows to "ingest a long value-axis result
   well" rather than "reshape a wide row in JS". Cheaper, and it puts
   the reshaping where the engine is good at it.
4. As-of-event join (Q5) and run-length (Q9) as pulled — neither has a
   clean ClickHouse pushdown, so both stay pond's problem.

K8/K7 stay parked: they are `U`-class, and the numerical RFC should
settle how those are surfaced before more of them exist.
