const pkgs = process.argv.slice(2);
for (const p of pkgs) {
  try {
    const r = await fetch('https://registry.npmjs.org/' + p.replace('/', '%2f'), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) { console.log(p.padEnd(28), 'HTTP', r.status); continue; }
    const j = await r.json();
    const latest = j['dist-tags']?.latest;
    const t = j.time?.[latest];
    const eng = j.versions?.[latest]?.engines?.node ?? '';
    console.log(p.padEnd(28), String(latest).padEnd(14), (t || '').slice(0, 10), '| modified', (j.time?.modified || '').slice(0, 10), '| node', eng, '| deprecated:', j.versions?.[latest]?.deprecated ? 'YES' : 'no');
  } catch (e) { console.log(p.padEnd(28), 'ERR', e.message); }
}
