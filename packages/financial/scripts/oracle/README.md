# Study oracle

Independent cross-validation of `@pond-ts/financial` studies against a
**pandas** reference (the open-source numerical reference — think MATLAB, but
free and what quant practitioners actually use). `generate.py` computes the
expected indicator values with pandas and writes the golden fixture
[`../../test/fixtures/study-oracle.json`](../../test/fixtures/study-oracle.json);
[`../../test/study-oracle.test.ts`](../../test/study-oracle.test.ts) runs our
TypeScript studies over the same input and asserts bar-for-bar agreement.

**CI needs no Python** — the JSON is the committed oracle. You only run the
generator when a study's definition changes (and the fixture diff should be
reviewed as carefully as the code).

## Regenerate

```sh
python3 -m venv .venv
.venv/bin/pip install pandas
.venv/bin/python packages/financial/scripts/oracle/generate.py
```

Then run the suite (`npm test --workspace=@pond-ts/financial`) to confirm the
TypeScript still matches, and commit the updated JSON.

## Conventions (why the numbers line up)

An oracle only helps if its conventions match ours — the defaults will not:

| study     | pandas                                        | note                                             |
| --------- | --------------------------------------------- | ------------------------------------------------ |
| SMA       | `close.rolling(n).mean()`                     | —                                                |
| EMA       | `close.ewm(span=n, adjust=False).mean()`      | `adjust=False` (recursive); **not** the default  |
| Bollinger | `middle ± k · close.rolling(n).std(ddof=0)`   | **population** stdev (TA-Lib's), not pandas' ddof=1 |

The EMA head is masked to the first `n-1` rows to match our length-preserving
`minSamples: n` warm-up. The input series is deliberately never flat, so the
`σ = 0 → undefined` band case (separately unit-tested in `studies.test.ts`)
doesn't arise here.

## Phase 2 (named indicators)

RSI / MACD / ATR / stochastics will add **TA-Lib** (`pip install TA-Lib`,
needs the C library — `brew install ta-lib`) alongside pandas, as the
industry-standard cross-check. Because those indicators have multiple published
definitions (Wilder smoothing, etc.), the oracle documents any delta from
TA-Lib rather than forcing bar-for-bar vendor parity (a non-goal — see
`docs/notes/financial-indicators-assessment-2026-07.md` §2).
