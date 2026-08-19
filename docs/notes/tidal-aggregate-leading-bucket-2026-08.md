# Tidal report — `aggregate` silently drops every event before its first emitted bucket

_Filed by the Tidal agent (Claude), 2026-08-20, on Peter's behalf. Cross-ref:
Tidal `CHARTS_FRICTION.md` F-charts-16. Observed on `pond-ts` 0.62.0._

## TL;DR

`TimeSeries.aggregate(sequence, mapping)` bounds the grid by `options.range`,
whose default is `series.timeRange()`. The first bucket emitted is the first
grid boundary **at or after** the first event — so every event between the first
event and that boundary belongs to a bucket that is never emitted, and is
aggregated into **nothing**. 60 daily bars rolled to `'1mo'` came back holding
38 of them. No error, no warning, no `undefined` — a well-formed series with
plausible buckets and a third of the input gone.

This is not a partial-bucket policy: the **trailing** partial bucket *is*
emitted. Only leading ones are dropped.

## Repro

Run as-is against 0.62.0 — output in the comment is what it printed:

```ts
import { Sequence, TimeSeries } from 'pond-ts';

const DAY = 86_400_000;
const bars = (startUtc: number, n: number) =>
  TimeSeries.fromColumns({
    name: 'x',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'volume', kind: 'number' },
    ],
    columns: {
      time: Array.from({ length: n }, (_, i) => startUtc + i * DAY),
      volume: Array.from({ length: n }, () => 1),
    },
  });

const cal = Sequence.calendar('month', { timeZone: 'UTC' });
const agg = bars(Date.UTC(2024, 0, 10), 60).aggregate(cal, { volume: 'sum' });

// ["2024-02-01 v=29", "2024-03-01 v=9"] — total 38 of 60.
// The 22 bars from 10 Jan to 31 Jan belong to the [1 Jan, 1 Feb) bucket,
// which is never emitted.
```

Measured across three shapes, all with `Sequence.calendar(unit, { timeZone: 'UTC', weekStartsOn: 1 })`:

| Input                                             | Buckets emitted | Events in | Events accounted for |
| ------------------------------------------------- | --------------- | --------- | -------------------- |
| 14 daily bars from Wed 3 Jan 2024, `'week'`        | Jan 8, Jan 15   | 14        | **9**                |
| 60 daily bars from 10 Jan 2024, `'month'`          | Feb 1, Mar 1    | 60        | **38**               |
| 3 sessions of 1-minute bars from 13:30Z, `'day'`   | day 2, day 3    | 1170      | **780**              |

## Why this reads as a bug rather than a policy

`aggregate`'s own docstring states the membership rule:

> Buckets use half-open membership semantics: `[begin, end)`. Point events
> contribute to the bucket containing their timestamp.

For the dropped events the bucket containing their timestamp is not in the
output, so they contribute to nothing — the documented rule and the behaviour
disagree. The `range` paragraph frames the override as a way to *add* buckets
("including leading or trailing empty buckets outside an individual series
extent"), which reads as "the default covers your data" — it doesn't.

The asymmetry is the strongest signal. Given bars from 09:30 on day 1 to 15:59
on day 3, a daily grid emits a trailing bucket that runs past the last bar
(partial, kept) but no leading bucket for day 1 (partial, dropped). Whatever
rule justifies dropping the leading partial should drop the trailing one too.

## Why it stayed invisible for a long time

Daily bars keyed at UTC midnight land exactly on the day/week/month boundary, so
nothing falls before the first bucket. That is most fixtures, and it was ours:
Tidal's `aggregate.test.ts` anchored on `Date.UTC(2024, 0, 1)` — a Monday that is
also a month start, the one date that cannot show the bug. Four waves of weekly
and monthly candles shipped over it. It surfaced only when we fed the same code
1-minute bars, where the first event is 13:30 and never a boundary.

## What we did

Floored the range to the bucket containing the first event and passed it
explicitly:

```ts
series.aggregate(grid, mapping, {
  range: { start: floorToWindow(range.begin(), window), end: range.end() },
});
```

The cost is that `floorToWindow` re-implements pond's UTC day / Monday-week /
month-start flooring in the consumer, purely to compensate, and now has to stay
in step with `Sequence.calendar`'s own anchoring — including `weekStartsOn` and
any future time-zone handling. That duplication is the reason we are reporting
it rather than keeping the workaround quietly.

## Ask (best-first)

1. **Make the default range cover the buckets that contain the data** — floor
   the realization to the bucket containing `range.begin()`. This makes the
   behaviour match the documented membership rule, and is what every consumer we
   can imagine already assumes.
2. If today's behaviour is load-bearing somewhere, an explicit opt-in
   (`{ leading: 'floor' | 'skip' }`, defaulting to `'floor'`) plus a line on
   `aggregate` saying what happens to events before the first boundary.
3. Failing both: **document it**, and consider exposing the flooring
   (`Sequence.floor(t)` or similar) so consumers compensating for it are not
   re-deriving calendar anchoring by hand.

A note either way would be useful — if (1) lands we delete `floorToWindow` and
the duplicated calendar logic with it.
