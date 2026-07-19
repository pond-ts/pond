import type { ReactNode } from 'react';
import Layout from '@theme/Layout';
import useBaseUrl from '@docusaurus/useBaseUrl';

import styles from './api.module.css';

/**
 * The API index groups packages by platform layer (plan §5b) — even the
 * reference landing reflects the architecture: foundation → visualization →
 * domain, with the React glue alongside.
 */
export default function ApiPage(): ReactNode {
  const coreHref = useBaseUrl('/generated-api/core/');
  const reactHref = useBaseUrl('/generated-api/react/');
  const fitHref = useBaseUrl('/generated-api/fit/');
  const chartsHref = useBaseUrl('/generated-api/charts/');
  const financialHref = useBaseUrl('/generated-api/financial/');

  const groups: Array<{
    layer: string;
    blurb: string;
    packages: Array<{ name: string; href: string }>;
  }> = [
    {
      layer: 'Foundation',
      blurb: 'Schema-typed series and the analytics core.',
      packages: [{ name: 'pond-ts (core)', href: coreHref }],
    },
    {
      layer: 'Visualization',
      blurb: 'Canvas charts that consume a TimeSeries directly.',
      packages: [{ name: '@pond-ts/charts', href: chartsHref }],
    },
    {
      layer: 'Domain',
      blurb: 'Vocabularies on the core: trading calendars, activity analysis.',
      packages: [
        { name: '@pond-ts/financial', href: financialHref },
        { name: '@pond-ts/fit', href: fitHref },
      ],
    },
    {
      layer: 'React glue',
      blurb: 'Hooks binding live series to rendering.',
      packages: [{ name: '@pond-ts/react', href: reactHref }],
    },
  ];

  return (
    <Layout
      title="API Reference"
      description="Generated TypeScript API reference for pond-ts and the @pond-ts packages"
    >
      <main className={styles.page}>
        <div className={styles.card}>
          <h1>API Reference</h1>
          <p className={styles.lede}>
            Every package has its own full-width generated reference, grouped
            here by platform layer. Pick the package whose API you want to
            browse.
          </p>
          {groups.map((g) => (
            <div key={g.layer} className={styles.group}>
              <div className={styles.groupHeader}>
                <span className={styles.groupLayer}>{g.layer}</span>
                <span className={styles.groupBlurb}>{g.blurb}</span>
              </div>
              <div className={styles.buttons}>
                {g.packages.map((p) => (
                  <a key={p.name} className={styles.button} href={p.href}>
                    {p.name}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      </main>
    </Layout>
  );
}
