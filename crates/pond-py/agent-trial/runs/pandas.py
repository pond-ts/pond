import math
import pandas as pd
import pond_rs

cpu = pd.read_csv("cpu.csv", parse_dates=["time"]).sort_values(["time", "host"], ignore_index=True)
s = pond_rs.TimeSeries(cpu)
print(s.columns)

# 1
r = s.partition_by("host").rolling(pd.Timedelta("15min"), {"cpu_avg": ("cpu", "avg")}).collect().to_pandas()
r = r.sort_values(["time", "host"], ignore_index=True)
r["time"] = r["time"].dt.strftime("%Y-%m-%dT%H:%M:%SZ")
r[["time", "host", "cpu_avg"]].to_csv("rolling.csv", index=False)

# 2
days = pond_rs.Sequence.calendar("day", "America/New_York")
d = s.partition_by("host").aggregate(days, {"max": ("cpu", "max"), "count": ("cpu", "count")}).collect()
d = d.as_time().to_pandas()
d["day"] = d["time"].dt.tz_convert("America/New_York").dt.strftime("%Y-%m-%d")
d["count"] = d["count"].astype(int)
d.sort_values(["day", "host"])[["day", "host", "max", "count"]].to_csv("daily.csv", index=False)

# 3
bars = pd.read_csv("bars.csv", parse_dates=["time"])
b = pond_rs.TimeSeries(bars).partition_by("symbol").rsi(period=14).bollinger(period=20, std_dev=2).collect().to_pandas()
last = b.groupby("symbol").tail(1).sort_values("symbol")
last = last.rename(columns={"bbUpper": "bb_upper", "bbLower": "bb_lower"})
last[["symbol", "rsi", "bb_upper", "bb_lower"]].to_csv("studies.csv", index=False)

# 4
live = pond_rs.LiveSeries({"time": "time", "host": "string", "cpu": "number"})
buckets = live.partition_by("host").aggregate("30m", {"max": ("cpu", "max"), "host": ("host", "last")}).collect()
buckets.watch("event")
out_rows = []
for i, row in enumerate(cpu.itertuples()):
    c = None if math.isnan(row.cpu) else row.cpu
    for out in live.push(row.time, host=row.host, cpu=c):
        label, begin, end = out.event.key
        out_rows.append({"host": out.event["host"], "start": begin, "max": out.event["max"], "closed_by": i})
pd.DataFrame(out_rows, columns=["host", "start", "max", "closed_by"]).to_csv("live.csv", index=False)
print(len(out_rows))
