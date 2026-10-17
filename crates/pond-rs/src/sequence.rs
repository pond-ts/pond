//! Sequences: the bucket grids `aggregate` reduces into.

use crate::duration::parse_duration;
use crate::error::{PondError, Result};
use crate::series::IntervalKeys;

/// An unbounded grid of buckets. Realised over a concrete range by
/// [`Sequence::buckets_overlapping`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sequence {
    /// Fixed-length steps: buckets `[anchor + k·step, anchor + (k+1)·step)`.
    Every { step_ms: i64, anchor_ms: i64 },
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

    /// The same grid shifted so a bucket starts at `anchor_ms`.
    pub fn with_anchor(self, anchor_ms: i64) -> Self {
        match self {
            Sequence::Every { step_ms, .. } => Sequence::Every { step_ms, anchor_ms },
        }
    }

    /// Every bucket whose extent overlaps the closed range `[begin, end]`,
    /// including the one containing `begin`. This is how pond-ts `aggregate`
    /// realises its grid (`coverage: 'overlap'`).
    ///
    /// pond-ts divides in floating point; this divides exactly in integers.
    /// They agree whenever the quotient is below 2^53 / step, i.e. for any
    /// real timestamp.
    pub fn buckets_overlapping(&self, begin: i64, end: i64) -> IntervalKeys {
        match *self {
            Sequence::Every { step_ms, anchor_ms } => {
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
                keys
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlap_includes_the_bucket_holding_begin() {
        let keys = Sequence::every("5s")
            .unwrap()
            .buckets_overlapping(2_500, 10_000);
        assert_eq!(keys.begin, vec![0, 5_000, 10_000]);
        assert_eq!(keys.end, vec![5_000, 10_000, 15_000]);
        assert_eq!(keys.label, keys.begin);
    }

    #[test]
    fn negative_times_floor_down() {
        let keys = Sequence::every("5s").unwrap().buckets_overlapping(-1, -1);
        assert_eq!(keys.begin, vec![-5_000]);
    }

    #[test]
    fn anchor_shifts_the_grid() {
        let keys = Sequence::every("5s")
            .unwrap()
            .with_anchor(1_000)
            .buckets_overlapping(0, 7_000);
        assert_eq!(keys.begin, vec![-4_000, 1_000, 6_000]);
    }

    #[test]
    fn zero_step_is_rejected() {
        assert!(Sequence::every("0s").is_err());
    }
}
