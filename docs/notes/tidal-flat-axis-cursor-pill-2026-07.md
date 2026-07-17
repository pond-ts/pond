# Tidal report — 0.47.0 flat axis vs the cursor time pill (F-charts-7 escalated)

_Filed by the Tidal agent (Claude), 2026-07-17, on Peter's behalf. Cross-ref:
Tidal `CHARTS_FRICTION.md` F-charts-7._

## TL;DR

Adopting 0.47.0's flat `dateStyle` (the release headline — great, shipped in
Tidal's terminal same-day) **forces us to give back our F-charts-7 workaround**:
the day-floor `timeFormat` we passed to keep the crosshair x-pill reading
`Sep 14` instead of `02 AM` on daily bars. A custom `format`/`timeFormat` opts
the axis out of the date styles **by design** ("a custom format owns the
labels") — but our format was never about the labels; it existed solely to fix
the pill. One knob, two concerns. We shipped the flat axis and are eating the
`02 AM` pill (verified on 0.47.0, Europe/Madrid, UTC-midnight daily bars).

## Repro

- Daily `TimeSeries` (UTC-midnight instants), `ChartContainer` with
  `cursor="crosshair"`, no `timeFormat`, viewer in any UTC+ zone.
- Axis ticks: correct flat layout (`… 17 Jun 16 Jul …`).
- Hover: the x-axis cursor pill reads `02 AM` — the bar's UTC-midnight instant
  formatted at sub-day granularity in local time.

## Ask (best-first)

1. **Resolve the pill at the data grid's granularity by default.** The
   crosshair x already snaps to the data grid; the pill should format at that
   grid's grain — a daily (or session/trading) axis reads a date, never a
   time-of-day. This deletes the consumer knob entirely and fixes every
   consumer's TZ story at once. (F-charts-7's original ask.)
2. Failing that, a **pill-only format** (e.g. `cursorFormat` on
   `ChartContainer`, falling back to `timeFormat`) that does **not** disqualify
   `dateStyle` — so a consumer can keep the flat axis and shape the readout.

## Context / praise

The rest of 0.47.0 adopted cleanly in one sitting: flat axis +
`align="right"` wired in the vol terminal (explicit `<TimeAxis>` with
`showAxis` off), hierarchical grid live via the default, session-index tick
thinning noticeably better on the collapsed trading axis. The stacked
zebra-band style and `sessionDividers` are queued as settings-page toggles on
our side.
