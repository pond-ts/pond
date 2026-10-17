# PND_RUST_PLAN — pond-rs, a native Rust core

> Breakout plan for the **pond-rs** roadmap section in
> [PLAN.md](../../PLAN.md). Design context:
> [docs/rfcs/pond-rs.md](../rfcs/pond-rs.md).

_Opened 2026-10-17._

## Decisions

**Building pond-rs is a committed decision** (pjm17971, 2026-10-17; reasoning
outside this record). The Codex review's R−1 "stop if it doesn't pay" phase is
therefore not adopted, but its measurements are, as R1a's acceptance targets
(RFC Amendment 1).

Owner-confirmed 2026-10-17 (RFC §3): native Rust first, WASM bridge into
pond-ts last; lives in this monorepo as a Cargo workspace; schema checked at
runtime with precise errors; pond's own columns with Arrow import/export; order
batch core → financial studies → live → WASM. Users are agents writing Rust
against the crate. Charts, React and `@pond-ts/process` are out of scope.

Taken as defaults when R0 started (stated to the owner, revisit if wrong):

- **Crate name `pond-rs`**, imported as `pond_rs`. `pond` is taken on crates.io
  by an unrelated 2018 thread-pool crate; `pond-rs` was free on 2026-10-17.
  Not published until R1 has something usable (`publish = false`).
- **Time zones: `jiff`**, added when R1 first needs it. pond-ts does its zone
  math with the Temporal polyfill (`@js-temporal/polyfill`, see
  `packages/core/src/core/time-zone.ts`), and `jiff` is modelled on Temporal,
  so DST and "start of day" rules should line up with less translation than
  `chrono` + `chrono-tz`. Confirm against the calendar `Sequence` fixtures when
  they exist.
- **Edition 2024, minimum Rust 1.85** (the first release with edition 2024).
  CI tests on stable only; no separate minimum-version job yet.

## [PND-RUST-R0] — scaffolding and parity harness — DONE

What landed:

- Root `Cargo.toml` workspace (`crates/*`, `spikes/` excluded so the WASM
  spike keeps building standalone) and `crates/pond-rs` with no public API yet.
- **Core parity fixture.** `packages/core/scripts/parity/cases.mjs` records
  pond-ts's own output for 20 cases (rolling, aggregate, diff, rate,
  pctChange, cumulative, shift, fill) over two inputs — a gappy irregular
  series and a dense 1s grid of exact binary fractions — as
  `TimeSeries.toJSON()`. `generate.mjs` writes
  `packages/core/test/fixtures/parity.json`. All cases are exact except rolling
  `stdev` (1e-12).
- **Drift guard.** `packages/core/test/parity-fixture.test.ts` rebuilds the
  fixture from pond-ts source and fails if the committed file differs, so the
  Rust target cannot silently fall behind pond-ts. Checked by mutating one cell:
  the test fails.
- **Rust harness.** `crates/pond-rs/tests/core_parity.rs` and
  `tests/study_oracle.rs` read both fixtures (the 220-case financial oracle
  unchanged). Each has a `run` dispatch that returns `None` for anything not
  implemented; once an op gets an arm, every fixture case for it must match.
  Comparator self-tests prove a one-ulp change, a missing-vs-present cell, a
  shifted key and a dropped row are all caught. Study tolerance matches the TS
  oracle test (`toBeCloseTo(_, 9)`, i.e. < 5e-10).
- **CI**: `rust` job in `ci.yml` — `cargo fmt --check`, `clippy -D warnings`,
  `cargo test`. No Node needed.

**"Exact" means same operation order, not just same maths.** Most core cases
demand bit-identical output, so R1 must reproduce pond-ts's arithmetic step for
step: e.g. `fill-linear-hold` at 9000 is `0.666666666666667`, not the nearest
double to 2/3, and `rate` / `pctChange` depend on the exact formula. A one-ulp
mismatch there is a port that computes differently, not a harness bug; give the
case a `tolerance` only when pond-ts's own order is incidental (as with rolling
`stdev`).

Behaviours the fixture already pins that a port could easily get wrong (worth
reading before R1): a time window over only-missing cells `sum`s to `0` but
`avg`s to missing; `aggregate` emits empty buckets (`count` 0, `sum` 0, others
missing); `diff`/`rate` against a missing neighbour give missing rather than
skipping back; rolling `stdev` is population (`ddof=0`), so a one-sample
window is `0`.

### R0 follow-up from the Codex review (same PR)

- Fixture cells tag `-0` / `NaN` / `±Infinity` as `{"f64": …}`; exact
  comparison is bitwise (`-0` ≠ `0`); a tolerance applies to finite values only.
  New `signed` input pins `-0` through `pctChange`, `shift` and `cumulative`.
- Error cases: `{ "error": { name, message } }` where pond-ts throws; pond-rs
  must also error (messages are not matched). 26 cases now.
- CI also runs `cargo check --target wasm32-unknown-unknown`.
- Found while recording errors (pond-ts bugs, not fixed here):
  `diff('nope')` throws a raw `Cannot read properties of undefined (reading
'kind')`; `rolling` with an unknown column reports "aggregate mapping
  references unknown source column". Tracked as [PND-ERRMSG] in PLAN.md.

## R1a step 1 — baseline (DONE)

Shipped `crates/pond-rs/bench/`: a fixed-seed 1M-row Arrow file, pond-ts and
polars runners for workloads A and B (Arrow in → compute → Arrow out, median
of 7 runs, memory growth for one run), and a script that checks both give the
same answers. Full table and method in `crates/pond-rs/bench/README.md`.

Numbers (4-core cloud machine, Node 22.22, polars 2.0.0; ranges over three
repeats):

| workload | pond-ts total | polars 1 thread | polars 4 threads |
| -------- | ------------- | --------------- | ---------------- |
| A        | 1885–1930 ms  | 421–429 ms      | 208–222 ms       |
| B        | 92–102 ms     | 28–31 ms        | 20–23 ms         |

What that makes the R1a speed targets on this machine: pond-rs one thread
≤ ~940–965 ms on A and ≤ ~46–51 ms on B (2× pond-ts); pond-rs all cores
≤ ~260–280 ms on A (1.25× polars, four cores here). Polars on one thread is
already ~4.5× faster than pond-ts on A, well past the 2× bar, so the polars
target is the hard one. (pond-ts A is slower than it would be on gap-free
windows; see [PND-ROLLGAP] below. Without the outages it is ~1250–1300 ms.)

Decisions and findings:

- **Step 1 changed from what was planned.** The plan said "repair the WASM
  spike's benches and re-measure pond-ts". Those benches time the spike's own
  kernels run as WASM behind JS, not the R1a workloads, so their numbers could
  not be compared with any R1a target. The baseline the targets need is
  pond-ts and polars on workloads A and B, so that is what step 1 built. The
  spike repair moves to R4, whose RFC row already says it re-asks the spike's
  question with fresh numbers.
- **pond-ts and polars agree on bucketing**: every key, count and gap match,
  and bucket averages are within 5e-13. The data has three 10-minute outages
  (all columns missing) so empty buckets and empty rolling windows are
  actually exercised; the first draft had none, which an adversarial review
  caught.
- **pond-ts rolling results drift, and near outages the error is large.**
  pond-ts keeps a running sum and a running stdev (Welford add/remove), updated
  as each value enters and leaves the window, and clears the built-up rounding
  error only when the window empties completely. On dense stretches that is
  small: up to ~5e-9 off an exact stdev and ~1e-9 off an exact average
  (polars: ~1e-12), growing along the series. As a window drains towards an
  outage, the stdev gets small but the error does not: the worst row has two
  values, 126.31951 and 126.32022, true stdev 0.000354, pond-ts 0.000442 (25%
  wrong), polars exact. A single-value window gives an average 9.4e-10 off the
  value itself. Logged as [PND-ROLLSTD]; it is a pond-ts bug in its own right,
  not only a pond-rs concern. For pond-rs: copying pond-ts's order of
  operations exactly would copy this, so rolling `sum`/`avg`/`stdev` parity
  should be "within tolerance of an exact answer", not "same bits as pond-ts".
  Workload B (the exact-match target) has no rolling, so R1a is not blocked.
- **pond-ts rolling slows down ~60% when some windows are empty**: three
  10-minute outages (0.18% of rows) take `rolling('5m', avg)` from ~400 to
  ~650 ms. Profile: the extra time is in writing results to the output
  (`writeGroup`) and in garbage collection; the cause is not established yet.
  Logged as [PND-ROLLGAP].
- **The memory target needs revising**; proposal above in Next.
- The RFC said pond-ts runs on Node 24; this machine has Node 22.22, recorded
  with the numbers.

## R1a step 2a — first slice (DONE)

Shipped in `crates/pond-rs/src/`: `TimeSeries` (time keys, number columns,
gaps as `NaN`), `Column`, `Sequence::every`, `Agg` / `Reducer`,
`TimeSeries::rolling` (trailing time window) and `TimeSeries::aggregate`.
Reducers: count, sum, avg (`mean`), min, max, first, last, median, stdev,
`pNN`. All 25 rolling / aggregate cases in the core fixture pass with exact
bits (36 cases total; the other ops are not ported yet).

How parity is kept: each kernel is a step-for-step port of the pond-ts one it
names (eight-lane block sums from 32 values, Welford stdev, quickselect for
percentiles, the monotone deque for rolling min/max, the sorted array for
rolling median). The fixture gained 8 cases that pin what the first 26 could
not: a 300-row `noisy` input whose sums depend on addition order, with
repeated times and signed zeros, plus column-order cases. Check that they
pin it: making pond-rs sum sequentially fails `aggregate-noisy-30s-sum-avg` by
one ulp.

Decisions:

- **Keys are `i64` milliseconds**, not `f64` as in pond-ts: Arrow timestamps
  are integers, and bucket arithmetic is then exact. Fractional-millisecond
  times are not representable; none have come up.
- **Rolling `sum` / `avg` / `stdev` copy pond-ts step for step**, so parity
  can be exact. They first copied the drifting running sums; since
  [PND-ROLLSTD] (PR #766) they are ports of pond-ts's double-double
  `WindowSum` / `WindowStdev`, and the fixture still matches bit for bit.
- **pond-ts's big-integer overflow lanes are not ported.** A rolling sum/avg
  over a value of magnitude ≥ 2^960, or a rolling stdev over one ≥ 2^480,
  returns `PondError::Unsupported` rather than a different answer.
- **`Sequence::every("0s")` is an error.** pond-ts accepts it and then cannot
  build the grid.
- **Column order follows pond-ts**: `Agg::new` entries keep their order;
  when every entry is an `Agg::of` shorthand, `rolling` puts them in schema
  order (pond-ts sorts a shorthand map that way). `aggregate` keeps the given
  order either way, as pond-ts does.
- **Error text names the call and column** (lesson from [PND-ERRMSG]). The
  harness still only checks that pond-rs errors where pond-ts throws.
- JS `Math.max(0, NaN)` is NaN but Rust `f64::max(NaN, 0.0)` is 0, so a
  stdev whose sums overflow came out 0 instead of a gap. Fixed with a
  JS-equivalent clamp; fixture case `aggregate-extreme-stdev` pins it (found
  by the PR #765 review's fuzzer, ~2,800 random cases, all others matching).
- `Reducer::Percentile(q)` is public, so `rolling` / `aggregate` check `q` is
  in `[0, 100]` and return an error rather than panic.
- `p<q>` reducer names: pond-ts reads `q` with JS `Number`, which also accepts
  spaces and hex (`"p 5"`, `"p0x10"`); pond-rs rejects those spellings.

Speed, compute only (no Arrow yet), workload A's shape in memory
(`cargo run --release -p pond-rs --example perf_slice`), one thread, same
machine as step 1:

| step                                 | pond-rs | pond-ts, step 1 baseline |
| ------------------------------------ | ------- | ------------------------ |
| aggregate 1m, 16 outputs             | ~45 ms  | ~85–90 ms                |
| rolling 5m, avg + stdev on 4 columns | ~170 ms | ~1,090 ms                |
| total                                | ~220 ms | ~1,150 ms                |

The pond-ts column is from step 1's data **without** outages, so it is not
the same input; the review of PR #765 ran pond-ts on the same shape as
`perf_slice` (5% gaps) and got ~122 ms aggregate / ~1,912 ms rolling. The
speedup above is therefore understated, not inflated. Like-for-like numbers
on the benchmark file come with the step 2b runner.

Complexity: `aggregate` is O(N + B) per output (one walk; median /
percentile copy each bucket and quickselect it). `rolling` is O(N) per output
for count, sum, avg, stdev, first, last and amortised O(N) for min/max; median
and percentiles insert into a sorted array, O(N·W) for a window of W values,
as in pond-ts. Per-reducer cost, one column of 1M rows: count 13 ms, avg 18,
stdev 24, min 36, median 136.

## [PND-ROLLSTD] — rolling sum / avg / stdev drift — DONE (2026-10-17)

**Decision:** keep the running sums, but hold them as double-double (two
doubles, `hi + lo`, with error-free twoSum / Dekker twoProd so every step's
rounding error is kept rather than dropped), in a new internal module
`packages/core/src/reducers/window-accumulators.ts` (`WindowSum`,
`WindowStdev`). Stdev keeps `Σd` and `Σd²` of shifted values `d = v − k`; the
shift `k` starts at the first value and is moved to the mean (an exact rewrite
of the two sums, no stored values needed) when the mean drifts more than about
one stdev away, so the final `Σd² − (Σd)²/n` never cancels.

**Why this and not the PLAN entry's "periodic re-sum":** a re-sum needs the
window's values, and the reducer states don't have them; eight drivers (batch
time/count sweeps, `rollingByColumn`, five live operators) would each need to
pass them in, and the live `reorder` mode removes by value, not oldest-first.
Double-double sums fix it inside the state, keep removal by value, need no
buffer, and stay O(1).

**Measured on the R1a bench data (1M rows × 4 columns, exact `BigInt`
reference):** stdev worst relative error 0.25 → 3.4e-16 (polars 3.1e-12); avg
worst absolute error 9.4e-10 → 0 (measured: every row equals the exact mean rounded once — not a guarantee, since the sum and the division each round; polars
1.3e-12). Workload A compute time unchanged within noise (~2.4–2.5 s both).
Microbench (`scripts/perf-rolling-accumulators.mjs`, 100k rows): `sum` +11–14%,
`avg` −2…+7%, `stdev` −12…+6% — stdev got cheaper in places because the state
moved from closure variables to class fields.

**Side effects:** the old "outlier eviction" limit (removing a value ~1e7×
the remaining spread cancelled to 0) is gone: precision now runs out only
near a ratio of ~1e12+ (a 1e9 leaving a 3e-4-spread window: 3e-10 relative).
The add-only `aggregate('stdev')` paths still use Welford, whose error floor
is ~ε·max|v| (~2e-8 relative at a 1e10 offset), so rolling and aggregate no
longer agree bit-for-bit at large offsets; the fuzz test now checks each
against an exact oracle instead. **pond-rs:** the same PR ports `WindowSum`
/ `WindowStdev` to `crates/pond-rs/src/rolling.rs`; all 36 fixture cases,
including the order-sensitive `noisy` rolling ones, still match bit for bit.

## R1a step 2b — calendar buckets, Arrow, pond-rs in the benchmark (DONE)

Shipped: `Sequence::calendar(unit, zone)` (day / week / month / quarter /
year, `with_week_start`), `TimeSeries::from_arrow` / `from_ipc_bytes` /
`read_ipc` / `to_arrow` / `write_ipc`, the pond-rs benchmark runner
(`examples/r1a_bench.rs`, wired into `bench/run.sh`) and `bench/same.py`
(pond-rs vs pond-ts, bit for bit). Eight calendar cases joined the core
fixture (New York day across spring-forward, a Sunday-start week, Santiago
where local midnight is skipped, Samoa's skipped day 2011-12-30, a `+05:30`
fixed offset, London months, Tokyo quarters, UTC years); 33 of 44 fixture
cases now run in pond-rs and all match exactly.

The PR #767 review compared calendar buckets with pond-ts across every Node
zone, all units and week starts, 1900–2040 (~9.2M buckets). It found one
logic bug: a local day that never happens (Samoa, Kwajalein 1993, Kiritimati
1995, Fakaofo 2011) gave an empty extra bucket, because pond-rs stepped the
civil date instead of recomputing from the bucket's start instant as
pond-ts's `zone.next` does. Fixed and pinned by the Apia case. The other 17
mismatches were tz-data differences (Node 2025b vs pond-rs 2026e, e.g.
Bogota 1992, Tehran 1979). The review also found fixed-offset names
(`+05:30`) rejected (now accepted in pond-ts's spellings `±HH`, `±HHMM`,
`±HH:MM`) and that arrow's IPC decoder panics on some corrupt files (now
caught and returned as an error on native targets; on wasm32 a panic still
aborts).

Decisions:

- **Calendar buckets follow pond-ts `TimeZone.startOf` / `next`:** take the
  local date of the first event, step back to the unit's first day, then each
  bucket starts at that day's local midnight ('compatible' rule: a skipped
  midnight becomes the first instant that exists, e.g. 01:00 in Santiago).
  `jiff` computes the instants. There is no `hour` unit, as in pond-ts.
- **The tz database is bundled** (`jiff` with `tzdb-bundle-always`, so the
  WASM build has it too); `tzdb_version()` reports it (`2026e` today).
  pond-ts uses whatever its JavaScript runtime ships. The fixture does
  **not** record a tzdb version: the drift test regenerates the fixture and
  requires it to equal the committed one, so a version field would fail on
  any machine whose Node has different tz data. If the two databases ever
  disagree on a fixture zone, the calendar cases fail and show it; today they
  pass with Node 22.22 (tz data 2025b) against pond-rs's 2026e.
- **Arrow field names match pond-ts `toArrow` / `fromArrow`:** time key as
  one field (default `time`); an interval key as `interval`, `intervalEnd`,
  the value columns, then `intervalLabel` last. pond-rs writes keys as
  `Timestamp(Millisecond, "UTC")` (pond-ts hands back `f64` ms). Reading
  accepts a `Timestamp` in any unit, `Date64` or `Int64` ms; a sub-millisecond
  part is an error rather than silently rounded (pond-ts keeps fractional ms
  in its `f64` keys; pond-rs keys are whole `i64` ms). Any integer or float
  value column is read as `f64`; other types are an error naming the column.
  A column with any gap becomes optional, one without is required. pond-rs
  reads time-keyed files only, so its own interval-keyed `aggregate` output
  is written but cannot be read back yet (pond-ts can, with `keyKind`).
- **Reading uses arrow's `FileDecoder`, not `FileReader`.** `FileReader`
  copies every buffer (~38 ms on the 38.6 MB file); the decoder slices the
  batches out of the file's bytes (0.13 ms). The remaining read time is the
  copy into pond-rs's own columns.

Result on the 1M-row benchmark (details and the full table in
`crates/pond-rs/bench/README.md`): outputs identical to pond-ts, to the bit,
on A and B. Single-threaded compute on A: pond-rs 393–403 ms, pond-ts
2468–3040, polars 468–485 (1 thread) / 171–213 (4 threads). On B: pond-rs
28–31, pond-ts 70–74, polars 20–23 / 10–11. So against the R1a targets:
**≥2× pond-ts single-core is met** (~6–8× on A, ~2.3–2.6× on B); **within
1.25× of polars multi-core is not** yet (A ~2× behind, B ~3× behind) and needs
threading, which pond-rs does not have.

Found on the way:

- **The [PND-ROLLSTD] fix doubled pond-rs's rolling stdev cost** (34 → 61–69
  ms per 1M-row column; rolling in workload A ~200 → ~345–390 ms, same
  machine). It is the price of the double-double sums, ported step for step;
  pond-ts did not slow measurably. A faster exact method would have to
  change in pond-ts first, or parity would break.
- **Copying dominates pond-rs's read and write.** On this machine allocating
  and copying 40 MB costs ~30 ms; A's read (~39 ms) and write (~150 ms) are
  near that floor. Columns that point at Arrow's memory instead of owning a
  copy would remove most of it. Not done: it is a design change to the column
  type (still pond's NaN-for-gap columns, just not owning their memory), and
  it should be weighed when threading is designed, since both change how
  columns are shared.

## R1a step 3 — property tests (DONE)

`crates/pond-rs/tests/properties.rs` checks pond-rs against the slow,
obvious answer on random inputs neither pond-ts nor pond-rs was written
against (300 seeded cases per test, ~3 s in a debug build):

- **rolling**: for every row, filter the rows in `(t - window, t]` and
  reduce them naively; thirteen reducer shapes (count, sum, avg, min, max,
  first, last, median, stdev, p0, p37.5, p99.9, p100). Exact reducers must agree exactly;
  sum / avg / stdev within `128 · 1e-12 · max|v|` (they add in a different
  order). Inputs have repeated times, 0–95% gaps, flat windows.
- **aggregate, fixed steps**: the buckets are the anchor's grid, back to
  back, from the bucket holding the first row to the one holding the last,
  with nothing extra; each bucket's row equals a naive filter of
  `begin <= t < end`.
- **calendar buckets**: checked from first principles with jiff, in 8 zones
  (DST at 02:00, at midnight, a half-hour shift, Apia's skipped day, no DST,
  a fixed offset) and all five units with random week starts. Each bucket
  starts at the first instant of its local date; that date starts a unit;
  buckets are back to back; no unit start falls inside a bucket. Half the
  cases start just before a known awkward day _in its own zone_ (a first
  draft picked zone and day separately and hit Apia's skipped day about once
  in 300 runs, so it missed the old Apia bug).
- **aggregate, calendar**: the same naive row check over DST-straddling
  series.
- **rolling drift** (added after review): 50k rows alternating runs of
  values up to ~1e11 and up to ~1e3, 10-row windows. A plain running sum is off by
  ~5e-4 once the huge values leave the window; this test catches it (the
  random tests above are too short and clean to drift).

Not covered here: `-0` (the generator never makes it and the comparison
treats `-0 == 0`); its handling is pinned by the parity fixture only.

Each test was shown to fail on a deliberately broken copy: a plain running
sum (drift test only), the old Apia
zero-length bucket, fixed 24-hour days, a rolling window closed at its low
end, an aggregate bucket closed at its high end, a wrong percentile rank.

**Found:** where a week's first date was skipped (Apia, weeks from Friday,
2011-12-30), the bucket starts at the first instant after the gap
(Saturday 00:00). The first draft of the test assumed every bucket starts on
a unit-start date and failed there; pond-ts does the same thing as pond-rs
(new fixture case `aggregate-calendar-week-apia-skipped-start`), so the test
was wrong, not the code. No pond-ts or pond-rs bugs found.

## Codex review of R0–2b, and fixes (DONE)

pjm17971 ran a Codex review of everything merged through #767 (at
c603339) and relayed it in the project thread. Codex also ran 4,225
differential probes against pond-ts (all reducers, gaps, ±Infinity, signed
zeros, repeated times, empty series, DST gaps/overlaps, skipped days, week
starts, fixed offsets) and found the numerical port sound. Nine findings,
all checked against the code and all real; all fixed in one PR:

1. **`Sequence` could hold invalid states** (public enum variants bypassed
   the constructors: step 0 panicked, step -1 made `[0, -1)` buckets) and
   bucket edges overflowed near `i64::MAX`. Now an opaque struct, built only
   through `every` / `every_ms` / `calendar`; edges computed in `i128` and
   checked; a range over 2^28 buckets or ending before it begins is an
   error, not an abort.
2. **pond-ts's own documented Arrow export was rejected**: `toArrow` hands
   the key over as Float64 epoch ms, and pond-rs only took
   Timestamp/Date64/Int64. Float64 keys are now read when whole
   milliseconds in range. New fixture `parity-export.arrow`, written by
   pond-ts with the documented recipe (`scripts/parity/export.mjs`,
   drift-checked by vitest), which pond-rs must read back exactly. Before,
   no test fed Rust a file pond-ts wrote.
3. **A non-ASCII offset name panicked** (`"+a€"` sliced inside the euro
   sign). Rejected before slicing.
4. **A row at `i64::MIN` was evicted from its own window** (saturating
   subtraction). Keys are now limited to ±8.64e15 ms (`MAX_TIME_MS`, the
   range of a JavaScript `Date`, so of pond-ts), which leaves room for any
   window or step in `i64`.
5. **Arrow intake guessed required/optional from the values**, so an
   optional column without gaps came back required. Now the field's
   nullability decides (NaN in a non-nullable float field still makes it
   optional). pond-ts has the opposite problem: [PND-ARROWREQ].
6. **The fixture did not regenerate the same on Node 26 / ARM64**: the
   `noisy` input used `Math.sin` / `Math.cos`, which JavaScript does not
   require to round identically everywhere. Replaced with integer
   arithmetic and single IEEE operations, which do.
7. **The comparator let `-0` match `0` under a tolerance.** Fixed, with
   the self-test now using a tolerance. The last tolerance in the fixture
   (dense rolling stdev, 1e-12) is removed: since #766 it matches exactly.
8. **Benchmark warm-ups were unequal**: pond-ts and polars kept the
   warm-up's outputs (~71 MB of IPC on A) through the timed runs, pond-rs
   freed them. All three now free them (and collect garbage) first.
9. **The memory number was overstated**: a difference of two lifetime
   peaks, wrong units for Python on macOS, silently 0 for Rust off Linux.
   All three now reset the peak just before the warm-up
   (`/proc/self/clear_refs`) and report peak minus size-before; `null`
   off Linux. Re-run: same picture (bench README).

## R1a step 4 — Arrow-memory columns and threading (DONE)

**Columns use Arrow's memory** (pjm17971's choice, 2026-10-17).
`Float64Column` now holds an Arrow `ScalarBuffer<f64>` (shared, immutable,
reference counted) instead of a `Vec<f64>`; still NaN-for-gap, and
`values()` still gives a `&[f64]`, so no caller changed.

- Reading: a Float64 field with no nulls, in a one-batch file, is used in
  place, no copy. A field with nulls is still copied (nulls must become NaN,
  and the buffer is shared with the file, so it cannot be written in place);
  so are several batches (they must be joined) and other number types
  (widened to f64). The time key is still copied: `Key::Time` is a public
  `Vec<i64>`; changing it is an API change left for R1b.
- Writing: every value column's buffer is handed to Arrow as it is; gaps get
  a validity bitmap over it.
- Cloning a column or series no longer copies values.
- Cost (raised in review): an in-place column keeps the whole IPC file's
  bytes in memory for as long as it (or anything derived from it) lives,
  including the parts that were copied. Documented on `from_ipc_bytes` /
  `from_arrow`; not limited, since the caller controls the series' lifetime.
- Considered and not done: keeping Arrow's validity bitmap as the gap marker
  (no copy for columns with nulls). Every reducer's inner loop would have to
  read the bitmap, which is slower and is a bigger change than R1a needs.

**Threading** behind a `parallel` Cargo feature, **on by default**, using
rayon (`RAYON_NUM_THREADS` sets the pool). rayon is not built for wasm32,
where the feature does nothing. Only whole output columns run on different
threads; each column is computed start to finish by one thread, in order, so
its bits cannot depend on the thread count. Splitting one column's rows
across threads was rejected: the running sums' last bits depend on the order
values are added in. Test `par::tests::same_bits_on_one_and_many_threads`
compares 72 output columns, to the bit, on 1, 4 and 7 threads; the
benchmark checks the 4-thread output against pond-ts with `same.py`.
Limit: a call with one output column uses one core.

**Results** (same 4-core machine, 3 full `run.sh` repeats; compute ms):

| workload | pond-ts   | pond-rs 1 thread | pond-rs 4 | polars 1 | polars 4 |
| -------- | --------- | ---------------- | --------- | -------- | -------- |
| A        | 2901–3412 | 438–504          | 141–159   | 519–590  | 209–231  |
| B        | 77–115    | 31–47            | 11–14     | 22–28    | 11–14    |

Memory growth for one run, MB: A pond-rs 192 (was 254), polars 256 / 281;
B pond-rs 78, polars 110 / 111. Write on A dropped from ~142–161 ms to
~79–115 (no copy into Arrow). Read on A did not change much in full runs
(46–55 ms; 19 ms when run alone): every value column in the benchmark file
has nulls, so all are still copied.

Against the R1a targets (RFC Amendment 1):

- **≥2× pond-ts on one core**: met, ~6.5× on A, ~2.4× on B.
- **Within 1.25× of polars on all cores**: met; pond-rs on 4 threads is
  faster than polars on 4 on A (141–159 vs 209–231 ms) and even on B.
- **Same results on 1 and many cores**: met (bits identical).
- **Memory**: under the proposed target (growth no more than polars on one
  thread), met on A and B. The proposal still awaits pjm17971.
- **Agent trial**: step 5.

## Next

- **[PND-RUST-R1A]** — Measured vertical slice (adopted). Steps:
  1. ~~Baseline~~ — done, see "R1a step 1 — baseline (DONE)" above.
  2. ~~2a: keys, NaN-as-missing columns, `Sequence.every`, `rolling`,
     `aggregate`; 2b: calendar sequences, Arrow in/out, pond-rs in the
     benchmark~~ — done, see "R1a step 2a" and "R1a step 2b" above.
  3. ~~Property tests independent of pond-ts~~ — done, see "R1a step 3"
     above.
  4. ~~Arrow-memory columns and threading~~ — done, see "R1a step 4"
     above.
  5. Benchmarks A (generic, 1M rows) and B (DST calendar buckets) against
     pond-ts, pond-rs 1-thread / all-core, polars 1-thread / all-core, plus
     an agent trial on B — targets in RFC Amendment 1. A miss means redesign
     before R1b.
- **R1a memory target — proposed revision (awaiting pjm17971).** The target
  as written, "peak memory ≤ 2× the input Arrow size", cannot be met by any
  engine on workload A: input plus output is already ~110 MB (38.6 + 71)
  against a 2× limit of ~77 MB, and polars on one thread grows by ~256 MB
  (6.6× the input) doing it. Proposed:
  **one-run memory growth no more than polars on one thread, on A and on B**,
  measured as `run_mem_mb` in `crates/pond-rs/bench/`. That keeps the target
  relative to the same competitor as the speed targets. The "one pass per
  column for Arrow in and out" half stands. Caveat: for pond-ts the number is
  the growth during the first (warm-up) run, so it includes JIT work and
  garbage not yet collected; it is indicative only. For pond-rs and polars
  (no garbage collector) it is a clean measure, which is what the target
  compares.
- **[PND-RUST-R1B]** — Rest of batch core (`align`, `partitionBy`, `join`,
  remaining element-wise ops). Not adopted until R1a reports.
- Threading: done in R1a step 4 (per output column). If R1b needs one
  column split across threads, reductions must still give the same bits as
  one thread (fixed chunks, ordered combine).
