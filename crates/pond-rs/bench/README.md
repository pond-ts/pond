# R1a benchmark

The two workloads [PND-RUST-R1A] is judged on (RFC `docs/rfcs/pond-rs.md`,
Amendment 1), run on pond-ts and polars today. pond-rs joins when it can run
them. Every runner reads the same Arrow IPC file and writes Arrow IPC back, so
the times include getting data in and out.

- **A, generic:** 1M rows, 1 s apart, 4 number columns with ~5% gaps.
  `aggregate(Sequence.every('1m'), avg/min/max/count)` and
  `rolling('5m', avg/stdev)`.
- **B, calendar:** the same file bucketed by
  `Sequence.calendar('day', { timeZone: 'America/New_York' })`. The data
  starts at New York midnight on 2026-03-03 and crosses the 2026-03-08
  daylight-saving change, so one day is 23 hours long.

| file              | what it does                                                       |
| ----------------- | ------------------------------------------------------------------ |
| `gen_data.py`     | writes the input file (fixed seed, so every machine gets the same) |
| `pond_ts.mjs`     | pond-ts runner (the built `packages/core/dist`)                    |
| `polars_bench.py` | polars runner; `POLARS_MAX_THREADS=1` for the one-thread run       |
| `compare.py`      | checks pond-ts and polars give the same answers                    |
| `run.sh`          | all of the above                                                   |

```
npm run build --workspace=pond-ts
PYTHON=/path/to/python crates/pond-rs/bench/run.sh      # needs polars, pyarrow, numpy
```

Each runner prints one JSON line: the median of 7 runs (after one warm-up)
for reading, computing and writing, and `run_mem_mb`, how much the process
grew during one run (its peak size after the run minus its size before, so
the runtime itself is not counted).

## How the two sides are matched

- pond buckets are `[start, end)` labelled by their start: polars
  `group_by_dynamic(closed="left", label="left")`.
- pond's trailing rolling window is `(t - 5m, t]`: polars `rolling_*_by(closed="right")`.
- pond `stdev` is the population stdev: polars `ddof=0`.
- pond `count` counts present values, as polars `count` does.
- B: polars converts the times to New York time and buckets by `1d`.

`compare.py` requires identical bucket keys and counts, gaps in the same
places, and other values within 1e-9. Rolling stdev gets 1e-8; see below.

## Results, 2026-10-17

4-core Intel Xeon 2.1 GHz cloud machine, Node 22.22, polars 2.0.0. Input file
38.6 MB. Three full repeats; each cell is the range of the three medians.

| workload | engine            | read ms | compute ms | write ms | total ms  | run memory MB |
| -------- | ----------------- | ------- | ---------- | -------- | --------- | ------------- |
| A        | pond-ts           | 38–44   | 1073–1125  | 125–354  | 1308–1472 | 295–298       |
| A        | polars, 1 thread  | 12–13   | 333–360    | 54–63    | 397–434   | 255–256       |
| A        | polars, 4 threads | 25–26   | 125–141    | 59–113   | 217–274   | 280–281       |
| B        | pond-ts           | 35–40   | 53–64      | 1.5–1.8  | 92–105    | 83–87         |
| B        | polars, 1 thread  | 10–11   | 14–15      | 0.8–0.9  | 24–28     | 110           |
| B        | polars, 4 threads | 12–13   | 8–9        | 0.8–1.0  | 21–25     | 112           |

Output size: A writes 71 MB (the rolling result has a row per input row); B
writes 12 rows. The first repeat (not in the table) had pond-ts A compute at
1594 ms, so single runs on this machine can be off by a third.

## Findings

- **Both engines agree** on every bucket key, every count, and every gap. Bucket
  averages differ by at most 5e-13 and rolling averages by at most 4e-12
  (adding in a different order).
- **pond-ts rolling stdev drifts.** It keeps a running stdev that is updated as
  each value enters and leaves the window (Welford add/remove,
  `packages/core/src/reducers/stdev.ts`), and is only reset when the window
  empties, which never happens on dense data. Against an exact two-pass stdev
  on 3,000 sampled rows the error was up to 4.4e-9 for pond-ts and 1e-13 for
  polars. By position in the series (c3, 200 rows each): 4e-13 at row 1,000,
  6e-11 at 100k, 1.3e-9 at 300k, 1.5e-9 at 999k. Typical stdev there is ~0.6,
  so this is a relative error of a few parts per billion.
