// Deno test server + browser launcher (own code).
const dir = new URL('.', import.meta.url).pathname;
const browser = Deno.args[0];
const fast = Deno.env.get('FAST') === '1'; // FAST=1 skips tests A-C (iframes, idle, stream)
const results = {};
let child;
const finish = async (why) => {
  console.log('\n===== RESULTS (' + why + ') =====');
  console.log(JSON.stringify(results, null, 2));
  try { child?.kill('SIGKILL'); } catch {}
  Deno.exit(0);
};
const ac = new AbortController();
const server = Deno.serve({ hostname: '127.0.0.1', port: 0, signal: ac.signal, onListen: async ({ port }) => {
  console.log('listening on', port);
  const profile = await Deno.makeTempDir({ dir: Deno.env.get('PROFILE_PARENT') ?? undefined, prefix: 'sw-exp-profile-' }); // throw-away browser profile (OS temp dir unless PROFILE_PARENT is set)
  child = new Deno.Command(browser, {
    args: [...Deno.args.slice(1), '--user-data-dir=' + profile, `http://127.0.0.1:${port}/${fast ? '?fast=1' : ''}`],
    stdout: 'null', stderr: 'piped'
  }).spawn();
  (async () => {
    const dec = new TextDecoder(); let buf = '';
    for await (const chunk of child.stderr) {
      buf += dec.decode(chunk);
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { globalThis.__wsUrl = m[1]; break; }
    }
  })();
  setTimeout(() => finish('GLOBAL TIMEOUT'), 7 * 60 * 1000);
} }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === '/report') {
    const body = await req.json();
    results[body.name] = body.data;
    console.log(new Date().toISOString().slice(11, 19), 'REPORT', body.name, JSON.stringify(body.data).slice(0, 400));
    if (body.name === 'done') setTimeout(() => finish('done'), 500);
    if (body.name === 'ready-for-reload-tests') runReloads();
    return new Response('ok');
  }
  if (u.pathname === '/') return new Response(await Deno.readTextFile(dir + 'index.html'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (u.pathname === '/sw.js') return new Response(await Deno.readTextFile(dir + 'sw.js'), { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } });
  if (u.pathname === '/__who') return new Response('network', { headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } });
  if (u.pathname.startsWith('/app/')) {
    const key = 'NETHIT dest=' + req.headers.get('sec-fetch-dest') + ' ' + u.pathname + u.search + ' @' + new Date().toISOString().slice(14, 23);
    console.log(key);
    results[key] = 1;
    const dest = req.headers.get('sec-fetch-dest');
    if (dest === 'document') {
      return new Response(`<!doctype html><meta charset=utf-8><p>NETWORK SHELL (static iframe)</p><iframe src="${u.pathname + u.search}" style="width:90%;height:80px"></iframe><script>fetch('/report', { method: 'POST', body: JSON.stringify({ name: 'E-network-shell-' + Date.now(), data: { ctrl: !!navigator.serviceWorker.controller } }) });</script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response(`<!doctype html><meta charset=utf-8><p>NETWORK FLAT PAGE (dest=${dest})</p>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (u.pathname.startsWith('/site/')) {
    results['NETWORK-HIT ' + u.pathname + u.search] = (results['NETWORK-HIT ' + u.pathname + u.search] || 0) + 1;
    console.log('NETWORK HIT', u.pathname + u.search, 'sec-fetch-dest=' + req.headers.get('sec-fetch-dest'));
    return new Response(`<!doctype html><meta charset=utf-8><p>from=network</p><script>(async()=>{const out={type:'frame-report',from:'network',path:location.pathname+location.search};try{out.ctrl=!!navigator.serviceWorker.controller}catch(e){out.ctrl='ERR:'+e.name}try{const r=await fetch('/__who');out.who=await r.text()}catch(e){out.who='ERR:'+e.name}parent.postMessage(out,'*')})()</script>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return new Response('not found', { status: 404 });
});

async function cdp() {
  const ws = new WebSocket(globalThis.__wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  return { send, ws };
}
let ranReloads = false;
async function runReloads() {
  if (ranReloads) return; ranReloads = true;
  try {
    const { send } = await cdp();
    const t = (await send('Target.getTargets')).result.targetInfos.find((x) => x.type === 'page' && x.url.includes('/app/page1'));
    const sessionId = (await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result.sessionId;
    await send('Page.enable', {}, sessionId);
    console.log('--- HARD RELOAD (ignoreCache:true) @' + new Date().toISOString().slice(14, 23));
    await send('Page.reload', { ignoreCache: true }, sessionId);
    await new Promise((r) => setTimeout(r, 6000));
    console.log('--- NORMAL RELOAD @' + new Date().toISOString().slice(14, 23));
    await send('Page.reload', { ignoreCache: false }, sessionId);
    await new Promise((r) => setTimeout(r, 6000));
    console.log('--- END');
  } catch (e) { console.log('CDP ERROR', String(e)); }
  finish('reload-tests-done');
}
