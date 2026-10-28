//! Memory held by the live layer: bytes per event after pushing 1M events
//! (100 ms apart; host text, cpu and mem numbers, ~2% gaps; the same rows
//! as `perf_live`), counted by a wrapping allocator.
//!
//!     cargo run --release -p pond-rs --example mem_live
//!
//! Each case builds a series (and any nodes), pushes the rows in batches of
//! 1,000, and reports the bytes still allocated divided by the events held.
//! Counting starts before the rows are built, so cells the live layer
//! keeps are counted and everything else it was handed is freed by then.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering};

use pond_rs::live::{LiveOptions, LiveSeries};
use pond_rs::{ColumnDef, ColumnKind, Value};

struct Counting;

static LIVE: AtomicIsize = AtomicIsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.fetch_add(layout.size() as isize, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size() as isize, Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        LIVE.fetch_add(
            new_size as isize - layout.size() as isize,
            Ordering::Relaxed,
        );
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn schema(numbers: usize, host: bool) -> Vec<ColumnDef> {
    let mut s = vec![ColumnDef::required("time", ColumnKind::Time)];
    if host {
        s.push(ColumnDef::optional("host", ColumnKind::String));
    }
    for c in 0..numbers {
        s.push(ColumnDef::optional(format!("n{c}"), ColumnKind::Number));
    }
    s
}

type Row = (i64, Vec<Option<Value>>);

fn rows(n: usize, numbers: usize, host: bool) -> Vec<Vec<Row>> {
    let mut seed = 20261027u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        seed as f64 / 4294967296.0
    };
    let hosts = ["a", "b", "c", "d"];
    let all: Vec<Row> = (0..n)
        .map(|i| {
            let mut row = Vec::new();
            if host {
                row.push(Some(hosts[i % 4].into()));
            }
            for _ in 0..numbers {
                let v = next();
                row.push((v >= 0.02).then_some(Value::Number(v)));
            }
            (i as i64 * 100, row)
        })
        .collect();
    all.chunks(1000).map(<[Row]>::to_vec).collect()
}

fn measure(name: &str, numbers: usize, host: bool, views: usize) -> pond_rs::Result<()> {
    const N: usize = 1_000_000;
    // Counted from before the rows exist: the cells a push takes in are
    // kept, and the rest is freed by the end.
    let before = LIVE.load(Ordering::Relaxed);
    let batches = rows(N, numbers, host);
    let mut live = LiveSeries::with_options("m", schema(numbers, host), LiveOptions::new())?;
    for _ in 0..views {
        live.filter(live.root(), |_| true)?;
    }
    for b in batches {
        live.push_many(b)?;
    }
    let held = LIVE.load(Ordering::Relaxed) - before;
    let events = N * (1 + views);
    println!(
        "{name:<34} {:>7.1} bytes per event held ({:.0} MB)",
        held as f64 / events as f64,
        held as f64 / 1e6
    );
    drop(live);
    Ok(())
}

fn main() -> pond_rs::Result<()> {
    measure("time + 3 numbers", 3, false, 0)?;
    measure("time + host + 2 numbers", 2, true, 0)?;
    measure("time + host + 2 numbers, filter", 2, true, 1)?;
    measure("time + 10 numbers", 10, false, 0)?;
    Ok(())
}
