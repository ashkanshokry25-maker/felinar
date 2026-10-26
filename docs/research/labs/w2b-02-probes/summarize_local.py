#!/usr/bin/python3
# Offline summaries from data collected by the other probes (no network).
# usage: python3 -I summarize_local.py <census.jsonl> <nip11_all.json> <listrot_dir> <kinds_dir> <outdir>
#   census.jsonl   : census66.py output (NIP-66 kind 30166 events, untrusted data)
#   nip11_all.json : nip11sweep.py output
#   listrot_dir    : contains lists.json (listrot_fetch.py) and sweep.json (listrot_sweep.py)
#   kinds_dir      : kindprobe.py output (<relay>_k<kind>.jsonl)
import sys, os, json, glob, re, time, collections, statistics, urllib.parse
census, nip11, lrdir, kdir, out = sys.argv[1:6]
os.makedirs(out, exist_ok=True)
def w(name, text): open(os.path.join(out, name), "w").write(text)

# ---- 1. NIP-66 census
evs = [json.loads(l) for l in open(census)]
now = time.time(); latest = {}
for e in evs:
    d = next((t[1] for t in e["tags"] if len(t) > 1 and t[0] == "d"), None)
    if d and ((e["pubkey"], d) not in latest or e["created_at"] > latest[(e["pubkey"], d)]["created_at"]): latest[(e["pubkey"], d)] = e
byrelay = {}
for (m, d), e in latest.items():
    if d not in byrelay or e["created_at"] > byrelay[d]["created_at"]: byrelay[d] = e
tv = lambda e, n: [t[1:] for t in e["tags"] if t and t[0] == n]
def fam(s):
    s = (s or "?").lower()
    for key, name in (("strfry", "strfry"), ("nostr-rs-relay", "nostr-rs-relay"), ("haven", "haven"), ("pyramid", "pyramid"), ("wot-relay", "wot-relay"), ("khatru", "khatru-based"), ("nostream", "nostream"), ("zooid", "zooid"), ("rnostr", "rnostr"), ("chronicle", "chronicle"), ("nfdb", "NFDB"), ("memlay", "memlay"), ("ditto", "ditto")):
        if key in s: return name
    return "unknown" if s == "?" else "other"
clear = {d: e for d, e in byrelay.items() if (next((t[1] for t in e["tags"] if len(t) > 1 and t[0] == "n"), "clearnet") == "clearnet")}
L = ["events=%d monitors=%d relay_urls=%d clearnet=%d newest_age_min=%.1f oldest_age_h=%.1f" % (len(evs), len({e["pubkey"] for e in evs}), len(byrelay), len(clear), (now - max(e["created_at"] for e in evs)) / 60, (now - min(e["created_at"] for e in evs)) / 3600)]
combo = collections.Counter(); sw = collections.Counter(); nips = collections.Counter(); asn = collections.Counter(); rtt = []
for d, e in clear.items():
    R = {t[0] for t in tv(e, "R")}
    combo[(("auth" in R), ("payment" in R), ("pow" in R), ("writes" in R))] += 1
    sw[fam(next((t[1] for t in e["tags"] if len(t) > 1 and t[0] == "s"), "?"))] += 1
    for t in tv(e, "N"): nips[t[0]] += 1
    for t in e["tags"]:
        if len(t) > 2 and t[0] == "l" and t[2] == "host.as": asn[t[1][:40]] += 1
    r = [int(t[0]) for t in tv(e, "rtt-open") if t and t[0].isdigit()]
    if r: rtt.append(r[0])
L.append("(auth,payment,pow,writes) combos: %s" % combo.most_common())
L.append("software: %s" % sw.most_common())
L.append("NIP counts (of %d clearnet; count, percent): %s" % (len(clear), {n: (nips[str(n)], round(100 * nips[str(n)] / len(clear), 1)) for n in (11, 40, 42, 45, 50, 62, 65, 66, 67, 70, 77, 78, 86)}))
L.append("host.as top: %s" % asn.most_common(8))
L.append("rtt-open (freshest event per relay, n=%d) median=%s p90=%s; relays with rtt-write tag: %d; note: ages above are relative to run time" % (len(rtt), statistics.median(rtt), sorted(rtt)[int(0.9 * len(rtt))], sum(1 for e in clear.values() if tv(e, "rtt-write"))))
w("census_summary.txt", "\n".join(L) + "\n")

# ---- 2. NIP-11 sweep (limits only; contact and pubkey fields dropped)
res = json.load(open(nip11)); ok = [r for r in res if isinstance(r.get("doc"), dict)]
lim = lambda r: r["doc"].get("limitation") or {}
slim = [{"host": r["host"], "acao": r.get("acao"), "software": r["doc"].get("software"), "version": r["doc"].get("version"), "supported_nips": r["doc"].get("supported_nips"), "limitation": r["doc"].get("limitation"), "fees": r["doc"].get("fees"), "terms_of_service": r["doc"].get("terms_of_service")} for r in ok]
w("nip11_limits.json", json.dumps(slim, indent=1))
L = ["hosts=%d parsed=%d errors=%d nonjson=%d acao_star=%d" % (len(res), len(ok), sum("error" in r for r in res), sum("parse_error" in r for r in res), sum(r.get("acao") == "*" for r in ok))]
for k in ("max_message_length", "max_limit", "max_subscriptions", "max_content_length", "max_event_tags", "created_at_upper_limit", "created_at_lower_limit", "min_pow_difficulty"):
    L.append("%s: %s" % (k, collections.Counter(lim(r).get(k, "(absent)") for r in ok).most_common(12)))
for k in ("payment_required", "restricted_writes", "auth_required"): L.append("%s true: %d" % (k, sum(1 for r in ok if lim(r).get(k))))
sn = lambda r: [x for x in (r["doc"].get("supported_nips") or []) if isinstance(x, int)] if isinstance(r["doc"].get("supported_nips"), list) else []
L.append("NIP counts of %d: %s" % (len(ok), {n: sum(1 for r in ok if n in sn(r)) for n in (9, 40, 42, 45, 62, 70, 77, 86)}))
L.append("retention field present: %d" % sum(1 for r in ok if "retention" in r["doc"]))
w("nip11_distributions.txt", "\n".join(L) + "\n")

# ---- 3. list rot
lists = json.load(open(os.path.join(lrdir, "lists.json"))); sweep = json.load(open(os.path.join(lrdir, "sweep.json")))
L = ["version\thosts\tws101\tnip11ok\teither"]
for v, d in lists.items():
    hs = d["hosts"]; ws = sum(sweep[h]["ws"] == "101" for h in hs); n11 = sum(sweep[h]["nip11"] == "ok" for h in hs); ei = sum(sweep[h]["ws"] == "101" or sweep[h]["nip11"] == "ok" for h in hs)
    L.append("%s\t%d\t%d\t%d\t%d" % (v, len(hs), ws, n11, ei))
w("listrot.tsv", "\n".join(L) + "\n")

# ---- 4. kinds on major relays
L = ["relay\tkind\tn\tauthors\tsize_median\tsize_max\toldest\tnewest"]
for f in sorted(glob.glob(os.path.join(kdir, "*_k*.jsonl"))):
    m = re.match(r"(.+)_k(\d+)\.jsonl$", os.path.basename(f)); evs = [json.loads(l) for l in open(f)]
    if not evs: continue
    sizes = [len(json.dumps(e, separators=(",", ":"), ensure_ascii=False).encode()) for e in evs]; ca = [e["created_at"] for e in evs]
    L.append("%s\t%s\t%d\t%d\t%d\t%d\t%s\t%s" % (m.group(1), m.group(2), len(evs), len({e["pubkey"] for e in evs}), statistics.median(sizes), max(sizes), time.strftime("%Y-%m-%d", time.gmtime(min(ca))), time.strftime("%Y-%m-%d", time.gmtime(max(ca)))))
w("kinds_on_major_relays.tsv", "\n".join(L) + "\n")

# ---- 5. Blossom usage from kind-10063 lists
auth = {}
for f in glob.glob(os.path.join(kdir, "*_k10063.jsonl")):
    for l in open(f):
        e = json.loads(l); auth.setdefault(e["pubkey"], set()).update(t[1] for t in e["tags"] if len(t) > 1 and t[0] == "server")
c = collections.Counter()
for pk, svs in auth.items():
    for h in {urllib.parse.urlparse(s).netloc.lower() or s.lower() for s in svs}: c[h] += 1
L = ["authors=%d hosts=%d median_servers_per_author=%s" % (len(auth), len(c), statistics.median(len(v) for v in auth.values()))]
L += ["%4d\t%5.1f%%\t%s" % (n, 100 * n / len(auth), h) for h, n in c.most_common(25)]
w("blossom_server_usage.txt", "\n".join(L) + "\n")
print("wrote summaries to", out)
