/**
 * Runs the code on the @pond-ts/fit pages and checks what it prints.
 *
 *   cd website
 *   node --experimental-strip-types scripts/check-fit-guides.mts [--write] [--no-python] [page …]
 *
 * For each `.mdx` page under `docs/fit/`, every ```ts block is joined, in
 * order, into one module and run with Node; every ```python block is joined
 * into one script and run with Python (`POND_PYTHON`, default `python3`,
 * which needs `pond_rs` and `polars`). Both run in `static/data/fit/`, where
 * the example files are, so a page reads `hill-ride.fit` or
 * `hill-ride.csv` by name.
 *
 * A ```text block whose meta says `output` is what the code block just above
 * it prints, and must match it exactly. So every number a page shows comes
 * from running the page.
 *
 * The blocks of one page share one scope, like cells of a notebook: a later
 * block uses what an earlier one made. A block whose meta says `norun` is
 * shown but not run (a fragment, an install line). Imports repeated across a
 * page's blocks are merged.
 *
 * Also checks the fixtures: reading each `.fit` file gives the same activity
 * as the model in `src/examples/lib/fit-fixtures.ts` that the live charts
 * use.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = fileURLToPath(new URL('..', import.meta.url));
const DOCS = join(SITE, 'docs/fit');
const DATA = join(SITE, 'static/data/fit');
const TMP = join(SITE, 'scripts/.fit-guides-tmp');
const PYTHON = process.env.POND_PYTHON ?? 'python3';
const MARK = '@@pond-block@@';
/** The TypeScript modules written, type-checked together at the end. */
const tsFiles: string[] = [];

interface Block {
  lang: string;
  meta: string;
  code: string;
  line: number;
  /** The expected output, from a ```text output block right after it. */
  output?: string;
}

function blocksOf(text: string): Block[] {
  const out: Block[] = [];
  const re = /^([ \t]*)```(\w*)([^\n]*)\n([\s\S]*?)^\1```[ \t]*$/gm;
  let m: RegExpExecArray | null;
  let last: Block | undefined;
  while ((m = re.exec(text))) {
    const [, indent, lang, meta, body] = m;
    const code = body!
      .split('\n')
      .map((l) => (l.startsWith(indent!) ? l.slice(indent!.length) : l))
      .join('\n');
    const line = text.slice(0, m.index).split('\n').length;
    if (lang === 'text' && /\boutput\b/.test(meta!)) {
      if (!last)
        throw new Error(`line ${line}: an output block with no code above it`);
      last.output = code;
      continue;
    }
    const block = { lang: lang!, meta: meta!, code, line };
    out.push(block);
    last = block;
  }
  return out;
}

/** Merge `import { a } from 'x'` lines across blocks, so a page can repeat
 *  an import in each block (each block reads on its own). */
function hoistImports(blocks: Block[]): { imports: string; bodies: string[] } {
  const named = new Map<string, Set<string>>();
  const typeNamed = new Map<string, Set<string>>();
  const other = new Set<string>();
  const re = /^import\s+(type\s+)?([\s\S]*?)\s+from\s+'([^']+)';?[ \t]*$/gm;
  const bodies = blocks.map((b) =>
    b.code.replace(
      re,
      (_all, isType: string | undefined, what: string, from: string) => {
        const braces = /^\{([\s\S]*)\}$/.exec(what.trim());
        if (braces) {
          const target = isType ? typeNamed : named;
          const set = target.get(from) ?? new Set<string>();
          for (const n of braces[1]!.split(','))
            if (n.trim()) set.add(n.trim());
          target.set(from, set);
        } else {
          other.add(`import ${isType ?? ''}${what} from '${from}';`);
        }
        return '';
      },
    ),
  );
  const lines = [...other];
  for (const [from, set] of named)
    lines.push(`import { ${[...set].join(', ')} } from '${from}';`);
  for (const [from, set] of typeNamed)
    lines.push(`import type { ${[...set].join(', ')} } from '${from}';`);
  return { imports: lines.join('\n'), bodies };
}

function run(lang: 'ts' | 'python', blocks: Block[], page: string): string[] {
  mkdirSync(TMP, { recursive: true });
  const base = page.replace(/[^\w]+/g, '-');
  if (lang === 'ts') {
    const { imports, bodies } = hoistImports(blocks);
    const src =
      imports +
      '\n' +
      bodies
        .map((b) => `console.log(${JSON.stringify(MARK)});\n${b}`)
        .join('\n') +
      '\nexport {};\n';
    const file = join(TMP, `${base}.mts`);
    writeFileSync(file, src);
    tsFiles.push(file);
    return split(
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', '--no-warnings', file],
        { cwd: DATA, encoding: 'utf8' },
      ),
    );
  }
  const src = blocks
    .map((b) => `print(${JSON.stringify(MARK)})\n${b.code}`)
    .join('\n');
  const file = join(TMP, `${base}.py`);
  writeFileSync(file, src);
  return split(
    execFileSync(PYTHON, ['-I', file], { cwd: DATA, encoding: 'utf8' }),
  );
}

function split(stdout: string): string[] {
  return stdout.split(MARK + '\n').slice(1);
}

const norm = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '');

function pages(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.mdx')) out.push(p);
    }
  };
  walk(DOCS);
  return out.sort();
}

let failures = 0;
const write = process.argv.includes('--write');
// --no-python: TypeScript only, for CI, which has no pond_rs build.
const noPython = process.argv.includes('--no-python');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
for (const file of pages()) {
  const page = relative(DOCS, file);
  if (only.length && !only.some((o) => page.includes(o))) continue;
  const text = readFileSync(file, 'utf8');
  const blocks = blocksOf(text).filter((b) => !/\bnorun\b/.test(b.meta));
  /** What each block printed, by its line, for --write. */
  const printed = new Map<number, string>();
  for (const lang of noPython
    ? (['ts'] as const)
    : (['ts', 'python'] as const)) {
    const mine = blocks.filter((b) => b.lang === lang);
    if (!mine.length) continue;
    let outs: string[];
    try {
      outs = run(lang, mine, page);
    } catch (e) {
      failures++;
      const err = e as { stderr?: string; message: string };
      console.error(
        `✗ ${page} (${lang}) failed to run:\n${err.stderr ?? err.message}`,
      );
      continue;
    }
    let ok = true;
    mine.forEach((b, i) => {
      if (b.output === undefined) return;
      const got = norm(outs[i] ?? '');
      printed.set(b.line, got);
      if (write) return;
      const want = norm(b.output);
      if (got !== want) {
        ok = false;
        failures++;
        console.error(
          `✗ ${page}:${b.line} (${lang}) printed\n${got}\n— but the page shows\n${want}\n`,
        );
      }
    });
    if (ok) console.log(`✓ ${page} (${lang}, ${mine.length} blocks)`);
  }
  if (write && printed.size) writeFileSync(file, fillOutputs(text, printed));
}

/** The page with each output block replaced by what its code printed. */
function fillOutputs(text: string, printed: Map<number, string>): string {
  const re = /^([ \t]*)```(\w*)([^\n]*)\n([\s\S]*?)^\1```[ \t]*$/gm;
  let lastLine = -1;
  return text.replace(
    re,
    (all, indent: string, lang: string, meta: string, _b, offset: number) => {
      const line = text.slice(0, offset).split('\n').length;
      if (lang === 'text' && /\boutput\b/.test(meta)) {
        const got = printed.get(lastLine);
        if (got === undefined) return all;
        const body = got
          .split('\n')
          .map((l) => (l ? indent + l : l))
          .join('\n');
        return `${indent}\`\`\`${lang}${meta}\n${body}\n${indent}\`\`\``;
      }
      lastLine = line;
      return all;
    },
  );
}

type Track = ReturnType<
  ReturnType<typeof import('@pond-ts/fit').Activity.from>['toSeries']
>;
const CHANNELS = ['lat', 'lng', 'ele', 'hr', 'power', 'cadence', 'distance'];
const columnOf = (t: Track, name: string) =>
  (t.column(name as 'lat')?.toFloat64Array() ?? null) as Float64Array | null;
const same = (x: number, y: number, tol: number) =>
  (Number.isNaN(x) && Number.isNaN(y)) || Math.abs(x - y) <= tol;

// The live charts use the model; the code reads the files. They must agree.
{
  const { Activity } = await import('@pond-ts/fit');
  const { readActivity } = await import('@pond-ts/fit/files');
  const fx = await import('../src/examples/lib/fit-fixtures.ts');
  const pairs = [
    ['hill-ride', fx.hillRide],
    ['interval-run', fx.intervalRun],
    ['pool-swim', fx.poolSwim],
  ] as const;
  for (const [slug, make] of pairs) {
    const a = readActivity(readFileSync(join(DATA, `${slug}.fit`)));
    const b = Activity.from(make());
    const view = (x: ReturnType<typeof Activity.from>) =>
      JSON.stringify([
        x.sport,
        x.stats(),
        x.stats({ time: 'moving' }),
        x.laps.length,
      ]);
    if (view(a) !== view(b) || sampleDiff(a.toSeries(), b.toSeries())) {
      failures++;
      console.error(`✗ ${slug}.fit doesn't match the model in fit-fixtures.ts`);
    } else console.log(`✓ ${slug}.fit matches the model`);

    // The Python reads the CSV: every row must be the model's sample.
    const csvProblem = csvDiff(join(DATA, `${slug}.csv`), b.toSeries());
    if (csvProblem) {
      failures++;
      console.error(`✗ ${slug}.csv doesn't match the model: ${csvProblem}`);
    } else console.log(`✓ ${slug}.csv matches the model`);
  }
}

/** First difference between two tracks' samples, or '' when they agree. */
function sampleDiff(a: Track, b: Track): string {
  const ta = a.keyColumn().begin;
  const tb = b.keyColumn().begin;
  if (ta.length !== tb.length) return `${ta.length} vs ${tb.length} samples`;
  for (let i = 0; i < ta.length; i++)
    if (ta[i] !== tb[i]) return `time of sample ${i}`;
  for (const name of CHANNELS) {
    const x = columnOf(a, name);
    const y = columnOf(b, name);
    if (!x && !y) continue;
    if (!x || !y) return `${name} present in only one`;
    for (let i = 0; i < x.length; i++)
      if (!same(x[i]!, y[i]!, 1e-9)) return `${name} at sample ${i}`;
  }
  return '';
}

/** First difference between a CSV and the model's samples, or ''. */
function csvDiff(path: string, model: Track): string {
  const [header, ...rows] = readFileSync(path, 'utf8').trim().split('\n');
  const names = header!.split(',');
  const toModel: Record<string, string> = {
    altitude_m: 'ele',
    heart_rate: 'hr',
    distance_m: 'distance',
  };
  const times = model.keyColumn().begin;
  if (rows.length !== times.length)
    return `${rows.length} rows vs ${times.length} samples`;
  const cols = names.map((n) =>
    n === 'time' ? null : columnOf(model, toModel[n] ?? n),
  );
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r]!.split(',');
    if (Date.parse(cells[0]!) !== times[r]) return `time on row ${r + 1}`;
    for (let c = 1; c < names.length; c++) {
      const col = cols[c];
      if (!col) return `no model column for ${names[c]}`;
      const v = cells[c] === '' ? NaN : Number(cells[c]);
      // lat/lng are written to 9 decimals
      const tol = names[c] === 'lat' || names[c] === 'lng' ? 1e-9 : 1e-6;
      if (!same(v, col[r]!, tol)) return `${names[c]} on row ${r + 1}`;
    }
  }
  return '';
}

// The TypeScript must also type-check, as a reader's editor would check it.
if (tsFiles.length) {
  try {
    execFileSync(
      process.execPath,
      [
        join(SITE, 'node_modules/typescript/bin/tsc'),
        '--ignoreConfig',
        '--noEmit',
        '--strict',
        '--target',
        'es2022',
        '--module',
        'nodenext',
        '--moduleResolution',
        'nodenext',
        '--skipLibCheck',
        '--types',
        'node',
        ...tsFiles,
      ],
      { cwd: SITE, encoding: 'utf8' },
    );
    console.log(`✓ ${tsFiles.length} page(s) type-check`);
  } catch (e) {
    failures++;
    const err = e as { stdout?: string; message: string };
    console.error(`✗ type errors:\n${err.stdout ?? err.message}`);
  }
}

rmSync(TMP, { recursive: true, force: true });
if (failures) {
  console.error(`\n${failures} problem(s)`);
  process.exit(1);
}
