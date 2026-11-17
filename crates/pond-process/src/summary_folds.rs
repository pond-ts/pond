//! The summary folds (`summary-folds.ts`): one answer over a whole column.

use serde_json::{Value, json};

use crate::context::{
    FoldContext, fact_number, first_present, last_present, present, stamper, value_at,
};
use crate::registry::{Def, ParamDef, param_text};

type Fact = Result<Value, crate::error::ProcessError>;

/// Plain running sum over present cells, in row order, and their count.
fn sum_count(v: &[f64]) -> (f64, u64) {
    let (mut s, mut n) = (0.0, 0);
    for &x in v {
        if present(x) {
            s += x;
            n += 1;
        }
    }
    (s, n)
}

fn mean(ctx: &FoldContext) -> Fact {
    let (s, n) = sum_count(ctx.input("source"));
    let value = if n == 0 {
        Value::Null
    } else {
        fact_number(s / n as f64)
    };
    Ok(json!({ "value": value, "count": n }))
}

fn stdev(ctx: &FoldContext) -> Fact {
    // Welford, as pond's reducer.
    let (mut count, mut m, mut m2) = (0u64, 0.0f64, 0.0f64);
    for &x in ctx.input("source") {
        if !present(x) {
            continue;
        }
        count += 1;
        let d = x - m;
        m += d / count as f64;
        m2 += d * (x - m);
    }
    if count == 0 {
        return Ok(json!({ "value": null, "count": 0 }));
    }
    let value = (m2.max(0.0) / count as f64).sqrt();
    Ok(json!({ "value": fact_number(value), "count": count }))
}

fn sum(ctx: &FoldContext) -> Fact {
    let (s, n) = sum_count(ctx.input("source"));
    let value = if n == 0 { Value::Null } else { fact_number(s) };
    Ok(json!({ "value": value, "count": n }))
}

fn count(ctx: &FoldContext) -> Fact {
    let v = ctx.input("source");
    let defined = v.iter().filter(|x| present(**x)).count();
    Ok(json!({ "value": defined, "rows": v.len() }))
}

/// Puts the `k`-th smallest of `a` at `a[k]` and returns it: Hoare's
/// quickselect with a median-of-three pivot, falling back to a sort when
/// it stops halving. Step for step `select` in `summary-folds.ts`, since
/// which of `0` and `-0` lands at `k` depends on the exact swaps.
fn select(a: &mut [f64], k: usize) -> f64 {
    let n = a.len();
    let mut left: isize = 0;
    let mut right: isize = n as isize - 1;
    let mut budget = 2 * ((n + 1) as f64).log2().ceil() as i64 + 8;
    let at = |a: &[f64], i: isize| a[i as usize];
    while right > left {
        if budget == 0 {
            a[left as usize..=right as usize].sort_by(f64::total_cmp);
            return a[k];
        }
        budget -= 1;
        let mid = (left + right) >> 1;
        if at(a, mid) < at(a, left) {
            a.swap(mid as usize, left as usize);
        }
        if at(a, right) < at(a, left) {
            a.swap(right as usize, left as usize);
        }
        if at(a, right) < at(a, mid) {
            a.swap(right as usize, mid as usize);
        }
        let pivot = at(a, mid);
        let (mut i, mut j) = (left, right);
        while i <= j {
            while at(a, i) < pivot {
                i += 1;
            }
            while at(a, j) > pivot {
                j -= 1;
            }
            if i <= j {
                a.swap(i as usize, j as usize);
                i += 1;
                j -= 1;
            }
        }
        let k = k as isize;
        if k <= j {
            right = j;
        } else if k >= i {
            left = i;
        } else {
            return a[k as usize];
        }
    }
    a[k]
}

fn percentile(ctx: &FoldContext) -> Fact {
    let mut buffer: Vec<f64> = ctx
        .input("source")
        .iter()
        .copied()
        .filter(|x| present(*x))
        .collect();
    let n = buffer.len();
    if n == 0 {
        return Ok(json!({ "value": null, "count": 0 }));
    }
    let rank = (ctx.number("q") / 100.0) * (n - 1) as f64;
    let lo = rank.floor();
    let at = select(&mut buffer, lo as usize);
    let value = if rank == lo {
        at
    } else {
        let next = buffer[lo as usize + 1..]
            .iter()
            .copied()
            .fold(f64::INFINITY, |m, x| if x < m { x } else { m });
        at + (next - at) * (rank - lo)
    };
    // `+ 0` turns a -0 into 0.
    Ok(json!({ "value": fact_number(value + 0.0), "count": n }))
}

fn share_true(ctx: &FoldContext) -> Fact {
    let (mut yes, mut of) = (0u64, 0u64);
    for &x in ctx.input("source") {
        if present(x) {
            of += 1;
            if x != 0.0 {
                yes += 1;
            }
        }
    }
    let value = if of == 0 {
        Value::Null
    } else {
        fact_number(yes as f64 / of as f64)
    };
    Ok(json!({ "value": value, "true": yes, "of": of }))
}

fn last_true(ctx: &FoldContext) -> Fact {
    let v = ctx.input("source");
    let fmt = stamper(ctx, v.len());
    Ok(match v.iter().rposition(|x| present(*x) && *x != 0.0) {
        Some(i) => json!({ "value": fact_number(v[i]), "at": fmt(ctx.at(i)) }),
        None => json!({ "value": null }),
    })
}

fn last_change(ctx: &FoldContext) -> Fact {
    let v = ctx.input("source");
    let fmt = stamper(ctx, v.len());
    let Some(i) = last_present(v) else {
        return Ok(json!({ "value": null }));
    };
    let current = v[i];
    let mut since = i;
    for j in (0..i).rev() {
        if !present(v[j]) {
            continue;
        }
        if v[j] != current {
            return Ok(json!({
                "value": fact_number(current),
                "since": fmt(ctx.at(since)),
                "previous": fact_number(v[j]),
            }));
        }
        since = j;
    }
    Ok(json!({ "value": fact_number(current), "since": fmt(ctx.at(since)), "previous": null }))
}

fn events(ctx: &FoldContext) -> Fact {
    let v = ctx.input("source");
    let fmt = stamper(ctx, v.len());
    let limit = ctx.number("limit") as usize;
    let hit = |x: f64| x != 0.0 && present(x);
    let total = v.iter().filter(|x| hit(**x)).count();
    let mut hits: Vec<usize> = (0..v.len())
        .rev()
        .filter(|&i| hit(v[i]))
        .take(limit)
        .collect();
    hits.reverse();
    let at: Vec<String> = hits.iter().map(|&i| fmt(ctx.at(i))).collect();
    Ok(json!({ "count": total, "shown": hits.len(), "at": at }))
}

fn mean_where(ctx: &FoldContext) -> Fact {
    let v = ctx.input("source");
    let w = ctx.input("when");
    let (mut total, mut count, mut signals) = (0.0, 0u64, 0u64);
    for (i, &c) in w.iter().enumerate() {
        if c == 0.0 || !present(c) {
            continue;
        }
        signals += 1;
        let x = v[i];
        if !present(x) {
            continue;
        }
        total += x;
        count += 1;
    }
    let value = if count == 0 {
        Value::Null
    } else {
        fact_number(total / count as f64)
    };
    Ok(json!({ "value": value, "count": count, "signals": signals }))
}

fn change(ctx: &FoldContext) -> Fact {
    let v = ctx.input("source");
    let fmt = stamper(ctx, v.len());
    let (Some(first), Some(last)) = (first_present(v), last_present(v)) else {
        return Ok(json!({ "first": null, "last": null }));
    };
    let (a, b) = (v[first], v[last]);
    let percent = if a == 0.0 {
        Value::Null
    } else {
        fact_number((b / a - 1.0) * 100.0)
    };
    Ok(json!({
        "first": value_at(ctx, v, fmt, first),
        "last": value_at(ctx, v, fmt, last),
        "change": fact_number(b - a),
        "percent": percent,
    }))
}

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
        .label(|_, inputs| format!("mean of {inputs}"))
        .folds(mean),
        one(
            "stdev",
            "The population standard deviation of every defined value (divides by n, as pond’s `stdev` reducer does).",
            "inherit",
        )
        .label(|_, inputs| format!("stdev of {inputs}"))
        .folds(stdev),
        one(
            "sum",
            "The total of every defined value, with how many there were.",
            "inherit",
        )
        .label(|_, inputs| format!("total of {inputs}"))
        .folds(sum),
        one(
            "count",
            "How many rows hold a value, out of how many rows there are. The gap between the two is missing data or warm-up.",
            "rows",
        )
        .label(|_, inputs| format!("count of {inputs}"))
        .folds(count),
        Def::fold(
            "percentile",
            "summary",
            "The value below which q percent of the defined values fall (q 5 of daily returns is the one-day 95% value at risk). Linear between ranks.",
            "inherit",
        )
        .param("q", ParamDef::num(50.0).min(0.0).max(100.0).suggest(1.0, 99.0))
        .input("source")
        .label(|p, inputs| format!("p{} of {inputs}", param_text(p, "q")))
        .folds(percentile),
        one(
            "shareTrue",
            "The share of defined rows where a signal is true (non-zero), 0–1. Over a `compare` step it answers \"how often was it above…?\".",
            "ratio",
        )
        .label(|_, inputs| format!("share true of {inputs}"))
        .folds(share_true),
        one(
            "lastTrue",
            "When a signal was last true (non-zero), and its value then. Over a crossover column it answers \"when was the last golden cross?\".",
            "inherit",
        )
        .label(|_, inputs| format!("last time {inputs}"))
        .folds(last_true),
        one(
            "lastChange",
            "The latest value, when it took that value, and what it was before — \"which way is the trend pointing, and since when?\". Gaps are skipped, not counted as changes.",
            "inherit",
        )
        .label(|_, inputs| format!("last change of {inputs}"))
        .folds(last_change),
        Def::fold(
            "events",
            "summary",
            "The dates where a signal is true (non-zero), oldest first — the most recent `limit` of them, with the total count. Over `compare` it lists every time RSI fell below 30.",
            "dates",
        )
        .param("limit", ParamDef::int(50.0).min(1.0).max(400.0).suggest(5.0, 100.0))
        .input("source")
        .label(|p, inputs| format!("dates of {inputs} (≤{})", param_text(p, "limit")))
        .folds(events),
        Def::fold(
            "meanWhere",
            "summary",
            "The average of `source` over the rows where `when` is true (non-zero) — the average 10-day forward return after RSI fell below 30. Over a 1/0 source it is a hit rate.",
            "inherit",
        )
        .input("source")
        .input("when")
        .label(|_, inputs| format!("mean where: {inputs}"))
        .folds(mean_where),
        one(
            "change",
            "The first and last defined values with their dates, the change between them, and that change in percent — \"what was the total return?\".",
            "inherit",
        )
        .label(|_, inputs| format!("change in {inputs}"))
        .folds(change),
    ]
}
