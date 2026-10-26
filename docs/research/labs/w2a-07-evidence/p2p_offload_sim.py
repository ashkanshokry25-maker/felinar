#!/usr/bin/env python3
"""w2a-07: how many of a small site's bytes can come from peers instead of the web seed?

THIS IS A MODEL, NOT A MEASUREMENT.  Every parameter is an assumption or is taken from another project
document (named in PARAMS).  Run:  python3 -I p2p_offload_sim.py  > results-p2p-offload-2026-10-17.txt

What it simulates (one calendar day of visits to one site in "shell mode", ARCHITECTURE v0.2 sections 5.4 and 8):
  * visits arrive as a Poisson process, V per day (flat arrival rate; a diurnal option exists)
  * each visit dwells for a log-normal time (mean d seconds, sigma 1.0) and then closes the tab
  * a fraction p_cold of visits are first visits (empty cache) and must download the whole payload S;
    the other visits are served from IndexedDB, download nothing, and (if allowed) keep seeding while the tab is open
  * a visit can use peers or seed only if the visitor accepted the consent notice (p_consent); the first-visit
    consent click happens a log-normal time after load (the web seed download starts at once, peers only after consent)
  * only desktop visitors upload (mobile defaults to uploads off, ARCHITECTURE section 8); desktop share f_desk
  * a peer connection needs tracker + ICE (C seconds, log-normal) and succeeds with probability q
    (docs/research/03-webrtc-nat-privacy.md F-01..F-03: STUN-only, no TURN in stock WebTorrent)
  * each connected seeder delivers at most u bytes/s (policy: 1 MiB/s desktop), the web seed W bytes/s after a start latency
  * policy "race": web seed starts at once.  policy "peer-first": web seed starts after Td seconds
Outputs, per scenario: share of first-visit payload bytes that came from peers, share of first visits that got any peer
byte, mean first-visit completion time, and the host's total bytes per day with and without peers.
"""
import heapq
import math
import random
import sys

PARAMS = dict(
    p_cold=0.30,         # share of visits with an empty cache (w1-10 Appendix C planning value)
    p_consent=0.60,      # share of visitors who accept the notice. ASSUMPTION (no data), swept below
    f_desk=0.55,         # share of visits on desktop (uploads on). ASSUMPTION
    t_consent_med=4.0,   # median seconds from load to clicking OK on a first visit. ASSUMPTION
    c_med=2.2,           # median tracker+ICE+DTLS time to the first usable peer (distributed-systems review: 1.5-3 s typical)
    c_sigma=0.5,
    q=0.75,              # probability a given peer pair connects (03 F-01: vendor estimates 10-25 % need TURN; stock WebTorrent has none)
    u=1.048576e6,        # per-seeder upload cap, 1 MiB/s (ARCHITECTURE section 8, desktop)
    k_max=30,            # desktop wire cap
    ws_latency=0.4,      # web seed path with xs=: torrent fetch + first range GET (distributed-systems review: 0.3-0.6 s)
    announce_delay=3.0,  # a visitor announces after 3 s visible (ARCHITECTURE section 3.4.6)
    sigma_dwell=1.0,
    shell_cold_bytes=110e3,   # cold shell visit, brotli (w1-10 Appendix C)
    meta_bytes=4e3,           # .torrent + pointer
)


def lognorm(rnd, mean, sigma):
    mu = math.log(mean) - sigma * sigma / 2
    return rnd.lognormvariate(mu, sigma)


def lognorm_med(rnd, med, sigma):
    return rnd.lognormvariate(math.log(med), sigma)


def simulate(V, d, S, W, policy="race", Td=0.0, seed=1, P=PARAMS, diurnal=False, window_s=86400):
    rnd = random.Random(seed)
    # arrivals
    arr = []
    if diurnal:
        # rate multiplier 1 + 0.7*sin(2 pi (t-9h)/24h): peak about 15:00, trough about 03:00; thinning against max 1.7
        while len(arr) < V:
            t = rnd.uniform(0, 86400)
            m = 1 + 0.7 * math.sin(2 * math.pi * (t - 9 * 3600) / 86400)
            if rnd.random() < m / 1.7:
                arr.append(t)
    else:
        arr = [rnd.uniform(0, window_s) for _ in range(V)]
    arr.sort()
    t_complete_ws = P["ws_latency"] + S / W   # conservative completion time used only to place seeder windows
    visits = []
    for a in arr:
        cold = rnd.random() < P["p_cold"]
        consent = rnd.random() < P["p_consent"]
        desk = rnd.random() < P["f_desk"]
        dwell = lognorm(rnd, d, P["sigma_dwell"])
        t_cons = a + (lognorm_med(rnd, P["t_consent_med"], 0.6) if cold else 0.0)
        visits.append(dict(a=a, cold=cold, consent=consent, desk=desk, dwell=dwell, t_cons=t_cons))
    # seeder windows (start, end)
    wins = []
    for i, v in enumerate(visits):
        if not (v["consent"] and v["desk"]):
            continue
        done = v["a"] + (t_complete_ws if v["cold"] else 0.0)
        start = max(done, v["t_cons"]) + P["announce_delay"]
        end = v["a"] + v["dwell"]
        if end > start:
            wins.append((start, end, i))
    wins.sort()
    # queries: cold visits with consent look for peers at t_q = t_cons + C
    queries = []
    for i, v in enumerate(visits):
        if v["cold"] and v["consent"]:
            c = lognorm_med(rnd, P["c_med"], P["c_sigma"])
            queries.append((v["t_cons"] + c, i))
    queries.sort()
    heap = []  # (end, i)
    wi = 0
    peers_for = {}
    for tq, i in queries:
        while wi < len(wins) and wins[wi][0] <= tq:
            heapq.heappush(heap, (wins[wi][1], wins[wi][2]))
            wi += 1
        while heap and heap[0][0] <= tq:
            heapq.heappop(heap)
        cand = [(e - tq) for (e, j) in heap if j != i]
        conn = [r for r in cand if rnd.random() < P["q"]][: P["k_max"]]
        peers_for[i] = (tq - visits[i]["a"], conn)  # (peer path start relative to arrival, remaining times)
    # per cold visit download
    tot_cold = 0
    peer_bytes = 0.0
    n_any_peer = 0
    n_have_seeder = 0
    sum_T = 0.0
    sum_T_ws_only = 0.0
    for i, v in enumerate(visits):
        if not v["cold"]:
            continue
        tot_cold += 1
        ws_start = P["ws_latency"] if policy == "race" else max(P["ws_latency"], Td)
        rel, conn = peers_for.get(i, (None, []))
        events = {0.0, ws_start}
        if conn:
            events.add(rel)
            for r in conn:
                events.add(rel + r)
        ev = sorted(events)
        got = 0.0
        pb = 0.0
        T = None
        for k, t0 in enumerate(ev):
            t1 = ev[k + 1] if k + 1 < len(ev) else float("inf")
            rate_ws = W if t0 >= ws_start else 0.0
            npeers = sum(1 for r in conn if rel <= t0 < rel + r) if conn else 0
            rate_p = P["u"] * npeers
            rate = rate_ws + rate_p
            if rate <= 0:
                continue
            need = S - got
            if rate * (t1 - t0) >= need:
                dt = need / rate
                pb += rate_p * dt
                got = S
                T = t0 + dt
                break
            got += rate * (t1 - t0)
            pb += rate_p * (t1 - t0)
        peer_bytes += pb
        if pb > 0:
            n_any_peer += 1
        if conn:
            n_have_seeder += 1
        sum_T += T
        sum_T_ws_only += ws_start + S / W
    N = len(visits)
    cold_payload = tot_cold * S
    host_with = tot_cold * (P["shell_cold_bytes"] + P["meta_bytes"]) + (cold_payload - peer_bytes)
    host_without = tot_cold * (P["shell_cold_bytes"] + P["meta_bytes"]) + cold_payload
    return dict(
        visits=N, cold=tot_cold,
        p2p_share_payload=peer_bytes / cold_payload if cold_payload else 0.0,
        share_cold_visits_with_any_peer_byte=n_any_peer / tot_cold if tot_cold else 0.0,
        share_cold_visits_with_connected_seeder=n_have_seeder / tot_cold if tot_cold else 0.0,
        mean_T=sum_T / tot_cold if tot_cold else 0.0,
        mean_T_ws_only=sum_T_ws_only / tot_cold if tot_cold else 0.0,
        host_gb_day_with=host_with / 1e9, host_gb_day_without=host_without / 1e9,
        host_saving=1 - host_with / host_without if host_without else 0.0,
    )


def fmt(r):
    return ("p2p_payload=%5.1f%%  cold_with_any_peer_byte=%5.1f%%  cold_with_connected_seeder=%5.1f%%  mean_T=%6.2fs (ws-only %6.2fs)  host_saving=%5.1f%%  host_GB/day %.3f -> %.3f"
            % (100 * r["p2p_share_payload"], 100 * r["share_cold_visits_with_any_peer_byte"], 100 * r["share_cold_visits_with_connected_seeder"],
               r["mean_T"], r["mean_T_ws_only"], 100 * r["host_saving"], r["host_gb_day_without"], r["host_gb_day_with"]))


def avg(runs, **kw):
    rs = [simulate(seed=s, **kw) for s in runs]
    keys = rs[0].keys()
    return {k: sum(r[k] for r in rs) / len(rs) for k in keys}


if __name__ == "__main__":
    MB = 1e6
    seeds = range(1, 4)
    print("# w2a-07 P2P offload model (assumptions in PARAMS; this is a model, not a measurement)")
    print("# PARAMS:", {k: v for k, v in PARAMS.items()})
    print()
    print("## A. Race policy (web seed at once), mean dwell 60 s, web seed 2.5 MB/s (about 20 Mbit/s), by visits/day and payload size")
    for S_mb in (0.5, 5, 25, 100):
        print("### payload S = %g MB" % S_mb)
        for V in (100, 300, 1000, 3000, 10000, 30000, 100000):
            r = avg(seeds, V=V, d=60.0, S=S_mb * MB, W=2.5 * MB)
            print("V=%6d/day  " % V + fmt(r))
    print()
    print("## B. Same, web seed 8 MB/s (about 64 Mbit/s)")
    for S_mb in (5, 25, 100):
        print("### payload S = %g MB" % S_mb)
        for V in (1000, 10000, 100000):
            r = avg(seeds, V=V, d=60.0, S=S_mb * MB, W=8 * MB)
            print("V=%6d/day  " % V + fmt(r))
    print()
    print("## C. Sensitivity of a 5 MB site at 10,000 visits/day (race, W=2.5 MB/s)")
    base = dict(V=10000, d=60.0, S=5 * MB, W=2.5 * MB)
    for label, over in (("dwell 30 s", dict(d=30.0)), ("dwell 60 s (base)", {}), ("dwell 120 s", dict(d=120.0)), ("dwell 300 s", dict(d=300.0))):
        kw = dict(base); kw.update(over)
        print("%-26s" % label + fmt(avg(seeds, **kw)))
    for label, pc in (("consent 30 %", 0.3), ("consent 60 % (base)", 0.6), ("consent 90 %", 0.9), ("consent 100 %", 1.0)):
        P2 = dict(PARAMS); P2["p_consent"] = pc
        print("%-26s" % label + fmt(avg(seeds, P=P2, **base)))
    for label, fd in (("desktop 25 %", 0.25), ("desktop 55 % (base)", 0.55), ("desktop 90 %", 0.9)):
        P2 = dict(PARAMS); P2["f_desk"] = fd
        print("%-26s" % label + fmt(avg(seeds, P=P2, **base)))
    for label, q in (("pair success 50 %", 0.5), ("pair success 75 % (base)", 0.75), ("pair success 95 %", 0.95)):
        P2 = dict(PARAMS); P2["q"] = q
        print("%-26s" % label + fmt(avg(seeds, P=P2, **base)))
    print("%-26s" % "diurnal (peak x1.7)" + fmt(avg(seeds, diurnal=True, **base)))
    print()
    print("## D. Peer-first policy (web seed starts after Td), 5 MB and 25 MB, mean dwell 60 s, W=2.5 MB/s")
    for S_mb in (5, 25):
        for V in (1000, 10000, 100000):
            for Td in (0.0, 3.0, 8.0, 15.0):
                r = avg(seeds, V=V, d=60.0, S=S_mb * MB, W=2.5 * MB, policy="peer-first" if Td else "race", Td=Td)
                print("S=%3g MB V=%6d/day Td=%4.1fs  " % (S_mb, V, Td) + fmt(r))
    print()
    print("## E. Best case: everyone consents, everyone is desktop, all pairs connect, dwell 300 s, peer-first Td=8 s (upper bound for this design)")
    P3 = dict(PARAMS); P3.update(p_consent=1.0, f_desk=1.0, q=1.0, t_consent_med=0.5)
    for S_mb in (5, 25):
        for V in (100, 1000, 10000, 100000):
            r = avg(seeds, V=V, d=300.0, S=S_mb * MB, W=2.5 * MB, policy="peer-first", Td=8.0, P=P3)
            print("S=%3g MB V=%6d/day  " % (S_mb, V) + fmt(r))

    print()
    print("## F. Visitor link speed (web seed throughput W) for a 5 MB and a 25 MB site at 10,000 visits/day, race policy, dwell 60 s")
    for S_mb in (5, 25):
        for W_mb in (0.25, 0.5, 1.0, 2.5, 8.0):
            r = avg(seeds, V=10000, d=60.0, S=S_mb * MB, W=W_mb * MB)
            print("S=%3g MB W=%5.2f MB/s (%5.1f Mbit/s)  " % (S_mb, W_mb, W_mb * 8) + fmt(r))
    print()
    print("## G. Break-even payload: smallest S (MB) at which peers carry at least 25 % of first-visit bytes, race policy, W=2.5 MB/s, V=100000/day, dwell 120 s, everyone consents and is desktop")
    P4 = dict(PARAMS); P4.update(p_consent=1.0, f_desk=1.0)
    for S_mb in (5, 10, 20, 40, 80, 120):
        r = avg(seeds, V=100000, d=120.0, S=S_mb * MB, W=2.5 * MB, P=P4)
        print("S=%4g MB  " % S_mb + fmt(r))

    print()
    print("## H. Traffic spike: 50,000 visits inside ONE hour (front-page day), 90 % cold (first-time visitors), dwell 60 s, W=2.5 MB/s")
    P5 = dict(PARAMS); P5.update(p_cold=0.9)
    for S_mb in (5, 25, 100):
        for pol, Td in (("race", 0.0), ("peer-first", 8.0)):
            r = avg(seeds, V=50000, d=60.0, S=S_mb * MB, W=2.5 * MB, policy=pol, Td=Td, P=P5, window_s=3600)
            print("S=%3g MB %-10s Td=%3.1fs  " % (S_mb, pol, Td) + fmt(r))
