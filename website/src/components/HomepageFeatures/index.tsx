import type { ReactNode } from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  description: ReactNode;
};

const featureList: FeatureItem[] = [
  {
    title: 'One library, three languages',
    description:
      'TypeScript for the browser and Node, Rust for native speed on many cores, Python with polars and pandas frames. Every language runs the same test cases and gives the same numbers, to the bit.',
  },
  {
    title: 'Time is the point',
    description:
      'Rows keyed by a moment, a span or a labelled bucket. Calendar days that know a day can be 23 or 25 hours long. Gaps that stay gaps. Rolling windows, buckets, joins and 109 finance studies.',
  },
  {
    title: 'Batch and live',
    description:
      'The same operations on a whole series or on events as they arrive, with live buckets, rolling windows and per-host partitions. Charts and React hooks on top, in TypeScript.',
  },
];

function Feature({ title, description }: FeatureItem): ReactNode {
  return (
    <div className={clsx('col col--4', styles.featureCard)}>
      <div className={styles.featureInner}>
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {featureList.map((feature) => (
            <Feature key={feature.title} {...feature} />
          ))}
        </div>
      </div>
    </section>
  );
}
