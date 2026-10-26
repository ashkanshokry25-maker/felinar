#!/usr/bin/python3
# Aggregate NIP-66 30166 events (untrusted data) into a relay census. usage: agg66.py census.jsonl
import sys, json, time, collections, statistics
evs = [json.loads(l) for l in open(sys.argv[1])]
now = time.time()
print("events", len(evs), "newest age (min):", round((now - max(e["created_at"] for e in evs)) / 60, 1), "oldest age (h):", round((now - min(e["created_at"] for e in evs)) / 3600, 1))
mons = collections.Counter(e["pubkey"] for e in evs)
print("distinct monitors", len(mons), "top:", [(k[:8], v) for k, v in mons.most_common(8)])
# latest event per (monitor, relay)
latest = {}
for e in evs:
    d = next((t[1] for t in e["tags"] if t and t[0] == "d" and len(t) > 1), None)
    if not d: continue
    k = (e["pubkey"], d)
    if k not in latest or e["created_at"] > latest[k]["created_at"]: latest[k] = e
relays = collections.defaultdict(list)
for (m, d), e in latest.items(): relays[d].append(e)
print("distinct relays (d tags):", len(relays))
def tagvals(e, name): return [t[1:] for t in e["tags"] if t and t[0] == name]
def first(e, name, idx=0):
    v = tagvals(e, name); return v[0][idx] if v and len(v[0]) > idx else None
# per relay: take the freshest event across monitors
rows = []
for d, es in relays.items():
    e = max(es, key=lambda x: x["created_at"])
    rows.append(dict(relay=d, age_h=(now - e["created_at"]) / 3600, nmon=len(es),
        rtt_open=[int(first(x, "rtt-open")) for x in es if first(x, "rtt-open") and first(x, "rtt-open").isdigit()],
        rtt_read=[int(first(x, "rtt-read")) for x in es if first(x, "rtt-read") and first(x, "rtt-read").isdigit()],
        rtt_write=[int(first(x, "rtt-write")) for x in es if first(x, "rtt-write") and first(x, "rtt-write").isdigit()],
        R=set(v[0] for x in es for v in tagvals(x, "R") if v), N=set(v[0] for x in es for v in tagvals(x, "N") if v),
        sw=first(e, "s"), net=first(e, "n"), kacc=[v[0] for x in es for v in tagvals(x, "k")]))
n = len(rows); print("relay rows", n)
clear = [r for r in rows if r["net"] in (None, "clearnet")]
print("clearnet:", len(clear), "tor/i2p/other:", n - len(clear))
fresh = [r for r in clear if r["age_h"] <= 24]
print("clearnet with event <=24h old:", len(fresh))
opened = [r for r in fresh if r["rtt_open"]]
print("  with rtt-open (reachable by >=1 monitor):", len(opened))
wr = [r for r in opened if r["rtt_write"]]
print("  with rtt-write (a monitor completed a write test):", len(wr))
def pct(c, tot): return "%d (%.0f%%)" % (c, 100.0 * c / max(1, tot))
print("  R !auth:", pct(sum('!auth' in r['R'] for r in opened), len(opened)), " auth:", pct(sum('auth' in r['R'] for r in opened), len(opened)))
print("  R !payment:", pct(sum('!payment' in r['R'] for r in opened), len(opened)), " payment:", pct(sum('payment' in r['R'] for r in opened), len(opened)))
print("  R !pow:", pct(sum('!pow' in r['R'] for r in opened), len(opened)), " pow:", pct(sum('pow' in r['R'] for r in opened), len(opened)))
print("  R !writes:", pct(sum('!writes' in r['R'] for r in opened), len(opened)), " writes(restricted):", pct(sum('writes' in r['R'] for r in opened), len(opened)))
open_w = [r for r in opened if ('!auth' in r['R'] and '!payment' in r['R'] and '!pow' in r['R'] and ('!writes' in r['R'] or 'writes' not in r['R']))]
print("  'open-write' by R tags (no auth, no payment, no pow, no restricted writes):", pct(len(open_w), len(opened)))
for nip in (11, 40, 42, 45, 50, 59, 62, 65, 66, 67, 70, 77, 78, 86):
    print("  NIP-%d advertised by" % nip, pct(sum(str(nip) in r['N'] for r in opened), len(opened)), "  | among open-write:", pct(sum(str(nip) in r['N'] for r in open_w), len(open_w)))
sw = collections.Counter()
for r in opened:
    s = r["sw"] or "?"
    sw[s.replace("https://github.com/", "gh:").replace("git+", "")[:50]] += 1
print("software (s tag) top:", sw.most_common(14))
rt = [statistics.median(r["rtt_open"]) for r in opened]
if rt: print("rtt-open median of medians (ms):", statistics.median(rt), "p90:", sorted(rt)[int(0.9 * len(rt))])
rw = [statistics.median(r["rtt_write"]) for r in wr]
if rw: print("rtt-write median (ms):", statistics.median(rw), "p90:", sorted(rw)[int(0.9 * len(rw))])
ks = collections.Counter(k for r in opened for k in r["kacc"])
print("k-tag values seen (accepted/unaccepted kinds), top:", ks.most_common(10))
# write-tested open relays, sorted by write rtt
json.dump([dict(relay=r["relay"], rtt_open=statistics.median(r["rtt_open"]), rtt_write=(statistics.median(r["rtt_write"]) if r["rtt_write"] else None), R=sorted(r["R"]), sw=r["sw"], nmon=r["nmon"], nips=sorted(int(x) for x in r["N"] if x.isdigit())) for r in open_w], open(sys.argv[1] + ".openwrite.json", "w"))
