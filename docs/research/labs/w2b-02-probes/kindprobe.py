#!/usr/bin/python3
# READ-ONLY: for each relay x kind, REQ limit=N and report how many events returned + size stats + oldest/newest created_at. Saves sampled events.
import os, sys, json, time, statistics
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nreq
relays = sys.argv[1].split(","); kinds = [int(k) for k in sys.argv[2].split(",")]; lim = int(sys.argv[3]); outdir = sys.argv[4]
for rl in relays:
    for k in kinds:
        r = nreq.req(rl, {"kinds": [k], "limit": lim}, lim, 20.0)
        evs = r["events"]
        row = {"relay": rl, "kind": k, "n": len(evs), "ms": r.get("eose_ms"), "closed": [m for m in r["msgs"] if "CLOSED" in m or "NOTICE" in m][:1], "err": r.get("error") or r.get("recv_exc")}
        if evs:
            sizes = [len(json.dumps(e, separators=(",", ":"), ensure_ascii=False).encode()) for e in evs]
            ca = [e["created_at"] for e in evs]
            row.update(size_med=int(statistics.median(sizes)), size_max=max(sizes), newest=time.strftime("%Y-%m-%d", time.gmtime(max(ca))), oldest=time.strftime("%Y-%m-%d", time.gmtime(min(ca))), authors=len(set(e["pubkey"] for e in evs)))
            with open("%s/%s_k%d.jsonl" % (outdir, rl.replace(":", "_"), k), "w") as f:
                for e in evs: f.write(json.dumps(e, separators=(",", ":")) + "\n")
        print(json.dumps(row)); sys.stdout.flush()
        time.sleep(0.3)
