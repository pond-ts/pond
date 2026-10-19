# R1a agent trial

The R1b step 4b trial on a partitioned workload (top-20 z-scores across 500
symbols) is in [`q11/`](q11/README.md).

The last R1a target (RFC `docs/rfcs/pond-rs.md`, Amendment 1): _on workload B,
an agent given pond-rs reaches the right answer at least as often as one given
polars, with fewer retries (10 runs each side)._

## How it was run (2026-10-17)

- **Task:** [`prompt.txt`](prompt.txt), the same text on both sides except for
  which library to use. It asks for daily avg/min/max/count of four columns
  with gaps, where a day is a New York calendar day. The data is the benchmark
  file (`../gen_data.py`), which crosses the 2026-03-08 clock change.
- **Agents:** 20 fresh Claude subagents (same model on both sides), 10 per
  library, all started at once per side. No web access. Each could read only
  its own folder and the library's source. pond-rs is unpublished, so its
  source and doc comments are its only docs. Polars agents had the polars
  0.55.2 crates' source.
- **Setup:** [`setup.sh`](setup.sh). It makes one Cargo project per run with
  the library already a dependency, and an `attempt.sh` that builds, runs and
  logs each try. Agents were told to build and run only through `attempt.sh`.
  Their transcripts were checked afterwards: none ran `cargo` another way or
  read outside the allowed paths.
- **Grading:** [`check.py`](check.py), run by me afterwards; the agents never
  saw it. It compares the output with pond-ts's answer (`pond_ts.mjs B`):
  - The same 12 day starts.
  - Equal counts.
  - avg/min/max within 1e-9 relative.

  It accepts any timestamp unit and any count type.

## Results

|                                         | pond-rs       | polars                                        |
| --------------------------------------- | ------------- | --------------------------------------------- |
| right answer                            | **10 / 10**   | **10 / 10**                                   |
| answer identical to pond-ts, to the bit | 10 / 10       | 0 / 10 (largest difference 3.7e-15, relative) |
| right on the first build-and-run        | 9 / 10        | 6 / 10                                        |
| failed runs before the first good one   | 2 (one agent) | 4 (four agents)                               |
| failed runs in total                    | 2             | 10                                            |
| build-and-runs in total                 | 12            | 28                                            |
| agent time, range                       | 39–52 s       | 70–202 s                                      |

Per run, in order (`0` is success, `101` a compile error or panic, `1` an error
returned by the program):

- pond-rs: nine runs `0`; run 06 `101 101 0`.
- polars:
  - 01 `101 0`
  - 02 `101 0 101 101 0`
  - 03 `0 101 0 0`
  - 04 `0 0`
  - 05 `0 0`
  - 06 `0 1 0 0`
  - 07 `0 101 0 0`
  - 08 `0 0`
  - 09 `101 0`
  - 10 `101 0 101 0`

**Verdict: target met.** Right answers were equal (10 vs 10), and retries were
fewer for pond-rs on every measure above.

### What the numbers do not show

- **Neither side fell for the clock change.** All 20 agents produced the
  23-hour day correctly. The trap the task was built around caught nobody, so
  this trial does not show pond-rs makes agents more correct. It shows they
  were equally correct with fewer tries.
- **Part of the gap is checking, not difficulty.** Six of the polars agents'
  failed runs came after they already had a good answer, while they added
  checks of their own. Three pond-rs agents said they relied on the library's
  stated match with pond-ts instead of checking the numbers.
- **Agent time is not a fair comparison.** Each polars build-and-run took 2–39
  s against 1–4 s for pond-rs, because 10 agents shared one polars build
  directory. A large part of the time gap is compiling, not thinking.
- **Home ground.** The task is the one pond-rs was built for. pond-rs's crate
  docs (`src/lib.rs`) show New York calendar days across a clock change as
  their example. Agents also get the repository's project notes, which
  describe pond (not the pond-rs API).
- **Polars was given a working setup.** The preset features include
  `parquet` because polars 0.55.2 does not compile with `ipc` alone (an error
  in `polars-stream`). A real user would have hit that first.
- **n = 10 per side.** The differences are in the direction the target asks
  for, but they are not large enough to rest much on.

## What the agents ran into

**pond-rs** (the number of agents, out of 10, that reported each problem):

1. **10/10: the output layout cannot be chosen.** `to_arrow`/`write_ipc` on an
   aggregate always write `interval`, `intervalEnd`, the values, then
   `intervalLabel`. Nothing renames or drops a key field. Every agent built
   the Arrow batch by hand.
2. **10/10: `arrow_ipc` is not re-exported.** Writing that batch meant adding
   `arrow-ipc = "59.3.1"` and matching pond-rs's version by hand
   (`arrow_array` and `arrow_schema` are re-exported).
3. **10/10: `Count` comes back as f64.** Every agent converted it to Int64. (It
   is f64 because pond-ts numbers are; not necessarily a bug.)
4. **3/10: empty buckets are not documented.** What an empty bucket gives
   (count 0, other values missing) is not in the `aggregate` docs. Agents read
   `reducer.rs` to find it.
5. **1/10 each:**
   - `Sequence::calendar` takes the unit as a string though `CalendarUnit`
     exists.
   - `Agg`'s output name is a method, not a field.
   - It is not obvious whether an interval key's `label` or `begin` is "the
     day start".

**polars** (for comparison):

- `TimeZone` needs `TimeZone::opt_try_new(Some(..))?.unwrap()` (most agents).
- `replace_time_zone` takes an expression for ambiguous times but an enum for
  times that do not exist.
- `Expr::exclude` moved to a selector type in 0.55.
- `ChunkedArray` is not `IntoIterator`.
- Wide tables print unreadably.
- The `ipc` without `parquet` build error above.

Items 1–2 are logged as [PND-RUSTOUT] in `docs/plans/PND_RUST_PLAN.md`.
