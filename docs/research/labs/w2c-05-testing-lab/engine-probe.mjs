// Cross-engine capability probe: Playwright 1.64.1 bundled Chromium / Firefox / WebKit
import http from 'node:http';
import { chromium, firefox, webkit } from '../../../../node_modules/playwright/index.mjs';

const PAGE = `<!doctype html><meta charset=utf-8><title>probe</title><script>
let pc, dc, waiters=new Map(), got=0, target=0, doneResolve;
function waitIce(pc){return new Promise(r=>{ if(pc.iceGatheringState==='complete')return r(); pc.addEventListener('icegatheringstatechange',()=>{ if(pc.iceGatheringState==='complete') r(); }); setTimeout(r,8000); });}
function wire(ch){ dc=ch; dc.binaryType='arraybuffer'; dc.onmessage=(e)=>{ if(typeof e.data==='string'){ if(e.data.startsWith('ping')) dc.send('pong'+e.data.slice(4)); else if(e.data.startsWith('pong')){ const w=waiters.get(e.data); if(w){waiters.delete(e.data); w();} } else if(e.data.startsWith('expect:')){ target=+e.data.slice(7); got=0; } else if(e.data==='done'){ doneResolve&&doneResolve(); } } else { got+=e.data.byteLength; if(target&&got>=target){ target=0; dc.send('done'); } } }; }
window.createOffer=async()=>{ pc=new RTCPeerConnection({iceServers:[]}); wire(pc.createDataChannel('x')); await pc.setLocalDescription(await pc.createOffer()); await waitIce(pc); return pc.localDescription.sdp; };
window.acceptOffer=async(sdp)=>{ pc=new RTCPeerConnection({iceServers:[]}); pc.ondatachannel=(e)=>wire(e.channel); await pc.setRemoteDescription({type:'offer',sdp}); await pc.setLocalDescription(await pc.createAnswer()); await waitIce(pc); return pc.localDescription.sdp; };
window.acceptAnswer=async(sdp)=>{ await pc.setRemoteDescription({type:'answer',sdp}); };
window.isOpen=()=>new Promise(r=>{ const t=setInterval(()=>{ if(dc&&dc.readyState==='open'){clearInterval(t);r(true);} },20); setTimeout(()=>{clearInterval(t);r(false)},12000); });
window.pingN=async(n)=>{ const rtts=[]; for(let i=0;i<n;i++){ const k='pong'+i; const p=new Promise(r=>waiters.set(k,r)); const t0=performance.now(); dc.send('ping'+i); await Promise.race([p,new Promise(r=>setTimeout(r,3000))]); rtts.push(performance.now()-t0);} rtts.sort((a,b)=>a-b); return +rtts[Math.floor(n/2)].toFixed(2); };
window.sendBytes=async(total)=>{ const chunk=new Uint8Array(16384); dc.bufferedAmountLowThreshold=262144; dc.send('expect:'+total); const t0=performance.now(); const done=new Promise(r=>doneResolve=r); let sent=0; while(sent<total){ if(dc.bufferedAmount>1048576){ await new Promise(r=>dc.addEventListener('bufferedamountlow',r,{once:true})); } dc.send(chunk); sent+=chunk.length; } await Promise.race([done,new Promise(r=>setTimeout(r,30000))]); const ms=performance.now()-t0; return +(total/1e6/(ms/1000)).toFixed(2); };
window.pairInfo=async()=>{ const st=await pc.getStats(); let out=[]; st.forEach(s=>{ if(s.type==='candidate-pair'&&(s.nominated||s.selected)&&s.state==='succeeded'){ const l=st.get(s.localCandidateId), r=st.get(s.remoteCandidateId); out.push((l?.candidateType)+'/'+(l?.protocol)+' -> '+(r?.candidateType)+'/'+(r?.protocol)+' addr='+((l?.address||l?.ip)||'?')); } }); return { pair: out, maxMessageSize: pc.sctp?pc.sctp.maxMessageSize:null }; };
window.features=async()=>{
  const f={}; const t=(k,fn)=>{ try{ f[k]=fn(); }catch(e){ f[k]='ERR '+e.message; } };
  t('isSecureContext',()=>isSecureContext); t('crossOriginIsolated',()=>crossOriginIsolated);
  t('Uint8Array.toHex',()=>typeof Uint8Array.prototype.toHex); t('Uint8Array.fromHex',()=>typeof Uint8Array.fromHex); t('Uint8Array.toBase64',()=>typeof Uint8Array.prototype.toBase64); t('Uint8Array.fromBase64',()=>typeof Uint8Array.fromBase64);
  t('AbortSignal.timeout',()=>typeof AbortSignal.timeout); t('AbortSignal.any',()=>typeof AbortSignal.any); t('structuredClone',()=>typeof structuredClone); t('Array.at',()=>typeof [].at); t('Promise.withResolvers',()=>typeof Promise.withResolvers);
  t('BigInt64Array',()=>typeof BigInt64Array); t('ReadableStream',()=>typeof ReadableStream); t('Blob.arrayBuffer',()=>typeof Blob.prototype.arrayBuffer);
  t('navigator.storage.getDirectory(OPFS)',()=>typeof navigator.storage?.getDirectory); t('createWritable',()=>typeof FileSystemFileHandle!=='undefined'&&typeof FileSystemFileHandle.prototype.createWritable);
  t('navigator.storage.persist',()=>typeof navigator.storage?.persist); t('navigator.connection',()=>typeof navigator.connection); t('navigator.locks',()=>typeof navigator.locks);
  t('measureUserAgentSpecificMemory',()=>typeof performance.measureUserAgentSpecificMemory); t('performance.memory',()=>typeof performance.memory);
  t('RTCPeerConnection',()=>typeof RTCPeerConnection); t('RTCDataChannel transferable-ish(MessagePort)',()=>typeof MessageChannel); t('Worker',()=>typeof Worker); t('SharedWorker',()=>typeof SharedWorker);
  t('serviceWorker',()=>typeof navigator.serviceWorker); t('caches',()=>typeof caches); t('indexedDB',()=>typeof indexedDB); t('crypto.subtle',()=>typeof crypto.subtle);
  t('Intl.DurationFormat',()=>typeof Intl.DurationFormat);
  // WebCrypto ECDSA P-256 + store CryptoKey in IndexedDB (non-extractable)
  try{
    const kp=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
    const sig=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},kp.privateKey,new Uint8Array([1,2,3])));
    const ok=await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},kp.publicKey,sig,new Uint8Array([1,2,3]));
    const raw=new Uint8Array(await crypto.subtle.exportKey('raw',kp.publicKey));
    f.ecdsa_p256={sigLen:sig.length,verify:ok,rawPubLen:raw.length};
    const db=await new Promise((res,rej)=>{ const r=indexedDB.open('probe',1); r.onupgradeneeded=()=>r.result.createObjectStore('k'); r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); });
    await new Promise((res,rej)=>{ const tx=db.transaction('k','readwrite'); tx.objectStore('k').put(kp,'id'); tx.oncomplete=res; tx.onerror=()=>rej(tx.error); });
    const back=await new Promise((res,rej)=>{ const tx=db.transaction('k'); const g=tx.objectStore('k').get('id'); g.onsuccess=()=>res(g.result); g.onerror=()=>rej(g.error); });
    const sig2=new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},back.privateKey,new Uint8Array([9])));
    f.cryptokey_in_idb={restored:!!back, signsAfterRestore: sig2.length};
  }catch(e){ f.ecdsa_p256='ERR '+e.name+': '+e.message; }
  // Service worker serving an iframe
  try{
    const reg=await navigator.serviceWorker.register('/sw.js',{scope:'/'});
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller){ await new Promise(r=>{ navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}); setTimeout(r,3000); reg.active&&reg.active.postMessage('claim'); }); }
    const ifr=document.createElement('iframe'); ifr.src='/_mw/s/abc/index.html'; document.body.appendChild(ifr);
    await new Promise(r=>{ ifr.onload=r; setTimeout(r,5000); });
    let txt=null; try{ txt=ifr.contentDocument.body.textContent.trim(); }catch(e){ txt='ERR '+e.message; }
    f.sw={controllerOnTop:!!navigator.serviceWorker.controller, iframeText:txt, iframeControlled: (()=>{try{return !!ifr.contentWindow.navigator.serviceWorker.controller;}catch(e){return 'ERR '+e.message;}})()};
  }catch(e){ f.sw='ERR '+e.name+': '+e.message; }
  return f;
};
</script><body>`;
const SW = `self.addEventListener('install',e=>self.skipWaiting()); self.addEventListener('activate',e=>e.waitUntil(self.clients.claim())); self.addEventListener('message',e=>{ self.clients.claim(); });
self.addEventListener('fetch',e=>{ const u=new URL(e.request.url); if(u.pathname.startsWith('/_mw/s/')){ e.respondWith(new Response('<!doctype html><title>x</title><p id=x>sw-ok</p>',{headers:{'content-type':'text/html; charset=utf-8'}})); } });`;

const server = http.createServer((q, r) => {
  const p = new URL(q.url, 'http://x').pathname;
  if (p === '/sw.js') { r.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/' }); return r.end(SW); }
  if (p.startsWith('/_mw/')) { r.writeHead(404); return r.end('NOT FROM SW'); }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;

const engines = { chromium, firefox, webkit };
const launchOpts = {
  chromium: { headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] },
  firefox: { headless: true, firefoxUserPrefs: {} },
  firefoxNoMdns: { headless: true, firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': false } },
  webkit: { headless: true },
};

async function rtcTest(label, makeA, makeB) {
  const t0 = Date.now();
  try {
    const A = await makeA(), B = await makeB();
    const a = await A.ctx.newPage(), b = await B.ctx.newPage();
    await a.goto(url); await b.goto(url);
    const offer = await a.evaluate(() => window.createOffer());
    const answer = await b.evaluate((s) => window.acceptOffer(s), offer);
    await a.evaluate((s) => window.acceptAnswer(s), answer);
    const [oa, ob] = [await a.evaluate(() => window.isOpen()), await b.evaluate(() => window.isOpen())];
    const res = { label, open: [oa, ob], setupMs: Date.now() - t0, offerHasMdns: /\.local/.test(offer) };
    if (oa && ob) {
      res.info = await a.evaluate(() => window.pairInfo());
      res.rttMedianMs = await a.evaluate(() => window.pingN(20));
      await a.evaluate(() => window.sendBytes(500000));
      res.MBps = await a.evaluate(() => window.sendBytes(2000000));
    }
    console.log('RTC ' + JSON.stringify(res));
    await A.close(); await B.close();
  } catch (e) { console.log('RTC ' + JSON.stringify({ label, error: String(e).slice(0, 200) })); }
}

for (const name of ['chromium', 'firefox', 'webkit']) {
  const opts = launchOpts[name];
  let browser;
  try {
    browser = await engines[name].launch(opts);
    console.log(`\n=== ${name} ${browser.version()}`);
    const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.goto(url);
    const feats = await page.evaluate(() => window.features());
    console.log('FEATURES ' + JSON.stringify(feats));
    await ctx.close();
    // WebRTC: two contexts in ONE browser process
    await rtcTest(`${name}: 2 contexts, 1 browser`, async () => { const c = await browser.newContext(); return { ctx: c, close: () => c.close() }; }, async () => { const c = await browser.newContext(); return { ctx: c, close: () => c.close() }; });
    // WebRTC: two separate browser launches (the 'separate processes' case from deadrop#97)
    await rtcTest(`${name}: 2 separate browser launches`, async () => { const br = await engines[name].launch(opts); const c = await br.newContext(); return { ctx: c, close: () => br.close() }; }, async () => { const br = await engines[name].launch(opts); const c = await br.newContext(); return { ctx: c, close: () => br.close() }; });
    if (name === 'firefox') {
      await rtcTest('firefox: 2 contexts, obfuscate_host_addresses=false', async () => { const br = await engines.firefox.launch(launchOpts.firefoxNoMdns); const c = await br.newContext(); return { ctx: c, close: () => br.close() }; }, async () => { const br = await engines.firefox.launch(launchOpts.firefoxNoMdns); const c = await br.newContext(); return { ctx: c, close: () => br.close() }; });
    }
    await browser.close();
  } catch (e) { console.log(`ENGINE ${name} ERROR ${String(e).slice(0, 300)}`); try { await browser?.close(); } catch {} }
}
server.close();
