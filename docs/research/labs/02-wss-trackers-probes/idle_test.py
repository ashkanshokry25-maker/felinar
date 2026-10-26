#!/usr/bin/python3
# usage: python3 -I idle_test.py 230 wss://a wss://b ...   (announce once, then stay silent; report when the server/proxy closes us)
# Idle-timeout experiment: connect, send ONE announce (random infohash, numwant 0), then send nothing and record
# when (if ever) the server/proxy closes the connection. Runs the trackers in parallel threads.
import sys, os, json, time, random, threading
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wsprobe as W

MAXWAIT = float(sys.argv[1])
URLS = sys.argv[2:]
results = {}

def worker(url):
    u = url.split("://", 1)[1]
    hostport, _, path = u.partition("/"); path = "/" + path
    host, _, port = hostport.partition(":"); port = int(port) if port else 443
    r = {"url": url}
    ws = W.WS(host, port, path, timeout=10.0, origin="https://example.org")
    try:
        ok = ws.connect()
        if not ok:
            r["upgrade"] = ws.info.get("http_status"); results[url] = r; return
        ih = "".join(chr(random.randint(0, 255)) for _ in range(20))
        pid = "-MW0001-" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12))
        ws.send_text(json.dumps({"action": "announce", "info_hash": ih, "peer_id": pid, "uploaded": 0, "downloaded": 0, "left": 1, "event": "started", "numwant": 0, "offers": []}, ensure_ascii=False))
        m = ws.recv_msg(10)
        r["first_reply_interval"] = json.loads(m[1]).get("interval") if m[0] == "text" else None
        t0 = time.time()
        r["events"] = []
        while time.time() - t0 < MAXWAIT:
            try:
                m = ws.recv_msg(5)
                r["events"].append(("%.0fs" % (time.time() - t0), m[0], (m[1] if m[0] == "text" else m[1:])[:80] if m[0] != "binary" else "bin"))
                if m[0] == "close":
                    break
            except socket_timeout:
                continue
            except EOFError:
                r["closed_by_peer_after_s"] = round(time.time() - t0); break
            except Exception as e:
                if "timed out" in str(e):
                    continue
                r["closed_by_peer_after_s"] = round(time.time() - t0); r["exc"] = repr(e)[:100]; break
        else:
            r["still_open_after_s"] = round(time.time() - t0)
    except Exception as e:
        r["error"] = repr(e)
    finally:
        ws.close()
    results[url] = r

import socket
socket_timeout = socket.timeout
ths = [threading.Thread(target=worker, args=(u,)) for u in URLS]
for t in ths: t.start()
for t in ths: t.join()
print(json.dumps(list(results.values()), indent=1))
