import { useState, type ReactNode } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import CodeBlock from '@theme/CodeBlock';
import { usePluginData } from '@docusaurus/useGlobalData';
import { useMeasuredWidth } from '../useMeasuredWidth';
import styles from './styles.module.css';

interface ChartExampleProps {
  /**
   * The example's filename under `src/examples/` (no extension) — the
   * lookup key into the source-text map the `example-sources` plugin
   * extracts. Must match a real file: a typo fails loud (see below), not
   * silently, per the docs plan's "honest code fences" rule.
   */
  name: string;
  /**
   * The example component, statically imported and mounted by the caller.
   *
   * Two forms:
   * - **An element** (`<MyExample width={560} />`) — a fixed-width embed,
   *   centred in the stage. The historical default.
   * - **A render-prop** (`{(width) => <MyExample width={width} />}`) — the
   *   stage measures itself and hands its content width down, so the chart
   *   **fills the page** and re-fits on resize. `<ChartContainer>` takes an
   *   explicit pixel width (PLAN's `[PND-WIDTH]`), so this is how a docs embed
   *   goes responsive — the same {@link useMeasuredWidth} pattern the
   *   [responsive-width recipe](/docs/recipes/responsive-width) teaches and
   *   `<GalleryCard>` uses.
   */
  children: ReactNode | ((width: number) => ReactNode);
  /** Fixed pixel height for the loading/SSR placeholder (avoids layout jump). */
  height?: number;
  /**
   * Start with the source folded behind an expander, leaving just the chart and
   * a one-line "Expand to see code" bar. Off by default: on the charts pages the
   * source sitting open under the chart *is* the point ("the code you read is
   * the chart you touch"). Turn it on where the example has grown long enough
   * that an open fence buries the prose around it.
   */
  collapsed?: boolean;
}

/** The stage for a render-prop child: a full-width box that measures itself
 *  and renders nothing until it has a real width (a zero-width chart would
 *  mount, draw an empty canvas, then re-mount at the true size). */
function FillStage({ children }: { children: (width: number) => ReactNode }) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  return (
    <div ref={ref} className={styles.fill}>
      {width > 0 ? children(width) : null}
    </div>
  );
}

/**
 * Mounts a live, interactive chart example and displays its own source
 * underneath — "the code you read is the chart you touch" (docs plan §9.1).
 *
 * The chart is wrapped in `BrowserOnly`: canvas drawing and the theme's
 * `MutationObserver` are browser-only, so this renders a placeholder during
 * SSR/build and mounts for real on hydration. Interaction (cursor, hover,
 * selection) is never disabled — an embed with interaction turned off is a
 * bug, not a simplification.
 */
export default function ChartExample({
  name,
  children,
  height = 260,
  collapsed = false,
}: ChartExampleProps): ReactNode {
  const sources = usePluginData('example-sources') as Record<string, string>;
  const [open, setOpen] = useState(!collapsed);
  const source = sources[name];
  if (source === undefined) {
    throw new Error(
      `ChartExample: no source found for "${name}" — does src/examples/${name}.tsx exist?`,
    );
  }
  const file = `src/examples/${name}.tsx`;

  return (
    <div className={styles.wrap}>
      <div className={styles.stage}>
        <BrowserOnly
          fallback={
            <div
              className={styles.placeholder}
              style={{ height }}
              aria-hidden="true"
            />
          }
        >
          {() =>
            typeof children === 'function' ? (
              <FillStage>{children}</FillStage>
            ) : (
              children
            )
          }
        </BrowserOnly>
      </div>
      {collapsed ? (
        <>
          {/* Own header rather than CodeBlock's `title`, so the toggle can live
              on the same bar — and so the bar is still there to click when the
              fence below it is closed. */}
          <button
            type="button"
            className={styles.sourceBar}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span className={styles.sourceName}>{file}</span>
            <span className={styles.sourceHint}>
              {open ? 'Hide code' : 'Expand to see code'}
            </span>
            <span
              className={styles.sourceChevron}
              data-open={open}
              aria-hidden="true"
            >
              ⌄
            </span>
          </button>
          {open && <CodeBlock language="tsx">{source}</CodeBlock>}
        </>
      ) : (
        <CodeBlock language="tsx" title={file}>
          {source}
        </CodeBlock>
      )}
    </div>
  );
}
