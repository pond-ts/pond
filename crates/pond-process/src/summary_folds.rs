//! The summary folds (`summary-folds.ts`): one answer over a whole column.
//! Definitions only for now; what each one computes comes in R5 step 3.

use crate::registry::{Def, ParamDef, param_text};

fn one(name: &str, summary: &str, unit: &str) -> Def {
    Def::fold(name, "summary", summary, unit).input("source")
}

/// The summary folds, in `SUMMARY_FOLDS` order.
pub fn summary_folds() -> Vec<Def> {
    vec![
        one(
            "mean",
            "The average of every defined value, with how many there were.",
            "inherit",
        )
        .label(|_, inputs| format!("mean of {inputs}")),
        one(
            "stdev",
            "The population standard deviation of every defined value (divides by n, as pond’s `stdev` reducer does).",
            "inherit",
        )
        .label(|_, inputs| format!("stdev of {inputs}")),
        one(
            "sum",
            "The total of every defined value, with how many there were.",
            "inherit",
        )
        .label(|_, inputs| format!("total of {inputs}")),
        one(
            "count",
            "How many rows hold a value, out of how many rows there are. The gap between the two is missing data or warm-up.",
            "rows",
        )
        .label(|_, inputs| format!("count of {inputs}")),
        Def::fold(
            "percentile",
            "summary",
            "The value below which q percent of the defined values fall (q 5 of daily returns is the one-day 95% value at risk). Linear between ranks.",
            "inherit",
        )
        .param("q", ParamDef::num(50.0).min(0.0).max(100.0).suggest(1.0, 99.0))
        .input("source")
        .label(|p, inputs| format!("p{} of {inputs}", param_text(p, "q"))),
        one(
            "shareTrue",
            "The share of defined rows where a signal is true (non-zero), 0–1. Over a `compare` step it answers \"how often was it above…?\".",
            "ratio",
        )
        .label(|_, inputs| format!("share true of {inputs}")),
        one(
            "lastTrue",
            "When a signal was last true (non-zero), and its value then. Over a crossover column it answers \"when was the last golden cross?\".",
            "inherit",
        )
        .label(|_, inputs| format!("last time {inputs}")),
        one(
            "lastChange",
            "The latest value, when it took that value, and what it was before — \"which way is the trend pointing, and since when?\". Gaps are skipped, not counted as changes.",
            "inherit",
        )
        .label(|_, inputs| format!("last change of {inputs}")),
        Def::fold(
            "events",
            "summary",
            "The dates where a signal is true (non-zero), oldest first — the most recent `limit` of them, with the total count. Over `compare` it lists every time RSI fell below 30.",
            "dates",
        )
        .param("limit", ParamDef::int(50.0).min(1.0).max(400.0).suggest(5.0, 100.0))
        .input("source")
        .label(|p, inputs| format!("dates of {inputs} (≤{})", param_text(p, "limit"))),
        Def::fold(
            "meanWhere",
            "summary",
            "The average of `source` over the rows where `when` is true (non-zero) — the average 10-day forward return after RSI fell below 30. Over a 1/0 source it is a hit rate.",
            "inherit",
        )
        .input("source")
        .input("when")
        .label(|_, inputs| format!("mean where: {inputs}")),
        one(
            "change",
            "The first and last defined values with their dates, the change between them, and that change in percent — \"what was the total return?\".",
            "inherit",
        )
        .label(|_, inputs| format!("change in {inputs}")),
    ]
}
