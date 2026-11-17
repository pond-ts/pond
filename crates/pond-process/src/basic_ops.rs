//! The basic ops (`basic-ops.ts`): row-by-row arithmetic and logic.

use pond_rs::js_number;

use crate::context::OpContext;
use crate::registry::{Def, ParamDef, param_text};

type Out = Result<Vec<Vec<f64>>, String>;

/// `x - x`: 0 for a present cell, NaN for a missing one. Adding it to a
/// 1/0 result makes the result a gap wherever the input was one.
#[inline]
#[allow(clippy::eq_op)]
fn mask(x: f64) -> f64 {
    x - x
}

#[inline]
fn bit(b: bool) -> f64 {
    if b { 1.0 } else { 0.0 }
}

/// A row-by-row op over `left` and `right` (`binary` in `basic-ops.ts`).
fn binary(ctx: &OpContext, how: &str) -> Out {
    let a = ctx.input("left");
    let b = ctx.input("right");
    let m = |i: usize| mask(a[i]) + mask(b[i]);
    let out: Vec<f64> = (0..a.len())
        .map(|i| {
            let (x, y) = (a[i], b[i]);
            match how {
                "add" => x + y,
                "subtract" => x - y,
                "multiply" => x * y,
                "divide" => x / y,
                "above" => bit(x > y) + m(i),
                "below" => bit(x < y) + m(i),
                "atLeast" => bit(x >= y) + m(i),
                "atMost" => bit(x <= y) + m(i),
                "equal" => bit(x == y) + m(i),
                "and" => bit(x != 0.0) * bit(y != 0.0) + m(i),
                "or" => bit(bit(x != 0.0) + bit(y != 0.0) != 0.0) + m(i),
                _ => unreachable!("binary op '{how}'"),
            }
        })
        .collect();
    Ok(vec![out])
}

/// `source` tested against a fixed value (`against`).
fn against(ctx: &OpContext) -> Out {
    let v = ctx.input("source");
    let value = ctx.number("value");
    let test = ctx.text("test");
    let out = v
        .iter()
        .map(|&x| {
            let hit = match test {
                "above" => x > value,
                "below" => x < value,
                "atLeast" => x >= value,
                "atMost" => x <= value,
                _ => x == value,
            };
            bit(hit) + mask(x)
        })
        .collect();
    Ok(vec![out])
}

fn scale(ctx: &OpContext) -> Out {
    let (factor, offset) = (ctx.number("factor"), ctx.number("offset"));
    Ok(vec![
        ctx.input("source")
            .iter()
            .map(|x| x * factor + offset)
            .collect(),
    ])
}

fn shift(ctx: &OpContext) -> Out {
    let v = ctx.input("source");
    let n = ctx.number("periods") as i64;
    let len = v.len() as i64;
    let out = (0..len)
        .map(|i| {
            let j = i - n;
            if j >= 0 && j < len {
                v[j as usize]
            } else {
                f64::NAN
            }
        })
        .collect();
    Ok(vec![out])
}

fn cumulative(ctx: &OpContext) -> Out {
    let v = ctx.input("source");
    let how = ctx.text("how");
    let step = |acc: f64, x: f64| match how {
        "product" => acc * x,
        "max" => {
            if x > acc {
                x
            } else {
                acc
            }
        }
        "min" => {
            if x < acc {
                x
            } else {
                acc
            }
        }
        _ => acc + x,
    };
    let mut acc = f64::NAN;
    let mut started = false;
    let out = v
        .iter()
        .map(|&x| {
            if !x.is_finite() {
                return f64::NAN;
            }
            // `started`, not `acc.is_nan()`: a product that overflows to
            // Infinity and then meets a 0 is NaN, and must stay so.
            acc = if started { step(acc, x) } else { x };
            started = true;
            acc
        })
        .collect();
    Ok(vec![out])
}

fn hold(ctx: &OpContext) -> Out {
    let mut held = f64::NAN;
    let out = ctx
        .input("source")
        .iter()
        .map(|&x| {
            if x.is_finite() && x != 0.0 {
                held = x;
            }
            if held.is_nan() { x } else { held }
        })
        .collect();
    Ok(vec![out])
}

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
        .label(|_, inputs| format!("sum of {inputs}"))
        .run(|c| binary(c, "add")),
        two(
            "subtract",
            "arithmetic",
            "left − right, row by row (a spread, or a price minus its average). Carries the left input’s unit.",
            "inherit",
        )
        .label(|_, inputs| format!("difference of {inputs}"))
        .run(|c| binary(c, "subtract")),
        two(
            "multiply",
            "arithmetic",
            "left × right, row by row (price × volume, or a return × a position). Carries the left input’s unit.",
            "inherit",
        )
        .label(|_, inputs| format!("product of {inputs}"))
        .run(|c| binary(c, "multiply")),
        two(
            "divide",
            "arithmetic",
            "left ÷ right, row by row (a pair ratio, or ATR as a share of price). Division by zero is a gap.",
            "ratio",
        )
        .label(|_, inputs| format!("ratio of {inputs}"))
        .run(|c| binary(c, "divide")),
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
        })
        .run(scale),
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
        })
        .run(shift),
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
        })
        .run(against),
        two(
            "compareColumns",
            "logic",
            "Tests left against right, row by row: 1 where the test holds, 0 where not (close above its 200-bar average).",
            "signal",
        )
        .param("test", ParamDef::choice("above", TESTS))
        .label(|p, inputs| format!("{} test of {inputs}", param_text(p, "test")))
        .run(|c| binary(c, c.text("test"))),
        two(
            "and",
            "logic",
            "1 where both signals are true (non-zero), 0 where not.",
            "signal",
        )
        .label(|_, inputs| format!("all of {inputs}"))
        .run(|c| binary(c, "and")),
        two(
            "or",
            "logic",
            "1 where either signal is true (non-zero), 0 where neither is.",
            "signal",
        )
        .label(|_, inputs| format!("any of {inputs}"))
        .run(|c| binary(c, "or")),
        Def::op(
            "cumulative",
            "arithmetic",
            "Running total from the first row: sum, product (compounding growth factors), max (the running peak, for drawdowns) or min. A gap row stays a gap and does not reset the total.",
        )
        .param("how", ParamDef::choice("sum", &["sum", "product", "max", "min"]))
        .input("source")
        .output("", "inherit")
        .label(|p, inputs| format!("running {} of {inputs}", param_text(p, "how")))
        .run(cumulative),
        Def::op(
            "hold",
            "logic",
            "Carries the last non-zero value forward over zeros and gaps — turns a crossover’s +1/−1 events into a position held until the next one. Before the first non-zero value, the input passes through.",
        )
        .input("source")
        .output("", "inherit")
        .label(|_, inputs| format!("{inputs} held"))
        .run(hold),
    ]
}
