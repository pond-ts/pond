"""The trial's answers, computed from data.csv with numpy alone, without
pond. `python3 truth.py <dir>` prints them as JSON."""
import json
import sys

import numpy as np

d = np.genfromtxt(f"{sys.argv[1]}/data.csv", delimiter=",", names=True)
close, time = d["close"], d["time"]

# q1: Wilder's RSI(14) on the last bar. Seed with the simple mean of the
# first 14 changes, then smooth with alpha = 1/14.
chg = np.diff(close)
gain, loss = np.maximum(chg, 0), np.maximum(-chg, 0)
ag, al = gain[:14].mean(), loss[:14].mean()
for g, l in zip(gain[14:], loss[14:]):
    ag, al = (ag * 13 + g) / 14, (al * 13 + l) / 14
q1 = 100 - 100 / (1 + ag / al)

# q2: population stdev of the last 20 daily log returns, x sqrt(252) x 100.
r = np.log(close[1:] / close[:-1])
q2 = r[-20:].std(ddof=0) * np.sqrt(252) * 100

# q3: share of days close is above its 50-bar SMA, over days the SMA exists.
sma = np.convolve(close, np.ones(50) / 50, mode="valid")
q3 = float((close[49:] > sma).mean())

# q4: the largest one-day fall in close, in percent, and that bar's UTC date.
pct = (close[1:] / close[:-1] - 1) * 100
i = int(pct.argmin())
q4 = {
    "percent": float(pct[i]),
    "date": np.datetime64(int(time[i + 1]), "ms").astype("datetime64[D]").astype(str),
}

print(json.dumps({"q1": float(q1), "q2": float(q2), "q3": q3, "q4": q4}))
