import { useLayoutEffect, useRef, useState } from 'react';
import GalleryActivity from './gallery-activity';

/**
 * The fit landing's payoff chart: the gallery's ride elevation profile,
 * self-measuring so it can mount directly on the index page (the gallery
 * version takes an explicit width from its card).
 */
export default function FitLandingActivity() {
  const ref = useRef<HTMLDivElement | null>(null);
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
  return (
    <div ref={ref} style={{ width: '100%' }}>
      {width > 0 ? (
        <GalleryActivity width={width} />
      ) : (
        <div style={{ height: 200 }} />
      )}
    </div>
  );
}
