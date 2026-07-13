/**
 * The OHLCV column contract. Core has no bar semantics — OHLC is a *naming
 * convention*, not a type — so `@pond-ts/financial` supplies the contract here.
 * Every study accepts a `column` (which field to read) and an `output` (what to
 * name the result), so no study hard-codes `'close'`; a study can run over any
 * numeric column, including another study's output (ChartIQ's "Field" idea).
 */

/** The conventional bar-column names. Override per call via a study's `column`. */
export interface OhlcvColumns {
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

/** Default OHLCV column names — `open` / `high` / `low` / `close` / `volume`. */
export const DEFAULT_OHLCV: OhlcvColumns = Object.freeze({
  open: 'open',
  high: 'high',
  low: 'low',
  close: 'close',
  volume: 'volume',
});

/** The default source column a study reads when `column` is omitted. */
export const DEFAULT_SOURCE = DEFAULT_OHLCV.close;
