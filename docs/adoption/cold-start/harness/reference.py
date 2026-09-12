# Independent reference for grading: dedupe exact rows, sort by (host, ts),
# drop blank ms, bucket to 5 min, p95 = linear interpolation (numpy default),
# trailing 1h (12 buckets incl. current) mean/sd (population), breaches.
import csv, sys, math, json
from collections import defaultdict
from datetime import datetime, timezone
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
worst=[]
for h,d in per.items():
    ks=sorted(d); n=0
    for i,k in enumerate(ks):
        win=[d[kk][0] for kk in ks[max(0,i-11):i+1]]
        m=sum(win)/len(win); sd=math.sqrt(sum((x-m)**2 for x in win)/len(win))
        if d[k][0]>m+2*sd: n+=1; worst.append((d[k][0]-(m+2*sd),h,k,d[k][0]))
    out['breaches'][h]=n
    out['sample'][h]={'first_bucket':ks[0],'first_p95':round(d[ks[0]][0],1),'first_count':d[ks[0]][1],'n_buckets':len(ks)}
worst.sort(reverse=True); out['worst3']=[(h,datetime.fromtimestamp(k,timezone.utc).isoformat(),round(p,1)) for _,h,k,p in worst[:3]]
print(json.dumps(out,indent=1))
