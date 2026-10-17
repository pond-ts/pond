# R1a benchmark

The two workloads [PND-RUST-R1A] is judged on (RFC `docs/rfcs/pond-rs.md`,
Amendment 1), run on pond-ts, pond-rs and polars. Every runner reads the same Arrow IPC file and writes Arrow IPC back, so
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

| file                       | what it does                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `gen_data.py`              | writes the input file (fixed seed, so every machine gets the same)    |
| `pond_ts.mjs`              | pond-ts runner (the built `packages/core/dist`)                       |
| `../examples/r1a_bench.rs` | pond-rs runner (`cargo run --release -p pond-rs --example r1a_bench`) |
| `polars_bench.py`          | polars runner; `POLARS_MAX_THREADS=1` for the one-thread run          |
| `compare.py`               | checks pond-ts and polars give the same answers                       |
| `same.py`                  | checks pond-rs gives exactly pond-ts's answers, bit for bit           |
| `run.sh`                   | all of the above                                                      |

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
places, and other values within 1e-9. (Rolling had a looser rule until the
pond-ts drift fix, [PND-ROLLSTD], PR #766; it now agrees with polars within
~1.3e-12.) `same.py` requires pond-rs to equal pond-ts to the bit: same field
names, same rows, every cell identical, gaps in the same places.

## Results, 2026-10-17 (after PR #766)

4-core cloud machine, Node 22.22, polars 2.0.0, Rust 1.97 (release build).
Input file 38.6 MB. Three full repeats of `run.sh`; each cell is the range of
the three medians. This machine is slower than the one the first baseline
(PR #764) ran on: pond-ts A compute was 1720–1757 ms there, 2468–3040 here.
Compare rows within this table, not across tables.

| workload | engine            | read ms | compute ms | write ms | total ms  | run memory MB |
| -------- | ----------------- | ------- | ---------- | -------- | --------- | ------------- |
| A        | pond-ts           | 43–45   | 2468–3040  | 160–168  | 2701–3254 | 362–475       |
| A        | pond-rs, 1 thread | 39      | 393–403    | 142–161  | 586–610   | 254           |
| A        | polars, 1 thread  | 23–26   | 468–485    | 74–84    | 570–596   | 239           |
| A        | polars, 4 threads | 27–29   | 171–213    | 76–81    | 278–364   | 264           |
| B        | pond-ts           | 50–59   | 70–74      | 1.8–2.3  | 120–135   | 86–87         |
| B        | pond-rs, 1 thread | 19      | 28–31      | 0.1      | 47–53     | 78            |
| B        | polars, 1 thread  | 21–23   | 20–23      | 1.0–1.3  | 42–50     | 94            |
| B        | polars, 4 threads | 24–27   | 10–11      | 1.2–1.4  | 35–40     | 95            |

pond-rs's outputs equal pond-ts's to the bit in every run (`same.py`), and
pond-ts agrees with polars (`compare.py`).

Output size: A writes ~71 MB (the rolling result has a row per input row); B
writes 12 rows. Single runs on this machine can be off by a third, so compare
ranges, not single numbers.

## Findings

- **pond-rs equals pond-ts exactly** on both workloads: all 1,016,667 output
  rows of A and the 12 of B, every cell to the bit.
- **pond-rs compute is ~6–8× faster than pond-ts on A and ~2.3–2.6× on B, single-threaded.**
  On A it is about even with polars on one thread: 393–403 vs 468–485 ms in
  these repeats, but 367–567 vs 459–537 in the PR #767 reviewer's runs, so the
  ranges overlap. It is about 2× behind polars on four. pond-rs has no threading yet.
- **The drift fix doubled pond-rs's rolling stdev cost.** Measured on this
  machine with `examples/perf_slice.rs`: rolling went from ~200 ms (before
  #766) to ~345–390 ms; stdev on one column from ~34 to ~61–69 ms, avg from
  ~29 to ~33–45. The new method keeps every rounding error (double-double
  sums), about 30 dependent arithmetic steps per value, and pond-rs copies it
  step for step for exact parity. pond-ts's time did not change measurably,
  since its per-value overhead is much larger.
- **Copying is most of pond-rs's read and write time.** pond-rs columns own
  their memory, so reading copies the 40 MB of input values out of the Arrow
  buffers and writing copies 72 MB back in. On this machine just allocating
  and copying 40 MB takes ~30 ms, so A's read (~39 ms) and write (~150 ms,
  of which ~65 ms is the copy into Arrow and ~55 ms arrow's own IPC encoding)
  sit near that floor. polars avoids most of it. Columns that point at Arrow's
  memory instead of owning a copy would remove it; that is a design change,
  not done here. (B's read is faster, ~19 ms, because the process reuses
  memory it already touched; A's large outputs keep it from doing so.)
- **Arrow's `FileReader` copies every buffer.** Reading the same file with
  arrow's zero-copy `FileDecoder` instead took 0.13 ms rather than ~38 ms;
  pond-rs uses the decoder (`TimeSeries::from_ipc_bytes`).
- **pond-ts rolling slows down when some windows are empty.** The same file
  without the three outages (0.18% of rows) runs pond-ts `rolling('5m', avg)`
  in ~400 ms instead of ~650 ms, and `stdev` in ~680 instead of ~850 (first
  baseline machine). `aggregate`, polars and pond-rs are unaffected. A CPU
  profile shows the extra time in the loop that writes each window's result
  into the output (`writeGroup` in `rolling`, 4% → 19% of samples) and in
  garbage collection (5% → 14%). Why is not established yet. Logged as
  [PND-ROLLGAP].
- **`run_mem_mb` for pond-ts is rough**: it is growth during the warm-up run,
  so it includes JIT work and garbage not yet collected. It is a clean number
  for pond-rs and polars, which have no garbage collector. pond-rs grows by
  254 MB on A against polars' 239 (one thread) and 264 (four).
