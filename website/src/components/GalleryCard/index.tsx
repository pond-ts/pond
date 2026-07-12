import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import BrowserOnly from '@docusaurus/BrowserOnly';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

interface GalleryCardProps {
  title: string;
  blurb: string;
  /** Absolute pathname into the deployed Storybook, e.g.
   *  `/storybook/?path=/story/charts-candlestick--show-ohlc`. */
  storybookHref: string;
  /** Fixed pixel height for the chart stage. */
  height?: number;
  /** Render-prop: the card measures its own box (ResizeObserver) and hands
   *  back the width, since `<ChartContainer>` takes an explicit pixel width
   *  with no responsive mode yet — the same seam `MultiPanelLayout.stories.tsx`
   *  solves locally, not yet a documented site-wide recipe (PLAN P1g). */
  children: (width: number) => ReactNode;
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
  children,
}: {
  height: number;
  children: (width: number) => ReactNode;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  return (
    <div ref={ref} className={styles.stage} style={{ height }}>
      {width > 0 ? children(width) : null}
    </div>
  );
}

/**
 * One Gallery card (docs plan §5a): a live, touchable chart — not a
 * thumbnail — plus a one-line caption and a deep link to its Storybook
 * story. Deliberately lighter than `<ChartExample>`: the Gallery is a
 * shop-window scan across 8 cards, not a reference page, so no inline
 * source block here — the Storybook link is where the curious go next.
 */
export default function GalleryCard({
  title,
  blurb,
  storybookHref,
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
        {() => <CardStage height={height}>{children}</CardStage>}
      </BrowserOnly>
      <div className={styles.meta}>
        <h3 className={styles.title}>{title}</h3>
        <p className={styles.blurb}>{blurb}</p>
        <Link className={styles.link} to={storybookHref}>
          Story ↗
        </Link>
      </div>
    </div>
  );
}
