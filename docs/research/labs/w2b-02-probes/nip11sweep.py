#!/usr/bin/python3
# READ-ONLY NIP-11 sweep: HTTPS GET with Accept: application/nostr+json. Response bodies are untrusted data (only parsed as JSON).
# usage: nip11sweep.py <outdir> ; builds list from famous relays + NIP-66 census (software-diverse sample)
import sys, os, re, json, time, ssl, urllib.request, collections
from concurrent.futures import ThreadPoolExecutor
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
famous = ["relay.damus.io","nos.lol","relay.primal.net","nostr.wine","relay.nostr.band","relay.snort.social","nostr.mom","offchain.pub",
 "nostr-pub.wellorder.net","relay.current.fyi","nostr.bitcoiner.social","nostr.oxtr.dev","purplepag.es","eden.nostr.land","nostr.land","relay.noswhere.com",
 "nfdb.noswhere.com","wot.utxo.one","relay.bnos.space","relay.vantis.ninja","relay.samt.st","relay.qstr.app","relay.olas.app","relay.fundstr.me",
 "relay.nostr.watch","relay.mostr.pub","nostr.fmt.wiz.biz","relay.nostrplebs.com","brb.io","relay.0xchat.com","nostr.massmux.com","relay.orangepill.dev",
 "relay.nostrcheck.me","nostr21.com","relay.lexingtonbitcoin.org","nostr.einundzwanzig.space","relay.ditto.pub","relay.stoner.com","relay.mutinywallet.com"]
bad_tld = re.compile(r"\.(xyz|top|rest|ru|su|рф|cn|tk|ml|ga|cf|gq|work|click|link|zip|mov)$")
hostre = re.compile(r"^wss://([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(:\d+)?/?$")
cand = collections.defaultdict(list)
for fn in ("census_nostrwatch.jsonl",):
    for l in open(os.path.join(os.path.dirname(out.rstrip("/")), "nip66", fn)):
        e = json.loads(l)
        d = next((t[1] for t in e["tags"] if len(t) > 1 and t[0] == "d"), "")
        s = next((t[1] for t in e["tags"] if len(t) > 1 and t[0] == "s"), "?")
        m = hostre.match(d)
        if not m or bad_tld.search(m.group(1)): continue
        fam = ("strfry" if "strfry" in s else "nostr-rs-relay" if "nostr-rs-relay" in s else "haven" if "haven" in s else "khatru" if "khatru" in s else
               "nostream" if "nostream" in s.lower() else "pyramid" if "pyramid" in s else "wot-relay" if "wot-relay" in s else "zooid" if "zooid" in s else
               "rnostr" if "rnostr" in s else "chronicle" if "chronicle" in s else "other")
        if m.group(1) not in cand[fam]: cand[fam].append(m.group(1))
quota = {"strfry": 14, "nostr-rs-relay": 8, "haven": 4, "khatru": 5, "nostream": 5, "pyramid": 3, "wot-relay": 3, "zooid": 3, "rnostr": 2, "chronicle": 1, "other": 6}
hosts = list(dict.fromkeys(famous))
for fam, q in quota.items():
    # deterministic sample: sorted, spread
    lst = sorted(cand[fam]); step = max(1, len(lst) // q)
    hosts += [h for h in lst[::step][:q] if h not in hosts]
hosts = list(dict.fromkeys(hosts))
ctx = ssl.create_default_context()
def get(h):
    r = {"host": h}
    t = time.time()
    try:
        req = urllib.request.Request("https://%s/" % h, headers={"Accept": "application/nostr+json", "User-Agent": "magnet-web-research-probe/1.0 (NIP-11 read)", "Origin": "https://example.org"})
        with urllib.request.urlopen(req, timeout=9, context=ctx) as resp:
            body = resp.read(300000)
            r["status"] = resp.status; r["ctype"] = resp.headers.get("content-type"); r["acao"] = resp.headers.get("access-control-allow-origin")
            r["server"] = resp.headers.get("server"); r["date"] = resp.headers.get("date"); r["ms"] = round((time.time() - t) * 1000); r["bytes"] = len(body)
            try: r["doc"] = json.loads(body.decode("utf-8", "replace"))
            except Exception as e: r["parse_error"] = repr(e)[:80]; r["raw_head"] = body[:120].decode("utf-8", "replace")
    except Exception as e:
        r["error"] = "%s: %s" % (type(e).__name__, str(e)[:100]); r["ms"] = round((time.time() - t) * 1000)
    return r
with ThreadPoolExecutor(8) as ex: res = list(ex.map(get, hosts))
json.dump(res, open(os.path.join(out, "nip11_all.json"), "w"))
ok = [r for r in res if "doc" in r and isinstance(r["doc"], dict)]
print("hosts", len(hosts), "parsed", len(ok), "errors", sum("error" in r for r in res), "nonjson", sum("parse_error" in r for r in res))
