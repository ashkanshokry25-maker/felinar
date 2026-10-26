#!/usr/bin/python3
# READ-ONLY retention lower bound: newest kind-1 event with created_at <= cutoff. Hit => relay retains events at least that old.
import os, sys, json, time, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nreq
now = datetime.datetime(2026, 10, 17, tzinfo=datetime.timezone.utc)
cuts = [("6mo", datetime.datetime(2026, 4, 17, tzinfo=datetime.timezone.utc)), ("1y", datetime.datetime(2025, 10, 17, tzinfo=datetime.timezone.utc)),
        ("2y", datetime.datetime(2024, 10, 17, tzinfo=datetime.timezone.utc)), ("3y", datetime.datetime(2023, 10, 17, tzinfo=datetime.timezone.utc)),
        ("4y", datetime.datetime(2022, 10, 17, tzinfo=datetime.timezone.utc))]
for rl in sys.argv[1].split(","):
    row = {"relay": rl}
    for name, dt in cuts:
        r = nreq.req(rl, {"kinds": [1], "until": int(dt.timestamp()), "limit": 1}, 1, 12.0)
        evs = r["events"]
        if evs:
            row[name] = time.strftime("%Y-%m-%d", time.gmtime(evs[0]["created_at"]))
        else:
            row[name] = "none" if not (r.get("error") or r.get("recv_exc")) else "err:" + str(r.get("error") or r.get("recv_exc"))[:30]
        time.sleep(0.25)
    print(json.dumps(row)); sys.stdout.flush()
