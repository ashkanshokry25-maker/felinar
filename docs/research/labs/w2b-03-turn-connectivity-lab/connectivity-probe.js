// connectivity-probe.js - reference implementation of a browser-only connectivity probe (no backend).
// Classifies the visitor's UDP/NAT situation in <= budgetMs using ONE throw-away RTCPeerConnection:
//   - two (or more) STUN servers on different IPs: if the reflexive ip:port differs between them the NAT mapping
//     depends on the destination (endpoint-dependent mapping, "hard NAT"). Same technique as Tailscale netcheck
//     (MappingVariesByDestIP) and the "NAT behavior" input of Snowflake's broker matching.
//   - optional TURN servers: tells whether an Allocate succeeded (relay candidate) and how long it took.
// It never waits for iceGatheringState === 'complete' (can take ~40 s with a dead server, never fires in some WebKit builds).
// Exports probeConnectivity(opts) -> Promise<Report>. No remote IP is read; reflexive addresses are used only to compare ports.
export async function probeConnectivity ({ stun = [], turn = [], budgetMs = 2500, settleMs = 150, confirmMs = 600, policy = 'all' } = {}) {
  const t0 = performance.now()
  const now = () => Math.round(performance.now() - t0)
  const stunUrls = stun.map(u => (typeof u === 'string' ? u : u.urls))
  const turnEntries = turn.map(t => (typeof t === 'string' ? { urls: t } : t))
  const turnUrls = turnEntries.flatMap(t => [].concat(t.urls))
  const report = {
    cls: 'unknown', udp: null, mappingVaries: null, gatherComplete: false, turnConfigured: turnUrls.length > 0, turnOk: false, ipv6Srflx: false, srflx: [], relay: [], errors: [], tFirstSrflx: null, tRelay: null, tDone: null, reason: null
  }
  let pc
  try {
    pc = new RTCPeerConnection({ iceServers: [...stunUrls.map(urls => ({ urls })), ...turnEntries], iceTransportPolicy: policy })
  } catch (e) {
    report.reason = 'RTCPeerConnection-ctor:' + (e && e.name); report.cls = 'no-webrtc'; report.tDone = now(); return report
  }
  const bySrflxUrl = new Map() // stun url -> 'ip:port'
  const relayByUrl = new Map()
  let gatherDone = false
  let confirmed = false // true once confirmMs elapsed after the first srflx
  let confirmTimer = null
  let resolveDone
  const done = new Promise(r => { resolveDone = r })
  const maybeFinish = () => {
    const stunAnswered = bySrflxUrl.size >= stunUrls.length || stunUrls.length === 0 || (confirmed && bySrflxUrl.size >= 1)
    const turnAnswered = turnUrls.length === 0 || relayByUrl.size > 0 || report.errors.some(e => turnUrls.includes(e.url))
    if (gatherDone || (stunAnswered && turnAnswered)) setTimeout(() => resolveDone('early'), gatherDone ? 0 : settleMs)
  }
  pc.onicecandidate = (e) => {
    if (!e.candidate) { gatherDone = true; maybeFinish(); return }
    const c = e.candidate
    const url = c.url || e.url || null
    if (c.type === 'srflx') {
      if (report.tFirstSrflx === null) {
        report.tFirstSrflx = now()
        // Browsers de-duplicate identical reflexive addresses: two STUN servers with the same mapping yield ONE srflx candidate,
        // so "second server answered with the same mapping" is indistinguishable from "second server silent" until gathering completes.
        confirmTimer = setTimeout(() => { confirmed = true; maybeFinish() }, confirmMs)
      }
      const key = `${c.address}:${c.port}`
      report.srflx.push({ key, url, t: now() })
      if (c.address && c.address.includes(':')) report.ipv6Srflx = true
      if (url) bySrflxUrl.set(url, key)
    } else if (c.type === 'relay') {
      if (report.tRelay === null) report.tRelay = now()
      report.relay.push({ url, proto: c.relayProtocol || null, t: now() })
      if (url) relayByUrl.set(url, true)
    }
    maybeFinish()
  }
  pc.onicecandidateerror = (e) => { report.errors.push({ code: e.errorCode, url: e.url, text: e.errorText, t: now() }); maybeFinish() }
  pc.createDataChannel('probe')
  try {
    await pc.setLocalDescription(await pc.createOffer())
  } catch (e) { report.reason = 'offer:' + (e && e.name) }
  const timer = new Promise(r => setTimeout(() => r('budget'), budgetMs))
  report.reason = report.reason || await Promise.race([done, timer])
  report.tDone = now()
  report.gatherComplete = gatherDone
  clearTimeout(confirmTimer)
  report.turnOk = report.relay.length > 0
  // classify
  const keys = [...new Set(report.srflx.map(s => s.key))]
  const ips = [...new Set(keys.map(k => k.slice(0, k.lastIndexOf(':'))))]
  const v4 = report.srflx.filter(s => !s.key.startsWith('[') && !s.key.includes('::') && s.key.split(':').length === 2)
  report.udp = report.srflx.length > 0 || report.relay.some(r => r.proto === 'udp' || r.proto === null && false)
  if (report.srflx.length === 0 && report.relay.length === 0) {
    report.cls = policy === 'relay' ? 'relay-only-failed' : 'udp-blocked-or-no-stun'
  } else if (v4.length >= 2) {
    const distinctV4Ports = new Set(v4.map(s => s.key))
    report.mappingVaries = distinctV4Ports.size > 1 && new Set(v4.map(s => s.key.split(':')[0])).size === 1
    report.cls = report.mappingVaries ? 'hard' : 'easy-mapping'
  } else if (report.srflx.length >= 1) {
    // exactly one distinct reflexive address
    report.mappingVaries = stunUrls.length >= 2 ? false : null
    report.cls = stunUrls.length < 2 ? 'unknown-single-stun' : (gatherDone ? 'easy-mapping' : 'easy-probable')
  } else {
    report.cls = 'relay-only-reachable'
  }
  try { pc.close() } catch (_) {}
  return report
}
