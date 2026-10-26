#!/usr/bin/python3
# usage: python3 -I soak.py <out.jsonl> <interval_s> <samples> [--relay-every=3]
# Polite multi-sample liveness probe for public WebSocket trackers (research 2026-10-17, wave 2b).
# Per sample and tracker: DNS ms, TCP ms, TLS ms, WS upgrade ms, announce RTT (numwant 0, no offers: what a
# health check should send, NOT scrape) and every Nth sample a 2-peer offer->answer relay in a private random swarm.
# Also GETs the operators' public stats endpoints (one small request each) to log load trends.
# Load on third parties per sample: <= 3 short WebSocket connections per tracker, a few KB. Stdlib only.
import sys, os, json, time, socket, random, urllib.request
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "02-wss-trackers-probes"))
import wsprobe as W
import relaytest as R

OUT, INTERVAL, SAMPLES = sys.argv[1], float(sys.argv[2]), int(sys.argv[3])
RELAY_EVERY = 3
for a in sys.argv[4:]:
    if a.startswith("--relay-every="):
        RELAY_EVERY = int(a.split("=", 1)[1])

ALIVE = ["wss://tracker.webtorrent.dev", "wss://tracker.openwebtorrent.com", "wss://open.ftorrent.com", "wss://tracker.novage.com.ua"]
EDGE = ["wss://tracker.btorrent.xyz", "wss://tracker.files.fm:7073/announce"]  # sampled on the first and last round only
STATS = {
    "tracker.openwebtorrent.com": "https://tracker.openwebtorrent.com/stats.json",
    "tracker.novage.com.ua": "https://tracker.novage.com.ua/stats.json",
    "open.ftorrent.com": "https://open.ftorrent.com/page.json",
}

def one(url):
    r = {"url": url}
    host = url.split("://", 1)[1].split("/")[0].split(":")[0]
    t = time.time()
    try:
        socket.getaddrinfo(host, 443)
        r["dns_ms"] = round((time.time() - t) * 1000)
    except Exception as e:
        r["dns_error"] = repr(e)[:80]
        return r
    p = W.probe(url, origin="https://example.org", do_announce=False)  # upgrade only
    for k in ("tcp_ms", "tls_ms", "upgrade_ms", "http_status", "error", "tls_version", "cert_notAfter"):
        if k in p:
            r[k] = p[k]
    if not p.get("ws_upgrade_ok"):
        return r
    # announce RTT with numwant 0 (health-check style)
    u = url.split("://", 1)[1]
    hostport, _, path = u.partition("/"); path = "/" + path
    h, _, port = hostport.partition(":"); port = int(port) if port else 443
    ws = W.WS(h, port, path, timeout=8.0, origin="https://example.org")
    try:
        if ws.connect():
            ih = "".join(chr(random.randint(0, 255)) for _ in range(20))
            pid = "-MW0001-" + "".join(random.choice("abcdefghijklmnopqrstuvwxyz0123456789") for _ in range(12))
            t = time.time()
            ws.send_text(json.dumps({"action": "announce", "info_hash": ih, "peer_id": pid, "uploaded": 0, "downloaded": 0, "left": 1, "event": "started", "numwant": 0, "offers": []}, ensure_ascii=False))
            m = ws.recv_msg(8)
            r["announce_rtt_ms"] = round((time.time() - t) * 1000)
            if m[0] == "text":
                j = json.loads(m[1]); r["interval"] = j.get("interval"); r["failure"] = j.get("failure reason")
            else:
                r["announce_close"] = str(m)[:80]
    except Exception as e:
        r["announce_error"] = repr(e)[:100]
    finally:
        ws.close()
    return r

def stats(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "magnet-web-research-probe/1.0 (soak, 1 req/5min)"})
        with urllib.request.urlopen(req, timeout=10) as f:
            return json.loads(f.read().decode())
    except Exception as e:
        return {"error": repr(e)[:100]}

with open(OUT, "a") as fh:
    for i in range(SAMPLES):
        t0 = time.time()
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "i": i, "trackers": []}
        urls = ALIVE + (EDGE if i in (0, SAMPLES - 1) else [])
        for u in urls:
            rec["trackers"].append(one(u))
            time.sleep(0.7)
        if RELAY_EVERY and i % RELAY_EVERY == 0:
            rec["relay"] = []
            for u in ALIVE:
                try:
                    rr = R.run(u)
                except Exception as e:
                    rr = {"url": u, "error": repr(e)[:80]}
                rec["relay"].append({k: rr.get(k) for k in ("url", "offer_forwarded_to_A", "offer_forward_ms", "answer_forwarded_to_B", "answer_forward_ms", "error", "upgrade")})
                time.sleep(0.7)
        rec["stats"] = {}
        for k, u in STATS.items():
            s = stats(u)
            if k == "tracker.openwebtorrent.com" and isinstance(s, dict) and "servers" in s:
                rec["stats"][k] = {"sockets": sum((x.get("webSocketsCount") or 0) for x in s["servers"]), "peers": s.get("peersCount"), "torrents": s.get("torrentsCount")}
            elif k == "tracker.novage.com.ua" and isinstance(s, dict) and "servers" in s:
                rec["stats"][k] = {"sockets": sum((x.get("webSocketsCount") or 0) for x in s["servers"]), "peers": s.get("peersCount"), "torrents": s.get("torrentsCount")}
            else:
                rec["stats"][k] = {kk: s.get(kk) for kk in list(s)[:6]} if isinstance(s, dict) else str(s)[:80]
        fh.write(json.dumps(rec) + "\n"); fh.flush()
        if i < SAMPLES - 1:
            time.sleep(max(1.0, INTERVAL - (time.time() - t0)))
