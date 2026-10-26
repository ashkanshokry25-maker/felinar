// E-CSP-2: do CSP connect-src rules affect RTCPeerConnection ICE (STUN) traffic?
(async () => {
  const q = new URLSearchParams(location.search)
  const out = { violations: [], cands: [], state: null }
  window.__out = out
  document.addEventListener('securitypolicyviolation', (e) => out.violations.push({ d: e.violatedDirective, b: String(e.blockedURI).slice(0, 90) }))
  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:' + q.get('stun') }] })
    pc.createDataChannel('x')
    pc.onicecandidate = (e) => { if (e.candidate) out.cands.push(e.candidate.candidate.split(' ')[7] + ':' + (e.candidate.address || '')) }
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise((r) => { if (pc.iceGatheringState === 'complete') r(); else { pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && r(); setTimeout(r, 4000) } })
    out.state = pc.iceGatheringState
  } catch (e) { out.error = String(e && e.message) }
  out.done = true
})()
