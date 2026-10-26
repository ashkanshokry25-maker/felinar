#!/usr/bin/python3
# usage: python3 -I check_webseed.py [--origin https://example.com] [--heartbeat URL] URL [URL ...]
# Health/CORS check for a BEP 19 web seed and for the .torrent used as `xs=` (stdlib only). For every URL it verifies what a browser
# loader needs (docs/review/browser-mobile.md M4, research F10):
#   1. CORS preflight (OPTIONS with Origin + Access-Control-Request-Headers: range, cache-control) is answered 2xx and allows `range`
#   2. GET with `Range: bytes=0-0` returns 206 with Content-Range, and the response carries Access-Control-Allow-Origin
#      and exposes Content-Range / Accept-Ranges (so fetch() can read them cross-origin)
#   3. a URL ending in .torrent is checked with a plain GET instead of a Range GET: 200, a bencoded dictionary (first byte 'd') and Access-Control-Allow-Origin
# Exit code 0 only when every URL passes; with --heartbeat the URL is GET after a full pass (dead-man's-switch monitors).
import sys, json, urllib.request, urllib.error, time

def req(method, url, headers, timeout=10):
    r = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as f:
            return f.status, {k.lower(): v for k, v in f.headers.items()}, f.read(65536)
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read(2048)

def check(url, origin):
    res = {"url": url, "ok": False, "checks": {}}
    ck = res["checks"]
    try:
        t0 = time.time()
        st, h, _ = req("OPTIONS", url, {"Origin": origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range, cache-control", "User-Agent": "magnet-web-webseed-check/1"})
        allow_h = h.get("access-control-allow-headers", "").lower()
        ck["preflight"] = {"status": st, "allow_origin": h.get("access-control-allow-origin"), "allow_headers": allow_h,
                           "pass": 200 <= st < 300 and h.get("access-control-allow-origin") in ("*", origin) and ("range" in allow_h or allow_h == "*")}
        is_torrent = url.split("?")[0].endswith(".torrent")
        if not is_torrent:   # the .torrent is fetched whole (xs=), only data files are range-requested by the web-seed code
            st, h, body = req("GET", url, {"Origin": origin, "Range": "bytes=0-0", "Cache-Control": "no-store", "User-Agent": "magnet-web-webseed-check/1"})
            exp = h.get("access-control-expose-headers", "").lower()
            ck["range_get"] = {"status": st, "content_range": h.get("content-range"), "accept_ranges": h.get("accept-ranges"), "allow_origin": h.get("access-control-allow-origin"), "expose": exp,
                               "ms": round((time.time() - t0) * 1000),
                               "pass": st == 206 and bool(h.get("content-range")) and h.get("access-control-allow-origin") in ("*", origin) and (("content-range" in exp and "accept-ranges" in exp) or exp == "*")}
        if is_torrent:
            st2, h2, body2 = req("GET", url, {"Origin": origin, "User-Agent": "magnet-web-webseed-check/1"})
            ck["torrent"] = {"status": st2, "bytes_read": len(body2), "bencoded_dict": body2[:1] == b"d", "allow_origin": h2.get("access-control-allow-origin"), "pass": st2 == 200 and body2[:1] == b"d" and h2.get("access-control-allow-origin") in ("*", origin)}
        res["ok"] = all(c["pass"] for c in ck.values())
    except Exception as e:
        res["error"] = repr(e)[:160]
    return res

if __name__ == "__main__":
    a = sys.argv[1:]; origin = "https://example.com"; hb = None; urls = []
    while a:
        x = a.pop(0)
        if x == "--origin": origin = a.pop(0)
        elif x == "--heartbeat": hb = a.pop(0)
        else: urls.append(x)
    if not urls:
        print(__doc__); sys.exit(2)
    out = [check(u, origin) for u in urls]
    ok = all(r["ok"] for r in out)
    print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "pass": ok, "results": out}))
    if ok and hb:
        try: urllib.request.urlopen(hb, timeout=10).read()
        except Exception as e: print(json.dumps({"heartbeat_error": repr(e)[:100]}), file=sys.stderr)
    sys.exit(0 if ok else 1)
