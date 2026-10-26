import json, sys, statistics as st, collections
base = sys.argv[1]
for p in ['en.wikipedia','de.wikipedia','fa.wikipedia','ja.wikipedia']:
    d = json.load(open(f'{base}/{p}.json'))['items']
    # timestamp YYYYMMDDHH, views
    rows = [(r['timestamp'], r['views']) for r in d]
    views = [v for _, v in rows]
    mean = st.mean(views)
    peak = max(views)
    # daily: group by YYYYMMDD
    days = collections.defaultdict(list)
    for ts, v in rows:
        days[ts[:8]].append(v)
    full = {k: v for k, v in days.items() if len(v) == 24}
    peak_share = [max(v) / sum(v) for v in full.values()]
    trough_share = [min(v) / sum(v) for v in full.values()]
    daily_peak_over_mean = [max(v) / (sum(v) / 24) for v in full.values()]
    # hour-of-day profile (UTC) averaged over full days
    prof = [st.mean([v[h] for v in full.values()]) for h in range(24)]
    pm = sum(prof) / 24
    print(f'{p}: hours={len(rows)} fulldays={len(full)} mean_hourly={mean:,.0f} global_peak={peak:,} peak/mean={peak/mean:.2f}')
    print(f'   per-day: median(peak-hour share of day)={st.median(peak_share)*100:.2f}%  median(peak/mean in day)={st.median(daily_peak_over_mean):.2f}  median(trough share)={st.median(trough_share)*100:.2f}%')
    print(f'   avg hour-of-day profile (UTC): max/mean={max(prof)/pm:.2f} at {prof.index(max(prof)):02d}h, min/mean={min(prof)/pm:.2f} at {prof.index(min(prof)):02d}h')
