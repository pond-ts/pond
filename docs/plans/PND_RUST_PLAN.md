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
       windows, a minimum sample count, rolling over a time grid. pond-rs
       only does trailing time windows.
     - **8h Smoothing and stats:** `smooth` (EMA, moving average, loess),
       `baseline`, `outliers`, `scan` (a custom running step, a Rust
       closure), `sample`. (`reduce` done in 7b.)
     - **8i Grouping and reshaping:** `pivot_by_group`, `by_column` and
       `rolling_by_column` (histograms), `by_value` and `ValueSeries`,
       `collapse`, `concat`.
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
    `rolling`: pond-ts keeps the window sorted (a splice per row, O(W) per
    row for a window of W rows) and answers last minus first. pond-rs uses
    two monotone deques (O(1) per row) plus a stack of zero signs, because
    pond-ts's sorted window gives a sign-dependent answer in one case: a
    window of only zeros, where it can give `-0`. A unit test checks the
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
    cells by their elements where pond-ts compares the array objects, so
    two equal arrays keep their value here and give a gap there
    ([PND-ARRAYKEY]); `array_aggregate` with `keep` takes the elements'
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
    5 minutes (25 ms for `difference`); pond-ts's rolling `difference`
    takes 376 ms at 5 minutes, 4.2 s at 1 hour and 96 s at 1 day
    ([PND-ROLLDIFF]). pond-rs's rolling `median` and percentiles keep the
    sorted window, as pond-ts's do; a faster structure for those is not
    part of this step.

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

- Threading: done in R1a step 4 (per output column). If R1b needs one
  column split across threads, reductions must still give the same bits as
  one thread (fixed chunks, ordered combine).
