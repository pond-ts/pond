import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Measure an element's own box and keep the number current as it resizes —
 * the site's shared implementation of the
 * [responsive-width recipe](/docs/recipes/responsive-width).
 *
 * `<ChartContainer>` takes an explicit pixel width (no responsive mode yet —
 * see PLAN's `[PND-WIDTH]`), so every full-width embed on this site is a box
 * that measures itself and hands the number down. Returns `0` until the first
 * layout pass; callers should render nothing until it's positive rather than
 * mount a zero-width chart.
 */
export function useMeasuredWidth<T extends HTMLElement>() {
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
