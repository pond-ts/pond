# pond-ts Claude Code plugin

Skills that teach Claude Code the pond-ts idioms so the code it writes against
`pond-ts`, `@pond-ts/charts` and `@pond-ts/financial` is right the first time.

```
/plugin marketplace add pond-ts/pond
/plugin install pond-ts@pond-ts
```

| Skill            | Triggers on                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| `pond-ts`        | bucketing / rolling / regridding / per-entity stats / streaming windows in TS |
| `pond-charts`    | drawing time series in React, live charts, cursors, selection, annotations    |
| `pond-financial` | OHLCV bars, moving averages, RSI/MACD/Bollinger, market-hours calendars       |

The skills are versioned with the library (same PR that renames an export
updates the skill that quotes it) and lean on two files every pond tarball
already ships: `API.md` (the export map) and `AGENTS.md` (the agent guide,
source: `docs/agents/USING_POND.md`).
