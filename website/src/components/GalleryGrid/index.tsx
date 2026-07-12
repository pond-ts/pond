import type { ReactNode } from 'react';
import styles from './styles.module.css';

/** The Gallery's responsive card grid: 2 columns down to 1 on narrow
 *  viewports — each `<GalleryCard>` measures its own box via ResizeObserver,
 *  so the grid is free to reflow the column count. */
export default function GalleryGrid({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return <div className={styles.grid}>{children}</div>;
}
