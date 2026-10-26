#!/usr/bin/python3
# usage: python3 -I summarize.py tuning|reconnect|degrade-engines results-dir      -> Markdown snippet for the research document
import sys, json, os, re
kind, d = sys.argv[1], sys.argv[2]
def lines(name):
    p = os.path.join(d, name)
    return [l.rstrip("\n") for l in open(p)] if os.path.exists(p) else []
if kind == "tuning":
    rows = [json.loads(l) for l in lines("tuning.log") if l.startswith("{")]
    print("| Policy (3 trackers, announce interval scaled to 10 s; x12 for the real 120 s) | RTCPeerConnections, page alone, 30 s | Bytes sent to trackers, alone, 30 s | Time for a joiner's first WebRTC wire | RTCPeerConnections per page, 2 peers connected, 30 s | Tracker bytes sent / received by page A, connected, 30 s |")
    print("|---|---|---|---|---|---|")
    for r in rows:
        a, c = r["alone30s"], r["connected30s"]
        print("| %s | %d | %d | %s ms | %d (A) / %d (B) | %d / %d |" % (r["policy"], a["rtcPeerConnections"], a["bytesSentToTrackers"], r["timeToFirstWebRtcWireForJoinerMs"], c["rtcPeerConnectionsPageA"], c["rtcPeerConnectionsPageB"], c["bytesSentA"], c["bytesReceivedA"]))
    ob = [r["medianOfferJsonBytes"] for r in rows if r.get("medianOfferJsonBytes")]
    if ob: print("\nMedian size of one offer inside an announce frame (JSON, real Chromium 156 SDP with ICE complete, loopback host candidates): %d-%d bytes." % (min(ob), max(ob)))
elif kind == "reconnect":
    for name, label in (("reconnect-stock.log", "stock WebTorrent 3.0.21 / bittorrent-tracker 11.2.3"), ("reconnect-patched.log", "per-instance `_startReconnectTimer` override (500 ms + U(0, min(60 s, 1 s x 2^retries)))")):
        for l in lines(name):
            if l.startswith('{"mode"'):
                j = json.loads(l)
                print("- **%s**: %d clients, tracker killed (SIGKILL) for 2 s and restarted on the same port; seconds until each client was back on the tracker: %s; median %s s, max %s s, never back within the window: %d." % (label, j["N"], ", ".join(str(x) for x in j["reconnectedAfterSeconds"]), j["median"], j["max"], j["notReconnected"]))
elif kind == "degrade-engines":
    out = []
    for name, eng in (("degrade-chromium.log", "Chromium (default OPFS chunk store)"), ("degrade-chromium-memstore.log", "Chromium (custom in-memory chunk store)"), ("degrade-webkit.log", "WebKit (default chunk store)"), ("degrade-webkit-memstore.log", "WebKit (custom in-memory chunk store)"), ("degrade-firefox.log", "Firefox")):
        L = lines(name)
        if not L: continue
        if not any(l.startswith("{") for l in L):
            out.append("%s: **could not be run** (Playwright's Firefox build 1555 exits at launch with 'Could not find profile folder', also with a different TMPDIR; unverified)" % eng); continue
        ver = next((l for l in L if l.startswith("browser:")), "").replace("browser: ", "")
        res = {}
        for l in L:
            if l.startswith("{"):
                j = json.loads(l); res[j["label"][0]] = j
        def ok(k): return k in res and res[k]["done"]
        errs = sorted({e.split("[", 1)[1].rstrip("]") for k in res for e in res[k]["events"] if ":error[" in e})
        good = "".join(k for k in "CDEFGH" if ok(k))
        out.append("%s, %s: scenarios C-H (xs+ws with a dead / black-hole / mute / alive / absent / NXDOMAIN tracker) completed in **%d of 6**%s; A and B (no `xs`) %s; I (`xs` without `ws`) %s" % (eng, ver.split(" (")[0], len(good), (" (failed: " + ",".join(k for k in "CDEFGH" if not ok(k)) + "; error \"" + "; ".join(errs) + "\")") if len(good) < 6 else "", "did not complete (as expected)" if not ok("A") and not ok("B") else "COMPLETED (unexpected)", "stalled after metadata (as expected)" if not ok("I") else "COMPLETED (unexpected)"))
    print("\n".join("- " + o for o in out) if out else "(not run)")
