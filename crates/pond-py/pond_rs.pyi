"""Time series analytics over Arrow frames, backed by the pond-rs Rust crate.

Same results as pond-ts (TypeScript) and pond-rs (Rust): every operation is
checked against pond-ts's own output.

    import pond_rs, polars as pl
    s = pond_rs.TimeSeries(df, key="time")           # pyarrow / polars / pandas / dict
    per_min = s.aggregate("1m", {"cpu_avg": ("cpu", "avg")})
    per_min.to_polars()                               # or to_pyarrow(), to_pandas()

Times are epoch milliseconds inside. Anywhere a time is taken you may pass
an int (milliseconds), a datetime (no time zone means UTC), a date (midnight
UTC) or text ("2026-03-08T12:00:00Z"). Durations are text ("500ms", "5s",
"5m", "1h", "1d") or a timedelta. A key is a time, a (begin, end) tuple or a
(label, begin, end) tuple.

Reducer mappings name each output column: {"avg": ("cpu", "avg")},
{"avg": {"from": "cpu", "using": "avg"}}, or {"cpu": "avg"} to reduce a
column into itself. Reducers: count, sum, avg (mean), min, max, first, last,
median, stdev, difference, keep, unique, samples, topN (top3), pNN (p95).
"""

from __future__ import annotations

import datetime as _dt
import os
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence as _Seq
from decimal import Decimal
from typing import Any, Literal, Optional, TypedDict, Union, overload

from typing_extensions import Self

__version__: str
tzdb_version: Optional[str]

Time = Union[int, float, str, _dt.datetime, _dt.date]
Duration = Union[str, _dt.timedelta]
Key = Union[Time, tuple[Time, Time], tuple[Union[float, str], Time, Time]]
Cell = Union[float, str, bool, Decimal, list[Union[float, str, bool]], None]
Spec = Union[str, tuple[str, str], Mapping[str, str]]
Aggs = Mapping[str, Spec]
Grid = Union["Sequence", Duration]
Alignment = Literal["trailing", "leading", "centered"]
At = Literal["begin", "center", "end"]
Range = Union[tuple[Time, Time], Time, None]
Columns = Union[str, _Seq[str]]

class PondError(ValueError):
    """Bad input data, an unknown column, a column of the wrong kind, a bad
    duration, reducer or option word. The message names the call and the
    column. A value of the wrong type (text where a number is needed) is a
    TypeError instead."""

def parse_time(text: str, time_zone: Optional[str] = None) -> int:
    """Text to epoch milliseconds, as pond-ts Time.parse. Text without an
    offset is read in time_zone (UTC when not given)."""

def parse_duration(text: str) -> int:
    """Duration text ("5m") to whole milliseconds."""

class Sequence:
    """A grid of buckets: fixed steps or calendar units in a time zone."""

    @staticmethod
    def every(step: Duration, *, anchor: Optional[Time] = None) -> Sequence: ...
    @staticmethod
    def calendar(
        unit: Literal["minute", "hour", "day", "week", "month", "quarter", "year"],
        time_zone: str = "UTC",
        *,
        week_starts_on: Optional[int] = None,
    ) -> Sequence:
        """Calendar buckets in an IANA zone; a day is 23 or 25 hours when the
        clocks change. week_starts_on: 1 = Monday … 7 = Sunday."""
    def buckets(self, begin: Time, end: Time) -> list[tuple[int, int]]:
        """Every bucket overlapping [begin, end] as (begin, end) ms pairs."""

class Row:
    """One row: row["cpu"] reads a cell (None for a gap)."""

    @property
    def index(self) -> int: ...
    @property
    def begin(self) -> int: ...
    @property
    def end(self) -> int: ...
    @property
    def key(self) -> Union[int, tuple[int, int], tuple[Union[float, str], int, int]]: ...
    def __getitem__(self, column: str) -> Cell: ...
    def get(self, column: str, default: Any = None) -> Cell: ...
    def keys(self) -> list[str]: ...
    def to_dict(self) -> dict[str, Cell]: ...

class _Shared:
    """Operations a TimeSeries and a PartitionedSeries both have. On a
    PartitionedSeries each runs per group (on several cores)."""

    def rolling(
        self,
        window: Union[Duration, int],
        aggs: Aggs,
        *,
        alignment: Alignment = "trailing",
        min_samples: int = 0,
        append: bool = False,
        over: Optional[Grid] = None,
        sample: At = "begin",
        range: Range = None,
    ) -> Self:
        """Reduce a window around each row: a duration, or an int count of
        rows. With over=, once per grid point instead of once per row.
        append=True keeps the source columns beside the outputs."""
    def aggregate(self, sequence: Grid, aggs: Aggs) -> Self:
        """One row per bucket of the grid, keyed by the bucket (interval)."""
    def diff(self, columns: Columns, *, drop_first: bool = False, output: Optional[str] = None) -> Self: ...
    def rate(self, columns: Columns, *, drop_first: bool = False, output: Optional[str] = None) -> Self:
        """Change per second."""
    def pct_change(self, columns: Columns, *, drop_first: bool = False, output: Optional[str] = None) -> Self: ...
    def shift(self, columns: Columns, n: int) -> Self: ...
    def cumulative(self, spec: Mapping[str, str]) -> Self:
        """Running reductions: {"cpu": "sum"}."""
    def fill(
        self,
        strategy: Union[str, float, bool, list[Any], Mapping[str, Any]],
        *,
        limit: Optional[int] = None,
        max_gap: Optional[Duration] = None,
    ) -> Self:
        """"hold", "bfill", "linear", "zero" or a value; or {column: strategy}."""
    def align(
        self,
        sequence: Grid,
        *,
        method: Literal["hold", "linear"] = "hold",
        sample: At = "begin",
        range: Range = None,
    ) -> Self: ...
    def materialize(
        self,
        sequence: Grid,
        *,
        pick: Literal["first", "last", "nearest"] = "last",
        sample: At = "begin",
        range: Range = None,
    ) -> Self: ...
    def dedupe(
        self,
        keep: Union[Literal["first", "last", "error", "drop"], tuple[Literal["min", "max"], str], None] = None,
    ) -> Self: ...
    def smooth(
        self,
        column: str,
        method: Literal["ema", "moving_average", "loess"],
        *,
        alpha: Optional[float] = None,
        span: Optional[float] = None,
        window: Optional[Duration] = None,
        warmup: Optional[int] = None,
        min_samples: Optional[int] = None,
        alignment: Optional[Alignment] = None,
        missing: Literal["bridge", "skip"] = "bridge",
        output: Optional[str] = None,
    ) -> Self: ...
    def baseline(
        self,
        column: str,
        window: Duration,
        sigma: float,
        *,
        alignment: Alignment = "trailing",
        min_samples: int = 0,
        names: Union[Mapping[str, str], _Seq[str], None] = None,
    ) -> Self:
        """Adds avg, sd, upper, lower (rename with names=)."""
    def outliers(
        self, column: str, window: Duration, sigma: float, *, alignment: Alignment = "trailing", min_samples: int = 0
    ) -> Self: ...
    def scan(
        self, column: str, step: Callable[[Any, float, int], tuple[Any, Optional[float]]], init: Any, *, output: Optional[str] = None
    ) -> Self:
        """step(state, value, index) -> (state, output); None output is a gap.
        On a PartitionedSeries each group starts from its own deep copy of
        init."""
    def sample(self, *, stride: Optional[int] = None, reservoir: Optional[int] = None, seed: int = 0) -> Self: ...

    def study(self, name: str, **options: Any) -> Self:
        """Run a financial study by name ("rsi", "bollinger",
        "anchored_vwap") with its options as keywords. Every study is also a
        method of its own (below); pond_rs.studies() describes them all. A
        study adds its columns and keeps every row; an option the study does
        not have is a TypeError."""

    # --- studies: generated by scripts/gen_stubs.py from pond_rs.studies() ---
    def sma(
        self,
        *,
        column: str = 'close',
        period: int,
        output: str = 'sma',
    ) -> Self:
        """Simple moving average of a column.
        Adds sma (moving-average).
        Options: period: min 1; usually 5-200; required, e.g. 20."""
    def ema(
        self,
        *,
        column: str = 'close',
        period: int,
        output: str = 'ema',
    ) -> Self:
        """Exponential moving average, span convention (α = 2/(period+1)).
        Adds ema (moving-average).
        Options: period: min 1; usually 5-200; required, e.g. 20."""
    def moving_average(
        self,
        *,
        column: str = 'close',
        period: int,
        type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        output: str = 'ma',
    ) -> Self:
        """Moving average of a selectable type (the shared MaType menu).
        Adds ma (moving-average).
        Options: period: min 1; usually 5-200; required, e.g. 20; type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema."""
    def macd(
        self,
        *,
        column: str = 'close',
        fast_period: int = 12,
        signal_period: int = 9,
        slow_period: int = 26,
        prefix: str = 'macd',
    ) -> Self:
        """Appel's MACD — a fast/slow EMA spread with its signal line.
        Adds macdLine, macdSignal, macdHist (moving-average).
        Options: fast_period: min 1; usually 5-20; signal_period: min 1; usually 3-20; slow_period: usually 20-60."""
    def moving_average_cross(
        self,
        *,
        column: str = 'close',
        fast_period: int = 10,
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        slow_period: int = 30,
        output: str = 'maCross',
    ) -> Self:
        """Fast/slow moving-average crossings as a +1/−1 event column.
        Adds maCross (moving-average).
        Options: fast_period: min 1; usually 5-25; ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; slow_period: usually 15-200."""
    def moving_average_deviation(
        self,
        *,
        column: str = 'close',
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        period: int = 20,
        output: str = 'maDev',
    ) -> Self:
        """How far price sits from its moving average, in price units.
        Adds maDev (moving-average).
        Options: ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; period: min 1; usually 5-100."""
    def guppy(
        self,
        *,
        column: str = 'close',
        type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'ema',
        prefix: str = 'gmma',
    ) -> Self:
        """Guppy's GMMA — the fixed twelve-average trader/investor ribbon.
        Adds gmmaS3, gmmaS5, gmmaS8, gmmaS10, gmmaS12, gmmaS15, gmmaL30, gmmaL35, gmmaL40, gmmaL45, gmmaL50, gmmaL60 (moving-average).
        Options: type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema."""
    def rainbow(
        self,
        *,
        column: str = 'close',
        period: int = 2,
        type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        prefix: str = 'rainbow',
    ) -> Self:
        """Widner's Rainbow — ten recursively smoothed moving averages.
        Adds rainbow1, rainbow2, rainbow3, rainbow4, rainbow5, rainbow6, rainbow7, rainbow8, rainbow9, rainbow10 (moving-average).
        Options: period: min 1; usually 2-10; type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema."""
    def rainbow_oscillator(
        self,
        *,
        column: str = 'close',
        lookback: int = 10,
        period: int = 2,
        type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        prefix: str = 'rbo',
    ) -> Self:
        """ChartIQ's rainbow oscillator, banded by the stack's own width.
        Adds rbo, rboUpper, rboLower (moving-average).
        Options: lookback: min 1; usually 5-50; period: min 1; usually 2-10; type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema."""
    def trix(
        self,
        *,
        column: str = 'close',
        period: int = 15,
        signal_period: int = 9,
        prefix: str = 'trix',
    ) -> Self:
        """Hutson's TRIX — percent rate of change of a triple EMA.
        Adds trix, trixSignal (moving-average).
        Options: period: min 1; usually 5-40; signal_period: min 1; usually 3-20."""
    def schaff_trend_cycle(
        self,
        *,
        column: str = 'close',
        cycle_period: int = 10,
        fast_period: int = 23,
        slow_period: int = 50,
        output: str = 'stc',
    ) -> Self:
        """Schaff's double stochastic of a MACD, bounded 0…100.
        Adds stc (moving-average).
        Options: cycle_period: min 1; usually 5-30; fast_period: min 1; usually 10-40; slow_period: usually 30-100."""
    def detrended_price_oscillator(
        self,
        *,
        column: str = 'close',
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        period: int = 20,
        output: str = 'dpo',
    ) -> Self:
        """Price less a moving average displaced ⌊period/2⌋+1 bars back.
        Adds dpo (moving-average).
        Options: ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; period: min 1; usually 10-50."""
    def disparity_index(
        self,
        *,
        column: str = 'close',
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        period: int = 14,
        output: str = 'disparity',
    ) -> Self:
        """Nison's disparity — price against its moving average, in percent.
        Adds disparity (moving-average).
        Options: ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; period: min 1; usually 5-50."""
    def coppock(
        self,
        *,
        column: str = 'close',
        long_period: int = 14,
        short_period: int = 11,
        wma_period: int = 10,
        output: str = 'coppock',
    ) -> Self:
        """Coppock Curve — a WMA of two percent rates of change, summed.
        Adds coppock (moving-average).
        Options: long_period: min 1; usually 8-24; short_period: min 1; usually 6-20; wma_period: min 1; usually 5-20."""
    def kst(
        self,
        *,
        column: str = 'close',
        signal_period: int = 9,
        prefix: str = 'kst',
    ) -> Self:
        """Pring's Know Sure Thing — four weighted smoothed percent ROCs.
        Adds kst, kstSignal (moving-average).
        Options: signal_period: min 1; usually 3-20."""
    def special_k(
        self,
        *,
        column: str = 'close',
        output: str = 'specialK',
    ) -> Self:
        """Pring's Special K — the KST extended to twelve terms.
        Adds specialK (moving-average)."""
    def price_oscillator(
        self,
        *,
        column: str = 'close',
        fast_period: int = 12,
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'ema',
        mode: Literal['percent', 'absolute'] = 'percent',
        slow_period: int = 26,
        output: str = 'priceOsc',
    ) -> Self:
        """Fast/slow MA spread, as a percent (PPO) or in points (APO).
        Adds priceOsc (moving-average).
        Options: fast_period: min 1; usually 5-20; ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; mode: one of percent, absolute; slow_period: usually 20-60."""
    def price_momentum_oscillator(
        self,
        *,
        column: str = 'close',
        prefix: str = 'pmo',
    ) -> Self:
        """DecisionPoint's PMO — a double-smoothed 1-bar percent ROC.
        Adds pmo, pmoSignal (moving-average)."""
    def bollinger(
        self,
        *,
        column: str = 'close',
        period: int,
        std_dev: float = 2,
        prefix: str = 'bb',
    ) -> Self:
        """Bollinger Bands — an SMA middle band with bands at ±k·σ.
        Adds bbMiddle, bbUpper, bbLower (bands).
        Options: period: min 1; usually 10-50; required, e.g. 20; std_dev: usually 1-3."""
    def bollinger_bandwidth(
        self,
        *,
        column: str = 'close',
        period: int = 20,
        std_dev: float = 2,
        output: str = 'bbWidth',
    ) -> Self:
        """Bollinger BandWidth — the channel's width in percent of price.
        Adds bbWidth (bands).
        Options: period: min 1; usually 10-50; std_dev: usually 1-3."""
    def bollinger_percent_b(
        self,
        *,
        column: str = 'close',
        period: int = 20,
        std_dev: float = 2,
        output: str = 'percentB',
    ) -> Self:
        """Bollinger %B — where price sits inside its own channel.
        Adds percentB (bands).
        Options: period: min 1; usually 10-50; std_dev: usually 1-3."""
    def keltner(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        atr_period: int = 10,
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'ema',
        multiplier: float = 2,
        period: int = 20,
        prefix: str = 'kc',
    ) -> Self:
        """Keltner Channel — an EMA of typical price with bands at ±k·ATR.
        Adds kcMiddle, kcUpper, kcLower (bands).
        Options: atr_period: min 1; usually 5-30; ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; multiplier: usually 1-4; period: min 1; usually 10-50."""
    def starc_bands(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        atr_period: int = 15,
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        multiplier: float = 2,
        period: int = 20,
        prefix: str = 'starc',
    ) -> Self:
        """STARC Bands (Stoller) — an MA of close with bands at ±k·ATR.
        Adds starcMiddle, starcUpper, starcLower (bands).
        Options: atr_period: min 1; usually 5-30; ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; multiplier: usually 1-4; period: min 1; usually 10-50."""
    def atr_bands(
        self,
        *,
        column: str = 'close',
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        multiplier: float = 2,
        period: int = 14,
        prefix: str = 'atrb',
    ) -> Self:
        """A field with volatility bands at ±k·ATR either side of it.
        Adds atrbUpper, atrbLower (bands).
        Options: multiplier: usually 1-4; period: min 1; usually 5-50."""
    def donchian(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        period: int = 20,
        prefix: str = 'dc',
    ) -> Self:
        """Donchian channel — the window's highest high and lowest low.
        Adds dcUpper, dcLower, dcMiddle (bands).
        Options: period: min 1; usually 10-55."""
    def high_low_bands(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'trima',
        percent: float = 1,
        period: int = 10,
        prefix: str = 'hlb',
    ) -> Self:
        """High Low Bands — a smoothed median price ±percent.
        Adds hlbMiddle, hlbUpper, hlbLower (bands).
        Options: ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; percent: usually 0.5-5; period: min 1; usually 5-30."""
    def prime_number_bands(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        prefix: str = 'pnb',
    ) -> Self:
        """The primes immediately bracketing each bar's high and low.
        Adds pnbUpper, pnbLower (bands)."""
    def envelope(
        self,
        *,
        column: str = 'close',
        period: int,
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        percent: float = 2.5,
        prefix: str = 'env',
    ) -> Self:
        """Moving-average envelope — bands at ±percent of the centre line.
        Adds envMiddle, envUpper, envLower (bands).
        Options: ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; percent: usually 0.5-10; period: min 1; usually 10-50; required, e.g. 20."""
    def rsi(
        self,
        *,
        column: str = 'close',
        period: int = 14,
        output: str = 'rsi',
    ) -> Self:
        """Wilder's relative strength index, bounded 0..100.
        Adds rsi (momentum).
        Options: period: min 1; usually 5-30."""
    def stochastic(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        d_period: int = 3,
        k_period: int = 14,
        slowing: int = 3,
        prefix: str = 'stoch',
    ) -> Self:
        """Lane's stochastic — where the close sits in its recent range.
        Adds stochK, stochD (momentum).
        Options: d_period: min 1; usually 1-10; k_period: min 1; usually 5-30; slowing: min 1; usually 1-10."""
    def stochastic_momentum_index(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        long_period: int = 25,
        period: int = 13,
        short_period: int = 2,
        signal_period: int = 3,
        prefix: str = 'smi',
    ) -> Self:
        """Blau's SMI — the close against the range midpoint, smoothed.
        Adds smi, smiSignal (momentum).
        Options: long_period: min 1; usually 3-50; period: min 1; usually 5-30; short_period: min 1; usually 1-10; signal_period: min 1; usually 1-15."""
    def stochastic_rsi(
        self,
        *,
        column: str = 'close',
        d_period: int = 3,
        k_period: int = 3,
        rsi_period: int = 14,
        stoch_period: int = 14,
        prefix: str = 'stochRsi',
    ) -> Self:
        """Chande & Kroll's stochastic of the RSI's own range.
        Adds stochRsiK, stochRsiD (momentum).
        Options: d_period: min 1; usually 1-10; k_period: min 1; usually 1-10; rsi_period: min 1; usually 5-30; stoch_period: min 1; usually 5-30."""
    def williams_r(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        period: int = 14,
        output: str = 'williamsR',
    ) -> Self:
        """Williams %R — the close below the recent high, −100..0.
        Adds williamsR (momentum).
        Options: period: min 1; usually 5-30."""
    def chande_momentum(
        self,
        *,
        column: str = 'close',
        period: int = 14,
        output: str = 'cmo',
    ) -> Self:
        """Chande's momentum oscillator — unsmoothed up/down sums.
        Adds cmo (momentum).
        Options: period: min 1; usually 5-30."""
    def momentum(
        self,
        *,
        column: str = 'close',
        period: int = 10,
        output: str = 'momentum',
    ) -> Self:
        """The change from n bars ago, in the price’s own units.
        Adds momentum (momentum).
        Options: period: min 1; usually 1-50."""
    def percent_change(
        self,
        *,
        column: str = 'close',
        periods: int = 1,
        output: str = 'pctChange',
    ) -> Self:
        """Percent change from n bars ago — the rate of change.
        Adds pctChange (momentum).
        Options: periods: min 1; usually 1-20."""
    def intraday_momentum_index(
        self,
        *,
        open: str = 'open',
        close: str = 'close',
        period: int = 14,
        output: str = 'imi',
    ) -> Self:
        """Chande's IMI — RSI's question asked of the candle body.
        Adds imi (momentum).
        Options: period: min 1; usually 5-30."""
    def awesome_oscillator(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        fast_period: int = 5,
        slow_period: int = 34,
        output: str = 'ao',
    ) -> Self:
        """Bill Williams' AO — fast minus slow SMA of the median price.
        Adds ao (momentum).
        Options: fast_period: min 1; usually 2-20; slow_period: usually 10-60."""
    def ultimate_oscillator(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        long_period: int = 28,
        medium_period: int = 14,
        short_period: int = 7,
        output: str = 'uo',
    ) -> Self:
        """Williams' three-horizon buying pressure, weighted 4/2/1.
        Adds uo (momentum).
        Options: long_period: usually 20-60; medium_period: usually 10-25; short_period: min 1; usually 3-12."""
    def commodity_channel_index(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        period: int = 20,
        output: str = 'cci',
    ) -> Self:
        """Lambert's CCI — typical price in mean absolute deviations.
        Adds cci (momentum).
        Options: period: min 1; usually 10-50."""
    def fisher_transform(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        period: int = 10,
        prefix: str = 'fisher',
    ) -> Self:
        """Ehlers' Fisher transform of the normalised median price.
        Adds fisher, fisherSignal (momentum).
        Options: period: min 1; usually 5-30."""
    def psychological_line(
        self,
        *,
        column: str = 'close',
        period: int = 12,
        output: str = 'psy',
    ) -> Self:
        """The percentage of the last n bars that closed up.
        Adds psy (momentum).
        Options: period: min 1; usually 5-30."""
    def pretty_good_oscillator(
        self,
        *,
        column: str = 'close',
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        period: int = 14,
        output: str = 'pgo',
    ) -> Self:
        """Johnson's PGO — distance from the SMA in average true ranges.
        Adds pgo (momentum).
        Options: period: min 1; usually 5-50."""
    def prime_number_oscillator(
        self,
        *,
        column: str = 'close',
        output: str = 'pno',
    ) -> Self:
        """The distance from the price to the prime nearest it.
        Adds pno (momentum)."""
    def qstick(
        self,
        *,
        open: str = 'open',
        close: str = 'close',
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        period: int = 8,
        output: str = 'qstick',
    ) -> Self:
        """Chande's QStick — a moving average of the candle body.
        Adds qstick (momentum).
        Options: ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; period: min 1; usually 2-30."""
    def relative_vigor_index(
        self,
        *,
        open: str = 'open',
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        period: int = 10,
        prefix: str = 'rvi',
    ) -> Self:
        """Ehlers' RVI — the body as a fraction of the range, plus signal.
        Adds rvi, rviSignal (momentum).
        Options: period: min 1; usually 4-30."""
    def center_of_gravity(
        self,
        *,
        column: str = 'close',
        period: int = 10,
        output: str = 'cog',
    ) -> Self:
        """Ehlers' CG — where the window's price mass balances, in bars.
        Adds cog (momentum).
        Options: period: min 1; usually 5-30."""
    def chande_forecast_oscillator(
        self,
        *,
        column: str = 'close',
        period: int = 14,
        output: str = 'cfo',
    ) -> Self:
        """Chande's CFO — the price against its own forecast, in percent.
        Adds cfo (momentum).
        Options: period: min 2; usually 5-50."""
    def true_strength_index(
        self,
        *,
        column: str = 'close',
        long_period: int = 25,
        short_period: int = 13,
        signal_period: int = 7,
        prefix: str = 'tsi',
    ) -> Self:
        """Blau's TSI — double-smoothed net change over total change.
        Adds tsi, tsiSignal (momentum).
        Options: long_period: min 1; usually 10-50; short_period: min 1; usually 5-30; signal_period: min 1; usually 3-20."""
    def directional_movement(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        period: int = 14,
        prefix: str = 'dmi',
    ) -> Self:
        """Wilder's directional movement system — +DI/−DI, DX, ADX, ADXR.
        Adds dmiPlusDi, dmiMinusDi, dmiDx, dmiAdx, dmiAdxr (trend).
        Options: period: min 1; usually 5-50."""
    def aroon(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        period: int = 25,
        prefix: str = 'aroon',
    ) -> Self:
        """Chande's Aroon — how recently the window's extremes printed.
        Adds aroonUp, aroonDown, aroonOsc (trend).
        Options: period: min 1; usually 10-50."""
    def vortex(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        period: int = 14,
        prefix: str = 'vi',
    ) -> Self:
        """Vortex Indicator — Botes & Siepman's crossed movement pair.
        Adds viPlus, viMinus (trend).
        Options: period: min 1; usually 5-50."""
    def vertical_horizontal_filter(
        self,
        *,
        column: str = 'close',
        period: int = 28,
        output: str = 'vhf',
    ) -> Self:
        """Adam White's VHF — net movement over total movement.
        Adds vhf (trend).
        Options: period: min 1; usually 10-50."""
    def random_walk_index(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        period: int = 14,
        prefix: str = 'rwi',
    ) -> Self:
        """Poulos' RWI — the move in units of a random walk's reach.
        Adds rwiHigh, rwiLow (trend).
        Options: period: min 2; usually 5-40."""
    def super_trend(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        multiplier: float = 3,
        period: int = 10,
        prefix: str = 'st',
    ) -> Self:
        """SuperTrend — a ratcheting ATR band that flips with the close.
        Adds st, stTrend (trend).
        Options: multiplier: usually 1-5; period: min 1; usually 5-30."""
    def parabolic_sar(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        max_step: float = 0.2,
        step: float = 0.02,
        prefix: str = 'psar',
    ) -> Self:
        """Wilder's parabolic stop-and-reverse.
        Adds psar, psarTrend (trend).
        Options: max_step: usually 0.1-0.5; step: usually 0.01-0.05."""
    def atr_trailing_stop(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        multiplier: float = 3,
        period: int = 14,
        prefix: str = 'ats',
    ) -> Self:
        """Vervoort's close-anchored ratcheting ATR stop.
        Adds ats, atsTrend (trend).
        Options: multiplier: usually 1-5; period: min 1; usually 5-50."""
    def zig_zag(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        deviation: float = 5,
        prefix: str = 'zz',
    ) -> Self:
        """ZigZag — percent-reversal pivots and the line joining them.
        Adds zzPivot, zzDirection, zzLine (trend).
        Options: deviation: usually 1-20."""
    def ichimoku(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        base_period: int = 26,
        conversion_period: int = 9,
        displacement: int = 26,
        span_b_period: int = 52,
        prefix: str = 'ichi',
    ) -> Self:
        """Ichimoku Kinko Hyo — Hosoda's five lines.
        Adds ichiTenkan, ichiKijun, ichiSenkouA, ichiSenkouB, ichiChikou (trend).
        Options: base_period: min 1; usually 10-60; conversion_period: min 1; usually 5-20; displacement: min 1; usually 10-60; span_b_period: min 1; usually 26-120."""
    def elder_impulse(
        self,
        *,
        column: str = 'close',
        ema_period: int = 13,
        fast_period: int = 12,
        signal_period: int = 9,
        slow_period: int = 26,
        output: str = 'impulse',
    ) -> Self:
        """Elder's impulse system — EMA and MACD histogram agreeing.
        Adds impulse (trend).
        Options: ema_period: min 1; usually 5-30; fast_period: min 1; usually 5-20; signal_period: min 1; usually 5-20; slow_period: usually 15-50."""
    def elder_ray(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        period: int = 13,
        prefix: str = 'elder',
    ) -> Self:
        """Elder Ray — the bar's high and low against an EMA.
        Adds elderBull, elderBear (trend).
        Options: period: min 1; usually 5-30."""
    def trend_intensity_index(
        self,
        *,
        column: str = 'close',
        ma_period: int = 60,
        period: int = 30,
        output: str = 'tii',
    ) -> Self:
        """M. H. Pee's trend intensity index — deviations above an SMA.
        Adds tii (trend).
        Options: ma_period: min 1; usually 20-120; period: min 1; usually 10-60."""
    def ravi(
        self,
        *,
        column: str = 'close',
        long_period: int = 65,
        short_period: int = 7,
        output: str = 'ravi',
    ) -> Self:
        """Chande's RAVI — the two SMAs' gap as a percent of the slow one.
        Adds ravi (trend).
        Options: long_period: min 1; usually 20-130; short_period: min 1; usually 3-20."""
    def swing_index(
        self,
        *,
        open: str = 'open',
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        limit: float,
        output: str = 'si',
    ) -> Self:
        """Wilder's swing index — one bar's move against the limit move.
        Adds si (trend).
        Options: limit: required, e.g. 5."""
    def accumulative_swing_index(
        self,
        *,
        open: str = 'open',
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        limit: float,
        output: str = 'asi',
    ) -> Self:
        """Wilder's accumulative swing index — the running swing total.
        Adds asi (trend).
        Options: limit: required, e.g. 5."""
    def atr(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        period: int = 14,
        output: str = 'atr',
    ) -> Self:
        """Wilder's average true range.
        Adds atr (volatility).
        Options: period: min 1; usually 5-50."""
    def historical_volatility(
        self,
        *,
        column: str = 'close',
        annualize: float = 252,
        period: int = 20,
        output: str = 'hv',
    ) -> Self:
        """Annualised σ of log returns, as a decimal.
        Adds hv (volatility).
        Options: annualize: usually 1-365; period: min 1; usually 10-60."""
    def chaikin_volatility(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        period: int = 10,
        roc_period: int = 10,
        output: str = 'chaikinVol',
    ) -> Self:
        """Chaikin's percent rate of change of a smoothed bar range.
        Adds chaikinVol (volatility).
        Options: period: min 1; usually 5-30; roc_period: min 1; usually 5-30."""
    def mass_index(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        ema_period: int = 9,
        sum_period: int = 25,
        output: str = 'mass',
    ) -> Self:
        """Dorsey's range-expansion sum — the reversal bulge.
        Adds mass (volatility).
        Options: ema_period: min 1; usually 5-20; sum_period: min 1; usually 10-50."""
    def choppiness_index(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        period: int = 14,
        output: str = 'chop',
    ) -> Self:
        """Dreiss' Choppiness Index — trending against ranging, 0..100.
        Adds chop (volatility).
        Options: period: min 2; usually 5-30."""
    def gopalakrishnan_range_index(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        period: int = 10,
        output: str = 'gapo',
    ) -> Self:
        """GAPO — the window's high-low range, logged in base period.
        Adds gapo (volatility).
        Options: period: min 2; usually 5-30."""
    def ulcer_index(
        self,
        *,
        column: str = 'close',
        period: int = 14,
        output: str = 'ulcer',
    ) -> Self:
        """Martin's RMS percent drawdown from the rolling peak.
        Adds ulcer (volatility).
        Options: period: min 1; usually 5-30."""
    def relative_volatility_index(
        self,
        *,
        column: str = 'close',
        period: int = 14,
        stdev_period: int = 10,
        output: str = 'relVol',
    ) -> Self:
        """Dorsey's RSI form applied to σ instead of price.
        Adds relVol (volatility).
        Options: period: min 1; usually 5-30; stdev_period: min 1; usually 5-30."""
    def obv(
        self,
        *,
        close: str = 'close',
        volume: str = 'volume',
        output: str = 'obv',
    ) -> Self:
        """Granville's running total of signed volume.
        Adds obv (volume)."""
    def accumulation_distribution(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        volume: str = 'volume',
        output: str = 'ad',
    ) -> Self:
        """Chaikin's A/D line — volume signed by the close's place in the bar.
        Adds ad (volume)."""
    def price_volume_trend(
        self,
        *,
        close: str = 'close',
        volume: str = 'volume',
        output: str = 'pvt',
    ) -> Self:
        """Running total of volume scaled by fractional price change.
        Adds pvt (volume)."""
    def chaikin_money_flow(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        volume: str = 'volume',
        period: int = 20,
        output: str = 'cmf',
    ) -> Self:
        """Chaikin's A/D term as a volume-weighted mean over a window.
        Adds cmf (volume).
        Options: period: min 1; usually 10-50."""
    def chaikin_oscillator(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        volume: str = 'volume',
        fast_period: int = 3,
        slow_period: int = 10,
        output: str = 'chaikinOsc',
    ) -> Self:
        """MACD of the Accumulation/Distribution line.
        Adds chaikinOsc (volume).
        Options: fast_period: min 1; usually 2-8; slow_period: usually 5-30."""
    def money_flow_index(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        volume: str = 'volume',
        period: int = 14,
        output: str = 'mfi',
    ) -> Self:
        """RSI computed on money flow instead of price.
        Adds mfi (volume).
        Options: period: min 1; usually 5-30."""
    def twiggs_money_flow(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        volume: str = 'volume',
        period: int = 21,
        output: str = 'tmf',
    ) -> Self:
        """Twiggs' money flow — true range, Wilder-smoothed.
        Adds tmf (volume).
        Options: period: min 1; usually 10-50."""
    def force_index(
        self,
        *,
        close: str = 'close',
        volume: str = 'volume',
        period: int = 13,
        output: str = 'force',
    ) -> Self:
        """Elder's force index — price change times volume, EMA-smoothed.
        Adds force (volume).
        Options: period: min 1; usually 1-40."""
    def ease_of_movement(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        volume: str = 'volume',
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        period: int = 14,
        scale: float = 100000000,
        output: str = 'eom',
    ) -> Self:
        """Arms' ease of movement — midpoint travel per unit of volume.
        Adds eom (volume).
        Options: ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; period: min 1; usually 5-30; scale: usually 1000000-1000000000."""
    def klinger(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        volume: str = 'volume',
        fast_period: int = 34,
        signal_period: int = 13,
        slow_period: int = 55,
        prefix: str = 'kvo',
    ) -> Self:
        """Klinger's volume oscillator with its signal line.
        Adds kvo, kvoSignal (volume).
        Options: fast_period: min 1; usually 20-50; signal_period: min 1; usually 5-30; slow_period: usually 40-100."""
    def volume_oscillator(
        self,
        *,
        volume: str = 'volume',
        fast_period: int = 5,
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        slow_period: int = 10,
        output: str = 'volOsc',
    ) -> Self:
        """Fast minus slow moving average of volume, as a percent.
        Adds volOsc (volume).
        Options: fast_period: min 1; usually 2-8; ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; slow_period: usually 10-50."""
    def trade_volume_index(
        self,
        *,
        column: str = 'close',
        volume: str = 'volume',
        min_tick: float,
        output: str = 'tvi',
    ) -> Self:
        """Tick-direction volume accumulation (needs the instrument tick).
        Adds tvi (volume).
        Options: min_tick: required, e.g. 0.01."""
    def negative_volume_index(
        self,
        *,
        column: str = 'close',
        volume: str = 'volume',
        start: float = 1000,
        output: str = 'nvi',
    ) -> Self:
        """Fosback's index compounding returns on lower-volume bars.
        Adds nvi (volume).
        Options: start: usually 100-10000."""
    def positive_volume_index(
        self,
        *,
        column: str = 'close',
        volume: str = 'volume',
        start: float = 1000,
        output: str = 'pvi',
    ) -> Self:
        """Fosback's index compounding returns on higher-volume bars.
        Adds pvi (volume).
        Options: start: usually 100-10000."""
    def market_facilitation_index(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        volume: str = 'volume',
        output: str = 'bwmfi',
    ) -> Self:
        """Bill Williams' price movement per unit of volume.
        Adds bwmfi (volume)."""
    def shinohara_intensity_ratio(
        self,
        *,
        open: str = 'open',
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        period: int = 26,
        prefix: str = 'sir',
    ) -> Self:
        """Shinohara's strong and weak intensity ratios.
        Adds sirStrong, sirWeak (volume).
        Options: period: min 1; usually 10-60."""
    def vwap(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        volume: str = 'volume',
        period: int,
        output: str = 'vwap',
    ) -> Self:
        """Volume-weighted average price over a trailing window.
        Adds vwap (volume).
        Options: period: min 1; usually 5-200; required, e.g. 20."""
    def anchored_vwap(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        volume: str = 'volume',
        output: str = 'avwap',
        anchor: Time,
    ) -> Self:
        """VWAP accumulated from a user-chosen bar onward.
        Adds avwap (volume)."""
    def linear_regression(
        self,
        *,
        column: str = 'close',
        period: int = 14,
        prefix: str = 'linreg',
    ) -> Self:
        """Rolling OLS fit against the bar index, with slope, angle and R².
        Adds linregValue, linregSlope, linregIntercept, linregAngle, linregR2 (statistical).
        Options: period: min 2; usually 5-60."""
    def time_series_forecast(
        self,
        *,
        column: str = 'close',
        period: int = 14,
        output: str = 'tsf',
    ) -> Self:
        """The rolling OLS fit projected one bar past the window.
        Adds tsf (statistical).
        Options: period: min 2; usually 5-60."""
    def beta(
        self,
        *,
        column: str = 'close',
        benchmark: str,
        period: int = 5,
        output: str = 'beta',
    ) -> Self:
        """Slope of a column's one-bar returns on a benchmark's.
        Adds beta (statistical).
        Options: period: min 2; usually 5-60."""
    def correlation(
        self,
        *,
        column: str = 'close',
        benchmark: str,
        period: int = 30,
        output: str = 'corr',
    ) -> Self:
        """Rolling Pearson correlation against a benchmark column.
        Adds corr (statistical).
        Options: period: min 2; usually 10-120."""
    def price_relative(
        self,
        *,
        column: str = 'close',
        benchmark: str,
        output: str = 'priceRel',
    ) -> Self:
        """Ratio of a column to a benchmark column, with no look-back.
        Adds priceRel (statistical)."""
    def performance_index(
        self,
        *,
        column: str = 'close',
        benchmark: str,
        period: int = 20,
        output: str = 'perf',
    ) -> Self:
        """Each side's own period-bar growth, divided — 1 is parity.
        Adds perf (statistical).
        Options: period: min 1; usually 10-60."""
    def z_score(
        self,
        *,
        column: str = 'close',
        period: int,
        output: str = 'zscore',
    ) -> Self:
        """Deviation from the rolling mean, in standard deviations.
        Adds zscore (statistical).
        Options: period: min 1; usually 10-60; required, e.g. 20."""
    def rolling_stdev(
        self,
        *,
        column: str = 'close',
        period: int,
        output: str = 'stdev',
    ) -> Self:
        """Rolling population standard deviation (ddof = 0).
        Adds stdev (statistical).
        Options: period: min 1; usually 5-100; required, e.g. 20."""
    def rolling_min(
        self,
        *,
        column: str = 'close',
        period: int,
        output: str = 'min',
    ) -> Self:
        """Rolling minimum over the last period bars.
        Adds min (statistical).
        Options: period: min 1; usually 5-100; required, e.g. 20."""
    def rolling_max(
        self,
        *,
        column: str = 'close',
        period: int,
        output: str = 'max',
    ) -> Self:
        """Rolling maximum over the last period bars.
        Adds max (statistical).
        Options: period: min 1; usually 5-100; required, e.g. 20."""
    def rolling_percentile(
        self,
        *,
        column: str = 'close',
        period: int,
        q: float,
        output: str = 'p90',
    ) -> Self:
        """Rolling q-th percentile, linearly interpolated.
        Adds p90 (statistical).
        Options: period: min 1; usually 5-100; required, e.g. 20; q: min 0; max 100; usually 5-95; required, e.g. 90."""
    def typical_price(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        output: str = 'typicalPrice',
    ) -> Self:
        """Typical price — (high + low + close) / 3.
        Adds typicalPrice (price)."""
    def median_price(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        output: str = 'medianPrice',
    ) -> Self:
        """Median price — (high + low) / 2.
        Adds medianPrice (price)."""
    def weighted_close(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        output: str = 'weightedClose',
    ) -> Self:
        """Weighted close — (high + low + 2·close) / 4.
        Adds weightedClose (price)."""
    def average_price(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        open: str = 'open',
        output: str = 'averagePrice',
    ) -> Self:
        """Average price — (open + high + low + close) / 4.
        Adds averagePrice (price)."""
    def balance_of_power(
        self,
        *,
        open: str = 'open',
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        ma_type: Literal['sma', 'ema', 'wma', 'smma', 'dema', 'tema', 'trima', 'hull', 'kama', 'zlema'] = 'sma',
        period: Optional[int] = None,
        output: str = 'bop',
    ) -> Self:
        """TA-Lib's per-bar (close − open)/(high − low), optionally smoothed.
        Adds bop (price).
        Options: ma_type: one of sma, ema, wma, smma, dema, tema, trima, hull, kama, zlema; needs period; period: min 1; usually 5-30; leave out to switch off."""
    def session_vwap(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        volume: str = 'volume',
        output: str = 'svwap',
        sessions: Union[TradingCalendar, Iterable[Session], None] = None,
        session: Optional[str] = None,
        stamped: Literal['open', 'close'] = 'open',
    ) -> Self:
        """Volume-weighted average price, reset at each session's open.
        Adds svwap (session).
        Options: give sessions= (a calendar or list) or session= (a session-id column)."""
    def pivot_points(
        self,
        *,
        high: str = 'high',
        low: str = 'low',
        close: str = 'close',
        method: Literal['standard', 'fibonacci', 'woodie', 'camarilla'] = 'standard',
        prefix: str = 'pp',
        sessions: Union[TradingCalendar, Iterable[Session], None] = None,
        session: Optional[str] = None,
        stamped: Literal['open', 'close'] = 'open',
    ) -> Self:
        """The prior session's pivot with its support and resistance levels.
        Adds ppPivot, ppR1, ppR2, ppR3, ppS1, ppS2, ppS3 (session).
        Options: method: one of standard, fibonacci, woodie, camarilla; give sessions= (a calendar or list) or session= (a session-id column)."""
    # --- end studies ---

class TimeSeries(_Shared):
    """A key column (times, time ranges or labelled intervals, in order) and
    value columns (numbers, decimals, text, bools, arrays; gaps allowed).
    Every operation returns a new series."""

    def __init__(
        self,
        data: Any,
        *,
        name: str = "series",
        key: str = "time",
        key_kind: Literal["time", "time_range", "interval"] = "time",
    ) -> None:
        """From a pyarrow Table / RecordBatch, a polars or pandas DataFrame,
        anything with __arrow_c_stream__, or a dict of columns. A gap-free
        float64 column of a one-chunk table is used in place, not copied. A
        nullable Arrow field makes an optional column."""
    @staticmethod
    def read_ipc(
        source: Union[str, os.PathLike[str], bytes],
        *,
        name: str = "series",
        key: str = "time",
        key_kind: Literal["time", "time_range", "interval"] = "time",
    ) -> TimeSeries: ...
    def write_ipc(self, path: Union[str, os.PathLike[str], None] = None) -> Optional[bytes]: ...
    @staticmethod
    def from_json(text: str, *, time_zone: Optional[str] = None, order: Literal["strict", "reorder", "clamp"] = "strict") -> TimeSeries: ...
    def to_json(self, row_format: Literal["array", "object"] = "array") -> str: ...
    @staticmethod
    def from_columns_json(text: str, *, order: Literal["strict", "reorder", "clamp"] = "strict") -> TimeSeries: ...
    def to_columns_json(self) -> str: ...
    @staticmethod
    def from_points_json(text: str, name: str, schema: _Seq[Mapping[str, Any]]) -> TimeSeries: ...
    def to_points_json(self) -> str: ...
    def __arrow_c_stream__(self, requested_schema: Any = None) -> Any: ...
    def to_pyarrow(self) -> Any:
        """A pyarrow.Table; times are timestamp[ms, UTC], a gap is a null."""
    def to_polars(self) -> Any: ...
    def to_pandas(self) -> Any: ...
    @property
    def name(self) -> str: ...
    @property
    def key_name(self) -> str: ...
    @property
    def key_kind(self) -> Literal["time", "time_range", "interval"]: ...
    @property
    def columns(self) -> list[str]: ...
    @property
    def schema(self) -> list[dict[str, Any]]: ...
    def __len__(self) -> int: ...
    def __iter__(self) -> Iterator[Row]: ...
    @overload
    def __getitem__(self, index: int) -> Row: ...
    @overload
    def __getitem__(self, index: slice) -> TimeSeries: ...
    def column(self, name: str) -> list[Cell]: ...
    def at(self, index: int) -> Optional[Row]: ...
    def first(self) -> Optional[Row]: ...
    def last(self) -> Optional[Row]: ...
    def bisect(self, key: Key) -> int: ...
    def includes_key(self, key: Key) -> bool: ...
    def at_or_before(self, key: Key) -> Optional[Row]: ...
    def at_or_after(self, key: Key) -> Optional[Row]: ...
    def nearest(self, key: Key) -> Optional[Row]: ...
    def find(self, test: Callable[[Row], bool]) -> Optional[Row]: ...
    def some(self, test: Callable[[Row], bool]) -> bool: ...
    def every(self, test: Callable[[Row], bool]) -> bool: ...
    def time_range(self) -> Optional[tuple[int, int]]: ...
    def overlaps(self, key: Key) -> bool: ...
    def contains(self, key: Key) -> bool: ...
    def intersection(self, key: Key) -> Optional[tuple[int, int]]: ...
    def reduce(self, aggs: Aggs) -> dict[str, Cell]: ...
    def select(self, *columns: Columns) -> TimeSeries: ...
    def rename(self, mapping: Mapping[str, str]) -> TimeSeries: ...
    def with_column(self, name: str, values: Iterable[Cell]) -> TimeSeries: ...
    def map(self, column: str, f: Callable[[Any], Any]) -> TimeSeries: ...
    def as_time(self, at: At = "begin") -> TimeSeries: ...
    def as_time_range(self) -> TimeSeries: ...
    def as_interval(self, label: Union[float, str, Callable[[Row], Union[float, str]]]) -> TimeSeries: ...
    def offset_time(self, by: Union[int, Duration]) -> TimeSeries: ...
    def slice(self, start: Optional[int] = None, end: Optional[int] = None) -> TimeSeries: ...
    def filter(self, keep: Callable[[Row], bool]) -> TimeSeries: ...
    def tail(self, duration: Duration) -> TimeSeries: ...
    def within(self, begin: Time, end: Time) -> TimeSeries: ...
    def overlapping(self, key: Key) -> TimeSeries: ...
    def contained_by(self, key: Key) -> TimeSeries: ...
    def trim(self, key: Key) -> TimeSeries: ...
    def before(self, key: Key) -> TimeSeries: ...
    def after(self, key: Key) -> TimeSeries: ...
    def array_contains(self, column: str, value: Union[float, str, bool]) -> TimeSeries: ...
    def array_contains_all(self, column: str, values: Iterable[Union[float, str, bool]]) -> TimeSeries: ...
    def array_contains_any(self, column: str, values: Iterable[Union[float, str, bool]]) -> TimeSeries: ...
    def array_aggregate(self, column: str, reducer: str, *, output: Optional[str] = None, kind: Optional[str] = None) -> TimeSeries: ...
    def array_explode(self, column: str, *, output: Optional[str] = None, kind: Optional[str] = None) -> TimeSeries: ...
    def join(
        self,
        other: TimeSeries,
        *,
        how: Literal["outer", "inner", "left", "right"] = "outer",
        on_conflict: Literal["error", "prefix"] = "error",
        prefixes: Optional[list[str]] = None,
    ) -> TimeSeries: ...
    @staticmethod
    def join_many(
        series: Iterable[TimeSeries],
        *,
        how: Literal["outer", "inner", "left", "right"] = "outer",
        on_conflict: Literal["error", "prefix"] = "error",
        prefixes: Optional[list[str]] = None,
    ) -> TimeSeries: ...
    @staticmethod
    def concat(series: Iterable[TimeSeries]) -> TimeSeries: ...
    def collapse(self, columns: Columns, output: str, f: Callable[[Row], Union[float, str, bool, None]], *, keep: bool = False) -> TimeSeries: ...
    def pivot_by_group(self, group: str, value: str, *, aggregate: Optional[str] = None, groups: Optional[list[str]] = None) -> TimeSeries: ...
    def by_column(
        self,
        column: str,
        aggs: Aggs,
        *,
        width: Optional[float] = None,
        origin: float = 0.0,
        edges: Optional[list[float]] = None,
        upper_inclusive: bool = False,
    ) -> dict[str, list[Cell]]: ...
    def rolling_by_column(self, column: str, radius: float, aggs: Aggs, *, at: Optional[list[float]] = None) -> dict[str, list[Cell]]: ...
    def by_value(self, axis: str) -> ValueSeries: ...
    def partition_by(self, columns: Columns) -> PartitionedSeries: ...
    def group_by(self, columns: Columns) -> dict[Any, TimeSeries]: ...

class PartitionedSeries(_Shared):
    """A series split by entity; operations run per group on several cores."""

    @property
    def by(self) -> list[str]: ...
    def __len__(self) -> int: ...
    def collect(self) -> TimeSeries: ...
    def to_dict(self) -> dict[Any, TimeSeries]: ...
    def keys(self) -> list[Any]: ...

class ValueSeries:
    """Rows keyed by a number axis (a distance, a strike price)."""

    @staticmethod
    def from_json(text: str, *, order: Literal["strict", "reorder", "clamp"] = "strict") -> ValueSeries: ...
    @staticmethod
    def from_columns_json(text: str, *, order: Literal["strict", "reorder", "clamp"] = "strict") -> ValueSeries: ...
    @staticmethod
    def from_arrow(data: Any, axis: str, *, name: str = "series") -> ValueSeries: ...
    @property
    def name(self) -> str: ...
    @property
    def axis_name(self) -> str: ...
    @property
    def schema(self) -> list[dict[str, Any]]: ...
    @property
    def columns(self) -> list[str]: ...
    def axis(self) -> list[float]: ...
    def column(self, name: str) -> list[Cell]: ...
    def __len__(self) -> int: ...
    def nearest_index(self, value: float) -> Optional[int]: ...
    def slice_by_value(self, lo: float, hi: float) -> ValueSeries: ...
    def to_json(self, row_format: Literal["array", "object"] = "array") -> str: ...
    def to_columns_json(self) -> str: ...
    def __arrow_c_stream__(self, requested_schema: Any = None) -> Any: ...
    def to_pyarrow(self) -> Any: ...
    def to_polars(self) -> Any: ...
    def to_pandas(self) -> Any: ...

class SessionBreak(TypedDict):
    start: int
    end: int

class Session(TypedDict):
    """A trading session; times are epoch milliseconds. As input, open,
    close and break times may be any Time, and breaks (start, end) tuples."""

    date: str
    open: int
    close: int
    breaks: list[SessionBreak]

Date = Union[str, _dt.date]

class TradingCalendar:
    """Exchange sessions in order, none overlapping, and lookups over them.
    For the session studies (session_vwap, pivot_points: sessions=calendar)
    and for tagging bars with their session."""

    @staticmethod
    def from_rules(
        time_zone: str,
        open: str,
        close: str,
        start: Union[Date, Time],
        end: Union[Date, Time],
        *,
        weekmask: Optional[_Seq[int]] = None,
        breaks: Optional[Iterable[tuple[str, str]]] = None,
        holidays: Optional[Iterable[Date]] = None,
        early_closes: Optional[Mapping[Date, str]] = None,
    ) -> TradingCalendar:
        """Sessions open..close (local "HH:MM") in time_zone for every
        trading day from start to end, both included. weekmask lists the
        trading weekdays (1 = Monday .. 7 = Sunday; Monday to Friday by
        default); breaks are local (start, end) times inside each session;
        holidays have no session; early_closes maps a date to its "HH:MM"
        close. Opens and closes follow the zone's clock changes."""
    @staticmethod
    def from_sessions(sessions: Iterable[Session], *, time_zone: Optional[str] = None) -> TradingCalendar: ...
    @property
    def time_zone(self) -> Optional[str]: ...
    @property
    def sessions(self) -> list[Session]: ...
    def __len__(self) -> int: ...
    def session_on(self, date: Date) -> Optional[Session]: ...
    def is_trading_day(self, date: Date) -> bool: ...
    def session_containing(self, time: Time) -> Optional[Session]:
        """The session whose [open, close) holds the time (a break is still
        inside it)."""
    def is_open(self, time: Time) -> bool:
        """Inside a session and not in one of its breaks."""
    def sessions_in_range(self, start: Time, end: Time) -> list[Session]:
        """The sessions overlapping [start, end)."""
    def next_session(self, from_: Union[Date, Time]) -> Optional[Session]:
        """After a date (YYYY-MM-DD or a date): the next trading day. After
        a time (any other text included): the next session to open."""
    def previous_session(self, from_: Union[Date, Time]) -> Optional[Session]:
        """Before a date (YYYY-MM-DD or a date): the trading day before.
        Before a time (any other text included): the last session to open
        (so a time inside a session gives that session)."""
    def tag_sessions(
        self, series: TimeSeries, *, column: str = "session", stamped: Literal["open", "close"] = "open"
    ) -> TimeSeries:
        """Add a session-id column: the open (epoch ms) of the session each
        row's time falls in, or a gap in closed time. stamped="close" is for
        bars stamped with their end."""

def studies() -> list[dict[str, Any]]:
    """Every study described: name, method (its Python name), family,
    summary, inputs (columns read), params (options with defaults and
    ranges), naming, outputs and output_names."""

def study_info(name: str) -> dict[str, Any]:
    """One study described, by pond-ts's name or Python's."""

# --- live: events as they arrive ---

OutputKind = Literal["event", "batch", "evict", "bucket", "update"]
NodeKindName = Literal[
    "series", "view", "aggregation", "rolling", "reduce", "partitioned", "partitioned_view", "partition_rolling"
]
# When a rolling window or reduce emits: "event" (after every event), an
# int n (every n events), a duration or Sequence (when a clock bucket ends).
_Trigger = Union[Literal["event"], int, Duration, "Sequence"]
# What a rolling window or reduce keeps of its emissions: True (all),
# False (none), or {"max_events": n, "max_age": "5m"}.
_History = Union[bool, Mapping[str, Any]]
SchemaEntry = Union[tuple[str, str], tuple[str, str, bool], Mapping[str, Any]]

class LiveEvent:
    """One event of a live node: event["cpu"] reads a cell (None for a gap)."""

    @property
    def key(self) -> Union[int, tuple[int, int], tuple[Union[float, str], int, int]]: ...
    @property
    def begin(self) -> int: ...
    @property
    def end(self) -> int: ...
    def __getitem__(self, column: str) -> Cell: ...
    def get(self, column: str, default: Any = None) -> Cell: ...
    def keys(self) -> list[str]: ...
    def to_dict(self) -> dict[str, Cell]: ...
    def __len__(self) -> int: ...

class LiveOutput:
    """Something a push caused at a watched node. kind "event": the node took
    an event (an aggregation: closed a bucket); "batch": the series took
    these events in one push; "evict": the node dropped these; "bucket": an
    aggregation's open bucket as it now stands; "update": a rolling window's
    values as they now stand (None from an aggregation)."""

    @property
    def node(self) -> LiveNode: ...
    @property
    def kind(self) -> OutputKind: ...
    @property
    def event(self) -> Optional[LiveEvent]:
        """For "event" and "bucket"."""
    @property
    def events(self) -> Optional[list[LiveEvent]]:
        """For "batch" and "evict"."""
    @property
    def values(self) -> Optional[dict[str, Cell]]:
        """For "update"."""

class _LiveBase:
    """What a LiveSeries and every LiveNode have: building nodes on it, and
    reading it. A node is built over what its source holds now, then kept
    up to date by every push. On a partitioned node each step is built on
    every partition (a partitioned view); collect() gathers the results."""

    def filter(self, f: Callable[[LiveEvent], bool]) -> LiveNode:
        """The events f accepts. An exception in f leaves the event out and
        is raised when the push returns (the push has happened). f must not
        use this LiveSeries."""
    def map(self, f: Callable[[LiveEvent], Union[Mapping[str, Cell], _Seq[Cell]]]) -> LiveNode:
        """Each event with new values: f returns {column: cell} for the
        columns to change, or every cell in schema order. Every value column
        of the view may have gaps."""
    def select(self, *columns: str) -> LiveNode: ...
    def sample(self, stride: int) -> LiveNode:
        """Every stride-th event, counted from now."""
    def window(self, size: Union[Duration, int]) -> LiveNode:
        """The events within a duration of the newest, or the newest n."""
    def diff(self, columns: Columns, *, drop_first: bool = False) -> LiveNode: ...
    def rate(self, columns: Columns, *, drop_first: bool = False) -> LiveNode:
        """diff per second of key time."""
    def pct_change(self, columns: Columns, *, drop_first: bool = False) -> LiveNode: ...
    def fill(self, strategy: Union[str, Mapping[str, Any]], *, limit: Optional[int] = None) -> LiveNode:
        """Fill gaps as events arrive: "hold" or "zero" for every column, or
        {column: strategy or value}; limit fills at most that many in a row."""
    def cumulative(self, spec: Mapping[str, Union[str, Callable[[float, float], float]]]) -> LiveNode:
        """Running totals: {column: "sum" | "max" | "min" | "count"}, or one
        column with your own f(running, value)."""
    def aggregate(self, sequence: Grid, aggs: Aggs, *, grace: Optional[Duration] = None) -> LiveNode:
        """Buckets of the sequence, each bucket's reducers emitted when it
        closes; grace keeps a bucket open until the latest event is that far
        past its end."""
    def rolling(
        self,
        window: Union[Duration, int, Mapping[Duration, Any]],
        aggs: Optional[Aggs] = None,
        *,
        min_samples: int = 0,
        trigger: Optional[_Trigger] = None,
        history: Optional[_History] = None,
    ) -> LiveNode:
        """A rolling window: a duration, a count of events, or several at
        once as {window: aggs} / {window: {"aggs": aggs, "min_samples": n}}.
        On a partitioned node a clock trigger (or several windows) makes one
        node emitting a row per partition at each tick."""
    def reduce(self, aggs: Aggs, *, trigger: Optional[_Trigger] = None) -> LiveNode:
        """Reducers over everything this node holds, emitted on trigger
        (after each event by default)."""
    def __len__(self) -> int: ...
    @property
    def schema(self) -> list[dict[str, Any]]: ...
    @property
    def columns(self) -> list[str]: ...
    @property
    def kind(self) -> NodeKindName: ...
    def events(self) -> list[LiveEvent]:
        """What the node holds (an aggregation: its closed buckets; a
        rolling window or reduce: its emissions)."""
    def last(self) -> Optional[LiveEvent]: ...
    def to_series(self) -> TimeSeries: ...
    def to_pyarrow(self) -> Any: ...
    def to_polars(self) -> Any: ...
    def to_pandas(self) -> Any: ...
    def stats(self) -> dict[str, Any]: ...
    def watch(self, *kinds: OutputKind) -> None:
        """Have each push return this node's outputs of these kinds (all it
        emits when none are named)."""
    def unwatch(self, *kinds: OutputKind) -> None: ...

class LiveNode(_LiveBase):
    """A node of a LiveSeries. Equal to another handle on the same node."""

    def __eq__(self, other: object) -> bool: ...
    def __hash__(self) -> int: ...
    def value(self) -> dict[str, Cell]:
        """A rolling window's or reduce's values as they stand now."""
    def snapshot(self) -> TimeSeries:
        """An aggregation's closed buckets and its open one."""
    @property
    def has_open_bucket(self) -> bool: ...
    def keys(self) -> list[str]:
        """A partitioned node's partition values, in order of arrival."""
    def partition(self, key: str) -> Optional[LiveNode]: ...
    def partitions(self) -> dict[str, LiveNode]:
        """Each partition (a partitioned series), or the chain's last node
        on each partition (a partitioned view)."""
    def collect(
        self,
        *,
        name: Optional[str] = None,
        ordering: Optional[Literal["strict", "drop", "reorder"]] = None,
        grace_window: Optional[Duration] = None,
        max_events: Optional[int] = None,
        max_age: Optional[Duration] = None,
    ) -> LiveNode:
        """One series of everything the partitions take (or their chains
        emit), as events arrive; it starts with what they hold now."""
    def remove(self) -> None:
        """Remove the node: it stops working, and nodes built on it keep
        what they hold but get no more events. Not the root."""

class LiveSeries(_LiveBase):
    """A series that takes events as they arrive and owns the nodes built on
    it. Every push returns what the watched nodes emitted, in order.

        live = pond_rs.LiveSeries({"time": "time", "host": "string", "cpu": "number"})
        avg = live.rolling("1m", {"avg": ("cpu", "avg")})
        live.push("2026-01-01T00:00:00Z", host="a", cpu=0.5)
        live.push_frame(df)       # pyarrow / polars / pandas, the fastest way in
        avg.value()               # {"avg": ...}

    Calls from several threads are safe: each takes the series in turn,
    with Python's lock released while it waits."""

    def __init__(
        self,
        schema: Union[Mapping[str, str], Iterable[SchemaEntry]],
        *,
        name: str = "live",
        ordering: Literal["strict", "drop", "reorder"] = "strict",
        grace_window: Optional[Duration] = None,
        max_events: Optional[int] = None,
        max_age: Optional[Duration] = None,
    ) -> None:
        """schema: the key column ("time", "time_range" or "interval") then
        the value columns, as {name: kind}, (name, kind[, required]) tuples
        or a TimeSeries.schema. Value columns may have gaps unless marked
        required. ordering says what a late event does: refused ("strict"),
        dropped ("drop") or put in place within grace_window ("reorder").
        max_events / max_age evict the oldest events."""
    @property
    def name(self) -> str: ...
    @property
    def root(self) -> LiveNode:
        """The series itself as a node (its outputs carry this node)."""
    def push(self, key: Key, values: Optional[Union[Mapping[str, Cell], _Seq[Cell]]] = None, /, **cells: Cell) -> list[LiveOutput]:
        """One event: values as a dict, a list in schema order, or keywords.
        A column left out is a gap."""
    def push_many(self, rows: Iterable[Union[tuple[Key, Union[Mapping[str, Cell], _Seq[Cell]]], Mapping[str, Any]]]) -> list[LiveOutput]:
        """Many events, all or nothing: (key, values) pairs or dicts with the
        key column among the values."""
    def push_frame(self, data: Any) -> list[LiveOutput]:
        """A frame (TimeSeries, pyarrow, polars, pandas, dict of columns) as
        one batch, all or nothing. It needs the key column and exactly this
        series' value columns."""
    def push_json(self, rows: str) -> list[LiveOutput]:
        """Rows written as pond-ts JSON (a JSON array of rows)."""
    def clear(self) -> list[LiveOutput]:
        """Remove every event; views drop theirs."""
    def partition_by(
        self,
        column: str,
        *,
        groups: Optional[_Seq[str]] = None,
        ordering: Optional[Literal["strict", "drop", "reorder"]] = None,
        grace_window: Optional[Duration] = None,
        max_events: Optional[int] = None,
        max_age: Optional[Duration] = None,
    ) -> LiveNode:
        """Split events by a column's value: each value gets its own series
        (when it first arrives, or now for groups). Build on the result as on
        the series; each step runs per partition."""
