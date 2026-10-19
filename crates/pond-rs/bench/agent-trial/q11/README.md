# R1b step 4b agent trial: top-20 z-scores across 500 symbols

The step-4 agent trial (`docs/plans/PND_RUST_PLAN.md`, R1b step 4): the R1a
setup ([`../README.md`](../README.md)) repeated on a partitioned workload,
[PND-AGENTBENCH] Q11, "which names have the most unusual latest move?".

## How it was run (2026-10-19)

- **Task:** [`prompt.txt`](prompt.txt), the same text on both sides except
  which library to use. For each of 500 symbols: the z-score of its latest
  close against its own closes in the trailing 60 minutes (population
  standard deviation); write the top 20 by |z|.
- **Data:** [`gen_panel.py`](gen_panel.py) (fixed seed): 500 symbols × 1000
  one-minute bars, 483,949 rows in time order with the symbols mixed.
  - 2% of closes are missing.
  - 3% of rows are absent, and 40 symbols are halted for 30 minutes near
    the end, so "the last 60 minutes" is not "the last 60 rows". With a
    60-row window the top 20 shares only 12 symbols with the right answer.
  - One symbol in the answer (s019) has no close in the last minute, so its
    `t` differs.
- **Agents:** 20 fresh Claude subagents (same model on both sides), 10 per
  library, all 10 of a side started at once. They had no web access. Each
  could read only its own folder and the library's source: pond-rs's
  `src/` and manifest, or the polars 0.55.2 crates. `../setup.sh` built
  the folders, with `NAME=top20` and these polars features:
  `lazy ipc parquet temporal timezones dynamic_group_by dtype-datetime
rolling_window rolling_window_by abs round_series is_in strings rank
cum_agg`. Both build directories were compiled before the agents
  started.
- **Before the trial:** I checked that both libraries can do the task by
  writing a solution with each. The pond-rs one used
  `partition_by` + `rolling`; the polars one used `rolling_mean_by` /
  `rolling_std_by` + `.over("symbol")`. Both came out right.
- **Grading:** [`check.py`](check.py), run afterwards; the agents never saw
  it. It checks the same 20 symbols in the same order, equal `t`, and z
  within 1e-9 relative. The reference is pond-ts
  ([`reference.mjs`](reference.mjs)); an independent numpy computation
  agrees on all 20 symbols, the order, and z to within 4e-14.
- **Rules check:** every agent's tool calls were scanned afterwards. None
  ran `cargo` other than through `attempt.sh`, and none touched a path
  outside its folder and its library's source.

## Results

|                                         | pond-rs   | polars    |
| --------------------------------------- | --------- | --------- |
| right answer                            | **10/10** | **10/10** |
| answer identical to pond-ts, to the bit | 9/10      | 0/10      |
| failed runs in total                    | 1         | 4         |
| agents with a failed run                | 1         | 4         |
| build-and-runs in total                 | 15        | 16        |
| agent time, range                       | 53–108 s  | 61–100 s  |
| used the library for the calculation    | 10/10     | 3/10      |

Per run (`0` success, `101` compile error or panic, `1` error returned):

- pond-rs: 07 `1 0 0`. All the others succeeded on every run: 01, 03, 09
  and 10 `0 0`, the rest `0`.
- polars:
  - 03 `1 0`, 04 `101 0`, 06 `101 0`, 07 `0 101 0`.
  - 10 `0 0`; its first run built the empty starter program.
  - The rest `0`.

pond-rs 02 is right but not bitwise: it cut each symbol down to its last
60 minutes before `rolling`, so its running sums started from different
rows. Every other pond-rs agent rolled over the whole history and matched
pond-ts to the bit.

### What the numbers do not show

- **Most polars agents did not use polars for the work.** 7 of 10 used it
  only to read and write the file and computed the window, mean, standard
  deviation and ranking in plain Rust. Several said they chose that to
  avoid working out polars' rolling API. The other 3 used polars
  expressions, but a join and a filter on the window rather than `rolling`.
  None used polars' rolling functions. So this trial compares pond-rs's API
  with "hand-written Rust plus polars for the file", not with polars'
  rolling API. pond-rs agents all used `partition_by` / `group_by` +
  `rolling`.
- **Nobody fell into the trap.** All 20 used a 60-minute window by time,
  not 60 rows, and all handled the symbol whose latest close is a minute
  early. The task text spells the window out
  (`time > t − 60 minutes and ≤ t`), which makes the trap easy to avoid.
  As in R1a, this shows equal correctness with fewer failed runs, not that
  pond-rs makes agents more correct.
- **n = 10 per side.** 1 failed run against 4 points the same way as R1a
  (2 against 10) but is too few to rest on.
- **The programs are not shorter with pond-rs** (79–116 lines against
  71–123). pond-rs agents built the output Arrow batch by hand (below), and
  most added their own cross-check.

## What the agents ran into

**pond-rs** (number of agents out of 10):

1. **10/10: the output could not go through pond-rs.** The answer is 20
   rows ranked by |z| with columns `symbol, time, z`. A `TimeSeries` must be
   in time order and writes its key first, so every agent built the Arrow
   batch by hand with the re-exported `arrow_array` / `arrow_ipc`. All
   called this easy. One first tried `TimeSeries::new` and got "key is not
   in order".
2. **9/10: no "value at the latest row per partition".** Agents ran
   `rolling` over each symbol's whole history to read one row, or scanned
   backwards for the latest close by hand. Several asked for a single-window
   reduce at a given time.
3. **6/10: partition keys are awkward.** `PartitionKey` is
   `Vec<Option<Value>>`, so getting the symbol text needs a match on
   `Some(Value::String(..))`. One noted the column is optional only because
   the Arrow field is marked nullable.
4. **5/10: unsure whether `Stdev` gives exactly 0 on a flat window.** Three
   added a `min == max` guard. **The worry is right:** a trailing-window
   stdev over identical values, once different values have left the window,
   comes out around 1e-16 of the value rather than 0 (e.g. `5.1e-16` for a
   flat window at 0.1). pond-ts gives the same bits. Logged as
   [PND-FLATSTDEV].
5. **2/10: `rolling` keeps only its outputs** (plus the partition columns).
   One agent asked for `close` afterwards, got `UnknownColumn`, and added
   a `last` output; that was pond-rs's one failed run. The docs do not say
   this.

**polars** (for comparison):

- `DataFrame::new` now takes the row count first (4 noted it, 1 failed
  build).
- `&ChunkedArray` is not `IntoIterator` (2, both failed builds).
- Two unaliased aggregates of one column clash ("duplicate output name")
  (1, a failed run).
- `LazyFrame::scan_ipc` takes a `PlRefPath`, so the agent used the eager
  reader; `TimeZone::UTC` had to be found in the source.

## Reproduce

```
python gen_panel.py data.arrow
node reference.mjs data.arrow > reference.json     # after npm run build --workspace=pond-ts
NAME=top20 POLARS_FEATURES='"lazy", "ipc", "parquet", "temporal", "timezones", "dynamic_group_by", "dtype-datetime", "rolling_window", "rolling_window_by", "abs", "round_series", "is_in", "strings", "rank", "cum_agg"' \
  ../setup.sh <trial-dir> data.arrow 10
# give each agent prompt.txt with {DIR}, {LIB}, {SRC} filled in; then
python check.py reference.json <trial-dir>/runs/<run>/out.arrow
```
