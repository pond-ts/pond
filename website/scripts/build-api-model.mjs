// Distills typedoc JSON into the curated per-primitive API model that the
// in-site reference pages render (src/components/ApiDoc). Two stages:
//
//   1. `typedoc --json` per package (full declaration model, straight from TS)
//   2. this script walks it and emits ONLY the curated pages — classes keyed
//      by primitive for core, components (docstring + props) for charts —
//      with docstrings as markdown and types printed as TS strings.
//
// The curation maps below are the contract: every page the site renders is
// listed here, and the script FAILS if a listed symbol disappears from the
// export surface, so the pages can't silently go stale.
//
// Output: src/api-model/<pkg>/<slug>.json — one file per page, each with its
// page-local hover dictionary (gitignored; rebuilt by prestart/prebuild).

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_DIR = join(ROOT, '.api-json');
const OUT_DIR = join(ROOT, 'src', 'api-model');

// ---- curation maps (the pilot set) -----------------------------------------

/** Core classes rendered as primitive pages, in sidebar order. */
const CORE_CLASSES = [
  { name: 'Time', slug: 'time' },
  { name: 'TimeRange', slug: 'time-range' },
  { name: 'Interval', slug: 'interval' },
  { name: 'Event', slug: 'event' },
  { name: 'Sequence', slug: 'sequence' },
  { name: 'BoundedSequence', slug: 'bounded-sequence' },
  { name: 'TimeSeries', slug: 'time-series' },
  { name: 'PartitionedTimeSeries', slug: 'partitioned-time-series' },
  { name: 'ValueSeries', slug: 'value-series' },
  { name: 'LiveSeries', slug: 'live-series' },
  { name: 'LiveView', slug: 'live-view' },
  { name: 'LivePartitionedSeries', slug: 'live-partitioned-series' },
  { name: 'LivePartitionedView', slug: 'live-partitioned-view' },
];
/** Chart components rendered as docstring + props pages. */
const CHART_COMPONENTS = [
  { component: 'LineChart', props: 'LineChartProps', slug: 'line-chart' },
];

// ---- typedoc JSON helpers --------------------------------------------------

const KIND = {
  class: 128,
  interface: 256,
  function: 64,
  constructor: 512,
  property: 1024,
  method: 2048,
  accessor: 262144,
};

function child(node, name) {
  return (node.children ?? []).find((c) => c.name === name);
}

function hasModifier(comment, tag) {
  return (comment?.modifierTags ?? []).includes(tag);
}

function sourceUrl(node) {
  return node.sources?.[0]?.url;
}

// ---- comment → markdown ----------------------------------------------------

/** Render typedoc comment display parts to a markdown string. */
function partsToMd(parts = []) {
  return parts
    .map((p) => {
      if (p.kind === 'inline-tag' && p.tag === '@link') {
        // Pilot: links render as code; cross-page resolution comes later.
        return '`' + p.text + '`';
      }
      return p.text;
    })
    .join('');
}

/**
 * Split the house-style leading example out of a docstring: comments here
 * open with "Example: `code`." — pull that into a structured field so the
 * renderer can set it as a code chip instead of prose.
 */
function splitComment(comment) {
  const md = partsToMd(comment?.summary).trim();
  // House style puts a one-line example either first ("Example: `x`. Prose")
  // or last ("Prose. Example: `x`.") — pull it out of the prose either way.
  const lead = md.match(/^Example:\s*`([^`]+)`\.?\s*/);
  const tail = lead ? null : md.match(/\s*Example:\s*`([^`]+)`\.?\s*$/);
  const example = lead ? lead[1] : tail ? tail[1] : undefined;
  const doc = lead
    ? md.slice(lead[0].length)
    : tail
      ? md.slice(0, tail.index)
      : md;
  const examples = (comment?.blockTags ?? [])
    .filter((t) => t.tag === '@example')
    .map((t) => partsToMd(t.content).trim());
  const returnsDoc = (comment?.blockTags ?? [])
    .filter((t) => t.tag === '@returns')
    .map((t) => partsToMd(t.content).trim())[0];
  return { doc, example, examples, returnsDoc };
}

// ---- type printer ----------------------------------------------------------

const warnings = [];
/** Type names referenced while printing — feeds the hover-card dictionary. */
const referencedNames = new Set();

function printType(t) {
  if (!t) return 'unknown';
  switch (t.type) {
    case 'intrinsic':
      return t.name;
    case 'reference': {
      referencedNames.add(t.name);
      const args = t.typeArguments?.length
        ? `<${t.typeArguments.map(printType).join(', ')}>`
        : '';
      return `${t.name}${args}`;
    }
    case 'union':
      return t.types.map(printType).join(' | ');
    case 'intersection':
      return t.types.map(printType).join(' & ');
    case 'array': {
      const el = printType(t.elementType);
      return /[|&]/.test(el) ? `(${el})[]` : `${el}[]`;
    }
    case 'literal':
      return typeof t.value === 'string' ? `'${t.value}'` : String(t.value);
    case 'tuple':
      return `[${(t.elements ?? []).map(printType).join(', ')}]`;
    case 'typeOperator':
      return `${t.operator} ${printType(t.target)}`;
    case 'query':
      return `typeof ${printType(t.queryType)}`;
    case 'predicate':
      return `${t.name} is ${printType(t.targetType)}`;
    case 'indexedAccess':
      return `${printType(t.objectType)}[${printType(t.indexType)}]`;
    case 'templateLiteral': {
      const parts = t.tail
        .map(([ty, text]) => '${' + printType(ty) + '}' + text)
        .join('');
      return '`' + t.head + parts + '`';
    }
    case 'namedTupleMember':
      return `${t.name}${t.isOptional ? '?' : ''}: ${printType(t.element)}`;
    case 'mapped': {
      const ro =
        t.readonlyModifier === '+'
          ? 'readonly '
          : t.readonlyModifier === '-'
            ? '-readonly '
            : '';
      const opt =
        t.optionalModifier === '+'
          ? '?'
          : t.optionalModifier === '-'
            ? '-?'
            : '';
      const as = t.nameType ? ` as ${printType(t.nameType)}` : '';
      return `{ ${ro}[${t.parameter} in ${printType(t.parameterType)}${as}]${opt}: ${printType(t.templateType)} }`;
    }
    case 'inferred':
      return t.constraint
        ? `infer ${t.name} extends ${printType(t.constraint)}`
        : `infer ${t.name}`;
    case 'rest':
      return `...${printType(t.elementType)}`;
    case 'conditional':
      return `${printType(t.checkType)} extends ${printType(t.extendsType)} ? ${printType(t.trueType)} : ${printType(t.falseType)}`;
    case 'reflection': {
      const d = t.declaration;
      if (d?.signatures?.length) {
        const s = d.signatures[0];
        const params = (s.parameters ?? [])
          .map(
            (p) =>
              `${p.name}${p.flags?.isOptional ? '?' : ''}: ${printType(p.type)}`,
          )
          .join(', ');
        return `(${params}) => ${printType(s.type)}`;
      }
      if (d?.children?.length) {
        const members = d.children
          .map(
            (c) =>
              `${c.name}${c.flags?.isOptional ? '?' : ''}: ${printType(c.type)}`,
          )
          .join('; ');
        return `{ ${members} }`;
      }
      return '{}';
    }
    default:
      warnings.push(`unhandled type kind: ${t.type}`);
      return 'unknown';
  }
}

// ---- signature / class / component distillers ------------------------------

function distillSignature(sig, { name, isConstructor = false } = {}) {
  const { doc, example, examples, returnsDoc } = splitComment(sig.comment);
  const params = (sig.parameters ?? []).map((p) => ({
    name: p.name,
    type: printType(p.type),
    optional: Boolean(p.flags?.isOptional) || p.defaultValue !== undefined,
    default: p.defaultValue,
    doc: partsToMd(p.comment?.summary).trim() || undefined,
  }));
  const paramText = params
    .map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`)
    .join(', ');
  const returns = printType(sig.type);
  const text = isConstructor
    ? `new ${name}(${paramText})`
    : `${name}(${paramText}): ${returns}`;
  return { text, doc, example, examples, params, returns, returnsDoc };
}

function distillClass(pkgJson, name, pkgName) {
  const node = child(pkgJson, name);
  if (!node || node.kind !== KIND.class) {
    throw new Error(`curated class ${name} not found in ${pkgName} exports`);
  }
  const { doc, example } = splitComment(node.comment);
  const model = {
    name,
    package: pkgName,
    kind: 'class',
    doc,
    example,
    sourceUrl: sourceUrl(node),
    constructorSigs: [],
    staticMethods: [],
    methods: [],
    properties: [],
  };
  for (const c of node.children ?? []) {
    if (hasModifier(c.comment, '@internal')) continue;
    if (c.kind === KIND.constructor) {
      model.constructorSigs = (c.signatures ?? []).map((s) =>
        distillSignature(s, { name, isConstructor: true }),
      );
    } else if (c.kind === KIND.method) {
      if (hasModifier(c.signatures?.[0]?.comment, '@internal')) continue;
      const entry = {
        name: c.name,
        static: Boolean(c.flags?.isStatic),
        sourceUrl: sourceUrl(c),
        signatures: (c.signatures ?? []).map((s) =>
          distillSignature(s, { name: c.name }),
        ),
      };
      (entry.static ? model.staticMethods : model.methods).push(entry);
    } else if (c.kind === KIND.property) {
      const { doc: pdoc, example: pex } = splitComment(c.comment);
      model.properties.push({
        name: c.name,
        type: printType(c.type),
        readonly: Boolean(c.flags?.isReadonly),
        doc: pdoc,
        example: pex,
      });
    } else if (c.kind === KIND.accessor) {
      // Getters render as properties (their read shape); a getter without a
      // setter is readonly. Dropping these silently would lose members on
      // accessor-bearing classes even though the pilot classes have none.
      const get = c.getSignature;
      if (!get || hasModifier(get.comment, '@internal')) continue;
      const { doc: pdoc, example: pex } = splitComment(get.comment);
      model.properties.push({
        name: c.name,
        type: printType(get.type),
        readonly: !c.setSignature,
        doc: pdoc,
        example: pex,
      });
    }
  }
  return model;
}

function distillComponent(pkgJson, { component, props }, pkgName) {
  const fn = child(pkgJson, component);
  const propsNode = child(pkgJson, props);
  if (!fn || !propsNode) {
    throw new Error(
      `curated component ${component} / ${props} not found in ${pkgName} exports`,
    );
  }
  const sig = fn.signatures?.[0];
  const { doc } = splitComment(sig?.comment);
  const model = {
    name: component,
    package: pkgName,
    kind: 'component',
    doc,
    sourceUrl: sourceUrl(fn),
    propsName: props,
    typeParams: (propsNode.typeParameters ?? []).map((tp) => tp.name),
    props: [],
  };
  for (const p of propsNode.children ?? []) {
    if (hasModifier(p.comment, '@internal')) continue;
    const md = partsToMd(p.comment?.summary).trim();
    if (/^@internal\b/.test(md)) continue;
    model.props.push({
      name: p.name,
      type: printType(p.type),
      optional: Boolean(p.flags?.isOptional),
      doc: md,
    });
  }
  // Required props first, each group in source order.
  model.props.sort((a, b) => Number(a.optional) - Number(b.optional));
  return model;
}

// ---- type-reference hover dictionary ---------------------------------------

const TYPE_ALIAS_KIND = 2097152;

/**
 * Resolve the type names collected during printing into hover-card entries.
 * Looks the name up across every provided package JSON (a charts page's
 * `TimeSeries<S>` resolves from core), keeping only exported aliases,
 * interfaces, and classes — unresolved names (type params like `S`, external
 * libs) simply get no hover.
 */
function buildTypeDict(packages) {
  const dict = {};
  const cap = (text) => (text.length > 240 ? `${text.slice(0, 240)}…` : text);
  // Hover cards are glances, not pages: first paragraph of the doc only.
  const firstPara = (md) => {
    const para = md.split(/\n\s*\n/)[0].trim();
    return para.length > 360 ? `${para.slice(0, 360)}…` : para;
  };
  for (const name of [...referencedNames].sort()) {
    for (const { json, pkgName } of packages) {
      const node = child(json, name);
      if (!node) continue;
      const doc = firstPara(partsToMd(node.comment?.summary).trim());
      if (node.kind === TYPE_ALIAS_KIND) {
        dict[name] = {
          kind: 'type',
          package: pkgName,
          definition: cap(printType(node.type)),
          doc,
          sourceUrl: sourceUrl(node),
        };
      } else if (node.kind === KIND.interface) {
        const members = (node.children ?? [])
          .filter((c) => !hasModifier(c.comment, '@internal'))
          .map(
            (c) =>
              `${c.name}${c.flags?.isOptional ? '?' : ''}: ${printType(c.type)}`,
          )
          .join('; ');
        dict[name] = {
          kind: 'interface',
          package: pkgName,
          definition: cap(`{ ${members} }`),
          doc,
          sourceUrl: sourceUrl(node),
        };
      } else if (node.kind === KIND.class) {
        dict[name] = {
          kind: 'class',
          package: pkgName,
          doc,
          sourceUrl: sourceUrl(node),
        };
      } else {
        continue;
      }
      break;
    }
  }
  return dict;
}

// ---- main ------------------------------------------------------------------

function generateTypedocJson(pkg) {
  const tmpOut = join(JSON_DIR, `.html-tmp-${pkg}`);
  execFileSync(
    'npx',
    [
      'typedoc',
      '--options',
      `typedoc.${pkg}.json`,
      '--json',
      join(JSON_DIR, `${pkg}.json`),
      '--out',
      tmpOut,
    ],
    { cwd: ROOT, stdio: 'pipe' },
  );
  rmSync(tmpOut, { recursive: true, force: true });
  return JSON.parse(readFileSync(join(JSON_DIR, `${pkg}.json`), 'utf8'));
}

mkdirSync(JSON_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const core = generateTypedocJson('core');
const charts = generateTypedocJson('charts');

const PACKAGES = [
  { json: core, pkgName: 'pond-ts' },
  { json: charts, pkgName: '@pond-ts/charts' },
];

// One JSON file per page, each carrying its own page-local hover dictionary —
// webpack then loads only the visited page's model, which matters once
// TimeSeries-scale pages exist.
let pageCount = 0;
function writePage(dir, slug, model) {
  const types = buildTypeDict(PACKAGES);
  mkdirSync(join(OUT_DIR, dir), { recursive: true });
  writeFileSync(
    join(OUT_DIR, dir, `${slug}.json`),
    JSON.stringify({ model, types }, null, 1),
  );
  pageCount += 1;
}

for (const { name, slug } of CORE_CLASSES) {
  referencedNames.clear();
  writePage('core', slug, distillClass(core, name, 'pond-ts'));
}
for (const entry of CHART_COMPONENTS) {
  referencedNames.clear();
  writePage(
    'charts',
    entry.slug,
    distillComponent(charts, entry, '@pond-ts/charts'),
  );
}

if (warnings.length) {
  console.error(`[api-model] ${warnings.length} type-printer failures:`);
  for (const w of [...new Set(warnings)]) console.error(`  - ${w}`);
  // Fail loudly: an unhandled type kind means a page would silently render
  // `unknown` where the source has a real type — same discipline as the
  // curation-map guard above.
  process.exit(1);
}
console.log(`[api-model] wrote ${pageCount} page model(s) to src/api-model/`);
