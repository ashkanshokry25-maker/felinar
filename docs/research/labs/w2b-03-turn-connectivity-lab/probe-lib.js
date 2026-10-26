// Runs inside the page. Exposes window.runIce(opts) and window.runPeer(opts) and window.thr(opts)
window.runIce = async function (opts) {
  const t0 = performance.now()
  const out = { label: opts.label, cands: [], errors: [], states: [] }
  const pc = new RTCPeerConnection({ iceServers: opts.iceServers || [], iceTransportPolicy: opts.policy || 'all' })
  pc.createDataChannel('x')
  pc.onicegatheringstatechange = () => out.states.push([Math.round(performance.now() - t0), pc.iceGatheringState])
  pc.onicecandidate = (e) => {
    const t = Math.round(performance.now() - t0)
    if (!e.candidate) { out.tNull = t; return }
    const c = e.candidate
    out.cands.push({ t, type: c.type, proto: c.protocol, addr: c.address, port: c.port, rel: c.relatedAddress ? c.relatedAddress + ':' + c.relatedPort : null, url: c.url || e.url || null, relayProto: c.relayProtocol || null })
  }
  pc.onicecandidateerror = (e) => out.errors.push({ t: Math.round(performance.now() - t0), code: e.errorCode, text: e.errorText, url: e.url, addr: e.address, port: e.port })
  await pc.setLocalDescription(await pc.createOffer())
  const deadline = performance.now() + (opts.maxMs || 20000)
  while (pc.iceGatheringState !== 'complete' && performance.now() < deadline) await new Promise(r => setTimeout(r, 25))
  out.gatherState = pc.iceGatheringState
  out.tComplete = pc.iceGatheringState === 'complete' ? (out.states.filter(s => s[1] === 'complete')[0] || [null])[0] : null
  out.sdpBytes = pc.localDescription.sdp.length
  out.sdpCandLines = (pc.localDescription.sdp.match(/^a=candidate:/mg) || []).length
  try {
    const st = await pc.getStats(); out.stats = []
    st.forEach(r => { if (r.type === 'local-candidate') out.stats.push({ candidateType: r.candidateType, protocol: r.protocol, relayProtocol: r.relayProtocol, url: r.url, networkType: r.networkType }) })
  } catch (e) { out.statsErr = String(e) }
  pc.close()
  return out
}
window.runPeer = async function (opts) {
  // measures simple-peer (lite) offer readiness with trickle:false, as bittorrent-tracker does
  const t0 = performance.now()
  const res = await new Promise((resolve) => {
    const p = new window.SimplePeer({ initiator: true, trickle: false, config: { iceServers: opts.iceServers || [], iceTransportPolicy: opts.policy || 'all' } })
    let iceTimeout = false
    p.on('iceTimeout', () => { iceTimeout = true })
    p.on('signal', (s) => { if (s.type === 'offer') { resolve({ label: opts.label, tOffer: Math.round(performance.now() - t0), sdpBytes: s.sdp.length, candLines: (s.sdp.match(/^a=candidate:/mg) || []).length, iceTimeout }); p.destroy() } })
    p.on('error', (e) => resolve({ label: opts.label, error: String(e) }))
    setTimeout(() => resolve({ label: opts.label, error: 'no-offer-in-' + ((opts.waitMs || 20000) / 1000) + 's' }), opts.waitMs || 20000)
  })
  return res
}
window.thr = async function (opts) {
  // loopback data channel throughput between two PCs in this page
  const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] })
  a.onicecandidate = e => e.candidate && b.addIceCandidate(e.candidate)
  b.onicecandidate = e => e.candidate && a.addIceCandidate(e.candidate)
  const dc = a.createDataChannel('t', { ordered: true }); dc.binaryType = 'arraybuffer'
  const recv = new Promise(res => { b.ondatachannel = ev => { const ch = ev.channel; ch.binaryType = 'arraybuffer'; res(ch) } })
  await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription)
  await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription)
  const t0 = performance.now()
  await new Promise((res, rej) => { dc.onopen = res; setTimeout(() => rej(new Error('open timeout')), 15000) })
  const tOpen = Math.round(performance.now() - t0)
  const rc = await recv
  const out = { label: opts.label, tOpen, maxMessageSize: a.sctp && a.sctp.maxMessageSize, runs: [] }
  for (const size of opts.sizes) {
    const total = opts.totalBytes
    let got = 0
    const done = new Promise(res => { rc.onmessage = ev => { got += ev.data.byteLength; if (got >= total) res() } })
    const buf = new Uint8Array(size)
    dc.bufferedAmountLowThreshold = opts.lowWater || 256 * 1024
    const high = opts.highWater || 1024 * 1024
    const s0 = performance.now()
    let sent = 0
    await new Promise((resolve) => {
      const pump = () => {
        while (sent < total && dc.bufferedAmount < high) { dc.send(buf); sent += size }
        if (sent < total) dc.onbufferedamountlow = pump; else resolve()
      }
      pump()
    })
    await done
    const dt = (performance.now() - s0) / 1000
    out.runs.push({ size, MBps: +(total / 1048576 / dt).toFixed(1), Mbps: +(total * 8 / 1e6 / dt).toFixed(0), sec: +dt.toFixed(2) })
  }
  // small-message ping-pong latency
  const rtts = []
  rc.onmessage = ev => rc.send(ev.data)
  for (let i = 0; i < 200; i++) {
    const p0 = performance.now()
    await new Promise(res => { dc.onmessage = res; dc.send(new Uint8Array(16)) })
    rtts.push(performance.now() - p0)
  }
  rtts.sort((x, y) => x - y)
  out.rttMs = { p50: +rtts[100].toFixed(2), p95: +rtts[190].toFixed(2), max: +rtts[199].toFixed(2) }
  a.close(); b.close()
  return out
}
