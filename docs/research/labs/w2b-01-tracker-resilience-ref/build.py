#!/usr/bin/python3
# usage: python3 -I build.py      Assembles ../../w2b-01-tracker-resilience.md from parts/*.md and fills the generated tables.
# Parts are ordered by file name. Markers: <!--SOAK_TABLES-->, <!--BENCH_TABLES-->, <!--STATS_COST-->.
import os, subprocess, sys, json, re
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "w2b-01-tracker-resilience.md")
def run(*a):
    return subprocess.run(["/usr/bin/python3", "-I", *a], capture_output=True, text=True, check=True).stdout.strip()
parts = sorted(f for f in os.listdir(os.path.join(HERE, "parts")) if f.endswith(".md"))
text = "\n".join(open(os.path.join(HERE, "parts", f)).read().rstrip() + "\n" for f in parts)
if "<!--SOAK_TABLES-->" in text:
    p = os.path.join(HERE, "probes", "results", "soak-2026-10-17.jsonl")
    text = text.replace("<!--SOAK_TABLES-->", run(os.path.join(HERE, "probes", "soak_summary.py"), p, "--exclude-file", os.path.join(HERE, "probes", "results", "soak-exclusions.txt")))
if "<!--SOAK_ONELINE-->" in text:
    rows = [json.loads(l) for l in open(os.path.join(HERE, "probes", "results", "soak-2026-10-17.jsonl"))]
    exc = set(l.split()[0] for l in open(os.path.join(HERE, "probes", "results", "soak-exclusions.txt")) if l.strip() and not l.startswith("#"))
    counted = [r for r in rows if r["ts"] not in exc]
    alive = ["tracker.webtorrent.dev", "tracker.openwebtorrent.com", "open.ftorrent.com", "tracker.novage.com.ua"]
    ok = {a: sum(1 for r in counted for t in r["trackers"] if t["url"].endswith(a) and "announce_rtt_ms" in t and not t.get("failure")) for a in alive}
    tot = {a: sum(1 for r in counted for t in r["trackers"] if t["url"].endswith(a)) for a in alive}
    import datetime
    t0 = datetime.datetime.strptime(rows[0]["ts"], "%Y-%m-%dT%H:%M:%SZ"); t1 = datetime.datetime.strptime(rows[-1]["ts"], "%Y-%m-%dT%H:%M:%SZ")
    line = "%d samples over %.1f hours (%d counted; %d excluded as a local fault): %s" % (len(rows), (t1 - t0).total_seconds() / 3600 + 5 / 60.0, len(counted), len(rows) - len(counted), ", ".join("%s %d/%d" % ({"tracker.webtorrent.dev": "webtorrent.dev", "tracker.openwebtorrent.com": "openwebtorrent", "open.ftorrent.com": "ftorrent", "tracker.novage.com.ua": "novage"}[a], ok[a], tot[a]) for a in alive))
    relay = [x for r in counted for x in r.get("relay", [])]
    line += "; offer->answer relay tests %d/%d passed" % (sum(1 for x in relay if x.get("offer_forwarded_to_A") and x.get("answer_forwarded_to_B")), len(relay))
    text = text.replace("<!--SOAK_ONELINE-->", line)
if "<!--BENCH_TABLES-->" in text:
    d = os.path.join(HERE, "bench", "results")
    text = text.replace("<!--BENCH_TABLES-->", run(os.path.join(HERE, "bench", "bench_summary.py"), os.path.join(d, "mem-gc.jsonl"), os.path.join(d, "throughput.log")))
if "<!--STATS_COST-->" in text:
    p = os.path.join(HERE, "bench", "results", "stats-cost.log")
    s = "(not measured)"
    if os.path.exists(p):
        for l in open(p):
            if l.strip().startswith("{"):
                j = json.loads(l)
                if j.get("statsMs"):
                    x0 = j["statsMs"]; s = "%s ms (first request, then %s) for %d peers in %d swarms - the event loop is blocked for that long on every request, and the route is public by default in the CLI (`--stats` defaults to true)." % (x0[0]["ms"], " and ".join(str(x["ms"]) + " ms" for x in x0[1:]), x0[0]["peers"], x0[0]["torrents"])
    text = text.replace("<!--STATS_COST-->", s)
for marker, kind in (("<!--TUNING_TABLE-->", "tuning"), ("<!--RECONNECT-->", "reconnect"), ("<!--DEGRADE_ENGINES-->", "degrade-engines")):
    if marker in text:
        text = text.replace(marker, run(os.path.join(HERE, "e2e", "summarize.py"), kind, os.path.join(HERE, "e2e", "results")))
open(OUT, "w").write(text)
print("wrote", OUT, len(text), "bytes from", len(parts), "parts")
