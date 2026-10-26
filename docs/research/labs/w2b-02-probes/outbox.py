#!/usr/bin/python3
# READ-ONLY: NIP-65/BUD-03 resolution test: for a public pubkey, fetch kind 10002 + 10063 from indexer relays and time it.
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nreq
pk = sys.argv[2]
for rl in sys.argv[1].split(","):
    t = time.time()
    r = nreq.req(rl, {"kinds": [10002, 10063], "authors": [pk]}, 10, 12.0)
    ms = round((time.time() - t) * 1000)
    out = {"relay": rl, "total_ms": ms, "connect_ms": r.get("connect_ms"), "eose_ms": r.get("eose_ms"), "err": r.get("error") or r.get("recv_exc"), "n": len(r["events"])}
    for e in r["events"]:
        if e["kind"] == 10002: out["relays_10002"] = [t[1] for t in e["tags"] if len(t) > 1 and t[0] == "r"][:8]
        if e["kind"] == 10063: out["blossom_10063"] = [t[1] for t in e["tags"] if len(t) > 1 and t[0] == "server"][:8]
    print(json.dumps(out)); sys.stdout.flush()
