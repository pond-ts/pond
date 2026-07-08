# Real 5-minute market-data fixture notes

## What is resolved

1. **US multi-session / overnight gap candidate**
   - Source: `imbue11235/stockhistory`
   - Symbol: `SPY`
   - Format: Alpha Vantage-style JSON
   - Interval: 5 minutes
   - Timezone: US/Eastern
   - Use the `spy10` list in `fetch-real-5m-fixtures.mjs`.

2. **US half-day candidate**
   - Source: `data/SPY/2024-12-02.json`
   - Captures `2024-11-29`, the post-Thanksgiving early-close date.
   - The companion script writes both all-hours and regular-session-only CSVs.

## Not fully resolved

I did not find a clean real HKEX/TSE 5-minute OHLCV fixture with a lunch break in the quick pass. For session-shape tests, HKEX is still a good target because its continuous trading sessions are 09:30-12:00 and 13:00-16:00 local time.

## Usage

```bash
node fetch-real-5m-fixtures.mjs
```

Optional:

```bash
OUT_DIR=./fixtures node fetch-real-5m-fixtures.mjs
```
