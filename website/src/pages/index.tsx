import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import ThemedImage from '@theme/ThemedImage';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Heading from '@theme/Heading';
import styles from './index.module.css';

function HomepageHeader(): ReactNode {
  const { siteConfig } = useDocusaurusContext();
  const logoSources = {
    light: useBaseUrl('/img/pond-mark-light.svg'),
    dark: useBaseUrl('/img/pond-mark-dark.svg'),
  };

  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className={clsx('container', styles.heroContent)}>
        <div className={styles.heroLogoWrap}>
          <div className={styles.heroLogoFrame}>
            <ThemedImage
              className={styles.heroLogo}
              sources={logoSources}
              alt="Pond logo"
            />
          </div>
        </div>
        <span className={styles.heroEyebrow}>[ TypeScript · time series ]</span>
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--primary button--lg"
            to="/docs/start-here/getting-started"
          >
            Get started
          </Link>
          <Link
            className="button button--outline button--primary button--lg"
            to="/docs/recipes/"
          >
            Explore an example
          </Link>
        </div>
        <div className={styles.heroMeta}>
          <span className={styles.heroPill}>Typed events and schemas</span>
          <span className={styles.heroPill}>Alignment, aggregation, joins</span>
          <span className={styles.heroPill}>Rolling windows and smoothing</span>
        </div>
      </div>
    </header>
  );
}

export default function Home(): ReactNode {
  const { siteConfig } = useDocusaurusContext();

  return (
    <Layout
      title={siteConfig.title}
      description="Typed time series primitives for modern TypeScript projects"
    >
      <HomepageHeader />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
