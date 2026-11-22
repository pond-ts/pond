// Writes the study block of index.d.ts (between `@generated-begin` and
// `@generated-end`) from the study catalog: one options type per study,
// from its descriptor's inputs, params, naming and anchor.
//
//   node scripts/types.mjs           (after ./build.sh) rewrites the block
//   node scripts/types.mjs --check   fails if the block is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { studies } from '../index.js';

const FILE = fileURLToPath(new URL('../index.d.ts', import.meta.url));
const BEGIN = '// @generated-begin\n';
const END = '// @generated-end\n';

const quote = (s) => `'${s}'`;
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k));

function paramType(p) {
  if (p.kind === 'enum') return p.of.map(quote).join(' | ');
  return 'number';
}

function optionsType(d) {
  const fields = [];
  for (const input of d.inputs) {
    const required = input.default === undefined;
    fields.push(
      `    /** Column read as ${input.role}${required ? '' : ` (default ${quote(input.default)})`}. */\n` +
        `    readonly ${key(input.role)}${required ? '' : '?'}: string;`,
    );
  }
  for (const [name, p] of Object.entries(d.params)) {
    const required = p.default === undefined && !p.optional;
    const notes = [];
    if (p.default !== undefined)
      notes.push(`default ${JSON.stringify(p.default)}`);
    if (p.min !== undefined) notes.push(`at least ${p.min}`);
    if (p.max !== undefined) notes.push(`at most ${p.max}`);
    if (p.requires !== undefined) notes.push(`needs ${p.requires}`);
    if (p.kind === 'integer') notes.push('a whole number');
    fields.push(
      (notes.length ? `    /** ${notes.join('; ')}. */\n` : '') +
        `    readonly ${key(name)}${required ? '' : '?'}: ${paramType(p)};`,
    );
  }
  const naming = d.naming.kind;
  fields.push(
    `    /** The ${naming === 'output' ? 'output column' : "output columns' prefix"} (default ${quote(d.naming.default)}). */\n` +
      `    readonly ${naming}?: string;`,
  );
  if (d.anchor === 'time')
    fields.push(
      '    /** The bar to start from: a time in ms, or a `Date`. */\n' +
        '    readonly anchor: number | Date;',
    );
  const body = `{\n${fields.join('\n')}\n  }`;
  return d.anchor === 'session' ? `${body} & SessionAnchor` : body;
}

export function generate() {
  const list = studies();
  const lines = [
    '',
    '/** Every study in the catalog, by name. */',
    `export type StudyName =\n${list.map((d) => `  | ${quote(d.name)}`).join('\n')};`,
    '',
    "/** Each study's options, as `@pond-ts/financial`'s. */",
    'export interface StudyOptions {',
    ...list.map(
      (d) =>
        `  /** ${d.summary.replace(/\*\//g, '*\\/')}. */\n  ${key(d.name)}: ${optionsType(d)};`,
    ),
    '}',
    '',
    "/** A study's options argument: optional when every option has a default. */",
    'export type StudyOptionsArg<N extends StudyName> = {} extends StudyOptions[N]',
    '  ? [options?: StudyOptions[N]]',
    '  : [options: StudyOptions[N]];',
    '',
  ];
  return lines.join('\n');
}

const text = readFileSync(FILE, 'utf8');
const at = text.indexOf(BEGIN);
const to = text.indexOf(END);
if (at < 0 || to < at) throw new Error('index.d.ts: no @generated block');
// The whole file as prettier writes it, so the check agrees with the
// repo's formatting.
const fresh = await prettier.format(
  text.slice(0, at + BEGIN.length) + generate() + text.slice(to),
  { ...(await prettier.resolveConfig(FILE)), filepath: FILE },
);
if (process.argv.includes('--check')) {
  if (fresh !== text) {
    console.error(
      'index.d.ts: the study block is stale; run node scripts/types.mjs',
    );
    process.exit(1);
  }
  console.log('index.d.ts: study block up to date');
} else {
  writeFileSync(FILE, fresh);
  console.log(`index.d.ts: wrote options for ${studies().length} studies`);
}
