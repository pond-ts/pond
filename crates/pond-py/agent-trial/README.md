# pond_rs docs trial (R4 step P3)

Can an agent solve typical tasks with `pond_rs` from the docs page alone
([`website/docs/pond-rs/python.mdx`](../../../website/docs/pond-rs/python.mdx))?
This folder holds the trial, so it can be run again with fresh agents.

- [`prompt.txt`](prompt.txt): four tasks. (1) a per-host trailing
  15-minute average from a CSV whose rows are not in time order; (2) daily
  max and count per host by New York calendar day, across the 2026-03-08
  clock change; (3) RSI(14) and Bollinger(20, 2) at each symbol's last bar;
  (4) the readings fed one at a time into a live series, reporting each
  host's 30-minute bucket as it closes.
- [`gen_data.py`](gen_data.py) writes `cpu.csv` and `bars.csv` (fixed
  seed).
- [`setup.sh`](setup.sh) `RUN_DIR [PYTHON]` makes a run folder: the data,
  the docs page as `docs.md`, the prompt, and `attempt.sh`, which runs
  `solution.py` and logs each exit status in `attempts.log`.
- [`check.py`](check.py) `RUN_DIR` grades the four answers against values
  worked out with plain pandas / Python (not `pond_rs`), so a misuse of the
  library shows as a wrong answer. Planted mistakes, each caught: rolling
  without `partition_by`, `"1d"` instead of New York days, counts left as
  floats (`57.0`), `std_dev=2.1`, live buckets not per host.

## How it was run (2026-11-02)

**Read this first: this is a weak trial.** Earlier trials
([R1a, R2, R3](../../pond-rs/bench/agent-trial/README.md)) used 10 fresh
subagents per side. The thread that built step P3 had no way to start
subagents, so the agent that wrote the docs page ran the trial itself. It
knew more than the page says, so "it got it right" counts for little. What
the trial is good for is the list of traps below: each is something a fresh
agent working from the page would have hit, found by trying the paths such
an agent takes first (pandas defaults, pandas duration words, looping over
pandas rows into `push`) and reading only the page for the way out. To
measure the page properly, run `setup.sh` once per agent, give each the
`PROMPT.txt`, and grade with `check.py`.

Two solutions were written from `docs.md` only, run only through
`attempt.sh`:

| Run                                | Right answers | Runs, exit status |
| ---------------------------------- | ------------- | ----------------- |
| [`runs/polars.py`](runs/polars.py) | 4 / 4         | one, `0`          |
| [`runs/pandas.py`](runs/pandas.py) | 4 / 4         | one, `0`          |

The pandas run came after the fixes below; before them, the page did not
say how to avoid traps 2, 4 and 5.

## What went wrong, and what changed

Found by the trial and fixed in the page (and the package README where it
applies):

1. **The type hints listed calendar units that do not exist.**
   `Sequence.calendar` was typed as taking `"minute"` and `"hour"`; pond-rs
   refuses both ("for hours use `Sequence::every`"). Fixed in `pond_rs.pyi`,
   the method's docstring and the page, which now says to use `"15m"` /
   `"1h"` steps.
2. **pandas hands its index over.** After `sort_values("time")` (needed,
   since rows must be in order) or a filter, the index is no longer
   0, 1, 2, … and arrives as a number column `__index_level_0__`, silently.
   The page now sorts with `ignore_index=True` and explains the index.
3. **Text times in a frame are refused.** `pd.read_csv` leaves `time` as
   text; the error is clear, and the page now shows `parse_dates=` /
   `try_parse_dates=`.
4. **A NaN in `push` is an error**, while a NaN in a frame is a gap. Looping
   over pandas rows into `push` fails on the first missing reading. The page
   and README now say so and show `None if math.isnan(x) else x`.
5. **A live partition's output has no partition column** (logged as
   [PND-LIVEKEY]). Known, but the page now shows the workaround in a full
   watch-and-push loop, and that `watch()` goes on the `collect()` node (on
   the partitioned node it is an error).
6. **pandas duration words** (`"15min"`, `"1D"`) are refused; the error is
   clear, and the page now says to write `"15m"` / `"1d"` (a `pd.Timedelta`
   works).
7. **Rules an agent had to guess**, now stated on the page: a trailing
   window of 15 minutes excludes the row exactly 15 minutes earlier (as
   pandas); a live bucket closes when an event at or after its end arrives,
   per partition; RSI is Wilder's (TA-Lib) and Bollinger bands use the
   population standard deviation.
8. **A list of reducers for one column** (`{"cpu": ["max", "count"]}`) is
   refused; the page now says one entry per output column.

Found while writing the page and covered from its first draft: an
aggregate's key comes out as three columns (`interval`, `intervalEnd`,
`intervalLabel`; `as_time()` makes one), counts come out as floats, times
come out in UTC, a calendar day is local but its output time is UTC, and
`difference` is max minus min, not last minus first.

## Not changed (candidates for the bridge)

- Drop `__index_level_0__` (pandas' index) on the way in, or read a
  `DatetimeIndex` as the key: removes trap 2 instead of documenting it.
- Read a NaN in `push` / `push_many` as a gap, as frames do (trap 4).
- Error texts from pond-rs use Rust spelling (`Sequence::every("1h")`)
  where Python's is `Sequence.every("1h")`.
- A live aggregation's key columns are named after the source key
  (`time`, `timeEnd`, `timeLabel`), a batch aggregate's `interval`,
  `intervalEnd`, `intervalLabel`. Not checked against pond-ts.
