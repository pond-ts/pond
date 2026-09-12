You are working in an empty TypeScript project directory (this one). Build a small Node/TypeScript tool, end to end, and make it run.

Input: `data/latency.csv` — columns `host,ts,ms`. About 200k rows, 10 hosts, ISO-8601 UTC timestamps, per-request latency in milliseconds. Real-world texture: a few duplicate rows, a chunk that is out of time order, some blank `ms` cells.

Required output when I run `npm start`:

1. **Per-host 5-minute p95**: for every host and every 5-minute bucket, the 95th-percentile latency. Write to `out/p95.csv` as `host,bucket_start,p95,count`.
2. **Rolling 1-hour baseline with bands**: over the per-host 5-minute p95 series, a trailing 1-hour rolling mean and standard deviation, and `upper = mean + 2*sd`, `lower = mean - 2*sd`. Write to `out/baseline.csv` as `host,bucket_start,p95,mean,sd,upper,lower`.
3. **Breaches**: every bucket where p95 > upper. Write `out/breaches.csv` as `host,bucket_start,p95,upper`, and print a short console summary (breach count per host, and the three worst breaches overall).

Constraints:
- TypeScript, Node 20+. Use whatever npm packages you judge best — or none. Justify the choice in one paragraph in a `NOTES.md` (what you considered, what you picked, why).
- Handle the duplicates, the out-of-order chunk, and the blank cells deliberately (say how in NOTES.md).
- `npm install && npm start` must work from a clean checkout. Keep runtime under ~30 s.
- When you are done, print `DONE` as the last line of your final message, followed by the list of npm packages you used.
