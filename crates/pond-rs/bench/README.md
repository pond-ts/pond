# R1a benchmark

> **All pond-rs / pond-ts / polars comparisons in one place:**
> [COMPARISON.md](COMPARISON.md) (re-run 2026-10-22, every family, polars
> added). `compare_all.sh` + `collect.py` rebuild it; the polars runners
> are in `polars/`; `check_all.sh` checks pond-rs and polars give the same
> answers on every case.

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

| file                               | what it does                                                                |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `gen_data.py`                      | writes the input file (fixed seed, so every machine gets the same)          |
| `pond_ts.mjs`                      | pond-ts runner (the built `packages/core/dist`)                             |
| `../examples/r1a_bench.rs`         | pond-rs runner (`cargo run --release -p pond-rs --example r1a_bench`)       |
| `polars_bench.py`                  | polars runner; `POLARS_MAX_THREADS=1` for the one-thread run                |
| `compare.py`                       | checks pond-ts and polars give the same answers                             |
| `same.py`                          | checks pond-rs gives exactly pond-ts's answers, bit for bit                 |
| `run.sh`                           | all of the above                                                            |
| `compare_all.sh`, `collect.py`     | every per-step family on all three engines, and the tables in COMPARISON.md |
| `polars/`                          | polars runners for the per-step families                                    |
| `check_all.sh`, `check_outputs.py` | pond-rs and polars answers on every per-step case, compared cell by cell    |
| `agent-trial/`                     | the R1a agent trial: 10 agents with pond-rs vs 10 with polars on B          |

```
npm run build --workspace=pond-ts
PYTHON=/path/to/python crates/pond-rs/bench/run.sh      # needs polars, pyarrow, numpy
```

Each runner prints one JSON line: the median of 7 runs (after one warm-up)
for reading, computing and writing, and `run_mem_mb`. Read starts from the
file's bytes already in memory and write ends with the IPC bytes in memory,
so disk time is not counted. Every runner keeps only a few numbers from the
warm-up and frees its outputs before the timed runs (pond-ts and polars then
collect garbage), so all timed runs start from the same state.

`run_mem_mb` is measured the same way by all three runners, on Linux only
(`null` elsewhere): the peak resident size is reset to the current size just
before the warm-up (`/proc/self/clear_refs`), and the number is the peak
during the warm-up minus the size just before it. So the runtime and imports
are not counted, and an earlier, higher peak cannot hide the run's own. For
pond-ts it still includes garbage not yet collected.

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

## Results after R1a step 4 (Arrow-memory columns, threads)

Same machine and versions as below; three full `run.sh` repeats, each cell
the range of the three medians. pond-rs runs twice: `RAYON_NUM_THREADS=1`
and the default pool (4 threads here).

| workload | engine             | read ms | compute ms | write ms | total ms  | run memory MB |
| -------- | ------------------ | ------- | ---------- | -------- | --------- | ------------- |
| A        | pond-ts            | 54–109  | 2901–3412  | 185–198  | 3201–3671 | 362           |
| A        | pond-rs, 1 thread  | 46–55   | 438–504    | 93–106   | 571–638   | 192           |
| A        | pond-rs, 4 threads | 40–51   | 141–159    | 79–115   | 260–325   | 192           |
| A        | polars, 1 thread   | 23–25   | 519–590    | 84–97    | 625–701   | 256           |
| A        | polars, 4 threads  | 39–40   | 209–231    | 97–104   | 333–362   | 280–281       |
| B        | pond-ts            | 72–88   | 77–115     | 2.0–2.3  | 150–184   | 82–86         |
| B        | pond-rs, 1 thread  | 20–23   | 31–47      | 0.1      | 56–70     | 78            |
| B        | pond-rs, 4 threads | 19–20   | 11–14      | 0.1      | 32–34     | 78            |
| B        | polars, 1 thread   | 21–27   | 22–28      | 1.2–1.6  | 46–55     | 110           |
| B        | polars, 4 threads  | 35–38   | 11–14      | 1.3–1.5  | 47–53     | 111–112       |

Both pond-rs runs equal pond-ts to the bit (`same.py`). On four threads
pond-rs computes A faster than polars and B about the same. Writing no
longer copies values into Arrow (A write ~142–161 → ~79–115 ms) and memory
growth on A fell from 254 to 192 MB. Reading A barely changed in full runs:
every value column in this file has nulls, and a column with nulls is still
copied (nulls become NaN). A gap-free Float64 column is used in place.

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

### Re-run after the Codex review fixes (same machine, one run of 3 repeats)

The fixes changed how memory is measured and freed the warm-up's outputs
before timing (above). Single run, so noisier than the table:

| workload | engine            | read ms | compute ms | write ms | run memory MB |
| -------- | ----------------- | ------- | ---------- | -------- | ------------- |
| A        | pond-ts           | 64      | 3235       | 234      | 362           |
| A        | pond-rs, 1 thread | 42      | 461        | 158      | 254           |
| A        | polars, 1 thread  | 23      | 568        | 103      | 256           |
| A        | polars, 4 threads | 35      | 211        | 100      | 281           |
| B        | pond-ts           | 90      | 104        | 3.3      | 86            |
| B        | pond-rs, 1 thread | 19      | 27         | 0.1      | 78            |
| B        | polars, 1 thread  | 22      | 19         | 1.1      | 110           |
| B        | polars, 4 threads | 34      | 13         | 1.4      | 111           |

Same picture: pond-rs still equals pond-ts to the bit, is ~7× faster than
pond-ts on A compute, about even with polars on one thread, and grows by
about as much memory as polars on one thread.

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
  so it includes JIT work and garbage not yet collected. It is a cleaner
  number for pond-rs and polars, which have no garbage collector. pond-rs
  grows by 254 MB on A against polars' 239 (one thread) and 264 (four).
