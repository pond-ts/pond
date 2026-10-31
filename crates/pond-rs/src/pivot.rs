//! Reshaping by row: `collapse` (several columns into one, row by row) and
//! `pivot_by_group` (long rows into wide ones, one column per group).

use std::collections::HashMap;

use crate::column::{BooleanColumn, ColumnData, Scalar, StringColumn};
use crate::error::{PondError, Result};
use crate::grid::js_number;
use crate::par;
use crate::reducer::{Agg, Reducer, check_source_kind};
use crate::rows::Row;
use crate::series::{Column, ColumnKind, Key, TimeSeries};

/// How [`TimeSeries::pivot_by_group`] treats rows that share a time and a
/// group, and which groups become columns.
///
/// ```
/// # use pond_rs::{Pivot, Reducer};
/// let options = Pivot::default().aggregate(Reducer::Avg).groups(["api-1", "api-2"]);
/// ```
#[derive(Debug, Clone, Default)]
pub struct Pivot {
    aggregate: Option<Reducer>,
    groups: Option<Vec<String>>,
}

impl Pivot {
    /// Combine the values of rows that share a time and a group with this
    /// reducer (pond-ts `{ aggregate }`). Its result must be the value
    /// column's kind: `avg` on numbers, `first` or `last` on any kind,
    /// `count` only on numbers. Without one, such rows are an error.
    pub fn aggregate(mut self, reducer: Reducer) -> Self {
        self.aggregate = Some(reducer);
        self
    }

    /// The groups, in column order (pond-ts `{ groups }`). Each becomes a
    /// column even when no row has it; a row with any other group is an
    /// error. Without this, the groups found are sorted (as JavaScript's
    /// default sort orders text).
    pub fn groups<S: Into<String>>(mut self, groups: impl IntoIterator<Item = S>) -> Self {
        self.groups = Some(groups.into_iter().map(Into::into).collect());
        self
    }
}

impl TimeSeries {
    /// Replace `columns` with one column `output` holding `f`'s result for
    /// each row (pond-ts `collapse(keys, output, reducer)`). `f` reads the
    /// row's values through the [`Row`] it is handed; it returns `None` for
    /// a gap. The other columns are kept, in order, and `output` comes
    /// last. See [`TimeSeries::collapse_keep`] to keep `columns` too.
    ///
    /// The output column's kind is the kind of `f`'s first value that is
    /// not a gap (a text column if every row is a gap), and every value
    /// must be that kind. A number that is not finite counts as a number
    /// for the kind but is stored as a gap, as in pond-ts. The column
    /// is required when it has no gaps, else optional. pond-ts marks it
    /// required even when it has gaps.
    ///
    /// ```
    /// # use pond_rs::{Column, Scalar, TimeSeries};
    /// let s = TimeSeries::new("net", vec![0, 1000], vec![
    ///     Column::required("in", vec![1.0, 2.0]),
    ///     Column::required("out", vec![3.0, 5.0]),
    /// ])?;
    /// let total = s.collapse(&["in", "out"], "total", |r| {
    ///     Ok(match (r.number("in")?, r.number("out")?) {
    ///         (Some(a), Some(b)) => Some(Scalar::Number(a + b)),
    ///         _ => None,
    ///     })
    /// })?;
    /// assert_eq!(total.column("total")?.numbers()?.values(), &[4.0, 7.0]);
    /// assert_eq!(total.columns().len(), 1);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn collapse<F>(&self, columns: &[&str], output: &str, f: F) -> Result<TimeSeries>
    where
        F: FnMut(&Row<'_>) -> Result<Option<Scalar>>,
    {
        self.collapse_into("collapse", columns, output, false, f)
    }

    /// [`TimeSeries::collapse`], keeping `columns` (pond-ts `{ append:
    /// true }`). `output` must then be a new name.
    pub fn collapse_keep<F>(&self, columns: &[&str], output: &str, f: F) -> Result<TimeSeries>
    where
        F: FnMut(&Row<'_>) -> Result<Option<Scalar>>,
    {
        self.collapse_into("collapse_keep", columns, output, true, f)
    }

    fn collapse_into<F>(
        &self,
        call: &'static str,
        columns: &[&str],
        output: &str,
        keep: bool,
        mut f: F,
    ) -> Result<TimeSeries>
    where
        F: FnMut(&Row<'_>) -> Result<Option<Scalar>>,
    {
        let dropped: Vec<usize> = columns
            .iter()
            .map(|name| self.column_index(call, name))
            .collect::<Result<_>>()?;
        let mut kept: Vec<Column> = self
            .columns()
            .iter()
            .enumerate()
            .filter(|(i, _)| keep || !dropped.contains(i))
            .map(|(_, c)| c.clone())
            .collect();
        if output == self.key_name() || kept.iter().any(|c| c.name() == output) {
            return Err(PondError::DuplicateOutput {
                call,
                column: output.to_string(),
            });
        }
        let mut kind: Option<ColumnKind> = None;
        let mut values: Vec<Option<Scalar>> = Vec::with_capacity(self.len());
        for row in self.rows() {
            // The kind counts a non-finite number (as pond-ts does: NaN is
            // still a number there); the value itself is stored as a gap.
            let v = f(&row)?;
            if let Some(v) = &v {
                let k = v.kind();
                match kind {
                    None => kind = Some(k),
                    Some(first) if first != k => {
                        return Err(PondError::InvalidData {
                            call,
                            message: format!(
                                "row {} gives a {k:?} value but earlier rows gave {first:?}; every value must be one kind",
                                row.index()
                            ),
                        });
                    }
                    Some(_) => {}
                }
            }
            values.push(match v {
                Some(Scalar::Number(x)) if !x.is_finite() => None,
                v => v,
            });
        }
        let data: ColumnData = match kind.unwrap_or(ColumnKind::String) {
            ColumnKind::Number => values
                .into_iter()
                .map(|v| match v {
                    Some(Scalar::Number(x)) => x,
                    _ => f64::NAN,
                })
                .collect::<Vec<f64>>()
                .into(),
            ColumnKind::Boolean => {
                BooleanColumn::from_options(values.into_iter().map(|v| match v {
                    Some(Scalar::Boolean(b)) => Some(b),
                    _ => None,
                }))
                .into()
            }
            _ => StringColumn::from_options(values.into_iter().map(|v| match v {
                Some(Scalar::String(s)) => Some(s),
                _ => None,
            }))
            .into(),
        };
        let required = data.missing_count() == 0;
        kept.push(Column::from_data(output.to_string(), data, required));
        Ok(self.with_value_columns(kept))
    }

    /// Long rows into wide ones (pond-ts `pivotByGroup(group, value)`):
    /// one row per distinct time, and one column per value of `group`,
    /// named `<group>_<value>` and holding `value` from the row with that
    /// time and group (a gap where there is none). The series must be keyed
    /// by time; the result keeps the key's name and has `value`'s kind,
    /// with every column optional.
    ///
    /// Groups are named as JavaScript's `String` writes them: numbers in
    /// JavaScript's form, `true` / `false`, array elements joined by
    /// commas, and a gap as `undefined` (so a gap and the text
    /// `"undefined"` share a column, as in pond-ts). Decimals, which
    /// pond-ts has no kind for, are written in full.
    ///
    /// Two rows with the same time and group are an error unless
    /// [`Pivot::aggregate`] names a reducer to combine them; a lone row is
    /// copied as it is, without the reducer.
    ///
    /// ```
    /// # use pond_rs::{Column, Pivot, TimeSeries};
    /// let long = TimeSeries::new("cpu", vec![0, 0, 1000], vec![
    ///     Column::required("host", vec!["b", "a", "a"]),
    ///     Column::required("cpu", vec![0.5, 0.2, 0.3]),
    /// ])?;
    /// let wide = long.pivot_by_group("host", "cpu", &Pivot::default())?;
    /// assert_eq!(wide.key().begin(), &[0, 1000]);
    /// assert_eq!(wide.column("a_cpu")?.numbers()?.values(), &[0.2, 0.3]);
    /// assert_eq!(wide.column("b_cpu")?.numbers()?.get(1), None);
    /// # Ok::<(), pond_rs::PondError>(())
    /// ```
    pub fn pivot_by_group(&self, group: &str, value: &str, options: &Pivot) -> Result<TimeSeries> {
        const CALL: &str = "pivot_by_group";
        let Key::Time(times) = self.key() else {
            return Err(PondError::InvalidData {
                call: CALL,
                message: format!(
                    "needs a series keyed by time; this one is keyed by {:?} (use as_time first)",
                    self.key().kind()
                ),
            });
        };
        let group_col = &self.columns()[self.column_index(CALL, group)?];
        let value_index = self.column_index(CALL, value)?;
        let value_col = &self.columns()[value_index];

        // The reducer's result must keep the value column's kind; learn the
        // result kind from a reduction over no buckets.
        let agg = options
            .aggregate
            .map(|reducer| Agg::new(value, value, reducer));
        if let Some(agg) = &agg {
            agg.reducer.check(CALL)?;
            check_source_kind(CALL, value_col, agg.reducer)?;
            let probe = self.reduce_columns(CALL, &[(agg, value_index)], &[])?;
            if probe[0].kind() != value_col.kind() {
                return Err(PondError::WrongKind {
                    call: CALL,
                    column: value.to_string(),
                    kind: kind_name(value_col.kind()),
                    reason: format!(
                        "aggregate {:?} gives {} values; aggregate first with the kind change, then pivot",
                        agg.reducer,
                        kind_name(probe[0].kind())
                    ),
                });
            }
        }

        // Each row's group, as an index into `names`.
        let mut ids: HashMap<String, usize> = HashMap::new();
        let mut names: Vec<String> = Vec::new();
        if let Some(declared) = &options.groups {
            for g in declared {
                if ids.insert(g.clone(), names.len()).is_some() {
                    return Err(PondError::InvalidData {
                        call: CALL,
                        message: format!("group '{g}' is declared twice"),
                    });
                }
                names.push(g.clone());
            }
        }
        // Naming a group allocates, so name each distinct raw value once.
        let mut seen: HashMap<Raw<'_>, usize> = HashMap::new();
        let mut row_group: Vec<usize> = Vec::with_capacity(self.len());
        for i in 0..self.len() {
            let raw = raw_group(group_col.data(), i);
            if let Some(&id) = raw.as_ref().and_then(|r| seen.get(r)) {
                row_group.push(id);
                continue;
            }
            let name = group_name(group_col.data(), i);
            let id = match ids.get(&name) {
                Some(&id) => id,
                None if options.groups.is_some() => {
                    return Err(PondError::InvalidData {
                        call: CALL,
                        message: format!(
                            "row {i} has group '{name}', which is not in the declared groups"
                        ),
                    });
                }
                None => {
                    ids.insert(name.clone(), names.len());
                    names.push(name);
                    names.len() - 1
                }
            };
            if let Some(raw) = raw {
                seen.insert(raw, id);
            }
            row_group.push(id);
        }
        // Column order: as declared, else sorted as JavaScript sorts text
        // (by UTF-16 code units).
        let order: Vec<usize> = if options.groups.is_some() {
            (0..names.len()).collect()
        } else {
            let mut order: Vec<usize> = (0..names.len()).collect();
            order.sort_by(|&a, &b| names[a].encode_utf16().cmp(names[b].encode_utf16()));
            order
        };
        let mut column_of = vec![0usize; names.len()];
        for (c, &g) in order.iter().enumerate() {
            column_of[g] = c;
        }
        let out_names: Vec<String> = order
            .iter()
            .map(|&g| format!("{}_{value}", names[g]))
            .collect();
        if let Some(clash) = out_names.iter().find(|n| *n == self.key_name()) {
            return Err(PondError::DuplicateOutput {
                call: CALL,
                column: clash.clone(),
            });
        }

        // Rows sharing a time are one run (keys are sorted): output row r.
        // Each row's cell is r * width + its column. A counting sort by
        // cell (stable) lays each cell's rows side by side in `perm`, in
        // row order; `first[cell]..first[cell + 1]` is the cell's run.
        let width = order.len();
        let mut out_times: Vec<i64> = Vec::new();
        let mut cell_of: Vec<usize> = Vec::with_capacity(self.len());
        for (i, &t) in times.iter().enumerate() {
            if i == 0 || t != times[i - 1] {
                out_times.push(t);
            }
            cell_of.push((out_times.len() - 1) * width + column_of[row_group[i]]);
        }
        let rows = out_times.len();
        let mut first = vec![0u32; rows * width + 1];
        for &c in &cell_of {
            first[c + 1] += 1;
        }
        for c in 0..rows * width {
            first[c + 1] += first[c];
        }
        let mut next = first.clone();
        let mut perm = vec![0u32; self.len()];
        for (i, &c) in cell_of.iter().enumerate() {
            perm[next[c] as usize] = i as u32;
            next[c] += 1;
        }
        drop(next);
        let size = |c: usize| (first[c + 1] - first[c]) as usize;

        // The cells of two or more rows, in output order, reduced.
        let multi: Vec<usize> = (0..rows * width).filter(|&c| size(c) > 1).collect();
        let reduced: Option<ColumnData> = match (&agg, multi.first()) {
            (_, None) => None,
            (None, Some(&c)) => {
                let row = perm[first[c] as usize] as usize;
                return Err(PondError::InvalidData {
                    call: CALL,
                    message: format!(
                        "{} rows share time {} and group '{}'; pass Pivot::aggregate to combine them",
                        size(c),
                        times[row],
                        names[row_group[row]]
                    ),
                });
            }
            (Some(agg), Some(_)) => {
                // Only the rows of those cells, one cell after another.
                let mut rows_of: Vec<Option<usize>> = Vec::new();
                let mut ranges = Vec::with_capacity(multi.len());
                for &c in &multi {
                    let at = rows_of.len();
                    rows_of.extend(
                        perm[first[c] as usize..first[c + 1] as usize]
                            .iter()
                            .map(|&i| Some(i as usize)),
                    );
                    ranges.push(at..rows_of.len());
                }
                let holder = TimeSeries::from_parts(
                    self.name().to_string(),
                    self.key_name().to_string(),
                    Key::Time(rows_of.iter().map(|i| times[i.expect("a row")]).collect()),
                    vec![Column::from_data(
                        value.to_string(),
                        value_col.data().take(&rows_of),
                        false,
                    )],
                );
                let out = holder.reduce_columns(CALL, &[(agg, 0)], &ranges)?;
                Some(out[0].data().clone())
            }
        };
        // Sources for each output cell: 0 = a lone row of the value column,
        // 1 = a reduced cell (numbered in output order), 2 = a gap.
        let gap = value_col.data().take(&[None]);
        let sources: Vec<&ColumnData> =
            vec![value_col.data(), reduced.as_ref().unwrap_or(&gap), &gap];
        let mut multi_index = vec![u32::MAX; rows * width];
        for (m, &c) in multi.iter().enumerate() {
            multi_index[c] = m as u32;
        }
        let column_ids: Vec<usize> = (0..width).collect();
        let columns: Vec<Column> = par::map(&column_ids, |&c| {
            let picks: Vec<(u32, u32)> = (0..rows)
                .map(|r| {
                    let cell = r * width + c;
                    match size(cell) {
                        0 => (2, 0),
                        1 => (0, perm[first[cell] as usize]),
                        _ => (1, multi_index[cell]),
                    }
                })
                .collect();
            Column::from_data(
                out_names[c].clone(),
                ColumnData::gather(&sources, &picks),
                false,
            )
        });
        Ok(TimeSeries::from_parts(
            self.name().to_string(),
            self.key_name().to_string(),
            Key::Time(out_times),
            columns,
        ))
    }
}

/// A group value as it is stored, for remembering its name: values that
/// are equal here have the same name. `None` for kinds named every row.
#[derive(Hash, PartialEq, Eq)]
enum Raw<'a> {
    Gap,
    Text(&'a str),
    /// The bits of a number, with `-0` as `0` (both are named `0`).
    Number(u64),
    Flag(bool),
}

fn raw_group(data: &ColumnData, i: usize) -> Option<Raw<'_>> {
    Some(match data {
        ColumnData::Number(c) => c
            .get(i)
            .map_or(Raw::Gap, |x| Raw::Number((x + 0.0).to_bits())),
        ColumnData::String(c) => c.get(i).map_or(Raw::Gap, Raw::Text),
        ColumnData::Boolean(c) => c.get(i).map_or(Raw::Gap, Raw::Flag),
        ColumnData::Decimal(_) | ColumnData::Array(_) => return None,
    })
}

/// JavaScript's `String(v)` for row `i` of a group column; `undefined` for
/// a gap.
fn group_name(data: &ColumnData, i: usize) -> String {
    match data {
        ColumnData::Number(c) => c.get(i).map_or_else(|| "undefined".into(), js_number),
        ColumnData::Decimal(c) => c
            .get(i)
            .map_or_else(|| "undefined".into(), |d| d.to_string()),
        ColumnData::String(c) => c.get(i).unwrap_or("undefined").to_string(),
        ColumnData::Boolean(c) => c
            .get(i)
            .map_or_else(|| "undefined".into(), |b| b.to_string()),
        ColumnData::Array(c) => c.get(i).map_or_else(
            || "undefined".into(),
            |items| {
                items
                    .iter()
                    .map(|s| match s {
                        Scalar::Number(x) => js_number(*x),
                        Scalar::String(t) => t.clone(),
                        Scalar::Boolean(b) => b.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            },
        ),
    }
}

fn kind_name(kind: ColumnKind) -> &'static str {
    kind.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::column::DecimalColumn;
    use crate::series::{IntervalKeys, Labels};

    fn net() -> TimeSeries {
        TimeSeries::new(
            "net",
            vec![0, 1000, 2000],
            vec![
                Column::optional("a", vec![Some(1.0), None, Some(3.0)]),
                Column::required("b", vec![2.0, 4.0, 0.0]),
            ],
        )
        .unwrap()
    }

    #[test]
    fn collapse_kind_comes_from_the_first_value_and_must_not_change() {
        let s = net();
        // The first row is a gap; the numbers after it keep their kind.
        let late = s
            .collapse(&["a"], "x", |r| {
                Ok(r.number("a")?.filter(|_| r.index() > 0).map(Scalar::Number))
            })
            .unwrap();
        assert_eq!(late.column("x").unwrap().kind(), ColumnKind::Number);
        assert!(!late.column("x").unwrap().is_required());
        let mixed = s.collapse(&["b"], "x", |r| {
            Ok(Some(if r.index() == 2 {
                Scalar::String("t".into())
            } else {
                Scalar::Number(1.0)
            }))
        });
        let e = mixed.unwrap_err().to_string();
        assert!(e.contains("row 2 gives a String value"), "{e}");
        // Non-finite numbers are gaps; booleans and text keep their kinds.
        let inf = s
            .collapse(&["b"], "x", |r| {
                Ok(Some(Scalar::Number(1.0 / r.number("b")?.unwrap())))
            })
            .unwrap();
        assert_eq!(inf.column("x").unwrap().numbers().unwrap().get(2), None);
        let flags = s
            .collapse_keep(&["b"], "x", |r| Ok(Some(Scalar::Boolean(r.index() == 1))))
            .unwrap();
        assert_eq!(
            flags.column("x").unwrap().booleans().unwrap().get(1),
            Some(true)
        );
        assert!(flags.column("x").unwrap().is_required());
        assert_eq!(flags.columns().len(), 3);
    }

    #[test]
    fn collapse_names_must_be_free() {
        let s = net();
        let none = |_: &Row<'_>| Ok(None);
        assert!(matches!(
            s.collapse(&["a"], "b", none),
            Err(PondError::DuplicateOutput { .. })
        ));
        assert!(matches!(
            s.collapse_keep(&["a"], "a", none),
            Err(PondError::DuplicateOutput { .. })
        ));
        assert!(matches!(
            s.collapse(&["a"], "time", none),
            Err(PondError::DuplicateOutput { .. })
        ));
        assert!(matches!(
            s.collapse(&["nope"], "x", none),
            Err(PondError::UnknownColumn { .. })
        ));
        // Replacing a dropped column's name is fine.
        assert!(s.collapse(&["a", "b"], "a", none).is_ok());
    }

    #[test]
    fn pivot_names_decimal_groups_and_refuses_clashes() {
        let s = TimeSeries::new(
            "s",
            vec![0, 0, 1000],
            vec![
                Column::required(
                    "g",
                    DecimalColumn::from_values(vec![150, -5, 150], 2).unwrap(),
                ),
                Column::required("v", vec![1.0, 2.0, 3.0]),
            ],
        )
        .unwrap();
        let wide = s.pivot_by_group("g", "v", &Pivot::default()).unwrap();
        let names: Vec<&str> = wide.columns().iter().map(|c| c.name()).collect();
        assert_eq!(names, ["-0.05_v", "1.50_v"]);
        // A declared group listed twice is an error.
        let twice = s.pivot_by_group("g", "v", &Pivot::default().groups(["a", "a"]));
        assert!(twice.unwrap_err().to_string().contains("declared twice"));
        // An output column named like the key.
        let keyed = TimeSeries::new(
            "s",
            vec![0],
            vec![
                Column::required("g", vec!["x"]),
                Column::required("time", vec![1.0]),
            ],
        );
        assert!(keyed.is_err(), "a value column cannot take the key's name");
        let clash = TimeSeries::new(
            "s",
            vec![0],
            vec![
                Column::required("g", vec!["time"]),
                Column::required("v", vec![1.0]),
            ],
        )
        .unwrap()
        .pivot_by_group("g", "v", &Pivot::default());
        assert!(clash.is_ok(), "time_v is not the key");
    }

    #[test]
    fn concat_checks_what_it_cannot_stack() {
        let dec = |scale| {
            TimeSeries::new(
                "d",
                vec![0],
                vec![Column::required(
                    "p",
                    DecimalColumn::from_values(vec![1], scale).unwrap(),
                )],
            )
            .unwrap()
        };
        let e = TimeSeries::concat(&[&dec(2), &dec(3)])
            .unwrap_err()
            .to_string();
        assert!(e.contains("scale 3 in series 1 but 2"), "{e}");
        assert_eq!(TimeSeries::concat(&[&dec(2), &dec(2)]).unwrap().len(), 2);

        let labelled = |label: Labels| {
            TimeSeries::from_intervals(
                "i",
                IntervalKeys {
                    label,
                    begin: vec![0],
                    end: vec![10],
                },
                vec![],
            )
            .unwrap()
        };
        let numbers = labelled(Labels::Number(vec![1.0]));
        let text = labelled(Labels::String(StringColumn::from_options([Some("a")])));
        let e = TimeSeries::concat(&[&numbers, &text])
            .unwrap_err()
            .to_string();
        assert!(e.contains("text interval labels"), "{e}");
        assert!(TimeSeries::concat(&[]).is_err());

        // Required only when every input has it required.
        let required =
            TimeSeries::new("r", vec![0], vec![Column::required("v", vec![1.0])]).unwrap();
        let optional =
            TimeSeries::new("o", vec![0], vec![Column::optional("v", vec![None::<f64>])]).unwrap();
        for pair in [[&required, &optional], [&optional, &required]] {
            let both = TimeSeries::concat(&pair).unwrap();
            assert!(!both.column("v").unwrap().is_required());
            assert_eq!(both.name(), pair[0].name());
        }
        let twice = TimeSeries::concat(&[&required, &required]).unwrap();
        assert!(twice.column("v").unwrap().is_required());
    }
}
