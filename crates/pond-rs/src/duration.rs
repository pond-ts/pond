//! Duration strings: `"500ms"`, `"5s"`, `"5m"`, `"1h"`, `"1d"`.

use crate::error::{PondError, Result};

/// Parse a duration string to whole milliseconds.
///
/// Same grammar as pond-ts `parseDuration`: one or more ASCII digits, then
/// `ms`, `s`, `m`, `h` or `d`. Signs, spaces and decimals are rejected.
/// `"0s"` parses to 0, as in pond-ts; callers that need a positive length
/// check for it.
pub fn parse_duration(input: &str) -> Result<i64> {
    let invalid = |reason| PondError::InvalidDuration {
        input: input.to_string(),
        reason,
    };
    let digits = input.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return Err(invalid("it must start with a whole number"));
    }
    let (number, unit) = input.split_at(digits);
    let multiplier: i64 = match unit {
        "ms" => 1,
        "s" => 1_000,
        "m" => 60_000,
        "h" => 3_600_000,
        "d" => 86_400_000,
        "" => return Err(invalid("the unit is missing")),
        _ => return Err(invalid("the unit is not one of ms, s, m, h, d")),
    };
    number
        .parse::<i64>()
        .ok()
        .and_then(|n| n.checked_mul(multiplier))
        .ok_or_else(|| invalid("it is too large"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_each_unit() {
        assert_eq!(parse_duration("250ms"), Ok(250));
        assert_eq!(parse_duration("5s"), Ok(5_000));
        assert_eq!(parse_duration("5m"), Ok(300_000));
        assert_eq!(parse_duration("2h"), Ok(7_200_000));
        assert_eq!(parse_duration("1d"), Ok(86_400_000));
        assert_eq!(parse_duration("0s"), Ok(0));
    }

    #[test]
    fn rejects_what_pond_ts_rejects() {
        for bad in ["", "-1s", "1.5s", " 1s", "1 s", "1", "1w", "s", "1S"] {
            assert!(parse_duration(bad).is_err(), "{bad:?} should fail");
        }
    }
}
