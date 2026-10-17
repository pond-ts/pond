# R1a benchmark

The two workloads [PND-RUST-R1A] is judged on (RFC `docs/rfcs/pond-rs.md`,
Amendment 1), run on pond-ts and polars today. pond-rs joins when it can run
them. Every runner reads the same Arrow IPC file and writes Arrow IPC back, so
the times include getting data in and out.

- **A, generic:** 1M rows, 1 s apart, 4 number columns with ~5% gaps.
  `aggregate(Sequence.every('1m'), avg/min/max/count)` and
  `rolling('5m', avg/stdev)`.
  The data has three 10-minute outages where all four columns are missing
  (rows still present), so some buckets and rolling windows hold nothing.
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
places, and other values within 1e-9. Rolling results get a looser rule
because of a pond-ts bug (below): within 1e-7, except up to 1 row in 10,000.

## Results, 2026-10-17

4-core Intel Xeon 2.1 GHz cloud machine, Node 22.22, polars 2.0.0. Input file
38.6 MB. Three full repeats; each cell is the range of the three medians.

| workload | engine            | read ms | compute ms | write ms | total ms  | run memory MB |
| -------- | ----------------- | ------- | ---------- | -------- | --------- | ------------- |
| A        | pond-ts           | 27–33   | 1720–1757  | 107–116  | 1885–1930 | 364–385       |
| A        | polars, 1 thread  | 12–13   | 340–353    | 52–59    | 421–429   | 256           |
| A        | polars, 4 threads | 25–26   | 120–133    | 54–60    | 208–222   | 281–282       |
| B        | pond-ts           | 37–43   | 54–61      | 1.3–1.6  | 92–102    | 86–87         |
| B        | polars, 1 thread  | 11–13   | 16–17      | 0.9–1.0  | 28–31     | 110           |
| B        | polars, 4 threads | 12–13   | 7.5–9.2    | 0.8–1.1  | 20–23     | 112           |

Output size: A writes ~71 MB (the rolling result has a row per input row); B
writes 12 rows. Single runs on this machine can be off by a third (an earlier
repeat had pond-ts A compute 45% above its others), so compare ranges, not
single numbers.

## Findings

- **Both engines bucket identically**: every bucket key, every count and every
  gap match, and bucket averages differ by at most ~5e-13 (adding in a
  different order).
- **pond-ts rolling results drift** ([PND-ROLLSTD]). pond-ts keeps a running
  sum and stdev (Welford add/remove, `packages/core/src/reducers/stdev.ts`),
  updated as each value enters and leaves the window, and clears the built-up
  rounding error only when the window empties completely. On dense stretches
  it ends up ~5e-9 off an exact stdev (polars ~1e-13), growing along the
  series. Next to an outage, as the window drains to a few values, the stdev
  gets small but the error does not: the worst row holds 126.31951 and
  126.32022, true stdev 0.000354, pond-ts 0.000442, polars exact. A window
  holding one value gives an average 9.4e-10 away from that value.
- **pond-ts rolling slows down when some windows are empty.** The same file
  without the three outages (0.18% of rows) runs pond-ts `rolling('5m', avg)`
  in ~400 ms instead of ~650 ms, and `stdev` in ~680 instead of ~850; A's
  compute goes from ~1150 to ~1750 ms. `aggregate` and polars are unaffected.
  A CPU profile shows the extra time in the loop that writes each window's
  result into the output (`writeGroup` in `rolling`, 4% → 19% of samples) and
  in garbage collection (5% → 14%). Why an empty window makes that loop slower
  is not established yet. Logged as [PND-ROLLGAP].
- **`run_mem_mb` for pond-ts is rough**: it is growth during the warm-up run,
  so it includes JIT work and garbage not yet collected. It is a clean number
  for polars (and will be for pond-rs), which have no garbage collector.
