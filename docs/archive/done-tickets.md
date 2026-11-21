# Archived tickets

Finished tickets taken out of `PLAN.md` by Planner, newest at the bottom. Each one is kept as it read when it came out.

## 2026-11-21

From `PLAN.md`, pond-rs — native Rust core:

- **[PND-ARROWREQ]** — pond-ts `fromArrow` declares every value column
  required, even one with nulls, so its own `toJSON` → `fromJSON` round trip
  then throws ("row 1 col 1 (v) is required"). Reproduced 2026-10-17 with a
  nullable Float64 column `[1, null]`. Proposed fix: take `required` from the
  Arrow field's nullability, as pond-rs now does (Codex review of pond-rs,
  finding 5), so both read the same file to the same schema. Until then they
  differ on every pyarrow / polars file (both mark fields nullable by
  default): pond-rs reads such columns as optional, pond-ts as required.
  - _Archived: Done in pull request #942 (wave "Columnar optionals") on 2026-11-19._
- **[PND-MAPREQ]** — pond-ts `mapColumns` keeps a column marked required
  even when the mapping leaves a gap (a non-finite result is stored as a
  gap), so its own `toJSON` → `fromJSON` round trip then throws ("row 3 col
  1 (value) is required"). Repro: parity case `mapColumns-overflow`
  (`v => v * 1e308 + 1e308` on a required column). Same class as
  [PND-ARROWREQ]. pond-rs makes the column optional when a gap appears;
  pond-ts should do the same. Found 2026-10-19 (pond-rs R1b step 3b).
  - _Archived: Done in pull request #942 (wave "Columnar optionals") on 2026-11-19._
- **[PND-COLSREQ]** — pond-ts `fromColumns` ignores `required`: a column
  the schema marks required (the default) is read with its gaps and stays
  marked required, so the series' own `toJSON` → `fromJSON` round trip
  then throws. Same class as [PND-ARROWREQ] / [PND-MAPREQ]. pond-rs marks
  such a column optional. Found 2026-10-20 (pond-rs R1b step 8d2).
  - _Archived: Done in pull request #942 (wave "Columnar optionals") on 2026-11-19._
- **[PND-COLLAPSEREQ]** — pond-ts `collapse` marks its output column
  required, but a non-finite result (`0 / 0`) or a reducer returning
  `undefined` leaves gaps in it, and the series then fails to reload
  through `fromJSON`. The reducer's type returns `ScalarValue` (no
  `undefined`), so the fix (output `required: false`, typed `R |
undefined`, or required only when it has no gaps) changes a public
  type and needs a yes. pond-rs marks it required only when it has no
  gaps. Found 2026-10-21 (pond-rs R1b step 8i).
  - _Archived: Done in pull request #942 (wave "Columnar optionals") on 2026-11-19._

