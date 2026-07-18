import type { ReactNode } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import styles from './styles.module.css';

interface ConceptVizProps {
  /** The driver component — the chart *and* its core-param controls. */
  children: ReactNode;
  /** Placeholder height (px) for SSR / pre-hydration, to avoid layout jump. */
  height?: number;
  /**
   * One line telling the reader what to *watch* — the concept, not the chart
   * ("Drag the window — watch each bucket's bar coarsen"). Optional.
   */
  caption?: ReactNode;
}

/**
 * The core-docs "concept animation" frame (plan §3a). Deliberately **not**
 * `<ChartExample>`: no source-code panel, chrome stripped to the concept, and
 * the only controls a driver may mount are bound to a **pond core option**,
 * never a chart prop. The chart here is evidence; the operator is the subject.
 *
 * Client-only mount (`BrowserOnly`) — the drivers stream into a `LiveSeries`
 * and animate, which is browser-only; the page SSGs to a placeholder and comes
 * alive on hydration.
 */
export default function ConceptViz({
  children,
  height = 260,
  caption,
}: ConceptVizProps): ReactNode {
  return (
    <div className={styles.frame}>
      <BrowserOnly
        fallback={
          <div
            className={styles.placeholder}
            style={{ height }}
            aria-hidden="true"
          />
        }
      >
        {() => <>{children}</>}
      </BrowserOnly>
      {caption ? <p className={styles.caption}>{caption}</p> : null}
    </div>
  );
}

/** The control strip a driver renders beneath its chart — a consistent row. */
export function ConceptControls({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return <div className={styles.controls}>{children}</div>;
}

interface SegmentedControlProps<T extends string> {
  /** The core option this control drives, e.g. `window`. Shown as the label. */
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * A labeled segmented picker for a discrete core option (bucket width,
 * alignment, …). The label makes the pond-option-not-chart-prop rule visible.
 */
export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: SegmentedControlProps<T>): ReactNode {
  return (
    <div className={styles.segmentedWrap}>
      <span className={styles.controlLabel}>{label}</span>
      <div className={styles.segmented} role="group" aria-label={label}>
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={styles.segment}
            aria-pressed={opt.value === value}
            data-active={opt.value === value ? '' : undefined}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Play / pause toggle for the autoplay stream. */
export function PlayButton({
  playing,
  onToggle,
}: {
  playing: boolean;
  onToggle: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={styles.playButton}
      onClick={onToggle}
      aria-label={playing ? 'Pause' : 'Play'}
    >
      {playing ? '❚❚ Pause' : '▶ Play'}
    </button>
  );
}

interface SliderProps {
  /** The core option this drives (shown as the label). */
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  /** Optional formatted value to show (defaults to the raw number). */
  display?: string;
}

/** A labeled range slider for a continuous/discrete core option. */
export function Slider({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
  display,
}: SliderProps): ReactNode {
  return (
    <div className={styles.sliderWrap}>
      <span className={styles.controlLabel}>{label}</span>
      <input
        type="range"
        className={styles.slider}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
      <span className={styles.sliderValue}>{display ?? value}</span>
    </div>
  );
}
