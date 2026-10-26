import { RTCPeerConnection } from '../../../../node_modules/node-datachannel/dist/esm/polyfill/index.mjs';
const N = Number(process.argv[2] || 20);
async function pair() {
  const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] });
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate); b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const dc = a.createDataChannel('x'); const got = new Promise((r) => { b.ondatachannel = (e) => { e.channel.onmessage = (m) => r(String(m.data)); }; });
  dc.onopen = () => dc.send('hi');
  await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
  const r = await Promise.race([got, new Promise((r) => setTimeout(() => r('TIMEOUT'), 8000))]);
  return { a, b, r };
}
const t0 = performance.now(); const pairs = [];
const rs = await Promise.all(Array.from({ length: N }, () => pair()));
const ok = rs.filter((x) => x.r === 'hi').length;
console.log(`node-datachannel polyfill: ${ok}/${N} loopback data-channel pairs connected in ${Math.round(performance.now() - t0)} ms (rss ${Math.round(process.memoryUsage().rss / 1048576)} MiB)`);
for (const x of rs) { x.a.close(); x.b.close(); }
setTimeout(() => process.exit(0), 300);
