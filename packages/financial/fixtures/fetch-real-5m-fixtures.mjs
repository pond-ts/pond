import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ref = '6373dbe137d61aa2693a7a14ca980725eaa721d5';
const repo = 'imbue11235/stockhistory';
const base = `https://raw.githubusercontent.com/${repo}/${ref}`;

const sources = {
  spy10: [
    'data/SPY/2025-04-08.json',
    'data/SPY/2025-04-09.json',
    'data/SPY/2025-04-10.json',
    'data/SPY/2025-04-11.json',
    'data/SPY/2025-04-14.json',
    'data/SPY/2025-04-15.json',
    'data/SPY/2025-04-16.json',
    'data/SPY/2025-04-17.json',
    'data/SPY/2025-04-18.json',
    'data/SPY/2025-04-21.json',
  ],
  spyHalfDay: ['data/SPY/2024-12-02.json'],
};

function toCsv(rows) {
  return (
    [
      'symbol,timestamp,timezone,open,high,low,close,volume,source_path',
      ...rows.map((r) =>
        [
          r.symbol,
          r.timestamp,
          r.timezone,
          r.open,
          r.high,
          r.low,
          r.close,
          r.volume,
          r.sourcePath,
        ].join(','),
      ),
    ].join('\n') + '\n'
  );
}

function parseAlphaVantageJson(json, sourcePath) {
  const meta = json['Meta Data'] ?? {};
  const symbol = meta['2. Symbol'] ?? 'UNKNOWN';
  const timezone = meta['6. Time Zone'] ?? 'US/Eastern';
  const series = json['Time Series (5min)'] ?? {};

  return Object.entries(series).map(([timestamp, v]) => ({
    symbol,
    timestamp,
    timezone,
    open: Number(v['1. open']),
    high: Number(v['2. high']),
    low: Number(v['3. low']),
    close: Number(v['4. close']),
    volume: Number(v['5. volume']),
    sourcePath,
  }));
}

function regularSessionOnly(rows) {
  return rows.filter((r) => {
    const hhmm = r.timestamp.slice(11, 16);
    return hhmm >= '09:30' && hhmm <= '16:00';
  });
}

function byTimestampAsc(a, b) {
  return a.timestamp.localeCompare(b.timestamp);
}

async function fetchJson(sourcePath) {
  const url = `${base}/${sourcePath}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed ${response.status} ${response.statusText}: ${url}`);
  }

  return response.json();
}

async function load(paths) {
  const all = [];

  for (const sourcePath of paths) {
    const json = await fetchJson(sourcePath);
    all.push(...parseAlphaVantageJson(json, sourcePath));
  }

  return all.sort(byTimestampAsc);
}

const outDir = process.env.OUT_DIR ?? './market-fixtures';
await mkdir(outDir, { recursive: true });

const spy10All = await load(sources.spy10);

await writeFile(
  path.join(outDir, 'spy-10-sessions-5m-all.csv'),
  toCsv(spy10All),
);

await writeFile(
  path.join(outDir, 'spy-10-sessions-5m-regular.csv'),
  toCsv(regularSessionOnly(spy10All)),
);

const halfDayAll = await load(sources.spyHalfDay);
const halfDayRows = halfDayAll.filter((r) =>
  r.timestamp.startsWith('2024-11-29'),
);

await writeFile(
  path.join(outDir, 'spy-2024-11-29-halfday-5m-all.csv'),
  toCsv(halfDayRows),
);

await writeFile(
  path.join(outDir, 'spy-2024-11-29-halfday-5m-regular.csv'),
  toCsv(regularSessionOnly(halfDayRows)),
);

console.log(`Wrote fixtures to ${outDir}`);
console.log(`SPY 10-session all rows: ${spy10All.length}`);
console.log(
  `SPY 10-session regular rows: ${regularSessionOnly(spy10All).length}`,
);
console.log(`SPY half-day rows: ${halfDayRows.length}`);
