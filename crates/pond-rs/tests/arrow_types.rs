//! Arrow files written by pyarrow and polars (`tests/data/arrow-types/`,
//! made by `generate.py` there) read as `expected.json` says: compressed
//! files, the stream format, time types as milliseconds, and the extras.

mod common;

use std::collections::BTreeMap;

use pond_rs::TimeSeries;

#[test]
fn reads_files_from_other_arrow_writers() {
    let dir = common::repo_path("crates/pond-rs/tests/data/arrow-types");
    let expected: BTreeMap<String, Vec<Option<f64>>> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("expected.json")).unwrap()).unwrap();
    let files = std::fs::read_dir(&dir)
        .unwrap()
        .filter(|e| {
            let path = e.as_ref().unwrap().path();
            matches!(
                path.extension().and_then(|x| x.to_str()),
                Some("arrow" | "arrows")
            )
        })
        .count();
    assert_eq!(expected.len(), files, "every file has an expected entry");
    for (name, want) in &expected {
        let file = if name == "stream" {
            dir.join("stream.arrows")
        } else {
            dir.join(format!("{name}.arrow"))
        };
        let series =
            TimeSeries::from_ipc_bytes(name.as_str(), std::fs::read(&file).unwrap(), "time")
                .unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(series.key().begin(), [0, 1000, 2000], "{name}");
        let got: Vec<Option<f64>> = series
            .column("v")
            .unwrap()
            .numbers()
            .unwrap_or_else(|e| panic!("{name}: {e}"))
            .iter()
            .collect();
        // Exact: the same bits, not just close.
        let bits = |v: &[Option<f64>]| v.iter().map(|x| x.map(f64::to_bits)).collect::<Vec<_>>();
        assert_eq!(bits(&got), bits(want), "{name}: got {got:?}, want {want:?}");
    }
}
