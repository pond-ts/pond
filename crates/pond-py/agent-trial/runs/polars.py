import polars as pl
import pond_rs

cpu = pl.read_csv("cpu.csv", try_parse_dates=True).sort(["time", "host"])
s = pond_rs.TimeSeries(cpu)

# 1. rolling
r = s.partition_by("host").rolling("15m", {"cpu_avg": ("cpu", "avg")}).collect().to_polars()
r = r.sort(["time", "host"]).select(
    pl.col("time").dt.strftime("%Y-%m-%dT%H:%M:%SZ"), "host", "cpu_avg")
r.write_csv("rolling.csv")

# 2. daily
days = pond_rs.Sequence.calendar("day", "America/New_York")
d = s.partition_by("host").aggregate(days, {"max": ("cpu", "max"), "count": ("cpu", "count")}).collect()
d = d.as_time().to_polars().with_columns(
    pl.col("time").dt.convert_time_zone("America/New_York").dt.strftime("%Y-%m-%d").alias("day"),
    pl.col("count").cast(pl.Int64),
).sort(["day", "host"]).select("day", "host", "max", "count")
d.write_csv("daily.csv")

# 3. studies
bars = pl.read_csv("bars.csv", try_parse_dates=True)
b = pond_rs.TimeSeries(bars).partition_by("symbol").rsi(period=14).bollinger(period=20, std_dev=2).collect()
last = b.to_polars().group_by("symbol").last().sort("symbol")
last.select("symbol", "rsi", pl.col("bbUpper").alias("bb_upper"), pl.col("bbLower").alias("bb_lower")).write_csv("studies.csv")

# 4. live
live = pond_rs.LiveSeries({"time": "time", "host": "string", "cpu": "number"})
buckets = live.partition_by("host").aggregate("30m", {"max": ("cpu", "max"), "host": ("host", "last")}).collect()
buckets.watch("event")
rows = []
for i, (t, host, c) in enumerate(cpu.iter_rows()):
    for out in live.push(t, host=host, cpu=c):
        label, begin, end = out.event.key
        rows.append((out.event["host"], begin, out.event["max"], i))
pl.DataFrame(rows, schema=["host", "start", "max", "closed_by"], orient="row").write_csv("live.csv")
print(r.head(3), d.head(3), last, len(rows))
