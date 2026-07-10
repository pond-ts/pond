import { XAxis, type XAxisProps } from './XAxis.js';

/**
 * The category-flavoured preset of {@link XAxis} — `<CategoryAxis />` is
 * `<XAxis />`. The axis kind follows the data: on a **category** container (a
 * layer that plots on the ordinal column-domain axis) it ticks once per category,
 * labelling each band centre with the category name (the container's shared
 * formatter). Kept as the familiar name for categorical charts, mirroring
 * {@link TimeAxis}. Forwards every {@link XAxisProps} (`label`, `side`, …).
 *
 * A high-cardinality axis (many categories) crowds its labels; the thin /
 * truncate / rotate label policy is a follow-on (categorical-axis RFC, Phase 1
 * PR3). Pass `format` only to override the default category-name labels.
 */
export function CategoryAxis(props: XAxisProps = {}) {
  return <XAxis {...props} />;
}
