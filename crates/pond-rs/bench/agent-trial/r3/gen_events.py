"""Events for the R3 step 7 agent trial (fixed seed).

    python3 gen_events.py events.csv

CPU readings from 13 hosts over 20 minutes, written in the order they
arrive (not time order): most arrive within 0.3 s of their time, about 4%
2-12 s late. Host h12 goes quiet from minute 6 to minute 9; h13 starts at
minute 10. Around minute boundaries some hosts send an event exactly at
(bucket end + 5 s) or 1 ms before it, followed by a late event 1 ms before
the bucket's end, so a grader can tell `>=` from `>` in the close rule.
About 3% of readings are missing (empty cpu).
"""
import random
import sys

START = 1772409600000  # 2026-03-02T00:00:00Z
MIN = 60_000
random.seed(20261029)


def cpu():
    return "" if random.random() < 0.03 else f"{random.random() * 100:.2f}"


rows = []  # (arrival, seq, time, host, cpu)
seq = 0


def add(arrival, t, host):
    global seq
    rows.append((arrival, seq, t, host, cpu()))
    seq += 1


hosts = [f"h{i:02d}" for i in range(1, 14)]
for host in hosts:
    t = START + random.randint(0, 250)
    while t < START + 20 * MIN:
        minute = (t - START) // MIN
        quiet = host == "h12" and 6 <= minute < 9
        late_start = host == "h13" and minute < 10
        if not quiet and not late_start:
            d = random.randint(2000, 12000) if random.random() < 0.04 else random.randint(0, 300)
            add(t + d, t, host)
        t += random.randint(150, 250)
    # Boundary traps, about one host-minute in four.
    for m in range(1, 20):
        if host == "h13" and m <= 10 or host == "h12" and 6 <= m <= 9:
            continue
        r = random.random()
        end = START + m * MIN
        if r < 0.125:
            # Closes the bucket exactly; the late event after it is too late.
            add(end + 5000 + 400, end + 5000, host)
            add(end + 5000 + 401, end - 1, host)
        elif r < 0.25:
            # 1 ms short of closing it; the late event still counts.
            add(end + 4999 + 400, end + 4999, host)
            add(end + 4999 + 401, end - 1, host)

rows.sort()
with open(sys.argv[1], "w") as f:
    f.write("time,host,cpu\n")
    for _, _, t, host, c in rows:
        f.write(f"{t},{host},{c}\n")
print(len(rows), "events")
