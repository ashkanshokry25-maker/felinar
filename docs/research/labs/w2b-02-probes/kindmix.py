#!/usr/bin/python3
# READ-ONLY: sample recent events (no kind filter) from a relay; report share of kinds absent from the NIPs README table.
import os, sys, re, json, time, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nreq
import urllib.request
txt = urllib.request.urlopen("https://raw.githubusercontent.com/nostr-protocol/nips/master/README.md", timeout=30).read().decode("utf-8")
reg = []
for m in re.finditer(r"^\|\s*`(\d+)(?:-(\d+))?`\s*\|", txt, re.M):
    a = int(m.group(1)); b = int(m.group(2) or a); reg.append((a, b))
def known(k): return any(a <= k <= b for a, b in reg)
for rl in sys.argv[1].split(","):
    now = int(time.time())
    r = nreq.req(rl, {"since": now - 300, "limit": 500}, 500, 20.0)
    evs = r["events"]
    c = collections.Counter(e["kind"] for e in evs)
    unk = {k: v for k, v in c.items() if not known(k) and not (20000 <= k < 30000)}
    neph = sum(v for k, v in c.items() if not (20000 <= k < 30000))
    nunk = sum(unk.values())
    big = sorted(((len(json.dumps(e, separators=(",", ":"), ensure_ascii=False).encode()), e["kind"]) for e in evs), reverse=True)[:3]
    print(json.dumps({"relay": rl, "n": len(evs), "distinct_kinds": len(c), "non_ephemeral_events": neph, "stored_events_in_kinds_absent_from_README": nunk, "pct_of_non_ephemeral": round(100.0 * nunk / max(1, neph), 1),
                      "unregistered_kinds_sample": sorted(unk.items(), key=lambda kv: -kv[1])[:10], "largest_event_bytes_kind": big}))
