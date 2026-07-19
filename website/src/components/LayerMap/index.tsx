import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import styles from './styles.module.css';

/**
 * The platform's layer story — one component, two placements (plan §5a.2/§5c):
 *
 * - `<LayerMap />` — the full stack of door-cards (homepage, intro): domain on
 *   top, visualization in the middle, foundation at the bottom, React glue as
 *   the side rail binding the stack to the UI.
 * - `<LayerLocator layer="…" />` — the compact "you are here" header every
 *   package index carries: a mini stack with the current layer lit, plus a
 *   one-line placement note.
 */

export type LayerId = 'domain' | 'visualization' | 'foundation' | 'react';

interface PackageDoor {
  name: string;
  to: string;
}

interface Layer {
  id: LayerId;
  /** Architectural role — the card's eyebrow and the locator's label. */
  role: string;
  packages: PackageDoor[];
  /** The layer's one job, stated once. */
  job: string;
}

/** Stack order: domain sits on visualization sits on foundation. */
const STACK: Layer[] = [
  {
    id: 'domain',
    role: 'Domain',
    packages: [
      { name: '@pond-ts/financial', to: '/docs/financial/' },
      { name: '@pond-ts/fit', to: '/docs/fit/' },
    ],
    job: 'Vocabularies on the core: trading calendars and studies; activity and fitness analysis.',
  },
  {
    id: 'visualization',
    role: 'Visualization',
    packages: [{ name: '@pond-ts/charts', to: '/docs/charts/' }],
    job: 'Canvas charts that consume a TimeSeries directly — live, composable, themed.',
  },
  {
    id: 'foundation',
    role: 'Foundation',
    packages: [{ name: 'pond-ts', to: '/docs/pond-ts/' }],
    job: 'Schema-typed series and the analytics: aggregate, rolling, baseline, smooth, sample.',
  },
];

const GLUE: Layer = {
  id: 'react',
  role: 'React glue',
  packages: [{ name: '@pond-ts/react', to: '/docs/react/' }],
  job: 'Hooks binding live series to rendering: throttled snapshots, stable refs, cleanup.',
};

function LayerCard({ layer }: { layer: Layer }): ReactNode {
  return (
    <div className={clsx(styles.card, styles[`card_${layer.id}`])}>
      <span className={styles.role}>{layer.role}</span>
      <div className={styles.packages}>
        {layer.packages.map((p) => (
          <Link key={p.name} to={p.to} className={styles.pkg}>
            {p.name}
          </Link>
        ))}
      </div>
      <p className={styles.job}>{layer.job}</p>
    </div>
  );
}

/** The full stack of door-cards. */
export default function LayerMap(): ReactNode {
  return (
    <div className={styles.map}>
      <div className={styles.stack}>
        {STACK.map((l) => (
          <LayerCard key={l.id} layer={l} />
        ))}
      </div>
      <div className={styles.glueRail}>
        <LayerCard layer={GLUE} />
      </div>
    </div>
  );
}

const LOCATOR_NOTES: Record<LayerId, string> = {
  foundation:
    'the analytics core everything else builds on — sits under @pond-ts/charts.',
  visualization:
    'draws what the foundation computes — consumes a pond TimeSeries directly.',
  domain: 'a vocabulary built on the core, drawn by @pond-ts/charts.',
  react: 'the live-binding glue between pond series and your components.',
};

/** The compact "you are here" header for a package index page. */
export function LayerLocator({
  layer,
  note,
}: {
  layer: LayerId;
  /** Override the default placement note. */
  note?: string;
}): ReactNode {
  const role = (layer === 'react' ? GLUE : STACK.find((l) => l.id === layer))!
    .role;
  return (
    <div className={styles.locator}>
      <span className={styles.miniStack} aria-hidden="true">
        {(['domain', 'visualization', 'foundation'] as const).map((id) => (
          <span
            key={id}
            className={clsx(
              styles.miniLayer,
              id === layer && styles.miniActive,
            )}
          />
        ))}
        <span
          className={clsx(
            styles.miniGlue,
            layer === 'react' && styles.miniActive,
          )}
        />
      </span>
      <span className={styles.locatorText}>
        <strong>{role} layer</strong> — {note ?? LOCATOR_NOTES[layer]}
      </span>
    </div>
  );
}
