// [PND-HOOKSIGNAL] The payload-free change signal pond-ts puts on
// `LiveSeries` under a registered symbol (`Symbol.for('pond-ts:onSignal')`
// in pond-ts), so reconstructing it here yields the identical symbol with
// no import. It fires once per push in which the channel delivered rows,
// at the moment of the channel's last call, without building the rows'
// `Event`s. An `'event'` / `'evict'` listener makes the column-native
// `LiveSeries` build one `Event` per pushed (or evicted) row, which these
// hooks never read.
const ON_SIGNAL = Symbol.for('pond-ts:onSignal');

type SignalSource = {
  [ON_SIGNAL]?: (type: 'event' | 'evict', fn: () => void) => () => void;
};

/**
 * Call `fn` when `source`'s `type` channel fires. Uses the payload-free
 * signal when the source offers one (`LiveSeries`), else an ordinary
 * listener (views, aggregations — their rows are `Event`s already).
 * For `'evict'`, callers check the source emits it first.
 */
export function onSourceChange(
  source: unknown,
  type: 'event' | 'evict',
  fn: () => void,
): () => void {
  const signal = (source as SignalSource)[ON_SIGNAL];
  if (typeof signal === 'function') return signal.call(source, type, fn);
  return (
    source as { on(type: 'event' | 'evict', fn: () => void): () => void }
  ).on(type, fn);
}
