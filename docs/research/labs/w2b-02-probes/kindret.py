#!/usr/bin/python3
# READ-ONLY: per-kind retention probe: newest event of kind K with created_at <= now - offset.
import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nreq
offs = [("1h", 3600), ("6h", 6 * 3600), ("1d", 86400), ("7d", 7 * 86400), ("30d", 30 * 86400), ("90d", 90 * 86400), ("365d", 365 * 86400)]
kinds = [int(k) for k in sys.argv[2].split(",")]
for rl in sys.argv[1].split(","):
    for k in kinds:
        row = {"relay": rl, "kind": k}
        now = int(time.time())
        for name, o in offs:
            r = nreq.req(rl, {"kinds": [k], "until": now - o, "limit": 1}, 1, 12.0)
            e = r["events"]
            row[name] = ("%.1fd" % ((now - e[0]["created_at"]) / 86400.0)) if e else ("none" if not (r.get("error") or r.get("recv_exc")) else "err")
            time.sleep(0.2)
        print(json.dumps(row)); sys.stdout.flush()
