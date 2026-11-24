# PND_RUST_PLAN — pond-rs, a native Rust core

> **Frozen 2026-11-24.** Open tasks from this plan moved to Linear (project map in
> [PLAN.md](../../PLAN.md); old IDs → issues in
> [linear-migration.md](../archive/linear-migration.md)). Each issue carries its
> task's write-up from here and keeps the `[PND-…]` tag in its title. This file
> stays as the reasoning behind shipped work. Do not add tasks or outcomes here.

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
  (2026-11-13: of the later [PND-ERRMSG] items, only the `cumulative` one
  is fixed: since #906 `cumulative({ a: 'avg' })` names the unknown
  accumulator, so that item left the PLAN.md entry. The rest still
  reproduce on main.)

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
   optional). pond-ts had the opposite problem: [PND-ARROWREQ] (fixed in
   #942; `toArrow` now also gives each field's nullable flag, [PND-TOARROWREQ]).
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

## Cross-library comparison, all steps re-run (2026-10-21)

Every speed table from R1a and R1b steps 2a–8i4 re-run in one session on one
machine (3 repeats each), with polars added where it has a matching call:
[`crates/pond-rs/bench/COMPARISON.md`](../../crates/pond-rs/bench/COMPARISON.md).
Outcome: pond-rs is faster than pond-ts in 171 of 174 cases (median 5.7×;
slower on the 1M × 1M outer join and wide-table JSON in); against polars it
is about even overall (faster in 61 cases, slower in 64 on 4 cores). The
R1a "≥2× pond-ts single-core" target holds on A but not on B's compute
(1.8×; 2.2× on total time). R1a A is now a tie with polars on 4 cores
(compute 128–139 vs 134–166 ms) rather than a pond-rs lead. Two earlier
numbers did not reproduce: pond-ts `shift` / `fill` (fixed since, #776) and
pond-rs `from_json` dense (45 ms in step 8d2's table; 75–91 ms at that
step's own commit on this machine, so not a regression).

**Revised 2026-10-22 after a Codex review** found polars runners doing
different work or giving different answers (gap handling in cumulative
sum, an off-by-one centred window, a missing reducer, dropped buckets, tie
rules, missing time / interval columns, different JSON formats). Every
pond-rs and polars runner now writes each case's answer (`BENCH_DUMP`) and
`bench/check_outputs.py` / `check_all.sh` compare them cell by cell; all
147 compared cases match. Polars cases were added where polars has a
counterpart the first run missed (leading / centred time windows, minimum
row counts, rolling list reducers). Re-timed on main with #811: pond-rs vs
pond-ts faster in 170 of 173 (median 7.5×); vs polars on 4 cores faster in
73, slower in 59, same in 9 (median 1.08). R1a A compute 117–120 vs polars
142–177 ms on 4 cores; B's ≥2× single-core target still missed (1.9×).
Decision: an answer check is now part of the benchmark, so a polars
"equivalent" that is not equivalent fails rather than reads as a number.

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
[PND-RUSTRFC] had nothing else open, so it left PLAN.md on 2026-11-13.

**First publish done.** crates.io lists `pond-rs` 0.1.0, created 2026-10-29
(checked 2026-11-13), and the docs pages install it as `pond-rs = "0.1"`.
`release-rs.yml` uses the `CARGO_REGISTRY_TOKEN` secret while it is set and
crates.io trusted publishing (OIDC) once it is gone. Left on PLAN.md: set up
trusted publishing for the crate on crates.io and delete the secret. Neither
can be seen from the repo, so check crates.io before closing it.

**0.2.0 (2026-11-23, Peter's go).** crates.io still had only 0.1.0 while
main had gained column expressions, `push_series`, `OutputKind::Columns`,
cumulative thresholds and the November speedups. A minor bump because
`cumulative`'s signature changed (pre-1.0, a minor may change the API).
Install lines in the docs moved to `"0.2"`.

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

## [PND-RUSTCOLS] — `OutputKind::Columns` (2026-11-05)

Peter asked for the pond-rs counterpart of pond-ts `live.on('columns')`
([PND-COLOUT], PR #908) the same day it was built.

- **Shape.** New `OutputKind::Columns` / `Output::Columns { node, series }`
  on a series (root or partition): a batch `TimeSeries` of the rows one push
  added, in key order, after `Batch` and before `Evict` (pond-ts's order).
  Not in the bridges' default `watch()` set, since it costs a table per push.
- **No event per row.** The root's "bare" path (no node, nothing watched)
  stays bare when only `Columns` is watched: the batch is read off the end
  of the stored columns (`EventBuffer::snapshot_rows`). A `reorder` push
  with a late row would place it among older rows, so that push (only)
  builds events, as do pushes with anything else watched; the batch is then
  built from the added events, stable-sorted by key (pond-ts's
  `TimeSeries.fromEvents`). Partitions build theirs from their added events.
- **Cost.** Building the batch is ~15 allocations a push (names, key, one
  buffer or more per column), and a `LiveEvent` is cheap in Rust, so the
  win needs between 10 and 100 rows a push. `examples/perf_live.rs`, 1M rows, reader
  sums `cpu`: 1,000 a push `Batch` 296 / `Columns` 232 ms; 100: 280 / 243;
  10: 318 / 332; 1: 413 / 861 (bare push, nothing watched: 193 ms). A
  sized string builder did not help (allocation count, not the builder).
  Python 200k rows, 1,000 a push: 92 → 61 ms.
- **Parity.** Fixture gained case- and node-level `watch: [kinds]`, and 8
  `columns` cases (strict, drop, reorder with late rows, interval keys,
  tags, a view built after, partitions strict + reorder): Rust, JS bridge
  and Python all 79/79.
- **Semver.** `Output` and `OutputKind` are not `#[non_exhaustive]`, so a
  new variant breaks exhaustive matches: the next pond-rs release is 0.2.0.

## [PND-RUSTDOCS] — pond-rs pages on the docs site

Moved here from PLAN.md on 2026-11-13; PLAN.md keeps only what is open
(run the snippet check in CI, and keep the pages in step).

- **Pages.** `website/docs/pond-rs/` (since 2026-11-23 `website/docs/rust/`), added 2026-10-19, covering R1a, R1b
  steps 1–6, 7a, 7b and 8a–8j (8d2, 8e2, 8f2, 8i2–8i4 included), R2 steps 1,
  2a–2g, 3 and 4 (the finance studies page) and R3 steps 2–7 (the live
  series page).
- **Every Rust example is a whole program** checked by
  `website/scripts/check-rust-snippets.sh`, which now covers every docs
  page, not only `pond-rs/`. `rust ignore` fences (excerpts from other
  repos) are skipped. Not yet run in CI.
- **Rust beside TypeScript** (Peter, 2026-10-29): TypeScript / Rust tabs
  (`groupId="language"`) on the introduction, getting started and financial
  overview, an "also in Rust" note on the core overview pages, and process
  marked TypeScript only (#850). Then 158 more tabs on the per-operator core
  pages (`pond-ts/creating`, `value-series`, `transforms/*`, `live/*`): 252
  snippets in all, each checked against pond-ts output.
- **crates.io.** Install lines say `pond-rs = "0.1"` and the Rust pages link
  docs.rs; all 252 snippets also pass against the published 0.1.0.
- **Expressions page** (`pond-ts/transforms/expressions`, 2026-10-31):
  `col` / `lit` / `when` with TypeScript, Rust and Python tabs, all checked
  against pond-ts.
- **Python beside Rust** (Peter, 2026-11-22): a Python tab (`import pond`)
  on every tabbed example across 23 pages, 178 runnable scripts with asserts
  mirroring the Rust ones. `website/scripts/check-python-snippets.py` runs
  each in a fresh interpreter, and CI's `python` job runs it against the
  wheel it just built, on 3.9 and 3.13. `fit/` pages are excluded: their
  blocks build on each other, and `check-fit-guides.mts` checks their Python
  only by hand (CI runs it with `--no-python`). Where the Python bridge
  lacks a call the page says so rather than working around it:
  no `apply` on a partitioned series (chain steps, then `collect()`), no
  `ValueSeries.read_ipc` (read with pyarrow, then `from_arrow`), no batch
  custom-fold `cumulative` (use `scan`), no live `at_or_before` (use
  `to_series()`).

## Docs for every language (2026-11-23)

Peter (2026-11-23): "The docs now need a new top level structure, where
someone coming from rust or python feels like the library isn't an after
thought for them." Proposal reviewed in a Claude Doc; Peter's answers:
**move the addresses** (not only the sidebar), **processing graphs are first
class in TypeScript and Rust**, and **Python needs its own API reference**.

- **Structure (PR 1).** The sidebar is by task, not by package: Start here
  (introduction, a new "Choose your language" page, getting started), Your
  language (a front door each for TypeScript, Rust, Python and JavaScript
  with WebAssembly), Concepts, Working with series, Live data, Finance
  studies, Processing graphs, then Charts / React hooks / Fitness files
  marked "(TypeScript)". Pages moved: `pond-ts/concepts` and `mental-model`
  to `concepts/`; `pond-ts/transforms/*`, `creating`, `value-series`,
  `advanced/*` to `series/`; `pond-ts/live/*` to `live/`; `pond-rs/*` to
  `rust/`; `pond-rs/python` split into six pages under `python/`;
  `pond-rs/javascript` to `javascript/`; `financial/` to `finance/`. The
  shared pages left `pond-ts/` because a Rust or Python reader seeing
  `/docs/pond-ts/...` in the address bar is still a guest. Every old address
  redirects (`docusaurus.config.ts`), checked against the full route list of
  the build before the move. The llms.txt area keys (`pond-ts`, `pond-rs`,
  `financial`) are kept, so the `llms-<key>.txt` dump URLs agents use don't
  change; only their titles and matched folders did.
- **Not done in PR 1, on purpose.** The Rust-only "Operations" and "Live
  series" tours overlap the shared tabbed pages; merging them is content
  work, not structure. The pond-rs Roadmap section was left alone (another
  thread rewrites it).
- **[PND-PYAPIDOCS] Python API reference (PR 2, done).** Ten pages under
  `website/docs/python/api/`, written by `website/scripts/gen-python-api.py`.
  Signatures come from `crates/pond-py/pond.pyi` (what an editor shows);
  descriptions from its docstrings, or, where it has none, from the
  docstrings the compiled package carries (the `///` comments in the PyO3
  source). Considered and not done: Sphinx / pdoc (another toolchain and a
  second site look), or copying the runtime docstrings into `pond.pyi`
  (would make the stub hand-maintained text twice over). The check runs in
  CI's `python` job against the wheel it builds (`--check`), so a changed
  method fails CI until the pages are regenerated; the output is identical
  on Python 3.9 and 3.13. The pages are in `.prettierignore` because the
  check compares bytes.
- **[PND-PROCRUSTDOCS] Processing graphs in Rust (PR 3, done).** The
  process pages now cover `pond-process` beside `@pond-ts/process`: the
  overview is retitled "Processing graphs", opens with a TypeScript and a
  Rust tab, gives the Rust install (a git dependency, since the crate is
  `publish = false`) and a table of what each language has (taken from the
  R5 scope: no builder, joins, `runRange`, live graph, `toJsonSchema` or
  pool in Rust; threads instead). Registry, requests, host and plans have
  Rust tabs on their main examples, each a whole program with asserts,
  compiled and run by `check-rust-snippets.sh` (which now also depends on
  `pond-process` from the same checkout). Performance gets the R5 step 7
  table. Authoring and the tutorial say they are TypeScript only and point
  at the Rust tabs. Considered and not done: a separate Rust page for
  processing graphs (would make Rust the side room again), and Rust tabs
  on every tutorial step (the tutorial is about the fluent builder, which
  Rust does not have). Left: the Rust snippet check is still not in CI
  ([PND-RUSTDOCS]); the pond-rs Roadmap line "`@pond-ts/process` stays
  TypeScript only" belongs to the thread rewriting that section.
- **[PND-CONCEPTTABS] Concepts in every language (PR 4, done).** Found by
  the #964 review: the Concepts pages, which the new sidebar calls the
  ideas every language shares, had TypeScript examples only. All 37
  examples on the ten pages now have Rust and Python tabs (whole programs
  with asserts, run by both snippet scripts). Where an idea has no Rust or
  Python form yet the page says "TypeScript only" (TimeZone,
  BoundedSequence, `Sequence.kind`, the hourly/daily aliases, `head` /
  `tail` by count). Mental model now explains that TypeScript checks
  columns when the code is compiled and Rust/Python when it runs, instead
  of leaning on `as const`. Left: three series pages, [PND-SERIESTABS].

## [PND-RUST-R5] — a Rust port of `@pond-ts/process`

Adopted by pjm17971 on 2026-11-17. R3 left this open ("a process port
becomes its own phase").

**Why.** A consumer's desktop app runs a local MCP server whose engine is
`@pond-ts/process` (one long-lived `Host`, slot requests, facts back). Today
the engine has to run in the app's web page. A Rust engine lets the app's
own Rust process answer, with the page closed, and fetch its data itself.
Speed is not the reason: that consumer caps a question at 2,520 daily bars
and measures about 20 ms per question in TypeScript.

**What exists.** pond-rs has the maths and none of the engine. The engine is
~6,000 lines (`packages/process/src/plan/`). Its basic ops and folds are
small loops over a number column, not calls into pond-ts analytics, so they
port directly. The studies come through the pond-rs catalog
(`StudyDescriptor::run`). Ids are text, not hashes (`p1:sma(close;period=20)`),
so the Rust engine can mint the same ids and share a cache key with
TypeScript.

**Decisions (pjm17971, 2026-11-17).**

1. **Scope: the first consumer's subset.** In: `Host` (datasets, byte budget,
   async sources with revisions, `maxSources`), registry with param checks
   and `describe()`, `specId` / `explain` / units, slot and nested requests
   under every error policy, `toWire`, the basic ops, the standard and
   summary folds, the bridged studies, and ops defined by the consumer in
   Rust. Out for now: joins, the worker pool, the fluent / builder authoring
   APIs, the live graph (`Graph` / `Node` / `fromLive`), ranged recompute
   (`runRange`, always optional), `toJsonSchema`, and Python / WASM bindings
   for the process layer.
2. **Port against process as it is, with a drift guard.** Process keeps
   changing in TypeScript first (PND-PROCFIN has 16 tasks queued).
   `packages/process/test/fixtures/parity.json` records what the TypeScript
   engine answers, and `test/parity-fixture.test.ts` fails when it goes
   stale, the same guard R0 built for core. The Rust tests read that file,
   so a TypeScript change that the port has not followed turns the Rust CI
   red rather than drifting.
3. **Pointwise basic ops in pond, not consumer ops in Rust.** The consumer
   has four steps of its own (a realized vol, a difference, a ratio, a log
   ratio). Rather than the consumer keeping Rust copies, pond adds the
   missing pointwise basics (`log`, `sqrt`, a ratio that gaps on a zero
   denominator) to `BASIC_OPS` in both languages, so those become
   compositions.
4. Where the data comes from is the consumer's call (it fetches from Rust).

**Steps.** Each follows the R1b rules: parity cases checked exactly, property
tests where an answer is easy to compute independently, the CLAUDE.md
performance check for anything that walks rows.

1. Parity fixture and drift guard (TypeScript side).
2. Ids, registry, param checks and `describe()`.
3. The ops: basic ops, the standard and summary folds, the studies, the new
   pointwise basics.
4. Graph, run, slots, error policies, `toWire`.
5. The `Host`: long-lived graphs, byte budget, sources with revisions,
   `maxSources`.
6. Ops defined by a consumer in Rust.
7. Measure TypeScript against Rust at the consumer's sizes and at 1M rows,
   then an agent trial against the Rust host.

### R5 step 1 — parity fixture (DONE)

`packages/process/scripts/parity/cases.mjs` builds, and `generate.mjs`
writes, `packages/process/test/fixtures/parity.json`:

- **Inputs** as pond JSON: 60 daily bars with gaps (two variants, for a
  data refresh), 48 five-minute bars (timestamps print as instants, not
  dates), a 12-row gappy series with an all-gap column, and an empty one.
- **Ids**: 23 specs, each named strictly and leniently (`validate: false`),
  with its explanation: defaults, key order, JavaScript number spelling
  (`1e-7`, `-0`, `1e+21`), escaped separators, picked outputs, nesting, and
  every malformed shape the lenient namer encodes.
- **`describe()`** of the standard registry and of the full one.
- **Source ids** with characters that need URL encoding.
- **Eight host sessions** (seven at first; the eighth came from the step 2–5
  review, below), each a sequence of `add` / `run` / `runAsync` /
  `remove` / `has` / `datasets` steps with every response recorded (node
  `ms` dropped, columns as numbers with `null` gaps): every basic op and
  fold on one plan, the same plan warm, columns and picked outputs, new
  data under a warm graph; nested plans with inline and id-string
  selectors; failures under `collect`, `skip` and `throw`
  (unknown ops, each param error, arity, units, unknown columns, folds as
  inputs, op code that throws or returns the wrong length, slot errors —
  including F-charts-39, where one bad slot refuses the whole request); a
  byte budget evicting least-recently-used nodes; folds over intraday,
  gappy and empty series; async sources across revisions, key order and
  the source cap; the standard registry alone.
- **Five fixture-only ops** (`picky`, which fails with a coded
  `ParamError`, came with the eighth session; `annualise` with a typed input, a three-output
  `band`, `boom` which throws, `short` which returns one row too few). The
  Rust harness defines the same four through its own op API, so the
  fixture also tests that API (step 6).

Checked: changing one fact value in the committed file fails the test.

### R5 step 2 — ids, registry, param checks, describe (DONE)

New crate `crates/pond-process` (`publish = false` until the port is
complete and a crates.io name is chosen). It holds:

- `Registry` with `define` (same definition-time checks and messages as
  `registry.ts`), `get`, `resolve_params` (strict and lenient),
  `check_arity` and `describe`.
- `Def` / `ParamDef` builders, and the definitions (with lineage labels) of
  the standard folds, the basic ops and the summary folds. What each op
  computes is step 3.
- `spec_id` (strict and lenient), `explain`, `output_key`, `source_id`.
- `js.rs`: the JavaScript text rules ids and messages depend on —
  `String(v)`, `typeof`, `JSON.stringify`, `encodeURIComponent`, and
  UTF-16 key order. Numbers go through pond-rs's `js_number`, made public
  for this.

`tests/parity.rs` reads the fixture: all 23 id cases (strict id or error
code and message, lenient id, lineage text), `describe()` of both
registries (compared as JSON values, not text), and the source ids. The
fixture's four ops are defined in the test with the crate's own builders.

### R5 steps 3 (part), 4 and 5 — ops, run engine, host (DONE)

What landed:

- **Ops and folds** (`basic_ops.rs`, `folds.rs`, `summary_folds.rs`): the
  code behind every basic op, standard fold and summary fold. `shape`
  bins reuse pond-rs's reducers through `Reducer::reduce`, made public for
  this. `percentile` ports the TypeScript quickselect, including its
  fallback, so ties and gaps pick the same value.
- **Graph** (`graph.rs`): compile with the warm re-check, unit checks,
  dirty marking by data generation, cached failures (a node that threw
  keeps throwing until the data changes), the per-graph byte budget with
  least-recently-used eviction that skips nodes something depends on.
- **Run** (`run.rs`) and **slots** (`slots.rs`): nested and slot requests,
  `throw` / `skip` / `collect`, selectors by spec or by id string, picked
  outputs, facts, lineage, node timing, `to_wire`.
- **Host** (`host.rs`): `add` / `has` / `remove` / `datasets` /
  `graph_for` / `run`, and `run_async` with a `SourceRegistry` of async
  loaders, revisions and the `max_sources` cap.

`tests/parity.rs` replays all eight fixture sessions through the Rust host
and compares every response with the TypeScript one as text, so key order
counts too (numbers are compared as numbers first, since JavaScript has one
number type). All match.

The review (PR #938) found two orders the first seven sessions could not
see, both now fixed and covered by an eighth session:

- **Integer-like names come first.** `Object.keys` lists keys such as `"2"`
  and `"10"` first and ascending, whatever order they were written in. That
  decides slot order, output order and the "slots are …" message.
- **Slots come back in the order they finish.** `expandSlots` returns its
  map of finished slots, so a slot comes after the slots it reads.

It also found malformed requests (no `process`, `nodes` not an object, a
slot with no `in`) quietly succeeding. TypeScript fails those with the
engine's own `TypeError`, which has no code. Rust now fails them with no
code too, with its own message, and under the same error policy:
the nested form fails whatever `onError` says. Op and fold code now returns
a `ProcessError`, so a custom op can fail with a code as a TypeScript op
can throw `ParamError`.

Differences from TypeScript, on purpose:

- **No widened series.** TypeScript's `assemble` appends the asked-for
  columns to a copy of the input series for a chart. The Rust result
  carries the columns (`RunResult::columns`) and no series; the first
  consumer reads facts. `hasSeries` is true when columns were asked for,
  which is what `toWire` reports on the requests a wire carries.
- **No shared in-flight loads.** TypeScript shares one load between
  concurrent `runAsync` calls for the same source, and a `remove` during a
  load discards that load. `Host::run_async` takes `&mut self`, so two
  calls cannot overlap and neither case can arise. A host shared across
  threads would need both back.

Not ported yet (scope decision 1): joins, ranged recompute
(`setSourceFrom` / `runRange`), the live graph, the worker pool and the
authoring APIs.

The performance check is step 7.

### R5 step 6 — custom ops and lookbacks (DONE)

A consumer could already define its own op in Rust (`Def::op` with params,
inputs, outputs, a label and a `run` closure; the parity fixture's five
fixture ops are defined that way). What was missing was the lookback:
`Def::lookback(|params| rows)` now declares how many rows of history an op
needs, and `required_history(registry, plan)` ports `requiredHistory`.
Lookbacks add along a chain and take the largest across inputs and specs;
an op with no lookback makes the answer unknown with the op named, never
zero. The basic ops declare the same lookbacks as TypeScript (0, `shift`
its positive `periods`, `cumulative` and `hold` none). The studies declare
none, as the TypeScript bridge does.

The fixture gains twelve `requiredHistory` plans (chains, branches, a
picked output under a fold, undeclared ops in a known order, an empty
plan, an unknown op, a bad param); `tests/parity.rs` matches them as text,
`byOp`'s order included, and checks the message for a negative, NaN or
infinite lookback.

Decision 4 (Peter, 2026-11-21): the consumer's Rust side signs in and
fetches its own data, so it works with the window closed. That is the
host's `SourceRegistry` and `run_async` (step 5); pond needs nothing new.

### R5 step 3 (end) — `log` and `sqrt` (DONE)

Scope decision 3 asked pond for the pointwise basics a consumer's own ops
need: `log`, `sqrt` and a ratio that gaps on a zero denominator. The ratio
was already there: `divide` writes `x / 0` as ±Infinity and `0 / 0` as NaN,
and both are gaps. So two steps were added to `BASIC_OPS` in TypeScript and
Rust: `log` (natural log; zero or below is a gap, unit `log`) and `sqrt`
(below zero is a gap, unit `sqrt`). Neither keeps its input's unit: the
review of #945 pointed out that an inherited `variance` would let an op
demanding a variance accept the root of one.

How the consumer's four ops compose from them:

- `diff` is `subtract`; `ratio` is `divide`, with the same gaps.
- `realizedVol` (√(var·252)·100) is `scale(sqrt(scale(var, 252)), 100)`,
  the same arithmetic in the same order, so the same bits.
- `logRatio` is `log(divide(a, b))`, the same bits where both legs are
  positive. One difference: where both legs are negative the ratio is
  positive, so the composition gives a number where the consumer's op
  gives a gap. Prices are positive, so it does not arise on prices.

Rust's `log` uses pond-rs's `js_log` (now public), V8's fdlibm routine,
because the system `ln` is one bit off on about 2% of inputs. The kitchen
session's 57 log cells happen to include none of those, so
`tests/parity.rs` also checks three inputs where the two differ.

### R5 step 3 (part) — the studies as ops (DONE)

`crates/pond-process/src/studies.rs` ports `@pond-ts/financial/process`:
`study_ops()` turns every study in pond-rs's catalog into an op by the
bridge's own rules (column inputs become roles, a param with no default
takes its `example`, `optional` params and the params that `requires` them
are dropped, outputs are named by the spec id, a bare suffix on a
multi-output study becomes `"value"`). `UNBRIDGED_STUDIES` is the same list
with the same reasons. The op runs the catalog study itself
(`StudyDescriptor::run`), so the maths is the code pond-rs's own study
parity already checks bit for bit.

The check is a second fixture, written by TypeScript:
`packages/financial/scripts/parity/process.mjs` builds
`test/fixtures/process-parity.json` (from `generate.mjs`, with a drift test
`test/process-parity.test.ts`). It holds the `describe()` of the standard
folds plus all 103 study ops, the unbridged list, and 109 runs: every study
once with its defaults over 800 daily bars with a gap in `close` and one in
`volume`, four with other params, and two the registry must refuse
(`period: 0`, `period: 2.5`). 800 bars is past every warm-up (`specialK`
needs 724), so every output column has numbers in it except zigZag's
default run, since the bars never swing 5%; a 1% run covers it, and the
test fails if any other column comes back empty. `tests/studies.rs` checks every `describe()`
entry, every id or refusal and every response, columns included, exactly
(a change of 1e-12 in one cell fails it), and `describe()` as text, so the
order of params counts. All match.

Left out, on purpose: the session studies (two in the catalog), which take
a trading calendar through `studyOps({ sessions })`. The Rust bridge has
no way to be handed one yet; `study_op` refuses them by name.

### R5 step 7 (first half) — measured against TypeScript (DONE)

`packages/financial/scripts/measure/run.mjs` runs the same process request
on both sides and checks the facts come back identical as text. Two
workloads (`workloads.mjs`, the same seeded generator in JS and in
`examples/measure.rs`): daily market bars (30 slots, 15 outputs: studies,
basic steps, folds) and 1-second telemetry (cpu, memory, latency,
requests, errors; 27 slots, 16 outputs). The telemetry sizes are there
because telemetry was named as the workload where data gets an order of
magnitude bigger (Peter, 2026-11-21). Times are the first run on a fresh
host, median of 7, 5 or 3 runs; a 4-core cloud machine.

| Data | TypeScript | Rust, 1 thread | Rust, 4 threads |
|---|---|---|---|
| market, 2,520 rows | 8.4 ms | 1.2 ms | 1.4 ms (one thread: under `PARALLEL_MIN_ROWS`) |
| market, 1M rows | 599 ms | 207 ms | 91 ms |
| telemetry, 1M rows | 451 ms | 181 ms | 77 ms |
| telemetry, 10M rows | 5.4 s | 2.8 s | 1.06 s |

A repeat run of the same request costs about 1 ms on both sides (results
are kept). Peak memory at 10M rows: TypeScript 1.85 GB, Rust 1.65 GB.

What it took:

- **Reading columns in place.** The graph read each raw number column
  into a fresh `Vec<f64>` and copied the key for each study. It now reads
  a number column where it lies (`Raw::Column`) and a study's input series
  shares the source's key (`series.select(&[])`).
- **The first touch of new memory is most of what is left.** Writing
  80 MB into a fresh allocation took about 40 ms against 14 ms into memory
  already touched (measured directly). Each output column is fresh memory,
  so on one thread the gain shrank from 7× at 2,520 rows to 2× at 10M.
- **Parallel steps.** `Host::with_threads(n)` computes the steps that do
  not depend on each other at the same time: steps are grouped into waves
  by how deep they sit, and each wave runs on up to `n` scoped threads.
  Answers and timing entries (all but `ms`) match one thread. A step's
  `ms` is its own time while other steps share the machine, so under
  threads the `ms` values no longer add up to the run's time. The parity
  sessions and the study runs are checked on 1 and 4 threads. One
  difference: with `onError: "throw"`, steps that one thread would never
  have reached (because an earlier one threw) may already have been
  computed. The answer is the same error.
- **Short data stays on one thread.** Measured with the limit set to 0
  (so threads ran at every size): at 2,520 rows four threads were
  slower (2.5 ms vs 2.0 ms); they broke even at 10,000 rows and won from
  25,000 (4.5 vs 3.2 ms; 19 vs 9.6 ms at 100,000). `PARALLEL_MIN_ROWS` is
  10,000 and `with_parallel_min_rows` moves it.

### R5 step 7 (second half) — agent trial (DONE)

Ten fresh agents, five per engine, answered four questions about the
market bars by writing process requests, blind to which engine answered
(`crates/pond-process/bench/agent-trial/`, README there). All ten got all
four right: Rust 10 requests, none failed; TypeScript 11, one refused for
the agent's own slot name. Replaying all 21 distinct requests on both
engines found one difference, a TypeScript bug: a computed step feeding
both inputs of an op (`multiply(lr, lr)`) was appended twice and refused.
Fixed in `@pond-ts/process` with a parity session; after it, every request
answers identically. The docs gaps the agents hit are [PND-PROCAGENTDOCS].

With this, the R5 subset (steps 1 to 7) is done and [PND-RUST-R5] is off
PLAN.md. Left for later, as scoped: joins, ranged recompute, the worker
pool, the authoring builders, the live graph, `toJsonSchema`, and a
crates.io name for the crate.

## [PND-RSPARTMERGE] — putting partitions back together (2026-11-23)

Logged from the Python bridge benchmark (100-host rolling 428 ms vs polars
127): `collect` / `concat` of 100 partitions holding 1M rows took ~300 ms.

Outcome, measured on Peter's M1 (Linux VM, 4 cores), 1M rows, 100 hosts:

- **The rolling case was already fixed** by 1c4b3b8 (2026-11-22,
  per-entity number operations run in place): `collect` after a per-host
  rolling average is ~1 ms, the whole partition → rolling → collect 35 ms
  on one thread. Its remaining cost is the rolling itself (21 ms) and
  `partition_by` (12 ms).
- **The general merge was still a radix sort** (`merge_order`: three or
  four passes, each scattering every row into 65,536 buckets). It runs
  for `concat`, `apply`, and any partitioned step that makes new keys
  (`aggregate`, `align`, `rolling_over`, `materialize`, `dedupe`, …),
  where the result is merged once more and split again when a partition
  value changed. Now: every series is already in key order (checked when
  made), so the series are merged with a loser tree (tournament), about
  log2(series) comparisons per row, and the merged key's begins and ends
  are written during the merge instead of gathered afterwards. A series
  not in key order (none is expected) still takes the radix sort, so the
  result never depends on that.
- Timings, median of 9, old → new: `concat` of the 100 partitions 27.2 →
  19.8 ms (1 thread), 24.2 → 17.6 (4); per-host 1-minute `aggregate`
  (1.67M rows out) 124 → 92 ms (1 thread), 102 → 75 (4). Within the new
  `concat`: merge + key ~10 ms, column copies ~10 ms; within `aggregate`'s
  merge: ~31 ms + ~14 ms.
- Same bits: all pond-rs tests and parity pass, and hashes of every output
  bit (key + columns) match old vs new on 17 cases (concat both partition
  orders, per-host aggregate / align / rolling / apply; 50k–1M rows, 7 to
  1,000 partitions, times repeated across partitions).
- Not done: Python's `partition_by` measured ~60 ms on the cloud VM where
  the same call from Rust took 20–30 ms; not investigated.

## [PND-RSFILTER] — a faster filter (2026-11-23)

Asked for by pjm17971 after the six-engine suite (#961) ran on an M1:
"keep rows where v > 500" was the one case of sixteen where polars was
clearly ahead (pond-rs 7.1 ms, polars 2.2 ms; one core, 1M rows, with #960
already in).

**Read the follow-up below with this.** This section is #969 as it
merged. On two kinds of series its benchmark did not have (long or
non-ASCII text, and many number columns on one core) #969 was slower than
the code before it, and #971 took both back the same day: see
"[PND-RSFILTER] follow-up". The numbers here are right for the series they
name.

**Where the time went**, measured piece by piece on that M1, inside a
Linux VM (timings there repeat to a few percent; the cloud machine's moved
by a factor of two between runs). The series is a time key, a number column
with a gap every 17 rows, and a text column of 6-byte host names. 564,875
of 1,000,000 rows are kept, in stretches of about three.

| part                                           | before (ms) | after (ms)                     | polars 2.0.0 (ms) |
| ---------------------------------------------- | ----------- | ------------------------------ | ----------------- |
| the test `v > 500`, into a mask                | 0.84        | 0.21                           | 0.16              |
| list of kept row numbers (Arrow's filter plan) | 0.44        | none                           |                   |
| key                                            | 0.54        | 0.40                           | 0.34              |
| number column, and its scan for gaps           | 0.42        | 0.46                           | 0.37              |
| text column                                    | 1.90        | 0.93, and 0.64 (Arrow's check) | 0.58              |
| whole call                                     | 4.3         | 2.8                            | 1.9               |

The polars column is the same machine and data, each part timed on its own
from Python (`df["v"] > 500`, then `filter(mask)` on each column; median of
41, the middle of three runs). The text column is the difference: 1.57 ms
against 0.58. Without it the two are level: key and number only take 1.11
ms in pond-rs and 1.17 to 1.37 in polars; with no row kept 0.31 against 0.33
to 0.41; with 1% kept 0.54 against 0.81 to 0.98. (The parts were timed on
the first version of the rewrite, 6b5fa0c. The whole call is the same on
what merged.)

**What changed** (`src/row_filter.rs`, used by `filter` and `filter_expr`):

- The mask is plain 64-bit words and every copy reads it directly. No list
  of row numbers is built (array columns aside, which share their cells).
- The test: each row's answer is made into the row's own bit and the 64
  bits of a word are or-ed together, a loop the compiler runs on several
  values at a time. A gap (NaN, or an infinity standing for one) is ruled
  out by a second comparison (`x > k` and `x <= f64::MAX`) rather than a
  separate test for a finite value.
- Fixed-width values (times, numbers, decimals, dictionary keys) go eight
  rows at a time. A 256-row table gives, for each byte of the mask, the
  places of its kept rows; all eight values are written, kept rows first,
  and the output moves on by the number kept, so no branch depends on the
  mask. The table holds an eight-value enum, not numbers, so reading a
  group of eight at a place needs no bounds check. A word with 12 kept rows
  or fewer is walked bit by bit, a full word is one copy, an empty word is
  skipped.
- Text: a stretch of kept rows is one stretch of the source's bytes, so it
  is one copy. A short stretch is copied as a fixed 8 offsets and 64 bytes
  (the next stretch overwrites what overshoots), so no branch depends on
  its length. The byte total is counted first, eight rows at a time, or
  stretch by stretch when under one row in 16 is kept.
- True/false values, and the bitmaps that mark gaps: stretch by stretch.
- `filter` with a closure builds the same mask and copies the same way. It
  used to build row numbers and gather.
- A filter that keeps 131,072 rows or more copies the key and each column
  on a core of its own, when the pool has more than one thread. Handing the
  copies out costs about 0.1 ms whatever there is to copy: at 74,000 kept
  rows several cores were no faster, at 148,000 they were 13% faster. With
  `RAYON_NUM_THREADS=1` the pool is not used at all: `rayon::join` called
  from outside the pool hands the work to the pool's one thread and waits,
  which cost 0.1 to 0.4 ms.
- The scan that notes whether a new number column has a gap looks at 64
  values at a time, with no branch inside the 64. It used to go value by
  value. Every number column pond-rs builds gets this scan, so it shows
  outside `filter` too (see "The rest of the suite").
- The three lookup tables are each held at the start of a 64-byte cache
  line (see "Two builds of the same code").

**Same answers.** Each copy is held to Arrow's `filter` kernel, value for
value: over masks of every shape the copies branch on, lengths around the
64-row words, sliced inputs, and text with empty, long and multi-byte
strings. The series-level test compares with the row-number path for every
column kind and key kind, on one core and on several, and pins each number
column's "no gaps" note. Of 34 mistakes planted in what merged, 33 fail a
test; the 34th is not a mistake (the two ways of counting text bytes must
agree).

One corner differs from before, in how an empty result is held, not in
what it holds. When no row is kept, a dictionary text column comes back
with an empty dictionary, which is what Arrow's `filter` gives and what
`filter_expr` gave before. `filter` with a closure used to gather by row
number, which kept the source's whole list of strings behind its zero
keys; it now gives the same as `filter_expr`. Either way the result has no
rows, is still a dictionary column, and stacks with the series it came
from (`nothing_kept_gives_an_empty_series_that_still_stacks`).

**Measured** on the M1 (Linux VM, 1M rows, `v > 500` unless said, ms;
`examples/perf_filter.rs`, the median of five runs of it). Before is the
same on one core or four. Built with Rust 1.97; built with 1.100, which CI
uses, every case is within 0.06 ms of these (arrays within 0.14).

| case                                           | before | one core | four cores |
| ---------------------------------------------- | ------ | -------- | ---------- |
| key, number, text; 56% kept (the suite's case) | 4.35   | 2.84     | 2.29       |
| the same, no row kept (the test alone)         | 1.42   | 0.27     | 0.28       |
| the same, 1% kept                              | 1.62   | 0.54     | 0.54       |
| the same, 93% kept                             | 3.86   | 3.23     | 2.72       |
| the same, 50% kept in stretches of 1,000       | 3.86   | 1.66     | 1.72       |
| key and number only                            | 2.34   | 1.12     | 0.92       |
| with a number column that has no gaps          | 2.62   | 1.52     | 1.07       |
| with text held as a dictionary                 | 2.58   | 1.74     | 1.10       |
| with true/false values and gaps                | 4.78   | 2.06     | 1.39       |
| with decimals and gaps                         | 4.07   | 2.17     | 1.86       |
| with an array column (copied by row number)    | 9.93   | 9.29     | 8.76       |
| `filter` with a closure (key, number, text)    | 5.06   | 3.89     | 3.39       |

**The rest of the suite** (`examples/suite.rs`, all sixteen cases, one
core, median of 7 rounds, before and after built with the same Rust). The
filter case went from 4.26 to 2.78 ms (4.25 to 2.26 on four cores). Six
other cases gained 0.22 to 0.26 ms each: `fill` (1.58 to 1.32),
`cumulative` sum (3.75 to 3.51) and four of the rolling cases (13.46 to
13.24, 13.47 to 13.25, 16.49 to 16.26, 59.74 to 59.52). They are the six
whose result is a 1M-row number column with no gaps (checked by printing
each result's "no gaps" note), so the scan for gaps reads the whole
column; timed on its own, that scan went from 0.34 to 0.14 ms per 1M
values. The per-host rolling case also gained (27.20 to 26.64), which was
not looked into. Of the other eight, seven moved by under 2%; the left
join read 8.58 to 8.25, but its "before" runs ranged from 8.09 to 18.70.

**Two builds of the same code, 0.6 ms apart: a table across the end of a
memory page.** During review a second build of the same source ran two
cases 0.6 ms slower (93% kept 3.8 ms against 3.2; stretches of 1,000 2.3
against 1.7), and an earlier pair of builds differed by 0.2 ms on the test
alone (no row kept 0.49 ms against 0.30). The source was the same. What
differed was where the linker had put the lookup tables.

- Ruled out first, each by a measurement: the allocator (the same number
  of page faults, and still slow when freed memory was held on to); the
  filter's machine code (the same instructions ran fast inside three other
  test programs); where the code sat (three builds padded to move it
  stayed slow); where the stack sat; the number of rows.
- A sampling profile put all of the extra time in one function, the text
  copy: 1.75 ms against 1.11 at 93% kept, 1.08 against 0.47 at stretches
  of 1,000, and within it the loop that adds up the lengths of the kept
  strings. Every other function took the same time in both builds. (The VM
  refuses `perf`, so a small library loaded ahead of the program sampled
  where it was 10,000 times a second.)
- That loop reads, for each byte of the mask, a 32-byte row of a 256-row
  table. The table had no alignment of its own, and in the slow build it
  began 28 bytes into a 4 KB page, so the rows for the mask bytes `0x7f`
  and `0xff` lay across the end of a page. Those are the bytes for "seven
  or eight of eight kept": 68,334 of the 125,000 mask bytes at 93% kept,
  62,500 at stretches of 1,000, none at 56%, which was not slower. In the
  fast builds the rows across a page end were ones these cases seldom
  read. One more build had the rows for `0x00` and `0x80` there: it was
  slow on stretches of 1,000 (half of its bytes are `0x00`) and fast at
  93%, as that predicts.
- The 0.2 ms on the test loop was the same thing in the 64-entry table of
  single bits. The loop reads it 16 bytes at a time; in the slow build the
  table sat 8 bytes off a 16-byte boundary and across a page end, so one
  read in 32 lay across two pages: 15,625 such reads per 1M rows.
- The cost works out the same each way it was measured: 9 to 10 ns for
  each read that lies across two pages (0.68 ms over 68,334 reads, 0.58 ms
  over 62,500, 0.15 ms over 15,625, from the table below). A read that
  lies across two 64-byte cache lines but stays inside a page cost nothing
  that could be measured.
- Proof, by placing the tables on purpose (same source, Rust 1.97, three
  runs each, ms):

| build                                           | 93% kept     | 50% in stretches of 1,000 | no row kept  |
| ----------------------------------------------- | ------------ | ------------------------- | ------------ |
| tables on cache lines (what merged)             | 3.18 to 3.23 | 1.64 to 1.67              | 0.28 to 0.29 |
| text-length table put 4 bytes past a page start | 3.85 to 3.88 | 2.21 to 2.26              | 0.28         |
| bit table put across a page end                 | 3.38 to 3.39 | 1.78 to 1.85              | 0.43 to 0.44 |
| the slow build that started this                | 3.79 to 3.84 | 2.25 to 2.29              | 0.28         |

The fix is `#[repr(align(64))]` on the three tables: their rows are 8 or
32 bytes, so from the start of a cache line no row lies across a line, and
so none across a page. The addresses above are from a script that finds
the three tables in a built program by their contents, run over 18
builds. The first version's suite program had the bit table across a page
end as well, which accounts for about 0.16 of the 0.22 ms between it (3.03
ms) and what merged (2.81 ms in the same run). Not measured: the same
hazard on macOS itself (16 KB pages) or on x86.

**The bridges**, same machine and case, through the suite's own runners,
timed on the first version (6b5fa0c) and not again since: Python 7.0 → 3.0
ms on one core and 6.9 → 2.3 on four; `@pond-ts/wasm` 7.1 → 6.0. Polars
2.0.0 there takes 1.88 ms on one core and 1.5 on four.

**The allocator matters, and differently on each system.** The Python
bridge gained the most, and the reason was checked: its allocator is
mimalloc, and the suite's Rust runner built with mimalloc gives the Python
numbers.

| suite's Rust runner, one core (ms) | Linux VM, glibc | Linux VM, mimalloc | macOS, system | macOS, mimalloc |
| ---------------------------------- | --------------- | ------------------ | ------------- | --------------- |
| before                             | 4.3             | 7.0                | 7.0           | 5.5             |
| after                              | 2.8             | 3.0                | 3.8           | 2.8             |

In the Linux VM the old path was much slower under mimalloc and the new
one is about level. On macOS itself both are faster under mimalloc, the
new one by 1 ms. So the new path does not escape the allocator: it only
does in the VM. Which part of either path an allocator slows was not
pinned down on either system. (The VM's "after, mimalloc" is the first
version; its tables happened to sit clear of page ends. The macOS "before"
of 7.0 here and the 6.45 in the next table are two runs on a machine that
was busy both times; see below.)

**On macOS itself** (M1 Pro, macOS 15.7.7, Rust 1.97, the first version,
the suite's filter case, median of 7, ms). The machine was busy: Spotlight
was indexing the fresh checkouts and the load average fell from 84 to 19
during the run, so these are rough, and a quiet run is on PLAN.md.

| runner                                                  | one core | all ten cores |
| ------------------------------------------------------- | -------- | ------------- |
| pond-rs before                                          | 6.45     | 6.39          |
| pond-rs after                                           | 3.90     | 2.69          |
| pond-rs after, without Arrow's check of text (unmerged) | 2.77     | 1.99          |
| Python bridge before (median of 5)                      | 5.57     | 5.55          |
| Python bridge after (median of 5)                       | 2.79     | 2.17          |
| polars 1.36.1                                           | 2.11     | 1.76          |

Polars there is 1.36.1 because the Mac's own Python is 3.9; the suite's
earlier run had 2.1.0 (2.23 ms on one core, 1.06 on ten).

**Considered, not done.** The first two are owner decisions and are on
PLAN.md as [PND-RSFILTER].

- **Skip Arrow's check of the copied text.** Arrow's safe constructor
  re-checks what pond-rs hands it: offsets rise, the bytes are UTF-8, every
  offset is on a character boundary. That is 0.64 ms of the 2.8. Arrow's
  own filter skips the check with `unsafe`, and no safe way around it was
  found (builders, `MutableArrayData`, `take`, `concat`, `interleave`,
  `ArrayData` and a Binary-to-Utf8 cast were each tried or read). One was
  missed, and the follow-up uses it for rows in long stretches: a
  builder's `append_array`. pond-rs's `src` has no `unsafe` block today.
  Measured with the one block, on the first version: 2.75 → 2.07 ms on one
  core and 2.19 → 1.47 on four in the VM; 3.90 → 2.77 and 2.69 → 1.99 on
  macOS. A dictionary column has a check of the same kind (every kept key
  is inside the dictionary): 0.27 ms for the 565,000 keys, of the 1.74.
- **Text as 16-byte views** (Arrow's `Utf8View`, what polars holds; the
  branch `perf/pond-rs-text-views`, parked over its export cost). Filtering
  this column as views through Arrow's own kernel takes 0.43 to 0.55 ms,
  against 1.57 for plain text (0.93 without the check). That difference is
  what is left between pond-rs and polars on this case. Building a view
  array from pond-rs's own copy is no way round Arrow's kernel: its check
  of 565,000 views takes 2.7 ms. The cost that parked the branch is as it
  was: writing text pond-rs built out to Arrow copies it back (0.7 → about
  7 ms per 1M rows), and a view takes 16 bytes a row against about 10.
- **One column's rows split across cores.** With four cores the three
  copies run side by side, so the text column (about 1.6 ms) sets the time.
  Polars splits the rows (1.06 ms on ten cores on the Mac). Not built yet.
- **WebAssembly.** The gain there is smaller (7.1 → 6.0 ms). The text
  column is 3.3 of the 6.0 ms, against 1.6 of 2.8 natively; why was not
  looked into. The build has WebAssembly SIMD turned off, and turning it on
  is untried.
- **Text copied into a buffer that is not cleared first** (append, then cut
  back, as the fixed-width copy does). About 0.2 ms slower on the text
  column in the one pair of builds compared. That pair predates the table
  fix, so the comparison was not a clean one, and it was not repeated.
- **Hand-written SIMD** stays unscheduled, as before: it needs `unsafe`.

## [PND-RSFILTER] follow-up — slowdowns taken back (2026-11-23, 24)

#969 merged before its Layer 2 review had finished. The review, and a
re-check on the M1 over more kinds of series, found the new filter
**slower than the code before it** in two places, and #971 was opened to
remove both (first round, below). #971's own Layer 2 review then found two
more shapes that were still slower than before #969, and a second round
removed those. A second Layer 2 review, of that round, found that its
rules had been set on masks that repeat, and that with rows kept at random
several text columns were once more slower than before #969. A third
round, in the same PR, set every rule again on masks with no pattern; it
is the code now. What #969's section above says about text ("a stretch of
kept rows is one copy") and about lists ("no list of row numbers is
built") describes #969 as it merged, not the code now.

### First round: what #969 made slower

(The M1, Linux VM, one core, ms; 1M rows, but 833,333 for the 120-byte
text, since the benchmark holds at most 100 MB of text.)

| series                                       | before #969 | with #969 |
| -------------------------------------------- | ----------- | --------- |
| text of 24 bytes in 2-byte letters, 56% kept | 4.10        | 10.73     |
| the same, 93% kept                           | 4.45        | 15.92     |
| text of 60 bytes in 3-byte letters, 56% kept | 9.16        | 27.91     |
| text of 120 bytes, ASCII, 56% kept           | 5.35        | 8.23      |
| 8 number columns, 25% kept                   | 3.31        | 3.69      |
| 16 number columns, 25% kept                  | 4.83        | 6.74      |
| 32 number columns, 25% kept                  | 7.81        | 12.84     |
| 32 number columns, 56% kept                  | 10.45       | 13.57     |

**Why it was missed.** `examples/perf_filter.rs` timed one shape of text
(6-byte ASCII host names) and at most one column beside `v`. Every number
in #969's section is for that shape, and is right for it.

**Cause 1: Arrow checks text it is handed.** #969 copied text with its own
loop and built the array with `StringArray::new`. Every safe way to build a
text array from bytes checks them: all the bytes for UTF-8, and every row's
start for a character boundary. Shown on the M1 by switching only that last
step in one program (24 bytes of 2-byte letters, 56% kept, the text column
alone): 9.54 ms with the check, 1.56 without. The check is cheap for short
ASCII (0.64 ms of #969's 2.8), grows with the bytes, and costs far more for
a letter of more than one byte. Arrow's own `filter` kernel skips it, with
`unsafe`.

**Cause 2: the mask was walked again for every column.** #969's copy from
the mask costs about 0.40 ms per number column on the M1 (56% kept),
whatever came before. Arrow's kernel makes a list of the kept rows once
(about 0.44 ms) and then gathers each column by it in 0.26 to 0.30 ms. With
enough columns the list wins, most where 20 to 40% of rows are kept, since
the copy from the mask does the same work per eight rows however few of
them are kept.

**What the first round changed.** Text is no longer put together from
bytes by pond-rs: it goes by Arrow's `filter` kernel, or stretch by stretch
through `StringBuilder::append_array` where the kept rows come in long
stretches (the safe bulk path that #969's notes say was not found). Both
copy from an array already known to be valid, so neither is checked again.
`RowFilter::by_list` holds the kernel's list of the kept rows, made the
first time it is needed and shared by every column copied that way, and
`TimeSeries::filter_copy` picks one of three ways to go about a series
(`FilterCopy`).

### Second round: what the review of #971 found

The review's own probe (23,730 results over every column and key kind, 43
masks and 1, 2 and 4 threads) found nothing wrong in what `filter`
returns. On speed it found four things, each reproduced here before
anything was changed (numbers in the table further down):

1. **Many decimal columns** were slower than before #969. #969 copied
   16-byte decimal values by the same table as 8-byte numbers, and #971
   had kept that.
2. **Wide number tables with nearly every row kept** (one dropped row in
   every few hundred) were slower than before #969. #971's rule sent a
   table to the list only when its rows were mixed, and here the copy from
   the mask went word by word where the list goes stretch by stretch.
3. **No benchmark text had gaps.** With gaps, short text gave back more
   against #969 than the first round said.
4. **`by_list` always made its list.** One text column with most rows kept
   was faster when Arrow's kernel read the mask as it went.

**What the second round changed, and what is left of it.** Four things
stand:

- **Values wider than eight bytes are never copied by the table.** The
  table moves eight values to keep some of them; for a 16-byte decimal
  that is more to move than the kept ones alone (16 decimal columns, 45
  and 56% kept, table against a row at a time: 48.7 against 43.1 ms and
  51.2 against 46.2).
- **Decimal columns count toward the list**, and their values go by it
  when it is made. Their gap marks are still copied straight from the
  mask.
- **The benchmark's 17 more lines**: text with gaps, a wide table with one
  row in 257 dropped at every width, and tables of 8 and 16 decimal
  columns at 10, 45 and 93% kept.
- **One more warm-up call before the benchmark counts page faults**: a
  benchmark that holds its first result needs fresh room once more, on its
  first timed call, and that showed as page faults on lines that have none
  in steady use.

Its rules for picking a way to copy do not stand: a word of the mask
copied by its stretches from six rows a stretch (`in_stretches`); the list
for a mask with one word in four not in stretches (`is_scattered`); the
list when most rows are kept in stretches of 40 or more
(`keeps_most_in_long_stretches`); and text by Arrow's kernel without its
list when most rows are kept and no other column shares one. Each was set
on masks that repeat, and the third round replaced it. What set them is in
this section as it stood at db44fed, and is not repeated here.

### Third round: what the second review found

The second review (of f0f1163 and db44fed) again found nothing wrong in
what `filter` returns: 16,525 series and masks, each way of copying,
against `take_rows` and a row-by-row reading. It found three things about
speed and about the evidence for it:

1. **Several text columns with most rows kept at random were slower than
   before #969**: 4 to 8 text columns with 85 to 93% of the rows kept read
   0.99 to 1.25 of "before" at 100,000 rows and 0.98 to 1.18 at 1,000,000
   (the first round: 0.88 to 1.00). The second round sent text with most
   rows kept to Arrow's kernel without its list, so every text column read
   the mask again; before #969 the mask was prepared once. Reproduced here
   before anything was changed: 0.96 to 1.27 on 4 and 8 text columns at 85
   and 93% kept, where the first round read 0.88 to 0.99.
2. **Every mask the rules had been set on repeats.** The benchmark's and
   the tool's masks were arithmetic sequences or fixed blocks; the lines
   named "kept at random" were stretches of 4, 8 and 13 rows over and
   over. Work that goes a stretch at a time is cheaper on such a mask
   than on rows kept with no pattern (about half the cost, measured in
   the third round: "Why a rule can win on a mask that repeats", below),
   so a rule set on masks that repeat rates that work too well. "No line
   is slower than before" had been shown for those masks only, and for at
   most one text column.
3. **No test saw which way a copy went.** Five of the ten planted
   mistakes that no test caught were that round's choices of route: each
   could be turned round with every test passing, and nothing in CI times
   anything.

The review also flagged two stale comments and two names that both said
"long" (40 rows in one, 32 in the other). Those rules are gone, with
their names.

Finding 2 was then followed through. The tool gained masks with no
pattern (each row kept or dropped by a pseudo-random number, xorshift64,
at shares from 5 to 99%; and stretches whose lengths are random, from 3
to 200 rows on average), 431 lines of them beside the 249 it had, and
every rule was timed again on those, at 100,000 and at 1,000,000 rows.
Beside the text rule of finding 1, three more of the second round's rules
did not hold:

- **A word copied by its stretches from six rows a stretch, however many
  stretches.** With 85% of the rows kept at random, 56% of a mask's words
  pass that test, and at 90% nine in ten do, with four to eight stretches
  to a word. Put into the third round's code, so that nothing else
  differs, the rule took 18 to 35% longer than the table alone on tables
  of 1, 2 and 4 number columns with 85 to 93% of the rows kept at random
  at 100,000 rows, and 9 to 17% longer at 1,000,000. Each stretch is then
  a copy of its own length, and what a copy a stretch at a time costs on
  lengths with no pattern was measured by itself ("Why a rule can win on
  a mask that repeats", below).
- **One text column, most rows kept, by the kernel without its list**
  (the second round's answer to the first review's fourth finding). On
  masks that repeat it was the faster. With rows kept at random it was
  not: over sixteen lines (one text column of 6 or 24 bytes, with gaps
  and without, 85 to 99% kept, both table sizes) it read from 12% faster
  than the shared list to 12% slower, 4% slower on the middle line, and 3
  to 12% slower on all six lines at 100,000 rows with 85 to 93% kept. So
  that answer is taken back, and text goes by the shared list.
- **The list when most rows are kept, from 40 rows a stretch.** With rows
  kept at random the list of stretches already pays from 8 rows a stretch
  on tables of 8 to 32 number columns.

**What the third round changed.** The rules are set out in full two
sections down. In short: a column's values are copied by one of two
compiled loops, picked once per mask, so that a mask whose rows are
scattered never meets the stretch copy; in the loop that has it, a word
goes by its stretches only when they are few and long; the list is taken
column by column, by how long the stretches of kept rows are and how
wide the values; and text goes by the shared list unless its rows come in
long stretches. Two tests now see which way a copy went
(`each_word_is_copied_the_way_the_rules_say` in `row_filter.rs`,
`filter_takes_the_list_only_where_the_rules_say` in `rows.rs`), and the
benchmark has 72 more lines (140), all on masks with no pattern.

What the third round gives back for this, on masks that repeat and on
some masks that do not, is in "Measured" below.

### How versions are timed against each other

The first round's thresholds were set from separate runs of each build,
and the first review's findings 1 and 2 are what that let through. On the
x86 cloud server, five runs of one program gave 13.6, 18.7, 18.8, 21.9 and
26.1 ms for one memory-bound line (16 decimal columns with 10% of the rows
kept, on the code before #969), so not even the lowest of five is steady.

Since the second round every choice is made with a small tool kept
outside the repo: **every version linked into one program, timed a call
of each in turn.** To build it again: a scratch cargo workspace; per
version a copy of the crate's `Cargo.toml` under another package name
(`pond-before`, `pond-after`, …) with `src` pointing at that version's
tree; the benchmark cases in one file, `include!`d once per version inside
`mod x { use pond_before as pond_rs; … }`; a thread and a copy of the data
for each version (or one version finds its input still in the cache from
the last); a new random order every round; and for each case the middle
of the round-by-round ratio to the first version.

What it can and cannot tell apart, measured on itself:

- **Two copies of one source do not read the same.** Built under two
  names and timed over 249 lines, in two runs, they were 2 and 3 points
  apart on the middle line, 6 and 7 or more on one line in ten, and 18
  and 15 on the widest. The compiler does not lay one loop out the same
  way twice. That goes for "before" too: two copies of it read 3 to 6%
  apart on single lines.
- **One line moves from run to run.** The suite's case read between 0.74
  and 0.95 of "before" for one build of the second round over eight runs.
  Two versions in one run keep their order better than that.
- So one line of one run is not evidence. What is: a gap that every copy
  shows (each version is linked in two or three times for any close
  call), a count over many lines, or the middle of a group of lines.
- A ratio to "before" also moves with how many versions are in the run
  (more versions, more copies of the data, colder caches), so ratios are
  compared within a run only.
- **A whole run can sit high or low on a line, both copies with it.** At
  100,000 rows the third round read 0.97 and 0.98 of "before" on one line
  in one run and 0.78 and 0.80 in a longer one ("What #971 gives back").
  Two copies in one run share that run's layout in memory, so a second
  copy does not catch this; a second run does.
- **The tool's times are colder than a program's own.** With every
  version taking its turn, each finds less of its data still in the
  processor's cache: the suite's case takes "before" 11.4 ms in the tool
  at 1,000,000 rows and 7.0 as a program of its own. Where the two
  disagree about two versions, each version is run alone in the tool
  (the suite's case, under "Measured").

The third round added five things to how a rule is set, each after being
caught out:

- **Masks with no pattern.** Each row kept or dropped by a pseudo-random
  number (xorshift64) at a given share, and stretches of random length
  (each row ends its stretch with a fixed chance, so the lengths spread
  widely around their average: with 60 rows to a stretch on average, one
  stretch in eight is under 8 rows). The masks that repeat are still
  timed, as a check, not as the guide.
- **Two table sizes**, 100,000 rows and 1,000,000. What wins can differ
  when the whole table fits in the processor's cache.
- **A rule is judged by switching it off in a real build**: a copy of the
  source with one line changed, linked in as a version of its own. A lab
  build with a switch read at run time carries both ways through the
  loop, and that alone changes the timing: a loop that could copy a word
  by its stretches was 6% slower on the middle line than one compiled
  without that way through it, on masks where no word took it. For the
  same reason an old rule is compared with a new one by putting the old
  rule into the new code, not by timing the old code.
- **A bar is found with the rule forced on and forced off across a range
  of values**, not from one mask at the bar. A mask of "16 kept, 16
  dropped" on average has 15.98 rows to a stretch at 1,000,000 rows, so
  it falls just under a bar of 16, and "32 kept, 32 dropped" (31.94) just
  under one of 32. Lines of those two shapes in the tables below show the
  other side of the bar from the one their names suggest.
- **A line that a long run flags is timed again by itself**, with two
  copies of every version, "before" included, before anything is made of
  it. This round's are in "Measured" and in "What #971 gives back".

The tables of ms are still from each build run as its own program, since
that is what a user's program is: eleven runs of each build, the builds
taking turns, and the middle of the eleven.

**Is the code that was timed the code that is committed?** The paired
runs of the third round were made before its tests and comments were
finished. To show that nothing that runs had changed since, the two
libraries that were timed were kept, the final source built again under
the same names, and the two builds taken apart and compared instruction
by instruction: the same in all 16 object files of each copy (4,017,618
bytes of code), once the numbers the compiler puts in the names of private
functions are left out.

### The rules now, and what set them

A filter makes its mask (one bit per row, 64 rows to a word), counts the
kept rows and, the first time a rule asks, the stretches of kept rows.
The rules turn on three things: the share of rows kept, how many rows the
kept rows come to a stretch on average, and how wide a column's values
are. All were timed on the x86 cloud server, on one core, at 100,000 and
1,000,000 rows, on masks with no pattern unless said. The numbers behind
each bar are in the doc comment on its constant (`row_filter.rs`,
`rows.rs`); what follows is each rule and the reading that set it. The
M1's crossovers are not all the same, and a run on the Mac itself is
still owed (PLAN.md).

**How a series is gone about** (`TimeSeries::filter_copy`):

- 131,072 kept rows or more and more than one core: the key and each
  column on a core of its own (`FilterCopy::Split`), as in #969.
- Otherwise the columns are copied one after another, and a list of the
  kept rows is made once when enough columns would be copied faster by it
  than straight from the mask (`FilterCopy::Listed`): number, decimal and
  dictionary columns for which `RowFilter::list_pays` says so, a decimal
  column counting as two, eight in all (`FILTER_LIST_COLUMNS`). With a
  quarter to three quarters of the rows kept at random: at 8 number
  columns the list was 5 to 17% faster, at 4 the two were level, at 1 and
  2 the copy from the mask was level to 21% faster; at 8 decimal columns
  the list was level to 13% faster, and at 4 (which count as 8) level.

**Whether the list pays for a column** (`RowFilter::list_pays`):

- More than four rows in five kept (Arrow's list is then a list of
  stretches): for values of up to eight bytes, from 8 rows a stretch on
  average (`LIST_STRETCH_ROWS`). At 82 to 85% kept at random (6 to 7 rows
  a stretch) the copy from the mask was 7 to 25% faster; at 88% (8 rows)
  the two were level; from 90% the list was level to 15% faster. For
  wider values, always.
- Four in five or fewer (a list of rows): unless the kept rows come 32 or
  more to a stretch (`DIRECT_STRETCH_ROWS`; 16 for wider values,
  `DIRECT_STRETCH_ROWS_WIDE`). At 8 to 16 rows a stretch the list was 5 to
  30% faster; at 20 to 24 the two were level with half the rows or more
  kept; from 32 the copy from the mask was level to 25% faster.

**How a column is copied straight from the mask** (`RowFilter::vec`):

- A word with no kept row is skipped, and a run of words with every row
  kept is one copy, as in #969.
- **Two compiled copies of the loop.** One can copy a word a stretch at a
  time; the other is compiled without that. A mask goes by the first when
  its kept rows come 16 or more to a stretch on average
  (`STRETCH_LOOP_ROWS`; 6 for values wider than eight bytes,
  `WIDE_STRETCH_ROWS`). The reason for two: the stretch copy slows the
  loop down even for words that do not take it (6% on the middle line of
  nine, on 1 to 4 number columns with a quarter of the rows kept or
  fewer). With the two loops, rows kept at random read level with no such
  rule at all up to 92% kept (0.98 to 1.01 of it on the middle lines).
  The bar was then timed directly, the first loop for every mask against
  the second for every mask, on stretches of random length: the first
  took 1.02 to 1.04 of the second at 8 rows a stretch, 0.99 to 1.00 at
  12, 0.97 to 0.98 at 16, 0.93 at 20 and 0.85 to 0.89 at 32.
- **In the first loop, a word goes by its stretches** when they are three
  or fewer, of eight rows or more on average (`WORD_STRETCHES`,
  `WORD_STRETCH_ROWS`); for wider values, any number of stretches of six
  rows or more. On stretches of 20 to 200 rows this took up to 29% less
  time than the table, and with rows kept at random it stayed level with
  the table, since few words then have so few stretches.
- **Otherwise** a word of values of up to eight bytes with more than 24
  kept rows goes eight rows a step by the table, and with 24 or fewer bit
  by bit (`SPARSE`; 20 to 40 were level on rows kept at random, 8 was 10
  to 20% slower with a quarter kept). A word of wider values goes bit by
  bit whatever the count.

**The rule for a word, checked one line at a time.** Once the rules were
set, the rule for a word was changed alone, in copies of the third
round's code that ask every word of every mask, and each copy timed
against the loop that never asks: two copies of each, on tables of 1, 2
and 4 number columns over 60 masks (52 of stretches of random length,
from 8 to 200 rows kept and 1.5 to 600 dropped on average, and 8 of rows
kept at random, from 50 to 99%). "s" is the stretches in a word and "r"
the rows to a stretch; each cell is the middle of the three tables, at
100,000 rows and then at 1,000,000:

| rule for a word (to never asking)   | 85% kept at random | 90%        | 93%        | 10 kept, 1.5 dropped | 16 kept, 16 dropped | 32 kept, 32 dropped | middle of the 60 |
| ----------------------------------- | ------------------ | ---------- | ---------- | -------------------- | ------------------- | ------------------- | ---------------- |
| s ≤ 3 and r ≥ 8 (the third round's) | 1.00, 1.06         | 1.04, 1.01 | 1.04, 1.03 | 1.00, 1.03           | 0.98, 0.95          | 0.80, 0.86          | 0.95, 0.95       |
| s ≤ 3 and r ≥ 6                     | 1.05, 1.02         | 1.03, 1.01 | 1.01, 1.00 | 0.98, 0.99           | 0.90, 0.93          | 0.81, 0.86          | 0.91, 0.94       |
| r ≥ 8, any s                        | 1.12, 1.07         | 1.17, 1.08 | 1.16, 0.99 | 1.15, 1.03           | 0.93, 0.91          | 0.80, 0.89          | 0.92, 0.92       |
| r ≥ 6, any s (the second round's)   | 1.27, 1.17         | 1.35, 1.16 | 1.18, 1.09 | 1.30, 1.04           | 0.91, 0.91          | 0.78, 0.86          | 0.91, 0.92       |
| the second round's code itself      | 1.28, 1.15         | 1.34, 1.10 | 1.19, 1.05 | 1.32, 1.04           | 0.90, 0.90          | 0.72, 0.87          | 0.92, 0.92       |

The last two rows agree, so what differs between the two rounds on these
masks is the rule and nothing else in the code. A rule with no limit on
the stretches in a word is the slower wherever a word holds many of them
(four to eight to a word in the first four columns), by up to a third at
100,000 rows, and the limit of three takes that away. Where a word holds
one or two stretches the five read within a few points of each other.
(Two copies of one source were level on the middle line here and from
0.76 to 1.26 of each other on single lines of 180, so a difference of a
few points between two rows of this table in one column is not a
finding.)

**What the bar of 16 rows stands in for.** The same runs show what makes
the loop that asks pay: the share of a mask's words (those with both kept
and dropped rows) that the rule for a word takes. Counted for each of the
60 masks by a small program of its own, and set beside the loop that
asks to the one that does not (the middle mask of each group, at 100,000
and at 1,000,000 rows):

| share of the words the rule takes | masks | asks, to never asking | from, to     |
| --------------------------------- | ----- | --------------------- | ------------ |
| under 0.30                        | 14    | 1.02, 1.02            | 0.92 to 1.06 |
| 0.30 to 0.50                      | 8     | 1.01, 0.98            | 0.96 to 1.05 |
| 0.50 to 0.65                      | 7     | 1.01, 0.99            | 0.86 to 1.05 |
| 0.65 to 0.80                      | 11    | 0.90, 0.92            | 0.79 to 0.98 |
| 0.80 and over                     | 20    | 0.84, 0.89            | 0.76 to 1.04 |

So asking pays once about two thirds of the words go by their stretches,
and that share turns on the gaps between stretches as well as on the
stretches. Rows to a stretch is what a filter has already counted, and
it is a rough guide to the share: with 16 rows kept and 16 dropped on
average the rule takes 0.69 of the words, with 16 kept and 1.5 dropped
0.28, and with 14 kept and 42 dropped 0.62. A bar on the share itself
(0.6) would pick the other loop on 10 of the 60 masks. On nine of the
ten the two loops read within 5% of each other at both sizes; the tenth
is 14 kept and 42 dropped, where the loop that asks read 0.86 and 0.93
and the code does not use it. "Considered, not done" has why that bar
was not built.

**Text** (`RowFilter::text`): a stretch at a time through
`StringBuilder::append_array` when the kept rows come 32 or more to a
stretch (`TEXT_STRETCH_ROWS`), and otherwise by Arrow's kernel and the
shared list, whether or not other columns use the list. 16 or 64 in place
of 32 moved nothing by more than two runs differ by; 128 took 25 to 100%
longer on stretches of 64 rows.

**True/false values and gap marks** go a stretch at a time, shifted into
place, as in #969. **Arrays** go by row number.

### Same answers

Each way of copying is held to a row-by-row reading and to Arrow's kernel
over 25 masks at 16 lengths (none, all, single rows at the edges of a
word, stretches that end with a word and that run on into the next, two
to four stretches to a word, rows kept at random at five shares): values
of 4, 8 and 16 bytes, through each of the two compiled loops whichever
the mask would pick; true/false values and gap marks, whole and sliced;
text with and without gaps, whole and sliced, by each of its two routes;
dictionaries; and the list against the copy from the mask. The three ways
of going about a series are each held to `take_rows`, with a decimal
column among them, and `filter_expr` in full to `take_rows` (it compared
row counts only, a finding of #969's review). Each rule is tested on both
sides of its bar: which loop a mask goes by, which words go by their
stretches, whether the list pays for a width, and how a series is gone
about.

**Two tests now see which way a copy went** (the second review's third
finding). The rows that come out are the same each way, so no test of
results can tell the ways apart:

- `each_word_is_copied_the_way_the_rules_say` (`row_filter.rs`) counts the
  words copied a stretch at a time, bit by bit and by the table, with a
  counter that only test builds carry, on masks of ten words made for
  each rule: scattered rows either side of 24 kept to a word, long
  stretches, 14 and 16 rows to a stretch, and masks in stretches on the
  whole with words that are not.
- `filter_takes_the_list_only_where_the_rules_say` (`rows.rs`) asks the
  mask, after a column or a series has been filtered by it, whether its
  list of kept rows was made: for numbers, decimals and dictionary keys
  only with a list to share and only where it pays for their width; for
  text whenever its rows come under 32 to a stretch; for true/false
  values never; and for a whole series only when it is gone about by the
  list.

**Planted mistakes.** 98 mistakes were planted in the copying code and
its rules, one at a time, and the filter tests run on each: every copy
broken in some way (a row read from the wrong place, a stretch cut
short, gap marks lost), every rule turned round, and every bar moved by
one row each way. A test fails on 97. Of the 98, 22 give the same rows
by another way of copying, which only the two tests above can see, and
they fail on 21 of those (at the second round, with no such tests, the
planted mistakes of this kind all went unseen). The one that no test
sees sets aside room for one row too few in each stretch when text is
copied a stretch at a time; the builder then makes more room as it goes,
so the rows are the same and only an allocation differs.

No test times anything, and nothing in CI does (the second review's
point). The two tests above hold each copy to the way the rules pick;
that the rules pick the faster way is shown only by the timings in this
section, on one machine.

### Measured

On the x86 cloud server (4 cores, a 2.1 GHz Xeon). "Before" is ff2ff27,
the commit before #969; it never uses a second core. "First round" is
#971 as first pushed (556ce9e), "second round" db44fed, and "third round"
the code now. Freed memory was held on to so that runs compare (below).

**Every version in one program, a call of each in turn.** Two sets of
lines: the 249 the second round was judged on, whose masks repeat (the
benchmark's first 68 lines and 181 more: decimals, wide tables, text of
three lengths with and without gaps, rows kept "at random" by a short
cycle, stretches that do and do not line up with 64 rows), and 431 with
no pattern (1 to 32 number columns, 1 to 16 decimal columns with and
without gaps, 1 to 8 text columns of 6 and 24 bytes; rows kept at random
from 5 to 99%, and stretches of random length from 3 to 200 rows with
gaps from 1.2 to 800). Each set was timed at 1,000,000 rows on one core
(15 rounds a line), at 100,000 rows on one core (61 rounds) and at
1,000,000 rows on four cores (9 rounds). The third round was linked in
twice. A line counts as slower than "before" when it reads more than 3%
above it:

| lines slower than "before"                  | #969 | first round | second round | third round, each copy | on both copies |
| ------------------------------------------- | ---- | ----------- | ------------ | ---------------------- | -------------- |
| 249 that repeat, 1,000,000 rows, one core   | 96   | 33          | 0            | 0, 2                   | 0              |
| 431 with no pattern, the same               | 146  | 35          | 19           | 1, 1                   | 0              |
| 249 that repeat, 100,000 rows, one core     | 110  | 44          | 11           | 5, 4                   | 2              |
| 431 with no pattern, the same               | 141  | 34          | 49           | 5, 6                   | 3              |
| 249 that repeat, 1,000,000 rows, four cores | 13   | 5           | 0            | 0, 0                   | 0              |
| 431 with no pattern, the same               | 18   | 8           | 4            | 0, 2                   | 0              |

| the middle line, to "before"                | #969 | first round | second round | third round, each copy |
| ------------------------------------------- | ---- | ----------- | ------------ | ---------------------- |
| 249 that repeat, 1,000,000 rows, one core   | 0.96 | 0.88        | 0.83         | 0.83, 0.83             |
| 431 with no pattern, the same               | 0.97 | 0.87        | 0.83         | 0.82, 0.82             |
| 249 that repeat, 100,000 rows, one core     | 0.97 | 0.88        | 0.83         | 0.83, 0.85             |
| 431 with no pattern, the same               | 0.89 | 0.84        | 0.81         | 0.80, 0.79             |
| 249 that repeat, 1,000,000 rows, four cores | 0.38 | 0.36        | 0.34         | 0.35, 0.35             |
| 431 with no pattern, the same               | 0.39 | 0.37        | 0.35         | 0.35, 0.35             |

How much of a count is the tool and not the code: in the two runs on
four cores a second copy of "before" was linked in too, and it read more
than 3% above the first copy on 67 of the 249 lines and on 133 of the
431 (and more than 3% under it on 52 and 124). On four cores nearly
every line of every later version is far under "before", so that does
not move the counts above; it is why a single line near 1.00 is read
only with a second copy beside it. The two copies of the third round
were more than 3% apart on 112 to 136 of the 249 lines and on 185 to 224
of the 431, depending on the run, and more than 10% apart on 8 to 31 and
on 22 to 55.

**Lines read again, with two copies of everything.** Every line that
read above "before" on both copies of the third round, and others near
it, was timed again in runs of their own, with "before", the second round
and the third round each linked in twice (25 or 41 rounds a line at
1,000,000 rows, 121 at 100,000). Each figure is the middle of one copy's
round-by-round ratio to the mean of the two copies of "before":

| line (ratios to "before")                                    | second round | third round |
| ------------------------------------------------------------ | ------------ | ----------- |
| **1,000,000 rows, one core**                                 |              |             |
| 16 number columns, 8 kept then 1 dropped                     | 0.87, 0.87   | 1.00, 1.00  |
| 32 number columns, 8 kept then 1 dropped                     | 0.91, 0.89   | 1.01, 0.98  |
| 32 number columns, 32 kept and 100 dropped on average        | 0.95, 0.87   | 1.02, 0.98  |
| 16 decimal columns, no gaps, 93% kept                        | 0.93, 0.91   | 0.97, 0.96  |
| 16 decimal columns, no gaps, 80% kept by the old short cycle | 0.96, 0.95   | 0.95, 0.97  |
| 4 text columns of 6 bytes, 85% kept at random                | 1.11, 1.04   | 0.89, 0.89  |
| the same, 93% kept                                           | 1.02, 0.96   | 0.87, 0.90  |
| the same, 99% kept                                           | 0.76, 0.76   | 0.75, 0.75  |
| 8 text columns of 6 bytes, 85% kept at random                | 1.16, 1.16   | 0.99, 0.95  |
| the same, 93% kept                                           | 1.07, 1.05   | 0.95, 0.95  |
| the same, 99% kept                                           | 0.82, 0.81   | 0.81, 0.85  |
| **1,000,000 rows, four cores**                               |              |             |
| 4 number columns, 5% kept at random                          | 0.90, 0.81   | 0.72, 0.80  |
| 16 decimal columns with gaps, 5% kept at random              | 0.97, 1.02   | 1.01, 0.97  |
| **100,000 rows, one core**                                   |              |             |
| 32 number columns, 8 kept then 1 dropped                     | 1.00, 1.02   | 1.10, 1.02  |
| the same line in another run                                 | 1.00, 1.00   | 1.07, 1.07  |
| 32 number columns, 12 kept then 1 dropped                    | 1.06, 1.05   | 1.01, 1.01  |
| 32 number columns, 16 kept then 1 dropped                    | 1.10, 1.08   | 0.93, 0.96  |
| 32 number columns, 93% kept by the old short cycle           | 1.06, 1.03   | 0.96, 0.92  |
| 16 decimal columns with gaps, 25% kept (a mask that repeats) | 0.98, 1.02   | 1.01, 0.98  |
| 16 decimal columns with gaps, 25% kept at random             | 1.05, 1.07   | 1.06, 1.02  |
| the same, 10% kept                                           | 1.02, 0.98   | 0.99, 0.97  |
| 16 decimal columns, no gaps, 25% kept at random              | 0.90, 0.88   | 0.91, 0.88  |
| 8 decimal columns with gaps, 25% kept at random              | 0.95, 0.94   | 0.95, 0.99  |
| 8 text columns of 6 bytes, 25% kept at random                | 0.91, 0.95   | 0.92, 0.92  |
| the same, 50% kept                                           | 1.01, 1.02   | 1.04, 1.09  |
| the same, 75% kept                                           | 1.01, 1.01   | 1.05, 1.03  |
| 4 text columns of 6 bytes with gaps, 50% kept at random      | 1.02, 0.94   | 0.94, 0.99  |

At 1,000,000 rows, on one core and on four, no line read above "before"
again by more than a point or two, which is less than the two copies of
"before" differ by on the same lines (up to 7%). Three kinds of table are
level with "before" there and no better: 16 and 32 number columns with 8
rows kept and then 1 dropped (the second round read 0.87 to 0.91); 32
number columns with 32 rows kept and 100 dropped on average (the second
round 0.87 and 0.95, on a line where the two copies of "before" were 7%
apart); and 16 decimal columns with gaps and a twentieth of the rows
kept, on four cores (the second round level too).

At 100,000 rows three kinds of table read from level with "before" to 10%
above it, in every run:

- **32 number columns with 8 rows kept and then 1 dropped**: 1.10 and
  1.02, and 1.07 and 1.07 in another run (the second round 1.00 to 1.02;
  in the main run #969 read 1.09 and the first round 1.03). The mask sits
  exactly on the bar of 8 rows to a stretch, on the side that takes
  Arrow's list of stretches.
- **8 columns of 6-byte text with half to three quarters of the rows kept
  at random**: 1.03 to 1.09 (the second round 1.01 to 1.02).
- **16 decimal columns with gaps and a quarter of the rows kept at
  random**: 1.02 and 1.06 (the second round 1.05 and 1.07).

On the first two, the columns that make up nearly all of the work (the 32
number columns, the 8 text columns) are copied the way "before" copied
them, by Arrow's kernel with the list made once, so level is what the
code should give. No cause was found for the few points above it. On the
third, the values go that way and the gap marks do not: "before" left
them to the kernel, and since #969 they are copied from the mask, which
is the slower way where rows are kept one at a time and few of them. Timed after the third round was committed: the same source with
the gap marks left to the kernel read 0.93 of "before" on that line, on
both copies, where the third round read 1.02 and 1.00 ("Considered, not
done" has the other shares; the rule is not built). The same three kinds
read 0.93 to 1.01 at 1,000,000 rows.

**The second review's first finding** (several text columns with most
rows kept at random) in the main runs: 2, 4 and 8 columns of 6- and
24-byte text, and 4 columns of 6-byte text with gaps, at 85 and 93% kept
(14 lines). The second round read 0.87 to 1.18 of "before" at 1,000,000
rows, above 1.03 on 7; the third round's two copies 0.86 to 1.12 and 0.83
to 0.97, above 1.03 on one line of one copy (8 columns of 6-byte text at
85% kept: 1.12 and 0.95). Read again with two copies of everything (the
table above), that line is 0.99 and 0.95, where the second round is 1.16
on both copies.

**The benchmark as a program of its own** (`cargo run --release -p
pond-rs --example perf_filter`, one build for each version; each of its
140 lines is the middle of eleven runs of the program; 1,000,000 rows, but
833,333 for the 120-byte text and 250,000 for the 400-byte, which the
benchmark holds to 100 MB of text).
A line counts when the two builds are more than 3% apart:

| 140 lines, against "before" | slower, one core | faster | slower, four cores | faster |
| --------------------------- | ---------------- | ------ | ------------------ | ------ |
| #969                        | 42               | 90     | 15                 | 123    |
| second round                | 5                | 130    | 0                  | 138    |
| third round                 | 1                | 137    | 1                  | 138    |

The one line is 16 decimal columns with gaps and 10% of the rows kept:
24.84 ms against 23.22 on one core (its eleven runs went from 22.1 to
29.3, and those of "before" from 20.5 to 27.9) and 25.77 against 24.91 on
four. In the paired tool the same line read 0.96 and 1.02 of "before" on
one core and 1.00 and 0.97 on four, so it is level. (With its gap marks
left to the kernel it read 0.85 to 0.87 in the second round's lab build:
"Considered, not done".) Of the 72 lines with no pattern, the third round
is above "before" on none (the second round on 4, #969 on 19, on one
core).

How far two builds of the same code read from each other in this table:
the build with the unchecked change (below) runs the third round's code
on the 86 lines with no text, and there the two builds read from 0.89 to
1.24 of each other on one core (more than 5% apart on 24 lines, more
than 10% on 4) and from 0.89 to 1.16 on four (37 and 7). Eleven runs of
one line spread by 39% of the middle on the typical line. So a gap of
under about 10% between two builds on one line of this table is not a
finding by itself.

The 68 lines the benchmark had before the third round, ms. The last two
columns are the third round's ratio to "before" in the paired runs above
(its two copies), on one core and on four. (\* "before" has no second
core to use; its column is there to show what the machine itself gives
on a second run.)

| line                                                | before | #969  | second round | third round | before, 4 cores\* | #969, 4 cores | third round, 4 cores | third round to before, paired | the same, 4 cores |
| --------------------------------------------------- | ------ | ----- | ------------ | ----------- | ----------------- | ------------- | -------------------- | ----------------------------- | ----------------- |
| **How many rows are kept, and how they are spread** |        |       |              |             |                   |               |                      |                               |                   |
| 56% kept, stretches of ~3 (the suite's case)        | 6.99   | 4.83  | 5.29         | 6.03        | 7.05              | 3.88          | 4.52                 | 0.79, 0.82                    | 0.61, 0.57        |
| none kept (the test alone)                          | 2.69   | 0.62  | 0.63         | 0.66        | 2.72              | 0.64          | 0.67                 | 0.26, 0.30                    | 0.24, 0.24        |
| 1% kept                                             | 3.05   | 1.27  | 1.20         | 1.19        | 3.10              | 1.29          | 1.16                 | 0.42, 0.39                    | 0.42, 0.44        |
| 93% kept (all but the gaps and 1%)                  | 8.51   | 5.50  | 5.72         | 6.76        | 8.29              | 4.33          | 4.90                 | 0.81, 0.83                    | 0.51, 0.51        |
| 50% kept, stretches of 1,000                        | 6.00   | 3.29  | 1.97         | 2.02        | 5.91              | 3.12          | 1.81                 | 0.42, 0.38                    | 0.26, 0.28        |
| 56% kept, gaps in the text                          | 8.47   | 5.43  | 6.72         | 6.84        | 8.38              | 4.72          | 5.88                 | 0.82, 0.83                    | 0.60, 0.62        |
| 93% kept, gaps in the text                          | 9.51   | 5.85  | 7.43         | 8.10        | 9.60              | 4.67          | 6.31                 | 0.81, 0.80                    | 0.56, 0.60        |
| **Half the rows kept, in stretches of one length**  |        |       |              |             |                   |               |                      |                               |                   |
| stretches of 1                                      | 6.49   | 5.15  | 4.58         | 4.60        | 6.41              | 5.00          | 3.95                 | 0.77, 0.87                    | 0.52, 0.55        |
| stretches of 4                                      | 6.36   | 3.67  | 4.41         | 4.65        | 6.45              | 3.17          | 4.11                 | 0.84, 0.75                    | 0.57, 0.55        |
| stretches of 8                                      | 6.18   | 3.50  | 4.48         | 4.54        | 6.34              | 3.06          | 3.93                 | 0.76, 0.85                    | 0.53, 0.55        |
| stretches of 16                                     | 6.08   | 3.67  | 4.31         | 4.19        | 6.33              | 3.14          | 3.77                 | 0.73, 0.73                    | 0.52, 0.55        |
| stretches of 32                                     | 5.74   | 3.71  | 3.15         | 3.19        | 6.25              | 3.02          | 2.56                 | 0.59, 0.63                    | 0.43, 0.43        |
| stretches of 64                                     | 5.88   | 3.49  | 2.62         | 2.62        | 5.83              | 2.89          | 1.96                 | 0.47, 0.49                    | 0.38, 0.38        |
| stretches of 256                                    | 5.83   | 3.44  | 2.31         | 2.35        | 6.25              | 2.92          | 1.73                 | 0.42, 0.42                    | 0.35, 0.31        |
| **The same rows as 1000 series of 1,000 rows**      |        |       |              |             |                   |               |                      |                               |                   |
| 56% kept, a call per series                         | 7.23   | 5.16  | 6.32         | 6.08        | 7.45              | 5.21          | 6.23                 | 0.85, 0.89                    | 0.84, 0.88        |
| **v > 500**                                         |        |       |              |             |                   |               |                      |                               |                   |
| no other column                                     | 4.65   | 2.20  | 2.43         | 2.40        | 4.68              | 2.32          | 2.26                 | 0.61, 0.53                    | 0.46, 0.45        |
| number, no gaps                                     | 5.42   | 3.10  | 3.17         | 3.42        | 5.46              | 2.25          | 2.46                 | 0.61, 0.69                    | 0.39, 0.41        |
| text                                                | 6.95   | 4.64  | 5.26         | 5.80        | 7.00              | 3.99          | 4.48                 | 0.71, 0.78                    | 0.51, 0.52        |
| text held as a dictionary                           | 5.25   | 3.18  | 3.42         | 3.49        | 5.32              | 2.57          | 2.20                 | 0.65, 0.71                    | 0.44, 0.45        |
| true/false, with gaps                               | 6.38   | 3.55  | 3.46         | 3.68        | 6.71              | 2.32          | 2.27                 | 0.63, 0.57                    | 0.32, 0.33        |
| decimal, with gaps                                  | 6.90   | 4.66  | 4.38         | 4.49        | 7.22              | 4.34          | 3.39                 | 0.82, 0.64                    | 0.49, 0.46        |
| array (one number per row)                          | 16.52  | 15.05 | 14.12        | 14.82       | 17.01             | 13.96         | 13.11                | 0.82, 0.92                    | 0.78, 0.77        |
| **Text of other lengths and letters**               |        |       |              |             |                   |               |                      |                               |                   |
| 24 bytes, ASCII                                     | 7.61   | 7.77  | 5.95         | 6.03        | 7.87              | 7.82          | 6.51                 | 0.93, 0.87                    | 0.62, 0.60        |
| 24 bytes, ASCII, stretches                          | 6.26   | 5.76  | 2.55         | 2.65        | 6.22              | 5.29          | 2.50                 | 0.43, 0.44                    | 0.38, 0.36        |
| 120 bytes, ASCII                                    | 18.03  | 26.19 | 17.86        | 17.39       | 19.58             | 23.75         | 17.23                | 0.91, 0.90                    | 0.77, 0.75        |
| 120 bytes, ASCII, stretches                         | 12.71  | 16.20 | 5.30         | 5.58        | 13.87             | 15.59         | 8.43                 | 0.62, 0.59                    | 0.55, 0.55        |
| 400 bytes, ASCII                                    | 12.85  | 20.00 | 12.14        | 10.32       | 13.39             | 19.78         | 13.78                | 0.97, 0.97                    | 0.91, 0.94        |
| 400 bytes, ASCII, stretches                         | 6.68   | 11.03 | 4.58         | 4.53        | 7.47              | 10.99         | 4.62                 | 0.85, 0.84                    | 0.87, 0.88        |
| 12 bytes, 6 letters of 2 bytes                      | 7.06   | 8.06  | 4.81         | 5.34        | 7.24              | 8.88          | 4.74                 | 0.76, 0.77                    | 0.58, 0.56        |
| 12 bytes, 6 letters of 2 bytes, stretches           | 5.86   | 7.26  | 2.11         | 2.01        | 6.00              | 7.38          | 2.29                 | 0.38, 0.39                    | 0.33, 0.31        |
| 24 bytes, 12 letters of 2 bytes                     | 7.39   | 15.80 | 5.82         | 5.76        | 8.37              | 15.10         | 6.39                 | 0.83, 0.83                    | 0.71, 0.67        |
| 24 bytes, 12 letters of 2 bytes, stretches          | 5.69   | 12.38 | 2.59         | 2.67        | 6.04              | 12.07         | 2.82                 | 0.43, 0.43                    | 0.32, 0.33        |
| 60 bytes, 20 letters of 3 bytes                     | 12.92  | 37.36 | 13.30        | 9.61        | 14.90             | 34.77         | 12.93                | 0.85, 0.90                    | 0.71, 0.72        |
| 60 bytes, 20 letters of 3 bytes, stretches          | 7.94   | 28.42 | 4.19         | 4.15        | 8.88              | 27.37         | 5.31                 | 0.53, 0.57                    | 0.44, 0.42        |
| **More number columns beside the key and v**        |        |       |              |             |                   |               |                      |                               |                   |
| 1 more, 56% kept                                    | 5.01   | 3.06  | 3.17         | 2.94        | 5.42              | 2.39          | 2.24                 | 0.71, 0.66                    | 0.36, 0.37        |
| 1 more, 25% kept                                    | 3.91   | 2.77  | 2.29         | 2.18        | 4.43              | 1.97          | 1.68                 | 0.52, 0.54                    | 0.37, 0.41        |
| 1 more, stretches of 1,000                          | 4.02   | 1.98  | 1.78         | 1.66        | 4.53              | 1.58          | 1.64                 | 0.40, 0.39                    | 0.32, 0.32        |
| 1 more, one row in 257 dropped                      | 4.49   | 2.98  | 2.73         | 2.72        | 4.91              | 2.09          | 2.02                 | 0.56, 0.56                    | 0.36, 0.40        |
| 3 more, 56% kept                                    | 6.81   | 4.44  | 4.72         | 4.54        | 7.07              | 2.65          | 2.74                 | 0.83, 0.84                    | 0.41, 0.39        |
| 3 more, 25% kept                                    | 5.47   | 3.92  | 3.33         | 3.22        | 5.46              | 2.32          | 1.92                 | 0.80, 0.78                    | 0.37, 0.36        |
| 3 more, stretches of 1,000                          | 5.79   | 2.75  | 2.50         | 2.40        | 5.87              | 1.93          | 1.73                 | 0.45, 0.45                    | 0.32, 0.28        |
| 3 more, one row in 257 dropped                      | 5.88   | 4.42  | 4.36         | 4.33        | 6.12              | 2.77          | 2.93                 | 0.76, 0.71                    | 0.42, 0.43        |
| 5 more, 56% kept                                    | 8.68   | 5.94  | 6.94         | 6.20        | 8.55              | 3.28          | 3.37                 | 0.87, 0.88                    | 0.36, 0.33        |
| 5 more, 25% kept                                    | 6.59   | 5.62  | 4.60         | 4.39        | 6.25              | 2.75          | 2.15                 | 0.84, 0.87                    | 0.37, 0.34        |
| 5 more, stretches of 1,000                          | 7.18   | 3.99  | 3.24         | 3.24        | 6.86              | 2.21          | 2.13                 | 0.57, 0.54                    | 0.26, 0.24        |
| 5 more, one row in 257 dropped                      | 8.52   | 6.66  | 5.91         | 6.29        | 7.84              | 3.17          | 3.12                 | 0.80, 0.82                    | 0.32, 0.34        |
| 7 more, 56% kept                                    | 12.04  | 11.85 | 9.23         | 9.08        | 11.25             | 4.04          | 3.98                 | 0.84, 0.83                    | 0.35, 0.38        |
| 7 more, 25% kept                                    | 7.71   | 7.31  | 5.55         | 5.59        | 7.31              | 3.08          | 2.53                 | 0.78, 0.76                    | 0.38, 0.38        |
| 7 more, stretches of 1,000                          | 8.16   | 4.37  | 4.12         | 4.30        | 8.26              | 2.55          | 2.16                 | 0.53, 0.55                    | 0.27, 0.24        |
| 7 more, one row in 257 dropped                      | 11.36  | 9.09  | 9.61         | 7.68        | 12.37             | 3.79          | 3.64                 | 0.77, 0.79                    | 0.35, 0.33        |
| 15 more, 56% kept                                   | 23.91  | 27.02 | 22.45        | 21.34       | 24.12             | 6.80          | 7.81                 | 0.87, 0.84                    | 0.35, 0.34        |
| 15 more, 25% kept                                   | 15.46  | 24.90 | 13.57        | 12.45       | 16.27             | 4.93          | 4.76                 | 0.95, 0.98                    | 0.34, 0.34        |
| 15 more, stretches of 1,000                         | 18.35  | 13.82 | 10.82        | 9.89        | 17.73             | 4.23          | 3.53                 | 0.68, 0.68                    | 0.23, 0.22        |
| 15 more, one row in 257 dropped                     | 26.22  | 27.95 | 23.55        | 23.06       | 25.24             | 7.83          | 7.32                 | 0.85, 0.87                    | 0.33, 0.33        |
| 31 more, 56% kept                                   | 46.00  | 51.80 | 42.52        | 43.11       | 44.90             | 14.76         | 14.81                | 0.98, 0.95                    | 0.34, 0.33        |
| 31 more, 25% kept                                   | 34.35  | 48.38 | 31.20        | 30.50       | 32.82             | 13.09         | 10.90                | 0.93, 0.90                    | 0.32, 0.33        |
| 31 more, stretches of 1,000                         | 34.99  | 35.44 | 27.75        | 27.08       | 33.70             | 8.99          | 7.87                 | 0.76, 0.78                    | 0.23, 0.23        |
| 31 more, one row in 257 dropped                     | 46.89  | 55.23 | 46.81        | 45.43       | 46.99             | 15.19         | 15.48                | 0.95, 0.94                    | 0.31, 0.31        |
| **Decimal columns beside the key and v**            |        |       |              |             |                   |               |                      |                               |                   |
| 8 decimals, 10% kept                                | 8.76   | 8.20  | 6.93         | 6.47        | 9.06              | 8.26          | 6.54                 | 0.75, 0.81                    | 0.84, 0.72        |
| 8 decimals, 45% kept                                | 20.34  | 27.85 | 17.90        | 17.60       | 19.33             | 7.63          | 6.88                 | 0.90, 0.87                    | 0.37, 0.38        |
| 8 decimals, 93% kept                                | 31.77  | 34.04 | 27.77        | 28.77       | 31.28             | 10.21         | 8.09                 | 0.92, 0.93                    | 0.29, 0.28        |
| 16 decimals, 10% kept                               | 21.11  | 23.38 | 16.91        | 17.70       | 20.50             | 22.63         | 18.27                | 0.86, 0.82                    | 0.90, 0.84        |
| 16 decimals, 45% kept                               | 38.84  | 54.40 | 36.16        | 36.61       | 39.83             | 15.26         | 12.15                | 0.88, 0.89                    | 0.35, 0.34        |
| 16 decimals, 93% kept                               | 57.54  | 63.53 | 53.92        | 56.13       | 57.55             | 18.50         | 14.92                | 0.97, 1.00                    | 0.30, 0.27        |
| 16 decimals, with gaps, 10% kept                    | 23.22  | 28.91 | 25.05        | 24.84       | 24.91             | 28.55         | 25.77                | 0.96, 1.02                    | 1.00, 0.97        |
| 16 decimals, with gaps, 45% kept                    | 52.60  | 61.12 | 50.14        | 47.13       | 54.95             | 18.91         | 15.78                | 0.89, 0.85                    | 0.28, 0.30        |
| 16 decimals, with gaps, 93% kept                    | 77.09  | 69.04 | 60.33        | 59.72       | 78.35             | 19.34         | 16.51                | 0.75, 0.80                    | 0.26, 0.24        |
| **v > 500 as a closure**                            |        |       |              |             |                   |               |                      |                               |                   |
| filter(\|row\| ...)                                 | 8.20   | 6.97  | 7.08         | 6.82        | 7.99              | 5.98          | 6.14                 | 0.82, 0.82                    | 0.62, 0.66        |

The 72 lines the third round added, all on masks with no pattern, ms:

| line                                                                    | before | #969  | second round | third round | before, 4 cores\* | #969, 4 cores | second round, 4 cores | third round, 4 cores |
| ----------------------------------------------------------------------- | ------ | ----- | ------------ | ----------- | ----------------- | ------------- | --------------------- | -------------------- |
| **Rows kept at random, by the share kept**                              |        |       |              |             |                   |               |                       |                      |
| 1 text, 5% kept                                                         | 3.65   | 2.16  | 2.29         | 2.11        | 4.09              | 2.06          | 2.28                  | 2.10                 |
| 1 text, 25% kept                                                        | 4.54   | 3.77  | 3.25         | 3.13        | 5.03              | 2.77          | 2.64                  | 2.83                 |
| 1 text, 50% kept                                                        | 5.82   | 4.68  | 4.73         | 4.75        | 6.38              | 3.69          | 3.69                  | 4.23                 |
| 1 text, 85% kept                                                        | 9.75   | 5.97  | 8.71         | 7.70        | 9.90              | 4.58          | 6.69                  | 6.71                 |
| 1 text, 97% kept                                                        | 6.27   | 6.05  | 5.09         | 4.89        | 6.44              | 4.54          | 4.08                  | 4.01                 |
| 4 texts, 5% kept                                                        | 6.08   | 4.92  | 4.55         | 3.97        | 6.21              | 4.76          | 4.79                  | 4.17                 |
| 4 texts, 25% kept                                                       | 8.56   | 9.35  | 7.28         | 6.68        | 8.69              | 4.07          | 3.29                  | 3.33                 |
| 4 texts, 50% kept                                                       | 13.50  | 13.35 | 12.76        | 11.42       | 12.97             | 4.79          | 4.78                  | 4.96                 |
| 4 texts, 85% kept                                                       | 25.11  | 19.49 | 28.03        | 21.23       | 21.84             | 5.74          | 8.47                  | 7.13                 |
| 4 texts, 97% kept                                                       | 14.88  | 18.47 | 17.18        | 14.53       | 15.38             | 5.54          | 5.55                  | 5.43                 |
| 1 number, 5% kept                                                       | 3.55   | 1.43  | 1.65         | 1.43        | 3.54              | 1.23          | 1.72                  | 1.53                 |
| 1 number, 25% kept                                                      | 4.37   | 2.48  | 2.01         | 2.09        | 4.32              | 1.64          | 1.54                  | 1.66                 |
| 1 number, 50% kept                                                      | 4.87   | 2.67  | 2.50         | 2.61        | 5.00              | 1.75          | 1.82                  | 1.92                 |
| 1 number, 85% kept                                                      | 7.17   | 2.79  | 3.75         | 2.84        | 7.28              | 1.87          | 2.24                  | 2.12                 |
| 1 number, 97% kept                                                      | 5.19   | 2.80  | 2.88         | 2.84        | 5.17              | 1.84          | 1.78                  | 1.85                 |
| 7 numbers, 5% kept                                                      | 4.84   | 3.03  | 2.52         | 2.73        | 4.95              | 3.33          | 2.98                  | 2.77                 |
| 7 numbers, 25% kept                                                     | 7.34   | 6.66  | 5.48         | 5.38        | 7.39              | 2.94          | 2.78                  | 2.68                 |
| 7 numbers, 50% kept                                                     | 9.63   | 7.63  | 8.02         | 7.45        | 9.59              | 3.31          | 3.48                  | 3.24                 |
| 7 numbers, 85% kept                                                     | 16.14  | 11.59 | 15.20        | 11.25       | 16.59             | 3.91          | 4.75                  | 4.01                 |
| 7 numbers, 97% kept                                                     | 11.55  | 11.99 | 9.13         | 9.63        | 12.13             | 3.67          | 3.15                  | 3.34                 |
| 31 numbers, 5% kept                                                     | 11.93  | 21.17 | 9.76         | 9.36        | 14.01             | 21.44         | 11.09                 | 9.46                 |
| 31 numbers, 25% kept                                                    | 32.20  | 47.89 | 29.51        | 29.27       | 31.37             | 13.12         | 11.04                 | 11.07                |
| 31 numbers, 50% kept                                                    | 40.71  | 50.41 | 39.05        | 38.95       | 42.50             | 14.07         | 15.01                 | 14.46                |
| 31 numbers, 85% kept                                                    | 63.19  | 58.09 | 58.92        | 57.78       | 61.15             | 15.56         | 16.99                 | 16.27                |
| 31 numbers, 97% kept                                                    | 56.09  | 56.94 | 52.05        | 51.83       | 55.71             | 15.90         | 13.76                 | 14.54                |
| 4 decimals, 5% kept                                                     | 4.58   | 2.67  | 3.21         | 2.38        | 4.63              | 2.65          | 3.24                  | 2.49                 |
| 4 decimals, 25% kept                                                    | 7.59   | 9.28  | 5.43         | 5.18        | 7.73              | 3.29          | 2.76                  | 2.66                 |
| 4 decimals, 50% kept                                                    | 10.08  | 11.89 | 7.51         | 7.44        | 9.87              | 4.01          | 3.19                  | 3.43                 |
| 4 decimals, 85% kept                                                    | 14.78  | 14.79 | 13.20        | 11.67       | 15.11             | 4.54          | 4.67                  | 4.29                 |
| 4 decimals, 97% kept                                                    | 12.28  | 14.82 | 10.44        | 9.36        | 13.12             | 4.75          | 3.96                  | 3.97                 |
| **Stretches of random length, by the rows kept and dropped on average** |        |       |              |             |                   |               |                       |                      |
| 1 text, 4 kept, 30 dropped                                              | 4.34   | 2.57  | 2.69         | 2.61        | 3.81              | 2.57          | 2.69                  | 2.62                 |
| 4 texts, 4 kept, 30 dropped                                             | 7.25   | 5.58  | 5.59         | 5.42        | 6.35              | 5.68          | 5.53                  | 5.34                 |
| 1 number, 4 kept, 30 dropped                                            | 3.75   | 1.95  | 1.89         | 1.85        | 3.32              | 1.99          | 1.89                  | 1.78                 |
| 7 numbers, 4 kept, 30 dropped                                           | 5.48   | 4.99  | 3.38         | 3.34        | 4.73              | 4.90          | 3.28                  | 3.29                 |
| 31 numbers, 4 kept, 30 dropped                                          | 19.20  | 34.25 | 16.53        | 13.76       | 18.40             | 34.83         | 15.12                 | 14.91                |
| 4 decimals, 4 kept, 30 dropped                                          | 5.38   | 4.58  | 3.85         | 3.28        | 4.66              | 4.63          | 3.83                  | 3.24                 |
| 1 text, 8 kept, 8 dropped                                               | 6.27   | 4.33  | 4.98         | 4.68        | 5.69              | 3.42          | 3.87                  | 3.74                 |
| 4 texts, 8 kept, 8 dropped                                              | 13.39  | 12.33 | 12.87        | 11.46       | 13.18             | 4.55          | 5.19                  | 4.96                 |
| 1 number, 8 kept, 8 dropped                                             | 5.02   | 2.63  | 3.42         | 2.67        | 4.70              | 1.84          | 1.96                  | 1.87                 |
| 7 numbers, 8 kept, 8 dropped                                            | 10.46  | 8.48  | 7.84         | 7.37        | 9.80              | 3.36          | 3.61                  | 3.50                 |
| 31 numbers, 8 kept, 8 dropped                                           | 43.64  | 52.27 | 41.54        | 40.46       | 43.75             | 14.18         | 14.57                 | 14.07                |
| 4 decimals, 8 kept, 8 dropped                                           | 9.20   | 11.70 | 8.06         | 7.71        | 9.56              | 3.57          | 3.23                  | 3.38                 |
| 1 text, 32 kept, 32 dropped                                             | 6.41   | 3.85  | 4.46         | 4.39        | 6.27              | 3.20          | 4.00                  | 3.85                 |
| 4 texts, 32 kept, 32 dropped                                            | 13.42  | 11.45 | 11.76        | 10.95       | 13.65             | 4.40          | 4.71                  | 4.63                 |
| 1 number, 32 kept, 32 dropped                                           | 4.56   | 2.58  | 2.19         | 2.24        | 4.87              | 1.79          | 1.56                  | 1.61                 |
| 7 numbers, 32 kept, 32 dropped                                          | 8.58   | 7.97  | 5.99         | 7.42        | 9.48              | 3.34          | 2.75                  | 3.04                 |
| 31 numbers, 32 kept, 32 dropped                                         | 43.02  | 47.83 | 38.47        | 39.56       | 42.99             | 14.09         | 10.48                 | 10.90                |
| 4 decimals, 32 kept, 32 dropped                                         | 9.28   | 8.42  | 5.78         | 5.83        | 9.65              | 3.74          | 2.66                  | 2.91                 |
| 1 text, 200 kept, 200 dropped                                           | 5.86   | 3.42  | 2.29         | 2.33        | 6.14              | 3.05          | 1.92                  | 1.93                 |
| 4 texts, 200 kept, 200 dropped                                          | 13.79  | 10.25 | 5.11         | 5.00        | 13.68             | 3.92          | 2.59                  | 2.69                 |
| 1 number, 200 kept, 200 dropped                                         | 4.41   | 2.35  | 1.89         | 1.91        | 4.76              | 1.62          | 1.50                  | 1.42                 |
| 7 numbers, 200 kept, 200 dropped                                        | 8.80   | 6.02  | 4.68         | 4.64        | 9.50              | 2.65          | 2.47                  | 2.39                 |
| 31 numbers, 200 kept, 200 dropped                                       | 39.06  | 43.43 | 30.49        | 31.36       | 39.68             | 11.78         | 9.03                  | 8.53                 |
| 4 decimals, 200 kept, 200 dropped                                       | 8.49   | 6.60  | 4.40         | 4.78        | 9.13              | 3.38          | 2.50                  | 2.53                 |
| 1 text, 6 kept, 1.2 dropped                                             | 10.47  | 5.49  | 8.16         | 8.00        | 10.41             | 4.57          | 6.71                  | 6.97                 |
| 4 texts, 6 kept, 1.2 dropped                                            | 25.14  | 17.81 | 28.48        | 22.82       | 24.23             | 6.42          | 8.31                  | 7.78                 |
| 1 number, 6 kept, 1.2 dropped                                           | 7.60   | 2.83  | 4.12         | 2.92        | 7.62              | 1.98          | 2.25                  | 1.94                 |
| 7 numbers, 6 kept, 1.2 dropped                                          | 18.33  | 10.33 | 16.93        | 12.28       | 18.31             | 3.89          | 4.55                  | 3.95                 |
| 31 numbers, 6 kept, 1.2 dropped                                         | 63.67  | 56.03 | 60.42        | 57.15       | 63.03             | 16.80         | 17.36                 | 16.69                |
| 4 decimals, 6 kept, 1.2 dropped                                         | 15.47  | 14.79 | 13.05        | 12.97       | 16.97             | 5.08          | 4.87                  | 4.76                 |
| 1 text, 12 kept, 1.2 dropped                                            | 8.21   | 5.47  | 7.02         | 6.31        | 8.30              | 4.89          | 5.02                  | 5.13                 |
| 4 texts, 12 kept, 1.2 dropped                                           | 19.65  | 19.25 | 20.99        | 18.56       | 18.32             | 7.02          | 7.05                  | 5.83                 |
| 1 number, 12 kept, 1.2 dropped                                          | 6.12   | 2.83  | 4.06         | 2.95        | 5.40              | 2.09          | 2.32                  | 1.90                 |
| 7 numbers, 12 kept, 1.2 dropped                                         | 13.31  | 13.27 | 12.43        | 10.87       | 12.80             | 3.91          | 4.49                  | 4.02                 |
| 31 numbers, 12 kept, 1.2 dropped                                        | 54.60  | 57.78 | 55.63        | 52.05       | 54.72             | 17.52         | 16.32                 | 16.74                |
| 4 decimals, 12 kept, 1.2 dropped                                        | 16.51  | 15.38 | 12.06        | 12.53       | 14.50             | 4.55          | 4.58                  | 4.57                 |
| 1 text, 60 kept, 1.5 dropped                                            | 6.18   | 5.56  | 4.12         | 4.16        | 5.78              | 4.31          | 3.17                  | 3.16                 |
| 4 texts, 60 kept, 1.5 dropped                                           | 14.32  | 17.56 | 12.23        | 12.29       | 13.34             | 5.92          | 4.64                  | 4.37                 |
| 1 number, 60 kept, 1.5 dropped                                          | 5.01   | 2.94  | 2.81         | 2.98        | 4.65              | 1.99          | 1.92                  | 1.84                 |
| 7 numbers, 60 kept, 1.5 dropped                                         | 10.87  | 12.41 | 10.01        | 8.48        | 10.23             | 3.97          | 3.55                  | 3.62                 |
| 31 numbers, 60 kept, 1.5 dropped                                        | 51.21  | 55.34 | 50.67        | 48.77       | 50.07             | 16.58         | 14.57                 | 14.80                |
| 4 decimals, 60 kept, 1.5 dropped                                        | 13.66  | 16.27 | 12.10        | 10.72       | 13.04             | 5.17          | 4.18                  | 3.67                 |

The suite's case reads 6.03 ms for the third round against 5.29 for the
second in that table, and the two run the same code on it (text by
Arrow's kernel with the list, numbers by the table). With each version
run alone in the paired tool (101 calls, three passes, the middle one)
they take the same time: 5.4 and 4.9 ms for the two copies of the third
round against 5.3 to 5.6 for three copies of the second; "before" 7.1
and 7.3, #969 4.6 to 5.1, and 3.6 and 4.1 with the unchecked change. So
the 6.03 is one build's reading. Against #969 the third round's readings
on this case run from level (4.9 and 5.4 ms against 4.6 to 5.1, each
version alone) through a tenth slower (0.77 and 0.79 of "before" against
0.70, paired, at 100,000 rows) to a quarter slower (6.03 against 4.83 as
programs of their own). On the M1 in the first round the same way of
copying the text was 26% slower than #969 and 18% faster than before it
(3.46 ms against 2.75 and 4.24).

The benchmark's line with 93% of the rows kept is different, and is a
real loss to the second round. Its mask repeats (16 rows kept, 1 dropped,
less 1%). Run alone the same way: "before" 7.7 and 8.5 ms, #969 5.7 to
6.0, the second round 4.5 to 4.9, the third round 6.3 and 6.4, and 3.6
and 4.4 with the unchecked change. That is taken up under "What #971
gives back".

**Fresh memory can cost more than the copy.** The benchmark prints page
faults per call. When a call's output buffers come fresh from the system
(the allocator did not reuse what the last call freed), each MB costs
about 0.2 ms on the M1 before a byte is copied. Whether that happens
depends on the allocator's state, not on `filter`: with the allocator left
as it comes, the same program gave 4.4 and 29.0 ms for one case (400-byte
text in stretches of 1,000) in two runs minutes apart. So the tables here
hold freed memory on to (`GLIBC_TUNABLES` with `mmap_max=0`, a large
`trim_threshold` and `top_pad`, and `arena_max=1` so that every thread
takes its memory from the one place), and a line that still shows page
faults is compared only with another that does.

### What #971 gives back, and the ways to get it back

Two things are given back: short text to #969, and some shapes of table
to #971's own second round. Each is set out with its numbers, and then
the two ways to get the first one back.

**To #969: short text whose kept rows come a few at a time.** This is the
suite's case, and the one kind of series where #969's own loop beat
Arrow's kernel even with Arrow's check on top. #971 sends that text back
to the kernel (the first round, cause 1), and neither later round changed
that. The third round's runs for this (174 kinds of series with text:
the benchmark's own, text of 6, 24, 120 and 400 bytes with and without
gaps, and 1 to 8 text columns with rows kept at random and in stretches
of random length; two copies of the third round; 15 rounds a line at
1,000,000 rows, 61 at 100,000, 9 on four cores; a line counts when both
copies are more than 3 points from #969):

| 174 kinds of series with text | third round faster than #969 | slower | how much slower (lowest, middle, highest) |
| ----------------------------- | ---------------------------- | ------ | ----------------------------------------- |
| 1,000,000 rows, one core      | 104                          | 30     | 2%, 11%, 37%                              |
| 100,000 rows, one core        | 103                          | 47     | 2%, 20%, 88%                              |
| 1,000,000 rows, four cores    | 98                           | 30     | 3%, 19%, 65%                              |

The slower ones are all text of 6 bytes, or of 24 bytes with gaps, with
kept rows that come under 32 to a stretch and, on all but a few, half
the rows or more kept. The widest gap is one 6-byte text column with
gaps and 85% of the rows kept at random: 0.44 of "before" with #969 and
0.78 to 0.86 with the third round at 100,000 rows (0.58 against 0.72 to
0.73 at 1,000,000). The lines it is faster on are the ones #969 made
slower than before (longer text, letters of more than one byte), text
in long stretches, and text with few rows kept.

Some of those lines, as ratios to "before" (the lowest and the highest
of the two copies; "unchecked" is the prepared change described below):

| text (ratios to "before")                                  | #969, 1M rows | third round, 1M | unchecked, 1M | #969, 100k rows | third round, 100k | unchecked, 100k | #969, 4 cores | third round, 4 cores | unchecked, 4 cores |
| ---------------------------------------------------------- | ------------- | --------------- | ------------- | --------------- | ----------------- | --------------- | ------------- | -------------------- | ------------------ |
| 6-byte text, 56% kept (the suite's case)                   | 0.65          | 0.67 to 0.82    | 0.59 to 0.66  | 0.66            | 0.72 to 0.76      | 0.58 to 0.61    | 0.46          | 0.50 to 0.52         | 0.38 to 0.42       |
| the same, 1% kept                                          | 0.41          | 0.38 to 0.41    | 0.38          | 0.26            | 0.29 to 0.30      | 0.27 to 0.29    | 0.42          | 0.40 to 0.42         | 0.43 to 0.44       |
| the same, 93% kept                                         | 0.75          | 0.68 to 0.70    | 0.55 to 0.61  | 0.71            | 0.73              | 0.45 to 0.55    | 0.57          | 0.52 to 0.55         | 0.34 to 0.35       |
| the same, every other row                                  | 0.86          | 0.85 to 0.92    | 0.78 to 0.81  | 0.95            | 0.82 to 0.83      | 0.80 to 0.81    | 0.66          | 0.54 to 0.60         | 0.52 to 0.58       |
| the same, half kept in stretches of 4                      | 0.71          | 0.81 to 0.85    | 0.61 to 0.65  | 0.84            | 0.95 to 1.06      | 0.53 to 0.71    | 0.45          | 0.54 to 0.55         | 0.36 to 0.37       |
| the same, in stretches of 8                                | 0.66          | 0.72 to 0.73    | 0.51 to 0.53  | 0.63            | 0.97 to 0.98      | 0.46 to 0.52    | 0.44          | 0.52 to 0.55         | 0.29 to 0.30       |
| the same, in stretches of 16                               | 0.79          | 0.85            | 0.62 to 0.63  | 0.59            | 0.70 to 0.83      | 0.38            | 0.50          | 0.54 to 0.59         | 0.35 to 0.38       |
| 1,000 series of 1,000 rows                                 | 0.85          | 0.89 to 0.93    | 0.78 to 0.81  | 0.76            | 1.14 to 1.17      | 0.65 to 0.91    | 0.84          | 0.88 to 0.92         | 0.74 to 0.81       |
| `filter` with a closure                                    | 0.75          | 0.84 to 0.85    | 0.70 to 0.71  | 0.85            | 0.89 to 1.05      | 0.73 to 0.81    | 0.55          | 0.59                 | 0.49 to 0.51       |
| one text column of 6 bytes, 25% kept at random             | 0.88          | 0.71 to 0.76    | 0.69          | 0.74            | 0.67 to 0.69      | 0.52 to 0.67    | 0.53          | 0.52 to 0.55         | 0.52 to 0.54       |
| the same, 50% kept                                         | 0.63          | 0.64 to 0.79    | 0.56 to 0.58  | 0.73            | 0.59 to 0.78      | 0.59 to 0.68    | 0.49          | 0.50 to 0.57         | 0.41 to 0.42       |
| the same, 75% kept                                         | 0.73          | 0.85 to 0.86    | 0.60          | 0.96            | 0.69 to 0.70      | 0.45 to 0.59    | 0.47          | 0.53 to 0.56         | 0.35               |
| the same, 85% kept                                         | 0.82          | 0.86 to 0.87    | 0.60 to 0.68  | 0.57            | 0.77 to 0.78      | 0.42 to 0.50    | 0.44          | 0.58 to 0.59         | 0.30 to 0.32       |
| the same, 93% kept                                         | 0.83          | 0.77 to 0.81    | 0.56 to 0.61  | 0.81            | 0.87 to 0.88      | 0.62 to 0.67    | 0.46          | 0.45 to 0.47         | 0.32 to 0.34       |
| four text columns of 6 bytes, 50% kept at random           | 0.88          | 0.81 to 0.87    | 0.78 to 0.82  | 0.94            | 0.88 to 0.89      | 0.78 to 0.81    | 0.36          | 0.34 to 0.35         | 0.33 to 0.34       |
| the same, 85% kept                                         | 0.78          | 0.91 to 0.92    | 0.58 to 0.61  | 0.75            | 0.90 to 0.91      | 0.50 to 0.53    | 0.30          | 0.30 to 0.31         | 0.23 to 0.24       |
| eight text columns of 6 bytes, 85% kept at random          | 0.96          | 0.88 to 0.89    | 0.57 to 0.62  | 0.82            | 0.94 to 0.95      | 0.57 to 0.63    | 0.33          | 0.29 to 0.32         | 0.19 to 0.20       |
| four text columns of 24 bytes, 85% kept at random          | 1.41          | 0.90 to 0.91    | 0.77 to 0.80  | 1.26            | 0.92              | 0.73            | 0.43          | 0.29 to 0.31         | 0.27               |
| four text columns of 6 bytes with gaps, 85% kept at random | 0.68          | 0.90 to 0.93    | 0.47 to 0.48  | 0.62            | 0.87 to 0.88      | 0.44            | 0.23          | 0.29 to 0.30         | 0.17 to 0.18       |
| one text column, 8 kept and 8 dropped on average           | 0.63          | 0.67 to 0.68    | 0.55 to 0.59  | 0.70            | 0.79 to 0.84      | 0.57 to 0.58    | 0.48          | 0.55 to 0.61         | 0.38               |
| the same, 12 kept and 1.2 dropped                          | 0.78          | 0.79 to 0.83    | 0.57 to 0.61  | 0.88            | 0.71 to 0.90      | 0.54 to 0.55    | 0.56          | 0.55                 | 0.36 to 0.38       |
| the same, 24 kept and 24 dropped                           | 0.73          | 0.73 to 0.78    | 0.55          | 0.64            | 0.89 to 0.93      | 0.50 to 0.52    | 0.53          | 0.52 to 0.62         | 0.38               |
| the same, 64 kept and 64 dropped                           | 0.69          | 0.54 to 0.56    | 0.52 to 0.54  | 0.59            | 0.46 to 0.47      | 0.48 to 0.49    | 0.51          | 0.40 to 0.42         | 0.38 to 0.39       |
| 24-byte text, 56% kept                                     | 0.99          | 0.92 to 1.01    | 0.82 to 0.88  | 0.95            | 0.77 to 0.83      | 0.70 to 0.71    | 0.67          | 0.59 to 0.61         | 0.49 to 0.51       |
| 120-byte text, 56% kept                                    | 1.20          | 0.83 to 0.85    | 0.73 to 0.77  | 1.32            | 0.91 to 0.96      | 0.84 to 0.89    | 1.30          | 0.80 to 0.87         | 0.85 to 0.86       |
| 400-byte text, 56% kept                                    | 1.37          | 0.93 to 0.95    | 0.86 to 0.93  | 1.49            | 0.97 to 0.98      | 0.93 to 0.94    | 1.43          | 0.88 to 0.90         | 0.89 to 0.91       |
| 24 bytes in 2-byte letters, 56% kept                       | 1.52          | 0.90            | 0.77 to 0.83  | 1.99            | 0.74 to 0.84      | 0.65 to 0.76    | 1.22          | 0.60 to 0.66         | 0.53 to 0.55       |
| 60 bytes in 3-byte letters, 56% kept                       | 2.50          | 0.89 to 0.90    | 0.77 to 0.79  | 3.02            | 0.81 to 0.86      | 0.71 to 0.82    | 2.04          | 0.68 to 0.72         | 0.62 to 0.68       |

At 100,000 rows that table is one run's reading, and a second run can
read the third round 15 to 30 points of "before" lower on a line, on both
copies at once (two copies in one run share that run's layout in memory,
so a second copy does not catch this). Eight lines again, 121 rounds,
with "before" linked in twice (ratios to the mean of its two copies):

| 100,000 rows (ratios to "before")                  | #969 | second round | third round | unchecked  |
| -------------------------------------------------- | ---- | ------------ | ----------- | ---------- |
| 6-byte text, 56% kept (the suite's case)           | 0.70 | 0.80         | 0.77, 0.79  | 0.57, 0.60 |
| the same, half kept in stretches of 4              | 0.62 | 0.84         | 0.83, 0.77  | 0.53, 0.56 |
| the same, in stretches of 8                        | 0.60 | 0.83         | 0.80, 0.78  | 0.49, 0.48 |
| 1,000 series of 1,000 rows                         | 0.72 | 0.83         | 0.87, 0.85  | 0.65, 0.63 |
| one text column, 24 kept and 24 dropped on average | 0.63 | 0.77         | 0.74, 0.74  | 0.47, 0.46 |
| four text columns, the same                        | 0.75 | 0.90         | 0.90, 0.90  | 0.50, 0.49 |
| five more number columns and no text, 56% kept     | 0.79 | 0.85         | 0.80, 0.77  | 0.79, 0.82 |
| the same, 25% kept                                 | 0.97 | 0.77         | 0.78, 0.80  | 0.76, 0.75 |

So at 100,000 rows the third round is not above "before" on the 1,000
small series or on text in stretches of 4 and 8, as the first run had it
(1.14 to 1.17, 0.95 to 1.06 and 0.97 to 0.98). Its loss to #969 on the
six text lines is 10 to 34% here, where the first run's readings give 9
to 56%. The count table's "how much slower" at 100,000 rows comes from
that first run, and its high end should be read with this beside it.

On the M1 in the first round (Linux VM, one core, whole call, ms; a lab
build of #969 in which only the text copy changes, so the middle column
stands for #971 on these scattered cases):

| text, 56% kept unless said | #969  | text by Arrow's kernel | #969's loop, unchecked |
| -------------------------- | ----- | ---------------------- | ---------------------- |
| 6 bytes, ASCII (the suite) | 2.75  | 3.46                   | 2.08                   |
| the same, 93% kept         | 3.18  | 2.88                   | 2.02                   |
| the same, 1% kept          | 0.54  | 0.48                   | 0.53                   |
| 12 bytes, ASCII            | 2.94  | 3.39                   | 2.14                   |
| 24 bytes, ASCII            | 3.69  | 3.37                   | 2.66                   |
| 120 bytes, ASCII           | 8.16  | 4.80                   | 4.90                   |
| 24 bytes in 2-byte letters | 10.63 | 3.38                   | 2.65                   |

Before #969 the suite's case took 4.24 there.

**To its own second round, on masks that repeat.** The second round's
rules were set on masks that repeat and are faster there than the third
round's on some kinds of table. Over the 249 lines whose masks repeat,
the third round (its two copies together) read more than 10% over the
second on 29 lines at 1,000,000 rows, 32 at 100,000 and 27 on four
cores, and more than 10% under it on 6, 16 and none. The second round
was linked in once, and two copies of one source are more than 10% apart
on 8 to 31 of these lines, so one run's count says where to look and no
more. 27 lines read more than 10% over in at least two of the three
runs. 23 of them fall into three families, each tied to a rule that
changed:

- **One text column with 85 to 93% of the rows kept** (10 lines: 6- and
  24-byte text, with gaps and without): 1.10 to 1.38 of the second
  round. The second round sent such text to Arrow's kernel without its
  list. That is the faster on a mask that repeats, and with rows kept at
  random it was 4% the slower on the middle line ("Third round", above).
  The third round sends the text by the shared list.
- **Tables of 8 to 32 number columns with 8 to 16 rows kept and then one
  dropped, with 16 kept and 16 dropped, or with 93% kept "at random" by
  the old short cycle** (11 lines): 1.10 to 1.20 at 1,000,000 rows and
  on four cores. On these masks the second round copied every word by
  its stretches, and the third round does not: on one core it takes
  Arrow's list for such a table, and where each column has a core of its
  own it copies these words by the table, since a word here holds four
  or five stretches and its rule stops at three. On a mask with no
  pattern the second round's word rule was up to a third slower than no
  rule at all ("The rule for a word, checked one line at a time"). At
  100,000 rows the main run showed it on the 8-column tables only (1.14
  to 1.34), and had the third round ahead on the 32-column ones (0.84 to
  0.90 of the second, which had read 1.03 to 1.23 of "before"). The table
  further down has all three widths again.
- **Four decimal columns with 93% of the rows kept** (2 lines, with gaps
  and without): 1.10 to 1.17 on one core. The second round copied them
  straight from the mask, each word by its stretches; in the third a
  decimal column counts as two toward the eight that make a list worth
  making, so four of them go by the list. On four cores, where every
  column has a core of its own in both rounds and a decimal word goes by
  the same rule in both, the line with gaps still read 1.13 and the one
  without 1.01; no cause was found for the first.

The other four lines (24-byte text at 56% kept; one decimal column at 56%
kept; the benchmark's decimal column with gaps; 4 number columns with 64
kept and one dropped) read 1.12 to 1.20 in two runs and 0.89 to 1.00 in
the third, on routes the two rounds share. No rule ties them and no
cause was found; two copies of one source differ by as much on single
lines, which may be all it is, but that was not shown.

In the main runs every one of the 27 still reads under "before" at
1,000,000 rows, but for one copy of one line at 1.01 (16 number columns
with 8 kept and 1 dropped; the other copy 0.90), and at 100,000 rows two
read level with it or above: that same line (1.03 and 1.12), and 32
number columns with 12 kept and 1 dropped (1.07 and 1.01, where the
second round read 1.23). Read again with two copies of "before" (the
next table), the first is level with "before" at 1,000,000 rows (1.00 on
both copies) and under it at 100,000 (0.92 and 0.89), and the second is
level at 100,000 (1.01 on both; the second round 1.06 and 1.05).

The second family again, with two copies of each round and of "before"
(25 rounds a line at 1,000,000 rows, 121 at 100,000; ratios to the mean
of the two copies of "before"):

| number columns, and the mask       | second round, 1M | third round, 1M | second round, 100k | third round, 100k |
| ---------------------------------- | ---------------- | --------------- | ------------------ | ----------------- |
| 8, 12 kept then 1 dropped          | 0.86, 0.86       | 0.86, 0.84      | 0.69, 0.69         | 0.85, 0.86        |
| 8, 16 kept then 1 dropped          | 0.84, 0.84       | 0.83, 0.82      | 0.76, 0.72         | 0.87, 0.86        |
| 8, 16 kept then 16 dropped         | 0.73, 0.73       | 0.79, 0.80      | 0.64, 0.60         | 0.78, 0.79        |
| 8, 93% kept by the old short cycle | 0.84, 0.84       | 0.85, 0.85      | 0.72, 0.73         | 0.84, 0.88        |
| 16, 8 kept then 1 dropped          | 0.87, 0.87       | 1.00, 1.00      | 0.83, 0.85         | 0.92, 0.89        |
| 16, 12 kept then 1 dropped         | 0.81, 0.83       | 0.93, 0.90      | 0.81, 0.81         | 0.94, 0.90        |
| 16, 16 kept then 1 dropped         | 0.82, 0.83       | 0.90, 0.91      | 0.82, 0.83         | 0.92, 0.92        |
| 16, 93% kept by the old cycle      | 0.79, 0.82       | 0.91, 0.91      | 0.87, 0.87         | 0.94, 0.91        |
| 32, 8 kept then 1 dropped          | 0.91, 0.89       | 1.01, 0.98      | 1.00, 1.00         | 1.07, 1.07        |
| 32, 12 kept then 1 dropped         | 0.85, 0.83       | 0.97, 0.96      | 1.06, 1.05         | 1.01, 1.01        |
| 32, 16 kept then 1 dropped         | 0.87, 0.83       | 0.95, 0.94      | 1.10, 1.08         | 0.93, 0.96        |
| 32, 93% kept by the old cycle      | 0.87, 0.84       | 0.96, 0.97      | 1.06, 1.03         | 0.96, 0.92        |

So this family holds with two copies of each. At 1,000,000 rows the third
round takes 10 to 15% longer than the second on 16 and 32 columns, and
the same time on 8 but for 16 kept and 16 dropped (9% longer). At 100,000
rows it takes 17 to 27% longer on 8 columns and 6 to 14% longer on 16. On
32 columns at 100,000 rows it is the second round that takes longer, by 4
to 15%, but for the line of 8 kept and 1 dropped, where the third round
takes 7% longer and reads 7% above "before".

The first family on the benchmark's own line with 93% of the rows kept
(16 kept, 1 dropped, less 1%; one 6-byte text column beside the key and
`v`), each version run alone in the paired tool at 1,000,000 rows, ms:
"before" 7.7 and 8.5, #969 5.7 to 6.0, the second round 4.5 to 4.9, the
third round 6.3 and 6.4. So on that line the third round takes 30 to 40%
longer than the second and is about a fifth faster than "before". Against
#969 its readings do not agree from run to run: 5 to 12% longer here, 5
to 8% longer in the main run (0.81 and 0.83 of "before" against 0.77), 7
to 9% shorter in the run of the 174 kinds of series with text (0.68 to
0.70 against 0.75, the table above), and 23% longer as programs of their
own (6.76 ms against 5.50, "Measured").

**Why a rule can win on a mask that repeats and lose on one that does
not.** What was measured is the cost: work that goes a stretch at a time
takes from a fifth more to nearly three times as long when the stretches
have random lengths as when they repeat, and about twice as long on the
middle pair. A small program (Arrow's own pieces and nothing of pond-rs;
not in the repo) took pairs of masks over 1,000,000 rows, one that
repeats and one with the same number of kept rows and of stretches in
lengths drawn at random, for eight shapes from 3 kept and 3 dropped to 40
kept and 3 dropped. Four of the pairs, ms, the middle of 41 calls, the
repeating mask first:

| one column, 1,000,000 rows                           | 16 kept, 1 dropped | 8 kept, 1 dropped | 17 kept, 3 dropped | 16 kept, 16 dropped |
| ---------------------------------------------------- | ------------------ | ----------------- | ------------------ | ------------------- |
| Arrow reads the mask into stretches, once            | 0.20, 0.34         | 0.40, 0.58        | 0.15, 0.35         | 0.12, 0.26          |
| the same, kept as a list                             | 0.60, 0.55         | 1.09, 1.07        | 0.49, 0.54         | 0.32, 0.33          |
| a number column copied a stretch at a time           | 0.61, 1.13         | 0.82, 2.13        | 0.64, 1.00         | 0.56, 0.69          |
| the same column by Arrow's kernel with its list      | 1.30, 1.40         | 1.89, 2.30        | 1.28, 1.38         | 1.10, 1.16          |
| a 6-byte text column by the kernel, reading the mask | 2.49, 3.23         | 2.25, 4.79        | 1.91, 3.15         | 3.47, 3.66          |
| the same by the kernel with its list                 | 2.90, 3.32         | 3.18, 4.97        | 2.54, 3.32         | 2.43, 2.48          |

Over the eight pairs, reading the mask into stretches took 1.5 to 2.8
times as long with random lengths on seven (the same on 3 kept and 3
dropped), and the copy a stretch at a time 1.2 to 2.6 times as long on
seven (the same at 40 kept and 3 dropped), while the copy by the list
stayed within 0.90 to 1.21.

For text, Arrow's kernel goes over the kept rows twice, once for where
each string ends and once for its bytes (`filter_bytes`, arrow-select
59.3.1). Given no list it reads the mask both times; given one, the mask
is read once and the list walked twice. On the six pairs with most rows
kept, the way with the list took 0.4 to 0.9 ms longer (16 to 41%) when
the mask repeats. With random lengths that came down to 0.1 to 0.5 ms (3
to 10%), and at 100,000 rows the list was ahead on two of the six, behind
on three and level on one. That is the first family above: the second
round's rule for one text column (the kernel with no list) saves a sixth
to a third of that column's time on a mask that repeats, and a few per
cent or nothing where the lengths are random. The paired runs with each
row kept or dropped at random say the same of one text column (the
kernel with no list from 12% faster to 12% slower, "Third round" above).
With four or eight text columns the list is made once for all of them,
and the third round takes 10 to 17% less time than the second at 85 and
93% kept ("Measured").

The usual explanation is that a processor guesses ahead how each loop
over a stretch will end, and guesses right when the lengths repeat. That
fits these readings, but the guesses themselves were not counted: the
cloud server gives a program no access to the processor's counters (it
has no `perf`, and the system call that opens a counter of wrongly
guessed branches fails).

**To its own second round, on masks with no pattern: one band of wide
tables.** 8, 16 and 32 number columns were timed on 35 shapes of
stretches of random length (105 lines, with two copies of each round and
of "before"; 15 rounds a line at 1,000,000 rows, 61 at 100,000). The
third round over the second, the middle line of each group and the range:

| 8 to 32 number columns, stretches of random length    | lines | 100,000 rows        | 1,000,000 rows      |
| ----------------------------------------------------- | ----- | ------------------- | ------------------- |
| most rows kept (over 80%), 16 rows a stretch or fewer | 15    | 0.89 (0.77 to 0.98) | 0.93 (0.82 to 1.00) |
| most rows kept, 20 rows a stretch and over            | 12    | 0.96 (0.85 to 1.01) | 0.98 (0.94 to 1.04) |
| 80% kept or fewer, under 20 rows a stretch            | 27    | 0.98 (0.88 to 1.24) | 0.98 (0.89 to 1.08) |
| half to three quarters kept, 20 to 32 rows a stretch  | 15    | 1.08 (0.99 to 1.20) | 1.05 (0.99 to 1.20) |
| half to three quarters kept, 40 to 64 rows a stretch  | 12    | 1.03 (0.94 to 1.08) | 1.04 (0.95 to 1.09) |
| a quarter kept or fewer, 20 to 64 rows a stretch      | 15    | 1.00 (0.87 to 1.15) | 1.01 (0.82 to 1.18) |
| 100 rows a stretch and over                           | 9     | 0.98 (0.95 to 1.08) | 1.02 (0.91 to 1.03) |
| all of them                                           | 105   | 0.99                | 0.99                |

Over these tables the two rounds are level on the whole. The third round
is ahead where most rows are kept in short stretches (on the middle line
there the second round read 1.00 of "before" at both sizes, and the third
0.90 and 0.92). It is behind by 5 to 8% on the middle line, and by up to
20%, where half to three quarters of the rows are kept in stretches of 20
to 32 rows: there the second round read 0.86 and 0.85 of "before" and the
third 0.93 and 0.89. That band lies under the third round's bar of 32
rows to a stretch for copying a narrow column straight from the mask, so
a table of eight columns or more takes Arrow's list there, where the
second round copied from the mask. With that bar at 15 rows the band's
middle line came down by 4 to 5 points, more than half of the gap (at 23
rows by 3 points at 100,000 rows and by none at 1,000,000), and other
lines went up ("Considered, not done").

On none of the 105 lines does the third round read above "before" on both
copies, at either size (one line on one copy at 100,000 rows: 1.04 and
0.92). Two copies of one source were more than 5% apart on 18 to 31 of
the 105 lines, so one line of this set says little by itself.

**What it has for that.** With rows kept at random the second round was
slower than before #969 on 19 of 431 kinds of table at 1,000,000 rows
and 49 at 100,000, and the third is on none and 3 (both copies; the
three are taken up under "Measured"). The second review's finding (2 to
8 text columns at 85 and 93% kept) went from 0.87 to 1.18 of "before" to
0.83 to 0.97 on one copy and 0.86 to 1.12 on the other. At 100,000 rows
the third round is more than 10% faster than the second on 107 of the
431 lines with no pattern and more than 10% slower on 13; at 1,000,000
rows, on 45 and 21.

**The two ways to get the short text back:**

- **Unchecked** (one `unsafe` block: `StringArray::new_unchecked` on
  pond-rs's own copy of the text, which is what Arrow's kernel does with
  its own). Prepared as the third round's code plus that one change. It
  is not part of #971 and not in the repo: the patch is kept with the
  project's working files, and what follows is enough to write it again.

  Text then goes one of three ways, by how many kept rows there are to a
  stretch on average: under 1.5, by Arrow's kernel and the shared list,
  as now; from 32, a stretch at a time through `append_array`, as now;
  between the two, by pond-rs's own copy from the mask's words, handed
  over unchecked.

  Against the third round, over the same 174 kinds of series with text
  (the unchecked change linked in twice as well; a line counts when both
  copies of one are more than 3 points from both copies of the other):

  | 174 kinds of series with text | faster than the third round | slower | faster than #969 | slower | slower than "before" | the middle line, to "before": #969, third round, unchecked |
  | ----------------------------- | --------------------------- | ------ | ---------------- | ------ | -------------------- | ---------------------------------------------------------- |
  | 1,000,000 rows, one core      | 90                          | 2      | 163              | 0      | 0                    | 0.90, 0.83, 0.71                                           |
  | 100,000 rows, one core        | 88                          | 2      | 157              | 1      | 1 (4 on one copy)    | 0.84, 0.81, 0.64                                           |
  | 1,000,000 rows, four cores    | 77                          | 2      | 155              | 1      | 0                    | 0.56, 0.57, 0.43                                           |

  By the shape of the mask (the unchecked change over the third round,
  the middle line of each group, at 1,000,000 rows, at 100,000, and on
  four cores):

  | text, 1 to 8 columns                         | 1,000,000 rows | 100,000 rows | four cores |
  | -------------------------------------------- | -------------- | ------------ | ---------- |
  | 10% of the rows kept at random               | 0.96           | 1.01         | 0.97       |
  | 25%                                          | 1.00           | 1.01         | 0.98       |
  | 50%                                          | 0.90           | 0.95         | 0.91       |
  | 75%                                          | 0.77           | 0.81         | 0.77       |
  | 85%                                          | 0.72           | 0.61         | 0.72       |
  | 93%                                          | 0.81           | 0.73         | 0.84       |
  | 99%                                          | 0.99           | 1.00         | 0.99       |
  | stretches of 3 kept and 3 dropped on average | 0.78           | 0.75         | 0.79       |
  | 8 kept, 8 dropped                            | 0.80           | 0.70         | 0.78       |
  | 24 kept, 24 dropped                          | 0.77           | 0.56         | 0.77       |
  | 12 kept, 1.2 dropped                         | 0.74           | 0.67         | 0.78       |
  | 30 kept, 1.2 dropped                         | 0.79           | 0.71         | 0.81       |
  | 64 kept, 64 dropped (the same code in both)  | 1.00           | 1.00         | 0.98       |
  | 60 kept, 1.5 dropped (the same code)         | 0.91           | 1.02         | 0.98       |
  | 150 kept, 1.5 dropped (the same code)        | 1.00           | 1.08         | 1.02       |
  | 200 kept, 200 dropped (the same code)        | 0.97           | 1.02         | 0.98       |

  The last four rows are how far two builds of the same code read from
  each other here (0.91 to 1.08), and the gain where the code differs
  (0.56 to 0.81) is outside that.

  Some lines read behind the third round in those runs although the two
  run the same code on them. Timed again with "before" linked in twice
  (the third round's two copies, then the unchecked change's, to the mean
  of "before"), they are level or ahead: 400-byte text in stretches of
  1,000, 0.88 and 0.86 against 0.87 and 0.86; one text column with 60
  rows kept and 1.5 dropped on average, 0.70 and 0.68 against 0.64 and
  0.66 (on four cores 0.48 and 0.49 against 0.49 and 0.50); the same with
  150 kept, 0.61 twice against 0.61 and 0.59; 6-byte text with 5% kept at
  random on four cores, 0.58 and 0.61 against 0.58 and 0.57.

  One line did not come level. Two 6-byte text columns with a quarter of
  the rows kept at random, at 100,000 rows, read 0.65 and 0.68 for the
  third round and 0.76 and 0.73 for the unchecked change, as in the first
  run, though both copy that text the same way (the kernel with its
  list). At 1,000,000 rows the same line is 0.75 and 0.76 for both, and
  the 17 other lines that go that way at 100,000 rows read from 10% ahead
  of the third round to 6% behind it. No cause was found.

  As a program of its own (the benchmark, the middle of eleven runs a
  line), the build with the unchecked change is more than 3% faster than
  the third round's on 57 of the 140 lines on one core and 61 on four,
  and more than 3% slower on 30 and 34. Against #969 it is faster on 120
  and 105 and slower on 11 and 12. Of the 30 on one core, 25 have no text
  at all and 4 have text that both builds copy by the same code, which is
  the reading of two builds and not of the change ("Measured" has how far
  two builds of one source read from each other). The one left is
  400-byte text at 56% kept, 12.57 ms against 10.32, whose eleven runs
  went from 8.7 to 16.0 and from 8.9 to 20.0; the paired runs read that
  line 0.86 to 0.93 of "before" for the unchecked change and 0.93 to 0.95
  for the third round. The lines with text, ms:

  | text (1M rows; ms)                               | before | #969  | third round | unchecked | #969, 4 cores | third round, 4 cores | unchecked, 4 cores |
  | ------------------------------------------------ | ------ | ----- | ----------- | --------- | ------------- | -------------------- | ------------------ |
  | 6-byte text, 56% kept (the suite's case)         | 6.99   | 4.83  | 6.03        | 4.33      | 3.88          | 4.52                 | 2.99               |
  | the same, 93% kept                               | 8.51   | 5.50  | 6.76        | 4.24      | 4.33          | 4.90                 | 2.61               |
  | the same, 1% kept                                | 3.05   | 1.27  | 1.19        | 1.17      | 1.29          | 1.16                 | 1.13               |
  | the same, every other row                        | 6.49   | 5.15  | 4.60        | 4.19      | 5.00          | 3.95                 | 3.88               |
  | the same, half kept in stretches of 4            | 6.36   | 3.67  | 4.65        | 3.27      | 3.17          | 4.11                 | 2.16               |
  | the same, in stretches of 8                      | 6.18   | 3.50  | 4.54        | 2.91      | 3.06          | 3.93                 | 1.94               |
  | the same, in stretches of 16                     | 6.08   | 3.67  | 4.19        | 2.56      | 3.14          | 3.77                 | 1.85               |
  | the same, in stretches of 32                     | 5.74   | 3.71  | 3.19        | 2.79      | 3.02          | 2.56                 | 2.41               |
  | the same with gaps, 56% kept                     | 8.47   | 5.43  | 6.84        | 4.77      | 4.72          | 5.88                 | 3.58               |
  | the same with gaps, 93% kept                     | 9.51   | 5.85  | 8.10        | 3.90      | 4.67          | 6.31                 | 2.79               |
  | 24-byte text, 56% kept                           | 7.61   | 7.77  | 6.03        | 5.25      | 7.82          | 6.51                 | 4.98               |
  | 120-byte text, 56% kept                          | 18.03  | 26.19 | 17.39       | 17.49     | 23.75         | 17.23                | 16.13              |
  | 400-byte text, 56% kept                          | 12.85  | 20.00 | 10.32       | 12.57     | 19.78         | 13.78                | 13.22              |
  | 24 bytes in 2-byte letters, 56% kept             | 7.39   | 15.80 | 5.76        | 5.29      | 15.10         | 6.39                 | 5.07               |
  | 60 bytes in 3-byte letters, 56% kept             | 12.92  | 37.36 | 9.61        | 9.24      | 34.77         | 12.93                | 11.16              |
  | 1,000 series of 1,000 rows                       | 7.23   | 5.16  | 6.08        | 4.70      | 5.21          | 6.23                 | 4.73               |
  | `filter` with a closure                          | 8.20   | 6.97  | 6.82        | 5.61      | 5.98          | 6.14                 | 4.86               |
  | one text column, 5% kept at random               | 3.65   | 2.16  | 2.11        | 2.08      | 2.06          | 2.10                 | 2.17               |
  | the same, 25% kept                               | 4.54   | 3.77  | 3.13        | 3.12      | 2.77          | 2.83                 | 2.53               |
  | the same, 50% kept                               | 5.82   | 4.68  | 4.75        | 3.85      | 3.69          | 4.23                 | 3.09               |
  | the same, 85% kept                               | 9.75   | 5.97  | 7.70        | 4.07      | 4.58          | 6.71                 | 3.15               |
  | the same, 97% kept                               | 6.27   | 6.05  | 4.89        | 4.93      | 4.54          | 4.01                 | 4.14               |
  | four text columns, 50% kept at random            | 13.50  | 13.35 | 11.42       | 9.99      | 4.79          | 4.96                 | 4.60               |
  | the same, 85% kept                               | 25.11  | 19.49 | 21.23       | 10.90     | 5.74          | 7.13                 | 4.18               |
  | one text column, 8 kept and 8 dropped on average | 6.27   | 4.33  | 4.68        | 3.11      | 3.42          | 3.74                 | 2.42               |
  | the same, 6 kept and 1.2 dropped                 | 10.47  | 5.49  | 8.00        | 3.94      | 4.57          | 6.97                 | 3.03               |
  | the same, 12 kept and 1.2 dropped                | 8.21   | 5.47  | 6.31        | 3.97      | 4.89          | 5.13                 | 2.96               |
  | the same, 32 kept and 32 dropped                 | 6.41   | 3.85  | 4.39        | 2.68      | 3.20          | 3.85                 | 2.08               |

  What the block rests on. `new_unchecked` asks for what the safe
  constructor would check: offsets that start at 0, never fall and end at
  the length of the bytes; bytes that are UTF-8, with every offset at the
  start of a character; and one gap mark per row. The copy writes whole
  strings of the source one after another (the source is a valid array),
  and its offsets are where those strings start and end. The two lengths
  are asserted in every build before the hand-over, and a debug build,
  and so every test, has Arrow check the finished array in full. Nothing
  in the copy itself is unchecked: it uses ordinary slices and `Vec`
  calls.

  Two things were learned on the way. A first version zero-filled its
  output before copying into it, and was 9 to 17 points behind the kernel
  on 120- and 400-byte text; the one timed here appends with nothing
  zeroed first. And where rows are kept one at a time the kernel's list
  of rows is the faster.

  That last rule, the list where rows are kept one at a time, was set on
  masks that repeat, so it was checked on rows kept at random: 28 kinds
  of series (1 to 8 text columns of 6 and 24 bytes, some with gaps, 10,
  25 and 50% kept) with the rule and without it, two copies of each, at
  both sizes. With a tenth of the rows kept the list is level with the
  own copy or faster than it, by up to a fifth (4 columns of 6-byte text
  at 100,000 rows: 0.67 and 0.65 of "before" by the list, 0.86 and 0.82
  by the own copy; 8 columns of 24-byte text at 1,000,000 rows: 0.91 and
  0.92 against 1.12 and 1.10). With a quarter kept the two are within 8%
  of each other on 1 and 2 columns, either way round; the list is 5 to
  10% faster on 4 and 8 columns of 6-byte text; and the two are within 4%
  on 4 and 8 columns of 24-byte text. At half the rows kept both versions
  take the own copy. So the rule stays as it is: the list under 1.5 kept
  rows to a stretch.

  An owner decision, as before, and the only one that matters to this
  case.

- **A safe special case**: #969's loop with Arrow's check, only where the
  check is cheap. That needs to know the text is plain ASCII, which takes a
  scan of the column's bytes on each call, and on the x86 server it paid
  only for text of about 8 bytes a row or less with half the rows or more
  kept (6 bytes, 56%: 4.04 ms against the kernel's 4.86; 12 bytes: 4.58
  against 4.80; 16 bytes: 5.08 against 4.81; 6 bytes at 33% kept: 3.30
  against 3.34). On the M1 the loop with the check already loses to the
  kernel at 93% kept and at 24 bytes. Timed in a lab build in the first
  round and left out: about 130 lines and three more rules for one narrow
  shape, all of which the unchecked hand-over would replace.

### Considered, not done

Timed in the third round, on masks with no pattern:

- **One loop for every mask**, with the stretch copy in it and each word
  asked. 6% slower on the middle line of nine than the same loop without
  the stretch copy on 1 to 4 number columns with a quarter of the rows
  kept or fewer, and 13 to 14% slower on 1 to 3 decimal columns with a
  tenth kept or fewer. Hence the two loops.
- **A floor in that one loop**: words with under eight kept rows not asked
  about their stretches. It helped only where 5% of the rows were kept.
- **A bar on the share of words the rule takes**, in place of the bar of
  16 rows to a stretch ("What the bar of 16 rows stands in for", above).
  It is one more pass over the mask's words on every call, with the two
  counts for each word that the loop then makes again, and it would
  change which loop is picked on 10 of the 60 masks timed; on nine of
  those the two loops are within 5% of each other. Not built, and the
  pass itself not timed. (The second round listed the same idea, a count
  per mask of the words in stretches, as a way to switch its per-word
  test off. The two loops and the bar of 16 rows are the cheap form of
  it.)
- **A lower bar for copying a narrow column straight from the mask on a
  wide table**: 15 rows to a stretch (with the bar for the loop that asks
  at 15 as well) and 23 rows, in place of 32. Timed on the 105 lines of
  wide tables under "What #971 gives back", two copies of each. On the
  band given back there (half to three quarters of the rows kept, 20 to
  32 rows a stretch) the bar of 15 took 4 to 5% off the middle line (from
  15% off to 1% on over the 15 lines), and the bar of 23 took 3% off at
  100,000 rows and nothing at 1,000,000. Where a quarter of the rows or
  fewer are kept in stretches of 20 to 64 rows, both bars added 2 to 3%
  on the middle line and far more on some: with 24 rows kept and 80
  dropped on average, on 8, 16 and 32 columns at 1,000,000 rows, 6, 20
  and 21% with the bar at 15 and 12, 19 and 25% with it at 23. And at 16
  rows to a stretch with half to three quarters kept, the bar of 15 added
  nothing to 10%. So where the list stops paying turns on the share of
  rows kept as well as on the rows to a stretch: with half the rows or
  more kept it is at about 20 rows, and with a quarter kept it is above 24. One number cannot say that. A bar that also takes the share kept is
  left for the pass on the Mac.
- **A bar of 10 rows to a stretch, in place of 8, for the list of
  stretches when most rows are kept.** A mask of 8 rows kept and then 1
  dropped sits exactly on the bar of 8 and takes the list, and on 16 and
  32 number columns at 1,000,000 rows it then reads level with "before"
  (0.98 to 1.01) where the second round's copy from the mask read 0.87
  to 0.91; at 100,000 rows it reads 0.89 to 0.92 on 16 columns and 1.02
  to 1.10 on 32 ("Measured"). A bar of 10 would send
  that mask the other way. With stretches of random length the list
  already pays at 8 rows to a stretch (0.89 and 0.93 of the second round
  on the middle line of "most rows kept, 16 rows a stretch or fewer"), so
  the bar was set there. Not timed at 10.
- **One text column, most rows kept, by the kernel with no list** (the
  second round's rule, kept for a table with a single text column). On a
  mask that repeats this is the faster by a sixth to a third of the
  column's time; where stretches have random lengths the two are within a
  tenth of each other and either can be ahead ("Why a rule can win on a
  mask that repeats", above). It would win back the first family of
  repeating masks and the benchmark's line with 93% kept, at the price of
  one more rule that counts a table's text columns. Not built in this
  round; a first thing to time on the Mac.
- **A lower column bar for the list where few rows are kept.** With a
  tenth of the rows kept or fewer the list is already the faster at 4
  number columns (by 14 to 23%) and at 2 and 3 decimal columns. It would
  be one more rule, turning on the share kept, for narrow tables with few
  rows kept. Left for the pass on the Mac.
- **The second round's rule for a word (six rows or more to a stretch,
  however many stretches) kept for masks that repeat.** On a mask that
  repeats, a word copied by its stretches beats the table whatever the
  number of stretches;
  with rows kept at random the same rule was up to a third slower ("The
  rule for a word, checked one line at a time"). "Measured" has what the
  third round gives back for this on masks that repeat. Telling the two
  kinds of mask apart would take a pass that looks for a pattern; not
  built. A stretch copy with no branch on the stretch's length (a fixed
  number of rows copied and then cut back, as the table does) might serve
  both; not built, not timed.
- **Text by stretches from 16 or from 64 rows** in place of 32: nothing
  moved by more than two runs differ by.
- **A decimal column's gap marks left to the kernel where rows are kept
  one at a time.** On a table that goes by the list, a decimal column's
  values go by Arrow's kernel and its gap marks are copied from the mask,
  a stretch at a time. "Before" left both to the kernel. Timed after the
  third round was committed, as its source with that one change, on 8
  and 16 decimal columns with gaps and rows kept at random (121 rounds
  at 100,000 rows, 25 at 1,000,000; two copies of each; ratios to the
  mean of two copies of "before", the third round's two copies first
  and then the change's):

  | rows kept | 16 columns, 100,000 rows | 16 columns, 1,000,000  | 8 columns, 100,000     | 8 columns, 1,000,000   |
  | --------- | ------------------------ | ---------------------- | ---------------------- | ---------------------- |
  | 5%        | 0.91, 0.92; 0.81, 0.82   | 0.93, 1.01; 0.77, 0.80 | 0.83, 0.77; 0.72, 0.71 | 0.84, 0.86; 0.75, 0.71 |
  | 10%       | 0.96, 0.96; 0.86, 0.87   | 0.94, 0.92; 0.92, 0.86 | 0.85, 0.94; 0.85, 0.84 | 0.92, 0.90; 0.76, 0.80 |
  | 25%       | 1.02, 1.00; 0.93, 0.93   | 0.98, 0.98; 0.97, 0.95 | 0.98, 0.99; 0.84, 0.89 | 0.88, 0.92; 0.86, 0.90 |
  | 50%       | 0.98, 0.95; 0.97, 0.96   | 0.90, 0.87; 0.97, 0.97 | 0.97, 0.92; 0.94, 0.93 | 0.88, 0.91; 0.96, 0.94 |
  | 75%       | 0.84, 0.82; 0.98, 0.97   | 0.78, 0.78; 0.98, 0.95 | 0.80, 0.81; 0.95, 0.94 | 0.77, 0.78; 0.98, 0.97 |
  | 85%       | 0.61, 0.63; 0.97, 0.97   | 0.59, 0.60; 0.99, 0.95 | 0.61, 0.61; 0.99, 0.96 | 0.60, 0.63; 0.94, 0.93 |
  | 93%       | 0.68, 0.69; 0.98, 0.96   | 0.70, 0.71; 0.98, 0.98 | 0.67, 0.69; 0.98, 0.94 | 0.70, 0.70; 0.93, 0.94 |
  | 99%       | 0.90, 0.91; 0.96, 0.94   | 0.89, 0.89; 0.94, 0.95 | 0.84, 0.85; 0.90, 0.90 | 0.88, 0.86; 0.89, 0.89 |

  So the kernel's copy of the gap marks is the faster only where rows
  are kept one at a time and few of them. With a tenth of the rows kept
  or fewer the change read 4 to 18 points lower (10 on the middle of the
  eight pairs), and with a quarter kept 8 and 12 points lower at 100,000
  rows and 2 at 1,000,000. With half kept the two are level at 100,000
  rows and the copy from the mask is 5 to 9 points the faster at
  1,000,000; with 75 to 93% kept it is 14 to 38 points the faster. In
  stretches of random length the kernel's copy was never the faster (16
  columns with 4 rows kept and 30 dropped: 0.83 and 0.78 against 0.83
  and 0.83 at 100,000 rows, 0.88 and 0.88 against 0.93 and 0.89 at
  1,000,000; with 3 kept and 3 dropped the copy from the mask is 8 and
  12 points the faster). The first two rounds read the same on masks
  that repeat: 16 columns with a tenth of the rows kept, 0.85 to 0.87 by
  the kernel against 0.90 to 0.96, and at 45% kept 0.91 to 1.01 against
  0.83 to 0.94. This is what keeps the third of the three kinds of table
  under "Measured" from reading below "before" at 100,000 rows. A rule
  for it would send the gap marks with the values where the kept rows
  come under 1.5 to a stretch and a quarter of the rows or fewer are
  kept. Not built: it was timed after the third round's code had been
  compared with the code that was timed, and one more rule needs its own
  tests and its lines timed again.

Timed in the first two rounds, on masks that repeat, and not timed again:

- **The count of kept rows in a group of eight looked up in a table**, in
  place of counted (a default x86-64 build has no instruction for the
  count and makes it in about ten steps, eight times a word). Three
  copies of it against three of the second round's code, in two runs:
  nothing that held from one run to the next.
- **Text row by row through a builder** (`append_value`), the other safe
  way to add text with no check: a copy call per row, as the kernel makes,
  so nothing to gain. Not timed.
- **One copy per stretch across words** (a stretch that runs over several
  words copied whole, where the code copies each word's part). No better
  than word by word, and often worse (200 kept then 200 dropped, 8 to 32
  number columns: 0.67 to 0.90 against 0.56 to 0.76).
- **Decimal values by the list on narrower tables.** One decimal column
  with no gaps read 0.75 to 0.83 by the list against 0.63 to 0.73 walked
  (25 to 93% kept); four were level.
- **Gap marks put together a word at a time**, in registers or by a small
  table, in place of a stretch at a time. Two lab runs over decimal and
  true/false columns with gaps: no gain that held from line to line, and
  the table was 13 to 22% slower with 10% of the rows kept.
- **`par.rs` running inline on one thread.** #969 guarded its own split
  with `par::threads() > 1`; the other callers of `par::map`, `par::join`
  and `par::fill_chunks` still hand their work to the pool's one thread
  and wait. Logged as [PND-RSPAR1].

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
    fields, pond-rs reads them. (pond-ts used to mark a value field with
    nulls required, [PND-ARROWREQ]; since #942 both follow the field's
    nullable flag.) No `ordering` and
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

  **R1b is complete** with step 8j (#807, 2026-10-21). Its PLAN.md entry,
  a list of the steps above all marked done, was removed on 2026-11-13.

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
      - J2a outcome (2026-10-31): studies and calendars
        (`crates/pond-wasm/src/study.rs`). `series.study(name, options)`
        is a dispatcher op (so it also runs as a `partitionBy` step, per
        group); index.js adds one method per catalog name from
        `study_names()` on `TimeSeries` and `PartitionedSeries`;
        `studies()` / `studyInfo()` return the catalog JSON exactly
        (`undefined` for no such study, as pond-ts `studyDescriptor`).
        `TradingCalendar` lives in a second Rust table (`free()` +
        finalizer) and crosses as `{"calendar": id}` in `sessions`;
        `fromRules(rules, { from, to })`, `fromSessions`, the lookups,
        `tagSessions`, plus `generateSessions`. Decisions: (1) options a
        study does not have are ignored, as pond-ts's runtime does
        (Python refuses them as its rule for an unexpected keyword; in JS
        a shared `{ high, low, close, volume }` object handed to several
        studies is an ordinary idiom, and pond-ts's types already refuse
        a typo); (2) calendar lookups take a date only as `YYYY-MM-DD`,
        as the Python bridge (the fixture's 32 other texts are checked to
        throw); (3) instants are whole ms. Fixed on the way: a number as
        a duration (`rolling(60000, …)`, `Sequence.every(60000)`, the
        `rolling(sequence, window)` window, `tail`, the smooth window) was
        refused, and a number `maxGap` was silently ignored (every gap
        filled); `numbers()` returned a non-finite value (a
        gap to pond-rs) as itself instead of NaN, which hid gaps from
        study output checks. Check (`test/studies.mjs`, CI `js-bridge`):
        study parity 3,702 matched bit for bit + 827 errors agree + 526
        known refusals (the Rust harness's counts), a planted 1-ulp change
        fails all but 560 cases (those with no finite non-zero output);
        oracle 220/220 within 5e-10; 109/109 descriptors equal pond-ts's,
        109/109 run from their method with defaults; calendar parity
        110/110. Speed, 1M one-minute bars, series in / out, bridge vs
        `@pond-ts/financial` (`scripts/perf-studies.mjs`): sma 4.5 vs
        45.7 ms, ema 2.6 vs 13.0, rsi 10.9 vs 40.9, bollinger 24.8 vs
        98.9, macd 18.3 vs 91.8, atr 9.3 vs 31.1, sessionVwap 9.9 vs
        85.4. Size 6.9 MB raw, 1.26 MB brotli. J2b: `LiveSeries`.
      - J2b outcome (2026-10-31): `LiveSeries`
        (`crates/pond-wasm/src/live.rs`, plain Rust, and `live_js.rs`, the
        exports; pond-rs's `live` feature now on in pond-wasm). One owner
        per root series in a thread-local table; nodes are u32 handles;
        builders go through one dispatcher (op name + JSON args, functions
        as `{"fn": k}`) like the batch ops. JS classes carry pond-ts's
        names (`LiveSeries`, `LiveView`, `LiveAggregation`,
        `LiveRollingAggregation`, `LiveFusedRolling`, `LiveReduce`, the
        `LivePartitioned*` set). Decisions: (1) listeners run after the
        Rust push returns, from its list of outputs, not from inside
        pond-rs's callbacks: a listener can then call the bridge (read,
        build, push) without re-entering a borrowed series; a push from a
        listener is queued until the current one is done, and listener
        errors are isolated with the first rethrown (pond-ts's emit); (2)
        a node function that throws does not stop the push: outputs are
        delivered, then its first exception is rethrown; over history the
        node is removed and the exception rethrown; a function that pushes
        into its own series gets a "busy" error, never a panic; (3)
        number-only rows take dedicated exports (`push1/2/3`, a
        Float64Array batch through `push_series` when ordered and finite)
        and everything else takes JSON; a random-rows differential checks
        both paths agree; (4) `apply(factory)` records the chain once and
        repeats it per partition (no per-partition JS factory, which would
        need a JS call per new partition inside pond-rs's push); (5) a
        reduce built over history emits its first value from a microtask,
        skipped if a push came first, as pond-ts defers it. Differences
        kept: a disposed node cannot be read; `pushJson` has no
        `timeZone`; pushes go into the root only; `cumulative` takes one
        function column (pond-rs's `cumulative_with`); `toTimeSeries`
        takes no name; partitioned fused rolling stats have no
        `windowsCount`; a `map` cell of the wrong type is a gap; a fold
        result that is not a number is NaN. Review (PR #870) fixes: a
        partition's `clear` / `pushJson` reached the root (now every push
        and `clear` on a non-root series is refused; pond-ts pushes into
        the partition itself, which pond-rs's partitions do not take);
        `pushJson` from a listener was not queued (now as `pushMany`;
        `clear` runs at once, both as pond-ts); node functions were held
        in wasm-bindgen's table, so one referring to its series kept it
        alive for good (now kept in the series' own JS array and called
        through one shared callback by series id + index; a gc test pins
        it); node kinds were looked up by `constructor.name` (broke
        subclasses and minifiers; now a field); a second `dispose()` and
        `on()` after dispose threw (now no-ops, as pond-ts). Also
        differences, documented: a node function cannot even read its own
        series during a push (the series is borrowed); reducers are names
        only (pond-rs has no function reducer; pond-ts takes one); keys are
        whole ms. Not changed: the function schema cache compares the
        column list on each call; a pointer check would need pond-rs to
        expose the event's `Arc` schema. Check (`test/live.mjs`, CI
        `js-bridge`): pond-ts's own fixture generator
        (`buildLiveFixture`) run against the bridge, compared with the
        committed fixture: 71/71 cases, 7,961 outputs and 3,596 final rows
        bit for bit, 40 errors agree, the Rust harness's 2 refused nodes
        and 1 refused push; plus 13 checks for throwing functions,
        re-entrancy, the fast path (ordered and unordered random rows),
        partitions, listener order, gc and leaks (a planted strong hold on
        the functions, an unqueued `pushJson` and an unchecked partition
        `clear` each fail them). Planted mistakes: map off by
        1e-12 fails 2 cases + extras, filter inverted fails 16, a -0 to 0
        change on the fast path fails only the extras (2 fixture cases are
        number-only). Speed, 1M events, bridge vs pond-ts
        (`scripts/perf-live.mjs`): push 250 vs 1593 ms, pushMany (1,000 a
        batch) 39 vs 111, rolling 1m avg + 1m buckets 570 vs 2943 (push) /
        365 vs 835 (pushMany), plus a listener on every rolling update
        1338 vs 2647 / 642 vs 875. pond-ts's `push` with
        `retention: { maxAge }` costs ~25 us an event (100k events 2.4 s),
        so the bench runs without retention. Size 7.5 MB raw, 1.39 MB
        brotli (+0.6 MB, +130 KB). Next J3.
      - toJSON speed (2026-10-31): `toJSON()` built each row cell by
        cell across the boundary (1M rows: 227-627 ms, 1.2-2.8x slower
        than pond-ts, much of it GC). Now `series_columns` sends whole
        columns once (key times as `Float64Array`, numbers as their raw
        `Float64Array` with a non-finite value a gap, text as a table of
        distinct strings + `Uint32Array` places, booleans as `Uint8Array`
        0/1/2, lists and decimals as cells) and JS builds the rows in one
        loop, written out per schema with `new Function` so each row is
        one literal (cached per schema + format). Rejected by numbers
        (1M rows, no gc between samples, ms for 1 / 4 number columns /
        number+text+bool): Rust writing JSON text + one `JSON.parse`
        569 / 1421 / 644 (the old path 171 / 576 / 547; the text writer
        also drops `-0`); a generic per-cell loop over the columns 738 /
        428 / 492; column-by-column `push` 170 / 300 / 861; the written-out
        loop 71 / 181 / 127. Freezing rows as pond-ts does would cost
        ~2x, so rows stay unfrozen (a known difference). `rowFormat:
        'object'` now works (it was ignored). Check (`test/tojson.mjs`,
        CI `js-bridge`, which now builds pond-ts): 300 random series x 3
        formats deep-equal (Object.is per cell) to pond-ts's `toJSON` and
        the same JSON text; a planted -0 to 0 and a boolean gap as
        `undefined` each fail it. Speed (`scripts/perf-tojson.mjs`,
        `--expose-gc`, bridge before / after / pond-ts): 1 number column
        227 / 37 / 220 ms, 4 columns 430 / 56 / 216, number + text +
        boolean 593 / 74 / 235, time-range keys 627 / 64 / 224, object
        rows of number + text + boolean - / 73 / 200. Size +5 KB.
        Still differs: the constructor names the key by its kind
        (`time`, `timeRange`, `interval`) whatever the schema says, so a
        renamed key comes back under the default name.
        Review (PR #871) fixes: a column named `__proto__` set an object
        row's prototype (the literal `"__proto__": v`); now written as a
        computed key, an own field like any name (pond-ts refuses
        `__proto__` / `constructor` at construction; the bridge takes
        them, a known difference). Where `new Function` is refused
        (`--disallow-code-generation-from-strings`, Workers, strict CSP)
        toJSON fell over with EvalError; now it checks once and falls back
        to a cell-by-cell loop with the same output (1M rows: 171 / 149 /
        181 / 201 ms, object rows 263; pond-ts ~175-220). The test now
        also runs itself in a child with code generation off, uses names
        that need escaping (quotes, backslash, newline, U+2028, keywords,
        the loop's own variable names), repeated and empty interval
        labels, the reserved names, a decimal column from Arrow and an
        unknown rowFormat. Planted: a plain `"__proto__"` key, -0 to 0 in
        the fallback and `__proto__` by assignment in the fallback each
        fail it. Speed after: 37.7 / 48.7 / 75.8 / 62.1 / 69.1 ms
        (unchanged).
      - J3 outcome (2026-10-31): Node + browser builds, publish, docs.
        Build: one wasm-bindgen `--target web` glue (ES module, explicit
        init) for every platform; `index.js` imports `#wasm`, which
        package.json `imports` maps by the `node` condition to
        `wasm.node.js` (`initSync` from `readFileSync`, so Node imports
        need no await) or `wasm.browser.js` (`await init(new URL(...,
        import.meta.url))`, a top-level await). Public API unchanged, no
        `init()` to call. Why `imports` and not two `exports` entries:
        with top-level await a sibling module runs before the awaiting
        one finishes (checked in Node), so the API module must import the
        loader itself. Rejected: `--target bundler` (needs wasm ESM
        integration, not in Node or plain browsers); an explicit
        `await init()` (would change the API; method installation and
        `version` run at import); inlining the wasm as base64 (+33%).
        Cost: Vite needs `build.target: 'es2022'` and
        `optimizeDeps.exclude` (its default es2020 target refuses
        top-level await; pre-bundling loses the `.wasm`); esbuild leaves
        `new URL` as is, so the `.wasm` is copied next to the bundle.
        Check (`test/browser.mjs`, CI `js-bridge`, Playwright's Chromium):
        an esbuild bundle (browser conditions) in headless Chromium runs a
        workload (constructor, rolling, aggregate, expression filter,
        rsi, bollinger, toJSON both formats, LiveSeries push / pushMany /
        listener, free) and its JSON must equal the Node build's; run
        twice, once plain (`new Function` allowed) and once under CSP
        `script-src 'self' 'wasm-unsafe-eval'` (asserts `new Function` is
        refused, so toJSON takes the plain-loop fallback). A planted
        off-by-one in the fallback fails only the CSP run. The workload
        uses an LCG, not `Math.sin`: Node 22's and Chromium's V8 differ in
        the last bit of `sin`, which first made the run differ. Also
        checked by hand from the `npm pack` tarball: Node import, `vite
        build` + preview and `vite` dev (with the two settings) and a
        no-bundler page with an import map, all equal to Node; webpack
        not tried. Size (unchanged by the target): `.wasm` 7,535,229 B
        raw / 1,393,188 brotli-11 / 2,053,258 gzip-9; glue 36,979 /
        6,301; `index.js` 51,055 / 12,911; loaders < 600 B. wasm-opt
        (binaryen 123 via npm, in the scratchpad; no system wasm-opt):
        -O3 6.12 MB raw / 1.361 MB brotli, -Oz 5.93 / 1.365, i.e. -19%
        raw but -2.3% brotli, ~3 min a run; not adopted (one more pinned
        tool in the release job for 30 KB on the wire). Publish:
        `packages/rs` stays out of the npm workspaces (root `npm ci` /
        `verify` need no Rust); `release.yml` installs Rust + wasm32 +
        wasm-bindgen 0.2.129, checks rs version == pond-ts's, builds and
        runs `npm test` in packages/rs before any publish, then publishes
        it after `--workspaces` with `--provenance`. `private` removed;
        `prepack` copies LICENSE / CHANGELOG / API.md and fails if the
        wasm is not built. CI `js-bridge` adds the browser test, the
        version check and `npm pack --dry-run`. No peer dependency (it
        does not import pond-ts), so the release peer-range sweep does
        not touch it, but its version must be bumped with the others and
        it is not in package-lock.json. First publish is manual: npm's
        `npm trust` docs say "The package you're configuring must already
        exist on the npm registry", so trusted publishing for
        `@pond-ts/wasm` can only be set up after a first publish by hand.
        Docs: JavaScript tabs on the pond-rs index, getting-started,
        finance-studies and live pages (examples run against the packed
        tarball), a new "From JavaScript" page, and a speed table on
        Performance (1M rows, 4-core Xeon 2.1 GHz, Node 22.22,
        2026-10-31): expression filter 11 vs 25 ms, sma 4.3 vs 44.6,
        sessionVwap 7.3 vs 77.4, toJSON 41 vs 175, live push 273 vs 1510,
        rolling + buckets via pushMany 337 vs 944; a function filter 623
        vs 35 (pond-ts with a function, timed apart). llms.txt, the
        versioning page and README now say seven packages.
    - J3: Node + browser builds, npm `@pond-ts/wasm` published on `v*`,
      docs JavaScript tab, speed table vs pond-ts. Built 2026-10-31 (see
      the J3 outcome above); waits on the first manual publish.
      Review (PR #875) fixes: the rs publish step skips with a warning
      while `npm view @pond-ts/wasm` gives E404 (a tag pushed before the
      manual first publish no longer goes red after six packages ship;
      other `npm view` failures still fail); release and CI js-bridge
      pin Rust 1.97.0 and `build.sh` builds `--locked`; `engines` is
      `>=20.19` (`require` of an ES module); esbuild and playwright are
      root devDependencies (they were only hoisted transitive deps);
      Rollup needs a plugin for `new URL(…, import.meta.url)` (docs said
      it did not); no types yet, documented with the `declare module`
      workaround.
      Name (2026-11-21, Peter's choice): npm name changed from
      `@pond-ts/rs` to `@pond-ts/wasm` before anything was published
      (`npm view` gave E404 for both). Why: the name says what a
      JavaScript user installs (a WebAssembly build, browser-ready),
      as `@duckdb/duckdb-wasm` does. Cost accepted: the crate and the
      PyPI package stay `pond-rs`, so not one name everywhere. The folder
      stays `packages/rs` (less churn; only the npm name is public).
      PyPI name (2026-11-22, Peter's choice): `pond-timeseries`, import
      still `pond_rs`. `pond-py` was refused in advance: PyPI's
      `ultranormalize_name` strips `-_.` and maps l/i->1, o->0, so it
      equals the unrelated `pondpy`; `py-pond` likewise equals `pypond`.
      Import name (2026-11-22, Peter's choice): `import pond` from 0.79.0,
      no `pond_rs` alias (0.78.0 had been out hours). Checked first: PyPI's
      `pond` 0.1 (Feb 2025) is an empty placeholder whose wheel installs a
      top-level `pond.py`; the only clash found. Rust keeps `pond_rs`.
    - [PND-RSTYPES] (DONE 2026-11-21): `packages/rs/index.d.ts`,
      hand-written. Decided **not** to import pond-ts's types: `@pond-ts/rs`
      has no dependency on pond-ts, and pond-ts's types follow the schema
      (`get('v')` is `number`), which the bridge's dynamic methods cannot
      promise, so a cell is `Cell`. The study options block (StudyName,
      one options type per study) is generated from `studies()` by
      `scripts/types.mjs` (`--check` fails when stale). `test/types/check.mjs`
      turns every core/study/live parity fixture call into TypeScript and
      compiles it under `tsc --strict` (4,082 core calls, 8,456 study calls,
      1,362 live steps), compiles `test/types/api.ts` (README examples plus
      `@ts-expect-error` mistakes), and checks every runtime export and
      prototype method is declared (619 names); runs in CI's js-bridge job.
      34 fixture study calls pass options the study does not declare;
      pond-ts's own types refuse them too, so the check drops them.
      Same PR: `toColumns()` (pond-ts's columnar object, equal to pond-ts's
      own `toColumns()` on 300 random series, 116 fromColumns round trips),
      the route from the bridge to `@pond-ts/charts`. Chosen over a
      Float64Array variant (~20 ms vs ~75-105 ms at 1M rows) because equal
      output to pond-ts wins and `numbers()`/`times()` already cover the
      typed-array case. And `AGENTS.md` (docs/agents/USING_POND.md) now
      copied into the tarball by prepack, like the other packages.
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
      - Outcome (2026-11-02): built. `.github/workflows/python-wheels.yml`
        builds five abi3 wheels with maturin-action (Linux x86-64 and
        aarch64 in the manylinux2014 container, each on a runner of its own
        CPU, `ubuntu-24.04-arm` for ARM; macOS on `macos-15-intel` and
        `macos-15`; Windows x64) and the sdist, and runs the full pytest
        suite against each built wheel on its own platform (the sdist is
        built into a wheel and tested too, so a file missing from it
        fails). `check-dist` then checks what PyPI would get: five wheels
        with the expected platform tags plus the sdist, all of the expected
        version, `twine check --strict`. It runs on PRs that touch
        `crates/pond-py`, `crates/pond-rs`, the workspace manifests or the
        parity fixtures the tests read; on every `v*` tag (after checking
        the tag equals `crates/pond-py/Cargo.toml`'s version, which CI
        already keeps equal to pond-ts's), `publish-pypi` uploads with
        PyPI trusted publishing (OIDC, environment `pypi`, no token
        stored); a manual run can upload to TestPyPI (environment
        `testpypi`). Decisions: (1) one workflow for CI and release, so the
        files published are the files tested; (2) native ARM and Intel
        runners rather than cross-compiling, so every wheel is tested where
        it runs; (3) `skip-existing` on upload, so a re-run after a partial
        upload sends the rest. ci.yml's `python` job stays (every PR, Python
        3.9 and 3.13). Fixed on the way: the tests read the fixtures with
        the platform's encoding, which fails on Windows (now UTF-8); the
        type hints listed `"minute"` / `"hour"` for `Sequence.calendar`,
        which pond-rs refuses. Checked locally: a manylinux2014 wheel (zig)
        and a wheel built from the sdist each pass all 1,420 tests; `twine
        check` passes; `actionlint` passes. Docs: page
        `website/docs/pond-rs/python.mdx` (install, frames in / out,
        reducers, rolling, `partition_by`, calendar buckets, expressions,
        studies, `LiveSeries`, errors), linked from the pond-rs index and
        the introduction; the package README updated to match. Agent trial
        (`crates/pond-py/agent-trial/`): four tasks (per-host rolling from
        unsorted CSV, New York days across a clock change, RSI + Bollinger
        per symbol, live per-host buckets as they close), graded against
        plain pandas. Weak: run by the agent that wrote the page (no
        subagents in that thread), 4/4 right with polars and with pandas;
        its value is eight traps found and fixed in the docs (pandas'
        index arriving as `__index_level_0__`, NaN refused by `push` but a
        gap in frames, text times in frames, pandas duration words, the
        live partition column ([PND-LIVEKEY]), unstated window edges /
        bucket closing / Bollinger's deviation, the calendar units, a list
        of reducers). Candidates for the bridge, not done: drop pandas'
        index on the way in, NaN as a gap in `push`, Python spelling in
        pond-rs error texts. Owner setup before the first upload: PyPI
        pending trusted publisher for `pond-rs` (owner `pond-ts`, repo
        `pond`, workflow `python-wheels.yml`, environment `pypi`).
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

  - Status 2026-11-13: every step is merged. JavaScript: J1 #859, J1b
    #863, J2a #869, J2b #870, `toJSON` #871, J3 #875. Python: P1 #860, P2a
    #862, P2b #864, P3 #882. Neither package is on its registry yet (npm
    and PyPI both answer "not found" for `@pond-ts/rs` and `pond-rs`). Two
    owner actions are left, and PLAN.md's [PND-RUST-R4] entry now holds only
    those: the first `@pond-ts/wasm` publish by hand, and PyPI's pending
    trusted publisher for `pond-rs`.

  - Status 2026-11-23: both are published, so R4 is done and its PLAN.md
    entry is removed. npm has `@pond-ts/wasm` 0.79.0; PyPI has
    `pond-timeseries` 0.78.0 and 0.79.0 (the PyPI name became
    `pond-timeseries` and the import `import pond`, #956).

- Threading: done in R1a step 4 (per output column). If R1b needs one
  column split across threads, reductions must still give the same bits as
  one thread (fixed chunks, ordered combine).
