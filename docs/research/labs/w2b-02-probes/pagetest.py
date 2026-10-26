#!/usr/bin/python3
# READ-ONLY: does `until`-based pagination work on a relay? Requests limit=1000 (to expose silent clamping), then pages by until=oldest (inclusive) with dedupe.
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nreq
for rl in sys.argv[1].split(","):
    kind = int(sys.argv[2]); seen = {}; until = int(time.time()); pages = []
    for p in range(4):
        r = nreq.req(rl, {"kinds": [kind], "until": until, "limit": 1000}, 1000, 25.0)
        evs = r["events"]; new = [e for e in evs if e["id"] not in seen]
        for e in evs: seen[e["id"]] = e
        ca = [e["created_at"] for e in evs]
        pages.append({"requested": 1000, "returned": len(evs), "new": len(new), "oldest": min(ca) if ca else None, "newest": max(ca) if ca else None, "eose_hint": r.get("eose_hint"), "msgs": r.get("msgs")[:1], "err": r.get("error") or r.get("recv_exc")})
        if not evs: break
        if len(new) == 0: break
        until = min(ca)          # inclusive until; duplicates of the boundary second are deduped by id
        time.sleep(0.8)
    print(json.dumps({"relay": rl, "kind": kind, "pages": pages, "total_unique": len(seen)}))
