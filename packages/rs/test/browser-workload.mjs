// The calls test/browser.mjs runs both in Node and in Chromium, with the
// results compared as JSON text. Takes the package's namespace so the same
// code runs against either build.
export function workload(rs) {
  const out = {};
  const n = 500;
  const rows = [];
  // A small LCG, not Math.sin: V8 versions differ in the last bit of the
  // transcendental functions, and Node's and Chromium's V8 differ.
  let seed = 12345;
  const next = () => (seed = (seed * 48271) % 2147483647);
  for (let i = 0; i < n; i++) {
    const close = 100 + (next() / 2147483647) * 10 - 5 + i * 0.01;
    rows.push([
      i * 60_000,
      close,
      i % 3 === 0 ? 'a' : 'b',
      i % 5 === 0,
      i % 11 === 0 ? undefined : close * 2,
    ]);
  }
  const s = new rs.TimeSeries({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number' },
      { name: 'side', kind: 'string' },
      { name: 'flag', kind: 'boolean' },
      { name: 'other', kind: 'number', required: false },
    ],
    rows,
  });
  out.version = rs.version;
  out.length = s.length;

  const rolled = s.rolling('5m', { close: 'avg', other: 'max' });
  out.rolling = rolled.toJSON();
  const buckets = s.aggregate(rs.Sequence.every('15m'), {
    close: 'avg',
    side: 'last',
  });
  out.aggregate = buckets.toJSON({ rowFormat: 'object' });
  const filtered = s.filter(rs.col('close').gt(101));
  out.filtered = filtered.length;
  const rsi = s.rsi({ period: 14 });
  out.rsi = rsi.toJSON();
  const bands = s.study('bollinger', { period: 20 });
  out.bollinger = bands.toJSON();
  out.rowsArray = s.toJSON();
  out.rowsObject = s.toJSON({ rowFormat: 'object' });

  const live = new rs.LiveSeries({
    name: 'cpu',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
    ],
  });
  const avg = live.rolling('1m', { avg: { from: 'cpu', using: 'avg' } });
  const perMinute = live.aggregate(rs.Sequence.every('1m'), { cpu: 'max' });
  const seen = [];
  const stop = perMinute.on('event', (b) => seen.push(b.get('cpu')));
  live.push([0, 0.31]);
  live.pushMany([
    [30_000, 0.44],
    [61_000, 0.52],
    [125_000, 0.12],
  ]);
  out.live = { avg: avg.value(), closedBuckets: seen, length: live.length };
  stop();

  for (const x of [s, rolled, buckets, filtered, rsi, bands]) x.free();
  live.free();
  out.alive = rs.alive();
  return out;
}
