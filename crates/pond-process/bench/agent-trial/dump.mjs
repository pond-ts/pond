/**
 * Writes what the trial needs from the TypeScript side into `<dir>`:
 * `data.csv` (the market workload's 2,520 bars, for truth.py only; the
 * agents never see it) and `ops.json` (the registry's describe(), the
 * catalog the agents compose against). `node dump.mjs <dir>`.
 */
import { writeFileSync } from 'node:fs';
import * as proc from '@pond-ts/process';
import { studyOps } from '../../../../packages/financial/dist/process/index.js';
import { COLUMNS } from '../../../../packages/financial/scripts/measure/workloads.mjs';

const dir = process.argv[2];
const c = COLUMNS.market(2520);
const names = Object.keys(c);
const lines = [names.join(',')];
for (let i = 0; i < c.time.length; i += 1)
  lines.push(names.map((n) => c[n][i]).join(','));
writeFileSync(`${dir}/data.csv`, lines.join('\n') + '\n');

let registry = proc.createRegistry();
for (const def of [...proc.BASIC_OPS, ...proc.SUMMARY_FOLDS, ...studyOps()])
  registry = registry.define(def);
writeFileSync(`${dir}/ops.json`, JSON.stringify(registry.describe(), null, 1));
