# PND_PROCFIN_PLAN — finance questions on `@pond-ts/process`

> Breakout plan for the **[PND-PROCFIN]** task in the `@pond-ts/process`
> roadmap section of [PLAN.md](../../PLAN.md). Sibling of
> [PND_PROCESS_PLAN.md](PND_PROCESS_PLAN.md), which carries the library's
> other tickets and the shipped finance kit ([PND-PROCKIT]).

## What this is for

Peter, 2026-11-08: the process library will be used for financial
operations, asked for by agents through an MCP server, returning facts and
**sparklines** (a small line of points for a chart; confirmed 2026-11-12 —
the first reading, "Spark-like across many tickers", was wrong).

The yardstick is the catalogue of 48 realistic agent questions,
[finance-process-graphs-2026-11.md](../notes/finance-process-graphs-2026-11.md).
On `main` at d737b120 (2026-11-10), after [PND-PROCKIT]:

- **23 of 48** can be answered, and are timed on 1M bars by
  `packages/financial/scripts/perf-graphs.mjs` (16–237 ms each, warm).
- **25 cannot**: no date window (7), one dataset per request (6), no
  roll-ups or grouping (5), nothing runs across many tickers (6), one fold
  not built (1).
- **Sparklines** work through the `shape` fold but are weak (group A).

This plan is the 19 tasks that close those gaps. It replaces the three
placeholder tasks [PND-PROCWINDOW], [PND-PROCMULTI] and [PND-PROCFAN], whose
names are kept below as group names so older references still resolve.

Size is relative: **S** one small PR; **M** one PR with a design choice in
it; **L** several PRs. **Peter's call** marks a decision to get before
building. Record each task's outcome (decision + reasoning, and its perf
table) in this file when it ships, and remove it from the order table.

## Rules for every task

- Tests, and a parity or oracle check where a number is produced.
- A 1M-row benchmark for anything that walks the data (CLAUDE.md,
  "Performance check"), in `packages/process/scripts/perf-kit.mjs` or its
  own script.
- [PND-FINREC] below: catalogue and graph benchmark updated in the same PR.
- CHANGELOG `[Unreleased]`, API.md row for a new export, Layer-2 review.
- New public request fields or host methods ([PND-WINOUT], [PND-MULTIFROM],
  [PND-ROLLBARS], [PND-FANRUN]) need Peter's OK to merge.

## Order

| Step | Tasks                                                       | Catalogue questions answerable after    |
| ---- | ----------------------------------------------------------- | --------------------------------------- |
| 1    | [PND-SHAPEEND] [PND-SHAPEHOW] [PND-SHAPESCALE]              | 23 (sparklines end at now, show spikes) |
| 2    | [PND-WINOUT] [PND-WINANCHOR]                                | 28                                      |
| 3    | [PND-MULTIFROM] [PND-MULTIUNIT] [PND-MULTITEST]             | 34                                      |
| 4    | [PND-WINSESSION] [PND-SESSMIN]                              | 36                                      |
| 5    | [PND-ROLLBARS] [PND-GROUPBY]                                | 41                                      |
| 6    | [PND-CALGAPS]                                               | 42                                      |
| 7    | [PND-FANRUN] [PND-FANCOLLECT] [PND-FANLABEL] [PND-FANPAIRS] | 48                                      |

[PND-PARAMKIND] can land at any point (it adds studies, not catalogue
questions). Sparklines first because they are small and are what Peter asked
for; then the steps that unlock the most questions for the least design
risk. Across-tickers is last: it is the largest piece and [PND-FANPAIRS]
builds on [PND-MULTIFROM].

## A. Sparklines

The `shape` fold (`packages/process/src/plan/folds.ts`) is the sparkline: up
to 400 `[time, value]` points. Read on 2026-11-12, it takes every Nth row
from the start (`step = ceil(length / points)`), so:

- the newest row is usually not included (1M rows, 40 points: the last
  point is 25,000 rows before the end), so the line does not end at "now";
- a spike between two sampled rows never shows;
- it always covers the whole history (that part is [PND-WINOUT]).

### [PND-SHAPEEND] — a sparkline ends at the newest bar (S)

`shape` splits the rows into equal row bins with core's `Float64Column.bin`
(at most `points` bins, never more bins than rows), replacing today's
every-Nth-row loop. Equal row bins cover every row, so the last bin always
holds the newest row. With `how: 'sample'` (see [PND-SHAPEHOW]) each point is
its bin's last defined value, read from the `last` channel of core's
`minMaxFirstLast` reducer (core's `bin` has no scalar `last`). The first point
is therefore the first bin's last value, not row 0. No sampling or reduction
code in `@pond-ts/process`: if core lacks something, raise a core ticket.
**Peter's call:** which time a point carries (proposed: the time of its bin's
last row). Done when a test on a length that is not a multiple of `points`
ends on the newest row and returns no more than `points` points.

### [PND-SHAPEHOW] — summarise each stretch (S)

New `how` param, passed straight to core's `Float64Column.bin` over the row
bins from [PND-SHAPEEND]. Values use core's reducer names: `sample` (each
bin's last value; the default, decided by Peter), `mean`, `median`, `min`,
`max`, `minMax` (low and high of each bin, so a spike always shows) and
`minMaxFirstLast` (M4: low, high, first and last). It is a param, so it lands
in the spec id and two callers share one answer.

Each point follows `bin`'s output: a scalar reducer gives `[time, value]`,
`minMax` gives `[time, lo, hi]`, `minMaxFirstLast` gives
`[time, lo, hi, first, last]`. `points` counts bins. A bin with no defined
value (NaN from `bin`) is left out. No reduction code in `@pond-ts/process`:
if core lacks something, raise a core ticket. Time bins (core's `binBy`)
come with date windows ([PND-WINOUT]), not here.

### [PND-SHAPESCALE] — carry the scale (S)

The fact also reports first, last, lowest and highest value (with their
times), so a client can draw and label the line without a second fold.

## B. Date windows — [PND-PROCWINDOW]

A request cannot say "in 2024", "since 2020" or "today". `host.ts` documents
that the host deliberately does not window, so a request never has two
places that slice time; [PND-WINOUT] makes the request that one place.
`ParamDef` has no date kind, so a window is a request field, not a param.

### [PND-WINOUT] — a window on each output (M)

Each output (`Select`) may carry `window: { from?, to? }` (ISO date or
instant). Steps still run on the full history, so warm-up stays right and
cached node values are reused; only the fold reads the rows inside the
window. The window is part of the fact's identity. Per output rather than
per request because one question can need two ("share of today's volume in
the last hour").

Considered and not chosen: slicing the source to the window plus each op's
`lookback` first. Faster cold, but wrong for any op with no fixed warm-up
(an EMA, `cumulative`), and it forks the cache per window. Measure
[PND-WINOUT] at 1M rows before revisiting.

Unlocks #7 (z-score over the last year), #9 (return in 2024), #12 (3-year
Sharpe), #25 (gap-ups this year).

### [PND-WINANCHOR] — running totals that start at the window (M)

`cumulative` and `hold` (`plan/basic-ops.ts`) can start from the window's
first row instead of the start of history. Without it "max drawdown since
2020" uses a peak from before 2020. This is the one place a step, not just a
fold, must see the window, so it needs a design: most likely an explicit
`since` on the node rather than an implicit read of an output's window.
**Peter's call:** the wording. Unlocks #11.

### [PND-WINSESSION] — windows in trading sessions (M)

`window: { sessions: N }` — 1 is "today", 5 is "this week" — resolved from
the `SessionSource` the server already gives `studyOps()`
(`packages/financial/src/process/index.ts`). Needs the calendar reachable
from the host, not only from the bridge. Unlocks #33.

### [PND-SESSMIN] — time since the open (S)

A step in `@pond-ts/financial/process` giving each bar its minutes since its
session opened, so a plan can test "first 30 minutes" with `compare`.
Unlocks #30 (with [PND-WINSESSION] for "today").

## C. Several datasets in one request — [PND-PROCMULTI]

`join.ts` ([PND-PROCJOIN]) already aligns n sources into one series with
`SOURCE:column` names, by `inner` or `asof`, with the policy in the join's
id. Only `bind()` reaches it: `Host.add` takes one series and a wire
request's `from` is one name (`host.ts` notes widening it is meant to be an
addition).

### [PND-MULTIFROM] — name several datasets (M)

`from` may be a list with a required `join` policy. `Host.graphFor` builds
the joined graph once, keyed by the join id, and keeps it; `remove` of a
member drops it. Unlocks #17 (beta to SPY), #18 (GLD/TLT correlation), #19
(KO/PEP ratio), #21 (does oil lead the energy ETF), #22 (BTC on two
exchanges, `asof`), and #20 (AAPL vs QQQ this year) once [PND-WINOUT] is in.

### [PND-MULTIUNIT] — units and names carry through (S)

Each dataset's units follow it into the join (`TSLA:close` is USD), and a
slot input `TSLA:close` does not clash with the `slot#Output` form
(`slots.ts` already guesses at `:` when reporting a bad reference).

### [PND-MULTITEST] — prove the two-series studies (S)

`beta`, `correlation`, `priceRelative` and `performanceIndex` through a
joined request match a direct call, as `process-bridge.test.ts` does for
one series. Adds the six graphs to `perf-graphs.mjs`.

## D. Roll-ups and grouping — [PND-PROCFAN], first half

Ops must keep the row count. That rule stays: [PND-ROLLBARS] changes the
data before the plan runs and [PND-GROUPBY] summarises after it.

### [PND-ROLLBARS] — bars at another size (M)

A request may ask for coarser bars first: `bars: '1w'`, `'1mo'`, or one per
session. The host builds them once (first open, highest high, lowest low,
last close, summed volume) and keeps them as a derived dataset with its own
graph. **Peter's call:** weeks and months by the trading calendar or the
plain calendar. Unlocks #35 (weekly RSI), #34 (monthly returns table).

### [PND-GROUPBY] — group at the end (M)

A `groupBy` fold: mean, sum or count of a column per weekday, month of the
year, time of day or calendar month — one bounded table. Needs a time zone
from the host's setup. Unlocks #31, #36, #37.

## E. Across many tickers — [PND-PROCFAN], second half

A layer over single requests: run one request per ticker, then combine.
`HostPool` already runs distinct requests across cores. **Peter's call:**
inside `@pond-ts/process` or a small layer on top (proposed: on top, so one
request and its cache stay simple).

### [PND-FANRUN] — run one request over a set (M)

`host.runAcross({ over, request })` returns each ticker's facts keyed by
ticker. Alone it gives a grid of sparklines. Unlocks #47.

### [PND-FANCOLLECT] — combine the answers (M)

A `collect` part: rank, top N, count, share, or list those passing a test.
Unlocks #38, #39, #42.

### [PND-FANLABEL] — group by a label (S)

Datasets may carry labels when added (sector, exchange); `collect` may group
by one. Unlocks #40.

### [PND-FANPAIRS] — every pair (M)

Runs a two-dataset request ([PND-MULTIFROM]) per pair in a set and returns a
grid. Unlocks #41.

## F. Leftovers

### [PND-CALGAPS] — missing bars (M)

A fold in `@pond-ts/financial/process` comparing bar times with the trading
calendar and listing the gaps. Unlocks #46 (with [PND-WINSESSION] for "this
week").

### [PND-PARAMKIND] — more kinds of param (M)

`ParamDef` is number, integer, enum or boolean. Add an instant kind and a
"required, no default" marker. Brings in the four `UNBRIDGED_STUDIES`:
`anchoredVwap` (instant anchor), `swingIndex` / `accumulativeSwingIndex`
(limit move) and `tradeVolumeIndex` (tick size): 105 of 109 studies → 109.

### [PND-FINREC] — keep the records current (S, inside every task)

Each task marks its questions as working in the catalogue note and adds
their graphs to `perf-graphs.mjs`, so a slow new graph shows at once.
