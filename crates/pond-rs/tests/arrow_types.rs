//! Arrow files written by pyarrow and polars (`tests/data/arrow-types/`,
//! made by `generate.py` there) read as `expected.json` says: compressed
//! files, the stream format, time types as milliseconds, and the extras.
//! Decimal files read as exact decimals, as `expected-decimals.json` says,
//! and list files as array columns, as `expected-lists.json` says.

mod common;

use std::collections::BTreeMap;

use pond_rs::{Scalar, TimeSeries};

#[test]
fn reads_files_from_other_arrow_writers() {
    let dir = common::repo_path("crates/pond-rs/tests/data/arrow-types");
    let expected: BTreeMap<String, Vec<Option<f64>>> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("expected.json")).unwrap()).unwrap();
    let files = std::fs::read_dir(&dir)
        .unwrap()
        .filter(|e| {
            let path = e.as_ref().unwrap().path();
            let name = path.file_name().unwrap().to_str().unwrap();
            !name.starts_with("decimal")
                && !name.starts_with("list")
                && matches!(
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

#[derive(serde::Deserialize)]
struct Decimals {
    scale: i8,
    values: Vec<Option<String>>,
}

#[test]
fn reads_decimal_files_exactly() {
    let dir = common::repo_path("crates/pond-rs/tests/data/arrow-types");
    let expected: BTreeMap<String, Decimals> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("expected-decimals.json")).unwrap())
            .unwrap();
    let files = std::fs::read_dir(&dir)
        .unwrap()
        .filter(|e| {
            let name = e.as_ref().unwrap().file_name();
            let name = name.to_str().unwrap();
            name.starts_with("decimal") && name.ends_with(".arrow")
        })
        .count();
    assert_eq!(expected.len(), files, "every decimal file has an entry");
    for (name, want) in &expected {
        let bytes = std::fs::read(dir.join(format!("{name}.arrow"))).unwrap();
        let series = TimeSeries::from_ipc_bytes(name.as_str(), bytes, "time")
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let column = series.column("v").unwrap();
        assert_eq!(column.kind().as_str(), "decimal", "{name}");
        let d = column.decimals().unwrap();
        assert_eq!(d.scale(), want.scale, "{name}");
        let got: Vec<Option<String>> = d.iter().map(|v| v.map(|v| v.to_string())).collect();
        assert_eq!(got, want.values, "{name}");

        // Written back and read again, nothing changes.
        let mut out = Vec::new();
        series.write_ipc(&mut out).unwrap();
        let again = TimeSeries::from_ipc_bytes(name.as_str(), out, "time").unwrap();
        assert_eq!(again.column("v").unwrap().decimals().unwrap(), d, "{name}");
    }
}

#[test]
fn reads_list_files_as_arrays() {
    let dir = common::repo_path("crates/pond-rs/tests/data/arrow-types");
    let expected: BTreeMap<String, Vec<Option<Vec<serde_json::Value>>>> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("expected-lists.json")).unwrap())
            .unwrap();
    let files = std::fs::read_dir(&dir)
        .unwrap()
        .filter(|e| {
            let name = e.as_ref().unwrap().file_name();
            let name = name.to_str().unwrap();
            name.starts_with("list") && name.ends_with(".arrow")
        })
        .count();
    assert_eq!(expected.len(), files, "every list file has an entry");
    let scalar = |v: &serde_json::Value| match v {
        serde_json::Value::Number(n) => Scalar::Number(n.as_f64().unwrap()),
        serde_json::Value::String(s) => Scalar::String(s.clone()),
        serde_json::Value::Bool(b) => Scalar::Boolean(*b),
        other => panic!("unexpected {other}"),
    };
    for (name, want) in &expected {
        let bytes = std::fs::read(dir.join(format!("{name}.arrow"))).unwrap();
        let series = TimeSeries::from_ipc_bytes(name.as_str(), bytes, "time")
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        let column = series.column("v").unwrap();
        let arrays = column.arrays().unwrap_or_else(|e| panic!("{name}: {e}"));
        let want: Vec<Option<Vec<Scalar>>> = want
            .iter()
            .map(|row| row.as_ref().map(|r| r.iter().map(scalar).collect()))
            .collect();
        let got: Vec<Option<Vec<Scalar>>> =
            arrays.iter().map(|c| c.map(<[Scalar]>::to_vec)).collect();
        assert_eq!(got, want, "{name}");

        // Written back and read again, nothing changes.
        let mut out = Vec::new();
        series.write_ipc(&mut out).unwrap();
        let again = TimeSeries::from_ipc_bytes(name.as_str(), out, "time").unwrap();
        assert_eq!(
            again.column("v").unwrap().arrays().unwrap(),
            arrays,
            "{name}"
        );
        assert_eq!(
            again.column("v").unwrap().is_required(),
            column.is_required(),
            "{name}"
        );
    }
}
