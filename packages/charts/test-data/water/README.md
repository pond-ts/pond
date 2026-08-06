# Wabash River gage record — USGS 03335500

Real, public-domain USGS data for **Wabash River at Lafayette, Indiana**
(`USGS-03335500`). Gage height in feet, 15-minute instantaneous values,
2025-08-04 → 2026-08-04.

Used by gallery chart **C5 (river stage)** — see
`docs/notes/charts-gallery-plan-2026-08.md` §4, Track C.

## Files

| File                        | Rows   | What it is                                                    |
| --------------------------- | ------ | ------------------------------------------------------------- |
| `stage-15min.csv`           | 34,746 | The series: `time`, `gage_height_ft`, `approval`.             |
| `time-series-metadata.csv`  | 1      | Site metadata — **including the flood-stage thresholds**.     |
| `field-measurements.csv`    | —      | Discrete field visits (rated discharge measurements).         |
| `channel-measurements.csv`  | —      | Channel geometry from those visits.                           |

## Why `stage-15min.csv` is a trimmed extract

The raw download (`primary-time-series.csv`, 6.1 MB) repeats latitude,
longitude, four identifier columns and a `last_modified` stamp on **every one
of its 34,746 rows** — roughly 176 bytes per row to carry one timestamp and one
float. Committing that verbatim would put ~5 MB of duplicated constants into
git history forever.

The extract keeps every row and every value that varies, at 884 KB:

```
time,gage_height_ft,approval
2025-08-04T11:30Z,5.67,A
```

Nothing is resampled, filtered or rounded — row count, value range and the
approval split are identical to the source. The constant columns are recorded
here instead of on every row, and the per-site metadata is in
`time-series-metadata.csv`.

Regenerate from a fresh download with:

```bash
python3 -c "
import csv
rows = sorted(
    (r['time'], r['value'], r['approval_status'])
    for r in csv.DictReader(open('primary-time-series.csv'))
)
w = csv.writer(open('stage-15min.csv', 'w', newline=''))
w.writerow(['time', 'gage_height_ft', 'approval'])
for t, v, a in rows:
    w.writerow([t.replace(' ', 'T')[:16] + 'Z', v, a[0]])
"
```

## Two things that make this worth charting

- **The thresholds are in the data's own metadata.** `time-series-metadata.csv`
  carries the site's flood stages as structured `thresholds` JSON — minor
  **11 ft**, moderate **18 ft**, major **26 ft**, plus operational limits. The
  record peaks at **15.59 ft**, so it crosses minor flood stage and not
  moderate. Baselines that are genuinely sourced rather than invented.
- **`approval` is real data lineage.** 13,256 rows `A` (Approved, reviewed by
  USGS) against 21,490 `P` (Provisional, not yet reviewed) — the recent tail is
  always provisional. That's a `Region`, and a data-quality story no synthetic
  fixture can tell.

## Provenance

Retrieved 2026-08-04 from the USGS Water Data APIs. USGS data are in the
**public domain**; cite as *U.S. Geological Survey, National Water Information
System*. Values marked `P` are provisional and subject to revision.
