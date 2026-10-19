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
     - **3b** `filter`, `slice`, `with_column`, `map` (Rust closures).

  4. **Groups:**
     - `partition_by` (one or more columns), with per-partition `rolling` /
       `aggregate` / `fill` / step-3 operations, and `collect`.
     - `group_by`.

     Partitions run on several cores with the same bits as one. This is the
     agent-workload pitch ([PND-AGENTBENCH] Q11: 500 symbols × 1000 bars).

  5. **Grid operations:** `align`, `materialize`, `dedupe`.
  6. **`join`.**
  7. **The rest, as friction asks for it:**
     - Queries (`at`, `bisect`, `nearest`, …) and range selection (`within`,
       `trim`, …).
     - `reduce`, `by_column`, `smooth`, `baseline` / `outliers`,
       `pivot_by_group`, `collapse`, `sample`, `scan`.
     - Array columns.

     Some of these may never be needed. They are not built until there is a
     reason to.

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

- Threading: done in R1a step 4 (per output column). If R1b needs one
  column split across threads, reductions must still give the same bits as
  one thread (fixed chunks, ordered combine).
