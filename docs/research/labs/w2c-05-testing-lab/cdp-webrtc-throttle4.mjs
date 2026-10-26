// Experiment: does CDP Network.emulateNetworkConditionsByRule (empty urlPattern) throttle RTCDataChannel traffic in Chromium?
import http from 'node:http';
import { chromium } from '../../../../node_modules/playwright/index.mjs';

const HTML = `<!doctype html><meta charset=utf-8><title>dc</title><script>
let pc, dc, got=0, target=0, waiters=new Map(), doneResolve;
function waitIce(pc){return new Promise(r=>{ if(pc.iceGatheringState==='complete')return r(); pc.addEventListener('icegatheringstatechange',()=>{ if(pc.iceGatheringState==='complete') r(); }); setTimeout(r,8000); });}
function wire(ch){ dc=ch; dc.binaryType='arraybuffer';
  dc.onmessage=(e)=>{ if(typeof e.data==='string'){
      if(e.data.startsWith('ping')){ dc.send('pong'+e.data.slice(4)); }
      else if(e.data.startsWith('pong')){ const k=e.data; const w=waiters.get(k); if(w){waiters.delete(k); w();} }
      else if(e.data.startsWith('expect:')){ target=+e.data.slice(7); got=0; }
      else if(e.data==='done'){ doneResolve&&doneResolve(); }
    } else { got+=e.data.byteLength; if(target&&got>=target){ target=0; dc.send('done'); } } };
}
window.createOffer=async()=>{ pc=new RTCPeerConnection({iceServers:[]}); wire(pc.createDataChannel('x')); await pc.setLocalDescription(await pc.createOffer()); await waitIce(pc); return pc.localDescription.sdp; };
window.acceptOffer=async(sdp)=>{ pc=new RTCPeerConnection({iceServers:[]}); pc.ondatachannel=(e)=>wire(e.channel); await pc.setRemoteDescription({type:'offer',sdp}); await pc.setLocalDescription(await pc.createAnswer()); await waitIce(pc); return pc.localDescription.sdp; };
window.acceptAnswer=async(sdp)=>{ await pc.setRemoteDescription({type:'answer',sdp}); };
window.isOpen=()=>new Promise(r=>{ const t=setInterval(()=>{ if(dc&&dc.readyState==='open'){clearInterval(t);r(true);} },20); setTimeout(()=>{clearInterval(t);r(false)},15000); });
window.pingN=async(n)=>{ const rtts=[]; for(let i=0;i<n;i++){ const k='pong'+i; const p=new Promise(r=>waiters.set(k,r)); const t0=performance.now(); dc.send('ping'+i); await Promise.race([p,new Promise(r=>setTimeout(r,5000))]); rtts.push(performance.now()-t0);} rtts.sort((a,b)=>a-b); return {median:rtts[Math.floor(n/2)], p90:rtts[Math.floor(n*0.9)], max:rtts[n-1]}; };
window.sendBytes=async(total)=>{ const chunk=new Uint8Array(16384); dc.bufferedAmountLowThreshold=262144; dc.send('expect:'+total); const t0=performance.now(); const done=new Promise(r=>doneResolve=r); let sent=0; while(sent<total){ if(dc.bufferedAmount>1048576){ await new Promise(r=>dc.addEventListener('bufferedamountlow',r,{once:true})); } dc.send(chunk); sent+=chunk.length; } await Promise.race([done,new Promise(r=>setTimeout(r,60000))]); const ms=performance.now()-t0; return {ms, MBps: total/1e6/(ms/1000)}; };
window.pairType=async()=>{ const st=await pc.getStats(); let out=[]; st.forEach(s=>{ if(s.type==='candidate-pair'&&s.nominated&&s.state==='succeeded'){ const l=st.get(s.localCandidateId), r=st.get(s.remoteCandidateId); out.push(l.candidateType+'/'+l.protocol+' -> '+r.candidateType+'/'+r.protocol+' addr='+(l.address||l.ip)); } }); return out; };
</script>`;

const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(HTML); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
console.log('Chromium', browser.version());

async function pair(applyA, applyB) {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  await a.goto(url); await b.goto(url);
  if (applyA) await applyA(ca, a);
  if (applyB) await applyB(cb, b);
  const t0 = Date.now();
  const offer = await a.evaluate(() => window.createOffer());
  const answer = await b.evaluate((s) => window.acceptOffer(s), offer);
  await a.evaluate((s) => window.acceptAnswer(s), answer);
  const openA = await a.evaluate(() => window.isOpen()); const openB = await b.evaluate(() => window.isOpen());
  const setupMs = Date.now() - t0;
  return { ca, cb, a, b, openA, openB, setupMs };
}

const byRule = (cond) => async (ctx, page) => {
  const s = await ctx.newCDPSession(page);
  await s.send('Network.enable');
  await s.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [{ urlPattern: '', downloadThroughput: -1, uploadThroughput: -1, latency: 0, ...cond }] });
  return s;
};
const legacy = (cond) => async (ctx, page) => {
  const s = await ctx.newCDPSession(page);
  await s.send('Network.enable');
  await s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, ...cond });
  return s;
};


async function setRule(ctx, page, cond) {
  const s = await ctx.newCDPSession(page); await s.send('Network.enable');
  await s.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [{ urlPattern: '', downloadThroughput: -1, uploadThroughput: -1, latency: 0, ...cond }] });
  return s;
}
// Test 1: rule installed BEFORE connect with loss 0, then flipped to 100 after connect
{
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage(); await a.goto(url); await b.goto(url);
  const sA = await setRule(ca, a, { packetLoss: 0 });
  const offer = await a.evaluate(() => window.createOffer()); const answer = await b.evaluate((s) => window.acceptOffer(s), offer); await a.evaluate((s) => window.acceptAnswer(s), answer);
  console.log('T1 open:', await a.evaluate(() => window.isOpen()));
  await sA.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [{ urlPattern: '', downloadThroughput: -1, uploadThroughput: -1, latency: 0, packetLoss: 100 }] });
  const r = await Promise.race([a.evaluate(() => window.pingN(2)).then(() => 'pings completed after flipping loss 0->100 (rule existed before connect)'), new Promise((r) => setTimeout(() => r('pings STALLED after flipping loss 0->100'), 5000))]);
  console.log('T1:', r);
  await ca.close(); await cb.close();
}
// Test 2: loss=100 installed BEFORE connect: how long until ICE reports failed?
{
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage(); await a.goto(url); await b.goto(url);
  await setRule(ca, a, { packetLoss: 100 });
  const t0 = Date.now();
  await a.evaluate(() => { window.__ev = []; window.__t0 = performance.now(); });
  const offer = await a.evaluate(() => { const p = window.createOffer(); setTimeout(() => { pc.addEventListener('iceconnectionstatechange', () => __ev.push(['ice:' + pc.iceConnectionState, Math.round(performance.now() - __t0)])); }, 0); return p; });
  const answer = await b.evaluate((s) => window.acceptOffer(s), offer); await a.evaluate((s) => window.acceptAnswer(s), answer);
  const open = await a.evaluate(() => window.isOpen());
  await new Promise((r) => setTimeout(r, 45000));
  console.log('T2 data channel opened under loss=100 before connect?', open, '| events:', JSON.stringify(await a.evaluate(() => __ev)), '| final ice:', await a.evaluate(() => pc.iceConnectionState), '| elapsed s', Math.round((Date.now() - t0) / 1000));
  await ca.close(); await cb.close();
}
await browser.close(); server.close();
