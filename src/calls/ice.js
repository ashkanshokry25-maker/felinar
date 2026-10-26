// ICE configuration and candidate rules for calls (SZ 3.5 "ICE and relay"; R 2.7.8; PEER B6).
//
//   iceConfig({ stun, turn, relayOnly }) -> { config, relay, relayOnly, operator }
//     config.iceServers = the site's own STUN list and _mw.cfg.turn only (never a default public server);
//     iceTransportPolicy 'relay' only when a relay exists and the person chose "Hide my IP from people I call";
//     bundlePolicy 'max-bundle' (every candidate belongs to the first m-line), rtcpMuxPolicy 'require'.
//   filterCandidate(candidate, { sameLan }) -> boolean, for RECEIVED candidates: private, loopback, link-local,
//     unspecified and shared (CGNAT) addresses are dropped unless both people chose "same local network" (a person who
//     did not choose it never sends them: sanitizeLocal below); mDNS '.local' names pass; other host names are dropped
//     (resolving them would be a lookup the peer chose for us).
//   sanitizeLocal(candidate, { sameLan }) -> string | null, for OUR candidates before they are sent: the same address
//     rule, and a private related address (raddr) of a server-reflexive or relay candidate is masked as 0.0.0.0 / ::.
//   sanitizeSdp(sdp, { sameLan, direction: 'in' | 'out' }) applies the matching rule to a=candidate lines and masks
//     private addresses in c= and a=rtcp: lines when sameLan is off.
// ICE restarts on network change are the session's (src/calls/session.js restartIce()).
//
// Shared code: Node >= 22 and browsers, no imports.

const STUN_RE = /^stuns?:[A-Za-z0-9.\-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/;
const STUN_V6_RE = /^stuns?:\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;
const TURN_RE = /^turns?:([A-Za-z0-9.\-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?(\?transport=(udp|tcp))?$/;
const URL_MAX = 256;
const SERVERS_MAX = 4;
const CRED_MAX = 512;
const TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

function v4Parts(a) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((x) => x >= 0 && x <= 255) ? p : null;
}

function classV4(p) {
  const [a, b] = p;
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'shared';
  if (a >= 224) return 'multicast';
  return 'public';
}

function expandV6(a) {
  let s = a;
  let v4 = null;
  const last = s.lastIndexOf(':');
  const tail = s.slice(last + 1);
  if (tail.indexOf('.') >= 0) {
    v4 = v4Parts(tail);
    if (!v4) return null;
    s = s.slice(0, last + 1) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 1) {
    groups = head;
  } else {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = head.concat(new Array(fill).fill('0'), rest);
  }
  if (groups.length !== 8) return null;
  const n = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    n.push(parseInt(g, 16));
  }
  if (v4) {
    n[6] = (v4[0] << 8) | v4[1];
    n[7] = (v4[2] << 8) | v4[3];
  }
  return n;
}

function classV6(addr) {
  let a = addr.toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(a) || a.indexOf(':') < 0) return 'invalid';
  const n = expandV6(a);
  if (!n) return 'invalid';
  if (n.every((x) => x === 0)) return 'unspecified';
  if (n.slice(0, 7).every((x) => x === 0) && n[7] === 1) return 'loopback';
  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return classV4([n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255]);
  const f = n[0];
  if ((f & 0xffc0) === 0xfe80) return 'link-local';
  if ((f & 0xffc0) === 0xfec0) return 'private'; // site-local (deprecated)
  if ((f & 0xfe00) === 0xfc00) return 'private'; // unique local, fc00::/7
  if ((f & 0xff00) === 0xff00) return 'multicast';
  return 'public';
}

/**
 * addressClass(address) -> 'public' | 'private' | 'loopback' | 'link-local' | 'unspecified' | 'shared' | 'multicast'
 *   | 'mdns' | 'hostname' | 'invalid'
 */
export function addressClass(address) {
  if (typeof address !== 'string' || address.length === 0 || address.length > 255) return 'invalid';
  const p = v4Parts(address);
  if (p) return classV4(p);
  if (address.indexOf(':') >= 0) return classV6(address);
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.local$/i.test(address)) return 'mdns';
  if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(address)) return 'hostname';
  return 'invalid';
}

/** Address classes a candidate may carry without "same local network". */
const OPEN = new Set(['public', 'mdns']);
/** Extra classes allowed when both people chose "same local network". */
const LAN = new Set(['private', 'loopback', 'link-local', 'shared']);

function allowedAddress(address, sameLan) {
  const c = addressClass(address);
  if (OPEN.has(c)) return true;
  return !!sameLan && LAN.has(c);
}

// ---------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------

/**
 * parseCandidate('candidate:...' | { candidate }) -> { foundation, component, protocol, priority, address, port, type,
 *   raddr, rport, rest: [key, value] pairs } | null. Strict about the fixed part, lenient about extensions.
 */
export function parseCandidate(c) {
  const s = typeof c === 'string' ? c : (c && typeof c.candidate === 'string' ? c.candidate : null);
  if (!s || s.length > 1024 || /[\r\n]/.test(s)) return null;
  const body = s.startsWith('a=') ? s.slice(2) : s;
  if (!body.startsWith('candidate:')) return null;
  const parts = body.slice('candidate:'.length).trim().split(/\s+/);
  if (parts.length < 8) return null;
  const [foundation, component, protocol, priority, address, port, typ, type] = parts;
  if (!/^[A-Za-z0-9+/]{1,32}$/.test(foundation)) return null;
  if (!/^\d{1,3}$/.test(component) || Number(component) < 1 || Number(component) > 256) return null;
  const proto = protocol.toLowerCase();
  if (proto !== 'udp' && proto !== 'tcp') return null;
  if (!/^\d{1,10}$/.test(priority)) return null;
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return null;
  if (typ !== 'typ' || !TYPES.has(type)) return null;
  const out = { foundation, component: Number(component), protocol: proto, priority: Number(priority), address, port: Number(port), type, raddr: null, rport: null, rest: [] };
  for (let i = 8; i + 1 < parts.length; i += 2) {
    const k = parts[i];
    const v = parts[i + 1];
    if (k === 'raddr') out.raddr = v;
    else if (k === 'rport') out.rport = /^\d{1,5}$/.test(v) ? Number(v) : null;
    else out.rest.push([k, v]);
  }
  if ((parts.length - 8) % 2 !== 0) return null;
  return out;
}

function formatCandidate(p) {
  const fields = [p.foundation, p.component, p.protocol, p.priority, p.address, p.port, 'typ', p.type];
  if (p.raddr !== null) fields.push('raddr', p.raddr);
  if (p.rport !== null) fields.push('rport', p.rport);
  for (const [k, v] of p.rest) fields.push(k, v);
  return 'candidate:' + fields.join(' ');
}

/** filterCandidate(candidate, { sameLan }) -> true when a received candidate may be given to the connection. */
export function filterCandidate(c, { sameLan = false } = {}) {
  const p = parseCandidate(c);
  if (!p) return false;
  return allowedAddress(p.address, sameLan);
}

function maskRelated(p, sameLan) {
  if (p.raddr === null || sameLan) return p;
  const cls = addressClass(p.raddr);
  if (cls === 'public' || cls === 'mdns') return p;
  return Object.assign({}, p, { raddr: p.raddr.indexOf(':') >= 0 ? '::' : '0.0.0.0', rport: 0 });
}

/** sanitizeLocal(candidate, { sameLan }) -> the candidate string to send, or null when it must stay here. */
export function sanitizeLocal(c, { sameLan = false } = {}) {
  const p = parseCandidate(c);
  if (!p || !allowedAddress(p.address, sameLan)) return null;
  return formatCandidate(maskRelated(p, sameLan));
}

// ---------------------------------------------------------------------------------------------
// SDP
// ---------------------------------------------------------------------------------------------

function maskConnLine(line, sameLan) {
  // c=IN IP4 <addr>[/ttl] and a=rtcp:<port> IN IP4 <addr>
  const m = /^(c=IN IP[46] |a=rtcp:\d+ IN IP[46] )([^\s/]+)(.*)$/.exec(line);
  if (!m || sameLan) return line;
  const cls = addressClass(m[2]);
  if (cls === 'public' || cls === 'unspecified') return line;
  const blank = m[1].indexOf('IP6') >= 0 ? '::' : '0.0.0.0';
  return m[1] + blank + m[3];
}

/**
 * sanitizeSdp(sdp, { sameLan, direction }) -> sdp. direction 'out': our own SDP before it is sent (candidates through
 * sanitizeLocal); 'in': a received SDP before setRemoteDescription (candidates through filterCandidate). Line endings
 * are kept.
 */
export function sanitizeSdp(sdp, { sameLan = false, direction = 'in' } = {}) {
  if (typeof sdp !== 'string') return sdp;
  const eol = sdp.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (line.startsWith('a=candidate:')) {
      if (direction === 'out') {
        const s = sanitizeLocal(line.slice(2), { sameLan });
        if (s) out.push('a=' + s);
      } else if (filterCandidate(line.slice(2), { sameLan })) {
        out.push(line);
      }
      continue;
    }
    if (line.startsWith('c=IN ') || line.startsWith('a=rtcp:')) {
      out.push(maskConnLine(line, sameLan));
      continue;
    }
    out.push(line);
  }
  return out.join(eol);
}

// ---------------------------------------------------------------------------------------------
// Servers
// ---------------------------------------------------------------------------------------------

/** stunServers(list) -> the valid 'stun:' / 'stuns:' URLs of the site's own list (at most 4). */
export function stunServers(list) {
  const arr = Array.isArray(list) ? list : (typeof list === 'string' ? [list] : []);
  const out = [];
  for (const u of arr) {
    if (typeof u !== 'string' || u.length > URL_MAX) continue;
    if (!STUN_RE.test(u) && !STUN_V6_RE.test(u)) continue;
    if (out.indexOf(u) < 0) out.push(u);
    if (out.length >= SERVERS_MAX) break;
  }
  return out;
}

/**
 * turnServers(turn) -> { servers: [{ urls, username, credential }], operator }. `turn` is `_mw.cfg.turn` after the
 * loader resolved R 2.7.8: option (a) static credentials { urls, username, credential, operator? } (or a list of
 * them); option (b), a credential endpoint, is fetched by the loader, which passes the answer in the same shape.
 */
export function turnServers(turn) {
  const list = Array.isArray(turn) ? turn : (turn && typeof turn === 'object' ? [turn] : []);
  const servers = [];
  let operator = null;
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const urls = (Array.isArray(t.urls) ? t.urls : [t.urls]).filter((u) => typeof u === 'string' && u.length <= URL_MAX && TURN_RE.test(u));
    if (!urls.length) continue;
    if (typeof t.username !== 'string' || typeof t.credential !== 'string') continue;
    if (t.username.length > CRED_MAX || t.credential.length > CRED_MAX) continue;
    servers.push({ urls, username: t.username, credential: t.credential });
    if (!operator && typeof t.operator === 'string' && t.operator.length > 0) operator = t.operator.slice(0, 64);
    if (servers.length >= SERVERS_MAX) break;
  }
  return { servers, operator };
}

/** iceConfig({ stun, turn, relayOnly }) -> { config, relay, relayOnly, operator }. */
export function iceConfig({ stun = [], turn = null, relayOnly = false } = {}) {
  const iceServers = [];
  const s = stunServers(stun);
  if (s.length) iceServers.push({ urls: s });
  const t = turnServers(turn);
  for (const x of t.servers) iceServers.push(x);
  const relay = t.servers.length > 0;
  const onlyRelay = relay && relayOnly === true;
  return {
    config: { iceServers, iceTransportPolicy: onlyRelay ? 'relay' : 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' },
    relay,
    relayOnly: onlyRelay,
    operator: t.operator,
    stun: s.length > 0,
  };
}
