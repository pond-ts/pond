import { XAxis, type XAxisProps } from './XAxis.js';

/**
 * The category-flavoured preset of {@link XAxis} — `<CategoryAxis />` is
 * `<XAxis />`. The axis kind follows the data: on a **category** container (a
 * layer that plots on the ordinal column-domain axis) it ticks once per category,
 * labelling each band centre with the category name (the container's shared
 * formatter). Kept as the familiar name for categorical charts, mirroring
 * {@link TimeAxis}. Forwards every {@link XAxisProps} (`label`, `side`, …).
 *
 * A high-cardinality axis (many categories) thins + truncates its labels to stay
 * legible (categorical-axis RFC, Phase 1). The labels **come from the data** (the
 * `categories` list), so a d3 `format` prop does not apply here (it can't name a
 * category); customize a label by changing the `categories` datum's `label`.
 */
export function CategoryAxis(props: XAxisProps = {}) {
  return <XAxis {...props} />;
}
