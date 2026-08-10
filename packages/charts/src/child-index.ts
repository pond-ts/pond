import {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from 'react';
import { isDev } from './dev.js';

/**
 * Inject each child's JSX position as an `index` prop, so a child registers its
 * **declaration order** rather than its mount order — and warn (dev, once per
 * component instance) when a `<Fragment>` child swallows that injection.
 *
 * Two components inject this way — `<ChartRow>` into its axes, `<Layers>` into
 * its draw layers — and both are defeated the same way: a fragment accepts no
 * props, so the index stops there and every element inside falls back to its
 * `index = 0` default. What makes it worth a warning rather than a doc note is
 * that the failure is **silent and plausible**: the sort is stable, so the
 * resulting tie resolves to mount order, which on a synchronous tree matches
 * declaration order. The stack looks correct right up to the case the injection
 * exists for — an element toggled on between two others, which lands on top
 * instead of slotting into place.
 *
 * The fragment is deliberately **not** cloned. Cloning it makes React emit its
 * own, vaguer "invalid prop `index` supplied to `React.Fragment`" on top of
 * ours, which is how this class of bug hid in plain sight: the message named the
 * prop but not the consequence, so it read as cosmetic.
 *
 * @param children the component's `children`
 * @param owner the component name, for the warning (e.g. `'<Layers>'`)
 * @param consequence what breaks, in one clause — the part a reader acts on
 */
export function useIndexedChildren(
  children: ReactNode,
  owner: string,
  consequence: string,
): readonly ReactNode[] | null | undefined {
  let sawFragmentChild = false;
  // `Children.map`'s own return type is a conditional over the `children` type
  // argument, which collapses to something non-iterable when `children` is the
  // broad `ReactNode`. Both callers need the array (one iterates it, one renders
  // it), so the shape is pinned here — `Children.map` really does hand back an
  // array, or `null`/`undefined` for absent children, which both callers handle.
  const indexed = Children.map(children, (child, index) => {
    if (!isValidElement(child)) return child;
    if (child.type === Fragment) {
      sawFragmentChild = true;
      return child;
    }
    return cloneElement(child as ReactElement<{ index?: number }>, { index });
  }) as readonly ReactNode[] | null | undefined;

  // Warned from an effect rather than from the map above: that runs during
  // render, and a render-phase ref write would let a discarded concurrent
  // render burn the once-per-instance flag and swallow the warning entirely.
  const warned = useRef(false);
  useEffect(() => {
    if (!isDev || !sawFragmentChild || warned.current) return;
    warned.current = true;
    console.warn(
      `[pond-charts] a <Fragment> child of ${owner} swallows the injected ` +
        `declaration index, so ${consequence}. List them as direct children, ` +
        'or return a keyed array instead of a fragment.',
    );
  }, [sawFragmentChild, owner, consequence]);

  return indexed;
}
