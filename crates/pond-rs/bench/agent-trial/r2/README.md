# R2 step 5 agent trial: RSI, Bollinger bands and session VWAP

The R2 agent trial (`docs/plans/PND_RUST_PLAN.md`, R2 step 5): the R1a
setup ([`../README.md`](../README.md)) repeated on a financial-studies task.

## How it was run (2026-10-23)

- **Task:** [`prompt.txt`](prompt.txt), the same text on both sides except
  which library to use. On two weeks of one-minute bars with pre-market and
  after-hours trading, compute a 14-bar Wilder RSI (TA-Lib's), 20-bar
  Bollinger bands (population standard deviation, ×2), and a session VWAP
  that restarts each New York regular session (09:30 up to 16:00). The US
  clock change (2024-03-10) falls inside the data, so the session moves
  from 14:30 to 13:30 UTC. The task spells out every formula.
- **Data:** [`gen_bars.py`](gen_bars.py) (fixed seed): 9,600 bars, 04:00 to
  20:00 New York on the ten weekdays 2024-03-04 to 2024-03-15.
- **Agents:** 20 fresh Claude subagents (same model on both sides), 10 per
  library, all 10 of a side started at once (the polars side started a few
  minutes after the pond-rs side). No web access. Each could read only its
  own folder and its library's source: pond-rs's `src/` and manifest, or
  the polars 0.55.2 crates. `../setup.sh` built the folders, with
  `NAME=r2` and these polars features: `lazy ipc parquet temporal
timezones dtype-datetime rolling_window cum_agg round_series abs`.
- **Before the trial:** I wrote a solution with each library. The pond-rs
  one used `rsi` + `bollinger` + `session_vwap` with a trading calendar;
  the polars one used `rolling_mean` / `rolling_std` plus hand-written RSI
  and VWAP. Both came out right. An independent numpy computation of the
  task's formulas agrees with pond-ts's answer (RSI and VWAP exactly, bands
  within 4.7e-16 relative).
- **Grading:** [`check.py`](check.py), run afterwards; the agents never saw
  it. The five columns in the order the task asks, same rows, equal times,
  every value within 1e-9 relative, nulls in the same places. (The first
  version of the grader skipped the column order; the Layer-2 review on
  #830 caught it, and pondrs-03 fails on it.) The reference is pond-ts ([`reference.mjs`](reference.mjs)).
- **Rules check:** every agent's tool calls were scanned afterwards. None
  ran `cargo` other than through `attempt.sh`, and none read outside its
  folder and its library's source. Two polars agents waited on their own
  background build output file, which is their own tool's output.

## Results

|                                         | pond-rs  | polars    |
| --------------------------------------- | -------- | --------- |
| right answer                            | **9/10** | **10/10** |
| right values, ignoring column order     | 10/10    | 10/10     |
| values identical to pond-ts, to the bit | 10/10    | 0/10      |
| failed runs in total                    | **0**    | **12**    |
| agents with a failed run                | 0        | 10        |
| build-and-runs in total                 | 14       | 25        |
| program length (lines)                  | 35–91    | 117–173   |
| used the library for the calculation    | 10/10    | 0/10      |

Per run (`0` success, `101` compile error or panic):

- pond-rs: 02, 03, 04 and 09 `0 0` (a second run after adding checks);
  the rest `0`.
- polars: 01, 02, 03, 06, 07, 08 `101 0`; 04 `101 0 0`; 05 `0 101 0`;
  09 `0 101 101 0`;
  10 `101 101 0`.

pondrs-03 has every value right but writes `rsi` last: it dropped `rsi`,
added its patched copy with `with_column`, then called
`select(&["rsi", "bbUpper", "bbLower", "vwap"])`, which keeps the series'
order rather than the order named (documented, and the same as pond-ts's
`select`). It did not print its output's columns, so it never saw this.

Polars answers differ from pond-ts by at most 6.4e-16 relative, only in the
bands (each agent recomputed every 20-bar window from scratch; pond-ts keeps
running sums). RSI and VWAP are identical.

### What the numbers do not show

- **Agent time is not comparable.** pond-rs agents took 48–75 s. Polars
  agents took 72–804 s, but most of that was waiting: one agent added
  `chrono-tz`, which changed polars' feature set and rebuilt polars (about
  6 minutes), and the others' first builds queued behind it on the shared
  build folder.
- **No polars agent used polars for the work.** All 10 used it only to read
  and write the file (and 4 to convert times to New York); RSI, the bands
  and VWAP were plain Rust loops. Several said the recursive RSI does not
  fit polars expressions. So, as in the step-4b trial, this compares
  pond-rs's API with "hand-written Rust plus polars for the file". All 10
  pond-rs agents used `rsi`, `bollinger` and `session_vwap`.
- **The clock change is where the polars answers are fragile.** 6 of 10
  polars agents hard-coded the New York offset (UTC−5 before 2024-03-10
  07:00 UTC, UTC−4 after), which is right for this data and wrong for any
  other year. 3 used polars' `convert_time_zone` and 1 added `chrono-tz`;
  one of the six cross-checked its rule against `convert_time_zone`. Every
  pond-rs agent used `TradingCalendar::from_rules` with
  `America/New_York`. One polars agent noted that its own check (390 bars
  per session) could not catch an offset that was an hour wrong, because a
  shifted session still has 390 bars of data.
- **The task text and pond-ts disagree on a flat window, which never
  occurs here.** The prompt says RSI is 100 whenever the average loss is 0.
  pond-ts (and so pond-rs) returns a gap when both averages are 0, a
  documented choice (TA-Lib returns 0). The data has no such window. All
  10 pond-rs agents spotted the difference in the source; 8 added a step
  turning those gaps into 100, which changed nothing.
- **n = 10 per side.** 9 against 10 right is one agent, and 0 failed runs against 12 points the same way as R1a
  (2 against 10) and step 4b (1 against 4).

## What the agents ran into

**pond-rs** (number of agents out of 10):

1. **10/10: the flat-window RSI rule** (above). Several called the TA-Lib
   claim in the doc comment shaky on that edge; the doc comment does
   describe the gap.
2. **9/10: dropping or reordering output columns is roundabout.**
   `bollinger` always adds `bbMiddle`. Most rebuilt the series with
   `TimeSeries::new` from copied columns; others used `select`, or
   `select(&[])` then `with_column`. Two noted `select` keeps the series'
   column order rather than the order asked for, and it is what cost
   pondrs-03 its answer (above). There is no way to reorder columns.
3. **4/10: finding the session-VWAP route took reading `session.rs` and
   `calendar.rs`.** A whole `TradingCalendar` from `SessionRules`, and
   knowing that `Stamped::Open` (the default) means a session holds bars
   in `[open, close)`. One noted the plain `vwap` (no session reset) is
   easy to pick by mistake. Once found, all called it straightforward.
4. **2/10: no `times()` on `TimeSeries`;** they went through
   `key()` / `Key::Time`.
5. **2/10: the calendar needs a date range** although the series already
   has one; most padded it.

**polars** (for comparison):

- `&ChunkedArray` is not `IntoIterator`; the compiler error lists unmet
  trait bounds and never mentions `.iter()` (8/10 hit or noted it; most
  of the failed builds).
- `DataFrame::new` takes the row count first (9/10 noted it).
- `DataFrame::get_columns()` is now `columns()` (2).
- No safe `TimeZone` from a string: `TimeZone::opt_try_new(Some(..))?.unwrap()`
  or `unsafe { TimeZone::from_static(..) }` (4).

## Reproduce

```
python gen_bars.py data.arrow
node reference.mjs data.arrow > reference.json     # after building pond-ts and @pond-ts/financial
NAME=r2 POLARS_FEATURES='"lazy", "ipc", "parquet", "temporal", "timezones", "dtype-datetime", "rolling_window", "cum_agg", "round_series", "abs"' \
  ../setup.sh <trial-dir> data.arrow 10
# give each agent prompt.txt with {DIR}, {LIB}, {SRC} filled in; then
python check.py reference.json <trial-dir>/runs/<run>/out.arrow
```
