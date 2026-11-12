# Finance process graphs an MCP agent would ask for — 2026-11

48 realistic questions an agent would send a finance MCP server, each written
as a `@pond-ts/process` graph, with whether the library could express it on
2026-11-08 (`main` 9a41c66, before [PND-PROCKIT]). Working doc with the same
content: https://claude.ai/artifact/118PdMrcgn8GUXH5CGftLW.

**Today** values: **Works** — the study catalog plus the four standard folds;
**Server adds** — fits the library, but needed a step or fold every server
would write (now shipped by [PND-PROCKIT]); **Can't** — the library's shape
cannot say it, reason given.

| #   | The agent asks                                            | Steps                                         | Today (before kit)                    |
| --- | --------------------------------------------------------- | --------------------------------------------- | ------------------------------------- |
| 1   | AAPL 14-day RSI now; overbought?                          | rsi(14), last, percentileRank                 | Works                                 |
| 2   | MSFT position inside Bollinger bands                      | bollingerPercentB(20,2), last                 | Works                                 |
| 3   | NVDA % above 50 and 200 day averages                      | sma, (close−sma)/sma, last                    | Server adds                           |
| 4   | SPY MACD and side of signal                               | macd, last of each output                     | Works                                 |
| 5   | TSLA trend strength                                       | directionalMovement(14), last, percentileRank | Works                                 |
| 6   | QQQ ATR as % of price                                     | atr(14)/close, last                           | Server adds                           |
| 7   | GOOG 20-day z-score over the last year                    | zScore(20), shape(60)                         | Can't: no date window                 |
| 8   | How unusual is AMZN's volume today                        | zScore(50) of volume, last, rank              | Works                                 |
| 9   | AAPL total return in 2024                                 | first/last close in 2024                      | Can't: no date window                 |
| 10  | SPY 30-day annualised volatility                          | historicalVolatility(30), last                | Works                                 |
| 11  | BTC max drawdown since 2020, peak and trough              | running peak, close/peak−1, min               | Can't: no date window                 |
| 12  | QQQ 3-year Sharpe                                         | pct change, mean/stdev × √252                 | Can't: no date window                 |
| 13  | NFLX biggest one-day drop and gain                        | percentChange(1), extremes                    | Works                                 |
| 14  | SPY rolling one-year return line                          | percentChange(252), shape(52)                 | Works                                 |
| 15  | Share of days TSLA closed up                              | pct change > 0, share                         | Server adds                           |
| 16  | AAPL one-day 95% VaR                                      | pct change, 5th percentile                    | Server adds                           |
| 17  | TSLA beta to SPY                                          | join, beta(252), last                         | Can't: one dataset per request        |
| 18  | GLD/TLT 60-day correlation                                | join, correlation(60), last, shape            | Can't: one dataset                    |
| 19  | Is KO/PEP ratio stretched                                 | join, ratio, zScore(60), rank                 | Can't: one dataset                    |
| 20  | AAPL vs QQQ this year                                     | join, priceRelative, change since 1 Jan       | Can't: one dataset, no window         |
| 21  | Does oil lead the energy ETF                              | join, shift 0–10, correlation per lag         | Can't: one dataset                    |
| 22  | How often BTC on two exchanges differs >0.5%              | as-of join, spread %, share                   | Can't: one dataset                    |
| 23  | SPY's last golden cross                                   | movingAverageCross(50,200), last time +1      | Server adds                           |
| 24  | Every time AAPL RSI fell below 30                         | rsi, compare, event dates                     | Server adds                           |
| 25  | NVDA gap-ups over 2% this year                            | open/prev close−1 > 2%, count                 | Can't: no date window                 |
| 26  | Did MSFT break its 20-day high today                      | donchian upper shifted 1, close above, last   | Server adds                           |
| 27  | ETH SuperTrend direction and last flip                    | superTrend, last change                       | Server adds                           |
| 28  | Days with 3× volume and a >3% drop                        | volume/sma, pct change, and, events           | Server adds                           |
| 29  | SPY vs today's session VWAP                               | sessionVwap(calendar), close−vwap, last       | Server adds (+ time-of-day fix)       |
| 30  | AAPL first-30-minute range breakout                       | session-relative high/low, compare            | Can't: no "today", no time-since-open |
| 31  | QQQ average volume by time of day                         | group by time of day, mean                    | Can't: row count changes              |
| 32  | Today's ES pivot points                                   | pivotPoints(calendar), last of each           | Server adds                           |
| 33  | Share of today's volume in the last hour                  | sums over today and last hour                 | Can't: no window                      |
| 34  | SPY monthly returns table, 5 years                        | month-end closes, pct change                  | Can't: row count changes              |
| 35  | TSLA weekly RSI                                           | weekly bars, rsi(14), last                    | Can't: row count changes              |
| 36  | BTC day-of-week effect                                    | group returns by weekday                      | Can't: grouping                       |
| 37  | Gold's best calendar month                                | group monthly returns by month                | Can't: grouping                       |
| 38  | Top 10 S&P 500 by 6-month momentum                        | per ticker pct change, rank                   | Can't: no fan-out                     |
| 39  | Nasdaq-100 breadth above 200-day                          | per ticker close > sma(200), count            | Can't: no fan-out                     |
| 40  | Average RSI by sector                                     | per ticker rsi, group by sector               | Can't: no fan-out or metadata         |
| 41  | Correlation matrix of 8 ETFs                              | 8-way join, 28 correlations                   | Can't: one dataset, no table          |
| 42  | Screen: RSI<30 and above 200-day                          | per ticker tests, list passes                 | Can't: no fan-out                     |
| 43  | Average 10-day return after SPY RSI<30                    | rsi, compare, forward shift, mean where       | Server adds                           |
| 44  | Hit rate of a higher close 5 days after a Bollinger break | compare, forward change > 0, mean where       | Server adds                           |
| 45  | 50/200 crossover vs buy and hold on QQQ                   | position (hold), return × position, compound  | Server adds                           |
| 46  | Missing 5-minute AAPL bars this week                      | bar times vs calendar, gaps                   | Server adds                           |
| 47  | When did each ticker last update                          | last timestamp per ticker                     | Can't: no fan-out                     |
| 48  | Flag possible unadjusted splits                           | pct change, abs > 40%, events                 | Server adds                           |

Tally before the kit: 8 Works, 16 Server adds, 24 Can't. After [PND-PROCKIT]
the 16 are expressible from shipped sets, except #46 (a gap-finding fold
carrying a calendar, not built) and #30's time-since-open step (not built).
The 24 map to [PND-PROCWINDOW] (7, 9, 11, 12, 25, 30, 33), [PND-PROCMULTI]
(17–22) and [PND-PROCFAN] (31, 34–42, 47).
The tasks that close them: [PND_PROCFIN_PLAN.md](../plans/PND_PROCFIN_PLAN.md).
