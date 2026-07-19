import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import CodeBlock from '@theme/CodeBlock';
import styles from './styles.module.css';

/**
 * In-site API reference renderers. These consume the distilled model emitted
 * by `scripts/build-api-model.mjs` (curated per-primitive JSON, not raw
 * typedoc) and render it with the site's own typography and tokens — the
 * docstring is the star, signatures are real highlighted TS, and props render
 * as definition cards rather than a cramped table.
 */

interface SigModel {
  text: string;
  doc: string;
  example?: string;
  examples?: string[];
  params: {
    name: string;
    type: string;
    optional: boolean;
    default?: string;
    doc?: string;
  }[];
  returns: string;
  returnsDoc?: string;
}

interface MethodModel {
  name: string;
  static: boolean;
  sourceUrl?: string;
  signatures: SigModel[];
}

export interface ClassModel {
  name: string;
  package: string;
  doc: string;
  example?: string;
  sourceUrl?: string;
  constructorSigs: SigModel[];
  staticMethods: MethodModel[];
  methods: MethodModel[];
  properties: {
    name: string;
    type: string;
    readonly: boolean;
    doc: string;
    example?: string;
  }[];
}

export interface ComponentModel {
  name: string;
  package: string;
  doc: string;
  sourceUrl?: string;
  propsName: string;
  typeParams: string[];
  props: { name: string; type: string; optional: boolean; doc: string }[];
}

/** Docstring prose — markdown, in the site's body style. */
function Doc({ md }: { md: string }): ReactNode {
  if (!md) return null;
  return (
    <div className={styles.doc}>
      <Markdown>{md}</Markdown>
    </div>
  );
}

/** The one-line house example, as a quiet code chip. */
function ExampleChip({ code }: { code?: string }): ReactNode {
  if (!code) return null;
  return (
    <div className={styles.exampleChip}>
      <code>{code}</code>
    </div>
  );
}

function SourceLink({ url }: { url?: string }): ReactNode {
  if (!url) return null;
  return (
    <a
      className={styles.sourceLink}
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      source
    </a>
  );
}

function Header({
  title,
  pkg,
  kind,
  sourceUrl,
}: {
  title: string;
  pkg: string;
  kind: string;
  sourceUrl?: string;
}): ReactNode {
  return (
    <div className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      <span className={styles.kindBadge}>{kind}</span>
      <span className={styles.pkgBadge}>{pkg}</span>
      <SourceLink url={sourceUrl} />
    </div>
  );
}

function Signature({ sig }: { sig: SigModel }): ReactNode {
  return (
    <div className={styles.signature}>
      <CodeBlock language="ts">{sig.text}</CodeBlock>
      <ExampleChip code={sig.example} />
      <Doc md={sig.doc} />
      {sig.params.some((p) => p.doc) ? (
        <ul className={styles.paramList}>
          {sig.params
            .filter((p) => p.doc)
            .map((p) => (
              <li key={p.name}>
                <code>{p.name}</code> — <Markdown>{p.doc!}</Markdown>
              </li>
            ))}
        </ul>
      ) : null}
      {sig.returnsDoc ? (
        <div className={styles.returnsDoc}>
          <span className={styles.returnsLabel}>Returns</span>{' '}
          <Markdown>{sig.returnsDoc}</Markdown>
        </div>
      ) : null}
      {sig.examples?.map((ex) => (
        <CodeBlock key={ex.slice(0, 24)} language="ts">
          {ex}
        </CodeBlock>
      ))}
    </div>
  );
}

function MethodEntry({ m }: { m: MethodModel }): ReactNode {
  return (
    <div className={styles.member} id={m.name}>
      <h3 className={styles.memberName}>
        <a className={styles.anchor} href={`#${m.name}`}>
          {m.name}
        </a>
        {m.static ? <span className={styles.staticBadge}>static</span> : null}
      </h3>
      {m.signatures.map((s) => (
        <Signature key={s.text} sig={s} />
      ))}
    </div>
  );
}

/** Jump-links index over the class's members, in render order. */
function MemberIndex({ model }: { model: ClassModel }): ReactNode {
  const names = [
    ...model.staticMethods.map((m) => m.name),
    ...model.methods.map((m) => m.name),
  ];
  if (names.length < 8) return null;
  return (
    <nav className={styles.memberIndex} aria-label="members">
      {names.map((n) => (
        <a key={n} href={`#${n}`}>
          {n}
        </a>
      ))}
    </nav>
  );
}

/** A core primitive page: class docstring, constructor, members. */
export function ApiClassPage({ model }: { model: ClassModel }): ReactNode {
  return (
    <div className={styles.page}>
      <Header
        title={model.name}
        pkg={model.package}
        kind="class"
        sourceUrl={model.sourceUrl}
      />
      <Doc md={model.doc} />
      <ExampleChip code={model.example} />
      <MemberIndex model={model} />

      {model.constructorSigs.length > 0 ? (
        <>
          <h2 className={styles.sectionHead} id="constructor">
            Constructor
          </h2>
          {model.constructorSigs.map((s) => (
            <Signature key={s.text} sig={s} />
          ))}
        </>
      ) : null}

      {model.properties.length > 0 ? (
        <>
          <h2 className={styles.sectionHead} id="properties">
            Properties
          </h2>
          {model.properties.map((p) => (
            <div className={styles.member} id={p.name} key={p.name}>
              <div className={styles.propHead}>
                <a className={styles.anchor} href={`#${p.name}`}>
                  <code className={styles.propName}>{p.name}</code>
                </a>
                <code className={styles.propType}>{p.type}</code>
                {p.readonly ? (
                  <span className={styles.staticBadge}>readonly</span>
                ) : null}
              </div>
              <ExampleChip code={p.example} />
              <Doc md={p.doc} />
            </div>
          ))}
        </>
      ) : null}

      {model.staticMethods.length > 0 ? (
        <>
          <h2 className={styles.sectionHead} id="static-methods">
            Static methods
          </h2>
          {model.staticMethods.map((m) => (
            <MethodEntry key={m.name} m={m} />
          ))}
        </>
      ) : null}

      {model.methods.length > 0 ? (
        <>
          <h2 className={styles.sectionHead} id="methods">
            Methods
          </h2>
          {model.methods.map((m) => (
            <MethodEntry key={m.name} m={m} />
          ))}
        </>
      ) : null}
    </div>
  );
}

/** A charts component page: docstring first, then the props as cards. */
export function ApiComponentPage({
  model,
}: {
  model: ComponentModel;
}): ReactNode {
  return (
    <div className={styles.page}>
      <Header
        title={`<${model.name}>`}
        pkg={model.package}
        kind="component"
        sourceUrl={model.sourceUrl}
      />
      <Doc md={model.doc} />

      <h2 className={styles.sectionHead} id="props">
        Props
      </h2>
      <div className={styles.propCards}>
        {model.props.map((p) => (
          <div className={styles.propCard} id={`prop-${p.name}`} key={p.name}>
            <div className={styles.propHead}>
              <a className={styles.anchor} href={`#prop-${p.name}`}>
                <code className={styles.propName}>{p.name}</code>
              </a>
              <code className={styles.propType}>{p.type}</code>
              {p.optional ? null : (
                <span className={styles.requiredBadge}>required</span>
              )}
            </div>
            <Doc md={p.doc} />
          </div>
        ))}
      </div>
    </div>
  );
}
