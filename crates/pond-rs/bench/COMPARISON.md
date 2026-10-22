# pond-rs vs pond-ts vs polars — benchmark comparison

Every speed comparison made while building pond-rs (R1a and R1b steps,
PRs #764–#806), re-run in one sitting on one machine, with polars added
wherever polars has a matching call. Run on 2026-10-22 at commit `646cd85`
(main with #811, the faster `diff` / `rate` / `pct_change` / `shift` /
`fill` loops), after the review fixes described in
[Changes after review](#changes-after-review-2026-10-22). The first run
(2026-10-21, commit `6a42155`) is kept in `results/2026-10-21-*`.

## Short answer

Counts below compare cases where both sides take at least 0.5 ms (a few
calls cost one side next to nothing, e.g. polars `shift`, which does not
copy the column, or pond-rs `keep` over a whole series, which stops at
the first differing value); those are in the tables but not in the counts.

- **pond-rs vs pond-ts:** pond-rs (4 cores) is faster in 170 of 173 cases
  (median **7.5× faster**; from 1.1× up to ~100× on grid, dedupe,
  smoothing and reducer work, and 14,000× on one pond-ts case that scans
  every row per bucket, [PND-ROLLGRID]). pond-ts is one thread, but most of
  these cases run on one core in pond-rs too: on 1 core pond-rs is faster
  in 169 of 173 (median 6.8×). It is slower in:
  - outer join of two 1M-row series: 73 ms (73 on 1 core) vs 67 ms
    (pond-ts's join was already column-based, and pond-rs pays to touch
    fresh memory for the output; see step 6 in `PND_RUST_PLAN.md`);
  - JSON in on the wide 10k × 41 series (410,000 small whole numbers):
    `from_json` 34 vs 31 ms and `from_columns_json` 17 vs 8.5 ms. Step
    8d2 found most of pond-rs's time there is parsing the text, and left
    a schema-typed reader undone;
  - on 1 core only, also: splitting 500k rows by symbol (39 vs 35 ms);
  - `ValueSeries.to_arrow` (not counted: pond-ts hands back views, 0 ms;
    pond-rs builds gap bits, 0.9 ms).
- **R1a workloads (the targets pond-rs was judged on):** on workload A
  pond-rs computes faster than polars on 4 cores (117–120 vs 142–177 ms)
  and the same on 1 core (355–364 vs 355–386 ms); pond-rs grows memory by
  185 MB against polars' 240–265 MB. On B (12 daily buckets) polars is
  faster on 1 core (19–23 vs 26–34 ms compute) and they are even on 4
  (9–10 ms each).
- **pond-rs vs polars, all other cases:** about even, slightly in pond-rs's
  favour. On 4 cores each, pond-rs is faster in 73 cases, slower in 59,
  same in 9 (median ratio 1.08: pond-rs ~8% faster). On 1 core each,
  pond-rs is faster in 85, slower in 51, same in 4 (median: pond-rs ~27%
  faster). The first run had 61 faster / 64 slower over its 127 cases
  (median 0.95); on the 119 of those this run still compares, it is now
  61 faster / 51 slower, same in 7 (median 1.08). The review fixes and
  #811 moved them; see
  [Changes after review](#changes-after-review-2026-10-22) for which
  cases moved and why.
  - pond-rs is much faster on: rolling `unique` / `top3` over 5-minute
    windows (11–113×: polars has no rolling form of these, and its general
    `rolling` with a list expression takes 1.3–19 s), joins that keep
    every row (outer joins 3.6–44×), per-entity `materialize` (2.7×),
    `dedupe` keeping the largest value (2.5×), `unique` / `top3` in
    buckets (1.4–2.6×), `keep` on numbers (1.4–3.7×), the row-by-row `rate` / `pct_change` /
    cumulative sum (3–3.6×), a time window that needs a minimum row count
    (3×), grid rolling onto 1-minute buckets (2.7–4.7×), EMA (2.2×), JSON
    object rows in (1.5–2.1×), pivots with many groups (1.2–1.6×; 4.6–5×
    on 1 core), `explode` of numbers (1.7–3.1×).
  - polars is much faster on: `collapse` (13–18×: pond calls a function
    once a row, polars adds two columns in one vectorised step), `filter`
    (6×, the same reason), list-column Arrow in and out and `len` /
    `mean` / `first` of lists (1.6–25×), the `samples` list reducer (1.5–15×),
    row windows per entity (4×) and per-entity `diff` / `fill` (3×),
    `align` hold onto a 1 s grid (2–3×), `concat` (2–2.5×), left and inner
    joins (~2×), row-count windows (~2×).

pond-rs and polars give the same answers, cell by cell, on every one of the
147 cases both time (`check_all.sh`, below); pond-rs and pond-ts on R1a to
the bit, and on the other families by per-case checksums.

## How this was measured

- Machine: 4-core cloud container, Intel Xeon @ 2.80 GHz, 15 GB RAM.
  Node 22.22, Rust 1.97 (release builds, Rust's default memory manager),
  polars 2.0.0 (Python API; the work runs in polars' Rust engine, and the
  Python call overhead is microseconds per call). Nothing else ran during
  the timed runs.
- Each runner builds the same data (same generators, same values), runs
  each case once to warm up (pond-ts: see below) and then 7 times (pond-rs
  and pond-ts use 9 for arrays and JSON; polars uses 3 for a case whose
  warm-up takes over 2 s, its rolling `top3`), and reports the median.
  Every family ran **3 times** (3 separate processes per engine); each
  cell below is the median of the 3, with the range in brackets when it
  spans more than ±15%.
- pond-rs ran twice, with `RAYON_NUM_THREADS=1` and with all 4 cores;
  polars ran with `POLARS_MAX_THREADS=1` and with all cores. pond-ts is
  one thread. pond-rs uses several cores only across columns, across
  partitions and in loess, so on single-column, single-series cases "4
  cores" is the same work and the difference is noise. The "pond-rs vs
  pond-ts" column compares pond-rs on 4 cores; compare the "pond-rs 1
  core" column for one thread against one thread.
- **pond-ts warm-up caveat:** most pond-ts runners warm up once (the
  row-by-row and array ones 3–5 times). V8 sometimes speeds a call up only
  after dozens of calls (fill linear: 75 ms after 5 warm-ups, 23 ms after
  40, PR #776), so some pond-ts numbers would be lower in a long-running
  program. The pond-ts rolling `samples` case needs a 12 GB heap
  (`--max-old-space-size`); with node's default it runs out of memory.
- **Same answers, pond-rs and polars:** with `BENCH_DUMP=<dir>` set, every
  pond-rs and polars runner writes each case's answer (the warm-up's, so
  it is not timed), and `check_outputs.py` compares them cell by cell:
  the same column names in the same order, the same rows in the same
  order, gaps in the same places, text, true/false, lists and times
  exactly equal, numbers within 1e-9 of the larger magnitude.
  `check_all.sh` runs every family; all 147 compared cases match. Two
  are compared more loosely: the reservoir sample (the two libraries draw
  different random numbers, so only columns, row count and time order are
  checked) and rolling `samples` over 5 minutes (~280 values a row, too
  big to write out, so each row's list length, sum, first and last value).
- **Same answers, pond-rs and pond-ts:** the R1a runner checks pond-rs
  equals pond-ts to the bit and pond-ts matches polars within 1e-9 (no
  check failed in any of the 3 repeats). For the other families, pond-rs
  and pond-ts print a checksum per case (rows, present values, their sum).
- **What "polars" means per case:** the closest polars call or short
  combination of calls that does pond's work and returns pond's answer:
  the same output columns (pond's interval key columns too), the same
  gap rules and tie rules, the same row order. Where a first version was
  slow, the faster form is used (each script's header says which, and what
  it does differently from a one-liner). Cases with no polars counterpart
  show "–": loess, a `scan` with custom state, time-range keys, a linear
  fill with a maximum gap, `rolling_by_column` (polars' rolling needs a
  time or integer column), `ValueSeries`, pond's array-row, columns and
  points JSON, the decimal columns.

To reproduce:

```
npm run build --workspace=pond-ts
PYTHON=/path/to/python crates/pond-rs/bench/run.sh            # R1a A and B
OUT=/tmp/cmp PYTHON=/path/to/python crates/pond-rs/bench/compare_all.sh 3
python crates/pond-rs/bench/collect.py /tmp/cmp                # tables below
PYTHON=/path/to/python crates/pond-rs/bench/check_all.sh       # same answers
```

## R1a workloads A and B

1M rows, 4 number columns with ~5% gaps, read from and written to Arrow IPC
(details in [README.md](README.md)). Ranges over 3 full repeats, each the
median of 7 runs.

| workload | engine           | read ms | compute ms | write ms | total ms  | memory growth MB |
| -------- | ---------------- | ------- | ---------- | -------- | --------- | ---------------- |
| A        | pond-ts          | 31–34   | 1950–2023  | 110–130  | 2117–2209 | 357–365          |
| A        | pond-rs, 1 core  | 34–35   | 355–364    | 67–74    | 463–474   | 184–185          |
| A        | pond-rs, 4 cores | 33–34   | 117–120    | 67–81    | 220–228   | 185              |
| A        | polars, 1 core   | 14–16   | 355–386    | 63–67    | 437–467   | 240              |
| A        | polars, 4 cores  | 24–29   | 142–177    | 60–67    | 229–275   | 265              |
| B        | pond-ts          | 42–49   | 53–58      | 1.6–1.9  | 98–109    | 83–86            |
| B        | pond-rs, 1 core  | 15–20   | 26–34      | 0.1      | 42–54     | 78               |
| B        | pond-rs, 4 cores | 16–18   | 8.9–10     | 0.1      | 25–28     | 78–79            |
| B        | polars, 1 core   | 13–15   | 19–23      | 1.0–1.2  | 33–38     | 95               |
| B        | polars, 4 cores  | 16–18   | 9.1–10     | 1.1–1.4  | 27–32     | 96               |

From the medians: pond-rs computes A 17× faster than pond-ts on 4 cores
(5.5× on 1) and B 6.1× faster (1.9× on 1). Against the R1a targets:
≥2× pond-ts single-core is met on A (5.5× compute, 4.6× total) but **not on
B's compute (1.9×)**; B's total time, with reading and writing, is 2.1×.
Within 1.25× of polars multi-core: met (pond-rs takes 0.72× polars' time
on A's compute, 0.96× on B's). Memory growth no more than 1-thread polars:
met (185 vs 240 MB).

## Changes after review (2026-10-22)

A Codex review of the first run (PR #810 at `c7bc9b1`) checked every
polars runner against the pond-rs case it is compared with and found
several that did different work or gave different answers. The checksums
then in use (rows, and the sum of the number columns) could not catch
most of them: they miss text, keys, column lists and row order. All
were fixed, the cell-by-cell answer check above was added so the same kind
of mistake fails loudly, and everything was re-timed. What changed:

| polars runner                                    | was                                                                                               | now                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| cumulative sum                                   | `cum_sum()` left 47,709 gap rows empty; pond carries the running total through them               | `cum_sum().forward_fill()`                                                                            |
| rows 300 avg centred                             | polars' centring puts the extra row before the centre, pond after: 999,982 values differed        | the column reversed, rolled centred, reversed back                                                    |
| per-entity rolling, Q11                          | computed mean and stdev but not pond's third output, the last present close in the window         | carries the last present close and its time forward per symbol, kept while inside the window          |
| `unique` / `top3` in buckets                     | dropped gap rows first, so all-gap buckets vanished (941,176 rows instead of 1,000,000)           | every bucket kept (an empty list where all gaps)                                                      |
| `top3` ties                                      | polars' own order; pond breaks ties by value (smaller first); 2,827 minute buckets differed       | ties by value, in buckets, windows and reduce                                                         |
| `dedupe` by largest `v`                          | kept the last of equal maxima (135 `host` values differed); pond keeps the earliest               | sorted so the earliest largest row comes first, then the first row per time                           |
| per-symbol `align` / `materialize` + collect     | rows at the same time came out in a different order from pond's                                   | symbols kept in first-seen order with a stable sort, as pond's collect                                |
| `align`, grid rolling, bucket `aggregate`        | no interval end / label columns (pond keys these rows by interval); linear `align` dropped `host` | the interval columns added; `host` kept                                                               |
| `materialize` nearest, rolling, smoothing, pivot | kept a helper column, or kept input columns pond doesn't return, or pivot names / order differed  | each returns exactly pond's columns, in pond's order                                                  |
| array Arrow / IPC                                | the two list columns only; pond-rs's `select` keeps the time key                                  | time included                                                                                         |
| array `explode`                                  | a filter pass, then explode                                                                       | one `explode(empty_as_null=False, keep_nulls=False)` call                                             |
| JSON in and out                                  | polars wrote and read times as date text and objects; pond-rs read array rows with numbers        | compared with pond's object rows (new `from_json object` / `fromJSON object` cases) and numeric times |
| reservoir sample                                 | unsorted; pond returns its picks in time order                                                    | sorted by time                                                                                        |

And the cases the first run listed as having no polars counterpart, where
polars does have one, now have polars numbers: leading and centred time
windows and the centred moving average (polars' general
`DataFrame.rolling` with an offset), the minimum-row-count windows (a
rolling row count beside the rolling mean), and the rolling `keep` on
text and `unique` / `top3` / `samples` reducers (`DataFrame.rolling`
with a list expression; `keep` on text compares each name's categorical
code). These general rolling forms are the fastest we found, not
necessarily the fastest polars can do: rolling `top3` takes polars 18–34 s
against pond-rs's 0.2 s.

The effect on the comparisons (4 cores; the machine also ran ~10% faster
overall than the first run, so only large moves mean much):

- polars got slower where it now does pond's work: cumulative sum 7.0 →
  12 ms, `dedupe` max 50 → 64 ms, `top3` v per second 159 → 192 ms, `align`
  hold 1 s 8.7 → 15 ms (interval columns), per-entity rolling 68 → 75 ms.
- polars got faster where the old form did extra work: `explode` tags 56 →
  38 ms (one call), `from_json` 195 → 156 ms (numbers instead of date text).
- pond-rs's own changes from #811 (`diff`, `rate`, `pct_change`, `shift`,
  `fill`) moved most of the row-by-row rows from polars' column to
  pond-rs's: `diff` 2.7× slower → 1.4× faster.
- Unchanged in direction: pond-rs is still much slower on list-column
  Arrow in and out (time included, polars 2–20× faster), `collapse`,
  `filter`, `samples` and per-entity row windows.

## Why polars wins where it does

Measured 2026-10-22 with throwaway probes (not committed), one core, same
data as the row-by-row and rolling families. Times move run to run; the
comparisons are within one probe run.

- **Not the memory manager.** A first probe suggested glibc handing freed
  memory back to the operating system cost pond-rs several ms per call
  (`diff` 8.3 → 4.7 ms with glibc told to keep freed memory). That was the
  probe's own allocation pattern: in the benchmark runner itself the same
  setting moves `diff` only 4.0–4.6 → 3.4–3.5 ms (two runs each) and
  the other row-by-row cases within run-to-run noise. Swapping the whole memory manager doesn't close the gap
  either (see "Memory manager" below).
- **`diff` itself.** pond-rs checked each pair of values for gaps before
  subtracting (a gap is NaN): that loop took 2.6 ms; the same subtraction
  without the checks takes 0.6 ms. Copying the time key into the new
  series adds 0.6 ms. polars keeps gaps in a separate bit list, so it
  subtracts straight through and combines the bit lists afterwards. (#811
  has since made these loops branch-free; in the tables below, which
  include it, pond-rs's `diff` is now 1.4× faster than polars on 4 cores.)
- **`shift`.** polars does not copy the column: the result is the original
  column plus a one-row gap placed in front (checked: the shifted column
  is made of 2 pieces, 1 row and 999,999 rows). pond-rs copies every value
  through a list of 1M row numbers.
- **`filter` and `collapse`.** Both take a function that pond-rs calls
  once per row, and the function looks columns up by name on every row.
  pond-rs's own numbers show the cost: `filter` by name 17 ms, the same
  filter with the column fetched once 7 ms. `collapse` also builds a
  general "number or text or true/false" value per row before turning
  them into a column. polars runs `v > 500` or `v + w` over whole columns
  at once (3 ms).
- **Row windows per entity** (`rows 20 avg by host`, 8 hosts): pond-rs
  splits the series into 8 separate series (every column copied, text
  included: 40 ms), runs the window on each (38 ms) and merges them back
  in time order (60 ms); the same window over the unsplit series takes 13
  ms. polars' `.over("host")` works out which rows belong to which host
  and writes results back into one column, without building separate
  tables.
- **List columns.** pond-rs stores each row's list as its own small array
  of general values (each element can be a number, text or true/false).
  polars stores lists the way Arrow does: one flat array of all elements
  plus the position where each row's list starts. So a list's length is
  one subtraction in polars (0.2 ms for 100k rows) against a walk over
  every row in pond-rs (3–5 ms), and Arrow in and out costs polars almost
  nothing while pond-rs converts every row (and makes one text string per
  text element).

## Memory manager (glibc, jemalloc, mimalloc)

polars ships its own memory manager (jemalloc, built into its library
file); pond-rs uses Rust's default (glibc on Linux). Tried on pond-rs,
2026-10-22, 3 repeats each, same machine:

- **jemalloc** (system `libjemalloc` 5.3 via `LD_PRELOAD`, every family):
  slower in 119 of 198 cases, faster in 15; median 14% slower. R1a A total
  187 → 282 ms, memory growth 192 → 251 MB. Turning off its memory
  return (`MALLOC_CONF=dirty_decay_ms:-1,muzzy_decay_ms:-1`) did not help
  the row-by-row cases.
- **mimalloc** (the `mimalloc` crate as `#[global_allocator]`, in copies
  of the row-by-row, join, smoothing and grid runners and the R1a runner):
  no change overall (44 cases, median 1.0; 7 faster, 5 slower). Big wins
  only where a call writes a large fresh output: `align` onto a 1 s grid
  2× (38 → 19 ms, 64 → 31 ms), 1M × 1M outer join 1.75× (78 → 45 ms).
  R1a A total 187 → 178 ms, but memory growth 192 → 342 MB, past
  polars' 256 MB (the R1a memory target).
- A library can't choose the memory manager for the program that uses
  it (in Rust that is the program's `#[global_allocator]`), and neither
  option is a general win, so pond-rs keeps the default. A program whose
  hot path is grid alignment or big outer joins can switch to mimalloc
  itself.

## Numbers that differ from what was reported before

- **pond-ts `shift` / `fill`** are much faster than in the step 3a table
  (`shift` 55.6 → 6.3 ms, `fill` hold 51.8 → 13, linear 75.1 → 17): the
  [PND-BOXFREE] fix (#776) landed after that table.
- **pond-rs `from_json`** on the dense 100k × 6 series takes 70 ms here;
  step 8d2's table said 45 ms. Built at that step's commit (`44c4723`,
  #793) on the first run's machine it took 75–91 ms, so the code has not
  got slower; the 45 ms does not reproduce.
- **R1a A, polars 4 cores** computes in 142–177 ms here against 209–231 ms
  in step 4's table. The tables were run in different sessions on cloud
  machines that differ run to run (this README notes a first machine ~40%
  faster than a second), so only compare numbers within one table.

## Results by family

### Row-by-row operations (1M rows)

Times in ms; median of 3 repeats (range when over ±15%).

| case                     | pond-ts       | pond-rs 1 core   | pond-rs 4 cores  | polars 1 core  | polars 4 cores   | pond-rs vs pond-ts    | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------ | ------------- | ---------------- | ---------------- | -------------- | ---------------- | --------------------- | ------------------------- | -------------------------- |
| diff                     | 6.9           | 1.6 (0.90–2.0)   | 1.2 (1.0–1.8)    | 1.5 (1.2–2.0)  | 1.7 (1.3–2.0)    | 5.8× faster           | 1.1× slower               | 1.4× faster                |
| diff drop                | 9.9 (8.1–14)  | 3.6 (1.8–3.7)    | 3.1              | 1.2 (1.2–1.4)  | 1.8 (1.5–1.9)    | 3.2× faster           | 3.0× slower               | 1.7× slower                |
| rate                     | 15            | 2.4 (1.7–3.2)    | 2.7 (2.1–3.2)    | 8.1            | 8.8              | 5.4× faster           | 3.4× faster               | 3.3× faster                |
| pct_change               | 7.8           | 1.4 (0.90–2.0)   | 1.1 (0.90–1.9)   | 3.4 (2.6–3.8)  | 4.0 (2.7–4.7)    | 7.1× faster           | 2.4× faster               | 3.6× faster                |
| cumulative sum           | 8.3 (6.2–8.4) | 4.6 (4.0–6.7)    | 4.1 (3.8–6.3)    | 14 (11–18)     | 12 (12–22)       | 2.0× faster           | 2.9× faster               | 3.0× faster                |
| shift 1                  | 6.3           | 1.1 (1.0–1.3)    | 0.90 (0.90–1.4)  | 0.00           | 0.20 (0.20–0.30) | 7.0× faster           | other under 0.05 ms       | 4.5× slower                |
| fill hold                | 13            | 3.9 (3.6–5.8)    | 3.3 (2.6–3.6)    | 5.7 (5.3–7.6)  | 5.4              | 4.0× faster           | 1.5× faster               | 1.6× faster                |
| fill linear              | 17 (17–20)    | 5.3 (4.7–7.6)    | 3.4 (3.0–4.4)    | 6.3            | 6.1              | 4.9× faster           | 1.2× faster               | 1.8× faster                |
| fill linear maxGap 3s    | 15            | 3.5 (2.6–6.0)    | 2.6 (2.2–3.2)    | –              | –                | 5.7× faster           | –                         | –                          |
| filter v > 500 (by name) | 39            | 18 (16–33)       | 16 (16–20)       | 3.2            | 2.6 (1.9–3.2)    | 2.4× faster           | 5.7× slower               | 6.2× slower                |
| map_numbers v \* 2       | 5.9 (5.0–7.8) | 1.3 (0.70–1.7)   | 0.70 (0.60–0.90) | 1.1 (0.80–1.3) | 1.4 (0.90–1.5)   | 8.4× faster           | 1.2× slower               | 2.0× faster                |
| with_column              | 6.2 (4.8–7.4) | 0.00             | 0.00             | 0.00           | 0.00             | pond-rs under 0.05 ms | both <0.5 ms              | both <0.5 ms               |
| slice middle half        | 0.00          | 0.30 (0.30–0.40) | 0.30 (0.20–0.30) | 0.00           | 0.00             | both <0.5 ms          | both <0.5 ms              | both <0.5 ms               |

### Per-entity work: 500 symbols × 1000 bars

Times in ms; median of 3 repeats (range when over ±15%).

| case                                        | pond-ts             | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------------------------- | ------------------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| split                                       | 35                  | 39 (37–47)     | 23              | 47            | 26             | 1.5× faster        | 1.2× faster               | 1.1× faster                |
| diff + collect                              | 638                 | 79             | 59              | 29 (26–35)    | 20 (18–24)     | 10.7× faster       | 2.7× slower               | 3.0× slower                |
| fill linear + collect                       | 645                 | 79             | 56              | 26 (24–39)    | 18             | 11.4× faster       | 3.0× slower               | 3.1× slower                |
| rolling 60m mean/sd + collect               | 1,241               | 162            | 73              | 132 (131–164) | 75 (56–77)     | 17.0× faster       | 1.2× slower               | same                       |
| Q11: rolling 60m, last z per symbol, top 20 | 1,332 (1,302–1,542) | 103            | 46              | 152           | 67 (67–83)     | 28.9× faster       | 1.5× faster               | 1.5× faster                |

### Putting rows on a time grid: align, materialize, dedupe

Times in ms; median of 3 repeats (range when over ±15%).

| case                                       | pond-ts | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------------------------ | ------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| align hold 1m (1M rows)                    | 62      | 2.3            | 2.4 (1.7–2.5)   | 1.9 (1.6–2.6) | 3.2 (2.1–3.2)  | 25.8× faster       | 1.2× slower               | 1.3× faster                |
| align hold 1s (1M rows)                    | 3,389   | 49             | 45              | 16            | 15 (11–16)     | 76.0× faster       | 3.0× slower               | 2.9× slower                |
| align linear 1s (1M rows)                  | 893     | 74 (66–89)     | 71              | 62 (52–73)    | 54             | 12.6× faster       | 1.2× slower               | 1.3× slower                |
| align hold 1s (10k rows, 1M buckets)       | 2,229   | 22             | 22 (22–27)      | 12            | 11             | 100.4× faster      | 1.8× slower               | 2.1× slower                |
| materialize last 1s (1M rows)              | 793     | 28             | 27 (26–32)      | 49            | 38 (36–44)     | 29.2× faster       | 1.8× faster               | 1.4× faster                |
| materialize nearest 1m (1M rows)           | 43      | 3.4 (3.2–4.1)  | 4.8 (3.4–5.8)   | 2.6           | 3.6            | 8.9× faster        | 1.3× slower               | 1.3× slower                |
| materialize last 1s (10k rows, 1M buckets) | 686     | 23             | 23              | 16            | 14 (8.6–14)    | 29.7× faster       | 1.5× slower               | 1.7× slower                |
| dedupe last (1M rows, 10% repeats)         | 1,085   | 20             | 21 (20–24)      | 14            | 9.9 (7.0–11)   | 52.2× faster       | 1.4× slower               | 2.1× slower                |
| dedupe max v (1M rows, 10% repeats)        | 1,191   | 21             | 25              | 142           | 64             | 46.9× faster       | 6.7× faster               | 2.5× faster                |
| panel: align 1m per symbol + collect       | 2,266   | 112 (92–119)   | 78              | 126           | 61 (47–72)     | 29.1× faster       | 1.1× faster               | 1.3× slower                |
| panel: materialize 1m per symbol + collect | 1,250   | 102 (83–113)   | 62              | 286           | 167            | 20.3× faster       | 2.8× faster               | 2.7× faster                |
| panel: dedupe per symbol + collect         | 1,258   | 73 (71–90)     | 60              | 84            | 66 (62–84)     | 20.9× faster       | 1.1× faster               | 1.1× faster                |

### Joins on time

Times in ms; median of 3 repeats (range when over ±15%).

| case                          | pond-ts      | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ----------------------------- | ------------ | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| left join, 1M x 1M, 1/3 match | 21           | 19 (15–21)     | 18 (15–21)      | 13 (13–19)    | 9.5            | 1.2× faster        | 1.5× slower               | 1.9× slower                |
| inner join, 1M x 1M           | 22           | 12 (12–16)     | 12 (11–14)      | 11            | 5.0            | 1.9× faster        | 1.1× slower               | 2.3× slower                |
| outer join, 1M x 1M           | 67 (65–79)   | 73             | 73 (63–87)      | 384           | 259            | 1.1× slower        | 5.2× faster               | 3.6× faster                |
| left join, 1M x 10k sparse    | 18           | 14 (12–20)     | 16              | 12 (11–19)    | 7.9 (7.6–9.6)  | 1.1× faster        | 1.1× slower               | 2.1× slower                |
| outer join, same keys         | 8.7 (8.0–11) | 6.1 (3.9–6.2)  | 4.0 (3.6–5.8)   | 265           | 160            | 2.2× faster        | 43.5× faster              | 40.0× faster               |
| joinMany 3 on same keys       | 16 (16–23)   | 8.2 (7.8–12)   | 8.3 (7.9–11)    | 510           | 364            | 2.0× faster        | 62.2× faster              | 43.8× faster               |

### Rolling windows

Times in ms; median of 3 repeats (range when over ±15%).

| case                       | pond-ts    | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| -------------------------- | ---------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| time 5m avg trailing       | 230        | 22             | 22              | 30 (28–51)    | 31             | 10.6× faster       | 1.3× faster               | 1.4× faster                |
| time 5m avg leading        | 220        | 22 (22–27)     | 24              | 25            | 22 (14–28)     | 9.3× faster        | 1.1× faster               | 1.1× slower                |
| time 5m avg centered       | 229        | 22             | 22              | 28            | 26             | 10.3× faster       | 1.3× faster               | 1.2× faster                |
| time 5m stdev centered     | 266        | 36             | 38              | 42            | 40 (37–47)     | 6.9× faster        | 1.2× faster               | 1.1× faster                |
| time 5m avg min 300        | 334        | 21             | 21              | 57            | 65             | 15.6× faster       | 2.7× faster               | 3.0× faster                |
| rows 20 avg                | 29 (29–34) | 22             | 22              | 12 (12–21)    | 10             | 1.3× faster        | 1.8× slower               | 2.1× slower                |
| rows 20 avg min 20         | 26 (25–31) | 22             | 22              | 12            | 12             | 1.2× faster        | 1.8× slower               | 1.8× slower                |
| rows 20 stdev              | 58 (52–67) | 47             | 47              | 24 (24–36)    | 24             | 1.2× faster        | 1.9× slower               | 2.0× slower                |
| rows 300 avg centered      | 26         | 21             | 22              | 17            | 19 (18–36)     | 1.2× faster        | 1.2× slower               | 1.1× slower                |
| rows 20 avg by host        | 2,211      | 175            | 122             | 43            | 30 (29–35)     | 18.0× faster       | 4.0× slower               | 4.1× slower                |
| grid 1m, 5m avg, 100k rows | 8,367      | 0.70           | 0.60            | 2.5 (2.5–2.9) | 2.8            | 13945.2× faster    | 3.6× faster               | 4.7× faster                |
| grid 1m, 5m avg, 1M rows   | –          | 7.4 (6.5–10)   | 6.4             | 16            | 17             | –                  | 2.1× faster               | 2.7× faster                |
| grid 1s, 5m avg, 1M rows   | –          | 250            | 237             | 157           | 169            | –                  | 1.6× slower               | 1.4× slower                |

### Smoothing, baseline, outliers, scan, sample

Times in ms; median of 3 repeats (range when over ±15%).

| case                            | pond-ts    | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores  | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------------- | ---------- | -------------- | --------------- | ------------- | --------------- | ------------------ | ------------------------- | -------------------------- |
| ema alpha 0.1                   | 12         | 4.5            | 4.6 (4.6–6.7)   | 9.6 (9.6–19)  | 9.9             | 2.6× faster        | 2.1× faster               | 2.2× faster                |
| ema span 20 min 20              | 10         | 4.6            | 4.4             | 9.9 (9.5–16)  | 10 (9.4–13)     | 2.3× faster        | 2.2× faster               | 2.3× faster                |
| moving average 5m               | 1,862      | 25             | 27              | 27 (27–31)    | 29 (26–34)      | 69.0× faster       | 1.1× faster               | 1.1× faster                |
| moving average 5m centered skip | 1,998      | 25             | 25              | 25            | 26              | 80.2× faster       | same                      | same                       |
| moving average 5m, ranges       | 2,168      | 73             | 78              | –             | –               | 27.9× faster       | –                         | –                          |
| loess 0.05, 20k rows            | 138        | 76             | 20              | –             | –               | 7.0× faster        | –                         | –                          |
| loess 0.3, 5k rows              | 45         | 28             | 6.9             | –             | –               | 6.5× faster        | –                         | –                          |
| baseline 5m                     | 3,964      | 76             | 55              | 77            | 49              | 71.8× faster       | same                      | 1.1× slower                |
| outliers 5m                     | 1,976      | 73             | 56              | 81            | 51              | 35.5× faster       | 1.1× faster               | 1.1× slower                |
| scan sum                        | 37 (28–42) | 4.2            | 4.4 (4.1–6.3)   | 7.6           | 7.7             | 8.5× faster        | 1.8× faster               | 1.8× faster                |
| scan gain                       | 44         | 3.8 (3.2–4.2)  | 4.0 (3.6–6.8)   | –             | –               | 10.9× faster       | –                         | –                          |
| sample stride 10                | 21         | 1.2 (0.80–2.0) | 1.2 (1.2–1.5)   | 3.6 (3.3–4.3) | 1.6             | 17.6× faster       | 3.0× faster               | 1.3× faster                |
| sample reservoir 1000           | 16         | 1.5            | 1.5             | 0.10          | 0.60 (0.50–1.1) | 10.5× faster       | 15.0× slower              | 2.5× slower                |

### concat, collapse, pivot

Times in ms; median of 3 repeats (range when over ±15%).

| case                    | pond-ts       | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ----------------------- | ------------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| concat 10 x 100k        | 225           | 48 (40–54)     | 41 (40–48)      | 30            | 17             | 5.5× faster        | 1.6× slower               | 2.5× slower                |
| concat 1000 x 1k        | 366           | 51             | 50 (49–75)      | 68            | 24 (21–25)     | 7.3× faster        | 1.3× faster               | 2.1× slower                |
| collapse sum            | 150           | 37             | 37 (35–60)      | 2.0           | 2.9            | 4.1× faster        | 18.4× slower              | 12.6× slower               |
| collapse_keep sum       | 133           | 36             | 36 (35–64)      | 1.7 (1.2–2.0) | 2.0 (1.3–2.4)  | 3.6× faster        | 21.4× slower              | 18.2× slower               |
| pivot 100 hosts         | 564           | 76             | 51              | 365           | 80             | 11.0× faster       | 4.8× faster               | 1.6× faster                |
| pivot 4 hosts           | 791           | 53             | 51 (49–66)      | 86            | 30 (28–36)     | 15.5× faster       | 1.6× faster               | 1.7× slower                |
| pivot 100 hosts x2 avg  | 687           | 89 (88–109)    | 87              | 448 (380–476) | 104            | 7.9× faster        | 5.0× faster               | 1.2× faster                |
| pivot 100 hosts x2 last | 689 (483–693) | 89 (89–113)    | 87              | 412 (409–496) | 118            | 7.9× faster        | 4.6× faster               | 1.3× faster                |

### Binning by a number column (by_column, rolling_by_column)

Times in ms; median of 3 repeats (range when over ±15%).

| case                                        | pond-ts    | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------------------------- | ---------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| by_column width 10, 1000 bins               | 122        | 26 (21–26)     | 22              | 32            | 16             | 5.6× faster        | 1.2× faster               | 1.3× slower                |
| by_column 6 zones                           | 111        | 18             | 15 (15–21)      | 48            | 37 (36–53)     | 7.2× faster        | 2.7× faster               | 2.4× faster                |
| by_column histogram, 1251 bins              | 74 (71–96) | 29             | 28              | 20            | 14             | 2.7× faster        | 1.4× slower               | 2.0× slower                |
| by_column width 10, p5 p95                  | 509        | 44             | 31              | 79 (78–101)   | 30             | 16.5× faster       | 1.8× faster               | same                       |
| rolling_by_column radius 0.5, avg           | 317        | 47             | 42              | –             | –              | 7.5× faster        | –                         | –                          |
| rolling_by_column radius 0.5, p5 p95        | 841        | 193            | 102             | –             | –              | 8.2× faster        | –                         | –                          |
| rolling_by_column radius 5, p5 p95          | 1,160      | 369            | 204             | –             | –              | 5.7× faster        | –                         | –                          |
| rolling_by_column at 1000 centers, radius 5 | 144        | 52             | 32              | –             | –              | 4.4× faster        | –                         | –                          |

### ValueSeries (rows keyed by a number)

Times in ms; median of 3 repeats (range when over ±15%).

| case                        | pond-ts       | pond-rs 1 core  | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts  | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| --------------------------- | ------------- | --------------- | --------------- | ------------- | -------------- | ------------------- | ------------------------- | -------------------------- |
| by_value, 1M rows           | 39            | 5.1 (4.1–5.4)   | 4.4             | –             | –              | 9.0× faster         | –                         | –                          |
| nearest_index, 1M probes    | 341 (320–403) | 247             | 263 (259–341)   | –             | –              | 1.3× faster         | –                         | –                          |
| slice_by_value, 100k slices | 603           | 106             | 118 (95–122)    | –             | –              | 5.1× faster         | –                         | –                          |
| to_json rows, 300k          | 162           | 54              | 51              | –             | –              | 3.2× faster         | –                         | –                          |
| from_json rows, 300k        | 178 (176–215) | 107             | 106             | –             | –              | 1.7× faster         | –                         | –                          |
| to_columns_json, 300k       | 90 (81–105)   | 44              | 48              | –             | –              | 1.9× faster         | –                         | –                          |
| from_columns_json, 300k     | 80            | 64              | 65              | –             | –              | 1.2× faster         | –                         | –                          |
| to_arrow, 1M rows           | 0.00          | 0.80 (0.80–1.2) | 0.90 (0.80–1.1) | –             | –              | other under 0.05 ms | –                         | –                          |
| from_arrow, 1M rows         | 436           | 6.5 (5.7–8.7)   | 7.1 (6.3–10)    | –             | –              | 61.4× faster        | –                         | –                          |
| write_ipc, 1M rows          | 19 (17–24)    | 8.9             | 9.2             | –             | –              | 2.0× faster         | –                         | –                          |
| from_ipc_bytes, 1M rows     | 473           | 13              | 14              | –             | –              | 33.6× faster        | –                         | –                          |

### Reducers: aggregate / rolling / reduce

Times in ms; median of 3 repeats (range when over ±15%).

| case                     | pond-ts       | pond-rs 1 core | pond-rs 4 cores | polars 1 core       | polars 4 cores   | pond-rs vs pond-ts    | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------ | ------------- | -------------- | --------------- | ------------------- | ---------------- | --------------------- | ------------------------- | -------------------------- |
| min v, agg 1m            | 8.4 (7.6–11)  | 3.4 (2.2–3.7)  | 2.8 (2.2–3.0)   | 6.9                 | 10 (6.5–11)      | 3.0× faster           | 2.0× faster               | 3.6× faster                |
| min v, agg 1s            | 364           | 36             | 37              | 39                  | 33 (30–39)       | 9.8× faster           | 1.1× faster               | 1.1× slower                |
| min v, rolling 5m        | 214           | 16 (16–27)     | 16              | 40 (28–44)          | 29 (27–35)       | 13.7× faster          | 2.5× faster               | 1.9× faster                |
| min v, rolling 1d        | 219           | 22 (18–28)     | 16 (15–20)      | 32                  | 33               | 13.9× faster          | 1.5× faster               | 2.1× faster                |
| min v, reduce            | 2.3           | 1.4            | 1.2 (1.2–1.6)   | 0.60 (0.60–0.70)    | 0.70 (0.50–0.80) | 1.9× faster           | 2.3× slower               | 1.7× slower                |
| keep v, agg 1m           | 19 (19–24)    | 2.7            | 2.4 (2.0–3.4)   | 18                  | 8.9 (7.4–9.0)    | 8.0× faster           | 6.5× faster               | 3.7× faster                |
| keep v, agg 1s           | 456           | 42 (35–48)     | 40 (32–43)      | 86 (82–102)         | 55               | 11.4× faster          | 2.1× faster               | 1.4× faster                |
| keep v, rolling 5m       | 170           | 25             | 24              | 105                 | 60               | 7.1× faster           | 4.2× faster               | 2.5× faster                |
| keep v, rolling 1d       | 196 (189–241) | 23 (22–46)     | 22              | 101                 | 72               | 8.8× faster           | 4.4× faster               | 3.2× faster                |
| keep v, reduce           | 118           | 0.00           | 0.00            | 18                  | 12 (11–14)       | pond-rs under 0.05 ms | pond-rs under 0.05 ms     | pond-rs under 0.05 ms      |
| difference v, agg 1m     | 27 (27–45)    | 3.6 (3.5–4.6)  | 3.9 (3.1–3.9)   | 12 (10–17)          | 15 (11–18)       | 7.0× faster           | 3.2× faster               | 3.8× faster                |
| difference v, agg 1s     | 497           | 40             | 38              | 59 (48–62)          | 36               | 13.2× faster          | 1.5× faster               | same                       |
| difference v, rolling 5m | 348           | 31 (26–45)     | 26              | 60                  | 34 (32–46)       | 13.4× faster          | 1.9× faster               | 1.3× faster                |
| difference v, rolling 1d | 387           | 34 (26–40)     | 24 (24–30)      | 72 (68–93)          | 39               | 15.8× faster          | 2.1× faster               | 1.6× faster                |
| difference v, reduce     | 112           | 2.6            | 2.3             | 1.0 (1.0–1.2)       | 0.80             | 48.8× faster          | 2.6× slower               | 2.9× slower                |
| keep host, agg 1m        | 23            | 10             | 9.3 (9.3–17)    | 16 (16–21)          | 7.6              | 2.5× faster           | 1.5× faster               | 1.2× slower                |
| keep host, agg 1s        | 483           | 76             | 71              | 47 (38–49)          | 52 (36–54)       | 6.8× faster           | 1.6× slower               | 1.4× slower                |
| keep host, rolling 5m    | 168           | 59             | 51              | 74                  | 45               | 3.3× faster           | 1.3× faster               | 1.1× slower                |
| keep host, rolling 1d    | 173           | 57 (53–81)     | 50              | 87 (77–128)         | 51               | 3.5× faster           | 1.5× faster               | same                       |
| keep host, reduce        | 76 (74–89)    | 5.9            | 6.1             | 12 (9.1–15)         | 9.8              | 12.5× faster          | 1.9× faster               | 1.6× faster                |
| unique v, agg 1m         | 69            | 14 (13–23)     | 13              | 66 (54–74)          | 28               | 5.3× faster           | 4.7× faster               | 2.2× faster                |
| unique v, agg 1s         | 1,809         | 105            | 107             | 504                 | 153              | 16.9× faster          | 4.8× faster               | 1.4× faster                |
| unique v, rolling 5m     | 1,971         | 133            | 123             | 5,157               | 1,688            | 16.0× faster          | 38.7× faster              | 13.7× faster               |
| unique v, reduce         | 159           | 9.0 (9.0–16)   | 10 (8.6–13)     | 18                  | 15 (13–17)       | 15.5× faster          | 2.0× faster               | 1.5× faster                |
| unique host, agg 1m      | 47            | 15 (14–22)     | 18 (15–22)      | 42                  | 28               | 2.7× faster           | 2.9× faster               | 1.6× faster                |
| unique host, agg 1s      | 1,601         | 93             | 98              | 409                 | 163              | 16.3× faster          | 4.4× faster               | 1.7× faster                |
| unique host, rolling 5m  | 1,335         | 115            | 114 (108–131)   | 3,877               | 1,307            | 11.8× faster          | 33.7× faster              | 11.5× faster               |
| unique host, reduce      | 90            | 11             | 10              | 9.6                 | 10 (9.4–18)      | 8.8× faster           | 1.2× slower               | same                       |
| top3 v, agg 1m           | 98            | 16             | 13              | 59                  | 34               | 7.5× faster           | 3.8× faster               | 2.6× faster                |
| top3 v, agg 1s           | 3,031         | 115            | 107             | 498                 | 192              | 28.4× faster          | 4.3× faster               | 1.8× faster                |
| top3 v, rolling 5m       | 3,378         | 187            | 167             | 33,853              | 18,830           | 20.3× faster          | 181.3× faster             | 113.0× faster              |
| top3 v, reduce           | 187           | 10             | 12 (9.3–16)     | 15 (14–18)          | 17               | 14.9× faster          | 1.4× faster               | 1.4× faster                |
| top3 host, agg 1m        | 75 (66–90)    | 16             | 15 (15–25)      | 40 (38–56)          | 23 (23–29)       | 4.9× faster           | 2.5× faster               | 1.5× faster                |
| top3 host, agg 1s        | 2,648         | 97             | 96              | 412                 | 150              | 27.5× faster          | 4.3× faster               | 1.6× faster                |
| top3 host, rolling 5m    | 2,485         | 179            | 176             | 30,659              | 18,299           | 14.1× faster          | 171.4× faster             | 104.1× faster              |
| top3 host, reduce        | 97            | 11             | 11              | 16                  | 19               | 8.8× faster           | 1.5× faster               | 1.7× faster                |
| samples v, agg 1m        | 221           | 40             | 40              | 10                  | 8.1 (7.8–9.9)    | 5.6× faster           | 4.0× slower               | 4.9× slower                |
| samples v, agg 1s        | 1,987         | 100            | 101             | 71                  | 50               | 19.6× faster          | 1.4× slower               | 2.0× slower                |
| samples v, rolling 5m    | 76,473        | 7,307          | 7,212           | 4,517 (4,179–5,262) | 4,791            | 10.6× faster          | 1.6× slower               | 1.5× slower                |
| samples v, reduce        | 726           | 20             | 21              | 1.3 (1.1–1.6)       | 1.4 (1.4–1.7)    | 34.9× faster          | 15.1× slower              | 14.9× slower               |

### Array (list) columns, 100k rows

Times in ms; median of 3 repeats (range when over ±15%).

| case                     | pond-ts       | pond-rs 1 core   | pond-rs 4 cores  | polars 1 core    | polars 4 cores   | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------ | ------------- | ---------------- | ---------------- | ---------------- | ---------------- | ------------------ | ------------------------- | -------------------------- |
| typical contains         | 38            | 4.4              | 3.7 (3.6–4.8)    | 5.0 (4.7–9.6)    | 3.6 (3.3–4.6)    | 10.3× faster       | 1.1× faster               | same                       |
| typical containsAny      | 64            | 6.6 (5.6–8.1)    | 7.7 (4.9–7.8)    | 7.7              | 3.5 (2.7–4.3)    | 8.3× faster        | 1.2× faster               | 2.2× slower                |
| typical containsAll      | 41            | 4.4 (3.8–6.5)    | 4.5 (4.2–5.2)    | 7.0              | 3.0              | 9.1× faster        | 1.6× faster               | 1.5× slower                |
| typical aggregate count  | 282           | 4.8 (4.2–8.0)    | 4.9              | 0.20 (0.10–0.20) | 0.20 (0.10–0.20) | 57.5× faster       | 24.1× slower              | 24.5× slower               |
| typical aggregate avg    | 305           | 5.0 (4.6–7.2)    | 7.5 (4.8–7.8)    | 0.60 (0.50–0.60) | 0.50 (0.50–0.70) | 40.5× faster       | 8.4× slower               | 15.1× slower               |
| typical aggregate median | 322           | 6.3 (5.7–10)     | 6.0 (5.7–7.1)    | 12               | 11               | 53.6× faster       | 1.9× faster               | 1.9× faster                |
| typical aggregate first  | 352           | 3.0 (2.2–5.0)    | 3.7 (2.9–4.1)    | 0.70 (0.70–1.1)  | 0.80 (0.80–1.2)  | 94.3× faster       | 4.3× slower               | 4.7× slower                |
| typical explode tags     | 905           | 43 (34–49)       | 39               | 38               | 38               | 23.0× faster       | 1.2× slower               | same                       |
| typical explode nums     | 920           | 46               | 48 (46–56)       | 86               | 79               | 19.4× faster       | 1.9× faster               | 1.7× faster                |
| typical toJSON           | 111           | 59               | 50               | –                | –                | 2.2× faster        | –                         | –                          |
| typical fromJSON         | 440           | 169              | 170              | –                | –                | 2.6× faster        | –                         | –                          |
| typical toJSON object    | –             | 56 (53–67)       | 54               | 50               | 50               | –                  | 1.1× slower               | 1.1× slower                |
| typical fromJSON object  | –             | 189              | 196              | 175 (173–206)    | 182              | –                  | 1.1× slower               | 1.1× slower                |
| typical toArrow          | –             | 13               | 12               | 1.4              | 1.6 (1.4–2.1)    | –                  | 9.2× slower               | 7.5× slower                |
| typical fromArrow        | –             | 42               | 45               | 3.1              | 3.8 (3.0–3.9)    | –                  | 13.7× slower              | 11.9× slower               |
| typical writeIpc         | –             | 14               | 14               | 5.6              | 6.4              | –                  | 2.5× slower               | 2.2× slower                |
| typical readIpc          | –             | 46               | 55 (45–56)       | 5.6              | 9.7 (8.2–10)     | –                  | 8.2× slower               | 5.7× slower                |
| single contains          | 6.5           | 0.70             | 0.73 (0.69–0.95) | 1.0 (1.0–1.3)    | 0.80 (0.60–1.1)  | 8.9× faster        | 1.4× faster               | 1.1× faster                |
| single containsAny       | 28            | 2.2              | 2.4 (1.9–2.4)    | 4.1 (3.8–5.8)    | 1.9 (1.7–2.4)    | 11.5× faster       | 1.9× faster               | 1.3× slower                |
| single containsAll       | 7.0 (6.6–8.6) | 0.78 (0.76–0.98) | 0.76             | 2.1              | 1.3              | 9.2× faster        | 2.7× faster               | 1.7× faster                |
| single aggregate count   | 218           | 2.3              | 2.2              | 0.20             | 0.20             | 98.8× faster       | 11.5× slower              | 11.0× slower               |
| single aggregate avg     | 220           | 2.8              | 2.8              | 0.50             | 0.50 (0.40–0.50) | 78.8× faster       | 5.5× slower               | 5.6× slower                |
| single aggregate median  | 235           | 2.9              | 2.7              | 10 (9.8–18)      | 9.9              | 86.0× faster       | 3.6× faster               | 3.6× faster                |
| single aggregate first   | 251           | 1.2              | 1.1              | 0.60 (0.60–1.3)  | 0.70 (0.70–0.90) | 217.9× faster      | 2.0× slower               | 1.6× slower                |
| single explode tags      | 215           | 6.1              | 6.2              | 12 (11–16)       | 9.9              | 35.0× faster       | 1.9× faster               | 1.6× faster                |
| single explode nums      | 149           | 5.3              | 5.8 (5.3–7.5)    | 17               | 18 (14–19)       | 25.8× faster       | 3.2× faster               | 3.1× faster                |
| single toJSON            | 76            | 19 (18–30)       | 19 (19–34)       | –                | –                | 4.0× faster        | –                         | –                          |
| single fromJSON          | 345           | 96               | 98               | –                | –                | 3.5× faster        | –                         | –                          |
| single toJSON object     | –             | 22 (21–31)       | 22 (22–41)       | 25               | 26 (24–32)       | –                  | 1.2× faster               | 1.2× faster                |
| single fromJSON object   | –             | 129              | 128              | 113              | 105              | –                  | 1.1× slower               | 1.2× slower                |
| single toArrow           | –             | 4.2              | 5.8              | 0.50             | 0.50 (0.50–0.80) | –                  | 8.5× slower               | 11.5× slower               |
| single fromArrow         | –             | 25               | 28 (27–33)       | 1.1              | 1.4 (1.1–1.4)    | –                  | 22.7× slower              | 20.2× slower               |
| single writeIpc          | –             | 5.5 (5.0–7.5)    | 5.6              | 1.9 (1.6–2.0)    | 2.5              | –                  | 2.9× slower               | 2.2× slower                |
| single readIpc           | –             | 27               | 28               | 2.8              | 4.1 (3.4–5.2)    | –                  | 9.8× slower               | 6.7× slower                |

### JSON text in and out

Times in ms; median of 3 repeats (range when over ±15%).

| case                                              | pond-ts       | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------------------------------- | ------------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| dense numeric (100k x 6) to_json tuple            | 146 (142–171) | 40             | 37              | –             | –              | 3.9× faster        | –                         | –                          |
| dense numeric (100k x 6) to_json object           | 147           | 40             | 40 (39–50)      | 41            | 43 (38–75)     | 3.7× faster        | same                      | 1.1× faster                |
| dense numeric (100k x 6) from_json                | 138           | 70             | 70              | –             | –              | 2.0× faster        | –                         | –                          |
| dense numeric (100k x 6) from_json object         | –             | 98 (93–118)    | 96              | 150           | 156 (132–156)  | –                  | 1.5× faster               | 1.6× faster                |
| dense numeric (100k x 6) to_columns_json          | 76            | 38 (36–57)     | 34 (33–45)      | –             | –              | 2.2× faster        | –                         | –                          |
| dense numeric (100k x 6) from_columns_json        | 53 (52–78)    | 40 (37–47)     | 40 (37–64)      | –             | –              | 1.3× faster        | –                         | –                          |
| dense numeric (100k x 6) to_points_json           | 143           | 39             | 38              | –             | –              | 3.8× faster        | –                         | –                          |
| dense numeric (100k x 6) from_points_json         | 151           | 91             | 100             | –             | –              | 1.5× faster        | –                         | –                          |
| with a string column (100k x 7) to_json tuple     | 132           | 40             | 40              | –             | –              | 3.3× faster        | –                         | –                          |
| with a string column (100k x 7) to_json object    | 148           | 43 (43–69)     | 43              | 44            | 45 (44–58)     | 3.4× faster        | same                      | same                       |
| with a string column (100k x 7) from_json         | 150 (147–174) | 80             | 85              | –             | –              | 1.8× faster        | –                         | –                          |
| with a string column (100k x 7) from_json object  | –             | 106            | 109             | 181           | 183            | –                  | 1.7× faster               | 1.7× faster                |
| with a string column (100k x 7) to_columns_json   | 106 (103–124) | 38             | 37              | –             | –              | 2.8× faster        | –                         | –                          |
| with a string column (100k x 7) from_columns_json | 59            | 45             | 48 (46–57)      | –             | –              | 1.2× faster        | –                         | –                          |
| with a string column (100k x 7) to_points_json    | 141           | 41             | 43              | –             | –              | 3.3× faster        | –                         | –                          |
| with a string column (100k x 7) from_points_json  | 231 (204–268) | 102            | 111             | –             | –              | 2.1× faster        | –                         | –                          |
| ~10% gaps (100k x 6) to_json tuple                | 117           | 33             | 34              | –             | –              | 3.5× faster        | –                         | –                          |
| ~10% gaps (100k x 6) to_json object               | 137           | 36             | 35 (35–47)      | 39            | 44 (38–69)     | 3.9× faster        | 1.1× faster               | 1.2× faster                |
| ~10% gaps (100k x 6) from_json                    | 163           | 66             | 75              | –             | –              | 2.2× faster        | –                         | –                          |
| ~10% gaps (100k x 6) from_json object             | –             | 94 (93–119)    | 100             | 149           | 149            | –                  | 1.6× faster               | 1.5× faster                |
| ~10% gaps (100k x 6) to_columns_json              | 89            | 35 (34–44)     | 33              | –             | –              | 2.7× faster        | –                         | –                          |
| ~10% gaps (100k x 6) from_columns_json            | 55 (44–55)    | 41 (36–50)     | 40              | –             | –              | 1.4× faster        | –                         | –                          |
| ~10% gaps (100k x 6) to_points_json               | 122           | 36             | 36              | –             | –              | 3.4× faster        | –                         | –                          |
| ~10% gaps (100k x 6) from_points_json             | 198 (163–204) | 104 (86–105)   | 97              | –             | –              | 2.0× faster        | –                         | –                          |
| wide (10k x 41) to_json tuple                     | 29            | 14 (13–18)     | 13 (13–17)      | –             | –              | 2.2× faster        | –                         | –                          |
| wide (10k x 41) to_json object                    | 81            | 15 (14–18)     | 17              | 30 (29–43)    | 33             | 4.8× faster        | 2.0× faster               | 1.9× faster                |
| wide (10k x 41) from_json                         | 31            | 35 (30–51)     | 34 (32–40)      | –             | –              | 1.1× slower        | –                         | –                          |
| wide (10k x 41) from_json object                  | –             | 47             | 52              | 125           | 110            | –                  | 2.7× faster               | 2.1× faster                |
| wide (10k x 41) to_columns_json                   | 13 (13–22)    | 11             | 11              | –             | –              | 1.1× faster        | –                         | –                          |
| wide (10k x 41) from_columns_json                 | 8.5 (7.1–8.8) | 18             | 17 (16–25)      | –             | –              | 2.0× slower        | –                         | –                          |
| wide (10k x 41) to_points_json                    | 99 (76–106)   | 19             | 18 (18–30)      | –             | –              | 5.5× faster        | –                         | –                          |
| wide (10k x 41) from_points_json                  | 73            | 48             | 50 (48–59)      | –             | –              | 1.5× faster        | –                         | –                          |

## Not re-run here

- `examples/perf_text.rs` (text and true/false columns), `perf_decimal.rs`
  (decimal vs number columns) and `perf_slice.rs` compare pond-rs against
  itself or against one-off pond-ts runs with no committed script; their
  numbers stay in `docs/plans/PND_RUST_PLAN.md` (steps 2a, 2b, 2d).
- The agent trials (`agent-trial/`) measure how well agents write code
  against each library, not speed.
