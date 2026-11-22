# The six-engine benchmark suite

One set of cases, one set of data, six engines, one results file:

| Engine id | What it is                                       | Runner              |
| --------- | ------------------------------------------------ | ------------------- |
| `pond-rs` | pond-rs, the Rust library                        | `examples/suite.rs` |
| `polars`  | Polars, from Python                              | `suite.py polars`   |
| `wasm`    | `@pond-ts/wasm`, pond-rs compiled to WebAssembly | `suite.mjs wasm`    |
| `pond-py` | pond-rs from Python (`pond-timeseries` on PyPI)  | `suite.py pond-py`  |
| `pond-ts` | pond-ts, the TypeScript library                  | `suite.mjs pond-ts` |
| `pondjs`  | pondjs 0.9.0, the predecessor of pond-ts         | `suite_pondjs.cjs`  |

`bench/COMPARISON.md` is the wide comparison (173 cases, three engines).
This suite is the narrow one: 16 common time-series operations on one
million rows, run through everything pond ships plus the two reference
points.

## Run it

Build what you want measured, from the repository root:

```sh
cargo build --release -p pond-rs --example suite     # pond-rs
npm ci && npm run build --workspace=pond-ts          # pond-ts, and installs pondjs
bash packages/rs/build.sh                            # wasm (needs the wasm32 target and wasm-bindgen-cli)
pip install maturin polars numpy
(cd crates/pond-py && maturin build --release) && pip install --force-reinstall target/wheels/pond_timeseries-*.whl   # pond-py
```

Then:

```sh
python crates/pond-rs/bench/suite/run.py             # every engine, 1M rows
python crates/pond-rs/bench/suite/run.py --engines pond-rs,polars --rows 100000
```

It writes `crates/pond-rs/bench/suite/results.json` and prints the
one-thread table. An engine that is not built or installed is skipped, and
the results file says why. Run it on a quiet machine: nothing is repeated
across processes, so another busy program shows up in the numbers.

**Rounds.** Each engine runs five times (`--rounds`), in a different order
each round, and a case's time is the median of its five. One run is not
enough: on a shared machine the same case on the same engine moved by a
third from one run to the next, which is larger than many of the gaps
measured. pondjs, a thousand times slower, runs once.

pond-rs, Polars and pond-py can use several cores, so each of those runs
twice: with `RAYON_NUM_THREADS=1` / `POLARS_MAX_THREADS=1`, and with neither
set. The JavaScript engines run on one thread, once.

## The data

Every runner builds the same series from the same formulas, with no random
numbers, so there is nothing to generate or ship. For row `i` of `N`:

- `v(i)` = `((i * 7919) % 10007) / 8`, and a gap when `i % 17 == 5`
- `host(i)` = `host-` + `floor(i / 90) % 8`

| Series    | Time (ms)                    | Columns                                                        | Used for          |
| --------- | ---------------------------- | -------------------------------------------------------------- | ----------------- |
| `even`    | `i * 1000`                   | `v`, `host`                                                    | most cases        |
| `uneven`  | `i * 1000 + (i % 7) * 13`    | `v`, `host`                                                    | align             |
| `repeats` | `(i - floor(i / 10)) * 1000` | `v`, `host` (every tenth time appears twice)                   | dedupe            |
| `other`   | `i * 1500`                   | `w` = `v(i + 1)`, `tag` = `host(i + 1)`                        | join (right side) |
| `wide`    | `floor(i / 100) * 1000`      | `host` = `h` + `((i % 100) * 37) % 100`, `v`, `w` = `v(i + 3)` | pivot, add        |

## The cases

| Id             | What is timed                                                          |
| -------------- | ---------------------------------------------------------------------- |
| `agg_1m`       | average of `v` per one-minute bucket of `even`                         |
| `roll_5m`      | trailing five-minute rolling average of `v`                            |
| `roll_20`      | trailing 20-row rolling average of `v`                                 |
| `roll_20_sd`   | trailing 20-row rolling standard deviation of `v` (population)         |
| `roll_20_host` | the 20-row rolling average kept separately for each `host`             |
| `roll_grid`    | the five-minute average read at every point of a one-second grid       |
| `diff`         | change in `v` from the previous row                                    |
| `fill`         | gaps in `v` filled with a straight line between their neighbours       |
| `cumsum`       | running total of `v`                                                   |
| `filter`       | rows where `v > 500`, written as a column expression                   |
| `add`          | a new column `v + w` on `wide`, written as a column expression         |
| `align_hold`   | `uneven` put onto a one-second grid, each point holding the last value |
| `align_linear` | the same grid, each point on the straight line between its neighbours  |
| `dedupe`       | `repeats` with one row per time, keeping the last                      |
| `join_left`    | `even` left-joined to `other` on time (one time in three matches)      |
| `pivot`        | `wide` with one column per host (100 hosts)                            |

The Polars forms are the ones `bench/polars/*.py` uses for the same
operations, which were checked against pond's answers cell by cell. One
difference: where pond keys a result by an interval (three key columns),
the Polars form here keeps only the interval's start time.

pondjs has no rolling windows, filter, dedupe, keyed join or pivot outside
its Pipeline, so it runs five cases (`agg_1m`, `fill`, `add`, `align_hold`,
`align_linear`). The others are left out, not approximated.

## What is timed, and what is checked

- **Timed:** the operation only, on series already built. In each run, one
  warm-up call, then the median of 7 (five warm-ups for pond-ts and wasm, where V8 is
  still compiling during the first few). A call that takes over 20 s (5 s
  for pondjs) is timed once. A case's time is the median over the rounds;
  the results file keeps every round's time, and the dashboard's file the
  lowest and highest.
- **Not timed:** building the input series. Loading data is its own
  subject, and each engine takes a different input.
- **Checked:** every runner prints the number of rows its answer has and
  the sum of the answer's number columns. `run.py` compares both with
  pond-rs's one-thread answer (sums to one part in 10⁹) and records `same`.
  pondjs gives different answers for the two align cases; the results file
  and the table mark them.

## The results file

```json
{
  "meta": {
    "date": "…",
    "rows": 1000000,
    "cpu": "…",
    "cores": 10,
    "commit": "…"
  },
  "cases": [
    { "id": "agg_1m", "group": "Buckets", "label": "Average per minute" }
  ],
  "engines": [
    { "id": "pond-rs", "label": "Pond Rust (pond-rs)", "threaded": true }
  ],
  "runs": {
    "1": {
      "pond-rs": {
        "version": "",
        "cases": {
          "agg_1m": { "ms": 1.2, "rows": 16667, "sum": 1.0, "same": true }
        }
      }
    },
    "all": {}
  }
}
```

`runs["1"]` is the one-thread run of every engine; `runs["all"]` is the
all-cores run of the three engines that have one. An engine that did not
run has `{"skipped": "why"}`; a case that threw has `{"failed": "message"}`.
