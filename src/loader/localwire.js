// src/loader/localwire.js: is a peer wire a local-network wire? (v0.3 C2, seed-policy lane;
// docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.3 row "Any phone, local wire"; S1 F4, D2).
//
// A local wire (both ends of the selected ICE candidate pair are host candidates on private, link-local or
// loopback addresses, or behind mDNS names) costs battery, not data, so the seed budget gives it the local row and
// keeps its bytes out of the month cap. The only signal a page has is the candidate pair in getStats(): the
// Network Information API says nothing about peers, and the stats networkType field was deprecated for privacy.
// Server-reflexive, peer-reflexive and relayed candidates are never local. Pure: the caller passes the
// RTCStatsReport (a Map), an array of stats or of [id, stats] pairs, or a plain object keyed by id.

const LEGACY_TYPES = { serverreflexive: 'srflx', peerreflexive: 'prflx', relayed: 'relay' }

function statsList (stats) {
  if (!stats || typeof stats !== 'object') return null
  let list
  if (typeof stats.values === 'function' && !Array.isArray(stats)) {
    try { list = Array.from(stats.values()) } catch (_) { return null }
  } else if (Array.isArray(stats)) {
    list = stats.map((x) => (Array.isArray(x) && x.length === 2 && x[1] && typeof x[1] === 'object' ? x[1] : x))
  } else {
    list = Object.keys(stats).map((k) => stats[k])
  }
  return list.filter((s) => s && typeof s === 'object')
}

function ipv4Of (text) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n <= 255) ? parts : null
}

/**
 * addressKind(address) → 'private' | 'mdns' | 'hidden' | 'public'. Private: 10/8, 172.16/12, 192.168/16, the
 * link-local 169.254/16, loopback 127/8 and ::1, fc00::/7, fe80::/10, and IPv4-mapped forms of these. mdns: a '.local'
 * name. hidden: no address in the stats (the browser left it out). 100.64/10 is the shared address space of RFC 6598
 * (carrier-grade NAT, and the addresses of overlay networks such as Tailscale): two such hosts are not on one local
 * network, often not even on one link, so it counts as public (code review v0.3, browser: an iPhone on mobile data
 * reached a tailnet peer as a "local" wire, outside the month cap).
 */
export function addressKind (address) {
  if (address === undefined || address === null || address === '') return 'hidden'
  let a = String(address).trim().toLowerCase()
  if (!a) return 'hidden'
  if (a[0] === '[' && a[a.length - 1] === ']') a = a.slice(1, -1)
  const zone = a.indexOf('%')
  if (zone >= 0) a = a.slice(0, zone)
  if (/\.local\.?$/.test(a)) return 'mdns'
  let v4 = ipv4Of(a)
  if (!v4) {
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a)
    if (mapped) v4 = ipv4Of(mapped[1])
  }
  if (v4) {
    const [x, y] = v4
    if (x === 10 || x === 127) return 'private'
    if (x === 172 && y >= 16 && y <= 31) return 'private'
    if (x === 192 && y === 168) return 'private'
    if (x === 169 && y === 254) return 'private'
    return 'public'
  }
  if (a.indexOf(':') >= 0) {
    if (a === '::1') return 'private'
    const first = /^([0-9a-f]{1,4}):/.exec(a)
    const head = first ? parseInt(first[1], 16) : 0
    if (first && head >= 0xfc00 && head <= 0xfdff) return 'private'
    if (first && head >= 0xfe80 && head <= 0xfebf) return 'private'
    return 'public'
  }
  return 'public'
}

function candidateTypeOf (c) {
  const t = String((c && c.candidateType) || '').toLowerCase()
  return LEGACY_TYPES[t] || t
}

// The standard field is address; Chromium before 2021 reported ip.
function addressOf (c) {
  if (!c) return undefined
  if (c.address !== undefined && c.address !== null && c.address !== '') return c.address
  if (c.ip !== undefined && c.ip !== null && c.ip !== '') return c.ip
  return undefined
}

function pairBytes (p) {
  return (Number(p.bytesSent) || 0) + (Number(p.bytesReceived) || 0)
}

/** selectedPair(stats) → the candidate-pair stats object in use, or null. */
export function selectedPair (stats) {
  const list = statsList(stats)
  if (!list) return null
  const byId = new Map()
  for (const s of list) if (typeof s.id === 'string') byId.set(s.id, s)
  for (const s of list) {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
      const p = byId.get(s.selectedCandidatePairId)
      if (p && p.type === 'candidate-pair') return p
    }
  }
  const pairs = list.filter((s) => s.type === 'candidate-pair')
  const selected = pairs.filter((p) => p.selected === true)
  const pool = selected.length ? selected : pairs.filter((p) => p.nominated === true && p.state === 'succeeded')
  if (!pool.length) return null
  pool.sort((a, b) => pairBytes(b) - pairBytes(a) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
  return pool[0]
}

/**
 * isLocalPair(stats) → { local, reason }. Finds the selected pair (transport.selectedCandidatePairId, else a pair
 * marked selected (Firefox), else a nominated and succeeded one, most bytes first) and reads both candidates. Local
 * only when both are 'host' and each address is private, an mDNS '.local' name, or hidden. reason: 'local',
 * 'no-stats', 'no-pair', 'no-candidate', 'srflx' | 'prflx' | 'relay' (the first end that is not a host candidate),
 * 'not-host' (an unknown candidate type), or 'public-address'.
 */
export function isLocalPair (stats) {
  const list = statsList(stats)
  if (!list) return { local: false, reason: 'no-stats' }
  const pair = selectedPair(list)
  if (!pair) return { local: false, reason: 'no-pair' }
  const find = (id) => list.find((s) => s.id === id && (s.type === 'local-candidate' || s.type === 'remote-candidate')) || null
  const ends = [find(pair.localCandidateId), find(pair.remoteCandidateId)]
  if (!ends[0] || !ends[1]) return { local: false, reason: 'no-candidate' }
  for (const c of ends) {
    const t = candidateTypeOf(c)
    if (t !== 'host') return { local: false, reason: t === 'srflx' || t === 'prflx' || t === 'relay' ? t : 'not-host' }
  }
  for (const c of ends) {
    if (addressKind(addressOf(c)) === 'public') return { local: false, reason: 'public-address' }
  }
  return { local: true, reason: 'local' }
}
