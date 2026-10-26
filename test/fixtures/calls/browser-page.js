// The page of test/unit/calls-browser.test.mjs: src/calls/service.js on the real WebRTC of the browser, with an in-page
// SIG seam whose send() goes to Node through the exposed binding __mwRelay and whose receive side is __mwDeliver.
// iceServers are emptied (as the e2e init script does), so no STUN request leaves the machine; "same local network"
// is on because loopback candidates are private ones.
import { createCallService } from '/src/calls/service.js';

const me = window.__mwMe;
const listeners = new Set();
const cards = [];
const answers = {};
const events = { ring: [], state: [], peer: [], ended: [] };
const pcs = [];
const Native = window.RTCPeerConnection;

class LabPeerConnection extends Native {
  constructor(config) {
    super(Object.assign({}, config || {}, { iceServers: [] }));
    pcs.push(this);
    if (window.__mwTamperStats) {
      const real = this.getStats.bind(this);
      this.getStats = async (...a) => {
        const r = await real(...a);
        let remoteId = null;
        r.forEach((s) => { if (s.type === 'transport' && s.remoteCertificateId) remoteId = s.remoteCertificateId; });
        const out = new Map();
        r.forEach((s, k) => {
          out.set(k, s.type === 'certificate' && (remoteId ? s.id === remoteId : true) ? Object.assign({}, s, { fingerprint: 'AA:'.repeat(31) + 'AA' }) : s);
        });
        return out;
      };
    }
  }
}

function b64(bytes) {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}

const chat = {
  async send(pub, payload) {
    const ok = await window.__mwRelay({ to: pub, from: me.pub, b64: b64(payload) });
    return { reached: ok ? 1 : 0, route: 'direct' };
  },
  onReceive(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  listen() { return () => {}; },
  contact(pub) {
    return me.contacts.indexOf(pub) >= 0 ? { pub, nick: 'Peer', accepted: true, blocked: false, verified: false, hasChatKey: true } : null;
  },
  groupMembers() { throw Object.assign(new Error('not a member'), { code: 'E_NOT_MEMBER' }); },
  state() { return { on: true, calls: true }; },
};

window.__mwDeliver = (from, data) => {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  for (const fn of listeners) fn(from, bytes, { contact: true, listen: false, groups: [] });
  return true;
};

const svc = createCallService({
  chat, keys: { pub: me.pub }, cfg: () => ({ calls: 'contacts' }), policy: () => ({ class: 'desktop', metered: false }),
  hostOnly: false, stun: ['stun:127.0.0.1:3478'], turn: null, prefs: () => ({ sameLan: true, hideIp: false }),
  RTCPeerConnection: LabPeerConnection, mediaDevices: navigator.mediaDevices, wakeLock: navigator.wakeLock || null,
  mediaSession: navigator.mediaSession || null, deviceClass: 'desktop',
  prompt: async (kind, data) => {
    cards.push([kind, data]);
    return answers[kind] === undefined ? true : answers[kind];
  },
});
for (const e of Object.keys(events)) svc.on(e, (x) => events[e].push(x));

let lastShare = null;
document.querySelector('#share').addEventListener('click', () => {
  const call = events.state.length ? events.state[events.state.length - 1] : null;
  lastShare = 'pending';
  svc.methods['calls.screen']({ id: call && call.id, on: true }, { activation: true }).then((r) => { lastShare = r; }, (e) => { lastShare = { error: e.code || e.message }; });
});

async function inboundByMid() {
  const out = {};
  for (const pc of pcs) {
    if (pc.connectionState === 'closed') continue;
    const r = await pc.getStats();
    r.forEach((s) => { if (s.type === 'inbound-rtp') out[(s.mid === undefined ? s.kind : s.mid)] = s.bytesReceived || 0; });
  }
  return out;
}

let kept = [];
window.__mwCalls = {
  svc, cards, answers, events, pcs, ready: true,
  share: () => lastShare,
  inboundByMid,
  /** Keeps the call's capture tracks so their state can be read after the call is gone. */
  keep(id) {
    const m = svc.media(id);
    kept = m ? [m.local.audio, m.local.camera, m.local.screen].filter(Boolean) : [];
    return kept.map((t) => t.kind + ':' + t.readyState);
  },
  kept: () => kept.map((t) => t.kind + ':' + t.readyState),
  pcStates: () => pcs.map((pc) => pc.connectionState),
};
