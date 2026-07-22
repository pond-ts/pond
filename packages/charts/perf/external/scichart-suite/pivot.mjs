import { readFileSync } from 'node:fs';
const R = JSON.parse(readFileSync('./suite-results.json', 'utf8'));
const GROUPS = {
  1: 'N line series x M points',
  2: 'Brownian scatter (unsorted x)',
  3: 'Unsorted XY line',
  4: 'Point series, sorted, y-update',
  5: 'Column ascending x',
  6: 'Candlestick',
  7: 'FIFO / ECG streaming (5 series)',
  8: 'Mountain (area)',
  9: 'Series compression (append)',
  10: 'Multi-chart',
};
const LIBS = ['scichart', 'pond', 'uplot', 'chartjs'];
console.log('GPU:', R.__gpu, '\n');
for (const [gid, gname] of Object.entries(GROUPS)) {
  const rowsByPoints = new Map();
  for (const lib of LIBS) {
    const g = R[lib]?.[gid];
    if (!Array.isArray(g)) continue;
    for (const r of g) {
      const key = `${r.points}|${r.series}|${r.charts ?? ''}`;
      if (!rowsByPoints.has(key))
        rowsByPoints.set(key, {
          points: r.points,
          series: r.series,
          charts: r.charts,
        });
      rowsByPoints.get(key)[lib] = r.status === 'OK' ? r.avgFPS : r.status;
    }
  }
  if (!rowsByPoints.size) continue;
  console.log(`## ${gid}. ${gname}`);
  console.log(`| points | series |`, LIBS.map((l) => ` ${l} `).join('|'), '|');
  for (const row of rowsByPoints.values()) {
    const cells = LIBS.map((l) => {
      const v = row[l];
      if (v === undefined) return '—';
      return typeof v === 'number' ? v.toFixed(1) : v.toLowerCase();
    });
    console.log(
      `| ${row.points.toLocaleString()} | ${row.series}${row.charts ? ` ×${row.charts}ch` : ''} | ${cells.join(' | ')} |`,
    );
  }
  console.log('');
}
