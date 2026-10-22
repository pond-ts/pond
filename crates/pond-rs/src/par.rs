//! Running independent pieces of work on several cores.
//!
//! Only whole output columns are split across threads: each column is still
//! computed from start to finish, in order, by one thread, so its bits do
//! not depend on how many threads ran. (Splitting one column's rows would
//! change the order values are added in, and so the last bits of a sum.)
//! The exceptions: loess, where each row's value is a fit of its own that
//! reads no other row's result, so rows can go to any thread; and the
//! financial kernels that restart their sums from the window every
//! `period` rows ([`fill_chunks`]), so a stretch of rows computed on its
//! own gives the same bits as the whole column.

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

/// `(a(), b())`, the two on separate cores when the `parallel` feature is
/// on (and not on wasm32).
pub(crate) fn join<A, B, RA, RB>(a: A, b: B) -> (RA, RB)
where
    A: FnOnce() -> RA + Send,
    B: FnOnce() -> RB + Send,
    RA: Send,
    RB: Send,
{
    #[cfg(all(feature = "parallel", not(target_arch = "wasm32")))]
    {
        rayon::join(a, b)
    }
    #[cfg(not(all(feature = "parallel", not(target_arch = "wasm32"))))]
    {
        (a(), b())
    }
}

/// Fill `a`, and `b` when it is not empty (then the same length), in
/// stretches of `chunk` rows: `f(first_row, a_stretch, b_stretch)`, on
/// several cores when the `parallel` feature is on (and not on wasm32).
/// Only for kernels whose rows come out the same whatever row the stretch
/// starts at.
pub(crate) fn fill_chunks<F>(a: &mut [f64], b: &mut [f64], chunk: usize, f: F)
where
    F: Fn(usize, &mut [f64], &mut [f64]) + Sync + Send,
{
    debug_assert!(b.is_empty() || b.len() == a.len());
    let chunk = chunk.max(1);
    #[cfg(all(feature = "parallel", not(target_arch = "wasm32")))]
    {
        use rayon::prelude::*;
        if b.is_empty() {
            a.par_chunks_mut(chunk)
                .enumerate()
                .for_each(|(k, a)| f(k * chunk, a, &mut []));
        } else {
            a.par_chunks_mut(chunk)
                .zip(b.par_chunks_mut(chunk))
                .enumerate()
                .for_each(|(k, (a, b))| f(k * chunk, a, b));
        }
    }
    #[cfg(not(all(feature = "parallel", not(target_arch = "wasm32"))))]
    {
        if b.is_empty() {
            for (k, a) in a.chunks_mut(chunk).enumerate() {
                f(k * chunk, a, &mut []);
            }
        } else {
            for (k, (a, b)) in a.chunks_mut(chunk).zip(b.chunks_mut(chunk)).enumerate() {
                f(k * chunk, a, b);
            }
        }
    }
}

/// [`fill_chunks`] for three outputs of the same length.
pub(crate) fn fill_chunks3<F>(a: &mut [f64], b: &mut [f64], c: &mut [f64], chunk: usize, f: F)
where
    F: Fn(usize, &mut [f64], &mut [f64], &mut [f64]) + Sync + Send,
{
    debug_assert!(b.len() == a.len() && c.len() == a.len());
    let chunk = chunk.max(1);
    #[cfg(all(feature = "parallel", not(target_arch = "wasm32")))]
    {
        use rayon::prelude::*;
        a.par_chunks_mut(chunk)
            .zip(b.par_chunks_mut(chunk))
            .zip(c.par_chunks_mut(chunk))
            .enumerate()
            .for_each(|(k, ((a, b), c))| f(k * chunk, a, b, c));
    }
    #[cfg(not(all(feature = "parallel", not(target_arch = "wasm32"))))]
    {
        for (k, ((a, b), c)) in a
            .chunks_mut(chunk)
            .zip(b.chunks_mut(chunk))
            .zip(c.chunks_mut(chunk))
            .enumerate()
        {
            f(k * chunk, a, b, c);
        }
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
