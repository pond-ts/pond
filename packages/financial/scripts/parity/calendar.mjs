/**
 * Calendar parity fixture: what `@pond-ts/financial`'s trading calendar
 * returns for a fixed set of calls, as language-neutral JSON, so pond-rs can
 * check its calendar gives the same sessions, lookups and tags.
 *
 * `buildCalendarFixture(pond, financial)` runs against the compiled packages
 * (`generate.mjs`, which writes `test/fixtures/calendar-parity.json`) and
 * against source (`test/calendar-parity.test.ts`, which fails if the
 * committed file is stale).
 *
 * Case kinds, each with `expected` or `error` (`{ name, message }`):
 * - `generate`: `generateSessions(rules, { from, to })` → sessions. Also
 *   records `calendar`: whether `TradingCalendar.fromRules` over the same
 *   range accepts them (`true`) or its error.
 * - `sessions`: `normalizeSessions(sessions)` → sessions.
 * - `queries`: a calendar (from `rules` + range, or `sessions`), then
 *   `queries`, each `{ call, arg, result }`. A session result is its date
 *   (or `null`); `sessionsInRange` gives a list of dates.
 * - `tag`: `calendar.tagSessions(series, options)` on a time-keyed series
 *   with a `close` column → the session ids (`null` in closed time).
 *
 * A session is `{ date, open, close, breaks: [{ start, end }] }`; a session
 * pond-ts gives no `breaks` is written with `breaks: []`.
 */

const NYSE_2024 = {
  timeZone: 'America/New_York',
  open: '09:30',
  close: '16:00',
  holidays: [
    '2024-01-01',
    '2024-01-15',
    '2024-02-19',
    '2024-03-29',
    '2024-05-27',
    '2024-06-19',
    '2024-07-04',
    '2024-09-02',
    '2024-11-28',
    '2024-12-25',
  ],
  earlyCloses: [
    { date: '2024-07-03', close: '13:00' },
    { date: '2024-11-29', close: '13:00' },
    { date: '2024-12-24', close: '13:00' },
  ],
};

const TOKYO = {
  timeZone: 'Asia/Tokyo',
  open: '09:00',
  close: '15:00',
  breaks: [{ start: '11:30', end: '12:30' }],
  holidays: ['2024-01-08'],
  earlyCloses: [
    { date: '2024-01-10', close: '11:00' }, // closes before the break
    { date: '2024-01-11', close: '12:00' }, // closes inside it: dropped
    { date: '2024-01-12', close: '12:30' }, // closes as it ends: kept
  ],
};

const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

function generateCases() {
  const out = [];
  const add = (name, rules, from, to) =>
    out.push({ kind: 'generate', name, rules, from, to });

  add('nyse 2024 (both clock changes)', NYSE_2024, '2024-01-01', '2024-12-31');
  add('nyse 2005-2010 (US rule change)', NYSE_2024, '2005-01-01', '2010-12-31');
  add('tokyo lunch break, early closes', TOKYO, '2024-01-05', '2024-01-16');
  add(
    'london clock change',
    { timeZone: 'Europe/London', open: '08:00', close: '16:30' },
    '2024-03-25',
    '2024-04-05',
  );
  add(
    'sydney, both changes',
    { timeZone: 'Australia/Sydney', open: '10:00', close: '16:00' },
    '2024-04-01',
    '2024-10-10',
  );
  add(
    'kolkata half-hour offset',
    { timeZone: 'Asia/Kolkata', open: '09:15', close: '15:30' },
    '2024-01-08',
    '2024-01-12',
  );
  // The open falls in the skipped hour: it moves forward by an hour and
  // meets the close, which the calendar then refuses.
  add(
    'open in a skipped hour',
    {
      timeZone: 'America/New_York',
      open: '02:30',
      close: '03:30',
      weekmask: EVERY_DAY,
    },
    '2024-03-09',
    '2024-03-11',
  );
  add(
    'times in a repeated hour',
    {
      timeZone: 'America/New_York',
      open: '01:00',
      close: '01:45',
      breaks: [{ start: '01:15', end: '01:30' }],
      weekmask: EVERY_DAY,
    },
    '2024-11-02',
    '2024-11-04',
  );
  add(
    'close 24:00 before a skipped midnight',
    {
      timeZone: 'America/Sao_Paulo',
      open: '20:00',
      close: '24:00',
      weekmask: EVERY_DAY,
    },
    '2018-11-02',
    '2018-11-05',
  );
  add(
    'open at a skipped midnight',
    {
      timeZone: 'America/Sao_Paulo',
      open: '00:00',
      close: '24:00',
      weekmask: EVERY_DAY,
    },
    '2018-11-03',
    '2018-11-05',
  );
  add(
    'a day that never happened',
    {
      timeZone: 'Pacific/Apia',
      open: '09:00',
      close: '17:00',
      weekmask: EVERY_DAY,
    },
    '2011-12-28',
    '2011-12-31',
  );
  for (const zone of [
    'UTC',
    'utc',
    'america/new_york',
    'US/Eastern',
    'EST',
    'Etc/GMT+5',
    '+05:30',
    '-03:00',
  ]) {
    add(
      `zone ${zone}`,
      { timeZone: zone, open: '09:30', close: '16:00' },
      '2024-03-08',
      '2024-03-11',
    );
  }
  const plain = { timeZone: 'America/New_York', open: '09:30', close: '16:00' };
  const nowhere = { ...plain, timeZone: 'Nowhere/Zone' };
  add('unknown zone, weekend only', nowhere, '2024-01-06', '2024-01-07');
  add('unknown zone', nowhere, '2024-01-06', '2024-01-08');
  add('unknown zone, instant bound', nowhere, 0, '2024-01-08');

  // Range bounds: the date forms Temporal's PlainDate.from reads, instants
  // (read as the local date in the zone), and bad ranges.
  for (const bound of [
    '20240108',
    '2024-01-08T23:59',
    '2024-01-08 10:00',
    '2024-01-08t10:00',
    '+002024-01-08',
    '2024-01-08[u-ca=iso8601]',
    '2024-01-08T10:00+05:00',
    '2024-01-08T10:00+05:00[Asia/Kolkata]',
    '2024-01-08Z',
    '2024-1-8',
    '2024-01',
    '2024-02-30',
    ' 2024-01-08',
    '',
  ]) {
    add(`from ${JSON.stringify(bound)}`, plain, bound, '2024-01-09');
  }
  add(
    'instant bounds',
    plain,
    Date.UTC(2024, 0, 9, 3),
    Date.UTC(2024, 0, 10, 5),
  );
  add('instant before 1970', plain, Date.UTC(1969, 11, 30), '1970-01-02');
  add('one day', plain, '2024-01-08', '2024-01-08');
  add('to before from', plain, '2024-01-09', '2024-01-08');

  // Hours.
  for (const [open, close] of [
    ['00:00', '24:00'],
    ['9:30', '16:00'],
    ['09:30', '16:0'],
    ['09:60', '16:00'],
    ['99:99', '16:00'],
    ['09:30', '24:01'],
    ['09:30', '25:00'],
    ['16:00', '16:00'],
    ['16:00', '09:30'],
    ['24:00', '24:00'],
    ['０9:30', '16:00'],
  ]) {
    add(
      `hours ${open}-${close}`,
      { ...plain, open, close },
      '2024-01-08',
      '2024-01-09',
    );
  }

  // Breaks.
  for (const [label, breaks] of [
    [
      'two, given out of order',
      [
        { start: '13:00', end: '13:30' },
        { start: '11:30', end: '12:00' },
      ],
    ],
    [
      'touching each other and the open',
      [
        { start: '09:30', end: '10:00' },
        { start: '10:00', end: '10:30' },
      ],
    ],
    ['ending at the close', [{ start: '15:00', end: '16:00' }]],
    [
      'overlapping',
      [
        { start: '11:00', end: '12:00' },
        { start: '11:30', end: '12:30' },
      ],
    ],
    ['before the open', [{ start: '09:00', end: '10:00' }]],
    ['after the close', [{ start: '15:30', end: '16:30' }]],
    ['backwards', [{ start: '12:00', end: '11:00' }]],
    ['empty', [{ start: '12:00', end: '12:00' }]],
    ['bad time', [{ start: '12:00', end: 'noon' }]],
  ]) {
    add(`breaks ${label}`, { ...plain, breaks }, '2024-01-08', '2024-01-09');
  }

  // Weekmasks, holidays, early closes.
  for (const weekmask of [[], [6, 7], [0, 8], [3, 3], [7, 1]]) {
    add(
      `weekmask ${JSON.stringify(weekmask)}`,
      { ...plain, weekmask },
      '2024-01-05',
      '2024-01-15',
    );
  }
  add(
    'holidays not ISO',
    { ...plain, holidays: ['2024-1-8', '20240109', '2024-01-10'] },
    '2024-01-08',
    '2024-01-11',
  );
  for (const [label, earlyCloses] of [
    ['later than the regular close', [{ date: '2024-01-08', close: '18:00' }]],
    [
      'repeated date, later wins',
      [
        { date: '2024-01-08', close: '12:00' },
        { date: '2024-01-08', close: '13:00' },
      ],
    ],
    ['at the open', [{ date: '2024-01-08', close: '09:30' }]],
    ['bad time on a trading day', [{ date: '2024-01-08', close: 'early' }]],
    ['bad time on a weekend', [{ date: '2024-01-06', close: 'early' }]],
    ['bad time on a holiday', [{ date: '2024-01-15', close: 'early' }]],
    ['24:00', [{ date: '2024-01-08', close: '24:00' }]],
  ]) {
    add(
      `early close ${label}`,
      { ...plain, holidays: ['2024-01-15'], earlyCloses },
      '2024-01-05',
      '2024-01-16',
    );
  }
  return out;
}

const day = (date, open, close, breaks) =>
  breaks === undefined ? { date, open, close } : { date, open, close, breaks };

function sessionCases() {
  const out = [];
  const add = (name, sessions) =>
    out.push({ kind: 'sessions', name, sessions });
  add('empty', []);
  add('sorted by open', [
    day('2024-01-10', 500, 600),
    day('2024-01-08', 100, 200),
    day('2024-01-09', 300, 400),
  ]);
  add('touching sessions', [
    day('2024-01-08', 100, 200),
    day('2024-01-09', 200, 300),
  ]);
  add('breaks touching the open, each other and the close', [
    day('2024-01-08', 100, 200, [
      { start: 100, end: 120 },
      { start: 120, end: 150 },
      { start: 180, end: 200 },
    ]),
  ]);
  add('empty breaks list', [day('2024-01-08', 100, 200, [])]);
  add('negative instants', [
    day('1969-12-30', -500, -100),
    day('1969-12-31', -50, 50),
  ]);
  for (const date of [
    '2024-1-08',
    '2024-01-08x',
    '24-01-08',
    '',
    '２024-01-08',
    '2024/01/08',
  ]) {
    add(`date ${JSON.stringify(date)}`, [day(date, 100, 200)]);
  }
  add('the bad date is found before a bad close', [
    day('2024-01-09', 300, 300),
    day('bad', 100, 200),
  ]);
  add('close at the open', [day('2024-01-08', 100, 100)]);
  add('close before the open', [day('2024-01-08', 100, 50)]);
  add('break backwards', [
    day('2024-01-08', 100, 200, [{ start: 150, end: 140 }]),
  ]);
  add('break empty', [day('2024-01-08', 100, 200, [{ start: 150, end: 150 }])]);
  add('break before the open', [
    day('2024-01-08', 100, 200, [{ start: 90, end: 110 }]),
  ]);
  add('break past the close', [
    day('2024-01-08', 100, 200, [{ start: 190, end: 210 }]),
  ]);
  add('breaks out of order', [
    day('2024-01-08', 100, 200, [
      { start: 150, end: 160 },
      { start: 120, end: 130 },
    ]),
  ]);
  add('breaks overlapping', [
    day('2024-01-08', 100, 200, [
      { start: 120, end: 140 },
      { start: 130, end: 150 },
    ]),
  ]);
  add('duplicate date', [
    day('2024-01-08', 100, 200),
    day('2024-01-08', 300, 400),
  ]);
  add('overlapping', [
    day('2024-01-08', 100, 200),
    day('2024-01-09', 150, 250),
  ]);
  add('dates out of order with opens', [
    day('2024-01-09', 100, 200),
    day('2024-01-08', 300, 400),
  ]);
  add('same open: an overlap, not a duplicate', [
    day('2024-01-08', 100, 200),
    day('2024-01-09', 100, 150),
  ]);
  return out;
}

// Instants around every edge of the calendar's sessions and breaks.
function edgeInstants(sessions) {
  const set = new Set([-1e13, 0, 1e13]);
  for (const s of sessions) {
    for (const t of [
      s.open,
      s.close,
      ...(s.breaks ?? []).flatMap((b) => [b.start, b.end]),
    ]) {
      set.add(t - 1);
      set.add(t);
      set.add(t + 1);
    }
    set.add(Math.floor((s.open + s.close) / 2));
  }
  return [...set].sort((a, b) => a - b);
}

function queryCases() {
  return [
    {
      kind: 'queries',
      name: 'nyse january',
      rules: NYSE_2024,
      from: '2024-01-01',
      to: '2024-01-31',
    },
    {
      kind: 'queries',
      name: 'tokyo',
      rules: TOKYO,
      from: '2024-01-05',
      to: '2024-01-16',
    },
    {
      kind: 'queries',
      name: 'hand-written',
      sessions: [
        day('2024-01-08', 100, 200, [{ start: 120, end: 130 }]),
        day('2024-01-09', 200, 300),
        day('2024-01-11', 500, 600),
      ],
    },
    { kind: 'queries', name: 'empty', sessions: [] },
  ];
}

function tagCases() {
  const sessions = [
    day('2024-01-08', 100, 200, [{ start: 120, end: 130 }]),
    day('2024-01-09', 200, 300),
    day('2024-01-11', 500, 600),
  ];
  const keys = [
    0, 99, 100, 100, 101, 125, 199, 200, 200, 201, 299, 300, 301, 450, 500, 600,
    700,
  ];
  const out = [];
  for (const stamped of [undefined, 'open', 'close']) {
    out.push({
      kind: 'tag',
      name: `stamped ${stamped}`,
      sessions,
      keys,
      options: stamped ? { stamped } : {},
    });
  }
  out.push({
    kind: 'tag',
    name: 'column name',
    sessions,
    keys,
    options: { column: 'sid' },
  });
  out.push({
    kind: 'tag',
    name: 'column exists',
    sessions,
    keys,
    options: { column: 'close' },
  });
  out.push({
    kind: 'tag',
    name: 'key name',
    sessions,
    keys,
    options: { column: 'time' },
  });
  out.push({
    kind: 'tag',
    name: 'empty series',
    sessions,
    keys: [],
    options: {},
  });
  out.push({
    kind: 'tag',
    name: 'empty calendar',
    sessions: [],
    keys,
    options: {},
  });
  return out;
}

function plainSession(s) {
  return {
    date: s.date,
    open: s.open,
    close: s.close,
    breaks: (s.breaks ?? []).map((b) => ({ start: b.start, end: b.end })),
  };
}

function caught(fn) {
  try {
    return { expected: fn() };
  } catch (e) {
    return { error: { name: e.name, message: e.message } };
  }
}

function runQueries(financial, c) {
  const { TradingCalendar } = financial;
  const cal = c.rules
    ? TradingCalendar.fromRules(c.rules, { from: c.from, to: c.to })
    : TradingCalendar.fromSessions(c.sessions);
  const sessions = cal.sessions();
  const dateOf = (s) => (s === undefined ? null : s.date);
  const instants = edgeInstants(sessions);
  const dates = [
    ...sessions.map((s) => s.date),
    '',
    '2023-12-31',
    '2024-01-07',
    '2024-01-10',
    '2024-01-15',
    '2024-01-08x',
    '2099-01-01',
    '9999-99-99',
  ];
  const queries = [{ call: 'length', arg: null, result: cal.length }];
  for (const d of dates) {
    queries.push({
      call: 'sessionOn',
      arg: d,
      result: dateOf(cal.sessionOn(d)),
    });
    queries.push({ call: 'isTradingDay', arg: d, result: cal.isTradingDay(d) });
    queries.push({
      call: 'nextSession',
      arg: d,
      result: dateOf(cal.nextSession(d)),
    });
    queries.push({
      call: 'previousSession',
      arg: d,
      result: dateOf(cal.previousSession(d)),
    });
  }
  for (const t of instants) {
    queries.push({
      call: 'sessionContaining',
      arg: t,
      result: dateOf(cal.sessionContaining(t)),
    });
    queries.push({ call: 'isOpen', arg: t, result: cal.isOpen(t) });
    queries.push({
      call: 'nextSession',
      arg: t,
      result: dateOf(cal.nextSession(t)),
    });
    queries.push({
      call: 'previousSession',
      arg: t,
      result: dateOf(cal.previousSession(t)),
    });
  }
  // Ranges between pairs of edge instants (a sample, both orders).
  const step = Math.max(1, Math.floor(instants.length / 40));
  for (let i = 0; i < instants.length; i += step) {
    for (let j = 0; j < instants.length; j += step * 3) {
      const range = { start: instants[i], end: instants[j] };
      queries.push({
        call: 'sessionsInRange',
        arg: range,
        result: cal.sessionsInRange(range).map((s) => s.date),
      });
    }
  }
  return { sessions: sessions.map(plainSession), queries };
}

function runTag(pond, financial, c) {
  const cal = financial.TradingCalendar.fromSessions(c.sessions);
  const series = new pond.TimeSeries({
    name: 'bars',
    schema: [
      { name: 'time', kind: 'time' },
      { name: 'close', kind: 'number' },
    ],
    rows: c.keys.map((t, i) => [t, i]),
  });
  const tagged = cal.tagSessions(series, c.options);
  const name = tagged.schema[tagged.schema.length - 1].name;
  const column = tagged.column(name);
  return Array.from({ length: tagged.length }, (_, i) => column.at(i) ?? null);
}

export function buildCalendarFixture(pond, financial) {
  const cases = [];
  for (const c of generateCases()) {
    const range = { from: c.from, to: c.to };
    const result = caught(() =>
      financial.generateSessions(c.rules, range).map(plainSession),
    );
    if (result.expected) {
      try {
        financial.TradingCalendar.fromRules(c.rules, range);
        result.calendar = true;
      } catch (e) {
        result.calendar = { name: e.name, message: e.message };
      }
    }
    cases.push({ ...c, ...result });
  }
  for (const c of sessionCases()) {
    cases.push({
      ...c,
      ...caught(() =>
        financial.normalizeSessions(c.sessions).map(plainSession),
      ),
    });
  }
  for (const c of queryCases()) {
    cases.push({ ...c, ...runQueries(financial, c) });
  }
  for (const c of tagCases()) {
    cases.push({ ...c, ...caught(() => runTag(pond, financial, c)) });
  }
  return {
    meta: {
      description:
        '@pond-ts/financial trading calendar results for pond-rs to match: generate (generateSessions + whether fromRules accepts), sessions (normalizeSessions), queries (calendar lookups; a session result is its date), tag (tagSessions ids, null in closed time); a session is {date, open, close, breaks}',
    },
    cases: cases.map((c, i) => ({ id: `${i}-${c.kind}`, ...c })),
  };
}
