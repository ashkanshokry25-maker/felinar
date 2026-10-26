#!/usr/bin/python3
# usage: python3 -I soak_summary.py results/soak-2026-10-17.jsonl   -> Markdown tables (per-tracker success rate and latency) on stdout
import sys, json, statistics as st
# usage: soak_summary.py results.jsonl [--exclude TS[,TS...]]   (excluded samples are reported separately: use for samples that
# coincided with a known LOCAL fault, e.g. my own load test exhausting ephemeral ports; the raw file is never edited)
EXC = set(); WHY = {}
if "--exclude" in sys.argv:
    EXC = set(sys.argv[sys.argv.index("--exclude") + 1].split(","))
if "--exclude-file" in sys.argv:   # lines: <timestamp> <free-text reason>
    for ln in open(sys.argv[sys.argv.index("--exclude-file") + 1]):
        if ln.strip() and not ln.startswith("#"):
            ts, _, why = ln.strip().partition(" "); EXC.add(ts); WHY[ts] = why
all_rows = [json.loads(l) for l in open(sys.argv[1])]
rows = [r for r in all_rows if r["ts"] not in EXC]
excluded = [r for r in all_rows if r["ts"] in EXC]
by = {}
for r in rows:
    for t in r["trackers"]:
        d = by.setdefault(t["url"], {"n": 0, "ok": 0, "rtt": [], "up": [], "tls": [], "int": set(), "errs": []})
        d["n"] += 1
        if "announce_rtt_ms" in t and not t.get("failure"):
            d["ok"] += 1; d["rtt"].append(t["announce_rtt_ms"]); d["up"].append(t.get("upgrade_ms") or 0); d["tls"].append(t.get("tls_ms") or 0)
            if t.get("interval"): d["int"].add(t["interval"])
        else:
            d["errs"].append((r["ts"][11:19], t.get("error") or t.get("http_status") or t.get("announce_error") or t.get("dns_error") or t.get("failure")))
def pct(a, p):
    a = sorted(a); k = (len(a) - 1) * p / 100.0; f = int(k); c = min(f + 1, len(a) - 1)
    return round(a[f] + (a[c] - a[f]) * (k - f))
print("| Tracker | Samples | OK | Announce RTT p50 / p95 / max (ms) | TLS handshake p50 (ms) | Told interval (s) |")
print("|---|---|---|---|---|---|")
for url, d in by.items():
    if d["rtt"]:
        print("| `%s` | %d | %d (%.0f%%) | %d / %d / %d | %d | %s |" % (url, d["n"], d["ok"], 100.0 * d["ok"] / d["n"], pct(d["rtt"], 50), pct(d["rtt"], 95), max(d["rtt"]), pct(d["tls"], 50), ",".join(str(i) for i in sorted(d["int"]))))
    else:
        print("| `%s` | %d | 0 (0%%) | - | - | - (%s) |" % (url, d["n"], d["errs"][0][1] if d["errs"] else "?"))
rel = {}
for r in rows:
    for x in r.get("relay", []):
        d = rel.setdefault(x["url"], {"n": 0, "ok": 0, "off": [], "ans": []})
        d["n"] += 1
        if x.get("offer_forwarded_to_A") and x.get("answer_forwarded_to_B"):
            d["ok"] += 1; d["off"].append(x["offer_forward_ms"]); d["ans"].append(x["answer_forward_ms"])
print()
print("| Tracker | Offer->answer relay tests | Passed | Offer relay ms (median) | Answer relay ms (median) |")
print("|---|---|---|---|---|")
for url, d in rel.items():
    print("| `%s` | %d | %d | %s | %s |" % (url, d["n"], d["ok"], pct(d["off"], 50) if d["off"] else "-", pct(d["ans"], 50) if d["ans"] else "-"))
print()
print("Window: %s .. %s UTC, %d samples counted. Failures counted: %s" % (rows[0]["ts"], rows[-1]["ts"], len(rows), "; ".join("%s %s: %s" % (u.split('//')[1], ts, e) for u, d in by.items() for ts, e in d["errs"][:3]) or "none"))
for r in excluded:
    print("Excluded as a local fault: sample %s (%s)%s" % (r["ts"], "; ".join("%s: %s" % (t["url"].split('//')[1], t.get("error") or t.get("announce_error") or "ok") for t in r["trackers"]), (" - reason: " + WHY[r["ts"]]) if r["ts"] in WHY else ""))
# operator-side load trend
tr = [(r["ts"][11:16], r["stats"]) for r in rows if r.get("stats")]
def first_last(key, f):
    v = [(ts, f(s[key])) for ts, s in tr if key in s and f(s[key]) is not None]
    return (v[0], v[-1], max(x[1] for x in v), min(x[1] for x in v)) if v else None
print()
for key in ("tracker.openwebtorrent.com", "tracker.novage.com.ua"):
    fl = first_last(key, lambda s: s.get("sockets") if isinstance(s, dict) else None)
    if fl: print("- %s open WebSockets: first %s=%d, last %s=%d, min %d, max %d" % (key, fl[0][0], fl[0][1], fl[1][0], fl[1][1], fl[3], fl[2]))
