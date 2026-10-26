import re, sys, subprocess, urllib.parse
def curl(args, timeout=25):
    p = subprocess.run(["curl","-s","--max-time",str(timeout),"-D","-","-o","/dev/null"]+args, capture_output=True, text=True)
    hdr = {}; status = None
    for line in p.stdout.replace("\r","").split("\n"):
        if line.startswith("HTTP/"): status = line.split()[1]; hdr = {}
        elif ":" in line:
            k,v = line.split(":",1); hdr[k.strip().lower()] = v.strip()
    return status, hdr
def body(url):
    p = subprocess.run(["curl","-s","--max-time","25","-L","-H","Accept-Encoding: identity",url], capture_output=True, text=True)
    return p.stdout
def pick_asset(home):
    html = body(home)
    cands = re.findall(r'(?:src|href)="([^"]+\.(?:js|css)(?:\?[^"]*)?)"', html)
    # prefer same-host absolute or root-relative
    host = urllib.parse.urlparse(home).netloc
    for c in cands:
        u = urllib.parse.urljoin(home, c)
        if urllib.parse.urlparse(u).netloc == host: return u
    return None
def probe(label, url):
    s_id, h_id = curl(["-H","Range: bytes=0-99","-H","Accept-Encoding: identity",url])
    s_gz, h_gz = curl(["-H","Range: bytes=0-99","-H","Accept-Encoding: gzip, br",url])
    s_get, h_get = curl(["-H","Origin: https://example.org",url])
    s_pf, h_pf = curl(["-X","OPTIONS","-H","Origin: https://example.org","-H","Access-Control-Request-Method: GET","-H","Access-Control-Request-Headers: cache-control,range",url])
    tot = lambda h: (h.get("content-range","-").split("/")[-1])
    srv = h_id.get("server") or h_id.get("via","?")
    print(f"{label:22s} {url[:70]}")
    print(f"   server/via: {srv[:40]} | via: {h_id.get('via','-')[:30]}")
    print(f"   Range+identity : {s_id} total={tot(h_id)} ce={h_id.get('content-encoding','-')}")
    print(f"   Range+gzip,br  : {s_gz} total={tot(h_gz)} ce={h_gz.get('content-encoding','-')}  {'<-- Content-Range over COMPRESSED bytes' if h_gz.get('content-encoding') and s_gz=='206' else ''}")
    print(f"   GET ACAO       : {h_get.get('access-control-allow-origin','-')}  (expose={h_get.get('access-control-expose-headers','-')})")
    print(f"   OPTIONS preflight: {s_pf} ACAO={h_pf.get('access-control-allow-origin','-')} ACAH={h_pf.get('access-control-allow-headers','-')} ACAM={h_pf.get('access-control-allow-methods','-')}")
    print(f"   cache-control  : {h_id.get('cache-control','-')}")
targets = [
 ("GitHub Pages",     "https://pages.github.com/", None),
 ("Vercel",           "https://nextjs.org/", None),
 ("Netlify",          "https://www.netlify.com/", None),
 ("Cloudflare (CDN)", "https://developers.cloudflare.com/", None),
 ("GitLab Pages",     "https://gitlab-org.gitlab.io/gitlab-ui/", None),
 ("CloudFront/S3",    "https://aws.amazon.com/", None),
 ("Firebase Hosting", "https://firebase.google.com/", None),
 ("Fastly/jsDelivr",  "https://cdn.jsdelivr.net/npm/webtorrent@3.0.21/dist/webtorrent.min.js", "direct"),
]
for label, home, mode in targets:
    url = home if mode == "direct" else pick_asset(home)
    if not url: print(f"{label:22s} could not discover an asset on {home}\n"); continue
    probe(label, url); print()
