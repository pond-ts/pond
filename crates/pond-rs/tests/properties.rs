//! Property tests: pond-rs against plain brute-force answers, on random
//! inputs.
//!
//! `core_parity.rs` checks pond-rs gives exactly pond-ts's answers on
//! hand-picked cases. These tests check a different thing: that both are
//! *right*, on many random inputs neither was written against. Each one
//! recomputes the answer the slow, obvious way (filter the rows, then reduce
//! them) and compares. If one fails, check pond-ts on the same input first:
//! a disagreement here is as likely a pond-ts bug as a pond-rs one.
//!
//! Exact reducers (count, min, max, first, last, median, percentile) must
//! agree exactly. Sum, avg and stdev are compared within a small relative
//! tolerance, because the fast path adds values in a different order.
//!
//! Inputs come from a seeded generator, so a failure names its seed and is
//! reproducible.

use jiff::Timestamp;
use jiff::civil::{Date, Weekday};
use jiff::tz::TimeZone;
use pond_rs::{Agg, CalendarUnit, Column, Key, Reducer, Sequence, TimeSeries};

/// SplitMix64: small, seeded, good enough to vary test inputs.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    /// Uniform in `0..n`.
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
}

const SEEDS: u64 = 300;

/// A random series: non-decreasing times (repeats allowed), one column with
/// some gaps. Values are small integers or have few decimals, sometimes all
/// equal, so ties and flat windows come up often.
fn random_series(rng: &mut Rng) -> (Vec<i64>, Vec<Option<f64>>) {
    let n = rng.below(120) as usize;
    let gap_percent = [0, 10, 50, 95][rng.below(4) as usize];
    let spread = [1, 10, 1000][rng.below(3) as usize];
    let flat = rng.chance(10);
    let mut t = rng.below(10_000) as i64 - 5_000;
    let mut times = Vec::with_capacity(n);
    let mut values = Vec::with_capacity(n);
    for _ in 0..n {
        t += [0, 1, 7, 250, 3_000][rng.below(5) as usize];
        times.push(t);
        values.push(if rng.chance(gap_percent) {
            None
        } else if flat {
            Some(3.25)
        } else {
            Some((rng.below(2 * spread * 100) as f64 - (spread * 100) as f64) / 100.0)
        });
    }
    (times, values)
}

fn series(times: &[i64], values: &[Option<f64>]) -> TimeSeries {
    TimeSeries::new(
        "s",
        times.to_vec(),
        vec![Column::optional("v", values.to_vec())],
    )
    .unwrap()
}

const REDUCERS: [Reducer; 13] = [
    Reducer::Count,
    Reducer::Sum,
    Reducer::Avg,
    Reducer::Min,
    Reducer::Max,
    Reducer::First,
    Reducer::Last,
    Reducer::Median,
    Reducer::Stdev,
    Reducer::Percentile(0.0),
    Reducer::Percentile(37.5),
    Reducer::Percentile(99.9),
    Reducer::Percentile(100.0),
];

fn aggs() -> Vec<Agg> {
    REDUCERS
        .iter()
        .enumerate()
        .map(|(i, r)| Agg::new(format!("r{i}"), "v", *r))
        .collect()
}

/// The obvious answer: `present` are the window's present values in time
/// order. `None` is a gap.
fn naive(reducer: Reducer, present: &[f64]) -> Option<f64> {
    let n = present.len();
    let sorted = || {
        let mut s = present.to_vec();
        s.sort_by(f64::total_cmp);
        s
    };
    let percentile = |q: f64| {
        let s = sorted();
        let rank = q / 100.0 * (n - 1) as f64;
        let (lo, hi) = (rank.floor() as usize, rank.ceil() as usize);
        s[lo] + (s[hi] - s[lo]) * (rank - lo as f64)
    };
    let mean = || present.iter().sum::<f64>() / n as f64;
    match reducer {
        Reducer::Count => Some(n as f64),
        Reducer::Sum => Some(present.iter().sum()),
        _ if n == 0 => None,
        Reducer::Avg => Some(mean()),
        Reducer::Min => present.iter().copied().reduce(f64::min),
        Reducer::Max => present.iter().copied().reduce(f64::max),
        Reducer::First => present.first().copied(),
        Reducer::Last => present.last().copied(),
        Reducer::Median => Some(percentile(50.0)),
        Reducer::Percentile(q) => Some(percentile(q)),
        Reducer::Stdev => {
            let m = mean();
            Some((present.iter().map(|v| (v - m) * (v - m)).sum::<f64>() / n as f64).sqrt())
        }
    }
}

/// Compare one cell. `scale` is the largest magnitude in the window, the
/// size the rounding error of a sum is measured against.
fn check(what: &str, reducer: Reducer, got: Option<f64>, want: Option<f64>, scale: f64) {
    let close = match (got, want) {
        (None, None) => true,
        (Some(g), Some(w)) => match reducer {
            Reducer::Sum | Reducer::Avg | Reducer::Stdev => {
                (g - w).abs() <= 1e-12 * 128.0 * scale.max(1.0)
            }
            _ => g == w,
        },
        _ => false,
    };
    assert!(close, "{what} {reducer:?}: got {got:?}, want {want:?}");
}

#[test]
fn rolling_matches_brute_force() {
    let aggs = aggs();
    for seed in 0..SEEDS {
        let mut rng = Rng(seed);
        let (times, values) = random_series(&mut rng);
        let window_ms = [1, 7, 250, 1_000, 10_000, 1_000_000][rng.below(6) as usize];
        let out = series(&times, &values)
            .rolling(&format!("{window_ms}ms"), &aggs)
            .unwrap();
        assert_eq!(out.key(), &Key::Time(times.clone()), "seed {seed}");
        for (row, &t) in times.iter().enumerate() {
            // (t - window, t], including later rows at the same time.
            let present: Vec<f64> = times
                .iter()
                .zip(&values)
                .filter(|&(&u, _)| u > t - window_ms && u <= t)
                .filter_map(|(_, v)| *v)
                .collect();
            let scale = present.iter().fold(0.0f64, |m, v| m.max(v.abs()));
            for (i, &reducer) in REDUCERS.iter().enumerate() {
                let got = out
                    .column(&format!("r{i}"))
                    .unwrap()
                    .numbers()
                    .unwrap()
                    .get(row);
                let what = format!("seed {seed} window {window_ms}ms row {row}");
                check(&what, reducer, got, naive(reducer, &present), scale);
            }
        }
    }
}

#[test]
fn aggregate_every_matches_brute_force() {
    let aggs = aggs();
    for seed in 0..SEEDS {
        let mut rng = Rng(seed);
        let (times, values) = random_series(&mut rng);
        let mut step = [1, 7, 1_000, 60_000][rng.below(4) as usize];
        // Keep the brute force quick: at most a few thousand buckets.
        let span = times.last().zip(times.first()).map_or(0, |(l, f)| l - f);
        while span / step > 5_000 {
            step *= 10;
        }
        let anchor = rng.below(100_000) as i64 - 50_000;
        let sequence = Sequence::every_ms(step).unwrap().with_anchor(anchor);
        let out = series(&times, &values).aggregate(&sequence, &aggs).unwrap();
        let keys = match out.key() {
            Key::Interval(k) => k.clone(),
            _ => panic!("seed {seed}: aggregate gave non-interval keys"),
        };
        if times.is_empty() {
            assert!(keys.begin.is_empty(), "seed {seed}");
            continue;
        }
        // The grid: every bucket on the anchor's step, back to back, from
        // the one holding the first row to the one holding the last.
        for i in 0..keys.begin.len() {
            assert_eq!((keys.begin[i] - anchor).rem_euclid(step), 0, "seed {seed}");
            assert_eq!(keys.end[i], keys.begin[i] + step, "seed {seed}");
            assert_eq!(
                keys.label.numbers().unwrap()[i],
                keys.begin[i] as f64,
                "seed {seed}"
            );
        }
        assert!(keys.begin[0] <= times[0], "seed {seed}");
        assert!(
            times[times.len() - 1] < keys.end[keys.end.len() - 1],
            "seed {seed}"
        );
        assert!(
            keys.end.windows(2).all(|e| e[1] - e[0] == step),
            "seed {seed}"
        );
        assert!(
            keys.begin[0] + step > times[0],
            "seed {seed}: extra bucket at the start"
        );
        assert!(
            keys.begin[keys.begin.len() - 1] <= times[times.len() - 1],
            "seed {seed}: extra bucket at the end"
        );
        check_buckets(seed, &times, &values, &keys.begin, &keys.end, &out);
    }
}

/// Each bucket's row against the rows with `begin <= t < end`.
fn check_buckets(
    seed: u64,
    times: &[i64],
    values: &[Option<f64>],
    begin: &[i64],
    end: &[i64],
    out: &TimeSeries,
) {
    for (b, (&lo, &hi)) in begin.iter().zip(end).enumerate() {
        let present: Vec<f64> = times
            .iter()
            .zip(values)
            .filter(|&(&t, _)| lo <= t && t < hi)
            .filter_map(|(_, v)| *v)
            .collect();
        let scale = present.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        for (i, &reducer) in REDUCERS.iter().enumerate() {
            let got = out
                .column(&format!("r{i}"))
                .unwrap()
                .numbers()
                .unwrap()
                .get(b);
            let what = format!("seed {seed} bucket {b} [{lo}, {hi})");
            check(&what, reducer, got, naive(reducer, &present), scale);
        }
    }
}

/// Zones with awkward days: DST at 02:00 (New York, London), DST at
/// midnight (Santiago), a half-hour DST shift (Lord Howe), a whole skipped
/// day (Apia, 2011-12-30), no DST (Kolkata), a fixed offset.
const ZONES: [&str; 8] = [
    "UTC",
    "America/New_York",
    "Europe/London",
    "America/Santiago",
    "Australia/Lord_Howe",
    "Pacific/Apia",
    "Asia/Kolkata",
    "+05:30",
];

/// Awkward local days, each with its zone (UTC midnight of that date):
/// Apia's skipped 2011-12-30, New York's spring forward 2015-03-08 and fall
/// back 2015-11-01, Santiago's midnight change 2016-08-14, Lord Howe's half
/// hour 2016-04-03.
const AWKWARD: [(&str, i64); 5] = [
    ("Pacific/Apia", 1_325_203_200_000),
    ("America/New_York", 1_425_772_800_000),
    ("America/New_York", 1_446_336_000_000),
    ("America/Santiago", 1_471_132_800_000),
    ("Australia/Lord_Howe", 1_459_641_600_000),
];

fn zone(name: &str) -> TimeZone {
    match name {
        "+05:30" => TimeZone::fixed(jiff::tz::offset(5) + jiff::SignedDuration::from_mins(30)),
        _ => TimeZone::get(name).unwrap(),
    }
}

fn local_date(ms: i64, tz: &TimeZone) -> Date {
    Timestamp::from_millisecond(ms)
        .unwrap()
        .to_zoned(tz.clone())
        .date()
}

/// Is `date` the first day of a `unit` (weeks start on ISO day `week_start`)?
fn starts_unit(date: Date, unit: CalendarUnit, week_start: i8) -> bool {
    match unit {
        CalendarUnit::Day => true,
        CalendarUnit::Week => {
            date.weekday() == Weekday::from_monday_one_offset(week_start).unwrap()
        }
        CalendarUnit::Month => date.day() == 1,
        CalendarUnit::Quarter => date.day() == 1 && (date.month() - 1) % 3 == 0,
        CalendarUnit::Year => date.day() == 1 && date.month() == 1,
    }
}

/// Calendar buckets, checked from first principles in the zone: each bucket
/// starts at the first instant of a local date that begins a unit, the
/// buckets are back to back, and no unit start is skipped or repeated.
#[test]
fn calendar_buckets_are_whole_local_units() {
    const UNITS: [(&str, CalendarUnit, i64); 5] = [
        ("day", CalendarUnit::Day, 86_400_000),
        ("week", CalendarUnit::Week, 7 * 86_400_000),
        ("month", CalendarUnit::Month, 31 * 86_400_000),
        ("quarter", CalendarUnit::Quarter, 92 * 86_400_000),
        ("year", CalendarUnit::Year, 366 * 86_400_000),
    ];
    // 2011-12-25: a week before Apia's skipped day. Ranges reach ~2016.
    const START: i64 = 1_324_771_200_000;
    for seed in 0..SEEDS {
        let mut rng = Rng(seed);
        let (unit_name, unit, longest) = UNITS[rng.below(UNITS.len() as u64) as usize];
        let week_start = 1 + rng.below(7) as i8;
        // Half the time cross a known awkward day in its own zone, so each
        // one is actually hit; otherwise any zone, anywhere in ~4 years.
        let (zone_name, begin) = if rng.chance(50) {
            let (zone, day) = AWKWARD[rng.below(AWKWARD.len() as u64) as usize];
            (zone, day - rng.below(3 * longest as u64) as i64)
        } else {
            let at = START + rng.below(4 * 365) as i64 * 86_400_000 + rng.below(86_400_000) as i64;
            (ZONES[rng.below(ZONES.len() as u64) as usize], at)
        };
        let end = begin + rng.below(40 * longest as u64) as i64;
        let tz = zone(zone_name);
        let sequence = Sequence::calendar(unit_name, zone_name)
            .unwrap()
            .with_week_start(week_start)
            .unwrap();
        let keys = sequence.buckets_overlapping(begin, end).unwrap();
        let what = format!("seed {seed}: {unit_name} in {zone_name} (week from {week_start})");

        let n = keys.begin.len();
        assert!(n >= 1, "{what}");
        assert!(
            keys.begin[0] <= begin && end < keys.end[n - 1],
            "{what}: does not cover"
        );
        assert!(begin < keys.end[0], "{what}: extra bucket at the start");
        assert!(keys.begin[n - 1] <= end, "{what}: extra bucket at the end");
        for i in 0..n {
            let (b, e) = (keys.begin[i], keys.end[i]);
            assert!(b < e, "{what}: bucket {i} empty");
            assert_eq!(keys.label.numbers().unwrap()[i], b as f64, "{what}");
            if i + 1 < n {
                assert_eq!(e, keys.begin[i + 1], "{what}: bucket {i} not back to back");
            }
            // First instant of its local date. That date starts a unit, or
            // a date the zone skipped just before it did (Apia's week from
            // Friday 2011-12-30 begins on Saturday the 31st).
            let day = local_date(b, &tz);
            let before = local_date(b - 1, &tz);
            assert!(before < day, "{what}: bucket {i} starts mid-day");
            let mut d = day;
            while d > before && !starts_unit(d, unit, week_start) {
                d = d.yesterday().unwrap();
            }
            assert!(d > before, "{what}: bucket {i} starts {day}");
            // No unit start inside the bucket: every day boundary between
            // b and e falls on a date that does not start a unit. Walk the
            // local dates the bucket covers.
            let last = local_date(e - 1, &tz);
            assert!(last >= day, "{what}");
            let mut d = day.tomorrow().unwrap();
            while d <= last {
                assert!(
                    !starts_unit(d, unit, week_start),
                    "{what}: bucket {i} [{b}, {e}) swallows unit start {d}"
                );
                d = d.tomorrow().unwrap();
            }
            // And the next bucket starts on the date right after `last`
            // (or a later one, when dates were skipped, as in Apia).
            assert!(local_date(e, &tz) > last, "{what}: bucket {i} ends mid-day");
        }
    }
}

/// Aggregate over calendar buckets: same brute-force row checks as for
/// fixed steps, on series that straddle DST changes.
#[test]
fn aggregate_calendar_matches_brute_force() {
    let aggs = aggs();
    for seed in 0..SEEDS {
        let mut rng = Rng(seed);
        let unit = ["day", "week"][rng.below(2) as usize];
        // Rows every few hours, over a few weeks around an awkward day (in
        // its zone) or, half the time, in any zone.
        let (awkward_zone, day) = AWKWARD[rng.below(AWKWARD.len() as u64) as usize];
        let zone_name = if rng.chance(50) {
            awkward_zone
        } else {
            ZONES[rng.below(ZONES.len() as u64) as usize]
        };
        let base = day - 10 * 86_400_000;
        let n = rng.below(300) as usize;
        let mut t = base;
        let mut times = Vec::with_capacity(n);
        let mut values = Vec::with_capacity(n);
        for _ in 0..n {
            t += rng.below(3 * 3_600_000) as i64;
            times.push(t);
            values.push((!rng.chance(10)).then(|| rng.below(1000) as f64 / 8.0));
        }
        let sequence = Sequence::calendar(unit, zone_name).unwrap();
        let out = series(&times, &values).aggregate(&sequence, &aggs).unwrap();
        let keys = match out.key() {
            Key::Interval(k) => k.clone(),
            _ => panic!("seed {seed}: aggregate gave non-interval keys"),
        };
        if let (Some(&first), Some(&last)) = (times.first(), times.last()) {
            let want = sequence.buckets_overlapping(first, last).unwrap();
            assert_eq!(keys, want, "seed {seed}");
        }
        check_buckets(seed, &times, &values, &keys.begin, &keys.end, &out);
    }
}

/// A running sum adds each value as it enters the window and subtracts it as
/// it leaves, so rounding errors can pile up over a long series ([PND-ROLLSTD]).
/// Long runs of huge values followed by runs of small ones make that visible:
/// once the huge values have left, a drifted sum is off by far more than
/// the small window's own rounding. The brute force re-adds each short
/// window from scratch, so it cannot drift.
#[test]
fn rolling_sum_does_not_drift() {
    for seed in 0..4 {
        let mut rng = Rng(seed);
        let n: usize = 50_000;
        let times: Vec<i64> = (0..n as i64).map(|i| i * 1_000).collect();
        let values: Vec<Option<f64>> = (0..n)
            .map(|i| {
                let big = (i / 500) % 2 == 0;
                let v = rng.below(1_000_000) as f64 / 997.0;
                Some(if big { v * 1e8 } else { v })
            })
            .collect();
        let aggs = [
            Agg::new("sum", "v", Reducer::Sum),
            Agg::new("avg", "v", Reducer::Avg),
            Agg::new("stdev", "v", Reducer::Stdev),
        ];
        let out = series(&times, &values).rolling("10s", &aggs).unwrap();
        for row in 0..n {
            let present: Vec<f64> = values[row.saturating_sub(9)..=row]
                .iter()
                .filter_map(|v| *v)
                .collect();
            let scale = present.iter().fold(0.0f64, |m, v| m.max(v.abs()));
            for (name, reducer) in [
                ("sum", Reducer::Sum),
                ("avg", Reducer::Avg),
                ("stdev", Reducer::Stdev),
            ] {
                let got = out.column(name).unwrap().numbers().unwrap().get(row);
                let what = format!("seed {seed} row {row}");
                check(&what, reducer, got, naive(reducer, &present), scale);
            }
        }
    }
}

/// Decimal columns: `count`, `first`, `last`, `min`, `max` and `sum` are
/// exact, so they must equal a brute-force answer on the raw `i128`s, even
/// for values far past what an `f64` holds exactly. `avg` goes through
/// `f64`, so it must equal `avg` of a number column of the same values.
#[test]
fn decimal_reducers_are_exact() {
    use pond_rs::{Decimal, DecimalColumn};
    let exact = [
        Reducer::Count,
        Reducer::Sum,
        Reducer::Min,
        Reducer::Max,
        Reducer::First,
        Reducer::Last,
    ];
    for seed in 0..SEEDS {
        let mut rng = Rng(seed);
        let (times, shape) = random_series(&mut rng);
        // Huge values (up to 34 digits, so a window of thousands still
        // fits 38) or small ones with many ties.
        let huge = rng.chance(50);
        let raw: Vec<Option<i128>> = shape
            .iter()
            .map(|v| {
                v.map(|_| {
                    if huge {
                        ((rng.next() >> 8) as i128 * (rng.next() >> 8) as i128)
                            * if rng.chance(50) { -1 } else { 1 }
                    } else {
                        rng.below(7) as i128 - 3
                    }
                })
            })
            .collect();
        // Negative scales and scales past 22 (where to_f64 parses text).
        let scale = rng.below(30) as i8 - 4;
        let s = TimeSeries::new(
            "s",
            times.clone(),
            vec![
                Column::optional(
                    "d",
                    DecimalColumn::from_options(raw.clone(), scale).unwrap(),
                ),
                Column::optional(
                    "f",
                    raw.iter()
                        .map(|v| v.map(|value| Decimal { value, scale }.to_f64()))
                        .collect::<Vec<_>>(),
                ),
            ],
        )
        .unwrap();
        let mut aggs: Vec<Agg> = exact
            .iter()
            .enumerate()
            .map(|(i, &r)| Agg::new(format!("r{i}"), "d", r))
            .collect();
        aggs.push(Agg::new("d_avg", "d", Reducer::Avg));
        aggs.push(Agg::new("f_avg", "f", Reducer::Avg));

        // Brute force over the rows a window or bucket holds.
        let want = |rows: &[usize], reducer: Reducer| -> Option<i128> {
            let present: Vec<i128> = rows.iter().filter_map(|&r| raw[r]).collect();
            match reducer {
                Reducer::Count => Some(present.len() as i128),
                Reducer::Sum => Some(present.iter().sum()),
                Reducer::Min => present.iter().min().copied(),
                Reducer::Max => present.iter().max().copied(),
                Reducer::First => present.first().copied(),
                Reducer::Last => present.last().copied(),
                _ => unreachable!(),
            }
        };
        let check_out = |what: &str, out: &TimeSeries, row: usize, rows: &[usize]| {
            for (i, &reducer) in exact.iter().enumerate() {
                let col = out.column(&format!("r{i}")).unwrap();
                let got = match reducer {
                    Reducer::Count => col.numbers().unwrap().get(row).map(|v| v as i128),
                    _ => {
                        let d = col.decimals().unwrap();
                        assert_eq!(d.scale(), scale, "{what}");
                        d.get(row).map(|d| d.value)
                    }
                };
                assert_eq!(got, want(rows, reducer), "{what} {reducer:?}");
            }
            let bits = |name: &str| {
                out.column(name)
                    .unwrap()
                    .numbers()
                    .unwrap()
                    .get(row)
                    .map(f64::to_bits)
            };
            assert_eq!(bits("d_avg"), bits("f_avg"), "{what} avg");
        };

        let window_ms = [1, 250, 10_000][rng.below(3) as usize];
        let out = s.rolling(&format!("{window_ms}ms"), &aggs).unwrap();
        for (row, &t) in times.iter().enumerate() {
            let rows: Vec<usize> = (0..times.len())
                .filter(|&r| times[r] > t - window_ms && times[r] <= t)
                .collect();
            check_out(&format!("seed {seed} rolling row {row}"), &out, row, &rows);
        }

        let out = s
            .aggregate(&Sequence::every_ms(1_000).unwrap(), &aggs)
            .unwrap();
        let Key::Interval(keys) = out.key() else {
            panic!("interval keys")
        };
        for b in 0..keys.begin.len() {
            let rows: Vec<usize> = (0..times.len())
                .filter(|&r| times[r] >= keys.begin[b] && times[r] < keys.end[b])
                .collect();
            check_out(&format!("seed {seed} bucket {b}"), &out, b, &rows);
        }
    }
}
