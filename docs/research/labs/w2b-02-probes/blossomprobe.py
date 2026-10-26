#!/usr/bin/python3
# READ-ONLY Blossom probe. For top servers: OPTIONS preflight (as a browser would for fetch with Range/Cache-Control),
# GET Range bytes=0-63 for real public blobs taken from nsite manifests that list that server, HEAD /upload preflight (BUD-06, no body).
import sys, json, glob, re, urllib.parse, urllib.request, urllib.error, ssl, collections, time, hashlib
ctx = ssl.create_default_context()
HOSTS = sys.argv[1].split(",")
ev_files = glob.glob(sys.argv[2] + "/*_k15128.jsonl") + glob.glob(sys.argv[2] + "/*_k35128.jsonl")
pairs = collections.defaultdict(list)   # host -> [sha256]
for f in ev_files:
    for l in open(f):
        e = json.loads(l)
        servers = {urllib.parse.urlparse(t[1]).netloc.lower() for t in e["tags"] if len(t) > 1 and t[0] == "server"}
        blobs = [t[2] for t in e["tags"] if len(t) >= 3 and t[0] == "path" and re.fullmatch(r"[0-9a-f]{64}", t[2])]
        for h in servers:
            for b in blobs[:3]:
                if b not in pairs[h]: pairs[h].append(b)
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ctx))
def req(method, url, headers, timeout=12, hops=3):
    chain = []
    for _ in range(hops + 1):
        r = urllib.request.Request(url, method=method, headers=dict(headers, **{"User-Agent": "magnet-web-research-probe/1.0 (blossom read-only)"}))
        try:
            resp = opener.open(r, timeout=timeout); code = resp.status; hd = {k.lower(): v for k, v in resp.headers.items()}; body = resp.read(200) if method == "GET" else b""
        except urllib.error.HTTPError as e:
            code = e.code; hd = {k.lower(): v for k, v in e.headers.items()}; body = e.read(200) if method == "GET" else b""
        except Exception as ex:
            return {"error": "%s: %s" % (type(ex).__name__, str(ex)[:80]), "chain": chain}
        if code in (301, 302, 303, 307, 308) and "location" in hd:
            chain.append((code, urllib.parse.urlparse(urllib.parse.urljoin(url, hd["location"])).netloc)); url = urllib.parse.urljoin(url, hd["location"]); continue
        return {"code": code, "hd": hd, "n": len(body), "chain": chain, "final": urllib.parse.urlparse(url).netloc}
    return {"error": "too many redirects", "chain": chain}
want = ["access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods", "access-control-expose-headers", "access-control-max-age", "accept-ranges", "content-range", "content-length", "content-type", "cache-control", "sunset", "x-reason", "server"]
for h in HOSTS:
    row = {"host": h}
    pf = req("OPTIONS", "https://%s/%s" % (h, "0" * 64), {"Origin": "https://example.org", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range,cache-control,user-agent"})
    row["preflight"] = {k: pf.get("hd", {}).get(k) for k in want if pf.get("hd", {}).get(k)} | {"code": pf.get("code"), "err": pf.get("error")}
    bl = pairs.get(h, [])[:2]
    row["blobs_tested"] = len(bl); row["gets"] = []
    for b in bl:
        g = req("GET", "https://%s/%s" % (h, b), {"Origin": "https://example.org", "Range": "bytes=0-63"})
        row["gets"].append({"sha": b[:10], "code": g.get("code"), "redir": g.get("chain"), "final": g.get("final"), "got_bytes": g.get("n"), "err": g.get("error"),
                            "h": {k: g.get("hd", {}).get(k) for k in want if g.get("hd", {}).get(k)}})
    up = req("HEAD", "https://%s/upload" % h, {"Origin": "https://example.org", "X-SHA-256": "0" * 64, "X-Content-Length": "314572800", "X-Content-Type": "application/octet-stream"})
    row["head_upload_300MB"] = {"code": up.get("code"), "x-reason": up.get("hd", {}).get("x-reason"), "err": up.get("error")}
    up2 = req("HEAD", "https://%s/upload" % h, {"Origin": "https://example.org", "X-SHA-256": "0" * 64, "X-Content-Length": "2097152", "X-Content-Type": "application/octet-stream"})
    row["head_upload_2MB"] = {"code": up2.get("code"), "x-reason": up2.get("hd", {}).get("x-reason"), "err": up2.get("error")}
    print(json.dumps(row)); sys.stdout.flush(); time.sleep(0.5)
