import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import ThemedImage from '@theme/ThemedImage';
import HomepageFeatures from '@site/src/components/HomepageFeatures';
import Heading from '@theme/Heading';
import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import CodeBlock from '@theme/CodeBlock';
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
        <span className={styles.heroEyebrow}>
          [ TypeScript · Rust · Python · time series ]
        </span>
        <Heading as="h1" className="hero__title">
          {siteConfig.title}
        </Heading>
        <p className={styles.heroSubtitle}>{siteConfig.tagline}</p>
        <div className={styles.buttons}>
          <Link
            className="button button--primary button--lg"
            to="/docs/languages"
          >
            Get started
          </Link>
          <Link
            className="button button--outline button--primary button--lg"
            to="/docs/getting-started"
          >
            Walk through an example
          </Link>
        </div>
        <div className={styles.heroMeta}>
          <span className={styles.heroPill}>
            Same answers in every language
          </span>
          <span className={styles.heroPill}>Batch and live</span>
          <span className={styles.heroPill}>
            Calendar days in any time zone
          </span>
        </div>
        <div className={styles.install}>
          {/* Same groupId as the docs' tabs: the language picked here is
              the one every tabbed example on the site opens with. */}
          <Tabs groupId="language">
            <TabItem value="ts" label="TypeScript" default>
              <CodeBlock language="sh">npm install pond-ts</CodeBlock>
            </TabItem>
            <TabItem value="rust" label="Rust">
              <CodeBlock language="sh">cargo add pond-rs</CodeBlock>
            </TabItem>
            <TabItem value="python" label="Python">
              <CodeBlock language="sh">pip install pond-timeseries</CodeBlock>
            </TabItem>
          </Tabs>
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
      description="Time series analysis in TypeScript, Rust and Python, with the same answers in each"
    >
      <HomepageHeader />
      <main>
        <HomepageFeatures />
      </main>
    </Layout>
  );
}
