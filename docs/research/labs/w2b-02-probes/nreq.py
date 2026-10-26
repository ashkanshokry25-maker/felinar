#!/usr/bin/python3
# READ-ONLY Nostr REQ helper (never sends EVENT). Reuses the stdlib RFC 6455 client from wave-1.
# usage: python3 -I nreq.py <relay host[:port]> '<filter json>' <max_events> <out.jsonl|-> [timeout_s]
# Prints a one-line JSON summary to stdout. Events (untrusted data) are written to out.jsonl, one per line.
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "02-wss-trackers-probes"))
import wsprobe as W

def req(host, flt, max_events=100, timeout=12.0, origin="https://example.org"):
    port = 443
    h = host
    if ":" in host:
        h, pp = host.split(":"); port = int(pp)
    res = {"relay": host, "filter": flt, "events": [], "msgs": []}
    ws = W.WS(h, port, "/", timeout=timeout, origin=origin)
    t0 = time.time()
    try:
        ok = ws.connect()
        res["upgrade"] = ws.info.get("http_status")
        res["connect_ms"] = round((time.time() - t0) * 1000)
        res["server_hdr"] = ws.info.get("resp_headers", {}).get("server")
        if not ok:
            return res
        sub = "mw" + os.urandom(3).hex()
        ws.send_text(json.dumps(["REQ", sub, flt]))
        t1 = time.time()
        deadline = t1 + timeout
        while time.time() < deadline:
            try:
                r = ws.recv_msg(max(0.5, deadline - time.time()))
            except Exception as e:
                res["recv_exc"] = repr(e); break
            if r[0] != "text":
                res["close"] = [str(x)[:120] for x in r]; break
            try:
                m = json.loads(r[1])
            except Exception:
                res["msgs"].append("nonjson:" + r[1][:100]); continue
            if not isinstance(m, list) or not m:
                continue
            if m[0] == "EVENT" and len(m) >= 3 and m[1] == sub:
                res["events"].append(m[2])
                if len(res["events"]) >= max_events:
                    res["stopped"] = "max_events"; break
            elif m[0] == "EOSE":
                res["eose_ms"] = round((time.time() - t1) * 1000)
                if len(m) > 2:
                    res["eose_hint"] = m[2]
                break
            elif m[0] in ("NOTICE", "CLOSED", "AUTH"):
                res["msgs"].append(r[1][:200])
                if m[0] == "CLOSED":
                    break
        try:
            ws.send_text(json.dumps(["CLOSE", sub]))
        except Exception:
            pass
    except Exception as e:
        res["error"] = "%s: %s" % (type(e).__name__, e)
    finally:
        ws.close()
    return res

if __name__ == "__main__":
    host, flt, maxe, out = sys.argv[1], json.loads(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    to = float(sys.argv[5]) if len(sys.argv) > 5 else 12.0
    r = req(host, flt, maxe, to)
    evs = r.pop("events")
    if out != "-":
        with open(out, "w") as f:
            for e in evs:
                f.write(json.dumps(e, separators=(",", ":")) + "\n")
    r["n_events"] = len(evs)
    print(json.dumps(r))
