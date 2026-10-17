//! Sequences: the bucket grids `aggregate` reduces into.

use std::str::FromStr;

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::{Timestamp, ToSpan};

use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::series::IntervalKeys;

/// A calendar unit for [`Sequence::calendar`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalendarUnit {
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

impl FromStr for CalendarUnit {
    type Err = PondError;

    /// pond-ts names: `day`, `week`, `month`, `quarter`, `year`.
    fn from_str(unit: &str) -> Result<Self> {
        Ok(match unit {
            "day" => CalendarUnit::Day,
            "week" => CalendarUnit::Week,
            "month" => CalendarUnit::Month,
            "quarter" => CalendarUnit::Quarter,
            "year" => CalendarUnit::Year,
            _ => {
                return Err(PondError::InvalidData {
                    call: "Sequence::calendar",
                    message: format!(
                        "unknown calendar unit '{unit}' (expected day, week, month, quarter or year; for hours use Sequence::every(\"1h\"))"
                    ),
                });
            }
        })
    }
}

/// An unbounded grid of buckets. Realised over a concrete range by
/// [`Sequence::buckets_overlapping`].
#[derive(Debug, Clone, PartialEq)]
pub enum Sequence {
    /// Fixed-length steps: buckets `[anchor + k·step, anchor + (k+1)·step)`.
    Every { step_ms: i64, anchor_ms: i64 },
    /// Calendar buckets in a time zone: each starts at local midnight of the
    /// unit's first day, so a day can be 23 or 25 hours long.
    Calendar {
        unit: CalendarUnit,
        zone: TimeZone,
        /// First day of a week, ISO numbering: 1 = Monday … 7 = Sunday.
        week_starts_on: i8,
    },
}

impl Sequence {
    /// Fixed-length buckets, anchored at Unix epoch 0, e.g.
    /// `Sequence::every("1m")`. Same as pond-ts `Sequence.every`.
    pub fn every(step: &str) -> Result<Self> {
        Self::every_ms(parse_duration(step)?)
    }

    /// Fixed-length buckets of `step_ms` milliseconds, anchored at epoch 0.
    pub fn every_ms(step_ms: i64) -> Result<Self> {
        if step_ms <= 0 {
            // pond-ts accepts '0s' here and then cannot realise the grid;
            // rejecting it up front is the useful answer.
            return Err(PondError::InvalidData {
                call: "Sequence::every",
                message: format!("step must be positive, got {step_ms} ms"),
            });
        }
        Ok(Sequence::Every {
            step_ms,
            anchor_ms: 0,
        })
    }

    /// Calendar buckets in an IANA time zone, e.g.
    /// `Sequence::calendar("day", "America/New_York")`. Same as pond-ts
    /// `Sequence.calendar(unit, { timeZone })`. Weeks start on Monday; see
    /// [`Sequence::with_week_start`].
    ///
    /// Time-zone rules come from the tz database bundled into pond-rs
    /// ([`tzdb_version`]); pond-ts uses the one in its JavaScript runtime.
    /// If the two disagree about a zone's history, so do the buckets.
    pub fn calendar(unit: &str, time_zone: &str) -> Result<Self> {
        let unit = unit.parse()?;
        let zone = TimeZone::get(time_zone).map_err(|e| PondError::InvalidData {
            call: "Sequence::calendar",
            message: format!("unknown time zone '{time_zone}': {e}"),
        })?;
        Ok(Sequence::Calendar {
            unit,
            zone,
            week_starts_on: 1,
        })
    }

    /// The same grid shifted so a bucket starts at `anchor_ms`. Calendar
    /// sequences have no anchor and are returned unchanged.
    pub fn with_anchor(self, anchor_ms: i64) -> Self {
        match self {
            Sequence::Every { step_ms, .. } => Sequence::Every { step_ms, anchor_ms },
            calendar => calendar,
        }
    }

    /// For calendar weeks: the first day, ISO numbering (1 = Monday … 7 =
    /// Sunday). Fixed sequences are returned unchanged.
    pub fn with_week_start(self, iso_weekday: i8) -> Result<Self> {
        if !(1..=7).contains(&iso_weekday) {
            return Err(PondError::InvalidData {
                call: "Sequence::with_week_start",
                message: format!("week start must be 1 (Monday) to 7 (Sunday), got {iso_weekday}"),
            });
        }
        Ok(match self {
            Sequence::Calendar { unit, zone, .. } => Sequence::Calendar {
                unit,
                zone,
                week_starts_on: iso_weekday,
            },
            every => every,
        })
    }

    /// Every bucket whose extent overlaps the closed range `[begin, end]`,
    /// including the one containing `begin`. This is how pond-ts `aggregate`
    /// realises its grid (`coverage: 'overlap'`).
    ///
    /// pond-ts divides in floating point; this divides exactly in integers.
    /// They agree whenever the quotient is below 2^53 / step, i.e. for any
    /// real timestamp.
    pub fn buckets_overlapping(&self, begin: i64, end: i64) -> Result<IntervalKeys> {
        match self {
            &Sequence::Every { step_ms, anchor_ms } => {
                let first = (begin - anchor_ms).div_euclid(step_ms);
                let last = (end - anchor_ms).div_euclid(step_ms);
                let count = usize::try_from(last - first + 1).unwrap_or(0);
                let mut keys = IntervalKeys {
                    label: Vec::with_capacity(count),
                    begin: Vec::with_capacity(count),
                    end: Vec::with_capacity(count),
                };
                for k in first..=last {
                    let start = anchor_ms + k * step_ms;
                    keys.label.push(start);
                    keys.begin.push(start);
                    keys.end.push(start + step_ms);
                }
                Ok(keys)
            }
            Sequence::Calendar {
                unit,
                zone,
                week_starts_on,
            } => {
                // pond-ts walks from the bucket holding `begin`, one bucket at
                // a time, while the bucket starts at or before `end`.
                let mut keys = IntervalKeys {
                    label: vec![],
                    begin: vec![],
                    end: vec![],
                };
                let mut day = unit_start(*unit, local_date(zone, begin)?, *week_starts_on)?;
                let mut start = midnight_ms(zone, day)?;
                while start <= end {
                    day = advance(*unit, day)?;
                    let next = midnight_ms(zone, day)?;
                    keys.label.push(start);
                    keys.begin.push(start);
                    keys.end.push(next);
                    start = next;
                }
                Ok(keys)
            }
        }
    }
}

/// The version of the tz database bundled into pond-rs, e.g. `"2025b"`.
pub fn tzdb_version() -> Option<&'static str> {
    jiff_tzdb::VERSION
}

fn calendar_error(message: String) -> PondError {
    PondError::InvalidData {
        call: "Sequence::calendar",
        message,
    }
}

/// The local calendar date at instant `ms` in `zone`.
fn local_date(zone: &TimeZone, ms: i64) -> Result<Date> {
    let ts = Timestamp::from_millisecond(ms)
        .map_err(|e| calendar_error(format!("time {ms} ms is out of range: {e}")))?;
    Ok(ts.to_zoned(zone.clone()).date())
}

/// pond-ts `TimeZone.#startDays`: the first day of the unit holding `date`.
fn unit_start(unit: CalendarUnit, date: Date, week_starts_on: i8) -> Result<Date> {
    let out = match unit {
        CalendarUnit::Day => date,
        CalendarUnit::Week => {
            let weekday = date.weekday().to_monday_one_offset();
            let back = (weekday - week_starts_on + 7) % 7;
            date.checked_sub(i64::from(back).days())
                .map_err(|e| calendar_error(e.to_string()))?
        }
        CalendarUnit::Month => date.first_of_month(),
        CalendarUnit::Quarter => {
            let month = date.month();
            Date::new(date.year(), month - (month - 1) % 3, 1)
                .map_err(|e| calendar_error(e.to_string()))?
        }
        CalendarUnit::Year => date.first_of_year(),
    };
    Ok(out)
}

/// pond-ts `TimeZone.#advanceDays`: the first day of the following unit.
fn advance(unit: CalendarUnit, start: Date) -> Result<Date> {
    let span = match unit {
        CalendarUnit::Day => 1.day(),
        CalendarUnit::Week => 7.days(),
        CalendarUnit::Month => 1.month(),
        CalendarUnit::Quarter => 3.months(),
        CalendarUnit::Year => 1.year(),
    };
    start
        .checked_add(span)
        .map_err(|e| calendar_error(e.to_string()))
}

/// The first instant of local day `date` in `zone`, in epoch milliseconds.
/// A midnight skipped by a clock change resolves to the first instant after
/// the gap, and a repeated midnight to the earlier one: Temporal's (and
/// pond-ts's) `'compatible'` rule, which is also jiff's.
fn midnight_ms(zone: &TimeZone, date: Date) -> Result<i64> {
    let zoned = date
        .to_zoned(zone.clone())
        .map_err(|e| calendar_error(e.to_string()))?;
    Ok(zoned.timestamp().as_millisecond())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_includes_the_bucket_holding_begin() {
        let keys = Sequence::every("5s")
            .unwrap()
            .buckets_overlapping(2_500, 10_000)
            .unwrap();
        assert_eq!(keys.begin, vec![0, 5_000, 10_000]);
        assert_eq!(keys.end, vec![5_000, 10_000, 15_000]);
        assert_eq!(keys.label, keys.begin);
    }

    #[test]
    fn negative_times_floor_down() {
        let keys = Sequence::every("5s")
            .unwrap()
            .buckets_overlapping(-1, -1)
            .unwrap();
        assert_eq!(keys.begin, vec![-5_000]);
    }

    #[test]
    fn anchor_shifts_the_grid() {
        let keys = Sequence::every("5s")
            .unwrap()
            .with_anchor(1_000)
            .buckets_overlapping(0, 7_000)
            .unwrap();
        assert_eq!(keys.begin, vec![-4_000, 1_000, 6_000]);
    }

    const NY_2026_03_07: i64 = 1_772_859_600_000; // 00:00 EST

    #[test]
    fn calendar_days_follow_the_clock_change() {
        let days = Sequence::calendar("day", "America/New_York").unwrap();
        // 2026-03-08 is 23 hours long in New York.
        let keys = days
            .buckets_overlapping(NY_2026_03_07 + 5, NY_2026_03_07 + 2 * 86_400_000)
            .unwrap();
        let lengths: Vec<i64> = keys
            .begin
            .iter()
            .zip(&keys.end)
            .map(|(b, e)| e - b)
            .collect();
        assert_eq!(keys.begin[0], NY_2026_03_07);
        assert_eq!(lengths, vec![86_400_000, 82_800_000, 86_400_000]);
    }

    #[test]
    fn calendar_weeks_months_quarters_years() {
        let t = 1_781_049_600_000; // 2026-06-10 00:00 UTC, a Wednesday
        let first = |unit: &str| {
            Sequence::calendar(unit, "UTC")
                .unwrap()
                .buckets_overlapping(t, t)
                .unwrap()
                .begin[0]
        };
        assert_eq!(first("week"), t - 2 * 86_400_000); // Monday 06-08
        assert_eq!(first("month"), 1_780_272_000_000); // 06-01
        assert_eq!(first("quarter"), 1_775_001_600_000); // 04-01
        assert_eq!(first("year"), 1_767_225_600_000); // 01-01
        let sunday = Sequence::calendar("week", "UTC")
            .unwrap()
            .with_week_start(7)
            .unwrap()
            .buckets_overlapping(t, t)
            .unwrap();
        assert_eq!(sunday.begin[0], t - 3 * 86_400_000);
    }

    #[test]
    fn calendar_rejects_unknown_names() {
        assert!(Sequence::calendar("hour", "UTC").is_err());
        assert!(Sequence::calendar("day", "Mars/Olympus").is_err());
    }

    #[test]
    fn zero_step_is_rejected() {
        assert!(Sequence::every("0s").is_err());
    }
}
