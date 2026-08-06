import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import { useAutoplayPhase, type AutoplayOptions } from '@site/src/lib/autoplay';
import styles from './styles.module.css';

interface GalleryCardProps {
  title: string;
  blurb: string;
  /**
   * Absolute pathname into the deployed Storybook, e.g.
   * `/storybook/?path=/story/charts-candlestick--show-ohlc`.
   *
   * Optional, because some cards demonstrate a **composition** rather than a
   * component — a stacked area is several `<AreaChart>`s over cumulative
   * columns, which no single story shows. Omit it rather than pointing at an
   * approximation: a "Story ↗" that opens something else is worse than no
   * link, and the `pageHref` walkthrough is the real destination for those.
   */
  storybookHref?: string;
  /**
   * Deep link to this chart's Gallery page — the build-it tutorial
   * (`/docs/charts/gallery/<slug>`). Optional while the pages land track by
   * track; a card without one shows only its Storybook link.
   */
  pageHref?: string;
  /**
   * Opt this card into **autoplay**: the second argument to `children`
   * becomes a loop phase in `[0, 1)` instead of a constant, and the card
   * animates while it's on screen. Omit for a still card — that's the
   * shipped, non-animated behaviour and it stays the default.
   *
   * Every animating card shares **one** `requestAnimationFrame` loop, only
   * animates while it intersects the viewport, and freezes at
   * {@link AutoplayOptions.staticPhase} under `prefers-reduced-motion`. See
   * `src/lib/autoplay.ts`.
   */
  autoplay?: AutoplayOptions;
  /** Fixed pixel height for the chart stage. **Must budget for the
   *  `ChartContainer`'s auto-rendered time-axis strip** (`showAxis`
   *  defaults `true`, adding ~22px below the rows) on top of the sum of
   *  the mounted example's own `<ChartRow height>`s — the stage clips
   *  (`overflow: hidden`) anything taller, silently cutting off axis
   *  labels rather than erroring. */
  height?: number;
  /** Render-prop: the card measures its own box (ResizeObserver) and hands
   *  back the width, since `<ChartContainer>` takes an explicit pixel width
   *  with no responsive mode yet — the
   *  [responsive-width recipe](/docs/recipes/responsive-width)'s pattern,
   *  applied per-card. The second argument is the {@link autoplay} loop
   *  phase, `0` for a still card — a scrolling window's offset, a live
   *  push's cursor, a parameter sweep's position. */
  children: (width: number, phase: number) => ReactNode;
}

function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function CardStage({
  height,
  autoplay,
  children,
}: {
  height: number;
  autoplay?: AutoplayOptions;
  children: (width: number, phase: number) => ReactNode;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  // The stage is both the measured box and the intersection target — the
  // thing that has to be on screen for animating it to be worth anything.
  const phase = useAutoplayPhase(ref, autoplay);
  return (
    <div ref={ref} className={styles.stage} style={{ height }}>
      {width > 0 ? children(width, phase) : null}
    </div>
  );
}

/**
 * One Gallery card (docs plan §5a): a live, touchable chart — not a
 * thumbnail — plus a one-line caption and the links out. Deliberately lighter
 * than `<ChartExample>`: the Gallery is a shop-window scan, not a reference
 * page, so no inline source block here — {@link GalleryCardProps.pageHref}
 * (the build-it tutorial) and the Storybook story are where the curious go.
 *
 * Pass {@link GalleryCardProps.autoplay} to make the preview move; without it
 * the card is a still, exactly as before.
 */
export default function GalleryCard({
  title,
  blurb,
  storybookHref,
  pageHref,
  autoplay,
  height = 220,
  children,
}: GalleryCardProps) {
  return (
    <div className={styles.card}>
      <BrowserOnly
        fallback={
          <div
            className={styles.placeholder}
            style={{ height }}
            aria-hidden="true"
          />
        }
      >
        {() => (
          <CardStage height={height} autoplay={autoplay}>
            {children}
          </CardStage>
        )}
      </BrowserOnly>
      <div className={styles.meta}>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.blurb}>{blurb}</p>
        <div className={styles.links}>
          {pageHref ? (
            <Link className={styles.link} to={pageHref}>
              Build it →
            </Link>
          ) : null}
          {storybookHref ? (
            <Link className={styles.link} to={storybookHref}>
              Story ↗
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
