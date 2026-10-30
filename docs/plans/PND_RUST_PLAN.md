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
- **The memory target needed revising**; the revision was accepted 2026-10-17
  (see Next).
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
- **Memory**: under the revised target (growth no more than polars on one
  thread, accepted 2026-10-17), met on A and B.
- **Agent trial**: step 5.

## R1a step 5 — agent trial, and the R1a report (DONE)

Twenty fresh Claude subagents (same model) were given the same task: daily
avg/min/max/count by New York calendar day over the benchmark file. Ten were
given pond-rs, ten polars 0.55.2. None had web access. Each could read only
the library source and its own folder, and built and ran only through a
logging script. Their outputs were graded afterwards against pond-ts's
answer. Setup, prompt, grader and full results are in
`crates/pond-rs/bench/agent-trial/`.

|                                       | pond-rs | polars  |
| ------------------------------------- | ------- | ------- |
| right answer                          | 10 / 10 | 10 / 10 |
| right on the first run                | 9 / 10  | 6 / 10  |
| failed runs before the first good one | 2       | 4       |
| failed runs in total                  | 2       | 10      |

- **Target met**: right answers were equal, and pond-rs needed fewer
  retries on every measure.
- **Not shown**: neither side got the clock change wrong. So this trial
  does not show pond-rs makes agents more correct, only that they needed
  fewer tries.
- **Some of the gap is checking**: six of polars' failed runs came after a
  good answer, while agents added their own checks.
- **The setup favoured polars in one respect**: its build needed a
  workaround preset for it. polars 0.55.2 does not compile with `ipc` alone,
  without `parquet`.

Friction the pond-rs agents hit:

- 10 of 10 could not write the requested layout. There is no way to rename
  or drop key fields, so every agent built the Arrow batch by hand.
- 10 of 10 had to add `arrow-ipc` themselves.
- All converted `Count`'s f64 to integers.
- Three read source to learn what an empty bucket gives.

The first two are logged as [PND-RUSTOUT] below.

**R1a report — every predeclared target met:**

| target                                               | result                                                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| correctness: fixtures pass, B equals pond-ts exactly | met: parity fixtures, property tests, and A and B bit-identical to pond-ts on 1 and 4 threads |
| ≥2× pond-ts on one core                              | met: ~6.5× on A, ~2.4× on B                                                                   |
| all-core within 1.25× of all-core polars on A        | met: faster (141–159 vs 209–231 ms)                                                           |
| memory: growth ≤ one-thread polars (revised)         | met: A 192 vs 256 MB, B 78 vs 110 MB                                                          |
| identical bits on 1 and N threads                    | met                                                                                           |
| agent trial                                          | met: 10/10 vs 10/10 right, fewer retries                                                      |

The one result short of a clean win is one-core B: polars is faster
(22–28 vs 31–47 ms of compute). Adopting R1b is pjm17971's call.

## [PND-CHAIN] — chain-friendly options, both libraries (2026-10-22)

Peter asked what a fluent chain looks like (study → operators → a final fold
such as "average of the last 5 minutes"). Writing it against main, in both
libraries, surfaced five rough edges; he asked to work on them. Outcome:

- **`rolling` with `append`** (pond-ts `{ append: true }`, pond-rs
  `Rolling { append }`): keeps the source columns. Before, `rolling` returned
  only the key and its outputs, so a chain lost every column it had built.
  Name reused from `collapse(…, { append: true })`. An output may not reuse an
  existing name, so the shorthand `{ rsi: 'avg' }` / `Agg::of` is an error
  with `append` (replacing a column in place was considered and rejected:
  explicit names are clearer, and replacing would be a second meaning for the
  same flag). Not on the grid form (its rows are buckets). Partitioned: with
  `append` the partition columns are already kept, so they are not carried
  through the mapping.
- **`diff` / `rate` / `pctChange` with `output`**: new optional number column,
  source kept, one source column only. Name reused from `scan` / `smooth`.
- **pond-rs short forms**: `diff(&cols)` etc. and `fill(&spec)` assume the
  usual defaults; `diff_with(&cols, Change)` / `fill_with(&spec, &limits)`
  take them, as `rolling` / `rolling_with` already did. A signature break,
  fine while the crate is unpublished.
- **`reduce_number` / `reduce_value`** (pond-rs): one column's single answer,
  pond-ts `reduce(column, reducer)`. Two methods rather than one returning
  `Value`, so the common number case needs no unwrapping.
- **Not done: `Agg` helper** (`avg("x").named("y")`): `Agg::new(out, src,
  reducer)` is already one call; a helper would only reorder its arguments.
- Live layer not changed: logged as [PND-LIVEAPPEND].

Parity: 10 new shared fixture cases (`rolling-append-*`, `*-output*`,
partitioned variants); a mutation run (dropping one appended column, renaming
the output) failed all 10.

## [PND-RUSTPUB] — publish pond-rs on crates.io (2026-10-29)

Peter asked (2026-10-29) for pond-rs to be published with API docs so Rust
users can find it. Crate name `pond-rs` was free on crates.io (checked
2026-10-29; `pond` is an unrelated 2017 thread-pool crate).

Done in the publish-prep PR:

- **Metadata.** description, homepage (pond-ts.org), documentation
  (docs.rs), keywords, categories, `readme`, a copy of the MIT `LICENSE`.
  `include` packs only `src/`, three user examples (`quickstart`, `rsi`,
  `live_stream`), README and licence (~385 KB). Tests, benches and the perf
  examples read fixtures elsewhere in the monorepo, so they stay out.
- **Minimum Rust is 1.88, not 1.85.** The `icu_*` crates need 1.88, and two
  `if let` match guards (stable only in newer Rust) were rewritten. Raising
  `rust-version` turned on two clippy lints (`is_multiple_of`, collapsed
  `if let` chains), applied with `clippy --fix`. CI now has a `rust-msrv`
  job on 1.88.
- **Docs.** Every public item documented; `#![warn(missing_docs)]` plus
  `RUSTDOCFLAGS=-D warnings` in CI keep it so. The crate front page was
  rewritten as a landing page (what it is, where to start, feature table).
  docs.rs builds with all features and `--cfg docsrs`, which marks
  `live`-only items.
- **Release workflow** `.github/workflows/release-rs.yml`: dispatch on main
  (dry run by default) or tag `pond-rs-v<version>`. The first publish needs
  a `CARGO_REGISTRY_TOKEN` secret (crates.io only offers trusted publishing
  for a crate that already exists); after it, set up trusted publishing on
  crates.io and delete the secret.

Version: Peter chose 0.1.0 with its own numbering, not lock-step with
pond-ts (2026-10-29); this settles [PND-RUSTRFC]'s versioning question.

## Codex review of the whole crate (2026-10-29)

pjm17971 relayed a Codex review of main at b5f6ecb (through #849): 14
findings (2 P1, 10 P2, 2 P3), checked one by one against main after #852
and fixed in small PRs, each with a test that fails before the fix. Where
pond-ts shares the defect it is fixed there too, under its own tag.

| #   | Finding                                                    | Status                                         |
| --- | ---------------------------------------------------------- | ---------------------------------------------- |
| R01 | reduce keeps what a window view trimmed                    | fixed, both libs, [PND-REDUCETRIM]             |
| R02 | reduce on a view of a reorder series uses FIFO-only states | fixed, both libs, [PND-REDUCETRIM]             |
| R03 | a batch can mix interval label kinds                       | fixed, both libs, [PND-LIVELABEL]              |
| R04 | live map keeps `required` though it can make gaps          | fixed, both libs, [PND-MAPGAP]                 |
| R05 | declared live groups skip the rows already held            | fixed (pond-ts already refused)                |
| R08 | numeric group names round ties up, JavaScript to even      | fixed: shares the JSON writer's digits         |
| R09 | catalog refuses `100.0` / `1e2` session milliseconds       | fixed: whole-number floats read                |
| R10 | partitions built over history: O(rows x groups)            | fixed: map, 64k groups 7.6 s → 0.19 s          |
| R07 | empty leading/centred time windows admit earlier rows      | fixed, both libs, [PND-ROLLEMPTY]              |
| R06 | batch partition map panics on a missing partition column   | fixed: error; mismatched results refused too   |
| R12 | Arrow time value `i64::MIN` panics in `abs()`              | fixed: `unsigned_abs`                          |
| R13 | huge study periods panic; Ichimoku offsets flip sign       | fixed: gaps (period > rows); offsets error     |
| R14 | `max_age` near `i64::MAX` overflows the cutoff             | fixed: saturating cutoff                       |
| R11 | declared minimum Rust version too low                      | handled in the crates.io prep PR (#851), 1.88  |

Codex also listed four existing limitations, not on the fix list:
duplicate-timestamp retention removing still-held view rows (mirrors
pond-ts, belongs to [PND-CHANGE]), schema-only Arrow IPC files unreadable,
composition tests (view→reduce, window→reduce, building over history,
schema after transforms) and ARCHITECTURE.md describing only the
TypeScript classes.

R13 note: an existing test (`huge_periods_give_gaps`) pins that a period no
window can fill gives gaps, not an error, so the fix short-circuits those
studies rather than capping periods at 2^53. A sweep of every catalog bar
option at usize::MAX, isize::MAX + 1 and 2^53 + 2 (catalog cap lifted for
the run) found exactly the reviewed studies and no others.

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
  5. ~~Benchmarks A (generic, 1M rows) and B (DST calendar buckets) against
     pond-ts, pond-rs 1-thread / all-core, polars 1-thread / all-core, plus
     an agent trial on B — targets in RFC Amendment 1. A miss means redesign
     before R1b.~~ — done, see "R1a step 5" above. **R1a is complete**;
     every target met.
- **R1a memory target — revised, accepted by pjm17971 on 2026-10-17.** The target
  as written, "peak memory ≤ 2× the input Arrow size", cannot be met by any
  engine on workload A: input plus output is already ~110 MB (38.6 + 71)
  against a 2× limit of ~77 MB, and polars on one thread grows by ~256 MB
  (6.6× the input) doing it. Accepted replacement:
  **one-run memory growth no more than polars on one thread, on A and on B**,
  measured as `run_mem_mb` in `crates/pond-rs/bench/`. That keeps the target
  relative to the same competitor as the speed targets. The "one pass per
  column for Arrow in and out" half stands. Caveat: for pond-ts the number is
  the growth during the first (warm-up) run, so it includes JIT work and
  garbage not yet collected; it is indicative only. For pond-rs and polars
  (no garbage collector) it is a clean measure, which is what the target
  compares. Met after step 4: A 192 MB vs polars 256 MB; B 78 vs 110 MB.
- **[PND-RUST-R1B]** — Rest of batch core. Adopted 2026-10-18 by pjm17971
  ("start it"). R1b has no predeclared speed targets. Instead every step
  has to meet four rules:
  - Each new operation gets cases in the core parity fixture
    (`packages/core/scripts/parity/cases.mjs`), checked bit for bit,
    including the cases where pond-ts throws.
  - Property tests (`tests/properties.rs`) cover any operation whose answer
    can be computed independently in a few lines.
  - Operations that walk rows get the CLAUDE.md performance check.
  - The work is done in the order below; a step can move earlier when a
    consumer needs it.

  The order follows dependencies. Groups need non-number columns, and most
  of the later steps need groups.
  1. **Reshape and output layout** ([PND-RUSTOUT]):
     - `select`, `rename`, `as_time(At)` and `TimeSeries::from_intervals`.
     - Re-export `arrow_ipc`.

     Doing this first removes most of what every agent in the R1a trial
     hit: no more hand-built batch or extra dependency. A key named e.g.
     `day_start` still needs one Arrow field renamed by hand, since pond-ts
     does not rename keys either.

  2. **Column kinds.** Columns become text and true/false as well as
     numbers, with Arrow in and out for each. Also `TimeRange` keys and
     text interval labels. This is the big API change: `Column` stops being
     number-only. The plan is a typed column enum, still checked at runtime,
     per the RFC. Split up: **2a** text and true/false columns (done,
     below), **2b** `TimeRange` keys and text interval labels (done,
     below), **2c** more
     Arrow input ([PND-RUSTARROWIN]) (done, below), **2d** exact decimals
     ([PND-RUSTDEC]) (done, below).
  3. **Row-wise operations**, split in two:
     - **3a** `diff`, `rate`, `pct_change`, `cumulative`, `shift`, `fill`
       (done, below).
     - **3b** `filter`, `slice`, `with_column`, `map` (Rust closures)
       (done, below).

  4. **Groups:**
     - `partition_by` (one or more columns), with per-partition `rolling` /
       `aggregate` / `fill` / step-3 operations, and `collect`.
     - `group_by`.

     Partitions run on several cores with the same bits as one. This is the
     agent-workload pitch ([PND-AGENTBENCH] Q11: 500 symbols × 1000 bars).

  5. **Grid operations:** `align`, `materialize`, `dedupe` (done, below).
  6. **`join`** (done, below).
  7. **Friction from the trials:** `parse_time` (7a) and the step 4b
     agent-trial fixes (7b) (done, below).
  8. **The rest of the pond-ts batch surface** ([PND-RUSTFULL]). Adopted
     2026-10-20 by pjm17971: all of it is core functionality and does not
     need to be justified again by friction. (Until then the plan was to
     build these only when asked for.) Sub-steps, in dependency order:
     - **8a Finding rows:** `at`, `bisect`, `at_or_before` /
       `at_or_after`, `nearest`, `includes_key`, `find` / `some` /
       `every`. (`first` / `last` done in 7b.) (done, below)
     - **8b Picking a time span:** `within`, `before` / `after`, `trim`,
       `overlapping`, `contained_by`, and `time_range` / `overlaps` /
       `contains` / `intersection`. (`tail` done in 7b; pond-rs had only
       `slice`, which takes positions.) (done, below)
     - **8c Changing key type:** `as_time_range`, `as_interval`,
       `offset_time` (pond-rs has only `as_time`). (done, below)
     - **8d Input and output:** `from_json` / `to_json`, `from_columns` /
       `to_columns`, `from_points` / `to_points`, `to_rows` /
       `to_objects`. pond-rs reads and writes Arrow only, plus building
       from Rust vectors. Split in two: 8d row JSON (done, below); 8d2
       columns and points JSON (done, below). `to_rows` / `to_objects`
       need no new call: `TimeSeries::rows` already hands out each row.
     - **8e Array columns:** a new column kind, with the whole set:
       `array_contains*`, `array_aggregate`, `array_explode`. (done,
       below)
     - **8e2 Arrow lists:** array columns read from and written to Arrow
       `List` fields; pond-rs only, since pond-ts has no Arrow form for
       arrays. (done, below)
     - **8f Reducers:** `unique`, `keep`, `top`, `difference`, `samples`.
       `unique`, `samples` and `topN` give arrays in pond-ts, so they wait
       for 8e.
     - **8g Rolling options:** windows counted in rows, leading and centred
       windows, a minimum sample count, rolling over a time grid. (done,
       below)
     - **8h Smoothing and stats:** `smooth` (EMA, moving average, loess),
       `baseline`, `outliers`, `scan` (a custom running step, a Rust
       closure), `sample`. (`reduce` done in 7b.) (done, below)
     - **8i Grouping and reshaping:** `pivot_by_group`, `by_column` and
       `rolling_by_column` (histograms), `by_value` and `ValueSeries`,
       `collapse`, `concat`. Split in three: 8i `concat`, `collapse`,
       `pivot_by_group` (done, below); 8i2 `by_column` /
       `rolling_by_column` (done, below); 8i3 `by_value` and `ValueSeries`
       (done, below); 8i4 `ValueSeries` Arrow in and out (pond-ts
       `fromArrow` / `toArrow`).
     - **8j Grouped series:** `smooth`, `baseline`, `outliers`, `sample`
       and `scan` per group.

     Each sub-step follows the R1b rules above (fixture cases bit for bit,
     property tests where an answer is easy to compute another way, the
     perf check for code that walks rows). A sub-step may be split further
     when it lands. Finance studies follow step 8.

  An agent trial at the end of step 4 repeats the R1a setup on a
  partitioned workload.

  **Step 1 (PR #770, merged 2026-10-18):** done.
  - Choices, all matching pond-ts:
    - `select` keeps schema order, so a repeated name selects the column
      once.
    - `rename` is applied all at once, so `a↔b` swaps work, and it refuses
      to rename the key.
    - `as_time` on a time-keyed series renames the key to `time`.
    - `as_time` with End or Center refuses overlapping intervals rather than
      reorder rows.
  - Differences from pond-ts:
    - The key still cannot be renamed, so a caller wanting `day_start`
      renames that one Arrow field.
    - An interval with an odd length in milliseconds has no whole-ms
      centre. pond-rs refuses it (error) where pond-ts gives `x.5`. pond-rs
      keys are whole milliseconds; fractional keys are a step-2 question.
    - Interval labels are numbers only until step 2 (text added in 2b).
  - Fixture: 19 new cases, 53 of 64 now run in pond-rs.

  **Step 2a (2026-10-18): text and true/false columns.**
  - Shape:
    - A value column is a `ColumnData`: `Number(Float64Column)`,
      `String(StringColumn)` or `Boolean(BooleanColumn)`. The names are
      pond-ts's own (`kind: 'string' | 'boolean'`), so agents moving between
      the two do not translate.
    - Text and true/false columns hold Arrow arrays (`Utf8`, or
      `Dictionary<Int32, Utf8>` when read that way; `Boolean`). A gap is an
      Arrow null. An empty string is a value.
    - `Column::required` / `optional` take any of `Vec<f64>`, `Vec<&str>`,
      `Vec<String>`, `Vec<bool>`, their `Option` forms, or arrays of them.
      They no longer take a bare iterator, so callers `collect()` first.
    - `TimeSeries::column(name)` now returns `Result<&Column>` (an error
      listing the columns, rather than `None`). Then `numbers()` /
      `strings()` / `booleans()` give the values, or a `WrongKind` error.
      This follows polars (`df.column("x")?.f64()?`), and was chosen over
      keeping a number-only `column()` that would return `None` for a text
      column that exists.
  - Reducers: `count`, `first` and `last` work on text and true/false
    columns in `rolling` and `aggregate`. `count` gives a number column;
    `first` / `last` give the same kind. They reuse the number kernels: they
    run over each row's number where it has a value (NaN where not), then
    pick out the chosen rows. Any other reducer on them is a `WrongKind`
    error.
  - Arrow:
    - Reads `Utf8`, `LargeUtf8`, `Utf8View` and dictionaries of `Utf8` /
      `LargeUtf8` with any key type, and `Boolean`.
    - With one batch, `Utf8`, `Dictionary<Int32, Utf8>` and `Boolean` are
      used in place. Anything else is copied into `Utf8`.
    - Writes the types pond-ts `toArrow` names: `Utf8`,
      `Dictionary<Int32, Utf8>` (when the column is one) and `Boolean`
      (pond-ts `toArrow` calls these `utf8`, `dictionary` and `bool`).
  - Differences from pond-ts:
    - pond-ts runs number reducers on text at run time (`sum` gives 0,
      `avg` gives gaps). pond-rs refuses them. Logged as [PND-KINDREDUCE].
    - pond-ts chooses dictionary or plain text itself, by how repetitive
      the column is. pond-rs keeps whatever it was given; built from Rust
      values, it is plain.
  - Sharp edges:
    - `first` / `last` of a dictionary column keep the source's whole list
      of strings, so a short `aggregate` result still writes every distinct
      string of the source to Arrow.
    - Text is held with 32-bit offsets (Utf8). Reading a `LargeUtf8` /
      `Utf8View` column of more than 2 GiB of text is an error, found in
      review.
  - Fixture:
    - 6 new cases on a `mixed` input (20 rows; a repetitive text column
      that pond-ts holds as a dictionary, a mostly distinct one, a
      true/false column, an empty string, gaps): `aggregate` fixed and
      calendar, `rolling` spec and shorthand order, `select`, `rename`.
      59 of 70 cases now run in pond-rs, all bit for bit.
    - A second Arrow file, `parity-export-mixed.arrow`, must read back as
      the `mixed` input exactly. It is built by apache-arrow in
      `export.mjs` from pond-ts's `toArrow` output (its buffers, null bits
      and dictionary), with Float64, Utf8, Dictionary<Int32, Utf8> and
      Boolean fields. The script, not pond-ts, picks those Arrow types and
      which fields are nullable.
  - Perf (`examples/perf_text.rs`, 1M rows 1 s apart, ~5% gaps, one
    thread, median of 7):

    | column            | aggregate 1m count/first/last | rolling 5m last | IPC write + read |
    | ----------------- | ----------------------------- | --------------- | ---------------- |
    | number            | 2.8 ms                        | 16 ms           | 11 ms            |
    | text              | 7.6 ms                        | 58 ms           | 12 ms            |
    | text (dictionary) | 6.5 ms                        | 25 ms           | 7.6 ms           |
    | true/false        | 5.8 ms                        | 29 ms           | 4.1 ms           |
    - pond-ts on the same shape: `aggregate` 133 ms (text) / 120 ms
      (true/false); `rolling` 267 ms / 199 ms.
    - Rolling plain text is mostly copying 1M strings into the output.
    - Two fixes came out of the check:
      - Each source column's row numbers are built once per call, not
        once per reducer: aggregate on text went from 13–17 ms to ~7 ms.
      - Gaps are read from Arrow's validity bits rather than row by row.
    - Number paths are unchanged. On the R1a benchmark (one thread),
      compute and write for A and B are within run-to-run noise of main.
      Read A came out 1.5–7 ms slower across runs (main ~27–29.5 ms). That
      read is mostly the memory allocator: with glibc told to keep freed
      memory (`MALLOC_MMAP_THRESHOLD_` / `MALLOC_TRIM_THRESHOLD_` = 4 GiB)
      both read A in 12–14 ms with no consistent order between them. Timed
      alone, 41 reads of the file take 14.6–15.3 ms on both.

  **Step 2b (2026-10-18): time-range keys and text interval labels.**
  - Shape:
    - `Key` gains `TimeRange(TimeRangeKeys { begin, end })`, built with
      `TimeSeries::from_time_ranges` (key named `timeRange`, as pond-ts).
    - Interval labels are a `Labels` enum: `Number(Vec<f64>)` or
      `String(StringColumn)`. `vec![...].into()` builds either from
      `f64`, `i64`, `&str` or `String` values. `Key` is no longer `Eq`
      (labels are `f64`).
    - `Key::begin()`, `Key::end()` (`None` for a time key) and `Key::kind()`
      so code can handle all three kinds without a match.
  - Checks, all as pond-ts: keys are ordered by start, then end (so
    `[0, 3000]` then `[0, 1000]` is an error); an end before its start is an
    error; zero-length spans are fine; number labels must be finite, text
    labels have no gaps; repeated labels and fractional number labels are
    fine.
  - Operations: `select`, `rename` and `as_time` work on ranges as on
    intervals. `rolling` anchors each row at its start, and rows sharing a
    start share a window, as pond-ts does. `aggregate` over range or
    interval keys stays an error (pond-ts counts a row in every bucket it
    overlaps; not built yet).
  - Arrow:
    - Out: a range key writes `<key>` and `<key>End`; an interval adds
      `<key>Label` last. Number labels are now written as `Float64`, as
      pond-ts does (they were timestamps before, which pond-ts would not
      read as numbers). Text labels are written like a text column.
    - In: `from_arrow` / `read_ipc` / `from_ipc_bytes` take an `ArrowKey`:
      `Time(name)`, `TimeRange(name)` or `Interval(name)`. A plain `&str`
      still means a time key, so existing calls compile unchanged. Labels
      of any number type read as `f64`; text types as text.
    - Checked both ways: pond-rs reads two new pond-ts Arrow exports
      (`parity-export-ranges.arrow`, `parity-export-labelled.arrow`) and
      rewrites them losslessly; a one-off run had pond-ts `fromArrow` read
      pond-rs's range, text-label and number-label files back exactly.
  - Differences from pond-ts:
    - pond-ts reads range and interval keys only from fields named
      `timeRange` / `interval`; pond-rs takes any name, so its own
      `ArrowKey::Interval("bucket")` file needs renaming for pond-ts.
    - pond-rs reads `<key>End` in its own Arrow time unit; pond-ts applies
      the start field's unit to both. They differ only for a table whose
      two edges have different units, where pond-rs's reading is the
      correct one. (Found in review.)
    - The pond-ts-reads-pond-rs direction was checked once by hand, not by
      a committed test.
  - Fixture: 11 new cases on a `ranges` input (shared starts, a
    zero-length span, an overlap) and a `labelled` input (repeated text
    labels): `as_time` begin / center / end-out-of-order error, `select`,
    `rename` and its key error, `rolling`. 70 of 81 cases now run in
    pond-rs, all bit for bit.
  - Perf: no new row loops beyond one pass of key checks at construction,
    so no benchmark.

  **Step 2c (2026-10-18): more Arrow input [PND-RUSTARROWIN].**
  - Why: a probe on 2026-10-18 wrote 17 Arrow files with pyarrow 26 and
    polars and read each with pond-rs (as of #771) and pond-ts:

    | file                                          | pond-rs        | pond-ts (via apache-arrow JS)   |
    | --------------------------------------------- | -------------- | ------------------------------- |
    | pyarrow `feather.write_feather` (LZ4 default) | error          | error (no codec in arrow JS)    |
    | ZSTD-compressed (pyarrow, polars)             | error          | error                           |
    | IPC stream format                             | error          | reads                           |
    | `Timestamp(us)` value column                  | error          | reads raw µs ([PND-ARROWTSVAL]) |
    | `Date32` value column                         | error          | reads as epoch ms               |
    | `Time64` value column                         | error          | reads raw units                 |
    | `Null` (all-empty) column                     | error          | reads as all gaps               |
    | `Float16`                                     | error          | error                           |
    | `Dictionary<Int32, Int64>`                    | error          | error                           |
    | `Decimal128`                                  | error          | error                           |
    | `Duration`, `Binary`, `List`, `Struct`        | error          | error                           |
    | `Utf8View`, `Dictionary<UInt32, LargeUtf8>`   | reads (copies) | reads                           |
    | polars `write_ipc` default (uncompressed)     | reads          | reads                           |

  - Outcome (everything planned, plus a `Date32` key):
    1. **Compressed IPC.** arrow-ipc's `lz4` and `zstd` features are on.
       `zstd` is C code: it builds for wasm32 with clang, and a test
       module built for wasm32-unknown-unknown read the ZSTD, polars-ZSTD,
       LZ4 and stream files in Node with no imports. Size of that module:
       2.72 MB without either codec, +28 KB for LZ4, +125 KB for ZSTD.
       pond-rs still writes uncompressed files, since apache-arrow JS (so
       pond-ts) cannot read compressed ones.
    2. **The stream format.** `read_ipc` / `from_ipc_bytes` tell the two
       layouts apart by the file format's `ARROW1` magic, so there is no
       new call. Stream batches are sliced out of the bytes without copying,
       as the file path does.
    3. **Time types as value columns.** `Timestamp`, `Date32`, `Date64`,
       `Time32`, `Time64` and `Duration` become number columns in
       milliseconds. Changed from the plan: a fractional millisecond is
       kept (`Timestamp(us)` 1500 reads as `1.5`) rather than being an
       error. Keys must be whole milliseconds because every operation
       buckets on them; a value is just a number, and refusing it would
       make every pandas nanosecond column with real sub-ms times
       unreadable. Whole milliseconds are exact; the fraction can be one unit in the
       last place off. A value whose whole milliseconds exceed 2^53 (not exactly
       representable) is an error. This does not copy pond-ts's unscaled
       `Timestamp(us)` read ([PND-ARROWTSVAL]).
    4. **Extras.** A `Null` column is an all-gap number column; `Float16`
       widens to `f64`; a dictionary of numbers (or of times) decodes to a
       number column, with a gap where the key or the entry is null.
    5. **`Date32` keys** read as midnight UTC of each day (pond-ts reads
       them too, via apache-arrow's own conversion).
  - Tests: `tests/data/arrow-types/` holds 15 small files written by
    pyarrow 26 and polars 2.0 (`generate.py`), one per case, and
    `expected.json` with each value worked out in Python from the raw
    input. `tests/arrow_types.rs` reads every file and checks the bits.
    Unit tests add LZ4 and ZSTD streams written by arrow-rs, a `Date32`
    key, a too-large duration, and a dictionary with null keys and null
    entries.
  - Perf: no change to the `Float64` / text / boolean paths; the new types
    take one pass over the column each.
  - Not planned: `Binary`. `List` / `Struct` wait for array columns (step 7).

  **Step 2d (done): exact decimals [PND-RUSTDEC].**
  - Arrow `Decimal128(precision, scale)` stores each value as a 128-bit
    whole number and a fixed count of decimal places for the column: `1.25`
    at scale 2 is stored as `125`. Databases, finance feeds, and pandas
    columns of Python `Decimal` write it. Peter (2026-10-18) rated it
    important.
  - pond-ts has no decimal kind (its numbers are JavaScript `f64`), so
    pond-rs cannot match pond-ts bit for bit on exact decimals; it can only
    match pond-ts after a conversion to `f64`.
  - Options:
    - **A. Read as `f64`.** Smallest change; every operation works as for
      numbers, matching pond-ts. Loses exactness: values past ~15–17
      significant digits round, and sums pick up binary rounding
      (0.1 + 0.2 ≠ 0.3).
    - **B. A decimal column kind** (`ColumnData::Decimal { values: i128,
scale }`, written back as `Decimal128`). Exact for `count` / `first`
      / `last` / `min` / `max` / `sum` (128-bit integer sums, an error on
      overflow). `avg` / `stdev` / percentiles give `f64`, since they leave
      the decimal grid. Costs a new kind in every operation, and is
      pond-rs-only until pond-ts gains one.
    - **C. A, plus `Column::to_decimal` / `from_decimal`** helpers so a
      caller can keep exact values outside pond-rs.
  - Decided 2026-10-18: **B** (Peter). Exactness is the reason people
    store decimals, and `sum` of prices or volumes is where `f64` drift
    shows.
  - Shipped:
    - `ColumnData::Decimal(DecimalColumn)` wraps an Arrow `Decimal128Array`
      (zero-copy from a single Decimal128 batch). `Decimal { value, scale }`
      is one value; it prints as a decimal and `to_f64` rounds once.
      Built with `DecimalColumn::from_options(raw, scale)` (precision 38;
      an error past 38 digits). `ColumnKind::Decimal` reads `"decimal"`.
    - Arrow in: `Decimal32` / `Decimal64` / `Decimal128` (widened to 128,
      precision and scale kept; every present value is checked against
      the precision, since a file can hold values that do not fit; a gap's
      raw value is never read). Arrow out: `Decimal128`. `Decimal256` is
      still refused (values may not fit 128 bits).
    - Reducers, `aggregate` and `rolling`:
      - `count` / `first` / `last`: the row-index trick text uses, then
        a gather of the chosen rows. Exact.
      - `min` / `max`: the number kernels run on the raw whole numbers as
        `f64` when every value fits within 2^53 (exact, and the common
        case), otherwise on each value's rank among the column's sorted
        distinct values. Either way the result maps back to the exact
        decimal.
      - `sum`: 256-bit running sums (`src/decimal.rs`), so nothing
        overflows on the way; each result must fit 38 digits or the call
        is an error naming the output and row. Output precision 38, same
        scale. Empty window or bucket sums to 0, as for numbers.
      - `avg` / `stdev` / `median` / percentiles: on the nearest `f64`,
        giving a number column, bit-identical to a number column of the
        same values (property test).
    - `rolling` was split into a `Window` trait (`enter` / `leave` /
      `emit`) and one `walk()`, so the exact sum reuses the window walk.
      No measured change on number columns (`perf_slice`, 1 thread,
      3 runs each: rolling 307–341 ms on main, 308–318 ms after).
    - Tests: `decimal_reducers_are_exact` property test (rolling and
      aggregate against brute force, values up to 34 digits and small
      values with ties, scales 0–5); unit tests for printing,
      conversion, bad input and sum overflow; pyarrow / polars decimal
      files in `tests/data/arrow-types/` (`expected-decimals.json`) read
      and round-tripped.
  - Perf (`examples/perf_decimal.rs`, 1M rows, prices at scale 2, 4
    threads, decimal vs number of the same values):

    | reducers | aggregate 1m | rolling 5m |
    | --- | --- | --- |
    | sum | 5.0 vs 3.0 ms | 29.2 vs 31.1 ms |
    | min + max | 16.4 vs 5.4 ms | 60.3 vs 37.1 ms |
    | first + last | 5.6 vs 2.0 ms | 38.0 vs 26.4 ms |
    | avg | 9.8 vs 3.5 ms | 30.1 vs 24.6 ms |

    Before two fixes found by this check, decimal `min + max` aggregate
    took 82 ms (sorting distinct values every time; now only when values
    pass 2^53) and `avg` 24 ms (per-row overhead converting to `f64`).
  - Not planned yet: decimals in the parity suite (pond-ts has none);
    decimal arithmetic in row-wise operations waits for step 3.

  **Step 3a (done): `diff`, `rate`, `pct_change`, `cumulative`, `shift`,
  `fill`.**
  - Rust shapes (`src/rowwise.rs`):
    - `diff` / `rate` / `pct_change(&[cols], FirstRow::Keep | Drop)`:
      pond-ts `{ drop }` as an enum rather than a bare `bool`.
    - `shift(&[cols], n: i64)`; `cumulative(&[(col, Reducer)])`, which
      reuses `Reducer` (only sum / max / min / count are allowed), plus
      `cumulative_with(col, |acc, v| …)` for pond-ts's function form.
    - `fill(&[(col, Fill)], &FillLimits)` and `fill_all(Fill, &FillLimits)`
      for pond-ts's bare-string form. `Fill::{Hold, Bfill, Linear, Zero,
      Value(FillValue)}`; `FillLimits::none().limit(n).max_gap("5m")`.
  - Behaviour follows pond-ts exactly, from a survey of its operators
    with probe scripts:
    - The "previous row" is the row directly above, not the last row
      with a value.
    - Rate is `(cur - prev) / ((begin_i - begin_{i-1}) / 1000)`, using
      begin for every key kind.
    - A zero time step or a zero previous value gives a gap; non-finite
      results are gaps; `-0` is kept.
    - A running sum starts from `+0`, so a leading `-0` becomes `+0`; max
      and min keep the earlier of two ties; overflow leaves the rest of
      the column as gaps.
    - Fill checks each run in pond-ts's order (neighbours, `limit`,
      `maxGap`), all or nothing, with its edge-run span rule.
    - Linear fill is `before + (after - before) * ((t - t0) / span)`.
  - Deliberate differences from pond-ts:
    - pond-rs errors where pond-ts is silent or crashes: unknown or key
      columns everywhere, `fill` on an unknown column, `Linear` / `Zero`
      on a kind they don't apply to (by name; `fill_all` skips such
      columns as pond-ts does), and a literal of the wrong kind, which is
      always an error rather than only when a gap gets filled.
    - `shift` and `fill` work on text and true/false columns. pond-ts
      types `shift` to numbers only.
    - Decimals: `diff` and `cumulative` sum / max / min are exact
      (precision 38, an error past it); `rate` / `pct_change` / `count`
      give numbers via `f64`; `fill` takes `Hold` / `Bfill` / `Zero` /
      a same-scale `Value`.
  - Tests:
    - 44 new pond-ts parity cases (fixture now 125), including `drop`,
      range and interval keys, overflow, signed zeros, every fill
      strategy and cap on gaps at the start, middle and end, sum
      overflow, and 6 error
      cases. All 125 match.
    - Four deliberate bugs planted in pond-rs were each caught: the rate
      expression, the edge-span rule, the `+0` sum start, and ties in
      max. The last three needed the new `zeros` / `edges` inputs.
    - Unit tests cover decimals, text, true/false, the extra errors,
      `cumulative_with`, and interval labels under `Drop`.
  - Perf (`examples/perf_rowwise.rs` vs `bench/rowwise_pond_ts.mjs`, same
    1M rows, 4.8% gaps, checked by gap count and sum), median ms; pond-ts
    after five warm-up runs, median of three script runs:

    | op | pond-rs | pond-ts |
    | --- | --- | --- |
    | diff | 3.5 | 7.9 |
    | diff, drop first | 4.1 | 10.0 |
    | rate | 4.5 | 17.3 |
    | pct_change | 4.0 | 9.5 |
    | cumulative sum | 3.9 | 8.6 |
    | shift 1 | 4.5 | 55.6 |
    | fill hold | 5.1 | 51.8 |
    | fill linear | 5.6 | 75.1 |
    | fill linear, maxGap 3s | 4.9 | 69.1 |

    Each op is one O(N) pass (fill: one to find runs, one to fill).
    - Gap loops sped up (2026-10-22, after the polars comparison in
      `bench/COMPARISON.md`). `diff` / `rate` / `pct_change` tested
      every row for a gap before doing the maths; that branch kept the
      compiler from working on several rows at once. A gap is a
      non-finite value, and the maths on one is non-finite too, so
      `finite_or_gap` on the plain expression gives the same bits (unit
      test against the old loop on NaN/±inf gaps, ±0, overflow and
      repeated times). Number `shift` is now one block copy, and `fill`
      finds gaps on the raw numbers. Medians of 7 runs, before → after:
      diff 3.8 → 1.5, rate 4.7 → 2.1, pct_change 4.2 → 1.6, shift
      3.8 → 1.7, fill hold 5.8 → 3.1, fill linear 6.1 → 3.7 ms. polars
      (1 thread, same session): 1.0 / 4.5 / 2.0 / 0.0 / 3.7 / 4.0.
      Partitioned `diff + collect` did not move (~40 ms: splitting and
      collecting dominate). This also answered "should gaps stop being
      NaN?": no. A NaN subtract (0.65 ms) is as fast as polars' bitmap
      style (0.64 ms); the cost of NaN is only at Arrow in/out (about
      2.3 / 0.7 ms per 1M-row column with gaps).
    - `FirstRow::Drop` first copied every column (14 ms, slower than
      pond-ts). It now shares the column buffers, as pond-ts's
      `withRowRange` does, and copies only the key. Step 3b's `slice`
      reuses this.
    - The first pond-ts timings used one warm-up run and were unstable:
      `diff` took 75 ms and was slower than `diff` with drop. The
      review of #775 caught it.
  - Found on the way: number columns with gaps never compared equal,
    not even to themselves, because the derived `PartialEq` compared the
    `NaN` gaps. `Float64Column` now compares values bit for bit and gaps
    by position.
  - Review fixes (#775):
    - A decimal fill value is now checked against the column's own
      precision, not just 38 digits. Before, a `Decimal128(5,2)` column
      could be filled with values its own Arrow type cannot hold.
    - A column named twice in `cumulative` or `fill` is an error.
    - New `overflow` input pins that a sum stays a gap after it
      overflows.

  **Step 3b (done): `slice`, `filter`, `with_column`, `map`.**
  - Rust shapes (`src/rows.rs`):
    - `slice(range)` takes any `i64` range (`2..5`, `-3..`, `..=-1`) with
      pond-ts's `Array.prototype.slice` rules: negative counts from the
      end, out of range clamps, a backwards range is empty. Never fails.
    - `filter(|row| -> Result<bool>)`. The closure gets a `Row` (index,
      begin, end, and `number` / `decimal` / `string` / `boolean` by
      column name). It returns `Result` so a wrong name or kind is an
      error passed through with `?`, not a panic. Chosen over a mask or
      expression API because it is what pond-ts's event predicate does
      and what an agent writes first.
    - `rows()` / `row(i)` walk the same `Row`s. They stand in for
      pond-ts's whole-row `map(schema, event => event)`: collect a new
      column from `rows()` and add it with `with_column`. pond-rs has no
      row objects to rebuild, so a row-rebuilding `map` would be slower
      and no clearer.
    - `with_column(Column)`: any kind, and `Column::required` /
      `optional` decide; pond-ts's `withColumn` takes numbers only and
      always makes the column optional. Same checks as building a series
      (length, name taken by a column or the key, gap in a required
      column); the column rules are now one function, `check_columns`.
    - `map_numbers` / `map_strings` / `map_booleans` / `map_decimals`
      (pond-ts `mapColumns`), one column per call. One method per kind
      rather than one generic `map_column`: a generic one needs the
      closure's argument type written out (`|v: f64|`), and the compiler
      error without it does not say so. Gaps are not passed to the
      closure. A number result that is not finite is a gap. A decimal
      result must keep the column's scale and fit its precision.
  - Deviations from pond-ts:
    - A mapped column that gains a gap becomes optional; pond-ts keeps it
      required and then cannot reload its own output ([PND-MAPREQ]).
    - An empty `mapColumns` mapping cannot be written in Rust (one column
      per call), so the harness stands in pond-ts's error for that case.
  - Parity: 31 new cases (156 in all): 12 `slice` (every bound form, all
    three key kinds), 9 `filter`, 5 `mapColumns` (one, the empty
    mapping, is a stand-in error, so it tests nothing in pond-rs), 5
    `withColumn`. Closures
    cannot be stored in JSON, so a case names one of a few fixed closures
    (`{ fn: { column: 'a', gt: 3 } }`, `{ fn: { mul: 2, add: 1 } }`, …);
    `cases.mjs` and the harness each build the same closure from it.
  - Perf (same 1M rows as 3a, median ms; pond-ts median of three runs):

    | op | pond-rs | pond-ts |
    | --- | --- | --- |
    | filter v > 500, value read by name | 10.4 | 348–473 |
    | filter, column fetched once | 4.0 | — |
    | map_numbers v × 2 / mapColumns | 1.4 | 72–97 |
    | with_column | 0.7 | 4.2–4.8 |
    | slice middle half | 0.4 | 0.0 |

    - `filter` reading by name looks the column up on every row (a scan
      of the column names); fetching the column once is 2.6× faster. The
      doc comment shows both.
    - pond-ts `slice` copies nothing (a view over the same buffers);
      pond-rs copies the key (shares the value columns).
    - pond-ts `filter` rebuilds its column store from `Event` objects
      ([PND-FILTERTAKE]); `mapColumns` is the boxed path under
      [PND-BOXFREE].

  **Step 4a (done): `partition_by` / `group_by`, threaded.** The agent
  trial on the Q11 workload is step 4b (done, below).
  - Rust shapes (`src/partition.rs`):
    - `series.partition_by(&["symbol"])` (one or more columns of any kind)
      gives a `PartitionedSeries`. Its `diff` / `rate` / `pct_change` /
      `shift` / `cumulative` / `fill` / `fill_all` / `rolling` /
      `aggregate` each run on every partition and return another
      `PartitionedSeries`; `map(closure)` runs any `TimeSeries -> Result<
      TimeSeries>` the same way; `apply(closure)` runs and puts the rows
      back together (the closure may drop the partition columns there).
    - `collect()` gives one series. `iter()` / `get(key)` /
      `into_groups()` give the partitions (pond-ts `toMap`).
      `group_by(&cols)` is `partition_by(..).into_groups()`.
    - A key is `PartitionKey = Vec<Option<Value>>`, one typed value per
      column, `None` for a gap. pond-ts keys `toMap` by strings (`String(v)`,
      `' undefined'` for a gap; JSON for several columns). Typed keys let an
      agent match on `Value::String(name)` instead of parsing text.
    - `FillValue` is renamed `Value` (one value of any column kind), since
      fill literals and partition keys are the same thing.
  - pond-ts behaviour copied exactly (each has a parity case):
    - Partitions are numbered in the order their first row appears; a gap is
      a partition of its own; `-0` and `0` are one partition.
    - Putting rows back together is pond-ts `TimeSeries.concat`: a stable
      sort by key, so rows at a shared time come out partition by
      partition, not in input order.
    - `collect()` before any operation returns the source unchanged.
    - `rolling` / `aggregate` carry each partition column through as a
      `first` output at the end (unless an output already has its name).
      An `aggregate` bucket with no rows gets a gap there, so it moves to
      the gap partition for the next operation.
    - An operation that drops a partition column is an error (pond-ts
      throws on the next split).
    - pond-ts merges after every operation and splits before the next.
      pond-rs keeps partitions apart and redoes only what that merge and
      split would change: drop partitions left empty, reorder by first row,
      and split for real only when an operation changed a partition
      column's values. One subtle case: `collect` merges in the order the
      last operation ran the partitions, while the next operation sees the
      new order (case `partition-two-drops`).
  - Not built: pond-ts's typed `groups` option (declare the partition
    values up front; `toMap` then lists them in that order, empty ones
    included, and unknown values throw). It exists for TypeScript's types;
    nothing has asked for it in Rust yet.
  - Differences from pond-ts, none reachable through the built-in
    operations:
    - Text values are compared as text. pond-ts's fast path for a
      dictionary-encoded column groups by dictionary code instead, so an
      Arrow dictionary that repeats a value gives pond-ts two partitions
      and pond-rs one. Such dictionaries are unusual (pyarrow and polars
      do not write them).
    - When a `map` / `apply` closure gives partitions different column
      details, pond-rs's `collect` marks a column required only if every
      partition has it required and takes the largest decimal precision;
      pond-ts takes both from the first partition (which may then fail to
      reload). Empty partitions are dropped before the column check.
  - Found in the Layer-2 review and fixed: on an empty series, rows a `map`
    closure makes from nothing had no key and were never split; they are
    now split as pond-ts does (unit test
    `rows_made_from_an_empty_series_are_split`).
  - Threads: partitions run on several cores (rayon); each partition is
    computed start to finish by one thread, so results are the same bits on
    any number of threads (unit test on 1, 4 and 7 threads).
  - Parity: 30 new cases (186 in all) over an 18-row hosts series with a gap
    host, composite keys, number / boolean keys, every step-3 operation,
    `rolling`, `aggregate` with empty buckets, chained operations, an
    operation that changes the partition column (`partition-changed-values`:
    `cumulative` sums `mem` 20 + 20 into the existing 40 partition), `toMap`
    order, `groupBy`, the empty series and the error cases. `-0` keys are a
    unit test (JSON cannot carry `-0`); `apply` has no parity case (it is
    `map` then `collect`, both covered).
  - Perf (`examples/perf_partition.rs` vs `bench/partition_pond_ts.mjs`; 500
    symbols × 1000 one-minute bars = 500k rows, symbols interleaved, 2%
    gaps; median ms on this 4-core machine; runs vary ±20%):

    | case | pond-rs 4 threads | pond-rs 1 thread | pond-ts |
    | --- | --- | --- | --- |
    | split (`toMap`) | 17.5 | 29.0 | 28.7 |
    | diff + collect | 45.4 | 89.6 | 637 |
    | fill linear + collect | 45.6 | 107 | 811 |
    | rolling 60m mean / sd / last + collect | 67.7 | 143 | 992 |
    | Q11: rolling, last z per symbol, top 20 | 36.4 | 84.5 | 1072 |

    First version, before tuning (4 threads / 1 thread): split 46.6 /
    63.5, diff + collect 143 / 205, fill 201 / 141, rolling 251 / 247,
    Q11 85 / 116. Timing each stage found three costs, all fixed:
    - Collect sorted 500k (partition, row) pairs with a closure that looked
      up each key through two indirections: 55–79 ms. Now a radix sort of
      the key numbers (stable, so ties keep partition order; it skips the
      16-bit digits where every key agrees): ~13 ms. A unit test checks it
      against a plain stable sort with negative times, far-apart times,
      repeats and time ranges.
    - Split hashed a fresh `Vec` per row: ~30–50 ms. Now each column's
      values are numbered once and several columns are folded pairwise;
      copying the rows out runs on several cores: ~17 ms.
    - The check that partition values did not change built a `String` per
      row: ~15 ms per operation. Now compares in place: under 1 ms.

    What is left: one thread spends about a third of `diff + collect` on
    the split and a third on collect; collect's text column copy is ~14 ms
    (500k strings from 500 sources). `rolling` per partition costs ~40 µs
    of fixed setup per call (49 ms for 500 partitions vs 29 ms for the
    same rows as one series).
  - pond-ts finding: `TimeSeries.concat`, which every partitioned operation
    calls to put rows back, takes ~450 ms on these 500 partitions
    ([PND-CONCATSORT] in PLAN.md).

  **Step 4b (done): agent trial on the partitioned workload.** The R1a
  trial repeated on [PND-AGENTBENCH] Q11: for 500 symbols, the z-score of
  each latest close against its trailing 60 minutes, top 20 by |z|. 10 fresh
  agents per side, same rules as R1a. Setup, prompt, grader and full write-up:
  `crates/pond-rs/bench/agent-trial/q11/README.md`.

  |                                  | pond-rs | polars |
  | -------------------------------- | ------- | ------ |
  | right answer                     | 10/10   | 10/10  |
  | identical to pond-ts, to the bit | 9/10    | 0/10   |
  | failed runs in total             | 1       | 4      |
  | used the library for the maths   | 10/10   | 3/10   |

  - Same picture as R1a: equal correctness, fewer failed runs. n = 10, so
    this points the same way rather than proves it.
  - 7 of 10 polars agents used polars only for file in and out and wrote
    the window maths in plain Rust; none used polars' rolling functions.
    So the comparison is pond-rs's API against hand-written Rust.
  - The 60-rows-instead-of-60-minutes trap caught nobody; the prompt spells
    the window out.
  - Friction for pond-rs, logged in PLAN.md as [PND-RUSTQ11]:
    - 10/10 built the output Arrow batch by hand: a ranked 20-row table is
      not a `TimeSeries` (time order, key first).
    - 9/10 wanted "the value at the latest row of each partition" and ran
      `rolling` over the whole history to read one row.
    - 6/10 found matching `Some(Value::String(..))` on a partition key
      clumsy.
    - 2/10 did not know `rolling` keeps only its outputs; this caused
      pond-rs's one failed run (`UnknownColumn` on `close`).
  - 5/10 worried that `Stdev` over a flat window is not exactly 0. Right:
    after different values leave the window it is ~1e-16 of the value
    (`5.1e-16` at 0.1). pond-ts gives the same bits, so parity holds; logged
    as [PND-FLATSTDEV] in PLAN.md for both libraries.

  **Step 5 (done): `align`, `materialize`, `dedupe`.**
  - Rust shapes (`src/grid.rs`), each also on `PartitionedSeries`:
    - `series.align(&seq, Align { method, sample, range })`, where
      `AlignMethod` is `Hold` (default) or `Linear`. Gives an interval-keyed
      series (key `interval`, labelled by bucket start) with every value
      column optional.
    - `series.materialize(&seq, Materialize { pick, sample, range })`, where
      `Pick` is `First`, `Last` (default) or `Nearest`. Gives a time-keyed
      series with the key at each bucket's sample point.
    - `series.dedupe(Keep::Last)`, where `Keep` is `First`, `Last`
      (default), `Error`, `Drop`, `Min(col)` or `Max(col)`.
    - All option structs implement `Default`, so `Align::default()` is
      pond-ts's `align(seq)`.
  - pond-ts behaviour copied exactly (each has a parity case):
    - The grid is pond-ts's `sequence.bounded(range, { sample })`: a bucket
      is in when its sample point is in `[begin, end]` (`(begin, end]` for
      sample End). The default range is pond-ts's `timeRange()`: the last
      row's begin for time keys, the largest end for time-range and interval
      keys. pond-rs computes sample points in half milliseconds with exact
      integers, so a centre on an odd step is exact.
    - Hold takes the row at or before each sample point, by pond-ts's key
      order: for time-range and interval keys a row counts as "before" when
      it begins before the point, or is a zero-length interval at it.
    - Linear (time keys only) interpolates numbers between the rows either
      side with pond-ts's formula and rounding; text and true/false columns
      take the earlier row's value; a result that is not finite is a gap.
    - `materialize` picks from rows whose begin is in
      `[bucket begin, bucket end)`; `Nearest` keeps the earliest row on a
      tie. Partitioned
      `materialize` fills the partition columns on empty buckets, as pond-ts
      does.
    - `dedupe` groups rows with the same key (begin; begin and end; begin,
      end and label for intervals), in order of first appearance. Interval
      rows with the same span but different labels stay apart, even when
      interleaved. `Min` / `Max` treat a gap as losing and keep the earliest
      row on a tie. The `Error` message matches pond-ts word for word,
      including JavaScript's number and ISO-date formatting.
    - Errors match: a value column already named `interval`, linear on a
      non-time key, a reversed range.
  - Differences from pond-ts:
    - `materialize` with a sample point on a half millisecond (centre of an
      odd-millisecond step) is an error: pond-rs time keys are whole
      milliseconds; pond-ts stores the fraction.
    - `Keep::Min` / `Max` check up front that the column exists and is a
      number or decimal column; pond-ts compares whatever it finds.
    - pond-ts's custom keep function, `BoundedSequence` input and
      `TimeRange`-object ranges are not built; `range` is a `(begin, end)`
      pair of epoch milliseconds.
    - `Linear` holds decimal columns rather than interpolating (pond-ts has
      no decimal column).
  - Parity: 60 new cases (247 in all): every method, sample and pick
    (calendar days at start, centre and end included), ranges
    inside, outside and as a single point, time-range and interval keys
    (including zero-length intervals and labels), gaps, text columns,
    repeated times, every keep policy, the partitioned forms and the error
    cases. The parity check compares error presence only, so a unit test
    pins the `dedupe` error text to pond-ts's, word for word. Unit tests
    also cover JavaScript number and date formatting (years outside
    0–9999 included), the half-millisecond refusal and decimals.
  - Property tests: align (hold and linear), materialize and dedupe each
    checked against a brute-force version on random time-keyed series
    (other key kinds rely on the parity cases).
  - Complexity: N rows, B buckets, C columns. `align` hold and linear and
    `materialize` walk rows and buckets together once: O(N + B·C). `dedupe`
    is one pass over sorted keys, O(N·C); only interval rows with equal
    spans use a hash map, to group by label.
  - Perf (`examples/perf_grid.rs` vs `bench/grid_pond_ts.mjs`; dense = 1M
    rows about 1 s apart with 2% gaps and a text column; sparse = 10k rows
    100 s apart onto a 1 s grid; repeats = 1M rows, 10% repeated times;
    panel = the 4a 500 × 1000 series; median ms on this 4-core machine;
    every checksum matches):

    | case                            | pond-rs 4 threads | pond-rs 1 thread | pond-ts |
    | ------------------------------- | ----------------- | ---------------- | ------- |
    | align hold, 1 m grid            | 2.7               | 3.0              | 78      |
    | align hold, 1 s grid            | 64                | 64               | 4565    |
    | align linear, 1 s grid          | 127               | 113              | 1215    |
    | align hold, sparse (1M buckets) | 30                | 41               | 2555    |
    | materialize last, 1 s grid      | 72                | 75               | 990     |
    | materialize nearest, 1 m grid   | 4.6               | 4.5              | 61      |
    | materialize last, sparse        | 67                | 70               | 961     |
    | dedupe last                     | 42                | 30               | 2314    |
    | dedupe max v                    | 30                | 30               | 2353    |
    | panel align 1 m + collect       | 127               | 145              | 3232    |
    | panel materialize 1 m + collect | 87                | 123              | 2347    |
    | panel dedupe + collect          | 76                | 135              | 2264    |

    Single-series grid operations run on one thread; only the panel cases
    use several (one partition per thread). So 4 vs 1 thread on the
    single-series rows is run-to-run noise. First version,
    before tuning: `dedupe` on 1M rows with no value columns took 68 ms and
    `align` 62 ms. Both went to fresh vectors per group or per bucket, which
    this machine pays for in page faults (~6 ms per fresh 8 MB). Now groups
    are found in one flat pass and bucket rows are produced without
    intermediate vectors: 12 ms and 33 ms.

  - pond-ts findings, from CPU profiles: `align` hold is ~4× slower than
    linear on the same grid ([PND-ALIGNHOLD]); `dedupe` and `materialize`
    pay for strings and `Event` objects ([PND-DEDUPEMAP]).

  **Step 6 (done): `join`, `join_many`.**
  - Rust shapes (`src/join.rs`): `left.join(&right, Join { how, on_conflict })`
    and `TimeSeries::join_many(&[&a, &b, &c], Join)`. `JoinType` is
    `Inner` / `Left` / `Right` / `Outer` (default); `OnConflict` is `Error`
    (default) or `Prefix(vec![..])`, one prefix per series.
  - pond-ts behaviour copied exactly (each has a parity case):
    - Exact keys only, same key kind on both sides (time, time range or
      interval); one walk over both keys.
    - Equal keys pair one to one in order: `a` rows on the left and `b` on
      the right give `min(a, b)` matched rows, then the longer side's extra
      rows alone. A matched row keeps the left key; the output takes the
      left series' name and key name. Every value column comes out
      optional.
    - Interval keys compare by begin, end, then label: number labels before
      text, and text labels as JavaScript `localeCompare` does in Node (CLDR
      root collation: `"a" < "B"`, and a precomposed `é` equals `e` + a
      combining accent, so those rows match). pond-ts does not sort labels
      within a span, so this order decides which rows pair. Node's
      `localeCompare` follows the machine's default locale, so this matches
      pond-ts under a root or English locale; pond-rs always uses root.
    - Number and text labels on rows from both sides (an outer join) are an
      error; a one-sided result keeps that side's label kind.
    - A value column name in more than one series is an error, or with
      `Prefix` becomes `<prefix>_<name>` in each series that has it. The
      prefix count is only checked when some name repeats; prefixes that
      still collide are an error. `join_many` finds repeats across all the
      series, then joins left to right; one series comes back unchanged.
  - Collation: pond-rs uses the `icu_collator` crate (ICU4X, compiled CLDR
    data). pjm17971 chose it over plain byte order on 2026-10-19: it
    matched Node's `localeCompare` on all 160,000 pairs of a 400-string
    test set (ASCII, case, accents both ways, ß, æ, CJK, emoji, NUL, tabs),
    at the cost of 46 small crates and ~1.3 MB in a built program. It is
    only called when two labels on the same span differ as bytes.
  - Differences from pond-ts:
    - `join_many` of no series is an error (pond-ts throws a `TypeError`
      reading `undefined`).
    - A right-side value column named like the left key is a clear error up
      front; pond-ts throws on the duplicate schema name. Only reachable
      through Arrow input, since pond-rs otherwise names keys by kind
      (unit test).
    - A side with 4,294,967,295 rows or more is refused (row numbers are
      held as `u32`).
  - Parity: 36 new cases (283 in all): every join type, repeated keys (2 vs
    3 at one time), both sides on identical keys, conflicts with and
    without prefixes, empty sides, key-kind mismatch, time ranges, interval
    labels in mixed case and both spellings of `é` in every join type,
    number vs text labels, and `joinMany` (plain, inner, prefixed, one
    series, conflict, wrong prefix count). New fixture encoding:
    `{ "series": name }` names another input; `joinMany` args are
    `[[others...], options]`.
  - Property test: random time-keyed series with repeats, every join type,
    against grouping by time.
  - Complexity: N and M input rows, R output rows, C columns. One walk,
    O(N + M); each column passes through (a side whose rows all land in
    order, nothing in between: shared, no copy) or is gathered once, O(R).
  - Perf (`examples/perf_join.rs` vs `bench/join_pond_ts.mjs`; a: 1M rows a
    second; b: 1M rows every 1.5 s, so a third of a's times match; each
    with a number column (2% gaps) and a text column; median ms; pond-ts
    is two separate runs; every checksum matches):

    | case                                 | pond-rs | pond-ts |
    | ------------------------------------ | ------- | ------- |
    | left join, 1M x 1M                   | 13–15   | 27–28   |
    | inner join, 1M x 1M                  | 11–12   | 26–36   |
    | outer join, 1M x 1M (1.67M rows out) | 87–89   | 67–75   |
    | left join, 1M x 10k                  | 10–11   | 16–18   |
    | outer join, same keys                | 2.3–3.0 | 7–9     |
    | `joinMany` of 3, same keys           | 5.8–6.1 | 16–23   |

    `join` runs on one thread, so the thread count does not change these.
    pond-ts's join was already column-native ([PND-JOINCOL]: one walk,
    then pass-through or one gather per column), so the gap is small.

  - The outer join is slower than pond-ts in a fresh run. With glibc told
    to keep freed memory (`GLIBC_TUNABLES` set to
    `glibc.malloc.mmap_threshold=268435456:glibc.malloc.trim_threshold=1073741824`)
    it takes 50 ms. So
    ~37 ms is the first touch of new memory pages for ~100 MB of output and
    temporaries. JavaScript reuses its own heap, so pond-ts does not pay
    that again run after run.
  - First version, before tuning (fresh run): left 66 ms, outer 152 ms,
    same keys 17 ms, `joinMany` 34 ms. Changes:
    - Output row pairs held as two `u32` instead of two `Option<usize>`:
      8 bytes a row, not 32.
    - Time keys compared with an inlined integer compare.
    - Each gathered side builds one Arrow `UInt32Array` of row numbers,
      used for every column, instead of a `Vec<Option<usize>>` per side.
    - Text, true/false and decimal columns gather with Arrow's `take`
      kernel (`arrow-select`, already built for `arrow-ipc`), which sizes
      the output first and copies each row once. `StringColumn::take` now
      uses it too, which speeds up the step-5 operations that copy text
      (same checksums; `perf_grid`, same session, before → after):
      `materialize` last 1 s 73 → 27 ms, `materialize` sparse 50 → 20 ms,
      `align` hold 1 s 62 → 45 ms, `dedupe` last 23 → 19 ms.

  **Step 7a (done): reading times written as text ([PND-RUSTTIME]).**
  Raised by the pond-rs website docs thread: pond-rs took times only as
  epoch milliseconds, so docs and agents worked out values like
  `1_772_859_600_000` by hand.
  - Shape: `parse_time(text)` and `parse_time_in(text, time_zone)`, each
    returning epoch-ms `i64`, the pond-rs form of pond-ts
    `Time.parse(text, { timeZone })` (`parse_time` = UTC, pond-ts's
    default). They feed the calls that already take milliseconds (`new`,
    `with_anchor`, `buckets_overlapping`, …), so nothing else changed.
  - Considered and not built: taking `jiff::Timestamp` / `Zoned` wherever a
    time goes in. It would double every time-taking signature, and a jiff
    user already has `ts.as_millisecond()`. Revisit if agents ask.
  - Rules, all pond-ts's (`parseTimestampString` in
    `packages/core/src/core/calendar.ts`): `YYYY-MM` and `YYYY-MM-DD` are the
    start of that month or day in the zone; `YYYY-MM-DD[T ]HH:MM[:SS[.f]]`
    (up to 9 fraction digits) is wall-clock time in the zone (a skipped time
    moves forward by the gap, a repeated one takes the earlier: Temporal's
    `compatible`, which is also jiff's default; `:60` reads as `:59`);
    anything else goes to jiff's timestamp parser, which must find an offset.
    Sub-millisecond parts round towards the past, as Temporal's
    `epochMilliseconds` does (`1969-12-31T23:59:59.9995Z` is -1, not 0).
  - jiff's timestamp parser accepted every offset form Temporal's
    `Instant.from` did in the probe (hour-only `T09Z`, basic
    `20250101T0900Z`, `+0100`, `+01`, `+01:00:30`, lowercase `t`/`z`, comma
    fractions, a 6-digit year) with one exception, now checked before it:
    offsets past 23 hours (Temporal refuses; jiff took up to 25). The
    wall-clock path refuses seconds past 60, as Temporal does.
  - Bracketed notes (`[Europe/Madrid]`, `[u-ca=iso8601]`) are read by
    pond-rs, not jiff, by Temporal's rules: one zone note, first; lower-case
    `key=value` notes; a critical `[!…]` note refused unless it is the zone
    or a calendar; a critical calendar refused next to a second calendar.
    jiff refused critical calendar notes Temporal accepts (found in review).
  - `time_zone` may be an offset (`+05:30`, `+0530`, `+05`), as in
    Temporal and `Sequence::calendar` (found in review).
  - Zone rules come from each side's tz database (Node's ICU 2025b vs
    jiff's 2026e here), so results differ where the databases do: a review
    fuzz found far-future Casablanca (its predicted clock changes) and
    `EST5EDT` before 1967. Same caveat as `Sequence::calendar`; documented
    on `parse_time_in`.
  - Differences from pond-ts, pinned in `time_parse.rs` tests, all errors in
    pond-rs: years beyond ±9999 and times after about 9999-12-30 22:00 UTC
    (jiff's range; Temporal's is ±271821), and offsets with a fraction of a
    second (`+00:00:00.5`; Temporal keeps it, jiff rounds it to the second,
    so pond-rs refuses rather than be half a second out).
  - Parity: the core fixture gains `timeParse`, 111 texts × 12 zones =
    1332 results (554 of them errors) from pond-ts `Time.parse`, built by
    `cases.mjs` and so covered by the drift test. Zones include Santiago and
    São Paulo (clocks once skipped midnight), Apia (skipped 2011-12-30
    whole, which reads as the start of the 31st in both), `Etc/GMT+5`, an
    unknown zone and two offsets. All 1332 match. A review fuzz of
    80k random texts found nothing else beyond the differences above.
  - Not a perf step: parsing does not walk series.

  **Step 7b (done): the step 4b agent-trial fixes ([PND-RUSTQ11]).** Each
  friction item from the Q11 trial, and what answered it:
  - 9/10 had no "value at the latest row of each partition" and ran
    `rolling` over the whole history to read one row. Answered with
    pond-ts's own pieces: `tail(duration)` (rows starting strictly after
    the last start minus the duration; a suffix slice, sharing memory) and
    `reduce(&aggs)` (the whole series as one `aggregate` bucket, so the
    same reducers, kernels and bits; checked in pond-ts that `reduce`
    equals a one-bucket `aggregate` on random data), plus `first()` /
    `last()` giving a `Row`. `reduce` returns `Reduced`, read by output
    name with the `Row` calls (`number`, `string`, …) or as a `Value`
    with `get`, since a Rust value per output needs a type; pond-ts
    returns a plain record. Its errors name `Reduced::*`, and it prints as
    output name → value. As in pond-ts, `tail` on an empty series returns
    it without reading the duration (so a bad duration is not an error
    there).
  - 6/10 found partition keys clumsy (`Some(Value::String(..))`): added
    `Value::as_str` / `as_f64` / `as_bool` / `as_decimal`, so a key part
    reads `key[0].as_ref().and_then(Value::as_str)`. `PartitionKey` stays
    `Vec<Option<Value>>` (changing it would break every caller).
  - 10/10 built the ranked output table with `arrow_array` by hand, and
    all called it easy. No table type added (pond-ts has none either);
    the crate docs now show the whole Q11 shape: partition, `tail` +
    `reduce`, rank, `RecordBatch::try_from_iter`.
  - 2/10 did not know `rolling` keeps only its outputs: now said on
    `TimeSeries::rolling` and `PartitionedSeries::rolling`, with the
    `Last` output that keeps a source column.
  - Not ported: pond-ts `reduce(column, reducer)` (the one-output form;
    one `Agg` does it), custom reducer functions, and reducers pond-rs
    lacks (`unique`, `keep`, `top`, …). As in `aggregate`, a number
    reducer on a text column is an error in pond-rs where pond-ts gives 0
    or a gap ([PND-KINDREDUCE]).
  - Parity: 16 new fixture cases (8 `tail`, 8 `reduce`, including an empty
    series, signed zeros (`reduce-zeros`: first and min give -0), text and
    true/false outputs, a zero and a bad duration, time-range keys), all
    matching. `reduce` results are
    recorded as `reduced` (output name → cell).
  - Perf: no new walking code. `tail` is a binary search and a slice;
    `reduce` calls the `aggregate` kernels once over all rows.

  **Step 8a (done): finding rows ([PND-RUSTFULL]).**
  - Calls, each as pond-ts's same-named one: `at(i)` (negative counts from
    the end), `bisect(key)`, `includes_key`, `at_or_before`,
    `at_or_after`, `nearest` (ties to the earlier row; outside the series
    gives the first or last row), and `find` / `some` / `every` with a
    closure over each `Row` (`FnMut(&Row) -> Result<bool>`, as `filter`).
    Rows come back as `Row`; `Row::key()` gives the row's key.
  - Keys are a new `EventKey`: `EventKey::time(t)` (or a plain `i64`),
    `time_range(begin, end)`, `interval(label, begin, end)` with a `Label`
    (number or text). The constructors refuse start > end, as pond-ts's
    `TimeRange` / `Interval` do.
  - Order, as pond-ts `compare`: start, then end, then kind name under
    `localeCompare` (interval, time, time range), then between two
    intervals the label (numbers before text, text by the ICU root
    collation already used by `join`). Equality is pond-ts `equals`: same
    kind, start, end, and label by `===` (text byte for byte). `bisect` is
    pond-ts's binary search step for step, so rows out of label order
    (the `dupLabelled` input) give the same answer.
  - Differences from pond-ts:
    - A key is checked when built, so a backwards range is an error even
      where pond-ts never reads the key (`nearest` on an empty series).
    - Number labels must be finite (pond-ts does not check; pond-rs labels
      are finite everywhere).
    - Times are whole milliseconds (pond-ts accepts fractions).
  - Parity: a new `queries` section in the fixture, 2,628 lookups: 9
    inputs (every key kind, repeated keys, an empty series, labels out of
    order) × 52 keys of every kind (cross-kind, text labels that differ
    only by case, `-0` labels, backwards ranges) × the five key lookups,
    plus `at` at 11 positions and `find` / `some` / `every` with 7 tests.
    All match, bar the one known difference above.
  - Perf: no perf script. Key lookups are O(log N) binary searches (a
    text-label compare builds the collator once per call, only when two
    keys tie up to the label); `find` / `some` / `every` stop at the first
    answer, as pond-ts.

  **Step 8b (done): picking a time span ([PND-RUSTFULL]).**
  - Calls, each as pond-ts's same-named one: `within(begin, end)`,
    `contained_by` (pond-ts `containedBy`, and `within(range)`),
    `overlapping`, `trim`, `before`, `after`, `time_range`, `overlaps`,
    `contains`, `intersection`. Spans and boundaries are `EventKey`s (from
    8a); every test is inclusive at both ends, as in pond-ts. `before` /
    `after` both read the boundary's start (pond-ts does too). To test one
    series' span against another's, pass `other.time_range()`.
  - pond-ts bug found and fixed in the same PR ([PND-TRIMORDER]): `trim`
    could leave two keys on the same start in the wrong end order
    (`[0, 10]` and `[2, 5]` trimmed at 3 gave `[3, 10]` before `[3, 5]`).
    Lookups such as `bisect` were then wrong and `fromJSON` refused to
    reload the result. Both libraries now re-sort, stably, by start then end, only
    when clipping reordered keys (CHANGELOG "Fixed"). Note the policy
    differs from `asTime({ at: 'center' | 'end' })`, which refuses (throws)
    when moving keys would reorder rows: `trim` keeps whole rows, so a
    re-sort loses nothing, while `asTime` refusing was a choice already
    pinned by fixture cases (step 1).
  - Differences from pond-ts: a span is checked when built, so a backwards
    range is an error even on an empty series, where pond-ts `overlapping`
    / `trim` never build it (the harness names those two cases). pond-ts
    also throws on a bare number for `within(range)` / `containedBy` /
    `overlaps` (its types exclude it), while a pond-rs `i64` is a point in
    time; passing a `Time` in pond-ts gives the same answer.
  - Parity: 342 new fixture cases (9 inputs of every key kind × 9 spans
    for `overlapping` / `containedBy` / `trim`, 4 boundaries for `before` /
    `after`, 3 `within` pairs), including trims that reorder keys; and 279
    new `queries` entries for `timeRange` / `overlaps` / `contains` /
    `intersection`. All match bar the named differences.
  - Perf: point-in-time keys use two binary searches and a slice that
    shares memory (O(log N)); range and interval keys are walked once
    (O(N)), as in pond-ts. `trim` adds an O(N) order check and sorts only
    when clipping reordered keys.

  **Step 8c (done): changing key type ([PND-RUSTFULL]).**
  - Calls: `as_time_range` (pond-ts `asTimeRange`), `as_interval(label)`
    and `as_interval_with(|range, row| label)` (pond-ts `asInterval` with a
    value or a function), `offset_time("-1h")` and `offset_time_ms(n)`
    (pond-ts `offsetTime` with a duration or a number). Each keeps every
    row's extent (or moves it) and shares the value columns. As in
    pond-ts: a value column already named `timeRange` / `interval` is an
    error; labels must be one kind (all numbers or all text); an empty
    series gets text labels; a zero offset returns the series as it is;
    `"1.5s"`, `"+1s"` and `"--1s"` are refused, and so is a label that is
    `NaN` or infinite (pond-ts stores it as a missing label and throws).
  - Differences from pond-ts: offsets are whole milliseconds (pond-ts
    takes `offsetTime(0.5)`); `offset_time`
    refuses a key moved past ±`MAX_TIME_MS` (pond-ts allows it, but such a
    key cannot be read back).
  - Parity: 108 new fixture cases (6 inputs of every key kind, including
    an empty one and one with a column named `interval`: `asTimeRange`; 7
    labels for `asInterval`, among them `-0`, per-row closures and a mixed
    kind; 10 offsets for `offsetTime`), 29 of them errors. All match. The
    fixture now writes a `-0` argument as `{"f64": "-0"}`, as JSON drops
    the sign.
  - Perf: one pass over the keys (O(N)); value columns are not copied.

  **Step 8d (done): row JSON input and output ([PND-RUSTFULL]).**
  - Calls: `from_json(text, &JsonOptions)` / `from_json_value` and
    `to_json(RowFormat)` / `to_json_value`, as pond-ts `fromJSON` /
    `toJSON`: the `{name, schema, rows}` format, array or object rows,
    every key kind in both its forms, `null` gaps. `JsonOptions` carries
    `time_zone` (pond-ts `parse.timeZone`; times written as text are read
    by `parse_time_in`) and `order` (`KeyOrder::Strict` / `Reorder` /
    `Clamp`, pond-ts `ordering`). `serde_json` became a normal dependency
    (it was a test-only one), re-exported for the `_value` forms, with
    only `float_roundtrip` (Cargo shares features across a build, so
    `preserve_order` was left to the tests); `zmij`, which serde_json
    already uses, gives `to_json` its shortest digits.
  - pond-ts bug found and fixed in the same PR ([PND-JSONLABEL]): an
    interval label of `true`, `false`, `null` or an array was stored as a
    number (`true` became 1, `null` became 0) by `fromJSON`,
    `new TimeSeries` and anything else building an `Interval`.
    `new Interval` now throws, as `fromColumns` already did (CHANGELOG
    "Fixed").
  - Differences from pond-ts: times must be whole milliseconds within
    ±`MAX_TIME_MS` (pond-ts takes `1.5` and `8.64e15 + 1`); a missing
    `name` is an error; text with a lone UTF-16 surrogate (`"\ud800"`)
    is refused, as it is not valid Unicode; `to_json` writes each schema
    column's `name`, `kind` and `required: false` only, where pond-ts
    writes back the schema it was given (extra properties,
    `required: true`); an `array` column was refused until 8e; `to_json`
    refuses a decimal column (pond-ts has no decimal kind; writing it as
    a number would lose exactness), pointing to `map_decimals` or Arrow.
  - Parity: a new `json` fixture section. `toJSON`: every input in both
    row formats (68). `fromJSON`: each of those read back, plus 63
    hand-written payloads (time text in four zones including DST gaps,
    object rows with missing and extra names, the three orderings, every
    key form, and the errors): 131. All match. A fuzz of 80,000 random
    payloads (random key kinds and forms, gaps, wrong-kind cells, time
    text, orderings) against pond-ts found no differences.
  - Perf (`examples/perf_json.rs`, pond-ts's `perf-to-json.mjs` workloads,
    text in and out; pond-ts is `JSON.stringify(toJSON())` and
    `fromJSON(JSON.parse(text))`):

    | Workload           | to_json array | to_json object | from_json   |
    | ------------------ | ------------- | -------------- | ----------- |
    | dense 100k x 6     | 34 vs 148 ms  | 30 vs 128 ms   | 71 vs 152   |
    | with text 100k x 7 | 34 vs 155 ms  | 34 vs 160 ms   | 86 vs 151   |
    | 10% gaps 100k x 6  | 30 vs 108 ms  | 32 vs 131 ms   | 69 vs 172   |
    | wide 10k x 41      | 9 vs 25 ms    | 10 vs 98 ms    | 23–30 vs 24 |

    `to_json` writes text directly; a first version that built a
    `serde_json::Value` tree took 84 / 303 ms (array / object) on the
    dense case, slower than pond-ts for object rows. Writing numbers
    byte-for-byte as JavaScript does (`0.000001`, `1e+21`, ties to the
    even digit; checked on 900,000 random numbers) costs about 15 ms of
    the dense case. `from_json` parses to a `Value` tree, then walks it
    once (O(N·C)); on the wide case it varies run to run around pond-ts's
    time.

  **Step 8d2 (done): columns and points JSON ([PND-RUSTFULL]).**
  - Calls: `from_columns_json(text, KeyOrder)` / `from_columns_value` and
    `to_columns_json` / `to_columns_value`, as pond-ts `fromColumns` /
    `toColumns` (`{name, schema, columns}`, one array per column; a time
    range or interval key is written as `<key>`, `<key>End` and
    `<key>Label`, pond-ts's `flat-keys.ts` names). `from_points_json`
    (text, a name and a `&[ColumnDef]` schema) / `from_points_value` and `to_points_json` /
    `to_points_value`, as pond-ts `fromPoints` / `toPoints`
    (`[{ts, col: value}]`, the time or a span's start under `ts`, a gap
    left out). `fromColumns` takes no time zone, so it takes `KeyOrder`
    alone rather than `JsonOptions`; `fromPoints` has no ordering option,
    so pond-rs has none either.
  - pond-ts bug found and fixed in the same PR: `fromPoints` refused a
    `null` cell ("expected finite number"), so points parsed from JSON
    with a gap could not be read back, though `fromJSON` reads `null` as a
    gap. It now reads `null` as a gap (CHANGELOG "Fixed").
  - pond-ts bugs logged, not fixed: [PND-COLSREQ] (`fromColumns` ignores
    `required`) and [PND-POINTSTS] (a value column named `ts` in points).
  - Differences from pond-ts: a column with gaps is optional whatever the
    schema says ([PND-COLSREQ]; pond-rs cannot hold a required column
    with gaps); `from_columns_json` refuses cells pond-ts coerces (`"5"`
    or `true` in a number column, which pond-ts reads as 5 and 1; a
    number in a text column, which pond-ts stores as a gap; a key written
    as `"5"` or `true`); times must be whole milliseconds within
    ±`MAX_TIME_MS`; a missing `name` is an error; a value column named
    `ts` is refused by both points calls ([PND-POINTSTS]);
    `from_columns_json` refuses a number too large for an `f64` (`1e400`,
    which pond-ts reads as `Infinity`, a gap). Names are written in schema
    order, where JavaScript puts names that look like whole numbers (`"1"`)
    first (`to_json` object rows already differ the same way; the JSON
    means the same). As in pond-ts, `from_columns_json` takes number and
    text columns only (a `boolean` column is an error), though
    `to_columns_json` writes true/false.
  - Parity: a new `columnsJson` fixture section. `toColumns` and
    `toPoints` of every input (34 each); `fromColumns` of each input's
    own output plus 51 hand-written payloads (every key kind, the three
    orderings, missing and short columns, label errors, name collisions,
    the coerced cells): 80; `fromPoints` of each time-keyed input's
    points plus 19 payloads: 41. 189 cases, all match. A fuzz of 40,000
    random payloads (columns and points: random key kinds, orderings,
    gaps, wrong-kind cells, interval labels) against pond-ts found no
    differences, `to_columns_json` / `to_points_json` text byte-for-byte
    included (its column names are `c0`, `p0`, …, so the name-order
    difference above does not arise). The fuzz is not committed; the
    fixture's `same_json` compares parsed JSON, so it checks values, not
    text.
  - Perf: reading first parsed into `serde_json::Value`, which made
    `from_points_json` as slow as pond-ts on 100k points and 2.4x slower
    on the wide case (116 vs 48 ms): a `Value` object is a sorted map that
    owns every key. The readers (`from_json` too) now parse into a light
    tree of their own (`json_text.rs`: text borrowed where it has no
    escapes, objects as lists of pairs) and place each object entry by
    position, falling back to a lookup by name. The `_value` forms borrow
    the caller's `Value` into the same tree. Medians of three runs
    (`examples/perf_json.rs`; pond-ts is `JSON.stringify(toColumns())`,
    `fromColumns(JSON.parse(text))` and the same for points):

    | Workload           | to_columns   | from_columns | to_points    | from_points  |
    | ------------------ | ------------ | ------------ | ------------ | ------------ |
    | dense 100k x 6     | 30 vs 72 ms  | 31 vs 46 ms  | 32 vs 147 ms | 65 vs 175 ms |
    | with text 100k x 7 | 31 vs 121 ms | 36 vs 52 ms  | 38 vs 137 ms | 89 vs 166 ms |
    | 10% gaps 100k x 6  | 28 vs 91 ms  | 30 vs 46 ms  | 29 vs 103 ms | 66 vs 133 ms |
    | wide 10k x 41      | 9 vs 10 ms   | 14 vs 6 ms   | 12 vs 80 ms  | 28 vs 55 ms  |

    `from_json` gained from the same change: 45 ms on the dense case (was
    71), 58 with text (was 86), 46 with gaps (was 69). One case is slower
    than pond-ts: `from_columns_json` on the wide case (410,000 small
    whole numbers), 14 vs 6 ms. Parsing alone is 12 ms of it; serde_json
    reads the same text into `Vec<Option<f64>>` in 7 ms, so a reader typed
    by the schema could close most of the gap. Not done: it would mean a
    second parser for one shape.

  **Step 8e (done): array columns ([PND-RUSTFULL]).**
  - Storage: `ArrayColumn`, one shared list per row (`Arc<[Scalar]>`) or
    `None` for a gap, where a `Scalar` is a number, text or true/false
    value, mixed freely, as pond-ts `kind: 'array'`. An empty list is a
    value, not a gap. Slicing, picking rows and joining share the lists
    rather than copying them. Numbers must be finite, checked when a series
    is built. New with it: `ColumnKind::Array` (`"array"`), `Value::Array`,
    `Column::arrays`, `Row::array`, `Reduced::array`, `map_arrays`.
  - Calls: `array_contains` / `array_contains_all` / `array_contains_any`,
    `array_aggregate` and `array_explode`, with
    `ArrayOptions { output, kind }` for pond-ts's `{ as, kind }`. Matching
    is JavaScript's `includes` (`0` matches `-0`, kinds never mix).
    `array_aggregate` reduces each array as a bucket with pond-ts's row-path
    kernels (sums left to right, the first of equal values for `min` /
    `max`, a stable sort for percentiles), which differ from the column
    kernels `aggregate` uses.
  - Other calls with array columns: `select`, `rename`, `filter`, `slice`,
    `shift`, `fill` (`Hold`, `Bfill` or a `Value::Array`; `Linear` and
    `Zero` skip arrays in `fill_all`, as for text), `align` (holds),
    `materialize`, `dedupe`, `join`, and partitioned calls by another
    column. `aggregate` / `rolling` / `reduce` take `count` (of cells),
    `first` and `last` on an array column; reducers that need numbers are an
    error, as on text. JSON rows, points and `to_columns_json` read and
    write arrays; `from_columns_json` refuses them, as pond-ts `fromColumns`
    does.
  - Differences from pond-ts, each where pond-ts gives an error or a result
    that cannot be meant: a column that is not an array is an error (pond-ts
    gives an empty series, or for `arrayAggregate` overwrites the column
    with gaps); `first` / `last` / `array_explode` without a kind take the
    elements' kind (pond-ts uses `string` and throws on numbers); a number
    reducer with a kind other than number, or an output named after another
    column, is an error up front; `partition_by` refuses an array column
    (pond-ts keys arrays by their text, so `['a,b']` and `['a', 'b']` share
    a partition); `map_arrays` and a fill value with a non-finite number are
    errors (pond-ts silently leaves a gap); `shift` works (pond-ts throws an
    internal error). `to_arrow` refused an array column, as pond-ts
    `toArrow` does, until 8e2.
  - Not yet: the reducers that give arrays (`unique`, `samples`, `top`) and
    `keep` / `difference`, which are step 8f.
  - pond-ts bugs logged, not fixed: [PND-ARRAYCHECK], [PND-ARRAYKIND],
    [PND-ARRAYKEY], [PND-ARRAYSLOW].
  - Parity: 85 new cases on three new inputs (text arrays, number arrays
    with `-0` and `0` in both orders, and arrays of mixed kinds): each
    operation, every reducer, `as` and `kind`, the error cases, and arrays
    through the other calls above. The new inputs also go through every JSON
    door (24 more). Two cases are known differences (no kind on number
    arrays); each is checked against its `kind: 'number'` twin. A fuzz of
    40,000 random calls (all five operations, random element pools including
    `-0`, gaps, empty arrays, `as` and `kind`) against pond-ts found no
    differences. The fuzz is not committed.
  - Perf (`examples/perf_array.rs`; 100k rows, text arrays of 0 to 6 words
    and number arrays of 0 to 8 values, a gap every tenth row; "single" is
    one element per array; pond-ts runs the same calls). Cost:
    `array_contains*` O(N·L·V) for N rows, L elements and V values asked
    for; `array_aggregate` O(N·L), with a sort per array for percentiles;
    `array_explode` O(E·C) for E elements and C columns. Medians, pond-rs vs
    pond-ts:

    | Call                 | typical       | single        |
    | -------------------- | ------------- | ------------- |
    | `array_contains`     | 4.1 vs 44 ms  | 0.7 vs 12 ms  |
    | `array_contains_any` | 5.7 vs 71 ms  | 1.9 vs 34 ms  |
    | `array_contains_all` | 4.6 vs 43 ms  | 0.7 vs 9 ms   |
    | aggregate `count`    | 6.6 vs 319 ms | 2.3 vs 223 ms |
    | aggregate `avg`      | 6.9 vs 366 ms | 2.9 vs 229 ms |
    | aggregate `median`   | 8.1 vs 331 ms | 3.5 vs 273 ms |
    | aggregate `first`    | 3.7 vs 357 ms | 1.6 vs 245 ms |
    | explode text         | 38 vs 891 ms  | 5.9 vs 213 ms |
    | explode numbers      | 46 vs 823 ms  | 4.9 vs 146 ms |
    | `to_json`            | 53 vs 103 ms  | 19 vs 65 ms   |
    | `from_json`          | 162 vs 445 ms | 95 vs 298 ms  |

    `from_json` spends most of its time making one list per row and one
    string per text element. pond-ts's array calls go row by row through its
    `Event` objects ([PND-ARRAYSLOW]).

  **Step 8e2 (done): array columns as Arrow lists ([PND-RUSTFULL]).**
  - Writing: `to_arrow` / `write_ipc` write an array column as a `List` of
    `Float64`, `Utf8` or `Boolean` items (items never null), gaps as null
    lists, the field nullable unless the column is required. Every element
    in the column must be the same kind, as an Arrow list holds one item
    type; a column that mixes kinds is an error naming the first element
    that differs and suggesting `map_arrays` or `select`. A column with no
    elements at all is written as a list of `Utf8`. Scope as Peter agreed
    on the 2026-10-20 decision card: one item kind per list, mixed arrays
    refused (an Arrow union type could hold them; not built).
  - Reading: `from_arrow` / `read_ipc` read `List`, `LargeList` and
    `FixedSizeList` fields as array columns. Items may be any type read as
    a number column (integers, floats, times in milliseconds, number
    dictionaries), any text type (dictionaries and `Utf8View` included) or
    `Boolean`. A null list is a gap; a null item, or a `NaN` or infinite
    number, is an error, since array elements cannot be gaps; decimal and
    nested-list items are refused, naming the type. Only items some row
    uses are read: items under a null list or outside a slice are never
    looked at, so they cannot cause an error (the review of #795 found the
    first version failing on a too-large time no row used, and naming the
    wrong row for one a row did use).
  - pond-ts: its `fromArrow` and `toArrow` refuse list fields, so a file
    with an array column written by pond-rs does not read in pond-ts. Not
    logged as a pond-ts task: nothing asks for it yet.
  - Checked against other writers and readers: eight list files written by
    pyarrow and polars (`tests/data/arrow-types/list*.arrow`, made by
    `generate.py`; `List`, `LargeList`, `FixedSizeList`, items of `double`,
    `int64`, `string`, text dictionaries, `string_view` from polars, `bool`
    and `timestamp[us]`) read as `expected-lists.json` says, and write back
    unchanged. pyarrow, polars and apache-arrow JS read a pond-rs file with
    number, text and true/false list columns, gaps and empty lists (checked
    by hand, not committed).
  - Perf (`examples/perf_array.rs`, Arrow rows added; the two array columns
    of the 8e benchmark alone, about 630k elements in 180k lists).
    Cost: O(N + E) for N rows and E elements both ways; reading makes one
    string per text element. The first version cloned each element out of
    the decoded items; moving them instead halved the read. Medians, before
    and after that change:

    | Call                    | typical     | single     |
    | ----------------------- | ----------- | ---------- |
    | `to_arrow`              | 14 ms       | 4.9 ms     |
    | `write_ipc`             | 15 ms       | 5.6 ms     |
    | `from_arrow`            | 92 → 45 ms  | 32 → 24 ms |
    | `read_ipc`              | 108 → 47 ms | 32 → 26 ms |
    | `from_json` (for scale) | 190 ms      | 99 ms      |

  **Before step 8f (done): a pond-ts fix, [PND-AGGSIBLING].**
  - Found while planning 8f. pond-ts `aggregate` chose one method for the
    whole call: a single column without a columnar kernel (`unique`, `top`,
    `samples`, `keep`, `difference`, a reducer over a text, boolean or
    array column, a custom function) sent every column down the row path.
    There `sum` / `avg` add sequentially instead of in eight lanes (last-ulp
    differences on buckets of 32+ values) and `median` sorts with a stable
    sort instead of a typed-array sort (so a zero can come out as `-0`).
    Checked: on 40 random series, 25 gave a different `sum` / `avg` once a
    `count` of a text column joined the call; on series with zeros, 10 of
    40 gave a different `median`. pond-rs computes each column on its own,
    so it already disagreed with pond-ts on such calls, and every 8f
    reducer would have triggered it.
  - Peter chose to fix pond-ts (2026-10-20 decision card, merged as #796)
    over copying the behaviour into pond-rs or recording it as a
    difference. Each column is now planned on its own: range kernel,
    first/last boundary scan, or else the reducer's bucket state fed that
    column's cells (the same values, in the same order, the row path feeds
    it). The row path remains only for a missing source column and for range- and
    interval-keyed series.
  - Rolling and `reduce` were checked the same way and do not have the
    problem (count-window rolling is all-or-nothing too, but both of its
    paths drive the same rolling states).
  - Mixed calls got 2-10x faster (`scripts/perf-aggregate-mixed.mjs`).

  **Step 8f (done): `keep` and `difference` ([PND-RUSTFULL]).**
  - Split: 8f is the two reducers that give one value; `unique`, `top` and
    `samples`, which give arrays, follow as 8f2.
  - `Reducer::Keep` and `Reducer::Difference` (parsed from `"keep"` and
    `"difference"`) work in `aggregate`, `rolling`, `reduce`, partitioned
    `aggregate` and `array_aggregate`.
  - `difference`: number and decimal columns only (others are an error, as
    for `sum`). `aggregate` / `reduce`: largest minus smallest, never `-0`.
    `rolling`: pond-ts kept the window sorted (a splice per row, O(W) per
    row for a window of W rows) and answered last minus first. pond-rs uses
    two monotone deques (O(1) per row) plus a stack of zero signs, because
    the sorted window gives a sign-dependent answer in one case: a window
    of only zeros, where it can give `-0`. pond-ts now does the same
    ([PND-ROLLDIFF], #799). A unit test checks the
    deques against a port of pond-ts's sorted window on 300 random series
    full of `0` and `-0`. Decimals are exact: the smallest and largest by
    rank, subtracted in 256 bits, at precision 38, an error past it
    naming the row.
  - `keep`: any column kind; the output has the source's kind. Numbers
    compare as `===` (`0` equals `-0`): `aggregate` and `reduce` give the
    first value's sign, `rolling` gives `0` (pond-ts counts values in a
    `Map`, whose keys turn `-0` into `0`). `rolling` answers "one distinct
    value" as largest equals smallest with two deques, not a counting map.
    Text, true/false and array columns get an id per distinct value (a
    hash map, skipped when a row repeats the row before). Decimals stay
    exact through ranks.
  - Differences from pond-ts, both already logged: pond-rs compares array
    cells by their elements, bit for bit, where pond-ts compares the array
    objects, so two equal arrays keep their value here and give a gap
    there ([PND-ARRAYKEY]). Bit for bit, so `[0]` and `[-0]` differ: the
    first version let them match, and a bucket holding only `[-0]` then
    gave an earlier row's `[0]` (found in the review of #797); `array_aggregate` with `keep` takes the elements'
    kind where pond-ts writes text and throws on numbers ([PND-ARRAYKIND]).
  - Parity: 18 new pond-ts cases (fixture made with [PND-AGGSIBLING] in),
    on a new `runs` input (equal runs, zeros of both signs in both orders,
    text and true/false runs) plus `zeros`, `noisy`, `hosts` and the array
    inputs, each `keep` / `difference` next to a `sum` or `avg`. Six
    planted bugs (rolling `keep` without the `-0` to `0` change, rolling
    `difference` reversed or without its sign, `keep` dropping the sign,
    `difference` off by its low end, arrays compared by bits) each failed
    the parity test. The brute-force property tests now cover both.
  - Perf (`examples/perf_reducers.rs`, 1M rows 1 s apart). Cost: O(N) per
    column for `aggregate`, `reduce` and `rolling`, any window size. Two
    changes from the first version: rolling `keep` by deques instead of a
    hash map (41 to 20 ms on numbers, 94 to 49 ms on text); and the
    repeated-row check before hashing text (`reduce` 27 to 6 ms). pond-rs
    vs pond-ts, medians:

    | Call              | agg 1m       | agg 1s       | rolling 5m   | reduce         |
    | ----------------- | ------------ | ------------ | ------------ | -------------- |
    | `min` (for scale) | 3.0 vs 7 ms  | 35 vs 413 ms | 16 vs 209 ms | 1.1 vs 2 ms    |
    | `keep` numbers    | 1.6 vs 19 ms | 35 vs 561 ms | 21 vs 190 ms | <0.1 vs 102 ms |
    | `difference`      | 3.5 vs 29 ms | 37 vs 816 ms | 27 vs 690 ms | 2.2 vs 353 ms  |
    | `keep` text       | 9.1 vs 26 ms | 69 vs 415 ms | 49 vs 159 ms | 6.1 vs 71 ms   |
    | `keep` decimal    | 12 ms        | 62 ms        | 47 ms        | 8.5 ms         |
    | `difference` dec. | 14 ms        | 99 ms        | 91 ms        | 12 ms          |

    Rolling over a 1-day window (86,400 rows) costs pond-rs the same as
    5 minutes (25 ms for `difference`). pond-ts's rolling `difference`
    kept a sorted window then, so it grew with the window: 11.4 s at 1
    day. [PND-ROLLDIFF] (#799) moved it onto the same two deques, ~250 ms
    at every window size (see `PND_COLUMNAR_PLAN.md`). An earlier run here
    measured 96 s at 1 day, which did not reproduce. pond-rs's rolling
    `median` and percentiles keep the sorted window, as pond-ts's do; a
    faster structure for those is not part of this step.

  **Step 8f2 (done): `unique`, `top<N>` and `samples` ([PND-RUSTFULL]).**
  - `Reducer::Unique`, `Reducer::Top(n)` and `Reducer::Samples` (parsed
    from `"unique"`, `"top3"`, `"samples"`; `top0` is an unknown reducer,
    as in pond-ts, and `top007` is 7) give lists: an array column. They
    work in the same calls as 8f, on every column kind. Each array cell
    is flattened one level, as pond-ts does, so a bucket of `["a", "b"]`
    and `["b"]` holds `a`, `b`, `b`. Nothing present gives an empty list,
    not a gap (also as pond-ts). Decimals are read as their nearest `f64`.
  - Order: `unique` sorts numbers, then text, then true/false (pond-ts
    `compareScalars`), text by UTF-16 code units as JavaScript's `<` does,
    which is not Rust's byte order (`"\u{FFFF}"` sorts after `"😀"`; the
    parity input holds both). `top` is most frequent first, ties in the
    `unique` order. `0` and `-0` are one value, written `0`, as keys of a
    JavaScript `Set` or `Map` are; `samples` keeps `-0` and arrival order.
  - How: every element gets an id once per call (`elements.rs`, a hash
    map, skipped on a repeat of the element before), and ids are numbered
    in `unique` order, so counting and sorting never compare text.
    Rolling keeps the window's distinct ids in a `BTreeSet` (`top`: by
    count, then id); `samples` reads the window's rows directly, as the
    window is always a run of rows. A list equal to the one before (a
    host that reports for a while) shares its memory instead of copying
    the values.
  - Parity: 18 new pond-ts cases (aggregate, rolling and reduce over
    numbers with signed zeros, text, true/false and array columns, an
    empty series, partitioned aggregate, and `array_aggregate`). Seven
    planted bugs each failed them (byte order for text, `-0` not merged,
    `samples` merging `-0`, `top` ties reversed, empty list as a gap,
    `unique` reversed, `top` one too many). A unit test checks the
    rolling states against the bucket kernels on 200 random series.
  - `PondError::UnsupportedReducer` is gone: pond-rs now has every
    pond-ts reducer, so nothing returned it.
  - Perf (`examples/perf_reducers.rs`, 1M rows 1 s apart, `v` numbers in
    runs of 40, `host` one of 8 names in runs of 90). Cost: O(E) to give
    ids to E elements, then per bucket O(k log k) for its k elements; per
    rolling row O(log D) for D distinct values in the window, plus the
    output list, which for `samples` is the whole window. Reusing equal
    lists took aggregate over 1 s buckets from 188 to 81 ms and rolling
    `unique` on `host` from 605 to 105 ms. pond-rs vs pond-ts, medians:

    | Call           | agg 1m      | agg 1s        | rolling 5m     | reduce       |
    | -------------- | ----------- | ------------- | -------------- | ------------ |
    | `unique` nums  | 12 vs 65 ms | 81 vs 1828 ms | 123 vs 1814 ms | 8 vs 147 ms  |
    | `unique` text  | 14 vs 43 ms | 89 vs 1792 ms | 105 vs 1383 ms | 10 vs 94 ms  |
    | `top3` nums    | 15 vs 103ms | 86 vs 3112 ms | 186 vs 3329 ms | 9 vs 203 ms  |
    | `top3` text    | 15 vs 71 ms | 89 vs 2920 ms | 163 vs 2619 ms | 11 vs 121 ms |
    | `samples` nums | 41 vs 235ms | 74 vs 2441 ms | 14.4 vs 97.8 s | 22 vs 194 ms |

    Rolling `samples` over 5 minutes writes about 280 values for each of
    1M rows; that output, not the reducer, is the cost in both.

  **Step 8g (done): rolling options ([PND-RUSTFULL]).**
  - Calls: `rolling_with(window, aggs, Rolling)` and
    `rolling_rows(n, aggs, Rolling)` (pond-ts `rolling(window, …)` and
    `rolling({ count }, …)`; `Rolling` holds `alignment` and
    `min_samples`, pond-ts's `alignment` and `minSamples`), and
    `rolling_over(&sequence, window, aggs, RollingOver)` (pond-ts
    `rolling(sequence, window, …)`; `RollingOver` adds `sample` and
    `range`). `rolling(window, aggs)` is unchanged and is
    `rolling_with` with `Rolling::default()`. All three are also on
    `PartitionedSeries`. Separate calls rather than one `rolling` taking
    an enum, so each reads plainly at the call site, and the options
    structs follow `Align` / `Materialize`.
  - `Alignment::Trailing` / `Leading` / `Centered` (pond-ts's spelling).
    A time window for a row at `t` holds starts in `(t - w, t]`,
    `[t, t + w)` or `[t - w/2, t + w/2)`; rows sharing a time share a
    window. Window edges are worked out in f64 exactly as pond-ts does: a
    centred window an odd number of ms long has edges on a half
    millisecond, which f64 rounds to even past 2^52 ms (after the year
    144,000). The first version compared doubled whole numbers, which kept
    the half exactly and so disagreed with pond-ts there; the review of
    #798 found it. A row window
    holds `n` rows by position (an even `n` centred has one more row
    after than before) and is per row, not per time.
  - `min_samples` counts rows in the window, gaps included (pond-ts
    `windowEnd - windowStart`). A window under it is not read at all,
    as in pond-ts; that matters for `stdev`, whose state can move its
    reference point when read.
  - The order rows enter and leave the window follows pond-ts: a
    trailing or row window takes rows in first, a leading or centred
    time window lets rows go first. This changes the last bits of a
    running sum: swapping it for leading windows fails 3 parity cases.
  - `rolling_over` reduces each window as `aggregate` reduces a bucket
    (pond-ts runs its aggregate reducers there, not the rolling states),
    so the bucket-reducing code moved into `reduce_columns`, shared by
    both. Windows are found with two cursors. The result is keyed by the
    buckets, named `interval`; buckets are picked as in `align`; an
    output named `interval` is an error. Any key kind works (ranges and
    intervals count by their start); `aggregate` still refuses them.
  - Parity: 84 new pond-ts cases (957 in all). Every alignment over
    time and row windows and grids on numbers with repeated times, signed
    zeros and a long silence, on text / true/false / list reducers and
    array columns, on interval keys; minimum counts; row counts 1, 3, 4
    and 500; half-millisecond edges; `sample` begin / center / end;
    `range`; an empty series; a calendar grid; per partition (`collect`
    and `toMap`); keys past 2^52 ms; a grid minimum gapping list columns;
    errors for a 0-row window and an `interval` output.
    Eight planted bugs each failed them (one only after the two
    half-millisecond cases were added). Property tests now draw a random
    alignment, row or time window and minimum for `rolling` and
    `rolling_over` (numbers and decimals) and check them by brute force.
  - Perf (`examples/perf_rolling.rs` and `bench/rolling_pond_ts.mjs`,
    1M rows 1 s apart, `v` with a gap every 17th row; checksums agree).
    Cost: a time or row window moves forward only, so each row enters
    and leaves once, O(N), plus the reducer state; a grid window costs
    O(N + B) to find and O(W) to reduce, so O(B·W) for B buckets of W
    rows. Trailing windows did not slow down (26 to 29 ms for `avg` over
    5 minutes before and after, on a busy machine). pond-rs vs pond-ts,
    medians:

    | Call                         | pond-rs | pond-ts  |
    | ---------------------------- | ------- | -------- |
    | time 5m `avg` trailing       | 33 ms   | 377 ms   |
    | time 5m `avg` leading        | 36 ms   | 474 ms   |
    | time 5m `avg` centred        | 36 ms   | 345 ms   |
    | time 5m `stdev` centred      | 64 ms   | 403 ms   |
    | time 5m `avg`, minimum 300   | 30 ms   | 576 ms   |
    | 20 rows `avg`                | 26 ms   | 31 ms    |
    | 20 rows `avg`, minimum 20    | 24 ms   | 28 ms    |
    | 20 rows `stdev`              | 62 ms   | 179 ms   |
    | 300 rows `avg` centred       | 27 ms   | 30 ms    |
    | 20 rows `avg` per host       | 169 ms  | 3252 ms  |
    | grid 1m, 5m `avg`, 100k rows | 0.7 ms  | 12856 ms |
    | grid 1m, 5m `avg`, 1M rows   | 11 ms   | -        |
    | grid 1s, 5m `avg`, 1M rows   | 352 ms  | -        |

    Row windows of `avg` are only 1.2x pond-ts, under the 2x target.
    pond-ts has a fast path for them that runs the same double-double
    running sum; that sum is a chain of dependent additions, and both
    sides must do it the same way to give the same bits. Evidence: a
    1-row `avg` window still takes 21 ms where a 20-row `count` takes 9.
    Two pond-ts slowdowns found here are logged as [PND-ROLLFAST] (one
    text output drops a row-window call off that fast path, which every
    partitioned call hits) and [PND-ROLLGRID] (grid windows scan every
    row for every bucket). The 1 s grid is pond-rs's slowest case: each
    of 1M windows is reduced afresh (300 rows each); sliding states
    would be faster but give `aggregate`'s bits only for some reducers.

  **Step 8h (done): smoothing and band statistics ([PND-RUSTFULL]).**
  - Calls: `smooth(column, &Smooth)` with `Smooth::ema(alpha)`,
    `Smooth::ema_span(span)`, `Smooth::moving_average(window)` and
    `Smooth::loess(span)`, plus `.output(name)`, `.warmup(rows)`,
    `.min_samples(n)`, `.alignment(a)` and `.skip_missing()` (pond-ts
    `smooth(column, method, options)`). An option the method does not
    take is an error, where pond-ts's types forbid it.
    `baseline(column, window, sigma, Rolling)` and `baseline_named`
    (which adds the four names: avg, sd, upper, lower),
    `outliers(column, window, sigma, Rolling)` (reusing `Rolling` for
    `alignment` / `min_samples`), `scan(column, init, step)` and
    `scan_to(column, output, init, step)` with a step of type
    `FnMut(A, f64, usize) -> (A, f64)`, and `sample` taking
    `Sample::Stride(n)` or `Sample::Reservoir { size, seed }`.
  - Moving average and loess place a time-range or interval row at its
    midpoint, `begin + (end - begin) / 2` in f64 as pond-ts does, which
    can be half a millisecond. The window walk now takes `f64` anchors
    as well as whole ms (an `Anchor` trait on `Frame`), so the moving
    average is the rolling `avg` state over those anchors and gives its
    bits; a property test checks the two agree exactly on time keys.
  - Reservoir sampling is random in pond-ts (`Math.random`, no seed).
    pond-rs takes a seed (SplitMix64) so a run can be repeated, and keeps
    the picked rows in series order; pond-ts sorts them by key, which
    can order rows that share a key differently. Only a reservoir that
    keeps every row is in the fixture.
  - Two pond-ts bugs fixed here. [PND-SMOOTHMID]: keys sort by start, so
    the midpoints of a long range before a short one run backwards, and
    `movingAverage` and `loess` both assumed they were in order (a 2 ms
    moving average over `[0, 10]`, `[1, 1]`, `[2, 2]`, `[3, 3]` gave every
    row the mean of all four). Both now work in midpoint order; time
    keys and ranges whose midpoints are in order are unchanged. Found by
    the moving-average property test on random range keys.
    [PND-LOESSPOW]: the loess weight used `**`. Node 22's V8 computes it
    with an fdlibm port; current V8 uses a correctly rounded `pow`. On 2M
    values `r ** 3` from Node 22 differed from glibc's `pow` in ~10% of
    cases, so a fit's last bits depended on the Node version, and Rust
    could not match both. The weights are now products, which round the
    same everywhere; this also made pond-ts loess ~23x faster (0.05 span
    over 20k rows: 2651 to 117 ms).
  - Known differences, each checked by the harness: pond-rs refuses an
    unknown or non-number column for `smooth` and a non-number column
    for `baseline`, where pond-ts passes the series through or gives
    gaps ([PND-SMOOTHCHECK]). `baseline_named` refuses the key's name and repeated names,
    which pond-ts lets through. Values of 2^960 or more are refused by
    the moving average, and of 2^480 or more by `baseline` / `outliers`,
    as by `rolling`.
  - [PND-SCANREQ] fixed in pond-ts here (Peter approved the type change):
    `scan(…, { output })` used to mark its new column required though
    rows before the first value and non-finite outputs are gaps. It is
    now optional, so `get(output)` reads `number | undefined`.
  - Parity: 135 new pond-ts cases (1092 in all): every method and option
    on gaps, repeated times, signed zeros, overflow, odd-length and
    backwards range midpoints, keys past 2^52 ms, a loess fit whose
    denominator rounds to a tiny non-zero number and one where every
    neighbour shares a time, flat baseline windows, the four `scan`
    steps (sum, row index, non-finite outputs, hysteresis gain), strides,
    and each error. Planted bugs (13) failed them, after adding cases for
    the three the first set missed (an even-length range, so loess's
    shift invariance could not hide a wrong midpoint; the two loess
    corner cases; a flat window whose mean rounds off its value). Four
    property tests check the moving average, loess (a different
    neighbour rule and least-squares solve), `baseline` / `outliers` and
    `scan` / stride by brute force; another checks reservoir picks are
    even over 20,000 seeds.
  - Perf (`examples/perf_smooth.rs` and `bench/smooth_pond_ts.mjs`, 1M
    rows 1 s apart, a gap every 17th row; checksums agree). Cost: EMA,
    `scan` and `sample` read each row once, O(N); the moving average,
    `baseline` and `outliers` slide a window as `rolling` does, O(N),
    plus O(N log N) to sort backwards midpoints; loess is O(N·k) for k =
    span·N neighbours, so O(N^2) for a fixed span, in both libraries.
    Medians, 4 cores:

    | Call                            | pond-rs | pond-ts |
    | ------------------------------- | ------- | ------- |
    | EMA alpha 0.1                   | 5.6 ms  | 12 ms   |
    | EMA span 20, minimum 20         | 4.7 ms  | 11 ms   |
    | moving average 5m               | 18 ms   | 1967 ms |
    | moving average 5m centred, skip | 20 ms   | 1509 ms |
    | moving average 5m, range keys   | 68 ms   | 1684 ms |
    | loess 0.05, 20k rows            | 16 ms   | 113 ms  |
    | loess 0.3, 5k rows              | 5.5 ms  | 32 ms   |
    | `baseline` 5m                   | 54 ms   | 3862 ms |
    | `outliers` 5m                   | 49 ms   | 2007 ms |
    | `scan` running sum              | 7.0 ms  | 80 ms   |
    | `scan` hysteresis gain          | 5.9 ms  | 48 ms   |
    | `sample` stride 10              | 1.1 ms  | 32 ms   |
    | `sample` reservoir 1000         | 1.0 ms  | 17 ms   |

    Loess spreads rows over the cores; on one thread it takes 56 and
    20 ms. EMA is 2.2x pond-ts, whose EMA already runs straight off the
    column. pond-ts's moving average, `baseline` and `outliers` build one
    `Event` per row (~1.2 s of the ~2 s moving average), logged as
    [PND-SMOOTHSLOW].

  **Step 8i (done): `concat`, `collapse`, `pivot_by_group`
  ([PND-RUSTFULL]).**
  - Calls: `TimeSeries::concat(&[&TimeSeries])` (pond-ts
    `TimeSeries.concat`), `collapse(columns, output, f)` and
    `collapse_keep` (pond-ts `collapse(keys, output, reducer)`, the
    second with `{ append: true }`; `f` is
    `FnMut(&Row) -> Result<Option<Scalar>>`), and
    `pivot_by_group(group, value, &Pivot)` with `Pivot::aggregate(r)` and
    `Pivot::groups(names)`.
  - `concat` shares the partition merge (a stable radix sort by begin
    then end, then one gather per column). It refuses what it cannot
    stack: different keys or columns, decimals of different scales,
    interval labels of different kinds (pond-rs holds one label kind
    per series; pond-ts allows a mix). A column is required only when
    every input has it required.
  - `collapse` takes its output kind from the first value that is not a
    gap and refuses a later value of another kind; a non-finite number
    counts as a number for that (as in pond-ts) but is stored as a gap.
    The output is required when it has no gaps.
  - `pivot_by_group` names groups as JavaScript's `String` does (number
    formatting, `true` / `false`, array elements joined by commas, a gap
    as `undefined`, sharing a column with the text `"undefined"` as in
    pond-ts) and sorts them by UTF-16 code units, as JavaScript's
    default sort does (an emoji sorts before U+FF5E; by code points it
    would not). A lone row is copied as is; only cells of two or more
    rows go through the reducer, whose result must keep the value
    column's kind (checked up front, as pond-ts does). Decimal groups,
    which pond-ts has no kind for, are named in full (`1.50`).
  - Two pond-ts bugs fixed here. [PND-COLLAPSEKIND]: `collapse` took the
    output kind from the first row only, so a gap there made the column
    text and every later number became a gap; a result of a different
    kind was also dropped silently. The kind now comes from the first
    defined result and a mixed kind throws; an unknown key names itself
    instead of failing on `undefined.read`. [PND-CONCATREQ]: `concat`
    took each column's `required` flag from the first series, so gaps
    from a later series sat in a column marked required and the result
    failed to reload through `fromJSON`; a column is now optional when
    any input has it optional.
  - Known difference, checked by the harness: pond-ts marks `collapse`'s
    output required even when it holds gaps ([PND-COLLAPSEREQ], logged;
    its reducer's type returns no `undefined`, so fixing it changes a
    public type).
  - Parity: 64 new pond-ts cases (1156 in all): concat of two and three
    series with shared keys, itself, one series, empty inputs, ranges,
    labelled intervals, arrays, text and true/false columns, and both
    mismatch errors; collapse sums, ratios (non-finite results), a
    comparison giving true/false, joined text, all gaps, a first-row
    gap, an empty series, range and interval keys, and its errors;
    pivot on text, number and true/false groups with every reducer that
    keeps the kind, the ones that do not, declared and undeclared
    groups, arrays as groups and values, empty input, and its errors.
    Three property tests (concat as a stable sort, pivot against a
    direct build with each reducer, collapse row by row) and unit tests
    for the refusals. Of 23 planted bugs, all are caught but three that
    change nothing (a different sort order inside a time's rows, keeping
    `inf` instead of a gap where both read as a gap, a name cache that
    misses on `-0`).
  - Perf (`examples/perf_reshape.rs` and `bench/reshape_pond_ts.mjs`,
    1M rows; checksums agree). Cost: `concat` is a radix sort plus a
    copy per column, O(N); `collapse` calls the closure once a row,
    O(N); `pivot_by_group` names each distinct group once (a hash lookup
    a row), places rows with a counting sort over the T × G cells, O(N +
    T·G), and reduces only cells of two or more rows. The first version
    named every row's group afresh and sorted each time's rows (95 ms
    for 100 hosts); naming each group once and the counting sort brought
    it to ~45 ms. Medians, 4 cores (busy container, ±30%):

    | Call                           | pond-rs | pond-ts |
    | ------------------------------ | ------- | ------- |
    | concat 10 × 100k               | 49 ms   | 279 ms  |
    | concat 1000 × 1k               | 50 ms   | 432 ms  |
    | collapse, sum of two columns   | 24 ms   | 145 ms  |
    | collapse keeping the columns   | 24 ms   | 140 ms  |
    | pivot, 100 hosts × 10k times   | 47 ms   | 553 ms  |
    | pivot, 4 hosts × 250k times    | 39 ms   | 751 ms  |
    | pivot, 100 hosts, 2 rows, avg  | 72 ms   | 619 ms  |
    | pivot, 100 hosts, 2 rows, last | 74 ms   | 1036 ms |

  **Step 8i2 (done): `by_column`, `rolling_by_column`
  ([PND-RUSTFULL]).**
  - Calls: `by_column(column, &Bins, aggs)` (pond-ts `byColumn`) with
    `Bins::width(w)` / `width_from(w, origin)` / `edges(e)` /
    `edges_upper_inclusive(e)` (pond-ts `{ width, origin }` and
    `{ edges, inclusive }`); `rolling_by_column(column, radius, aggs)`
    and `rolling_by_column_at(column, radius, centers, aggs)` (pond-ts
    `rollingByColumn` with `{ radius }` and `{ radius, at }`). Both give
    a new `Table`: columns of equal length with no key, read by name as
    on a series (pond-ts gives an array of records). `by_column` puts
    `start` and `end` first.
  - `by_column` works out each row's bin with pond-ts's arithmetic (a
    width bin is `floor((v - origin) / width)`, then moved a step when
    the product `origin + bin * width` puts `v` outside it; edges by
    the same binary search), sorts the rows by bin with a counting sort
    (row order kept inside a bin) and reduces each bin with the
    `aggregate` reducers. Its errors are pond-ts's: reserved outputs
    `start` / `end`, bad widths and edges, more than a million bins, a
    bin number past 2^53, and bins whose edges f64 cannot tell apart.
  - `rolling_by_column` keeps the rows with a value, places each window
    with pond-ts's two pointers (in while `value <= center + radius`,
    out while `value < center - radius`) and runs the `rolling` window
    states through a new kind of rolling frame: one explicit run of rows
    per output row, rows entering before rows leave, as pond-ts does.
    That order matters: a stdev, and the sign of a difference or median
    over signed zeros, change with it (the `rollcol-order` case). A row
    whose axis value is a gap gets each reducer's empty value, taken
    from an empty window.
  - Not ported: decimal columns as the axis (refused as not a number
    column; pond-ts has no decimals). pond-ts runs `sum` on an array
    column and gives 0 ([PND-KINDREDUCE]); pond-rs refuses it, as it
    does elsewhere.
  - Parity: 36 new pond-ts cases (1192 in all), a new `records` result
    shape in the fixture: width bins (fractional, offset, signed values
    with 0 and -0, values pond-ts moves a bin either way), edges in both
    inclusive modes with values outside them, array reducers, empty
    input, every reducer on numbers and the ones text takes, windows
    per row and at centers (none in range, repeated, far apart), the
    enter-before-leave order, and the errors JSON can write; unit tests
    cover the rest (non-finite widths, origins, edges, radii and
    centers; repeated outputs). Two property tests (bins and windows
    against direct filtering). Of 11 planted bugs, all are caught.
  - Review (#803): a value too large for a rolling sum is now refused
    with its row in the series, and only when a window reads it
    (`rolling_by_column_at` once refused rows past its last window).
    Left for later: `Table` has no way out yet (Arrow, JSON, rows); add
    one when a caller needs it.
  - Perf (`examples/perf_value_axis.rs` and
    `bench/value_axis_pond_ts.mjs`, 1M rows; checksums agree). Cost, for
    N rows, B bins, W rows a window and C centers: `by_column` is O(N +
    B) plus the reducers (O(N log B) for edges); `rolling_by_column` is
    O(N + C) pointer moves, with O(1) window states for most reducers
    and O(W) a row for median / percentiles. Handing the row order to
    Arrow's gather as plain row numbers instead of optional ones took
    the histogram from 40 to ~25 ms. Medians, 4 cores (busy container,
    ±30%):

    | Call                                    | pond-rs | pond-ts |
    | --------------------------------------- | ------- | ------- |
    | by_column, width 10, 1000 bins          | 26 ms   | 93 ms   |
    | by_column, 6 zones                      | 20 ms   | 97 ms   |
    | by_column, 1251-bin histogram           | 23 ms   | 68 ms   |
    | by_column, width 10, p5 + p95           | 38 ms   | 415 ms  |
    | rolling_by_column, ~100 rows, avg       | 35 ms   | 265 ms  |
    | rolling_by_column, ~100 rows, p5 + p95  | 94 ms   | 843 ms  |
    | rolling_by_column, ~1000 rows, p5 + p95 | 188 ms  | 932 ms  |
    | rolling_by_column, 1000 centers         | 22 ms   | 119 ms  |

  **Step 8i3 (done): `by_value` and `ValueSeries` ([PND-RUSTFULL]).**
  - Calls: `TimeSeries::by_value(axis)` (pond-ts `byValue`) and a new
    `ValueSeries`: rows keyed by a number that never goes down
    (distance, strike, frequency) instead of time. `ValueSeries::new`,
    `axis()` (pond-ts `axisValues` / `axisAt`), `axis_name`, `column`,
    `schema`, `nearest_index(x)` and `slice_by_value(lo, hi)` (pond-ts
    `nearestIndex` / `sliceByValue`), JSON rows and columns in and out
    (`from_json` / `to_json`, `from_columns_json` / `to_columns_json`,
    each with a `_value` twin for `serde_json`). The schema kind is a
    new `ColumnKind::Value`; the time-series readers refuse it.
  - `by_value` checks the axis (no gaps, never down), drops it from the
    columns and shares every column's memory. As pond-ts, a series with
    no rows takes any column as the axis (pond-ts checks row by row).
    The readers reuse the time-series JSON code (now split into
    `row_cells` / `row_columns` / `columnar_columns`) with an axis
    reader of their own; `KeyOrder::Reorder` is a stable sort and
    `Clamp` raises a value to the one above, both treating -0 and 0 as
    equal, as pond-ts does.
  - Not ported here: `fromArrow` / `toArrow` (8i4); `toRows` /
    `toObjects` (read columns by name instead). pond-ts reads only
    `number` and `string` columns back (a true/false or array column
    from `byValue` writes out but does not read in); pond-rs matches.
    Known differences, as for `TimeSeries`: a missing `name` and coerced
    cells (`"5"` in a number column or the axis) are refused; a column
    with a gap read from columns is optional.
  - Parity: a new `valueSeries` fixture section (357 cases): `byValue`
    on every number column of every input (and a text or array column,
    the key and an unknown name) plus two sources of its own (signed
    zeros, repeats, array and true/false columns, float ties), each
    result written three ways and probed with `nearestIndex` (every
    value, midpoints, past both ends, NaN, ±infinity) and
    `sliceByValue` (many ranges, reversed, NaN bounds); then `fromJSON`
    / `fromColumns` on every result's own output and 42 hand-written
    payloads (orderings, gaps, bad cells, bad schemas). A unit test
    pins -0 / 0 under each ordering, which JSON fixtures cannot carry.
    One property test (nearest row and slices against brute force). Of
    7 planted bugs, all are caught (the two in -0 / 0 order only by
    that unit test).
  - Perf (`examples/perf_value_series.rs` and
    `bench/value_series_pond_ts.mjs`; checksums agree). Cost, for N
    rows and C columns: `by_value` is one O(N) check and no copy;
    `nearest_index` and `slice_by_value` are binary searches, and a
    slice shares memory (a number column with gaps is scanned once for
    its no-gaps flag, about a third of the slice time here). JSON is
    O(N·C). Medians, 4 cores (busy container, ±30%):

    | Call                         | pond-rs | pond-ts |
    | ---------------------------- | ------- | ------- |
    | by_value, 1M rows            | 3 ms    | 34 ms   |
    | nearest_index, 1M probes     | 166 ms  | 357 ms  |
    | slice_by_value, 100k slices  | 90 ms   | 401 ms  |
    | to_json rows, 300k rows      | 59 ms   | 178 ms  |
    | from_json rows, 300k rows    | 100 ms  | 129 ms  |
    | to_columns_json, 300k rows   | 49 ms   | 81 ms   |
    | from_columns_json, 300k rows | 70 ms   | 106 ms  |

  **Step 8i4 (done): `ValueSeries` Arrow in and out ([PND-RUSTFULL]).**
  - Calls: `ValueSeries::from_arrow(name, batches, axis)` (pond-ts
    `ValueSeries.fromArrow(table, { axis })`), `read_ipc` /
    `from_ipc_bytes`, `to_arrow` (pond-ts `toArrow`) and `write_ipc`.
    The axis is any integer field or `Float32` / `Float64`, read at face
    value (no unit), with no nulls, all finite, never down; one
    `Float64` batch is used in place. Every other field is a value
    column, read by the same code as `TimeSeries::from_arrow` (shared
    now as `read_columns`; writing shares `push_columns`).
  - As pond-ts: a `Float16` axis is refused. Known differences: pond-ts
    reads a `Timestamp` axis as its stored numbers (pond-rs refuses a
    time-typed axis); pond-ts refuses true/false, decimal and list value
    fields, pond-rs reads them; pond-ts marks a value field with nulls
    required ([PND-ARROWREQ]), pond-rs optional. No `ordering` and
    `columns` options, as for `TimeSeries::from_arrow`.
  - Parity: `parity-value-arrow.json`, 18 Arrow files (hex) made by
    apache-arrow in `export.mjs` (Int32, Int64, UInt8 and UInt64 axes,
    the 64-bit ones past 2^53; Float32, Float16, dictionary text, empty, two
    batches, null / NaN / infinite / unsorted / text / missing /
    timestamp axis, true/false values) with pond-ts's result or error
    for each; and `parity-export-value.arrow`, pond-ts's own `toArrow`
    of a series with -0, a gap and the smallest subnormal, read back and
    rewritten. A unit test covers what apache-arrow tables cannot make
    (batches with different schemas), a dictionary axis, that the axis
    shares Arrow's buffer, and that errors from the readers and writers
    shared with `TimeSeries` name the `ValueSeries` call (via
    `PondError::renamed`). Of 6 planted bugs, all are caught.
  - Perf (`examples/perf_value_series.rs` and
    `bench/value_series_pond_ts.mjs`, new rows; checksums agree). 1M
    rows, a number axis, a number column with gaps and a text column.
    Cost: `to_arrow` shares every value buffer and builds null bits for
    number columns with gaps (O(N)); `from_arrow` shares gap-free number
    buffers and checks the axis (O(N·C)); IPC in and out copy (O(N·C)).
    pond-ts has no IPC writer; its side is apache-arrow's `tableToIPC`.
    pond-ts `toArrow` hands back views, so it costs nothing. pond-ts
    `fromArrow` spends most of its time on the text column; logged as
    [PND-ARROWTEXT]. The shared reader is no slower for `TimeSeries`
    (`perf_text` IPC column against `main`, three runs, within noise).

    | Call           | pond-rs | pond-ts |
    | -------------- | ------- | ------- |
    | to_arrow       | 1 ms    | 0 ms    |
    | from_arrow     | 5 ms    | 420 ms  |
    | write_ipc      | 10 ms   | 27 ms   |
    | from_ipc_bytes | 13 ms   | 402 ms  |

  **Step 8j (done): the 8h operations per group ([PND-RUSTFULL]).**
  - Calls: `smooth`, `baseline`, `baseline_named`, `outliers`, `scan`,
    `scan_to` and `sample` on `PartitionedSeries`, as pond-ts's
    same-named `PartitionedTimeSeries` methods. Each runs the
    `TimeSeries` call on every partition through `map` (several cores,
    same bits), so a partition is smoothed, banded or scanned on its own
    rows only. `scan`'s step is `Fn + Sync` (not `FnMut`) and each
    partition starts from its own clone of `init`, with the row index
    counting from 0.
  - Edges, as pond-ts: smoothing the partition column itself splits the
    rows again by the new values; `outliers` drops a partition left with
    no rows. Known differences: pond-ts smooths a text column to gaps
    per partition too (pond-rs refuses it, as for `TimeSeries`); a
    reservoir sample seeds each partition from `seed` and its place in
    partition order, so partitions pick independently but repeatably
    (pond-ts uses `Math.random`); pond-ts hands every partition the same
    `init` object, so a step that changes it in place leaks state from
    one partition to the next, where pond-rs clones `init`.
  - Parity: 22 `partitionBy` cases on `hosts` (ema with span, warmup and
    output; moving average trailing and centred; loess; smooth then
    `diff`; smoothing the partition column; baseline with names and
    minimum samples; outliers, also with none left; scan sum, index and
    gain; stride samples; a reservoir as large as each partition; the
    errors). The harness now runs these five calls through one path for
    `TimeSeries` and `PartitionedSeries`, and calls `baseline` (not
    only `baseline_named`) when no names are given. A unit test checks
    the per-partition reservoir and that a scan restarts per partition.
    Of 7 planted bugs (including running on the whole series instead of
    per partition), all are caught.
  - Perf: no check; each call only hands the `TimeSeries` operation to
    `map`, which already runs partitions in parallel (CLAUDE.md exempts
    operators that only delegate).

- **[PND-RUST-R2]** — the financial studies (planned 2026-10-21, after R1b).
  - Exactness, chosen by pjm17971: every study matches pond-ts
    (`@pond-ts/financial`) bit for bit, checked against a new fixture
    `packages/financial/test/fixtures/study-parity.json` that a pond-ts
    test keeps fresh, AND the pandas / TA-Lib oracle
    (`study-oracle.json`, 220 cases over 109 studies) within 5e-10,
    through `tests/study_oracle.rs`.
  - Defaults: studies are methods on `TimeSeries`, in a
    `pond_rs::financial` module of the same crate, with pond-ts's
    contract (source `column`, default `close`; `output`, default the
    study name; bar-count periods; a warm-up that keeps every row). No
    port of pond-ts's worker pool: a study is one pass over one column,
    split across cores (rayon) only where a stretch of rows gives the
    same bits as the whole column (pjm17971 chose this in #809).
  - Steps: 1. foundations: the options and checks every study shares,
    the shared kernels (window mean and spread, Wilder, weighted and
    exponential averages), `sma`, `ema`, `moving_average` (all 10
    types), `rolling_stdev` / `rolling_min` / `rolling_max` /
    `rolling_percentile`, `z_score`; 2. one PR per family: (a) moving
    averages, (b) bands, (c) momentum, (d) trend, (e) volatility and
    statistics, (f) volume, (g) price; 3. trading calendars, then
    pivot points, session VWAP and anchored VWAP; 4. the catalog; 5. perf check
    against pond-ts and an agent trial.

  **R2 step 1 (done): foundations.**
  - Calls, as `@pond-ts/financial`: `TimeSeries::sma`, `ema`,
    `moving_average(MaType, …)` (all 10 types), `rolling_stdev`,
    `rolling_min`, `rolling_max`, `rolling_percentile(q, …)` and
    `z_score`, each taking a `Study` (`period`, `.column`, `.output`).
    Kernels in `src/financial/kernels.rs` are line-for-line ports of
    pond-ts's `ranged.ts` (window mean and spread, shifted and rebuilt
    every `period` rows), `rolling.ts` (z-score deviation),
    `rolling-mean.ts`, `wilder.ts` and `moving-average.ts`; the
    percentile goes through `rolling_rows`, as pond-ts goes through core
    `rolling({ count })`; min and max use their own queue (same results,
    earliest of equal values wins). `ema` is the same arithmetic as
    `smooth(ema_span(p).min_samples(p))`. KAMA's `** 2` is `c * c` (V8
    and fdlibm compute it that way too; the fixture agrees).
  - Known differences: pond-ts reads a missing or non-number source
    column as all gaps (except min / max / percentile on a missing one,
    which throw); pond-rs refuses both (logged for pond-ts as
    [PND-STUDYSRC]). A decimal column is refused (pond-ts has none). A
    period is a `usize`, so negative and fractional periods cannot be
    written.
  - Parity: new pond-ts fixture `study-parity.json` (556 cases, written
    by `packages/financial/scripts/parity/generate.mjs`, kept fresh by
    `study-parity.test.ts`) over the oracle's 80 bars and 900 closes plus
    gappy (leading, single, runs longer than the period, trailing), 1e15
    and 1e9 magnitudes, flat runs with signed zeros, 3 rows and none; every
    study and type at periods from 1 to past the row count, five
    percentiles (`p1e-7` naming), other columns, custom outputs and the
    errors. 464 match bit for bit, 30 errors agree, 48 refused (known),
    14 periods Rust cannot write. Oracle: the 29 step-1 cases pass
    (`study_oracle.rs`, 5e-10). Of 14 planted bugs, 12 caught; the two
    survivors change nothing (`count` and Welford's `n` always agree;
    adding `0 * sum`).
  - Perf (`examples/perf_studies.rs`, `bench/studies_pond_ts.mjs`; 1M
    bars, checksums agree). All O(N) (a rebuild of `period` rows every
    `period` rows), except the percentile, which keeps each window sorted.
    First cut was only 1.5–5x pond-ts; timing the parts showed most of a
    study's time was taking fresh memory from the system (page faults),
    not the maths: copying the source column (8 MB), copying the time key
    for the result (8 MB; every pond-rs call that keeps the rows did
    this) and the output. Fixes: `TimeSeries` now shares its key
    (`Arc<Key>`) with results that keep the rows (`with_column`, `select`,
    `rename`, `rolling` and the other users of `with_value_columns`); a
    study reads its source in place unless a gap is stored as an infinity;
    min / max use their own O(N) queue instead of `rolling_rows`;
    dema / tema / hull reuse buffers. The rebuild test is a counter, not
    `i % period`.
  - Across cores (pjm17971 asked for it in #809): the mean / spread
    (`sma`, `rolling_stdev`, `moving_average` Sma and Trima), `wma`
    (also inside Hull) and min / max kernels fill stretches of 64k rows
    (or 8 periods) on rayon's pool. Each stretch starts at the last
    multiple of `period` at or before its first row, where every sum is
    rebuilt from the window (pond-ts's `rollingReadBack` uses the same
    property), so it gives the same bits as one sweep; min / max read
    from the first row of the window. Output buffers start zeroed, so the
    system hands pages out as the threads write. A unit test cuts a
    noisy column (gaps, signed zeros, infinities, 1e15) into stretches of
    1 to 2,999 rows at periods 1 to 3,001 and checks every bit; 4 of 4
    planted bugs (stretch starting at its first row, min / max queue not
    read back, no reset at the rebuild) are caught. Review found the
    min / max queue reserved `period` slots (period 1e12 on 10 rows asked
    for 8 TB) and `period + i` overflows at `usize::MAX`; fixed, and a
    test runs every study at periods up to `usize::MAX`.
  - What does not split: EMA, Wilder (smma), Dema / Tema / Zlema / KAMA
    and the z-score, where each row waits on the one before (a
    multiply-add or a division per row, the same chain V8 runs; matching
    pond-ts's bits rules out reordering it), and the percentile (still
    `rolling_rows`). Medians of 3 runs of 7, 1M bars, ms; 1 thread is
    `RAYON_NUM_THREADS=1`; checksums agree between all three:

    | Study       | pond-rs 1 thread | pond-rs 4 cores | pond-ts | ratio |
    | ----------- | ---------------- | --------------- | ------- | ----- |
    | sma 20      | 6.0              | 2.5             | 43.7    | 17x   |
    | sma 200     | 5.8              | 2.4             | 41.9    | 17x   |
    | ema 20      | 3.7              | 4.0             | 11.7    | 2.9x  |
    | stdev 20    | 22.7             | 6.9             | 36.4    | 5.3x  |
    | min 20      | 8.0              | 2.5             | 59.6    | 24x   |
    | max 200     | 8.3              | 2.8             | 86.1    | 31x   |
    | p90 20      | 58.7             | 55.5            | 183.4   | 3.3x  |
    | zscore 20   | 25.3             | 25.4            | 82.2    | 3.2x  |
    | ma wma 20   | 6.5              | 2.7             | 30.4    | 11x   |
    | ma smma 20  | 7.9              | 8.4             | 18.2    | 2.2x  |
    | ma dema 20  | 9.2              | 9.9             | 23.4    | 2.4x  |
    | ma tema 20  | 14.0             | 13.1            | 35.3    | 2.7x  |
    | ma trima 20 | 14.8             | 8.0             | 40.1    | 5.0x  |
    | ma hull 20  | 20.9             | 9.9             | 50.0    | 5.1x  |
    | ma kama 20  | 5.5              | 6.6             | 28.3    | 4.3x  |
    | ma zlema 20 | 6.1              | 5.7             | 18.9    | 3.3x  |

  **R2 step 2a (done): the moving-average family.**
  - Calls, as `@pond-ts/financial`'s moving-average family: `macd`,
    `price_oscillator`, `moving_average_cross`, `guppy`, `rainbow`,
    `rainbow_oscillator`, `trix`, `schaff_trend_cycle`, `coppock`, `kst`,
    `special_k`, `price_momentum_oscillator` each take an options struct
    named after the study (`Macd::default().fast(5).prefix("m")`):
    `Default` is pond-ts's defaults, one setter per option, `column`, and
    `output` or `prefix`. `moving_average_deviation`, `disparity_index`
    and `detrended_price_oscillator` take `(MaType, Study)`, like
    `moving_average`. `OscillatorMode` is the price oscillator's `mode`;
    `ma` is pond-ts's `type` / `maType`.
  - Ported as pond-ts writes them: averages read from the column go
    through `ma_column` (pond-ts `movingAverageColumn`: `Sma` counts rows,
    as `sma` does); averages of a derived line through
    `moving_average_values` (waits for whole windows); `percentChange`,
    `rollingExtremesValues`, `percentOfRangeValues`, `foldRows` (the cross
    and the Schaff half-smoothing) and the KST / Special K terms in the
    same order. macd refuses a series holding its scratch column
    `__macdLine__`, as pond-ts does. Same known difference as step 1
    (missing or non-number source refused).
  - Parity: the fixture grew to 1,411 cases (inputs gained `named`, a
    series that already has columns the studies write): every study at
    its defaults on every input, small settings, every moving-average
    type, other columns, signed zeros, custom names, collisions and every
    error. 1,163 match bit for bit, 86 errors agree, 93 refused (known),
    69 calls Rust cannot write (negative or fractional periods, an
    unknown `mode` or moving-average name). Oracle: all 29 family cases pass (58 of 220 now).
    Both harnesses call studies through one door,
    `tests/common/studies.rs`. Planted bugs: 12 of 16 caught at first;
    three cannot change any output (a guard that turns `±inf` into `NaN`,
    and pond-rs reads every non-finite value as a gap anyway) and one (a
    tie between `-0` and `0` in the high / low queue) is now caught by a
    unit test against pond-ts's queue. 7 of 7 caught after the speed work.
  - Perf (`examples/perf_studies.rs`, `bench/studies_pond_ts.mjs`; 1M
    bars at pond-ts's defaults, checksums agree). All O(N): each study is
    a fixed number of O(N) kernels. First cut was 2.3–5.8x pond-ts; what
    was slow and the fixes, each giving the same bits:
    - Fresh memory again: guppy holds twelve 8 MB columns, Special K made
      24 in between. Independent averages now run on separate cores
      (`par::map`, `par::join`); KST / Special K work through their terms
      stretch by stretch with small buffers of their own (no term is
      held for the whole column), checked by a unit test that cuts 6,000
      rows into stretches of 1 to 6,000.
    - Chained EMAs (macd, trix, the PMO, Schaff's MACD line, and step 1's
      `Dema` / `Tema`) run in one pass with a row-at-a-time `Ema` (the
      same operations in the same order): no column in between, and the
      chains overlap in the processor. Dema 9.9 → 6.6 ms, Tema 13.1 → 5.6.
    - pond-ts's high / low queue (Schaff) was 18 ms: replaced by van Herk
      / Gil-Werman blocks (three comparisons a row, later rows win ties,
      stretches on separate cores); a unit test checks it against the
      queue, signed-zero ties included, at every stretch size (6 of 6
      planted tie bugs caught). `rolling_mean_values` (the masked mean)
      and the rainbow oscillator's per-row loop split across cores too.
  - Medians of 7, 1M bars, ms; 1 thread is `RAYON_NUM_THREADS=1`:

    | Study    | first cut | 1 thread | 4 cores | pond-ts | ratio |
    | -------- | --------- | -------- | ------- | ------- | ----- |
    | macd     | 26.6      | 7.9      | 8.1     | 73.5    | 9.1x  |
    | priceOsc | 10.6      | 8.6      | 11.5    | 48.1    | 4.2x  |
    | maCross  | 11.1      | 21.0     | 12.4    | 64.6    | 5.2x  |
    | maDev    | 4.2       | 7.2      | 4.3     | 31.9    | 7.4x  |
    | dispar.  | 3.9       | 8.4      | 4.4     | 44.1    | 10x   |
    | dpo      | 3.8       | 11.5     | 5.3     | 29.7    | 5.6x  |
    | guppy    | 79.1      | 93.5     | 30.8    | 184.6   | 6.0x  |
    | rainbow  | 49.1      | 101.0    | 41.4    | 234.2   | 5.7x  |
    | rbo      | 70.3      | 152.3    | 56.6    | 404.9   | 7.2x  |
    | trix     | 18.7      | 8.6      | 8.0     | 45.0    | 5.6x  |
    | stc      | 67.3      | 55.3     | 41.6    | 158.5   | 3.8x  |
    | coppock  | 9.3       | 19.4     | 12.8    | 38.4    | 3.0x  |
    | kst      | 47.5      | 86.0     | 20.5    | 138.4   | 6.8x  |
    | specialK | 100.2     | 112.4    | 42.1    | 278.9   | 6.6x  |
    | pmo      | 15.3      | 7.4      | 8.3     | 44.0    | 5.3x  |

    This box runs four cores in a shared VM; single runs move by up to
    a third, so read ratios to one significant figure.

  **R2 step 2b (done): the bands family.**
  - Calls, as `@pond-ts/financial`'s bands family: `bollinger`,
    `bollinger_bandwidth`, `bollinger_percent_b`, `keltner`,
    `starc_bands`, `atr_bands`, `donchian`, `high_low_bands`,
    `prime_number_bands` and `envelope`, each with an options struct
    named after it, as in step 2a. pond-ts has no default period for
    `bollinger` and `envelope`, so those structs have `new(period)`
    instead of `Default`. Studies that read price bars take `high`,
    `low` and `close` setters instead of `column` (`atr_bands` has both;
    its `column` follows a moved `close`, as in pond-ts). The macro that
    writes the structs moved to `src/financial/options.rs`.
  - Ported as pond-ts writes them: Bollinger through the range-exact
    mean and spread; Keltner and high-low bands average a derived line
    (typical or median price) through `moving_average_values`, STARC and
    the envelope average the column through `ma_column`; the true range
    takes JS `Math.max` (a gap gives a gap, `+0` beats `-0`), then
    Wilder's smoothing; Donchian is step 1's rolling high and low; prime
    bands port pond-ts's 6k ± 1 ladder (whole numbers up to 2^53 - 1).
  - Parity: the fixture grew to 1,887 cases. A new `ohlc` input has gaps
    in close only, high only, low only and whole bars, a stretch where
    high = low = close (zero spread and zero true range), signed zeros,
    a `prime` column across the prime limits, and columns a band prefix
    collides with. Because Wilder's smoothing never recovers from a gap,
    a second input, `lead`, has gaps only at the start (shifting the
    seed) and a zero-true-range stretch, so the ATR studies get 70-80
    values a case; `ohlcEmpty` is the empty bar input. Studies of price
    bars only run on inputs with high and low. 1,504 match bit for bit,
    139 errors agree, 133 refused (the known missing-column difference,
    now checked for every price column a study reads), 111 calls Rust
    cannot write. Oracle:
    all 18 family cases pass (76 of 220 now); the oracle input now
    carries open, high, low and volume too. Planted bugs: 17 of 20
    caught; the other 3 change no output here: `c + -k * w` vs
    `c - k * w` (twice) is always the same in floating point, and
    `(h + l) / 2` vs `h / 2 + l / 2` differ only on overflow or numbers
    too small for full precision, which no fixture input has. A unit
    test pins `js_max` on signed zeros (the true range never produces
    `-0`, so the fixture can't). Two ATR bugs planted after the review
    (Wilder's seed not shifted past leading gaps; gaps dropped by the
    max) are both caught.
  - Perf: all O(N) except prime bands, which cost O(√x) per value (as in
    pond-ts). The average true range is one sequential pass (each value
    needs the last, so it cannot split across cores without changing
    bits); it now takes each row's true range as it goes instead of
    building the column first. Centre and true range run on separate
    cores; band arithmetic and prime rows split across cores.
  - Medians of 7, 1M bars at pond-ts's defaults, ms:

    | Study     | 1 thread | 4 cores | pond-ts | ratio |
    | --------- | -------- | ------- | ------- | ----- |
    | bollinger | 39.8     | 12.2    | 80.2    | 6.6x  |
    | bbWidth   | 24.3     | 10.7    | 53.5    | 5.0x  |
    | percentB  | 26.7     | 12.1    | 83.7    | 6.9x  |
    | keltner   | 22.6     | 12.6    | 63.0    | 5.0x  |
    | starc     | 24.1     | 12.8    | 71.0    | 5.5x  |
    | atrBands  | 24.5     | 16.2    | 49.3    | 3.0x  |
    | donchian  | 17.7     | 8.6     | 165.9   | 19x   |
    | hlBands   | 36.1     | 15.0    | 78.8    | 5.3x  |
    | prime     | 41.6     | 17.0    | 68.3    | 4.0x  |
    | envelope  | 18.6     | 7.1     | 66.5    | 9.4x  |

    atrBands is the slowest ratio: its Wilder pass is a chain of
    multiply, add and divide on every row (about 8 ms at 1M rows), which
    pond-ts pays too.

  **R2 step 2c part 1 (done): momentum, first 11 studies.**
  - Calls, as `@pond-ts/financial`'s momentum family: `rsi`,
    `chande_momentum` and `momentum` take a plain `Study` (pond-ts's
    default periods 14, 14 and 10 are in their docs); `stochastic`,
    `stochastic_momentum_index`, `stochastic_rsi`, `williams_r`,
    `percent_change`, `intraday_momentum_index`, `awesome_oscillator`
    and `ultimate_oscillator` take an options struct named after the
    study, as in step 2b. `stochastic_rsi` refuses a series that has
    pond-ts's scratch column `__stochRsiRsi__`, as pond-ts does (it
    writes its RSI there first). Part 2 (cci, fisher transform,
    psychological line, pretty good oscillator, prime number oscillator,
    qstick, relative vigor index, centre of gravity, Chande forecast,
    true strength index) is next.
  - Ported as pond-ts writes them: rises and falls of each change, then
    Wilder's average (RSI) or the window mean (CMO, IMI); stochastics
    through step 1's rolling high and low, except stochastic RSI, which
    uses pond-ts's own rolling-extremes kernel; JS `Math.min` (new
    `js_min`: a gap gives a gap, `-0` beats `+0`) for the ultimate
    oscillator's buying pressure.
  - Parity: the fixture grew to 2,274 cases (the `lead` input gained an
    open column; the `named` input gained the scratch column). 1,753
    match bit for bit, 191 errors agree, 175 refused (known missing
    column difference), 155 calls Rust cannot write. Oracle: 98 of 220
    cases now. Planted bugs: 19 of 22 caught; the 3 missed were a change
    of `-0` (neither a rise nor a fall, and no input row gives one), `-0`
    in `js_min`, and a mutation that changed nothing. Unit tests now pin
    both signed-zero cases.
  - Perf: all O(N). RSI runs both Wilder averages in one pass with no
    column in between (33 → 9 ms); SMI runs its five EMAs row by row in
    one pass (48 → 25 ms). Both are the same operations in the same
    order, so the same bits (parity still passes; planted swaps in
    either are caught).
  - Medians of 7, 1M bars at pond-ts's defaults, ms (pond-ts run alone
    per study):

    | Study      | 1 thread | 4 cores | pond-ts | ratio |
    | ---------- | -------- | ------- | ------- | ----- |
    | rsi        | 9.9      | 9.2     | 58.2    | 6.3x  |
    | stochastic | 61.7     | 19.8    | 320.9   | 16x   |
    | smi        | 49.5     | 25.5    | 284.9   | 11x   |
    | stochRsi   | 47.0     | 30.3    | 218.2   | 7.2x  |
    | williamsR  | 30.0     | 12.1    | 220.7   | 18x   |
    | cmo        | 27.4     | 17.1    | 94.6    | 5.5x  |
    | momentum   | 3.0      | 2.9     | 19.6    | 6.8x  |
    | pctChange  | 3.1      | 2.5     | 23.4    | 9.4x  |
    | imi        | 27.5     | 17.2    | 116.6   | 6.8x  |
    | ao         | 31.1     | 13.4    | 75.0    | 5.6x  |
    | uo         | 73.4     | 32.5    | 262.9   | 8.1x  |

  **R2 step 2c part 2 (done): momentum, the other 10 studies.** The
  momentum family is complete.
  - Calls: `commodity_channel_index`, `fisher_transform`,
    `pretty_good_oscillator`, `prime_number_oscillator`, `qstick`,
    `relative_vigor_index` and `true_strength_index` take an options
    struct named after the study; `psychological_line`,
    `center_of_gravity` and `chande_forecast_oscillator` take a plain
    `Study` (pond-ts's defaults 12, 10 and 14 are in their docs).
    `pretty_good_oscillator`'s `column` defaults to its `close` setting,
    as in pond-ts. The helper that reads price columns moved to
    `mod.rs` and the bands family now uses it too (review nit on #817).
  - New kernels, ported as pond-ts writes them: the rolling mean
    absolute deviation (CCI), the 4-bar symmetric weighted mean (RVI),
    the nearest prime (lower on a tie), and pond-ts's rolling linear
    regression (`linearRegressionValues`, in `regression.rs`: shifted
    running sums rebuilt every `period` rows, the flat-window rule and
    the two-pass refit of windows whose spread is lost in the sums).
    The regression splits across cores: a stretch starts at a rebuild
    row and counts the window's changes first, the only state carried
    across a rebuild (a unit test checks stretches of 1, 7, 64 and 1000
    rows give the bits of one sweep). The trend family will reuse it.
  - JS `Math.log`: the Fisher transform takes a logarithm. V8 computes
    `Math.log` with fdlibm's `__ieee754_log`; the system `f64::ln`
    differed from it on 2.2% of 2M test values.
    `kernels::js_log` ports fdlibm's routine; it matched node on all 2M
    values, and a unit test pins six inputs where `f64::ln` is off.
    A planted swap back to `f64::ln` fails parity.
  - Parity: the fixture grew to 2,632 cases (the `flat` input gained a
    `ramp` column, for bars whose true range is 0 from the start).
    2,013 match bit for bit, 226 errors agree, 215 refused (known
    missing-column difference), 178 calls Rust cannot write. Oracle: 117
    of 220 cases. Planted bugs: 19 of 25 caught. The 6 missed change no
    output: `w / (2m)` vs `w / m / 2` (a halving is exact unless `2m` overflows or the result is too small for full precision); adding
    `0 * mean`; the regression's flat-window intercept as the anchor
    instead of the value (the anchor is always a value in the window,
    so they differ only in the sign of a zero, which CFO then turns into
    a gap); the refit's `scale == 0` branch (unreachable: a window equal
    throughout has no changes and is caught first); the anchor kept
    when the rebuild row is a gap (every window until the next rebuild
    holds that gap, so all are gaps); and PGO's zero-denominator guard
    (both pond-ts's `withColumn` and pond-rs store an infinite value as
    a gap, so `x / 0` reads the same as the guard's gap). The
    regression's r² is computed but no study reads it yet, so nothing
    checks it against pond-ts until `linearRegression` (statistics
    family, which reads it) adds parity cases.
  - Perf: all O(N) except CCI's deviation (O(N·period), as pond-ts) and
    the prime oscillator (O(√x) per value). The Fisher transform's pass
    is sequential (each value needs the last) and pays a logarithm per
    row; TSI runs its five EMAs row by row in one pass, like SMI.
  - Medians of 7, 1M bars at pond-ts's defaults, ms (pond-ts run alone
    per study):

    | Study  | 1 thread | 4 cores | pond-ts | ratio |
    | ------ | -------- | ------- | ------- | ----- |
    | cci    | 41.2     | 21.8    | 136.0   | 6.2x  |
    | fisher | 40.2     | 39.0    | 129.5   | 3.3x  |
    | psy    | 11.5     | 7.8     | 61.1    | 7.8x  |
    | pgo    | 19.2     | 14.8    | 113.5   | 7.7x  |
    | pno    | 35.3     | 11.5    | 63.8    | 5.5x  |
    | qstick | 11.0     | 6.7     | 52.2    | 7.8x  |
    | rvi    | 31.0     | 32.1    | 161.9   | 5.0x  |
    | cog    | 25.5     | 8.6     | 65.9    | 7.7x  |
    | cfo    | 21.6     | 13.6    | 62.3    | 4.6x  |
    | tsi    | 13.7     | 18.0    | 75.4    | 4.2x  |

  **R2 step 2d part 1 (done): trend, 8 of 16 studies.**
  - Calls: `directional_movement`, `aroon`, `vortex`, `random_walk_index`,
    `super_trend`, `parabolic_sar` and `atr_trailing_stop` take an options
    struct named after the study (`high` / `low` / `close` setters and a
    `prefix`; SuperTrend, the SAR and the ATR stop write the prefix itself
    and `{prefix}Trend`); `vertical_horizontal_filter` takes a plain
    `Study` (pond-ts default 28). Errors as pond-ts: the random walk's
    period must be at least 2, the SAR's `max_step` at least its `step`,
    multipliers and steps positive and finite.
  - Ported as pond-ts writes them: `foldRows` (a state machine over rows
    with no gap, restarting after each gap) for SuperTrend, the SAR and
    the ATR stop; `barsSinceExtremeValues` for Aroon (a queue of candidate
    rows, the latest of equal extremes); `sarStep` line for line.
    SuperTrend keeps pond-ts's `!(close < lower)` rather than
    `close >= lower`: the two differ when the band is NaN, which an
    overflowing price produces.
  - Parity: the fixture grew to 2,918 cases, with a new `edge` input: a
    run whose second bar is an inside bar (the high falls further than
    the low rises, so both moves are negative; the SAR picks its first
    direction from that), short runs after whole-bar gaps, and a jump
    from -1.7e308 to 1.7e308 whose ranges overflow to infinity (pond-ts
    refuses infinite inputs and pond-rs reads them as gaps, so overflow
    is the only way a study sees one), plus an outside bar whose high
    rises exactly as far as its low falls (both moves then count as 0).
    2,219 match bit for bit, 253 errors agree, 254 refused (known
    missing-column difference), 192 calls Rust cannot write. Oracle: 133
    of 220 cases (was 117).
  - Planted bugs: 19 of 26 caught on the first version, plus 8 of 8 after
    the speed changes below (re-planted in the rewritten code; one
    needed the outside bar above), plus the random walk's zero-denominator
    guard once the review on #819 showed how to reach it (below): 20 of
    26 on the first set. The 6 missed change no output: starting the
    +DM / -DM average at row 0 instead of 1 (row 0 is always a gap, so
    both find row 1); adding `0 * adx`; Aroon dropping only NaN, not
    infinities, from its window count (no input value is ever infinite,
    see above); vortex's guard on a zero true range (`x / 0` is an
    infinity or NaN, both stored as a gap); `powf(0.5)` for `sqrt` (same
    bits for every whole number from 2 to 100,000, checked); and
    `f64::min` for `js_min` in the ATR stop (they differ only on NaN,
    which the stop never holds, and on the sign of a zero).
  - The random walk's guard first survived, and the reason first given
    here (a zero mean true range means the numerator is 0 too) was wrong
    (review on #819). A zero mean true range pins only the bars inside
    the horizon, not the bar before it, so on a bar whose close lies
    outside its high and low the term is `-inf`, which the other
    horizons' maximum swallows where pond-ts gives a gap. The `edge`
    input now has such a bar (row 45, then two flat bars at its close).
    Also from that review: Wilder's ATR never recovers after a gap in
    the middle of a series (pond-ts `atrValues`), so SuperTrend and the
    ATR stop restart only after leading gaps; the `edge` input's later
    runs test the restart for the SAR alone.
  - Perf: all O(N) except the random walk (O(N·period): a mean true
    range per horizon, as pond-ts). DMI first ran at 65 ms (1.8x pond-ts):
    about 4.5 ms of each pass is writing a fresh 1M-row array, and it made
    ten. Now the +DM / -DM averages run side by side in one pass with no
    raw columns (they have gaps on the same rows, so the same seed row;
    same operations in the same order, as RSI), +DI / -DI / DX / ADXR
    split across cores, and only ADX runs in order: 40 ms. Aroon writes
    its percent in the queue pass (38 → 15 ms). The random walk splits
    rows across cores (each row's maximum stands alone; a unit test checks
    stretches of 1, 7, 64 and 1000 rows give the bits of one sweep).
    SuperTrend, the SAR and the ATR stop are one sequential pass each
    (each row needs the last). At 1M rows all eight match pond-ts on
    every bit of every column, on 4 cores and on 1, which covers the
    split code (the parity inputs are shorter than one stretch): both
    bench scripts print a hash of every output bit under `POND_BITS=1`
    (added after the review on #819 rated the split code as checked by
    reading only).
  - Medians of 7, 1M bars at pond-ts's defaults, ms (pond-ts run alone
    per study):

    | Study  | 1 thread | 4 cores | pond-ts | ratio |
    | ------ | -------- | ------- | ------- | ----- |
    | dmi    | 73.2     | 38.8    | 136.3   | 3.5x  |
    | aroon  | 25.3     | 15.3    | 106.6   | 7.0x  |
    | vortex | 47.1     | 20.2    | 164.9   | 8.2x  |
    | vhf    | 44.0     | 16.1    | 275.8   | 17x   |
    | rwi    | 165.1    | 58.1    | 429.4   | 7.4x  |
    | st     | 22.0     | 23.8    | 98.7    | 4.1x  |
    | psar   | 10.3     | 9.7     | 62.4    | 6.4x  |
    | ats    | 18.2     | 21.0    | 73.4    | 3.5x  |

  **R2 step 2d part 2 (done): trend, the other 8 studies; the family is
  complete.**
  - Calls: `zig_zag` (`ZigZag`, `deviation` in percent, default 5),
    `ichimoku` (`Ichimoku`; `Ichimoku::offsets()` is pond-ts
    `ichimokuOffsets`, the shifts a chart applies), `elder_impulse`,
    `elder_ray`, `trend_intensity_index`, `ravi` (each its own options
    struct), and `swing_index` / `accumulative_swing_index`, which take
    `SwingIndex::new(limit)` / `AccumulativeSwingIndex::new(limit)`: the
    limit move has no default in pond-ts either. Errors and their order as
    pond-ts, including `elderImpulse` refusing a series that already holds
    its MACD scratch columns (`__elderMacd__Line` …; a `scratch` input
    holds one), and `elder_ray` reading the close before the high and low
    (review on #821; parity checks only that both sides fail, so a unit
    test pins which column the error names).
  - Ported as pond-ts writes them: ZigZag's `zigZagStep` state machine
    plus the pass that fills the legs (each run of rows without a gap
    starts again; no leg crosses a gap); Ichimoku's midpoints on the
    strict rolling extremes; the swing index's branch order (ties go to A,
    then B, then D).
  - Parity: the fixture grew to 3,231 cases, with a new `ties` input: a
    first ZigZag swing of exactly the deviation (25 is 0.25 times 100, no
    rounding) and closes alternating 1 and -1 (a two-bar average of
    exactly 0, which RAVI turns into a gap). 2,427 match bit for bit, 286
    errors agree, 292 refused (known missing-column difference), 226 calls
    Rust cannot write. A unit test covers infinite and NaN limits and
    deviations (JSON cases cannot carry them).
  - Planted bugs: 21 of 28 caught at first; the cases above (plus one-bar
    Ichimoku windows on the `edge` bars, whose high plus low overflows)
    and the unit test caught 4 more: 25 of 28. The 3 missed change no
    output: the swing index's tie between A and B, and between B and D
    (with A = B both branches give the same value; B = D forces A = 0,
    and again both agree); and ZigZag remembering the later of two equal
    lows on a rising leg (a reversal needs a strictly lower low, which
    replaces the remembered row anyway).
  - Perf: all O(N). Ichimoku is O(N) per window (strict extremes, three
    windows split across cores); it computes both the highest and lowest
    for each column and uses one, a 2x it leaves on the table (still 7.8x
    pond-ts). ZigZag, the impulse's MACD and the running total are one
    sequential pass each. At 1M rows all eight match pond-ts on every bit
    of every column, on 4 cores and on 1 (`POND_BITS=1`).
  - Medians of 7, 1M bars at pond-ts's defaults (swing limit 20), ms
    (the swing index uses one core; its 4-core figure is noise, 7-10 ms
    either way):

    | Study   | 1 thread | 4 cores | pond-ts | ratio |
    | ------- | -------- | ------- | ------- | ----- |
    | zz      | 18.1     | 17.5    | 254.1   | 15x   |
    | ichi    | 113.2    | 36.5    | 284.9   | 7.8x  |
    | impulse | 19.2     | 12.6    | 125.6   | 10x   |
    | ray     | 9.6      | 9.6     | 39.5    | 4.1x  |
    | tii     | 30.6     | 14.6    | 110.0   | 7.5x  |
    | ravi    | 15.8     | 8.0     | 58.4    | 7.3x  |
    | si      | 7.0      | 11.7    | 42.2    | 3.6x  |
    | asi     | 11.5     | 14.9    | 56.9    | 3.8x  |

  **R2 step 2e part 1 (done): volatility, 8 of 14 studies.**
  - Calls: `atr`, `historical_volatility`, `chaikin_volatility`,
    `mass_index`, `choppiness_index`, `gopalakrishnan_range_index` and
    `relative_volatility_index` take an options struct named after the
    study (`high` / `low` / `close` setters or `column`, and `output`);
    `ulcer_index` takes a plain `Study` (pond-ts default 14). Errors and
    their order as pond-ts, including the choppiness and range indexes
    refusing a period of 1 and historical volatility refusing an
    `annualize` that is not a positive finite number.
  - New kernel: `js_log10`, V8's `Math.log10` (fdlibm's
    `__ieee754_log10` on top of `js_log`). Checked against node on 2M
    values: 0 differ, where the system `log10` differed on 4,111. The
    choppiness index needs it; the range index and historical volatility
    use `js_log`. Everything else reuses kernels from earlier families
    (Wilder's ATR, the rolling mean and spread, the count-window extremes,
    the EMA and percent change).
  - Parity: the fixture grew to 3,516 cases. 2,627 match bit for bit, 318
    errors agree, 323 refused (known missing-column difference), 248
    calls Rust cannot write. The new cases cover prices at or below zero
    and a first log return of +Infinity (the `ties` input's open jumps
    from 1e-300 to 1e300), flat bars (zero ranges, EMAs and spans), a
    window of only new highs (the ulcer index's exact 0), unchanged closes
    (the relative volatility index counts them as down) and the `edge`
    bars. Oracle: 167 of 220 cases (was 133).
  - Planted bugs: 18 of 29 caught at first; the overflowing return above,
    a unit test for non-finite `annualize`, and three `log10` inputs below
    1 caught 3 more: 21 of 29. The 8 missed change no output: a zero price
    giving an infinite return instead of a gap (the spread kernel skips
    both); dropping historical volatility's early return for too few
    returns (the kernel then gives all gaps anyway); `powf(0.5)` for
    `sqrt` (same bits on 22M values checked); `+ 0.0` on the mass index's
    sum (its mean is never -0); dropping either half of the choppiness
    guard, or `>=` in the range index's (the dropped case then gives an
    infinity or NaN, both stored as a gap; review on #822 corrected an
    earlier reason given here); and dropping the ulcer index's finite check on its exact-0
    rule (a window with no drawdown is always full and finite: warm-up
    rows have no peak, so their drawdown is a gap and counts).
  - Perf: all O(N); the window kernels split rows across cores as before.
    At 1M rows all eight match pond-ts on every bit, on 4 cores and on 1
    (`POND_BITS=1`).
  - Medians of 7, 1M bars at pond-ts's defaults, ms:

    | Study   | 1 thread | 4 cores | pond-ts | ratio |
    | ------- | -------- | ------- | ------- | ----- |
    | atr     | 7.5      | 7.4     | 70.8    | 9.6x  |
    | hv      | 25.9     | 15.4    | 72.2    | 4.7x  |
    | chaikin | 4.4      | 6.0     | 25.7    | 4.3x  |
    | mass    | 11.6     | 9.4     | 37.9    | 4.0x  |
    | chop    | 34.2     | 22.8    | 215.6   | 9.5x  |
    | gapo    | 18.8     | 10.9    | 268.8   | 25x   |
    | ulcer   | 15.8     | 9.0     | 154.0   | 17x   |
    | relvol  | 32.6     | 17.2    | 68.1    | 4.0x  |

  **R2 step 2e part 2 (done): statistics, the other 6 studies; the family
  is complete.**
  - Calls: `linear_regression` (`LinearRegression`, a `prefix`; writes
    value, slope, intercept, angle in degrees and r squared, in that
    order), `time_series_forecast` (a plain `Study`, pond-ts default 14),
    and four studies that compare `column` with a second column:
    `beta`, `correlation`, `price_relative` and `performance_index`. Their
    options take the `benchmark` column in `new` (`Beta::new("spy")`), as
    pond-ts has no default for it; `study_options!` gained a
    `Name(benchmark)` form for them. Errors in pond-ts's order: the
    period, then the benchmark (not the column itself, on the series, a
    number column), then the output name, then the column. Parity checks
    only that both sides fail; a unit test pins the order and part of
    each message.
  - New kernels: `rolling_bivariate_values`, pond-ts
    `rollingBivariateValues` (covariance and the two variances of each
    window, in a frame shifted by the window's first pair, rebuilt every
    `period` rows and again where a moment looks like rounding residue),
    split across cores by the same rebuild rows; and `js_atan`, V8's
    `Math.atan` (fdlibm), checked against node on 2M values. The
    regression's r squared, unchecked since part 2 of momentum, is now
    checked by parity.
  - A bug of mine the stretch test caught before review: a stretch
    skipped the rebuild-on-demand check on the rows before its first
    output row, but a rebuild there carries forward, so the bits
    differed from one sweep.
  - Parity: the fixture grew to 3,931 cases, with a new `pair` input
    (gaps on different rows in each column, each column flat while the
    other moves, zeros, plateau prices with a few ulps of jitter, columns
    scaled by 1e-100 and 1e100 so the product of two variances underflows
    or overflows, and exact multiples of the close). 2,948 match bit for
    bit, 390 errors agree, 335 refused (known missing-column difference),
    258 calls Rust cannot write. The oracle's bars gained its benchmark
    column; oracle: 178 of 220 cases (was 167).
  - Planted bugs: 22 of 28 caught at first; the scaled columns caught 2
    more: 24 of 28. The 4 missed: price relative and the performance
    index without their zero guards (dividing by 0 then gives an
    infinity or NaN, both stored as a gap); and two in the kernel that
    gave 0 differences in 8.4M readings of random gappy, plateau and
    near-duplicate inputs: a looser Cauchy-Schwarz slack (1e-6 for 1e-9),
    and dropping the closed form for a window down to one pair. Neither
    is proven harmless; the inputs that would show them were not found.
  - Parity inputs are under one 65,536-row stretch, so they never split
    across cores; the split is checked by the stretch unit test and the
    1M-row bit comparison below (review on #823).
  - Perf: all O(N). Beta's two return columns are one pass split across
    cores, as is the regression's angle. At 1M rows all six match pond-ts
    on every bit, on 4 cores and on 1 (`POND_BITS=1`).
  - Medians of 7, 1M bars at pond-ts's defaults (benchmark: the open),
    ms:

    | Study    | 1 thread | 4 cores | pond-ts | ratio |
    | -------- | -------- | ------- | ------- | ----- |
    | linreg   | 33.8     | 15.2    | 83.2    | 5.5x  |
    | tsf      | 13.7     | 4.6     | 23.9    | 5.2x  |
    | beta     | 27.8     | 8.7     | 45.3    | 5.2x  |
    | corr     | 29.5     | 10.3    | 53.0    | 5.1x  |
    | pricerel | 1.3      | 1.2     | 16.9    | 14x   |
    | perf     | 2.6      | 2.5     | 10.8    | 4.3x  |

  **R2 step 2f part 1 (done): volume, 9 of 17 studies** (the catalog's
  18th, anchored VWAP, needs the key times and goes with session VWAP in
  step 3).
  - Calls: `obv`, `accumulation_distribution`, `price_volume_trend`,
    `chaikin_money_flow`, `chaikin_oscillator`, `money_flow_index`,
    `twiggs_money_flow`, `force_index` and `ease_of_movement`, each with
    its own options struct (`high` / `low` / `close` / `volume` setters,
    `output`; `ease_of_movement` also takes `ma` and `scale`).
    `study_options!` gained a `volume` setter doc. Errors and their order
    as pond-ts (periods, the oscillator's fast-before-slow rule, the
    scale, the output, then the columns, Twiggs reading the close and
    volume before the high and low).
  - New kernels: `cumulative_values`, `clv` / `clv_values`,
    `money_flow_volume_values`, `js_sign` (JS `Math.sign`: a zero keeps
    its sign, where `f64::signum` gives 1 for +0) and
    `wilder_values_from` (pond-ts `wilderValues`' `start`). On-balance
    volume, the force index and Twiggs money flow fuse pond-ts's passes
    into one, the same operations in the same order.
  - Parity: the fixture grew to 4,300 cases, with two new inputs: `vol`
    (price bars with volume and gaps in each column, bars with no range
    and an unchanged close, zero volume, a zero close) and `blowup` (a bar
    whose close location times volume overflows to -Infinity). 3,193
    match bit for bit, 420 errors agree, 413 refused (known
    missing-column difference), 274 calls Rust cannot write. Oracle: 193
    of 220 cases (was 178).
  - Planted bugs: 16 of 26 caught at first; the new cases (a bar with no
    range whose close is a gap, the overflowing bar, a close before the
    first volume) caught 4 more: 20 of 26. The 6 missed change no output:
    `Math.sign` giving +0 for -0 (the running total starts from 0 plus a
    volume, so it is never -0 and adding either zero gives the same);
    Twiggs smoothing from row 0 instead of row 1, either sum (row 0's flow
    is always a gap, as it has no previous close); dropping the zero
    guards in the money flow index and Twiggs (dividing by 0 there gives
    an infinity or NaN, both stored as a gap); and dropping ease of
    movement's zero-volume guard (the infinity is skipped as a gap by
    every moving-average type, as the guard's gap is; all ten were run).
  - Perf: all O(N). The running totals (OBV, A/D, PVT) and the EMAs are
    one sequential pass; Chaikin money flow and the money flow index
    split rows across cores. At 1M rows all nine match pond-ts on every
    bit, on 4 cores and on 1 (`POND_BITS=1`).
  - Medians of 7, 1M bars at pond-ts's defaults, ms. The bench bars'
    close is the middle of each bar (close location 0), so A/D and
    Chaikin's two studies read the open as the close:

    | Study   | 1 thread | 4 cores | pond-ts | ratio |
    | ------- | -------- | ------- | ------- | ----- |
    | obv     | 3.3      | 3.3     | 23.4    | 7.1x  |
    | ad      | 7.4      | 6.7     | 29.5    | 4.4x  |
    | pvt     | 5.5      | 5.7     | 28.9    | 5.1x  |
    | cmf     | 26.7     | 14.2    | 69.6    | 4.9x  |
    | chaikin | 19.1     | 13.0    | 45.7    | 3.5x  |
    | mfi     | 25.7     | 15.1    | 75.9    | 5.0x  |
    | tmf     | 27.2     | 17.8    | 61.0    | 3.4x  |
    | force   | 5.4      | 4.4     | 17.4    | 4.0x  |
    | eom     | 14.2     | 8.2     | 39.8    | 4.9x  |

  **R2 step 2f part 2 (done): volume, the other 8 studies** (17 of the
  catalog's 18; anchored VWAP goes with session VWAP in step 3).
  - Calls: `klinger` (prefix `kvo`: `kvo`, `kvoSignal`),
    `volume_oscillator`, `trade_volume_index`
    (`TradeVolumeIndex::new(min_tick)`, no default), `negative_volume_index`,
    `positive_volume_index` (`start`, default 1000),
    `market_facilitation_index` (`bwmfi`), `shinohara_intensity_ratio`
    (prefix `sir`: `sirStrong`, `sirWeak`) and `vwap` (`Vwap::new(period)`,
    no default). The volume oscillator shares the price oscillator's
    arithmetic (`averages::oscillator_values`, split out of
    `price_oscillator`); the trailing VWAP reuses part 1's weighted mean.
    Errors and their order as pond-ts, pinned by unit tests (the parity
    check only sees that both sides fail): Klinger checks its periods
    before fast-before-slow, the volume oscillator the other way round;
    the trade volume index checks the tick before the output name, the
    volume indexes the output name before the start. Non-finite ticks
    and starts (which JSON cases cannot carry) are unit-tested too.
  - pond-ts's `foldRows` studies (Klinger, the trade volume index, the
    volume indexes) are one loop each with the same restart rule: a gap
    in any column ends the stretch and the next one starts over (the
    trade volume index stays a gap after an interior gap, as pond-ts).
  - Parity: the fixture grew to 4,672 cases, with one new input, `ticks`
    (closes moving by exactly 0.5 against the last decisive move, both
    ways). 3,436 match bit for bit, 457 errors agree, 482 refused (known
    missing-column difference), 297 calls Rust cannot write. Oracle: 206
    of 220 cases (was 193).
  - Planted bugs: 20 of 25 caught (the trade volume index's dead band was
    missed until the `ticks` input and a prime-ladder case went in). The
    5 missed change no output: Klinger's `v · |…| · t · 100` regrouped
    as `v · |…| · (t · 100)` (`t` is ±1, so both are exact); the trade
    volume index keeping its direction across a gap (after an interior
    gap the index is a gap anyway); and dropping the zero guards in the
    volume indexes, the market facilitation index and Shinohara's ratios
    (dividing by 0 gives an infinity or NaN, both stored as a gap, and an
    index that hits one stays a gap).
  - Perf: all O(N). At 1M rows all eight match pond-ts on every bit, on 4
    cores and on 1 (`POND_BITS=1`). Shinohara's terms are built with
    zipped iterators rather than indexing (1 thread: 61-83 ms over three
    runs before, 43-61 after on this noisy machine; same bits).
  - Medians of 3 runs of medians of 7, 1M bars at pond-ts's defaults
    (the trade volume index at `min_tick` 0.01, VWAP at 20 bars), ms:

    | Study   | 1 thread | 4 cores | pond-ts | ratio |
    | ------- | -------- | ------- | ------- | ----- |
    | klinger | 22.6     | 19.3    | 81.4    | 4.2x  |
    | volosc  | 13.5     | 6.6     | 65.1    | 9.9x  |
    | tvi     | 4.2      | 4.8     | 47.8    | 10.0x |
    | nvi     | 5.2      | 5.3     | 58.9    | 11.1x |
    | pvi     | 4.7      | 4.4     | 31.7    | 7.2x  |
    | bwmfi   | 5.3      | 5.3     | 39.2    | 7.4x  |
    | sir     | 45.2     | 19.8    | 160.7   | 8.1x  |
    | vwap    | 27.7     | 11.9    | 64.9    | 5.5x  |

  **R2 step 2g (done): price, 5 studies. Step 2 is complete**: every
  catalog study but the session family (pivot points, session VWAP) and
  anchored VWAP, which need step 3's calendars.
  - Calls: `typical_price`, `median_price`, `weighted_close`,
    `average_price` and `balance_of_power`. `BalanceOfPower` is written
    out by hand rather than with `study_options!`, because pond-ts's
    `period` has no default (absent means the raw per-bar ratio) and its
    `maType` is refused without a period: `.period(n)` and `.ma(t)` set
    optional fields, and `.ma(t)` alone gives pond-ts's error.
    `MedianPrice` has no `close` setter: pond-ts accepts a `close` there
    and never reads it, so a bad `close` is not an error on either side
    (the parity cases pass one).
  - Errors and their order as pond-ts, pinned by a unit test: the
    period, then a type without a period, then the output name, then the
    columns, the open first for the two studies that read it.
  - Parity: the fixture grew to 4,882 cases. 3,593 match bit for bit, 471
    errors agree, 518 refused (known missing-column difference), 300
    calls Rust cannot write. Oracle: 213 of 220 (was 206); the 7 left are
    pivot points (4), anchored VWAP (2) and session VWAP (1).
  - Planted bugs: 9 of 9 caught (the median's read order only after the
    unit test gained a case for it). Regrouping the sums (`c + c` for
    `2 · c`, the open first) changes bits and is caught.
  - Perf: all O(N), one pass each. At 1M rows all five (and the smoothed
    balance of power) match pond-ts on every bit, on 4 cores and on 1. The
    bench bars' close is the middle of the bar, so the weighted close
    equals the median there; parity covers the difference.
  - Medians of 3 runs of medians of 7, 1M bars, ms:

    | Study   | 1 thread | 4 cores | pond-ts | ratio |
    | ------- | -------- | ------- | ------- | ----- |
    | typical | 3.7      | 3.7     | 29.2    | 7.9x  |
    | median  | 2.9      | 3.4     | 11.7    | 3.4x  |
    | wclose  | 4.4      | 4.9     | 23.4    | 4.8x  |
    | avg     | 4.3      | 5.7     | 23.1    | 4.1x  |
    | bop     | 5.1      | 4.6     | 25.3    | 5.5x  |
    | bop 14  | 16.6     | 6.7     | 67.9    | 10.1x |

  **R2 step 3 split** (planned 2026-10-23): 3a the trading calendar on its
  own; 3b the three studies that read it (pivot points, session VWAP) or
  the key times (anchored VWAP).

  **R2 step 3a (done): trading calendars.**
  - Calls, in `pond_rs::financial`, as pond-ts `calendar/`: `Session`
    (date, open, close, breaks; `Session::new`, `.with_break`),
    `normalize_sessions`, `SessionRules` (`new(zone, open, close)`,
    `.weekmask`, `.with_break`, `.holiday(s)`, `.early_close`),
    `generate_sessions(&rules, from, to)` (a bound is a date string or an
    instant, `DateBound`), and `TradingCalendar` (`from_sessions`,
    `from_rules`, `with_time_zone`, `time_zone`, `sessions`, `len`,
    `session_on`, `is_trading_day`, `session_containing`, `is_open`,
    `sessions_in_range(start, end)`, `next_session` / `previous_session`
    (an instant or a date, `SessionRef`),
    `tag_sessions(&series, TagSessions)` with `Stamped::Open` /
    `Close`). Rules are resolved to
    instants with jiff, day by day; a skipped time moves forward, a
    repeated one takes the earlier instant (Temporal's `compatible`).
  - Checks and error messages are pond-ts's word for word (the zone and
    date parsing aside, which Temporal words), in pond-ts's order: the
    hours, the breaks, the range, then each trading day's early close; the
    zone is read only when a trading day needs it (a bad zone over a
    weekend gives no sessions and no error, in both).
  - Not built: `sessionSequence` / `barSequence` (pond-rs has no
    `BoundedSequence` input for `aggregate`; listed as a known difference
    since R1b) and `discontinuities` (a chart axis; charts are out of
    scope). Sessions hold whole milliseconds (pond-ts allows fractions).
    Years past 9999 are refused (jiff's range).
  - Known differences in reading inputs (found in review, #827): a range
    bound in another calendar (`2024-01-08[u-ca=gregory]`) is refused;
    pond-ts accepts it and writes session dates with the annotation on,
    which its own `fromRules` then refuses. A critical ISO annotation
    (`[!u-ca=iso8601]`) is refused, and an offset of `+24:00` accepted,
    where Temporal does the reverse. Zone names follow pond-rs's bundled
    tz database, not Node's: `Etc/Unknown` and `Factory` are known to
    pond-rs only, `Canada/East-Saskatchewan` and `US/Pacific-New` to Node
    only (same caveat as `Sequence::calendar`).
  - Shared quirk: a zone that skipped a whole day (Pacific/Apia,
    2011-12-30) gets a session for the missing day, placed on the next one,
    which `from_rules` then refuses as an overlap. Same in pond-ts; left
    alone (one zone, once).
  - Parity: a new fixture, `packages/financial/test/fixtures/calendar-parity.json`
    (written by `scripts/parity/calendar.mjs`, kept fresh by
    `calendar-parity.test.ts`), 110 cases checked by
    `tests/calendar_parity.rs`: 73 rule sets (New York over 2005-2010 and
    2024, Tokyo with a lunch break and early closes, London, Sydney,
    Kolkata, a skipped and a repeated hour, a skipped midnight, the
    missing Apia day, fixed-offset and lower-case zones, every date form
    for a bound, bad hours, breaks, weekmasks, holidays and early
    closes), 25 session lists, 4 calendars with ~2,700 lookups at every
    session and break edge, and 8 tagging cases. Every case agrees; every
    error message matches but the Temporal / core ones.
  - Perf: tagging is one forward walk, O(N + sessions). 1M minute bars on
    a New York calendar, medians of 3 runs of medians of 7, ms (pond-ts
    run one case per process; it varied 10-18 ms between runs):

    | Case      | 1 thread | 4 cores | pond-ts | ratio |
    | --------- | -------- | ------- | ------- | ----- |
    | tag open  | 2.3      | 1.9     | 18.0    | 9.5x  |
    | tag close | 3.0      | 1.8     | 15.1    | 8.4x  |

    Bits match node on 1 and 4 threads. Generating a 30-year calendar with a
    lunch break: 3.4 ms against pond-ts's 1.3 s (the Temporal polyfill);
    logged for pond-ts as [PND-CALGEN].

  **R2 step 3b (done): session VWAP, pivot points, anchored VWAP.**
  - Calls, in `pond_rs::financial`: `TimeSeries::session_vwap`
    (`SessionVwap`, writes `svwap`), `pivot_points` (`PivotPoints`,
    `PivotMethod::Standard` / `Fibonacci` / `Woodie` / `Camarilla`, prefix
    `pp`) and `anchored_vwap` (`AnchoredVwap::new(anchor_ms)`, writes
    `avwap`). The two session studies take a `SessionAnchor`: a calendar,
    a session list (checked and sorted as `normalize_sessions`), or a
    session-id column (`SessionAnchor::column`), with `.stamped` for the
    first two. pond-ts's "exactly one of `sessions` / `session`" check is
    the enum itself, so pond-rs cannot be given neither or both.
  - Checks and messages are pond-ts's, in its order: the output names,
    then the sessions (a stamp given with a column, the column, the list),
    then the price columns. Two limits (review, #828): an output named
    like the key column (`time`) is refused up front by pond-rs's shared
    name check but only when appending by pond-ts, so that message and
    order differ (all studies); and study parity counts error against
    error without comparing messages, so the order is pinned by a Rust
    unit test, not the fixture. Range and interval keys are not in the
    fixture (its inputs are time keyed).
  - Pivot points fuse pond-ts's two passes (previous-session high / low /
    close, then the levels) into one walk; the arithmetic per level is
    pond-ts's, so bits match. With a calendar only the sessions between
    the first and last bar are walked.
  - Parity: a `sessions` input (New York 30-minute bars, 08:00-17:00
    local, 2024-01-08 to -17: out-of-hours bars, a weekend, the 15th as a
    holiday, a trading day with no bars in hours, missing high / low /
    close cells, a zero-volume first hour, a day with no highs, plus a
    `sid` column; and the same from the first session's close, with an id
    that comes back after another) with cases over every door, stamp,
    method, a bad and unsorted list, overlap, collisions and missing
    columns. The fixture encodes a calendar as its rules, so both sides
    build it themselves. Study fixture now 5,055 cases; oracle 220 / 220
    (the last seven, pivots and the two VWAPs, now covered).
  - Perf: all three O(N + sessions), one pass. 1M bars, 4 cores, ms
    (medians of medians of 7): svwap 15.5 vs pond-ts 47 (3.0x), pivots
    44.9 vs 103 (2.3x), Camarilla 50.1 vs 105 (2.1x), anchored VWAP 6.7 vs
    28 (4.2x). Pivots write 7 or 9 columns, and each fresh 1M-row column
    costs ~5 ms to touch, so it is memory bound; fusing the passes did not
    make it faster. Bits match node at 1M rows.

  **R2 step 4 (done): the study catalog.**
  - Calls, in `pond_rs::financial::catalog`, as `@pond-ts/financial/catalog`:
    `STUDIES` (all 109, in pond-ts's order), `study_descriptor(name)`,
    `STUDY_FAMILIES`, and `StudyDescriptor` (name, family, summary, inputs,
    params with defaults / examples / min / max / suggest / menu values,
    naming, outputs with units, anchor) with `param`, `output_names`,
    `to_json` (pond-ts's JSON shape) and `run(&series, &options)`: any study
    by name with pond-ts's options as JSON. `run_with` takes a
    `SessionAnchor` for a calendar, which has no JSON form; a session list
    (`sessions`) or column (`session`) can go in the JSON.
  - The descriptor table (`catalog/table.rs`) was generated once from
    pond-ts's `STUDIES` and is edited by hand from now on;
    `tests/study_catalog.rs` checks it against a new fixture,
    `packages/financial/test/fixtures/catalog-parity.json` (written by
    `scripts/parity/catalog.mjs`, kept fresh by `catalog-parity.test.ts`):
    every descriptor equal, options in the same order. It also ports
    pond-ts's `catalog.test.ts` on the same 120 bars: each study appends
    exactly its declared columns; stating every default changes nothing
    (so the table's defaults are the options structs' own); every menu
    value, suggestion end and bound runs, one past a bound is refused. A
    planted wrong default in an options-struct study fails both checks.
    Where the runner reads the default from the table (a `Study` period:
    `rsi`, `momentum`, `z_score`…, and the moving-average type of three
    studies), the stated-defaults check compares the table with itself; the
    fixture check and the parity cases that leave the option out (against
    pond-ts) are what pin those (review, #829).
  - The runner sets only the options given, so each options struct keeps
    its own defaults; where a Rust call takes a value directly (a `Study`
    period, a moving-average type) the default comes from the descriptor.
    The study parity harness now calls every study through it (the old
    test-only mapper is gone): 3,702 matched, 827 errors agree, 526
    refused. The 320 calls Rust could not write before (such as negative or
    fractional periods, unknown menu names, neither or both session doors)
    are now runner errors, and pond-ts throws on all of them too.
  - Known differences: the runner's own errors (a missing required option,
    a wrong type, a bar count that is negative or not whole) are worded by
    pond-rs. `null` reads as left out, as pond-ts's `??` does in most
    studies. Unknown option keys are ignored, as in pond-ts. `to_json`'s `params`
    is an object keyed by name (the field `params` keeps the order).
  - Found by running every number option at 1e15: `random_walk_index`
    walked every horizon up to the period (pond-ts does too, and takes
    5.2 s at period 1e6 on 120 bars). Any horizon as long as the series
    makes every row a gap, so pond-rs now returns that at once; output
    unchanged. Logged for pond-ts as [PND-RWIBIG]. No other study was slow
    or panicked at 0, 1, 1e9, 1e15 or 2^53.

  **R2 step 5 (done): perf check and agent trial. R2 is complete.**
  - Perf: every catalog study at its defaults on the same 1M bars,
    pond-rs (`examples/perf_catalog.rs`, through the catalog runner) and
    pond-ts (`bench/catalog_pond_ts.mjs`), median of 7, every output bit
    hashed. Full table: `crates/pond-rs/bench/catalog-results.md`.
    - All 109 studies give the same bits in pond-ts, pond-rs on 4 cores
      and pond-rs on one thread.
    - 4 cores against pond-ts: median 6.1x, from 2.3x (`ema`) to 32.5x
      (`rollingMax`). Five are under 3x: `ema`, `historicalVolatility`,
      `rollingPercentile`, `superTrend`, `averagePrice`.
    - One thread against pond-ts: median 3.9x, from 1.0x
      (`primeNumberOscillator`). Five are under 1.4x: the prime-number pair
      and `correlation` / `beta` / `linearRegression` (the shared
      bivariate kernel). These split across cores (3.6-5.1x on 4).
    - Follow-up (2026-10-24, `catalog-results.md` "Follow-up"): the prime
      pair spent its time on trial division per row (and library
      `floor`/`ceil`); a per-stretch memo of the prime for each whole
      number took them to 19.0 / 13.1 ms on one thread (from 37.7 /
      27.4), same bits. The bivariate trio is bound by the arithmetic
      pond-ts specifies, which V8 compiles nearly as well as Rust; three
      bit-exact tweaks gave 0-9% and were not kept. Hand-written SIMD is
      the one lever left (unsafe code, maybe 1.3x); not scheduled.
  - Agent trial (`bench/agent-trial/r2/README.md`): RSI, Bollinger bands
    and a New York session VWAP across the March clock change, 10 fresh
    agents per library. pond-rs 9/10 right (all 10 values bit for bit; one
    wrote `rsi` last because `select` keeps the series' column order), 0
    failed runs; polars 10/10 right, 12 failed runs (every agent had one). No
    polars agent used polars for the maths; 6 of 10 hard-coded the 2024
    New York offset, right here and wrong for any other year. Every pond-rs
    agent used `rsi` + `bollinger` + `session_vwap` with
    `TradingCalendar::from_rules`.
  - Friction from the trial (pond-rs, not scheduled): dropping or
    reordering output columns is roundabout (9/10; `bollinger` always adds
    `bbMiddle`, `select` keeps the series' order and there is no reorder,
    which cost one agent its answer); the calendar route to
    session VWAP took reading two files (4/10); no `times()` accessor
    (2/10). All 10 noticed that the prompt's flat-window RSI rule (100)
    differs from pond-ts's documented gap; the data never has that case.

- **[PND-RUST-R3]** — the live layer (drafted 2026-10-23, after R2; revised
  twice on 2026-10-25 after two reviews of the plan; done 2026-10-29). RFC
  phase R3: pond-ts `packages/core/src/live/`, 9.7k lines (`LiveSeries`
  1.65k, partitioned 1.6k + 1.15k rolling, `LiveView` 1.2k, rolling / fused
  rolling 1.3k, aggregation 0.5k, reduce 0.5k, storage 1.4k, triggers
  0.2k).
  - Exactness: each push returns the same list of outputs as pond-ts
    dispatches for it (every kind, in order), and every operator's state
    after the last push matches, bit for bit. Checked against a new fixture
    written by pond-ts (`packages/core/test/fixtures/live-parity.json`,
    kept fresh by a pond-ts test, like `parity.json`). A case is a schema,
    options, a list of nodes (`{id, op, from, args}`, each created at a
    given push index so a view's replay of existing history is pinned),
    and a list of pushes, each with the ordered outputs it caused
    (`{node, kind, payload}`, recorded by one pond-ts listener per kind
    per node, in dispatch order), then `final` (rows for series and views,
    closed and open buckets, `value()`). `filter` / `map` use a small named
    predicate set (`gt` / `lt` / `eq` on one column) both sides implement.
    No clock input and no pause markers: pond-ts triggers and `max_age`
    run on event times only.
  - Design (proposed by the second review 2026-10-25, which built a 332-line
    Rust prototype; replaces the channels design pjm17971 picked on
    2026-10-24; he confirmed the switch on 2026-10-25): **one owner, typed handles,
    ordered outputs.** The root `LiveSeries` owns every operator built from
    it in a flat list (an arena); building one returns a `Copy + Send`
    handle `Node<T>` with no lifetime, and the caller queries through it
    (`live[bars].closed()`, `live[vwap].value()`). `push` / `push_many`
    run pond-ts's phases (each row's events down the tree → retention →
    batch → evict, then a settle phase where `reduce` emits) and return
    `Result<Vec<Output>, PondError>` in that order; nothing inside calls
    user code, blocks or drops. So no `Rc` / `RefCell` / `Mutex`, no
    re-entrant push queue, no listener errors, and no channel dependency.
    Channels, `tokio::sync::watch` (latest value only, e.g. an MCP tool)
    or a plain function are the caller's choice downstream: a short
    adapter, shown in the docs. Reads from another task: the caller puts
    the owner behind `Arc<Mutex<_>>` or publishes a snapshot after each
    push. Works under WASM (R4), where a blocking `recv()` does not.
    Details:
    - Outputs are opt-in per node and kind (`live.watch(node, kind)`), so
      a push builds no output a caller doesn't want; pond-ts likewise
      builds row objects only when a row listener is attached
      (`live-series.ts` "row-materialising listeners"). A
      `push_into(&mut Vec<Output>)` form reuses the caller's buffer.
    - `push_many` validates the whole batch, then commits it whole, then
      returns outputs (the chunked backing's behaviour; no half-committed
      batch is ever visible). `drop` mode keeps counting `rejected`.
    - `live.remove(node)` removes the node and its subtree (pond-ts
      `dispose`). Slots are kept and marked removed, so a stale handle
      returns `Err`, never another node; a handle used with the wrong
      owner or type returns `Err` too.
    - The live buffer is per-column with sealed chunks plus a mutable tail;
      `to_time_series()` shares sealed chunks by `Arc` rather than
      copying row by row.
    - Live rolling reuses R1's incremental window states
      (`rolling.rs` `trait WindowState`), as pond-ts reuses
      `rollingStateFor`.
  - `reduce` timing (first review 2026-10-25, reproduced): pond-ts
    `LiveReduce` emits from a `queueMicrotask`, so three `push()` calls
    with no `await` between them give ONE output (6) instead of 1, 3, 6,
    and `count(2)` over four such pushes gives 10, 10 instead of 3, 10.
    Logged as [PND-REDUCETICK] and fixed in pond-ts 2026-10-25 (an
    internal end-of-push hook after `'evict'`; `reduce` flushes there;
    construction replay still emits on a microtask). pond-rs's settle
    phase is an exact copy.
  - Steps (one PR each, parity + perf against pond-ts in each):
    1. The replay fixture generator in `packages/core/test/` (a few dozen
       cases across every operator), the Rust runner that compares, and
       the pond-ts [PND-REDUCETICK] fix.
       Done 2026-10-27: generator `packages/core/scripts/parity/live.mjs`
       (run by `generate.mjs`), fixture `live-parity.json` (46 cases,
       3,070 outputs inside calls plus 2 deferred, every operator, output
       kind and step kind), drift
       test `live-parity-fixture.test.ts`, Rust loader
       `tests/live_parity.rs` (checks the fixture's shape; `SUPPORTED_OPS`
       is empty until step 2 adds ops and fills in `run_case`). A case is
       a list of steps (`push` / `pushMany` / `pushJson` / `clear` /
       `node` / `dispose`) rather than nodes tagged with a push index:
       same information, and it also orders disposals. After each step the
       generator waits for microtasks; anything emitted then is the step's
       `deferred` list, which today is only a `reduce` built over existing
       history (its construction replay). pond-rs should return those as
       the outputs of building the node. Things the fixture pins that a
       port could get wrong: an aggregation emits the new open bucket
       before the bucket it closes (`bucket`, `event`, `update`); error
       wording differs by ordering mode (`'cpu': expected …` under
       `drop` / `reorder`, `row 0 col 2: …` under `strict`); under
       `drop` / `reorder`, `pushMany` with a bad second row commits and
       emits the first row's `event` (no `batch`) before throwing, while
       `strict` refuses the whole batch, so the "never half-committed"
       rule in the design above held for pond-ts only under `strict`
       (pjm17971 chose to fix pond-ts: [PND-BATCHATOM], so every mode
       now refuses a bad batch whole); disposing the last
       view on an intermediate view disposes the intermediate too, but
       only when nothing listens to it (case `view-dispose-chain`, an
       unwatched node; pond-rs's `remove` goes down the tree, so this
       upward case needs a deliberate mapping); on a
       `reorder` source an accepted late event makes every view on it
       throw while the source keeps the event (pond-ts bug, noted under
       [PND-LATE] in `PND_LIVE_PLAN.md`; case
       `partition-apply-and-retention`). Whether pond-rs copies that throw
       or the pond-ts bug is fixed first is a step 3 decision.
    2. Owner and handles on a small chain: `LiveSeries` (schema, `push` /
       `push_many` / `push_json`, ordering `strict` / `drop` / `reorder`
       with `grace_window`, retention `max_events` / `max_age`, `clear`,
       key queries `at` / `first` / `last` / `bisect` / `at_or_before` /
       `find` / `some` / `every` / `includes_key`, `time_range` /
       `event_rate`, snapshots incl. `to_json` / `from_json`, `stats`),
       plus `filter` and a fixed-bucket `aggregate` queried through
       handles, `watch`, and `remove`.
       Built 2026-10-27 (`src/live/`: `mod.rs` owner, `event.rs`,
       `buffer.rs`, `view.rs`, `aggregation.rs`, `json.rs`; cargo feature
       `live`, on by default). 31 of the 51 fixture cases run (every case
       whose nodes are only `filter` / `aggregate`), each push's outputs and
       every node's final state (aggregation `stats` included) equal. Five
       cases were added to the fixture for this step:
       `view-dispose-chain-filters`, `aggregate-reducers` (every reducer),
       `aggregate-grace`, `aggregate-boolean-array`,
       `aggregate-dispose-on-view`. Decisions
       and differences from pond-ts:
       - Rows were first stored as a `VecDeque` of shared events
         (`Arc` key + values, `Arc` schema): a filter or a watched output
         handed the same event on with two reference counts. Cost was about
         250 bytes per event (each cell a 48-byte `Value`). Replaced by a
         column store before step 4 (below, "Memory").
       - `push_many` checks every row, then dry-runs the ordering over the
         batch, then commits, in every mode (pond-ts after [PND-BATCHATOM]).
       - `remove(node)`: that node's handle then returns `Err`; nodes
         built on it stay readable but get no more events. When a view is
         removed, a source view left with no children and no watched
         output is detached too, and so on up (pond-ts's upward dispose,
         case `view-dispose-chain`); it stays readable. Removing an
         aggregation does not walk up (`LiveAggregation.dispose` only
         unsubscribes; case `aggregate-dispose-on-view`, found in review).
         The root cannot be removed.
       - pond-rs refuses what pond-ts accepts and gets wrong: number
         reducers on text columns ([PND-KINDREDUCE]; case
         `aggregate-bad-mapping` is listed as refused in the harness),
         decimal columns and duplicate column names in a live schema, and
         intervals whose label kind differs from the events held.
       - `keep` on an array column compares the arrays' elements, as
         batch pond-rs does; pond-ts compares the array objects, so two
         equal arrays give a gap there ([PND-ARRAYKEY], logged with the
         batch reducers). The fixture's array case leaves `keep` out.
       - Bucket edges are worked out in i128, and `aggregate` refuses a
         step and anchor whose edges for a supported time would not fit
         an i64 (an anchor of `i64::MIN` panicked before review).
       - A late event a `reorder` source accepts goes into each view in
         key order; pond-ts views throw ([PND-LATE]). No fixture case
         reaches it with only step 2 nodes; step 3 decides.
       - `aggregate` refuses calendar sequences for now (step 5 with the
         full `LiveAggregation`).
       - For step 6: pond-ts #838 (partition fan-out per `pushMany`)
         finishes partitions (retention, `batch`, `evict`, settle) in the
         order of each partition's last row in the batch; fixture case
         `partition-pushmany`.
       - Timing (`examples/perf_live.rs` vs `bench/live_pond_ts.mjs`, 1M
         events, pond-ts after the fix below): one at a time 298 ms vs
         3,548 (12x); `max_events` 10k 220 vs 2,667; reorder 398 vs 587;
         filter + aggregate 418 vs 3,864, all outputs watched 696 vs
         4,401, on a 10k window 408 vs 10,766. Batches of 1,000: 260 vs
         148, pond-rs slower: storing takes ~125 ms and freeing the 1M
         events when the series is dropped ~130 ms (counted in the time);
         pond-ts stores batches by column and makes no per-event object
         when nothing listens. A column store would close that.
       - Timing found a pond-ts bug, fixed in the same PR:
         [PND-LIVEPUSHSCAN] (one-at-a-time `push` slowed as the series
         grew).
    3. Views: `map`, `select`, `sample`, `window`; live `diff` / `rate` /
       `pct_change` / `fill` / `cumulative`.
       Built 2026-10-28 (`src/live/views.rs`; `window` trimming in
       `view.rs`). 39 of the 52 fixture cases run, every output and final
       state equal; one case added, `views-reorder-late`. Decisions and
       differences from pond-ts:
       - Late events ([PND-LATE]): pjm17971 chose insert in order
         (2026-10-28; the other options were stateful views skip it, or
         refuse the push). pond-ts was changed to match (its
         views threw after the root had stored the event): every view puts
         a late event at its key position, after equal keys; `diff`,
         `rate`, `pct_change`, `fill`, `cumulative` and `sample` work in
         arrival order. A pond-ts re-keying `map` that went backwards also
         threw; it now inserts in order too (pond-rs `map` cannot re-key).
       - Fixed in pond-ts on the way: live `fill('zero')` wrote `0` into
         text columns (batch skips them); case `fill-cumulative` showed it.
       - pond-rs refuses at build what pond-ts takes silently: unknown or
         repeated columns, `diff` / `rate` / `pct_change` / `cumulative`
         on a column that is not a number (pond-ts gives gaps; case
         `diff-rate-pct` node `bad` is listed as refused in the harness),
         `Zero` or a value of the wrong kind in a per-column `fill` (batch
         pond-rs refuses the same), `Bfill` / `Linear`, `sample` with
         `Reservoir` (pond-ts has stride only) or stride 0, a row window of
         0, `cumulative` with a reducer other than sum / max / min / count.
       - `map(from, |event| cells)` returns the new cells in schema order
         and keeps the key and schema (no re-keying, no new columns);
         a wrong number of cells or a cell of the wrong kind panics during
         the push. Non-finite numbers become gaps, as pond-ts.
       - `fill_with(.., limit)`: a live view fills the first `limit` gaps
         of a longer run and leaves the rest (pond-ts live); batch
         `fill_with` leaves the whole run unfilled.
       - A `window` view trims itself silently (no `Evict` output, and
         views on it keep what it trimmed), as pond-ts. `filter`, `map`
         and `select` on a time window keep its length for `event_rate`.
       - Timing (1M events, same quiet run, pond-rs vs pond-ts, ms): on a
         `max_events` 10k root, diff + rate + pct_change 739 vs 4,404;
         fill hold + cumulative 606 vs 3,523; map + select + sample 480
         vs 3,678; two windows 309 vs 3,173; reorder 5% late with diff +
         fill + window 761 vs 1,239. Each view that makes new events costs
         pond-rs ~0.2-0.3 µs an event (an `Arc`, a `Vec` and a text clone
         per event; the row layout noted under memory below). Timing found
         a pond-ts slowdown, fixed in the same PR: [PND-EVICTSPLICE]
         (dropping old events copied the whole buffer per push; before the
         fix pond-ts took 115 s on the first case). pond-rs also stopped
         collecting a view's evicted events when nothing follows them.
       - Memory (gRPC experiment friction, 2026-10-28,
         pjm17971/pond-grpc-experiment#45): a 30 s window at 1000 hosts x
         1000 events/s held ~10.3M rows in 2,540 MB, ~250 bytes per row
         against ~67 for a plain `VecDeque` of the same rows, and the batch
         handler's p99 doubled; cause is one `Arc` + a `Vec` of 48-byte
         `Option<Value>` cells per event. Same column-store point as the
         step 2 `push_many` timing. Also `LiveSeries::to_json` copies into
         a `TimeSeries` first.
       - Fixed 2026-10-28, before step 4 (pjm17971 asked whether to fix it
         now; yes, since steps 4-6 add more nodes that keep events): series
         and views store events by column (`live/buffer.rs`): a start time
         per event (plus end and label for range and interval keys) and a
         `VecDeque` per value column, numbers as `f64` with NaN for a gap
         (live number columns never hold NaN otherwise), text as
         `Option<String>`, true/false as `Option<bool>`. A `LiveEvent` is
         built when read (`at`, `events`, `find`, … now return owned events)
         or when a push hands an event down the tree; the root stores an
         event after handing it on, moving its cells in when no output kept
         it. Simpler than the sealed chunks the design above names: no
         `Arc` sharing of chunks with `to_time_series` (which builds
         columns straight from the store). Memory (`examples/mem_live.rs`,
         1M events, bytes held per event): time + 3 numbers 249 → 34;
         time + text + 2 numbers 250 → 51; the same plus a pass-all filter
         133 → 51 per event summed over both nodes (the view alone went
         from ~16 to ~51: it now holds its own copy rather than sharing the
         root's events, so each pass-through view costs about as much as
         the series; worth remembering as steps 4-6 add nodes); time + 10
         numbers 585 → 92. Timing
         (`perf_live`, ms, best of two interleaved runs, before → after):
         one at a time 268 → 220; batches of 1,000 217 → 204; reorder 306
         → 230; filter + aggregate 382 → 293; fill + cumulative 600 → 450;
         filter + aggregate on a 10k-capped root 278 → 339 and map +
         select + sample 462 → 499 (copying cells into each view, text
         cells allocate); the rest within ±6%. Batches of 1,000 are still
         slower than pond-ts (92 ms): each row still makes one short-lived
         event and frees the caller's cell list.
    4. Rolling: single-window (`LiveRollingAggregation`), fused
       multi-window (`LiveFusedRolling`), `reduce`.
       Built 2026-10-28 (`src/live/rolling.rs`, `reduce.rs`, `states.rs`;
       batch `rolling.rs` states shared). 52 of the 57 fixture cases run
       (the 5 left are partitioned, step 6), every output and final state
       equal. Five cases added (`reduce-and-rolling-reorder`,
       `rolling-reducers`, `rolling-tags`, `rolling-history`,
       `rolling-overflow`) after mutation testing showed the first fixture
       missed a reduce that ignored where a late event went, or ignored
       that a reorder root drops events out of arrival order; 14 planted
       bugs, all caught now. Decisions and differences from pond-ts:
       - Triggers for rolling and reduce came with this step (the fixture
         cases use them): `Trigger::event`, `every(duration)`,
         `clock(sequence)` (calendar sequences refused), `count(n)`. Step 5
         is left with the full `LiveAggregation` (closed and open buckets,
         calendar sequences).
       - A reduce over a series or view removes each evicted event under
         the index it was added with (pond-ts finds it by object identity):
         it keeps the index of each event its source holds, in the
         source's order, inserting a late event where the source put it
         and dropping what a `window` view trims silently.
       - Sources as pond-ts allows them: `rolling` on the series, a view
         or an aggregation; `reduce` on the series or a view; nothing on a
         reduce or on fused windows (pond-ts has no methods there). The
         first build allowed any source; review on #843 found those had
         no pond-ts behaviour to match.
       - A reduce built over existing events emits for them during the
         build. pond-ts emits on a microtask after the build, so a caller
         that pushes again without yielding gets one emission covering
         both from pond-ts and two from pond-rs. pond-rs has no event loop
         to wait for; the fixture (which waits after each step) matches.
       - `value()` peeks (copies a `stdev` state before reading), so
         reading changes nothing. In pond-ts a read can move the reference
         point of a running `stdev` and with it the last bit of a later
         value; pond-rs copies the reads pond-ts makes inside a push (for
         `update` listeners, made whether or not any listen), so pushed
         results match bit for bit.
       - A clock trigger on a source keyed by time range or interval is
         refused: pond-ts emits time keys under that schema.
       - Huge values: sums of values from 2^960 (2^480 for `stdev`) go to
         an exact big-integer lane as pond-ts (`num-bigint`, new optional
         dependency of the `live` feature), so a window that overflowed to
         infinity reads finite again once they leave.
       - `Output::Update` now carries the rolling window's values (pond-ts
         passes `value()` to `update` listeners); `None` for an
         aggregation.
       - `keep` over array cells counts by event (pond-ts compares array
         objects, so equal arrays from different events differ).
       - Timing (1M events, each case alone in its own process, pond-rs
         vs pond-ts, ms, root keeping 10k events): root alone 182 vs
         2,049; rolling 30 s avg + max + stdev 328 vs 3,719; rolling 100
         rows avg, history off, `update` watched 291 vs 2,935; fused 1 m +
         5 m + 15 m avg 338 vs 3,493; reduce avg + max + count 357 vs
         6,443. Each node adds 0.11-0.18 µs an event to pond-rs (time
         over the root alone; not broken down further). Timing found a
         pond-ts slowdown, fixed in the same PR: [PND-REDUCEMICRO] (reduce
         queued a microtask per push in a loop that never awaits; the
         reduce case took 12,633 ms before).
    5. Triggers (`event`, `clock(sequence)`, `every(duration)`,
       `count(n)`; calendar sequences refused for clock triggers) across
       rolling, reduce and the full `LiveAggregation` (closed and open
       buckets).
       Built 2026-10-28. Triggers had come with step 4, and closed and
       open buckets with step 2, so what was left was pond-ts's
       per-aggregation grace (the `LiveAggregation` constructor's
       `{ grace }`, now `aggregate_with`) and calendar sequences.
       pond-ts refused those in live `aggregate` too (`stepMs()` throws),
       so they were new work in both libraries; pjm17971 chose to add them
       (2026-10-28) rather than close the step with grace only.
       - pond-ts: `LiveAggregation` takes the bucket holding each event
         from `sequence.bounded` over the single instant (coverage
         `'overlap'`) and keeps the last one, so only an event outside it
         does time-zone arithmetic. Fixed sequences keep the arithmetic
         path. Clock triggers still refuse calendar sequences.
       - pond-rs: `Sequence::calendar_bucket` (one bucket, no walk past
         it: `buckets_overlapping` computes the next bucket's end first,
         which fails a year earlier near jiff's limits). While a calendar
         aggregation exists the series refuses times outside years -9997
         to 9997 UTC (`CALENDAR_RANGE_MS`; jiff handles ±9999 and a year
         bucket in a zone 14 h off needs the year beside it), and building
         one over such an event is refused. pond-ts takes any time.
       - Fixture: cases `aggregate-own-grace` and
         `aggregate-calendar-zones` (New York days across the 2026 DST
         change, Sunday weeks, London months, a filter view, a late row
         into the day before the cached one), `aggregate-calendar-fallback`
         (New York's 25-hour fall-back day, Santiago's skipped midnight);
         `aggregate-calendar` now records buckets instead of an error. 55
         of 60 cases run, all equal. A cache that checked only `ts < end` survived until the
         late row went into an earlier bucket.
       - Timing (1M events, root keeping 10k, each case alone, ms): daily
         New York buckets 198 vs pond-ts 2,469; the fixed path unchanged
         (filter + aggregate 1 m 315 vs 3,103, 3,489 for pond-ts in the
         step 4 run).
    6. Partitioned: `partition_by` (a node owning one subtree per key),
       `to_map` / `apply` / `collect` (append-only fan-in), partitioned
       fused rolling with synchronised emission.
       Built 2026-10-28 (`src/live/partition.rs`, `partition_rolling.rs`,
       `series.rs`), after pond-ts #838 merged (pjm17971 chose to merge it
       first so pond-rs copies its batch routing).
       - Partitions are series inside the owner (`SubSeries`); the root is
         one too. Each slot records its nearest series, whose push settles
         the reduces below it. `partition_by` is root-only in pond-rs.
       - pond-ts's partitioned sugar (`p.fill(..)`, `p.diff(..)`,
         `p.rolling(..)` without a clock, ...) is one call:
         `per_partition(from, |live, part| ...)`, a closure that builds the
         chain on a partition and is run again for every partition
         `collect` / `apply` / `partition_outputs` builds on, and once on an
         empty stub to learn the schema. `node::<T>(id)` gives a typed
         handle for its output.
       - Routing copies pond-ts exactly, since output order depends on it:
         on a strict time-keyed root, a push goes to the partitions first
         (each built in order of its first row, then every row's event in
         push order, then each partition closes in order of its last row,
         #838); otherwise each root event is routed as it arrives. The
         quiet-partition age sweep runs every `max_age / 8` of time.
       - A push a partition would refuse (value outside `groups`, an event
         a stricter partition ordering refuses) is refused whole before
         anything is stored; pond-ts stores it in the root and throws
         (case `partition-groups`, compared without that row). An order a
         gathered (`collect` / `apply`) series refuses fails the push
         after it is delivered, as pond-ts throws mid-delivery.
       - Synchronised rolling (`partition_rolling`, `_rows`, `_windows`)
         reuses the rolling window state per partition (`take`, `advance`
         added to `LiveRolling`). Emitting order: declared groups, then
         first event. Its partition column is text (pond-ts declares the
         source column's type but writes the key text into it).
       - Fixture: 4 cases added (`partition-over-history`,
         `partition-max-age`, `partition-max-age-sweep`,
         `partition-rolling-history`) after mutation runs showed history
         replay, inherited retention, the sweep step, group order and
         chain-fed rolling were unchecked. 65 of 65 cases run, all equal.
       - Timing found pond-rs slower than pond-ts at 1000 partitions: the
         end-of-push settle scanned every node per series push (fixed: a
         list of reduces), plus a linear search per routed row (fixed:
         map). 1000 hosts, batches of 1000, per-host rolling 4,288 ms
         before, 994 after. The up-front partition check is skipped when
         the root's own order check already covers it.
       - Threads (tried 2026-10-28/29, not kept; pjm17971 chose "stop").
         `PartitionOptions::threads(n)` split partitions over shards, each
         push's per-partition work ran on rayon and outputs were merged
         back in one-thread order (an event engine trait shared by the
         owner and a shard). Outputs matched on 1-5 shards (fixture plus
         random pipelines), but the go/no-go (>= 1.5x on 4 threads, 1000
         hosts, 1000-row pushes, rolling + collect) failed: 0.96 s on one
         thread, 1.5-1.9 s on 2-4. Causes measured: a 1000-row push holds
         ~0.5 ms of work, about what waking threads and merging cost;
         with glibc malloc each shard ran ~2x slower when shards ran
         together (mimalloc removed most of that and made one thread
         35% faster); `collect` stays on the owner. At 50 hosts and 1M
         rows/s one thread already does 1.0-1.4M rows/s (1.4-2.0M with
         mimalloc); threads gave at best 1.3x. The parked code is commit
         ff570b52 (reachable from branch claude/project-thread-225u77).
         For more cores: several `LiveSeries`, each with a share of the
         keys (2.5x on 4 threads at 1000 hosts). The same work found
         the per-row linear search through declared `groups` (fixed,
         1000 declared hosts 2.8 s -> 1.2 s).
    7. Perf (events per second, pond-ts vs pond-rs) and an agent trial on
       a streaming task against polars-or-hand-written Rust; also the same
       task with a channel-style API vs owner-and-handles, to test rather
       than assume which agents get right.
       **Done 2026-10-29.**
       - Perf: every `examples/perf_live.rs` case re-run on one machine
         (pond-rs middle of 3 runs; pond-ts one process per case, since one
         process for all cases grew slower as its heap filled and ran out
         of memory on the last case). One series: ~3M events/s pond-rs,
         ~250k pond-ts (331 vs 3,944 ms per 1M); views, rolling, reduce
         and 4-host partitions 5-17x, 1,000-host partitions 2.6-2.7x. Weak spots: batches of 1,000 (pond-ts 2.5x
         faster, [PND-RUSTLIVEBATCH]) and `Reorder` with views (1.2x).
         Much of pond-ts's one-at-a-time cost is its strict path building
         a one-row chunk per push ([PND-LIVEONEPUSH]): in-order rows into a
         `Reorder` series take pond-ts 0.76-0.8 s, so pond-rs is ~2x there. Table in
         `website/docs/pond-rs/live.mdx` (Speed).
       - Speed review, 2026-10-29 (thread "Review live series speed top
         to bottom", Peter's ask: top to bottom, including the batches
         slower than node). Method: `examples/prof_live.rs` (perf_live
         twin, one case per run inside `timed`) under callgrind, so the
         record is instructions per event, not this VM's ±30% timings; a
         `git worktree` of the base commit gives the before numbers.
         Findings at 200k rows: a bare batch push cost 1,877 instructions
         per row, ~45% of it allocation: an `Arc<EventData>` per row even
         when nobody reads events (~700), freeing the caller's `Vec` per
         row (~190), the row check (~220). `reduce` rebuilt a `LiveEvent`
         per evicted event (34% of its case). Partition routing made a
         fresh `HashMap` + `Vec` per partition per push (~14% of the
         1,000-host case) and partition rolling cloned and hashed the key
         twice per event. Rolling, reduce and partition-rolling outputs
         went through a throwaway `Vec`; leaf `map`/`select`/`diff` views
         built an `Arc` + `Vec` per event only to copy the cells out.
         Fixes (all internal, parity 65/65, no API change): a series with
         no subscribers, routers or partitions (`bare_root`) stores cells
         straight from the checked rows; `compare_keys` returns as soon as
         the starts differ and the order check borrows keys; eviction
         reads the cells a `reduce` must remove before they go
         (`EventBuffer::cell`); each partition keeps a `share_at` table
         across pushes and partition rolling maps slot → feed index with
         the window made lazily on the first event (making it at spawn
         changed pond-ts's emit order and broke parity); `append_values`
         writes output rows from an iterator; a view step returns
         `Kept::Pass(event)` or `Kept::New(cells)` so a leaf view stores
         cells without an event. Result: 7–42% fewer instructions per
         event on every case (push −41%, batches −37%, `Reorder` −42%,
         `reduce` −31%, 1,000-host sync −27%, views 7–15%). Wall clock
         moved where the cut was big (push 372 → 234 ms, batches 296 →
         255, reduce 826 → 398, 1,000-host sync 2,954 → 2,475) and sat in
         the noise elsewhere. The batch gap vs node: with the library's
         share now ~50 ms per 1M rows, 70–130 ms is freeing the caller's
         per-row `Vec`s and the host `String`s (measured by timing the
         pushes, then the drop, then the bench's own batching alone);
         node does that in its garbage collector, off the clock. Only a
         column-shaped push removes it ([PND-RUSTLIVEBATCH]). Not done:
         a threads-in-library trial (already parked), any API change.
       - [PND-RUSTLIVEBATCH] done 2026-10-29 (Peter: "work on it").
         `LiveSeries::push_series(&TimeSeries)`: a batch series pushed as
         one batch, same rules and outputs as `push_many` of its rows
         (key kind must match; the live series' value columns by name in
         any order, same kinds; a gap in a required column or a non-finite
         number in an array cell is refused naming the row; extra or
         missing columns refused; all or nothing). With nothing built on
         or watching the series, `ingest_bare_series` copies each run of
         in-order rows into storage column by column
         (`EventBuffer::append_series`, `Cells::extend_from`); a late row
         under `Drop` is skipped, under `Reorder` inserted on its own,
         and `Strict` has refused the batch already. Otherwise rows become
         events as in `push_many`. Measured (callgrind, 200k rows):
         `push_many` batches 1,158 instructions/row, `push_series` 517
         (−55%); with filter + 1 m aggregate built on it 3,385/row, the
         same as pushing rows (the event path). Wall clock, 1M rows,
         batches of 1,000, same machine same hour: `push_many` 247 ms,
         `push_series` 126 ms, pond-ts `pushMany` 192 ms. Tests: the same
         session run twice (rows vs series) in 8 modes × 3 batchings
         gives the same outputs, rows, stats and errors; shape and row
         errors pinned. Chosen shape: a `TimeSeries` rather than
         `push_columns(keys, columns)`, since that is what Arrow and JSON
         readers hand back and it carries validated, sorted keys. Not
         built: a column path for a series with nodes (each node still
         takes one event at a time, as pond-ts); pond-ts has no
         column-shaped push, so no parity case (the rows-vs-series test
         stands in).
       - Agent trial (`bench/agent-trial/r3/README.md`): per-host minute
         buckets over late events with a 5 s grace, against plain Rust
         (std only; polars has no push-one-event API). 10/10 right on both
         sides, 0 failed runs on both. The task spells out its rules, so
         plain Rust needs ~60 lines; it does not separate the sides. 9/10
         pond-rs agents also wrote the rules by hand to cross-check the
         library. Friction: 10/10 found gathered partition outputs carry
         no partition key ([PND-LIVEKEY]); 5/10 had to read source to
         tell the series grace window (refuses late events) from
         `aggregate_with`'s bucket grace (doc comment on `aggregate` now
         says so); 7/10 unsure whether the gathered series needs
         `Reorder`.
       - Channel-API arm not run: pond-rs has no channel API (owner and
         handles chosen 2026-10-25), and no agent had trouble with handles
         or `push` returning outputs.
  - Out of scope: React hooks, charts, live financial studies (none exist
    in pond-ts), and `@pond-ts/process` (RFC decision 4), including its
    `fromLive` binding. So R3 gives live series and studies, not the
    process layer's op registry, envelopes or wire format; an app that
    needs those keeps using `@pond-ts/process` in TypeScript, or a process
    port becomes its own phase.

- **[PND-RUST-R4]** — bridges to JavaScript (WebAssembly) and Python
  (planned 2026-10-29; pjm17971 chose "Yes, all" on 2026-10-30: a separate
  npm package, both bridges at once, same version as pond-ts on every `v*`
  tag; Python name `pond-rs`, imported as `pond_rs`). Plan doc for review:
  https://claude.ai/artifact/3RY7ofiG8B21stg3W7nvtf.
  - Why: pond-rs's speed for JavaScript and Python users without writing
    Rust. Probes (2026-10-29, 1M rows, outputs bit for bit pond-ts's):
    - WebAssembly (wasm-bindgen 0.2.129, `default-features = false`):
      live pushes one at a time 7-12x pond-ts (plain 326 vs 3,539-4,043
      ms); rolling 5 m 6.1x, `sma` 2.3x, `rsi` 2.0x, aggregate 1.5x,
      `bollinger` 1.4x, `diff` even (JS arrays in and out, copies
      included). Size, brotli: core 269 KB, + live 655 KB (the live query
      path pulls in the ICU collator, ~1.1 MB raw), everything 1,015 KB.
      ~5 ns per call; 1M numbers in 0.6 ms, out 1.0 ms.
    - Python (PyO3 0.29 + arrow-pyarrow 59.3.2, abi3 wheel 2.3 MB):
      pyarrow / polars / pandas frames in and out, gap-free number columns
      not copied; mimalloc cut a 4-column round trip 44-49 -> 14-17 ms.
      Against polars, frame in to frame out: rolling, aggregate, `sma`
      even, `rsi` ~2x faster, `diff` slower (the copy is the whole cost).
  - Costs (JavaScript): `free()` per series (a finalizer backs it up),
    out of memory or a panic kills the instance (the binding must return
    errors, never unwrap), one thread, 3.84 GB memory cap.
  - Shape (JavaScript): a separate package with pond-rs's API, not
    WebAssembly inside pond-ts (the RFC's first R4 idea); that stays open
    for single hot spots.
  - Steps, each checked against the pond-ts fixtures the crate passes:
    - J1 `crates/pond-wasm`: series from / to JS typed arrays and Arrow
      IPC, the batch core, errors as JS exceptions, `free()` + finalizer,
      size cuts (no collator in the live path; Arrow decompression only).
      Check: core parity fixture through JS.
    - J2: studies through the catalog (`study(name, options)` plus named
      helpers from the catalog table) and `LiveSeries`. Check: study and
      live parity fixtures through JS.
    - J3: Node + browser builds, npm `@pond-ts/rs` published on `v*`,
      docs JavaScript tab, speed table vs pond-ts.
    - P1 `crates/pond-py`: frames in / out (Arrow, no copy where
      possible), the batch core with keyword options, `datetime` and
      duration strings, mimalloc, errors as Python exceptions. Check: core
      parity fixture through pytest.
      - Outcome (2026-10-30, merged #860 after Peter's OK): built.
        PyO3 0.29 abi3-py39 + arrow-pyarrow 59.3.2 + mimalloc; one wheel
        3.4 MB stripped (the probe's 2.3 MB bound far less). In: anything
        with `__arrow_c_stream__` / `__arrow_c_array__` (pyarrow, polars,
        pandas 2.2+), or a dict of columns. Out: the series is itself an
        Arrow stream, plus `to_pyarrow` / `to_polars` / `to_pandas`. A
        gap-free float column of a one-chunk table crosses both ways
        without a copy (pytest checks buffer addresses). Every pond-rs
        call runs with the GIL released; Python callbacks (`filter`,
        `map`, `scan`, `collapse`, `as_interval`, `find`) take it back and
        their first exception is re-raised as itself. Option words are
        keyword arguments; the shared series / partitioned methods are
        written once (`shared_methods!`). Lookups return `Row` objects.
        pytest: all 1,230 core cases, 2,907 lookups, 1,332 time texts,
        JSON / columns / points, value series and pond-ts's Arrow
        exports, with the Rust harness's known differences; a planted
        wrong answer in each of the 990 series cases is caught.
        Decisions: a naive `datetime` is UTC (as Arrow's naive
        timestamps); a sub-millisecond time is refused, not rounded; a
        nullable Arrow field gives an optional column (pyarrow's default
        is nullable); `rolling(window=int)` counts rows. Speed, 1M rows,
        frame in to frame out vs polars 2.1: rolling 35.5 vs 39.1 ms,
        1-minute buckets 11.6 vs 14.7, New York days 11.8 vs 7.1, `diff`
        16.5 vs 3.3 (data in costs ~7 ms: the time key is copied and
        checked), 100-host rolling 428 vs 127, slow in pond-rs itself
        ([PND-RSPARTMERGE]).
    - P2: studies through the catalog, `LiveSeries`. Split in two PRs:
      P2a studies (and the trading calendars the session studies need),
      P2b `LiveSeries` (with `push_series` for Arrow frames, #857).
      - P2a outcome (2026-10-30): `series.study(name, **options)` runs any
        catalog study; each study is also a method in Python's spelling
        (`series.rsi(period=14)`), found by attribute lookup and typed in
        `pond_rs.pyi` by `scripts/gen_stubs.py` (a pytest checks the stub
        is current). On a `PartitionedSeries` the study runs per group
        (`PartitionedSeries::map`). Options take Python or pond-ts
        spelling. Decision: an option the study does not have is a
        `TypeError` (Python's rule for an unexpected keyword; pond-ts's
        types refuse it at compile time, only its runtime ignores it), so a
        typo such as `peroid=` cannot pass silently. 22 study-parity cases
        pass such options (volume studies given `high`/`low`); they are
        checked to raise. `TradingCalendar` (`from_rules`, `from_sessions`,
        lookups, `tag_sessions`; sessions are dicts, times in epoch ms) and
        `sessions=` taking a calendar, a list or `session=` a column.
        `studies()` / `study_info()` give the catalog JSON plus `method`
        and `output_names`. pytest: study parity 3,680 matched + 22
        refused options (= the Rust harness's 3,702), 827 errors agree,
        526 known refusals; a planted 1-ulp change in each of 3,270 cases
        with a finite value was caught every time (one-off run); oracle
        220/220 within 5e-10; 109 descriptors equal pond-ts's; every study
        runs from its method with its defaults; calendar parity 110/110.
        Decision (review): calendar lookups (`session_on`,
        `is_trading_day`, `next_session`, `previous_session`) take only
        `YYYY-MM-DD` text as a date; other text is an error, or a time for
        next/previous. pond-ts compares any text with session dates as
        strings, so `""` or `"Jan 12"` quietly found nothing or the wrong
        neighbour (pond-rs keeps pond-ts's rule; the fixture's 32 such
        queries are checked to raise here).
        Speed, 1M rows, frame in to frame out (shared 4-core VM; runs vary
        by about a third): RSI 21.5 ms vs polars 36.3 / pandas 58.4 (both
        hand-written, as neither has RSI), Bollinger 22.2 vs 34.6 / 70.2.
      - P2b outcome (2026-10-30): `pond_rs.LiveSeries` (`src/live.rs`).
        Schema as `{name: kind}`, tuples or a `TimeSeries.schema`; value
        columns optional unless marked. `push` / `push_many` / `push_frame`
        (any frame `TimeSeries()` reads, then `push_series`) /
        `push_json` / `clear` return the watched nodes' outputs as
        `LiveOutput` objects. Every node is one `LiveNode` class with a
        `kind` word; builders are shared by `LiveSeries` and `LiveNode`
        (`live_builders!`), and on a partitioned node each step is built
        per partition through `per_partition` (a `Step` value cloned into
        each partition's chain), so `partition_by(..).fill(..).rolling(..)
.collect()` reads as in pond-ts. A partitioned `rolling` with a
        clock trigger (a duration or `Sequence`) or several windows builds
        the synchronised `partition_rolling` node, as pond-ts does.
        Decisions: (1) the owner sits behind a `Mutex`; a call takes it
        with Python's lock released, except short calls (`push`, `len`)
        which first try it without releasing Python's lock (releasing and
        retaking it cost more than the call: `len()` 162 -> 64 ns), falling
        back to waiting released. Safe because a thread holding both runs
        only Rust, so no other thread can be holding Python's lock while
        waiting for the series. (2) A node's Python function runs inside
        the push; an exception costs only that event's value from that
        node (filter: left out; map: gaps; cumulative fold: the running
        value stays), every function keeps running, and the first
        exception is raised when the push returns with the push's outputs
        as its `outputs` attribute (the push has happened: pond-rs has no
        rollback). Review of #864 found the first version skipping every
        later function call in the push, which broke unrelated nodes and
        left a fold at NaN for good. (3) A function that calls back into
        its own series would wait on its own lock; a thread id kept with
        the lock turns that into an error on the push's thread (handing
        the call to another thread and joining it still waits forever).
        A partitioned node refuses `watch()` (it emits nothing itself).
        (4) A node built over history runs its function at once; if that
        raises, the node is removed before the error reaches Python (no
        handle would exist). (5) No Python `apply(fn)`: chaining on a
        partitioned node then `collect()` builds the same thing without a
        Python function per partition. pytest: all 70 live parity cases
        (7,897 outputs and 5,918 final rows compared, with the Rust
        harness's two refused nodes and one refused push); planted
        mistakes (map off by 1e-12, filter inverted, -0 read as 0) each
        fail cases. Speed (`bench/bench_live.py`, 1M events, rolling 1m
        avg + 1m buckets): `push` one call per event 631 ms, `push_many`
        1,000-row batches 299 ms, `push_frame` 10,000-row tables 219 ms,
        frame into a bare series 19 ms; the same two sums hand-written in
        Python 317 ms. Rust alone does those pushes in ~0.26 us per event;
        a Python `push` call adds ~0.3 us (argument reading, the lock,
        the result list), found with callgrind and trimmed from ~0.55 us
        (float fast path, list fast path, no-release lock, empty-output
        early return, lazy row labels in `push_many`).
    - P3: wheels in CI (Linux x86 + ARM manylinux2014, macOS, Windows),
      PyPI `pond-rs` on `v*`, docs Python tab, agent trial vs polars and
      pandas.
  - J1 built (2026-10-30, `crates/pond-wasm` + `packages/rs`, private
    until J3). Shape: pond-ts's method names and argument shapes in JS; each
    call sends the method name and its arguments as JSON (`{"series": id}`
    for another series, `{"sequence": …}` for a `Sequence`, `{"f64": …}` for
    -0 / NaN / infinities) to one Rust dispatcher (`dispatch.rs`, ported
    from `core_parity.rs`'s runner, errors returned not panicked). Series
    live in a Rust table addressed by number; `free()` plus a finalizer.
    Chosen over one wasm-bindgen export per method: one place to keep in
    step with pond-ts, and the core parity fixture runs through the public
    JS API unchanged. Check: 1,159 of 1,159 core parity cases match through
    JS (`node packages/rs/test/parity.mjs`, CI job `js-bridge`), 0 series
    left after freeing; 71 callback cases (`filter`, `mapColumns`, `scan`,
    `collapse`, `asInterval` with a function) wait for J1b with row lookups
    and `Time.parse`. An error case matches any pond-rs error but not a JS
    `TypeError` or the dispatcher refusing an argument (six listed cases
    aside); review of #859 found such a slip hiding a `mapColumns` case.
    `test/inputs.mjs` pins what the fixture misses: the constructor's cell
    checks (pond-ts's messages), -0 as a whole number, empty lists. Size
    6.2 MB raw, 1.12 MB brotli before `wasm-opt` and the size cuts (J2).
  - J1b built (2026-10-30, PR pending Peter's OK as new API): functions,
    row lookups, `Time.parse`. A function argument crosses as `{"fn": k}`,
    the k-th entry of a JS array passed beside the JSON; Rust calls it back
    through one trait (`callbacks.rs`), so the dispatcher stays testable
    without JS. pond-rs closures cannot fail, so the first exception is
    kept, the remaining rows skip the function, and the call rethrows that
    same exception object. The input series is cloned out of the table
    first, so a function may call the bridge. Where pond-ts does not check a
    function's result, the bridge copies it: a result of the wrong type is a
    gap (`mapColumns`, `collapse`, `scan` output), and `scan` reads
    `result[0]` / `result[1]` of anything but null / undefined. New JS
    classes, cut-down versions of pond-ts's: `Event` (lookup and test
    results), `Time`, `TimeRange`, `Interval`. Also changed: the constructor now refuses
    `null` cells (pond-ts does; `fromJSON` still reads them as gaps). Check:
    all 1,230 core cases, 2,907 row lookups and 1,332 time texts match
    through JS; `test/inputs.mjs` passes against pond-ts itself too (one
    listed line aside: `joinMany([])`).
  - Found by both probes, handed to the live speed review: pond-rs live
    filter + aggregate over 1M one-at-a-time pushes took 230-256 ms from
    Rust; a hand-written Python dict took 110-132 ms.

- Threading: done in R1a step 4 (per output column). If R1b needs one
  column split across threads, reductions must still give the same bits as
  one thread (fixed chunks, ordered combine).
