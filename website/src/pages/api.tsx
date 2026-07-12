import type { ReactNode } from 'react';
import Layout from '@theme/Layout';
import useBaseUrl from '@docusaurus/useBaseUrl';

import styles from './api.module.css';

export default function ApiPage(): ReactNode {
  const coreHref = useBaseUrl('/generated-api/core/');
  const reactHref = useBaseUrl('/generated-api/react/');
  const fitHref = useBaseUrl('/generated-api/fit/');
  const chartsHref = useBaseUrl('/generated-api/charts/');
  const financialHref = useBaseUrl('/generated-api/financial/');

  return (
    <Layout
      title="API Reference"
      description="Generated TypeScript API reference for pond-ts and the @pond-ts packages"
    >
      <main className={styles.page}>
        <div className={styles.card}>
          <h1>API Reference</h1>
          <p className={styles.lede}>
            Every package has its own full-width generated reference. Pick the
            package whose API you want to browse.
          </p>
          <div className={styles.buttons}>
            <a className={styles.button} href={coreHref}>
              pond-ts (core)
            </a>
            <a className={styles.button} href={reactHref}>
              @pond-ts/react
            </a>
            <a className={styles.button} href={chartsHref}>
              @pond-ts/charts
            </a>
            <a className={styles.button} href={fitHref}>
              @pond-ts/fit
            </a>
            <a className={styles.button} href={financialHref}>
              @pond-ts/financial
            </a>
          </div>
        </div>
      </main>
    </Layout>
  );
}
