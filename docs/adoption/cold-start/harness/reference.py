# Independent reference for grading. Conventions (an arm may legitimately
# choose others — compare only when they match):
#   - exact-duplicate rows collapsed; blank `ms` dropped; sorted by time
#   - 5-minute buckets anchored to the epoch; p95 = linear interpolation
#     between order statistics (numpy default), not nearest-rank
#   - trailing window = every present bucket with start in (t - 1h, t],
#     i.e. a TIME window including the current bucket (up to 12 buckets;
#     fewer across gaps), mean and POPULATION sd (ddof=0); bands emitted from
#     the first bucket (no warm-up)
#   - breach: p95 > mean + 2*sd; worst-3 ranked by exceedance over the upper
#     band, not by p95
# Usage: reference.py latency.csv            → summary JSON
#        reference.py latency.csv --full     → adds per-bucket p95 and the breach set
import csv, sys, math, json
from collections import defaultdict
from datetime import datetime, timezone
full = '--full' in sys.argv
rows=set()
with open(sys.argv[1]) as f:
    r=csv.reader(f); next(r)
    for host,ts,ms in r:
        if ms=='': continue
        rows.add((host,ts,float(ms)))
b=defaultdict(list)
for host,ts,ms in rows:
    t=datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()
    b[(host,int(t//300)*300)].append(ms)
def p95(xs):
    xs=sorted(xs); k=0.95*(len(xs)-1); lo=math.floor(k); hi=math.ceil(k)
    return xs[lo]+(xs[hi]-xs[lo])*(k-lo)
per=defaultdict(dict)
for (h,bs),xs in b.items(): per[h][bs]=(p95(xs),len(xs))
out={'buckets':sum(len(v) for v in per.values()),'breaches':{}, 'sample':{}}
worst=[]; breach_set=[]; p95_all={}
for h,d in per.items():
    ks=sorted(d); n=0
    for i,k in enumerate(ks):
        win=[d[kk][0] for kk in ks[:i+1] if kk > k-3600]
        m=sum(win)/len(win); sd=math.sqrt(sum((x-m)**2 for x in win)/len(win))
        p95_all[f'{h}|{k}']=d[k][0]
        if d[k][0]>m+2*sd:
            n+=1; worst.append((d[k][0]-(m+2*sd),h,k,d[k][0])); breach_set.append(f'{h}|{k}')
    out['breaches'][h]=n
    out['sample'][h]={'first_bucket':ks[0],'first_p95':round(d[ks[0]][0],1),'first_count':d[ks[0]][1],'n_buckets':len(ks)}
worst.sort(reverse=True); out['worst3']=[(h,datetime.fromtimestamp(k,timezone.utc).isoformat(),round(p,1)) for _,h,k,p in worst[:3]]
if full: out['p95']=p95_all; out['breach_set']=breach_set
print(json.dumps(out,indent=None if full else 1))
