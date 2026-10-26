#!/usr/bin/python3
# usage: python3 -I bench_summary.py mem-gc.jsonl throughput.log   -> Markdown tables for the engine comparison section
import sys, json, statistics as st
mem = [json.loads(l) for l in open(sys.argv[1]) if l.strip().startswith("{")]
thr = []
rep = None
for l in open(sys.argv[2]):
    l = l.strip()
    if not l.startswith("{"): continue
    d = json.loads(l)
    if "target" in d: d["rep"] = rep; thr.append(d)
    else: rep = d.get("rep")
def slope(rows, key):
    xs = [r["conns"] for r in rows]; ys = [key(r) for r in rows]
    n = len(xs); mx = sum(xs) / n; my = sum(ys) / n
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
print("| Target | Connections | Heap after GC (MiB) | External after GC (MiB) | RSS after GC (MiB) |")
print("|---|---|---|---|---|")
for tgt in ("stock", "hardened"):
    for r in [m for m in mem if m["target"] == tgt]:
        print("| %s | %d | %.1f | %.1f | %d |" % (tgt, r["conns"], r["retainedHeapMiB"], r["externalMiB"], r["retainedRssAfterGcMiB"]))
print()
for tgt in ("stock", "hardened"):
    rows = [m for m in mem if m["target"] == tgt]
    if len(rows) >= 2:
        h = slope(rows, lambda r: r["retainedHeapMiB"]) * 1024; e = slope(rows, lambda r: r["externalMiB"]) * 1024; rs = slope(rows, lambda r: r["retainedRssAfterGcMiB"]) * 1024
        print("- %s: slope %.1f KiB/connection heap + %.1f KiB external = **%.1f KiB retained**, RSS slope **%.1f KiB/connection**" % (tgt, h, e, h + e, rs))
print()
print("| Target | Announce interval per connection | Incoming msgs/s | Outgoing msgs/s | Server CPU (cores) | CPU per incoming msg (us) | RSS (MiB) | Host load avg (1 min) |")
print("|---|---|---|---|---|---|---|---|")
for tgt in ("stock", "hardened"):
    for iv in (2000, 1000, 500):
        rows = [t for t in thr if t["target"] == tgt and t["intervalMs"] == iv]
        if not rows: continue
        def med(k): return st.median([r[k] for r in rows])
        print("| %s | %d ms (4,000 conns) | %d | %d | %.2f | %.0f | %d | %s |" % (tgt, iv, med("msgsInPerS"), med("msgsOutPerS"), med("serverCpuCores"), med("cpuMicrosPerIncomingMsg"), med("serverRssMiB"), ", ".join(r["loadAvg"].split()[0] for r in rows)))
