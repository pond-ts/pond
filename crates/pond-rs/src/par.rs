//! Running independent pieces of work on several cores.
//!
//! Only whole output columns are split across threads: each column is still
//! computed from start to finish, in order, by one thread, so its bits do
//! not depend on how many threads ran. (Splitting one column's rows would
//! change the order values are added in, and so the last bits of a sum.)
//! The one exception is loess, where each row's value is a fit of its own
//! that reads no other row's result, so rows can go to any thread.

/// `items.iter().map(f).collect()`, on several cores when the `parallel`
/// feature is on (and not on wasm32). Output order is input order.
pub(crate) fn map<T, R, F>(items: &[T], f: F) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync + Send,
{
    #[cfg(all(feature = "parallel", not(target_arch = "wasm32")))]
    {
        use rayon::prelude::*;
        items.par_iter().map(f).collect()
    }
    #[cfg(not(all(feature = "parallel", not(target_arch = "wasm32"))))]
    {
        items.iter().map(f).collect()
    }
}

#[cfg(all(test, feature = "parallel", not(target_arch = "wasm32")))]
mod tests {
    use crate::{Agg, Column, Reducer, Sequence, TimeSeries};

    /// Same bits on 1 thread and on 4: the R1a determinism target.
    #[test]
    fn same_bits_on_one_and_many_threads() {
        // Deterministic noisy input: 20k rows, gaps, repeated times.
        let mut x = 0x2545_f491_4f6c_dd1du64;
        let mut next = || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let n = 20_000;
        let mut t = 0i64;
        let times: Vec<i64> = (0..n)
            .map(|_| {
                t += (next() % 3) as i64 * 500;
                t
            })
            .collect();
        let cols: Vec<Column> = (0..6)
            .map(|c| {
                let v: Vec<Option<f64>> = (0..n)
                    .map(|_| {
                        let r = next();
                        (r % 17 != 0).then(|| (r % 1_000_003) as f64 / 7.0 - 70_000.0)
                    })
                    .collect();
                Column::optional(format!("c{c}"), v)
            })
            .collect();
        let s = TimeSeries::new("s", times, cols).unwrap();
        let reducers = [
            Reducer::Sum,
            Reducer::Avg,
            Reducer::Stdev,
            Reducer::Median,
            Reducer::Min,
            Reducer::Percentile(90.0),
        ];
        let aggs: Vec<Agg> = (0..6)
            .flat_map(|c| {
                reducers
                    .iter()
                    .enumerate()
                    .map(move |(i, r)| Agg::new(format!("c{c}_{i}"), format!("c{c}"), *r))
            })
            .collect();
        let run = |threads: usize| {
            rayon::ThreadPoolBuilder::new()
                .num_threads(threads)
                .build()
                .unwrap()
                .install(|| {
                    let roll = s.rolling("30s", &aggs).unwrap();
                    let agg = s.aggregate(&Sequence::every("1m").unwrap(), &aggs).unwrap();
                    [roll, agg]
                        .iter()
                        .flat_map(|r| {
                            r.columns()
                                .iter()
                                .map(|c| {
                                    (
                                        c.name().to_string(),
                                        c.numbers()
                                            .unwrap()
                                            .values()
                                            .iter()
                                            .map(|v| v.to_bits())
                                            .collect(),
                                    )
                                })
                                .collect::<Vec<(String, Vec<u64>)>>()
                        })
                        .collect::<Vec<_>>()
                })
        };
        let one = run(1);
        assert_eq!(one.len(), 72);
        assert_eq!(one, run(4));
        assert_eq!(one, run(7));
    }
}
