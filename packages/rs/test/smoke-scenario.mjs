// The work test/smoke.mjs runs in every place the package loads (Node, a
// browser page, a module worker, a Vite bundle): a little of each part of
// the API, returned as plain data so the runs can be compared. Takes the
// package's namespace; uses no Node or browser API.
export async function scenario(rs) {
  await rs.init();
  const out = { version: rs.version };

  const cpu = new rs.TimeSeries({
    name: 'cpu',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'value', kind: 'number' },
    ],
    rows: [
      [0, 0.31],
      [60_000, 0.44],
      [120_000, 0.52],
      [180_000, 0.4],
    ],
  });
  const buckets = cpu.aggregate(rs.Sequence.every('2m'), { value: 'avg' });
  out.aggregate = buckets.toJSON({ rowFormat: 'object' }).rows;
  const high = cpu.filter(rs.col('value').gt(0.35));
  out.filter = high.toJSON().rows;
  const fromFn = cpu.filter((e) => e.get('value') < 0.35);
  out.filterFn = fromFn.length;

  const sma = cpu.sma({ period: 2, column: 'value' });
  out.sma = sma.toJSON().rows;
  out.studies = rs.studies().length;

  const live = new rs.LiveSeries({
    name: 'live',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'cpu', kind: 'number' },
    ],
  });
  const perMinute = live.aggregate(rs.Sequence.every('1m'), { cpu: 'max' });
  const closed = [];
  const stop = perMinute.on('event', (bucket) =>
    closed.push(bucket.get('cpu')),
  );
  live.push([0, 0.31]);
  live.pushMany([
    [30_000, 0.44],
    [61_000, 0.52],
    [125_000, 0.1],
  ]);
  stop();
  out.live = { closed, length: live.length };

  for (const s of [cpu, buckets, high, fromFn, sma]) s.free();
  live.free();
  out.alive = rs.alive() + rs.livesAlive();
  return out;
}

export const expected = {
  aggregate: [
    { interval: { value: 0, start: 0, end: 120_000 }, value: 0.375 },
    { interval: { value: 120_000, start: 120_000, end: 240_000 }, value: 0.46 },
  ],
  filter: [
    [60_000, 0.44],
    [120_000, 0.52],
    [180_000, 0.4],
  ],
  filterFn: 1,
  sma: [
    [0, 0.31, null],
    [60_000, 0.44, 0.375],
    [120_000, 0.52, 0.48],
    [180_000, 0.4, 0.46],
  ],
  live: { closed: [0.44, 0.52], length: 4 },
  alive: 0,
};
