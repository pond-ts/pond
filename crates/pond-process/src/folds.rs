//! The standard folds every registry starts with (`folds.ts`). Definitions
//! only for now; what each one computes comes in R5 step 3.

use crate::registry::{Def, ParamDef, param_text};

/// `last`, `extremes`, `percentileRank` and `shape`, in that order.
pub fn standard_folds() -> Vec<Def> {
    vec![
        Def::fold(
            "last",
            "read",
            "The most recent defined value, with its date. The usual way to ask \"what is it now?\".",
            "inherit",
        )
        .input("source")
        .label(|_, inputs| format!("latest {inputs}")),
        Def::fold(
            "extremes",
            "read",
            "The lowest and highest values over the whole series, each with its date.",
            "inherit",
        )
        .input("source")
        .label(|_, inputs| format!("range of {inputs}")),
        Def::fold(
            "percentileRank",
            "read",
            "Where the latest value sits within the series’ own history, as a 0–1 fraction. Answers \"is this unusual?\" without needing a second series to compare against.",
            "%ile",
        )
        .input("source")
        .label(|_, inputs| format!("rank of {inputs}")),
        Def::fold(
            "shape",
            "read",
            "The whole series in at most `points` equal row bins, one point per bin at the bin end time. `how` sums up each bin: `sample` (its last value, the default), `mean`, `median`, `min`, `max`, `minMax` ([time, lo, hi], so a spike always shows) or `minMaxFirstLast` ([time, lo, hi, first, last]). Also reports `first`, `last`, `min` and `max` over the whole series, each { value, at }, to label the line. The honest answer to \"show me the series\" for a caller paying by the token.",
            "inherit",
        )
        .param("points", ParamDef::int(40.0).min(2.0).max(400.0).suggest(20.0, 120.0))
        .param(
            "how",
            ParamDef::choice(
                "sample",
                &["sample", "mean", "median", "min", "max", "minMax", "minMaxFirstLast"],
            ),
        )
        .input("source")
        .label(|p, inputs| {
            format!("shape({}, {}) of {inputs}", param_text(p, "points"), param_text(p, "how"))
        }),
    ]
}
