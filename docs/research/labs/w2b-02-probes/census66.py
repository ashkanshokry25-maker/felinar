#!/usr/bin/python3
# READ-ONLY: page through NIP-66 kind 30166 events on one relay. usage: census66.py <relay> <out.jsonl> [days] [max_pages]
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nreq
relay, out = sys.argv[1], sys.argv[2]
days = float(sys.argv[3]) if len(sys.argv) > 3 else 3
maxp = int(sys.argv[4]) if len(sys.argv) > 4 else 12
now = int(time.time()); since = now - int(days * 86400)
seen = {}; until = now; pages = 0; clamps = []
while pages < maxp:
    r = nreq.req(relay, {"kinds": [30166], "since": since, "until": until, "limit": 1000}, 1000, 25.0)
    evs = r["events"]; pages += 1
    clamps.append(len(evs))
    new = 0
    for e in evs:
        if e["id"] not in seen:
            seen[e["id"]] = e; new += 1
    if not evs or new == 0:
        break
    oldest = min(e["created_at"] for e in evs)
    if oldest <= since: break
    until = oldest  # inclusive 'until'; dedupe by id
    time.sleep(0.4)
with open(out, "w") as f:
    for e in seen.values(): f.write(json.dumps(e, separators=(",", ":")) + "\n")
print(json.dumps({"relay": relay, "pages": pages, "per_page": clamps, "events": len(seen), "eose_hint": r.get("eose_hint"), "msgs": r.get("msgs")}))
