//! The basic ops (`basic-ops.ts`): row-by-row arithmetic and logic.
//! Definitions only for now; what each one computes comes in R5 step 3.

use pond_rs::js_number;

use crate::registry::{Def, ParamDef, param_text};

const TESTS: &[&str] = &["above", "below", "atLeast", "atMost", "equal"];

fn two(name: &str, family: &str, summary: &str, unit: &str) -> Def {
    Def::op(name, family, summary)
        .input("left")
        .input("right")
        .output("", unit)
}

/// The basic ops, in `BASIC_OPS` order.
pub fn basic_ops() -> Vec<Def> {
    vec![
        two(
            "add",
            "arithmetic",
            "left + right, row by row. Carries the left input’s unit.",
            "inherit",
        )
        .label(|_, inputs| format!("sum of {inputs}")),
        two(
            "subtract",
            "arithmetic",
            "left − right, row by row (a spread, or a price minus its average). Carries the left input’s unit.",
            "inherit",
        )
        .label(|_, inputs| format!("difference of {inputs}")),
        two(
            "multiply",
            "arithmetic",
            "left × right, row by row (price × volume, or a return × a position). Carries the left input’s unit.",
            "inherit",
        )
        .label(|_, inputs| format!("product of {inputs}")),
        two(
            "divide",
            "arithmetic",
            "left ÷ right, row by row (a pair ratio, or ATR as a share of price). Division by zero is a gap.",
            "ratio",
        )
        .label(|_, inputs| format!("ratio of {inputs}")),
        Def::op(
            "scale",
            "arithmetic",
            "source × factor + offset. ×100 turns a ratio into percent; offset −1 turns a ratio into a change; factor √252 annualises a daily figure. Keeps the input’s unit label, which it cannot know the factor changes.",
        )
        .param("factor", ParamDef::num(1.0).suggest(-100.0, 100.0))
        .param("offset", ParamDef::num(0.0).suggest(-100.0, 100.0))
        .input("source")
        .output("", "inherit")
        .label(|p, inputs| {
            format!("{inputs} × {} + {}", param_text(p, "factor"), param_text(p, "offset"))
        }),
        Def::op(
            "shift",
            "arithmetic",
            "Moves values by `periods` rows. Positive reads the past (yesterday’s close is periods 1); negative reads the future (the close 10 bars ahead is periods −10), for asking what happened after a signal.",
        )
        .param(
            "periods",
            ParamDef::int(1.0).min(-5000.0).max(5000.0).suggest(-20.0, 20.0),
        )
        .input("source")
        .output("", "inherit")
        .label(|p, inputs| {
            let n = p.get("periods").and_then(|v| v.as_f64()).unwrap_or(f64::NAN);
            if n >= 0.0 {
                format!("{inputs} {} rows earlier", js_number(n))
            } else {
                format!("{inputs} {} rows later", js_number(-n))
            }
        }),
        Def::op(
            "compare",
            "logic",
            "Tests source against a fixed value: 1 where the test holds, 0 where not (RSI below 30, a change above 2).",
        )
        .param("test", ParamDef::choice("above", TESTS))
        .param("value", ParamDef::num(0.0))
        .input("source")
        .output("", "signal")
        .label(|p, inputs| {
            format!("{inputs} {} {}", param_text(p, "test"), param_text(p, "value"))
        }),
        two(
            "compareColumns",
            "logic",
            "Tests left against right, row by row: 1 where the test holds, 0 where not (close above its 200-bar average).",
            "signal",
        )
        .param("test", ParamDef::choice("above", TESTS))
        .label(|p, inputs| format!("{} test of {inputs}", param_text(p, "test"))),
        two(
            "and",
            "logic",
            "1 where both signals are true (non-zero), 0 where not.",
            "signal",
        )
        .label(|_, inputs| format!("all of {inputs}")),
        two(
            "or",
            "logic",
            "1 where either signal is true (non-zero), 0 where neither is.",
            "signal",
        )
        .label(|_, inputs| format!("any of {inputs}")),
        Def::op(
            "cumulative",
            "arithmetic",
            "Running total from the first row: sum, product (compounding growth factors), max (the running peak, for drawdowns) or min. A gap row stays a gap and does not reset the total.",
        )
        .param("how", ParamDef::choice("sum", &["sum", "product", "max", "min"]))
        .input("source")
        .output("", "inherit")
        .label(|p, inputs| format!("running {} of {inputs}", param_text(p, "how"))),
        Def::op(
            "hold",
            "logic",
            "Carries the last non-zero value forward over zeros and gaps — turns a crossover’s +1/−1 events into a position held until the next one. Before the first non-zero value, the input passes through.",
        )
        .input("source")
        .output("", "inherit")
        .label(|_, inputs| format!("{inputs} held")),
    ]
}
