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
import HomeHeroLive from '@site/src/examples/home-hero-live';
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
        {/* The first thing a visitor touches is a real pond chart: raw points
            stream in, smooth() draws the trend, and the clip toggle filters
            outliers via baseline() — analytics options, not chart props. */}
        <div className={styles.heroChart}>
          <BrowserOnly
            fallback={<div style={{ height: 300 }} aria-hidden="true" />}
          >
            {() => <HomeHeroLive />}
          </BrowserOnly>
          <p className={styles.heroChartCaption}>
            Live, right now: raw points stream in and a real{' '}
            <code>smooth()</code> draws the trend through them — drag{' '}
            <strong>smooth</strong> to tune it. The shaded bands are a rolling{' '}
            <code>baseline()</code> at 1σ and at the <strong>sigma</strong> you
            pick; flip <strong>clip</strong> and the outliers beyond it drop out
            of the line, left behind as red dots. All pond analytics options;
            the chart just redraws.{' '}
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
