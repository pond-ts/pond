import { XAxis, type XAxisProps } from './XAxis.js';

/**
 * The time-flavoured preset of {@link XAxis} — `<TimeAxis />` is `<XAxis />`.
 * Kept as the familiar name for time charts (and what the container auto-renders);
 * the axis kind still follows the data, so on a value container it ticks as a
 * value axis. Forwards every {@link XAxisProps} (`format`, `label`, `side`, …).
 */
export function TimeAxis(props: XAxisProps = {}) {
  return <XAxis {...props} />;
}
