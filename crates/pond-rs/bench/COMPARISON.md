# pond-rs vs pond-ts vs polars — benchmark comparison

Every speed comparison made while building pond-rs (R1a and R1b steps,
PRs #764–#806), re-run in one sitting on one machine, with polars added
wherever polars has a matching call. Run on 2026-10-21 at commit `6a42155`.

## Short answer

Counts below compare cases where both sides take at least 0.5 ms (a few
calls cost one side next to nothing, e.g. polars `shift`, which does not
copy the column, or pond-rs `keep` over a whole series, which stops at
the first differing value); those are in the tables but not in the counts.

- **pond-rs vs pond-ts:** pond-rs (4 cores) is faster in 171 of 174 cases
  (median **5.7× faster**; from 1.1× up to ~100× on grid, dedupe,
  smoothing and reducer work, and 12,000× on one pond-ts case that scans
  every row per bucket, [PND-ROLLGRID]). pond-ts is one thread, but most of
  these cases run on one core in pond-rs too: on 1 core pond-rs is faster
  in 169 of 174, same median. It is slower in:
  - outer join of two 1M-row series: 107 ms (85 on 1 core) vs 67 ms
    (pond-ts's join was already column-based, and pond-rs pays to touch
    fresh memory for the output; see step 6 in `PND_RUST_PLAN.md`);
  - JSON in on the wide 10k × 41 series (410,000 small whole numbers):
    `from_json` 54 ms (34 on 1 core) vs 30 ms and `from_columns_json` 19
    vs 7.8 ms. Step 8d2 found most of pond-rs's time there is parsing the
    text, and left a schema-typed reader undone;
  - on 1 core only, also: splitting 500k rows by symbol (42 vs 33 ms) and
    dense `from_columns_json` (58 vs 53 ms);
  - `ValueSeries.to_arrow` (not counted: pond-ts hands back views, 0 ms;
    pond-rs builds gap bits, 1.4 ms).
- **R1a workloads (the targets pond-rs was judged on):** on workload A
  pond-rs computes slightly faster than polars on 4 cores (128–139 vs
  134–166 ms) and the same on 1 core (353–378 vs 353–369 ms); pond-rs grows
  memory by 192 MB against polars' 256–281 MB. On B (12 daily buckets)
  polars is faster on 1 core (20–24 vs 30–37 ms compute) and they are even
  on 4 (10–11 ms each).
- **pond-rs vs polars, all other cases:** about even. On 4 cores each,
  pond-rs is faster in 61 cases, slower in 64, same in 2 (median ratio
  0.95: polars ~5% faster). On 1 core each, pond-rs is faster in 75,
  slower in 46, same in 5 (median: pond-rs ~25% faster).
  - pond-rs is much faster on: joins that keep every row (outer joins
    2.5–40×), pivots with many groups (1.3–2×; 5–6× on 1 core),
    per-entity `materialize` (2.4×), `unique` / `top3` reducers and `keep`
    on numbers (1.3–4×), JSON text (1.4–2.4×; polars' JSON is slow),
    `explode` (1.4–2.6×), EMA (1.7×).
  - polars is much faster on: simple column arithmetic (`diff`, `filter`,
    `map`: 2–6×), `collapse` (14×: pond calls a function once a row,
    polars adds two columns in one vectorised step), row-count windows per
    entity (4×), `align` hold onto a 1 s grid (5×), list-column Arrow in
    and out and `len` / `mean` / `first` of lists (2–26×), `concat`
    (2–4×), left and inner joins (2×).

All three libraries give the same answers on the cases checked (below).

## How this was measured

- Machine: 4-core cloud container, Intel Xeon @ 2.80 GHz, 15 GB RAM.
  Node 22.22, Rust 1.97 (release builds), polars 2.0.0 (Python API; the
  work runs in polars' Rust engine, and the Python call overhead is
  microseconds per call). Nothing else ran during the timed runs.
- Each runner builds the same data (same generators, same values), runs
  each case once to warm up (pond-ts: see below) and then 7 times (pond-rs
  and pond-ts use 9 for arrays and JSON), and reports the median. Every family ran **3 times** (3 separate processes
  per engine); each cell below is the median of the 3, with the range in
  brackets when it spans more than ±15%.
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
- **Same answers:** the R1a runner checks pond-rs equals pond-ts to the
  bit and pond-ts matches polars within 1e-9 (no check failed in any of
  the 3 repeats). For the other families, pond-rs and pond-ts print a
  checksum per case (rows, present values, their sum) and the polars
  scripts print the same; they match for every polars case in the row-by-
  row, per-entity, grid, join, rolling, smoothing, reshape and binning
  families, except the reservoir sample (random picks). The reducer,
  array and JSON families print no per-case checksum in pond-rs, so their
  polars answers are **not** cross-checked.
- **What "polars" means per case:** the closest polars call or short
  combination of calls, chosen to be what someone fluent in polars would
  write; where a first version was slow, the faster form is used (each
  script's header says which). Cases with no polars counterpart show "–"
  (leading or centred time windows, loess, custom `scan`, rolling list
  reducers, `rolling_by_column`, `ValueSeries`, pond's columns / points
  JSON), as do cases where polars' rule differs from pond's (pond's
  minimum-rows counts rows, polars' `min_samples` counts present values).
- Cases timed on pond-rs alone (decimal columns, tiny JSON inputs) are
  left out of the tables.

To reproduce:

```
npm run build --workspace=pond-ts
PYTHON=/path/to/python crates/pond-rs/bench/run.sh            # R1a A and B
OUT=/tmp/cmp PYTHON=/path/to/python crates/pond-rs/bench/compare_all.sh 3
python crates/pond-rs/bench/collect.py /tmp/cmp                # tables below
```

## R1a workloads A and B

1M rows, 4 number columns with ~5% gaps, read from and written to Arrow IPC
(details in [README.md](README.md)). Ranges over 3 full repeats, each the
median of 7 runs.

| workload | engine           | read ms | compute ms | write ms | total ms  | memory growth MB |
| -------- | ---------------- | ------- | ---------- | -------- | --------- | ---------------- |
| A        | pond-ts          | 31–35   | 2066–2118  | 114–121  | 2206–2271 | 358–363          |
| A        | pond-rs, 1 core  | 21–26   | 353–378    | 69–81    | 442–483   | 192              |
| A        | pond-rs, 4 cores | 34–35   | 128–139    | 65–73    | 227–254   | 192              |
| A        | polars, 1 core   | 13–16   | 353–369    | 62–69    | 433–447   | 256              |
| A        | polars, 4 cores  | 17–29   | 134–166    | 61–66    | 227–259   | 280–281          |
| B        | pond-ts          | 44–51   | 52–64      | 1.7–2.0  | 97–127    | 84–86            |
| B        | pond-rs, 1 core  | 17–19   | 30–37      | 0.1      | 47–57     | 78               |
| B        | pond-rs, 4 cores | 16–18   | 10–11      | 0.1      | 26–30     | 78               |
| B        | polars, 1 core   | 14–15   | 20–24      | 1.0–1.9  | 35–43     | 110              |
| B        | polars, 4 cores  | 16–18   | 10–11      | 1.1      | 28–30     | 111–112          |

From the medians: pond-rs computes A 16× faster than pond-ts on 4 cores
(5.7× on 1) and B 5.5× faster (1.8× on 1). Against the R1a targets:
≥2× pond-ts single-core is met on A (5.7× compute, 4.8× total) but **not on
B's compute (1.8×)**; B's total time, with reading and writing, is 2.2×.
Within 1.25× of polars multi-core: met (pond-rs takes 0.84× polars' time
on A's compute, 0.96× on B's). Memory growth no more than 1-thread polars:
met (192 vs 256 MB).

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
- **`diff` itself.** pond-rs checks each pair of values for gaps before
  subtracting (a gap is NaN): that loop takes 2.6 ms; the same subtraction
  without the checks takes 0.6 ms. Copying the time key into the new
  series adds 0.6 ms. polars keeps gaps in a separate bit list, so it
  subtracts straight through and combines the bit lists afterwards.
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
  (`shift` 55.6 → 10 ms, `fill` hold 51.8 → 12, linear 75.1 → 20): the
  [PND-BOXFREE] fix (#776) landed after that table.
- **pond-rs `from_json`** on the dense 100k × 6 series takes 74–83 ms
  here; step 8d2's table said 45 ms. Built at that step's commit
  (`44c4723`, #793) on this machine it takes 75–91 ms, so the code has not
  got slower; the 45 ms does not reproduce here.
- **R1a A, polars 4 cores** computes in 134–166 ms here against 209–231 ms
  in step 4's table, so pond-rs's lead there (141–159 vs 209–231) is now
  a tie. pond-rs's own numbers are about the same as then. The two tables
  were run in different sessions on cloud machines that differ run to run
  (this README notes a first machine ~40% faster than a second), so only
  compare numbers within one table.

## Results by family

The polars join rows were re-run (3 repeats) after review found a faster
polars form for the 1M × 1M outer join; see `polars/bench_join.py`.

### Row-by-row operations (1M rows)

Times in ms; median of 3 repeats (range when over ±15%).

| case                     | pond-ts       | pond-rs 1 core | pond-rs 4 cores  | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------ | ------------- | -------------- | ---------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| diff                     | 9.6 (7.3–13)  | 5.8            | 5.9              | 2.1 (1.6–2.1) | 2.2 (2.0–2.6)  | 1.6× faster        | 2.8× slower               | 2.7× slower                |
| diff drop                | 11 (8.0–16)   | 7.4            | 7.0              | 2.0           | 2.3            | 1.6× faster        | 3.7× slower               | 3.0× slower                |
| rate                     | 16 (14–20)    | 6.6 (6.3–9.2)  | 6.3              | 9.7           | 10             | 2.6× faster        | 1.5× faster               | 1.6× faster                |
| pct_change               | 11 (8.9–12)   | 6.0 (5.6–8.0)  | 5.8              | 4.1           | 4.5            | 1.9× faster        | 1.5× slower               | 1.3× slower                |
| cumulative sum           | 15 (13–16)    | 6.7 (6.2–7.9)  | 6.8              | 7.0 (6.8–9.0) | 7.0            | 2.2× faster        | same                      | same                       |
| shift 1                  | 10 (8.6–13)   | 7.6            | 7.8              | 0.00          | 0.20           | 1.3× faster        | other under 0.05 ms       | 39.0× slower               |
| fill hold                | 12            | 7.9 (7.9–11)   | 8.3              | 5.6           | 5.7 (5.7–7.4)  | 1.5× faster        | 1.4× slower               | 1.5× slower                |
| fill linear              | 20 (14–21)    | 8.9 (8.8–12)   | 9.2              | 6.3           | 6.2 (6.2–9.0)  | 2.2× faster        | 1.4× slower               | 1.5× slower                |
| fill linear maxGap 3s    | 19            | 7.8 (7.8–10)   | 7.9 (7.9–9.9)    | –             | –              | 2.4× faster        | –                         | –                          |
| filter v > 500 (by name) | 42            | 17             | 18 (17–29)       | 3.4 (3.2–4.7) | 2.8            | 2.4× faster        | 5.0× slower               | 6.3× slower                |
| map_numbers v \* 2       | 7.8 (5.7–8.5) | 3.2            | 3.7              | 1.7           | 1.6            | 2.1× faster        | 1.9× slower               | 2.3× slower                |
| with_column              | 6.1 (5.0–7.3) | 0.70           | 0.70 (0.70–1.2)  | 0.00          | 0.00           | 8.7× faster        | other under 0.05 ms       | other under 0.05 ms        |
| slice middle half        | 0.00          | 0.30           | 0.30 (0.30–0.40) | 0.00          | 0.00           | both <0.5 ms       | both <0.5 ms              | both <0.5 ms               |

### Per-entity work: 500 symbols × 1000 bars

Times in ms; median of 3 repeats (range when over ±15%).

| case                                        | pond-ts       | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------------------------- | ------------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| split                                       | 33 (31–44)    | 42             | 26 (25–38)      | 52            | 32             | 1.3× faster        | 1.2× faster               | 1.2× faster                |
| diff + collect                              | 694 (669–815) | 86             | 62              | 34 (26–40)    | 26 (25–33)     | 11.1× faster       | 2.6× slower               | 2.4× slower                |
| fill linear + collect                       | 673           | 89 (83–119)    | 70 (59–74)      | 29            | 22 (19–27)     | 9.6× faster        | 3.0× slower               | 3.2× slower                |
| rolling 60m mean/sd + collect               | 1,415         | 163            | 80              | 79            | 68             | 17.6× faster       | 2.1× slower               | 1.2× slower                |
| Q11: rolling 60m, last z per symbol, top 20 | 1,545         | 118            | 52              | 94            | 81 (77–107)    | 29.8× faster       | 1.3× slower               | 1.6× faster                |

### Putting rows on a time grid: align, materialize, dedupe

Times in ms; median of 3 repeats (range when over ±15%).

| case                                       | pond-ts         | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------------------------ | --------------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| align hold 1m (1M rows)                    | 86 (67–88)      | 2.8            | 4.0 (2.9–4.6)   | 3.4 (2.4–3.4) | 2.7            | 21.4× faster       | 1.2× faster               | 1.5× slower                |
| align hold 1s (1M rows)                    | 3,750           | 46 (46–55)     | 46 (43–56)      | 15 (12–17)    | 8.7            | 82.2× faster       | 3.1× slower               | 5.2× slower                |
| align linear 1s (1M rows)                  | 978 (866–1,220) | 72             | 75              | 54            | 42             | 13.0× faster       | 1.3× slower               | 1.8× slower                |
| align hold 1s (10k rows, 1M buckets)       | 2,514           | 23             | 23              | 10 (9.7–16)   | 10 (8.1–11)    | 110.2× faster      | 2.2× slower               | 2.2× slower                |
| materialize last 1s (1M rows)              | 850             | 29             | 28              | 60            | 50             | 30.3× faster       | 2.1× faster               | 1.8× faster                |
| materialize nearest 1m (1M rows)           | 41 (38–76)      | 5.8 (4.0–6.0)  | 4.1             | 5.1 (3.1–8.1) | 3.7 (3.3–4.3)  | 9.9× faster        | 1.1× slower               | 1.1× slower                |
| materialize last 1s (10k rows, 1M buckets) | 947 (737–966)   | 33 (23–37)     | 23 (23–31)      | 20 (17–21)    | 13             | 40.5× faster       | 1.6× slower               | 1.8× slower                |
| dedupe last (1M rows, 10% repeats)         | 1,631           | 22 (21–27)     | 22              | 16 (16–22)    | 10             | 73.5× faster       | 1.3× slower               | 2.2× slower                |
| dedupe max v (1M rows, 10% repeats)        | 1,832           | 22 (22–32)     | 23              | 106 (97–122)  | 50 (42–59)     | 79.6× faster       | 4.7× faster               | 2.2× faster                |
| panel: align 1m per symbol + collect       | 2,371           | 130 (104–137)  | 92              | 140           | 61             | 25.9× faster       | 1.1× faster               | 1.5× slower                |
| panel: materialize 1m per symbol + collect | 1,473           | 109            | 78 (68–91)      | 370           | 188            | 18.9× faster       | 3.4× faster               | 2.4× faster                |
| panel: dedupe per symbol + collect         | 1,364           | 102            | 66 (55–76)      | 116 (97–128)  | 78             | 20.7× faster       | 1.1× faster               | 1.2× faster                |

### Joins on time

Times in ms; median of 3 repeats (range when over ±15%).

| case                          | pond-ts    | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ----------------------------- | ---------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| left join, 1M x 1M, 1/3 match | 21         | 18 (16–22)     | 18 (16–23)      | 14            | 8.5 (6.5–9.4)  | 1.1× faster        | 1.3× slower               | 2.2× slower                |
| inner join, 1M x 1M           | 21 (20–25) | 14 (13–19)     | 12              | 13            | 6.0            | 1.7× faster        | 1.1× slower               | 2.1× slower                |
| outer join, 1M x 1M           | 67         | 85 (84–99)     | 107 (85–119)    | 474           | 268 (240–322)  | 1.6× slower        | 5.6× faster               | 2.5× faster                |
| left join, 1M x 10k sparse    | 23 (23–32) | 13             | 13              | 14            | 10 (8.2–12)    | 1.8× faster        | same                      | 1.3× slower                |
| outer join, same keys         | 7.6        | 5.7 (4.5–6.3)  | 4.3             | 274           | 172            | 1.8× faster        | 48.0× faster              | 40.1× faster               |
| joinMany 3 on same keys       | 17         | 12 (11–14)     | 10 (10–15)      | 541           | 385            | 1.7× faster        | 46.2× faster              | 38.1× faster               |

### Rolling windows

Times in ms; median of 3 repeats (range when over ±15%).

| case                       | pond-ts       | pond-rs 1 core  | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| -------------------------- | ------------- | --------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| time 5m avg trailing       | 249           | 24 (24–31)      | 27              | 31            | 33 (32–51)     | 9.4× faster        | 1.3× faster               | 1.2× faster                |
| time 5m avg leading        | 232           | 24              | 28              | –             | –              | 8.4× faster        | –                         | –                          |
| time 5m avg centered       | 257           | 24              | 28 (24–29)      | –             | –              | 9.1× faster        | –                         | –                          |
| time 5m stdev centered     | 288 (228–299) | 41              | 41 (40–59)      | –             | –              | 7.0× faster        | –                         | –                          |
| time 5m avg min 300        | 359           | 24              | 24 (23–30)      | –             | –              | 15.2× faster       | –                         | –                          |
| rows 20 avg                | 49 (38–49)    | 26              | 26              | 10            | 10             | 1.9× faster        | 2.5× slower               | 2.6× slower                |
| rows 20 avg min 20         | 30 (23–33)    | 23              | 23              | –             | –              | 1.3× faster        | –                         | –                          |
| rows 20 stdev              | 60            | 54              | 50 (49–61)      | 30 (23–35)    | 24             | 1.2× faster        | 1.8× slower               | 2.1× slower                |
| rows 300 avg centered      | 43 (28–44)    | 24              | 25              | 10 (9.9–16)   | 19 (9.7–22)    | 1.7× faster        | 2.4× slower               | 1.3× slower                |
| rows 20 avg by host        | 2,348         | 214             | 159             | 43            | 37             | 14.8× faster       | 5.0× slower               | 4.3× slower                |
| grid 1m, 5m avg, 100k rows | 8,601         | 0.60 (0.60–1.2) | 0.70 (0.60–1.2) | 2.4 (2.4–3.2) | 2.8            | 12286.7× faster    | 4.0× faster               | 4.0× faster                |
| grid 1m, 5m avg, 1M rows   | –             | 7.3             | 12 (7.4–12)     | 16 (16–19)    | 16             | –                  | 2.2× faster               | 1.4× faster                |
| grid 1s, 5m avg, 1M rows   | –             | 305 (235–343)   | 262 (244–307)   | 160           | 162            | –                  | 1.9× slower               | 1.6× slower                |

### Smoothing, baseline, outliers, scan, sample

Times in ms; median of 3 repeats (range when over ±15%).

| case                            | pond-ts             | pond-rs 1 core | pond-rs 4 cores | polars 1 core    | polars 4 cores   | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------------- | ------------------- | -------------- | --------------- | ---------------- | ---------------- | ------------------ | ------------------------- | -------------------------- |
| ema alpha 0.1                   | 13                  | 6.1            | 6.5             | 10               | 11 (11–13)       | 2.0× faster        | 1.7× faster               | 1.7× faster                |
| ema span 20 min 20              | 15 (12–19)          | 6.0            | 6.3             | 11 (10–21)       | 12 (11–20)       | 2.4× faster        | 1.8× faster               | 1.8× faster                |
| moving average 5m               | 2,216 (1,871–2,237) | 30             | 27              | 37 (27–54)       | 38 (30–51)       | 82.1× faster       | 1.2× faster               | 1.4× faster                |
| moving average 5m centered skip | 2,099               | 27             | 29              | –                | –                | 72.4× faster       | –                         | –                          |
| moving average 5m, ranges       | 2,406               | 83             | 79 (74–91)      | –                | –                | 30.5× faster       | –                         | –                          |
| loess 0.05, 20k rows            | 160                 | 73 (70–90)     | 20              | –                | –                | 7.9× faster        | –                         | –                          |
| loess 0.3, 5k rows              | 50 (45–62)          | 27             | 8.0             | –                | –                | 6.2× faster        | –                         | –                          |
| baseline 5m                     | 4,477               | 81             | 60              | 85               | 59 (49–64)       | 74.6× faster       | same                      | same                       |
| outliers 5m                     | 2,600 (2,102–2,819) | 80             | 58              | 94 (89–134)      | 46               | 45.2× faster       | 1.2× faster               | 1.2× slower                |
| scan sum                        | 34 (34–101)         | 6.3            | 6.2             | 8.0              | 7.8              | 5.5× faster        | 1.3× faster               | 1.3× faster                |
| scan gain                       | 66 (46–66)          | 6.8 (5.7–7.1)  | 6.3             | –                | –                | 10.5× faster       | –                         | –                          |
| sample stride 10                | 36 (26–44)          | 2.1 (2.0–2.5)  | 1.9             | 4.4 (4.3–5.3)    | 2.4 (1.9–2.5)    | 18.7× faster       | 2.1× faster               | 1.3× faster                |
| sample reservoir 1000           | 26 (15–33)          | 1.7 (1.5–2.7)  | 1.5             | 0.10 (0.00–0.10) | 0.20 (0.20–0.30) | 17.5× faster       | 17.0× slower              | 7.5× slower                |

### concat, collapse, pivot

Times in ms; median of 3 repeats (range when over ±15%).

| case                    | pond-ts           | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ----------------------- | ----------------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| concat 10 x 100k        | 236               | 57             | 74 (48–93)      | 38 (35–52)    | 19 (16–20)     | 3.2× faster        | 1.5× slower               | 3.9× slower                |
| concat 1000 x 1k        | 449 (373–451)     | 61             | 59 (56–79)      | 74            | 27             | 7.7× faster        | 1.2× faster               | 2.2× slower                |
| collapse sum            | 169               | 40 (40–47)     | 40 (38–48)      | 3.0           | 2.9            | 4.2× faster        | 13.4× slower              | 13.9× slower               |
| collapse_keep sum       | 140 (134–172)     | 43 (41–50)     | 41              | 2.8 (2.5–3.5) | 2.8            | 3.4× faster        | 15.3× slower              | 14.6× slower               |
| pivot 100 hosts         | 1,009 (652–1,098) | 83 (75–109)    | 60 (56–80)      | 522 (418–528) | 122            | 16.7× faster       | 6.3× faster               | 2.0× faster                |
| pivot 4 hosts           | 963               | 64 (52–64)     | 51              | 86            | 36             | 18.9× faster       | 1.3× faster               | 1.4× slower                |
| pivot 100 hosts x2 avg  | 698               | 97 (90–135)    | 99              | 586           | 144            | 7.0× faster        | 6.0× faster               | 1.5× faster                |
| pivot 100 hosts x2 last | 620 (554–1,013)   | 97 (88–138)    | 103 (85–110)    | 493 (492–574) | 134            | 6.0× faster        | 5.1× faster               | 1.3× faster                |

### Binning by a number column (by_column, rolling_by_column)

Times in ms; median of 3 repeats (range when over ±15%).

| case                                        | pond-ts       | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------------------------- | ------------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| by_column width 10, 1000 bins               | 125 (115–177) | 32             | 28 (26–38)      | 32            | 18             | 4.5× faster        | same                      | 1.5× slower                |
| by_column 6 zones                           | 117           | 26             | 20              | 54 (46–66)    | 48 (39–51)     | 5.7× faster        | 2.0× faster               | 2.4× faster                |
| by_column histogram, 1251 bins              | 79 (68–92)    | 50 (34–50)     | 33 (32–39)      | 26            | 15             | 2.4× faster        | 1.9× slower               | 2.2× slower                |
| by_column width 10, p5 p95                  | 513           | 54             | 44              | 87 (83–107)   | 36             | 11.8× faster       | 1.6× faster               | 1.2× slower                |
| rolling_by_column radius 0.5, avg           | 307           | 50             | 49              | –             | –              | 6.3× faster        | –                         | –                          |
| rolling_by_column radius 0.5, p5 p95        | 934           | 195            | 118             | –             | –              | 7.9× faster        | –                         | –                          |
| rolling_by_column radius 5, p5 p95          | 1,235         | 388            | 201 (200–241)   | –             | –              | 6.1× faster        | –                         | –                          |
| rolling_by_column at 1000 centers, radius 5 | 149           | 58             | 39              | –             | –              | 3.8× faster        | –                         | –                          |

### ValueSeries (rows keyed by a number)

Times in ms; median of 3 repeats (range when over ±15%).

| case                        | pond-ts       | pond-rs 1 core  | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts  | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| --------------------------- | ------------- | --------------- | --------------- | ------------- | -------------- | ------------------- | ------------------------- | -------------------------- |
| by_value, 1M rows           | 44 (39–67)    | 5.7 (5.7–6.6)   | 5.3             | –             | –              | 8.4× faster         | –                         | –                          |
| nearest_index, 1M probes    | 412 (380–475) | 310             | 346 (288–348)   | –             | –              | 1.2× faster         | –                         | –                          |
| slice_by_value, 100k slices | 704           | 138 (128–186)   | 128 (121–149)   | –             | –              | 5.5× faster         | –                         | –                          |
| to_json rows, 300k          | 199 (168–202) | 52              | 48              | –             | –              | 4.2× faster         | –                         | –                          |
| from_json rows, 300k        | 215 (186–267) | 106             | 130 (112–150)   | –             | –              | 1.6× faster         | –                         | –                          |
| to_columns_json, 300k       | 85 (78–106)   | 45              | 48 (44–71)      | –             | –              | 1.8× faster         | –                         | –                          |
| from_columns_json, 300k     | 78 (72–99)    | 65              | 70              | –             | –              | 1.1× faster         | –                         | –                          |
| to_arrow, 1M rows           | 0.00          | 0.90 (0.90–1.4) | 1.4 (1.1–1.8)   | –             | –              | other under 0.05 ms | –                         | –                          |
| from_arrow, 1M rows         | 445 (436–523) | 9.2             | 10              | –             | –              | 44.5× faster        | –                         | –                          |
| write_ipc, 1M rows          | 17 (16–27)    | 9.8 (9.2–11)    | 10              | –             | –              | 1.7× faster         | –                         | –                          |
| from_ipc_bytes, 1M rows     | 536 (434–662) | 15              | 15              | –             | –              | 35.5× faster        | –                         | –                          |

### Reducers: aggregate / rolling / reduce

Times in ms; median of 3 repeats (range when over ±15%).

| case                     | pond-ts                 | pond-rs 1 core | pond-rs 4 cores | polars 1 core   | polars 4 cores | pond-rs vs pond-ts    | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------ | ----------------------- | -------------- | --------------- | --------------- | -------------- | --------------------- | ------------------------- | -------------------------- |
| min v, agg 1m            | 7.5                     | 3.3 (3.0–3.8)  | 3.6 (3.6–4.8)   | 8.7             | 7.2 (7.0–10)   | 2.1× faster           | 2.6× faster               | 2.0× faster                |
| min v, agg 1s            | 442                     | 39             | 37              | 44 (36–56)      | 29             | 11.9× faster          | 1.1× faster               | 1.3× slower                |
| min v, rolling 5m        | 231                     | 25 (19–26)     | 18 (18–28)      | 50 (28–57)      | 31             | 12.5× faster          | 2.0× faster               | 1.7× faster                |
| min v, rolling 1d        | 218                     | 20 (19–32)     | 19              | 32              | 35             | 11.7× faster          | 1.6× faster               | 1.9× faster                |
| min v, reduce            | 2.6 (2.6–6.2)           | 2.0 (1.6–2.1)  | 1.7 (1.7–2.0)   | 0.90 (0.60–1.5) | 1.0 (0.80–1.1) | 1.5× faster           | 2.2× slower               | 1.7× slower                |
| keep v, agg 1m           | 19 (19–25)              | 3.2 (2.8–3.7)  | 3.4 (3.1–4.0)   | 16 (16–26)      | 13 (8.5–16)    | 5.6× faster           | 5.2× faster               | 3.9× faster                |
| keep v, agg 1s           | 473                     | 40 (38–56)     | 47 (36–51)      | 105             | 60             | 10.1× faster          | 2.6× faster               | 1.3× faster                |
| keep v, rolling 5m       | 221                     | 32 (26–41)     | 26 (25–39)      | 97 (89–147)     | 87             | 8.6× faster           | 3.0× faster               | 3.4× faster                |
| keep v, rolling 1d       | 212                     | 26 (26–34)     | 37 (35–43)      | 110 (97–141)    | 94 (75–103)    | 5.7× faster           | 4.1× faster               | 2.5× faster                |
| keep v, reduce           | 130 (113–150)           | 0.00           | 0.00            | 21              | 16             | pond-rs under 0.05 ms | pond-rs under 0.05 ms     | pond-rs under 0.05 ms      |
| difference v, agg 1m     | 37 (28–49)              | 4.4            | 6.6             | 13 (11–15)      | 12 (11–18)     | 5.7× faster           | 2.9× faster               | 1.7× faster                |
| difference v, agg 1s     | 506 (477–631)           | 46 (40–54)     | 39              | 52 (49–64)      | 37             | 12.9× faster          | 1.1× faster               | 1.1× slower                |
| difference v, rolling 5m | 368                     | 44 (28–48)     | 27 (27–45)      | 66 (56–86)      | 43 (31–44)     | 13.5× faster          | 1.5× faster               | 1.6× faster                |
| difference v, rolling 1d | 414                     | 28 (28–54)     | 28 (26–54)      | 84 (77–98)      | 56 (36–64)     | 14.7× faster          | 3.0× faster               | 2.0× faster                |
| difference v, reduce     | 128                     | 3.3 (2.7–3.8)  | 3.4 (2.8–4.1)   | 2.4 (2.3–2.9)   | 1.0 (0.80–1.6) | 37.7× faster          | 1.4× slower               | 3.4× slower                |
| keep host, agg 1m        | 27 (24–36)              | 11 (10–15)     | 11 (10–16)      | 15              | 7.5 (7.0–9.1)  | 2.4× faster           | 1.4× faster               | 1.5× slower                |
| keep host, agg 1s        | 568 (530–764)           | 87 (81–104)    | 76 (65–94)      | 50 (39–57)      | 35             | 7.5× faster           | 1.7× slower               | 2.1× slower                |
| keep host, rolling 5m    | 172 (170–210)           | 70 (58–88)     | 77 (55–80)      | –               | –              | 2.2× faster           | –                         | –                          |
| keep host, rolling 1d    | 198                     | 61 (53–76)     | 55 (51–77)      | –               | –              | 3.6× faster           | –                         | –                          |
| keep host, reduce        | 85                      | 6.4 (6.2–14)   | 7.1             | 11              | 9.8            | 12.0× faster          | 1.8× faster               | 1.4× faster                |
| unique v, agg 1m         | 74                      | 15 (14–22)     | 18 (15–42)      | 68 (57–80)      | 33             | 4.2× faster           | 4.6× faster               | 1.8× faster                |
| unique v, agg 1s         | 1,936                   | 106            | 92 (91–115)     | 465             | 154            | 21.1× faster          | 4.4× faster               | 1.7× faster                |
| unique v, rolling 5m     | 2,142                   | 129            | 159             | –               | –              | 13.5× faster          | –                         | –                          |
| unique v, reduce         | 447                     | 11 (10–19)     | 12 (10–16)      | 21 (21–31)      | 16             | 37.2× faster          | 2.0× faster               | 1.3× faster                |
| unique host, agg 1m      | 55 (52–71)              | 16 (16–24)     | 19 (16–26)      | 64 (45–71)      | 30             | 3.0× faster           | 4.1× faster               | 1.6× faster                |
| unique host, agg 1s      | 1,821                   | 105            | 95              | 452             | 176            | 19.2× faster          | 4.3× faster               | 1.9× faster                |
| unique host, rolling 5m  | 1,563 (1,420–1,891)     | 156 (121–167)  | 175 (147–176)   | –               | –              | 8.9× faster           | –                         | –                          |
| unique host, reduce      | 256 (101–293)           | 11 (11–13)     | 16 (11–21)      | 11 (9.6–19)     | 11 (10–20)     | 15.6× faster          | 1.1× slower               | 1.5× slower                |
| top3 v, agg 1m           | 124 (96–158)            | 14             | 26 (15–31)      | 56              | 37             | 4.8× faster           | 3.9× faster               | 1.4× faster                |
| top3 v, agg 1s           | 3,291                   | 112            | 108             | 428             | 159            | 30.3× faster          | 3.8× faster               | 1.5× faster                |
| top3 v, rolling 5m       | 3,898                   | 201 (190–246)  | 242 (174–275)   | –               | –              | 16.1× faster          | –                         | –                          |
| top3 v, reduce           | 455 (257–516)           | 12 (12–18)     | 11              | 14 (14–20)      | 15 (14–20)     | 41.8× faster          | 1.1× faster               | 1.4× faster                |
| top3 host, agg 1m        | 73                      | 17             | 18 (17–22)      | 55 (46–61)      | 26             | 4.1× faster           | 3.3× faster               | 1.5× faster                |
| top3 host, agg 1s        | 3,115                   | 99 (97–115)    | 97              | 477             | 162            | 32.2× faster          | 4.8× faster               | 1.7× faster                |
| top3 host, rolling 5m    | 2,713                   | 193            | 188             | –               | –              | 14.4× faster          | –                         | –                          |
| top3 host, reduce        | 262 (126–278)           | 13 (12–20)     | 15 (14–20)      | 21 (20–27)      | 27 (20–29)     | 17.1× faster          | 1.6× faster               | 1.8× faster                |
| samples v, agg 1m        | 246                     | 47 (45–59)     | 51              | 12 (10–14)      | 11             | 4.9× faster           | 3.8× slower               | 4.7× slower                |
| samples v, agg 1s        | 2,226                   | 98             | 104 (100–122)   | 79 (79–104)     | 56             | 21.5× faster          | 1.2× slower               | 1.9× slower                |
| samples v, rolling 5m    | 81,919 (80,924–100,749) | 15,796         | 15,457          | –               | –              | 5.3× faster           | –                         | –                          |
| samples v, reduce        | 835                     | 30 (21–35)     | 21              | 2.0             | 2.0            | 39.6× faster          | 15.2× slower              | 10.6× slower               |

### Array (list) columns, 100k rows

Times in ms; median of 3 repeats (range when over ±15%).

| case                     | pond-ts       | pond-rs 1 core | pond-rs 4 cores | polars 1 core    | polars 4 cores   | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------ | ------------- | -------------- | --------------- | ---------------- | ---------------- | ------------------ | ------------------------- | -------------------------- |
| typical contains         | 41            | 5.5 (5.5–7.0)  | 6.8             | 7.2 (5.2–8.3)    | 3.3 (3.0–3.8)    | 6.0× faster        | 1.3× faster               | 2.0× slower                |
| typical containsAny      | 68            | 8.4            | 11 (8.4–13)     | 9.2 (8.1–12)     | 3.6 (3.4–4.8)    | 6.1× faster        | 1.1× faster               | 3.1× slower                |
| typical containsAll      | 43            | 6.2            | 7.9 (6.0–8.2)   | 8.7 (7.6–11)     | 3.5              | 5.5× faster        | 1.4× faster               | 2.2× slower                |
| typical aggregate count  | 319           | 5.1            | 5.2 (4.9–9.5)   | 0.20 (0.20–0.30) | 0.20             | 60.7× faster       | 25.4× slower              | 26.2× slower               |
| typical aggregate avg    | 331           | 5.6 (5.5–9.5)  | 5.8 (5.8–9.6)   | 1.1 (0.60–1.3)   | 0.80 (0.60–1.0)  | 57.1× faster       | 5.1× slower               | 7.2× slower                |
| typical aggregate median | 361           | 7.5 (6.8–12)   | 7.5 (6.4–12)    | 14 (12–20)       | 11               | 48.1× faster       | 1.9× faster               | 1.5× faster                |
| typical aggregate first  | 362           | 5.4 (4.2–6.8)  | 6.1 (4.4–6.2)   | 1.2 (1.2–1.6)    | 1.4              | 59.8× faster       | 4.5× slower               | 4.3× slower                |
| typical explode tags     | 1,013         | 40             | 41              | 54               | 56               | 25.0× faster       | 1.4× faster               | 1.4× faster                |
| typical explode nums     | 882           | 58             | 58              | 93               | 96               | 15.1× faster       | 1.6× faster               | 1.6× faster                |
| typical toJSON           | 116 (110–146) | 61 (55–74)     | 55 (51–69)      | 63               | 66               | 2.1× faster        | same                      | 1.2× faster                |
| typical fromJSON         | 470           | 194            | 206             | 226              | 196              | 2.3× faster        | 1.2× faster               | 1.1× slower                |
| typical toArrow          | –             | 15 (15–22)     | 19 (15–23)      | 1.4 (1.3–2.6)    | 1.5              | –                  | 10.9× slower              | 13.0× slower               |
| typical fromArrow        | –             | 55 (51–74)     | 65 (53–72)      | 3.3 (3.2–4.3)    | 3.3 (3.3–4.0)    | –                  | 16.6× slower              | 19.8× slower               |
| typical writeIpc         | –             | 18 (16–28)     | 22 (18–22)      | 6.0              | 6.2              | –                  | 2.9× slower               | 3.6× slower                |
| typical readIpc          | –             | 56 (55–85)     | 62              | 6.3 (6.2–7.4)    | 9.9              | –                  | 8.9× slower               | 6.2× slower                |
| single contains          | 7.0           | 1.4 (1.2–2.4)  | 1.6 (1.4–1.7)   | 2.0 (1.2–2.0)    | 1.2 (0.80–1.3)   | 4.4× faster        | 1.4× faster               | 1.3× slower                |
| single containsAny       | 30            | 3.3 (2.7–6.5)  | 3.3 (3.0–6.4)   | 5.5 (4.0–8.1)    | 2.4 (2.2–2.8)    | 9.1× faster        | 1.7× faster               | 1.4× slower                |
| single containsAll       | 7.0           | 1.8 (1.1–2.0)  | 1.6 (1.0–1.6)   | 2.2 (1.8–4.7)    | 1.2 (1.1–1.5)    | 4.4× faster        | 1.3× faster               | 1.3× slower                |
| single aggregate count   | 236           | 2.7            | 3.1 (2.7–4.2)   | 0.20 (0.10–0.20) | 0.20 (0.10–0.20) | 76.2× faster       | 13.3× slower              | 15.5× slower               |
| single aggregate avg     | 229 (226–287) | 3.2            | 3.2 (3.1–4.9)   | 0.50 (0.40–0.60) | 0.50             | 71.5× faster       | 6.5× slower               | 6.4× slower                |
| single aggregate median  | 277           | 3.0 (3.0–3.7)  | 3.4 (3.0–6.2)   | 9.8              | 9.9              | 80.9× faster       | 3.2× faster               | 2.9× faster                |
| single aggregate first   | 289           | 2.0 (2.0–2.9)  | 2.4 (2.0–2.7)   | 1.1 (0.60–1.2)   | 1.0              | 118.5× faster      | 1.8× slower               | 2.4× slower                |
| single explode tags      | 235           | 7.4 (6.8–11)   | 9.2 (6.8–9.4)   | 18 (18–23)       | 13               | 25.4× faster       | 2.5× faster               | 1.4× faster                |
| single explode nums      | 227 (191–227) | 8.0 (7.0–10.0) | 8.4             | 24               | 22 (17–26)       | 26.9× faster       | 3.0× faster               | 2.6× faster                |
| single toJSON            | 79            | 18             | 19              | 42               | 40               | 4.2× faster        | 2.3× faster               | 2.2× faster                |
| single fromJSON          | 380           | 111            | 123 (104–128)   | 144              | 130              | 3.1× faster        | 1.3× faster               | 1.1× faster                |
| single toArrow           | –             | 5.5 (5.1–6.4)  | 5.7 (5.5–8.9)   | 0.40 (0.40–0.90) | 0.50 (0.40–0.70) | –                  | 13.8× slower              | 11.4× slower               |
| single fromArrow         | –             | 26             | 25 (25–32)      | 1.2              | 1.1 (1.0–1.3)    | –                  | 21.9× slower              | 23.2× slower               |
| single writeIpc          | –             | 6.4            | 6.2 (6.1–9.4)   | 2.6              | 2.6 (2.4–3.2)    | –                  | 2.5× slower               | 2.4× slower                |
| single readIpc           | –             | 27             | 32 (27–42)      | 2.9 (2.6–4.6)    | 5.2              | –                  | 9.5× slower               | 6.2× slower                |

### JSON text in and out

Times in ms; median of 3 repeats (range when over ±15%).

| case                                              | pond-ts       | pond-rs 1 core | pond-rs 4 cores | polars 1 core | polars 4 cores | pond-rs vs pond-ts | pond-rs vs polars, 1 core | pond-rs vs polars, 4 cores |
| ------------------------------------------------- | ------------- | -------------- | --------------- | ------------- | -------------- | ------------------ | ------------------------- | -------------------------- |
| dense numeric (100k x 6) to_json tuple            | 152           | 38 (37–44)     | 52 (39–55)      | –             | –              | 2.9× faster        | –                         | –                          |
| dense numeric (100k x 6) to_json object           | 139           | 40 (39–66)     | 46 (41–58)      | 55 (54–68)    | 63             | 3.0× faster        | 1.4× faster               | 1.4× faster                |
| dense numeric (100k x 6) from_json                | 136           | 74             | 83              | 192           | 194 (194–232)  | 1.6× faster        | 2.6× faster               | 2.4× faster                |
| dense numeric (100k x 6) to_columns_json          | 74            | 38             | 37 (35–62)      | –             | –              | 2.0× faster        | –                         | –                          |
| dense numeric (100k x 6) from_columns_json        | 53            | 58 (44–59)     | 44              | –             | –              | 1.2× faster        | –                         | –                          |
| dense numeric (100k x 6) to_points_json           | 151           | 41 (40–69)     | 38              | –             | –              | 4.0× faster        | –                         | –                          |
| dense numeric (100k x 6) from_points_json         | 170           | 98             | 104             | –             | –              | 1.6× faster        | –                         | –                          |
| with a string column (100k x 7) to_json tuple     | 147 (130–180) | 39 (38–49)     | 39              | –             | –              | 3.7× faster        | –                         | –                          |
| with a string column (100k x 7) to_json object    | 149           | 52 (45–64)     | 42              | 66            | 68             | 3.5× faster        | 1.3× faster               | 1.6× faster                |
| with a string column (100k x 7) from_json         | 153           | 86             | 84              | 208 (206–240) | 194 (186–229)  | 1.8× faster        | 2.4× faster               | 2.3× faster                |
| with a string column (100k x 7) to_columns_json   | 108           | 40 (37–47)     | 40              | –             | –              | 2.7× faster        | –                         | –                          |
| with a string column (100k x 7) from_columns_json | 68            | 54             | 47 (47–69)      | –             | –              | 1.4× faster        | –                         | –                          |
| with a string column (100k x 7) to_points_json    | 163           | 42             | 45 (44–53)      | –             | –              | 3.6× faster        | –                         | –                          |
| with a string column (100k x 7) from_points_json  | 243           | 107            | 120             | –             | –              | 2.0× faster        | –                         | –                          |
| ~10% gaps (100k x 6) to_json tuple                | 113           | 35 (32–42)     | 35 (35–60)      | –             | –              | 3.2× faster        | –                         | –                          |
| ~10% gaps (100k x 6) to_json object               | 118           | 38             | 38 (38–45)      | 54            | 55             | 3.1× faster        | 1.4× faster               | 1.4× faster                |
| ~10% gaps (100k x 6) from_json                    | 143           | 77             | 89 (82–104)     | 189           | 185            | 1.6× faster        | 2.4× faster               | 2.1× faster                |
| ~10% gaps (100k x 6) to_columns_json              | 97            | 36 (34–46)     | 37 (34–55)      | –             | –              | 2.6× faster        | –                         | –                          |
| ~10% gaps (100k x 6) from_columns_json            | 58 (53–83)    | 46             | 39              | –             | –              | 1.5× faster        | –                         | –                          |
| ~10% gaps (100k x 6) to_points_json               | 119           | 37 (36–51)     | 35 (34–56)      | –             | –              | 3.4× faster        | –                         | –                          |
| ~10% gaps (100k x 6) from_points_json             | 192           | 100            | 101             | –             | –              | 1.9× faster        | –                         | –                          |
| wide (10k x 41) to_json tuple                     | 29            | 15             | 14              | –             | –              | 2.1× faster        | –                         | –                          |
| wide (10k x 41) to_json object                    | 79 (77–102)   | 17 (16–26)     | 16              | 35 (32–41)    | 34 (30–46)     | 5.0× faster        | 2.0× faster               | 2.2× faster                |
| wide (10k x 41) from_json                         | 30            | 34 (33–39)     | 54              | 126           | 126            | 1.8× slower        | 3.8× faster               | 2.3× faster                |
| wide (10k x 41) to_columns_json                   | 13            | 11             | 11              | –             | –              | 1.1× faster        | –                         | –                          |
| wide (10k x 41) from_columns_json                 | 7.8 (7.1–9.8) | 19             | 19              | –             | –              | 2.4× slower        | –                         | –                          |
| wide (10k x 41) to_points_json                    | 85 (80–115)   | 19 (18–22)     | 19 (17–31)      | –             | –              | 4.4× faster        | –                         | –                          |
| wide (10k x 41) from_points_json                  | 71            | 51             | 57 (48–78)      | –             | –              | 1.3× faster        | –                         | –                          |

## Not re-run here

- `examples/perf_text.rs` (text and true/false columns), `perf_decimal.rs`
  (decimal vs number columns) and `perf_slice.rs` compare pond-rs against
  itself or against one-off pond-ts runs with no committed script; their
  numbers stay in `docs/plans/PND_RUST_PLAN.md` (steps 2a, 2b, 2d).
- The agent trials (`agent-trial/`) measure how well agents write code
  against each library, not speed.
