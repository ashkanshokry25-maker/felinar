# VERIFY claim 3: how late do GitHub Actions `schedule` runs actually start? Reads the PUBLIC Actions pages (HTML with embedded JSON,
# no API quota) of four public workflows and compares each run's createdAt with its nominal cron slot. Run: python3 -I gh-sched-delay.py
# Caveat: small, uncontrolled sample (4 workflows, different repos/orgs); it shows magnitudes, not a model of GitHub's scheduler.
import re, json, subprocess, datetime as dt, statistics, tempfile, os
UA = 'Mozilla/5.0 (factcheck)'
TARGETS = [  # (repo, workflow file, cron as published in that repo, nominal-slot rule, pages of ~25 runs)
    ('home-assistant/core', 'lock.yml',  '0 * * * *',    'hourly', 6),
    ('home-assistant/core', 'stale.yml', '0 * * * *',    'hourly', 6),
    ('microsoft/vscode',    'css-order-scan.yml', '17 5 * * *', (5, 17), 3),
    ('github/docs',         'index-general-search.yml', '20 16 * * 1-5', (16, 20), 3),
]
def fetch(url):
    return subprocess.run(['curl', '-sS', '-m', '60', '-L', '-A', UA, url], capture_output=True, text=True).stdout
def runs_of(html):
    m = re.search(r'<script type="application/json"[^>]*data-target="react-app.embeddedData"[^>]*>(.*?)</script>', html, flags=re.S)
    if not m: return []
    return [r['createdAt']['timestamp'] for r in json.loads(m.group(1))['payload']['workflowRunsRoute']['workflowRuns']]
def parse(s): return dt.datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)
def nominal(c, rule):
    if rule == 'hourly': return c.replace(minute=0, second=0, microsecond=0)
    n = c.replace(hour=rule[0], minute=rule[1], second=0, microsecond=0)
    return n if c >= n else n - dt.timedelta(days=1)
def pct(a, p): a = sorted(a); return a[min(len(a) - 1, int(p * len(a)))]
print('fetched', dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))
for repo, wf, cron, rule, pages in TARGETS:
    seen = set()
    for p in range(1, pages + 1):
        seen.update(runs_of(fetch(f'https://github.com/{repo}/actions/workflows/{wf}?query=event%3Aschedule&page={p}')))
    cs = sorted(parse(t) for t in seen)
    if not cs: print(repo, wf, 'no data'); continue
    d = [(c - nominal(c, rule)).total_seconds() / 60 for c in cs]
    print(f'{repo} {wf} cron "{cron}" n={len(cs)} {cs[0]:%Y-%m-%d %H:%MZ}..{cs[-1]:%Y-%m-%d %H:%MZ}')
    print(f'    delay after nominal slot, minutes: min={min(d):.1f} median={statistics.median(d):.1f} mean={statistics.mean(d):.1f} p90={pct(d, .9):.1f} max={max(d):.1f}')
    if rule != 'hourly':  # daily rules: every calendar day (or every weekday for '1-5') between the first and last run should have a run
        weekdays_only = '1-5' in cron
        days = {c.date() for c in cs}; day, exp = cs[0].date(), []
        while day <= cs[-1].date():
            if not weekdays_only or day.weekday() < 5: exp.append(day)
            day += dt.timedelta(days=1)
        print(f'    days with a run: {len(days)} of {len(exp)} expected{" weekdays" if weekdays_only else " days"} (missing {[str(x) for x in exp if x not in days]})')
    if rule == 'hourly':
        first, last = cs[0].replace(minute=0, second=0, microsecond=0), cs[-1].replace(minute=0, second=0, microsecond=0)
        span = int((last - first).total_seconds() // 3600) + 1
        print(f'    distinct hourly slots with a run: {len({c.replace(minute=0, second=0, microsecond=0) for c in cs})} of {span} slots between the first and last run (missing {span - len({c.replace(minute=0, second=0, microsecond=0) for c in cs})})')
