import type { ReactNode } from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import BrowserOnly from '@docusaurus/BrowserOnly';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import ThemedImage from '@theme/ThemedImage';
import Heading from '@theme/Heading';
import LayerMap from '@site/src/components/LayerMap';
import PipelineStrip from '@site/src/components/PipelineStrip';
import CoreAnomalyLive from '@site/src/examples/core-anomaly-live';
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
        {/* The first thing a visitor touches is a real pond chart: a live
            stream, a rolling baseline() band, outliers flagged as they cross
            it — the sigma control is a pond core option, not a chart prop. */}
        <div className={styles.heroChart}>
          <BrowserOnly
            fallback={<div style={{ height: 300 }} aria-hidden="true" />}
          >
            {() => <CoreAnomalyLive />}
          </BrowserOnly>
          <p className={styles.heroChartCaption}>
            Live, right now: a rolling <code>baseline()</code> band over a
            streaming series, outliers flagged as they cross it. Drag{' '}
            <strong>sigma</strong> — the control is a pond analytics option, the
            chart just redraws.{' '}
            <Link to="/docs/pond-ts/transforms/anomaly-detection">
              How it works →
            </Link>
          </p>
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
      description="Time-series analytics and live visualization for TypeScript — one typed platform: pond-ts core, @pond-ts/charts, financial and fitness domain packages, React glue"
    >
      <HomepageHeader />
      <main>
        <section className={styles.section}>
          <div className="container">
            <Heading as="h2" className={styles.sectionTitle}>
              Rows in, analytics run, chart out
            </Heading>
            <p className={styles.sectionLead}>
              The whole motion in one gesture: schema-typed rows, one analytics
              call on the series, a chart that consumes the result directly. The
              chip in the middle is the exact call that produced the chart on
              the right.
            </p>
            <BrowserOnly
              fallback={<div style={{ height: 220 }} aria-hidden="true" />}
            >
              {() => <PipelineStrip />}
            </BrowserOnly>
          </div>
        </section>
        <section className={clsx(styles.section, styles.sectionAlt)}>
          <div className="container">
            <Heading as="h2" className={styles.sectionTitle}>
              One platform, four layers
            </Heading>
            <p className={styles.sectionLead}>
              A typed analytics <strong>foundation</strong>, canvas{' '}
              <strong>visualization</strong> that consumes it directly,{' '}
              <strong>domain</strong> vocabularies on top, and React{' '}
              <strong>glue</strong> for live apps. Each layer has one job; every
              card is a door.
            </p>
            <LayerMap />
          </div>
        </section>
      </main>
    </Layout>
  );
}
