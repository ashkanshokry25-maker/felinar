// The calls service (SVC contract of src/chat/service.js; SZ 3.5): every calls.* method behind one object the loader
// mounts after 'chat'.
//
//   createCallService(deps) -> { methods, on(event, fn) -> unsubscribe, answer(id, { video }), setVisible(visible),
//                                setNetwork(), media(id), inspect(), destroy() }
//   methods[name] = async (params, ctx) -> result, ctx = { activation, tab: 'leader' | 'follower' }
//   failures: Object.assign(new Error(msg), { code }) with SZ 3.5 codes: E_BUSY, E_DECLINED, E_NO_ANSWER,
//   E_MEDIA_DENIED, E_NO_DEVICE, E_CALL_FAILED; reused E_NOT_SIGNED_IN, E_HOST_ONLY, E_POLICY, E_NOT_CONTACT,
//   E_PEER_UNREACHABLE, E_LIMIT, E_UNSUPPORTED; and E_NEEDS_GESTURE, E_USER_CANCELLED, E_BAD_REQUEST, E_NOT_MEMBER.
//   events: 'ring' { id, from, name, kind, group, roster, expiresAt }, 'state' (the call's state()), 'peer' { id, pub,
//   state, path, mute, camera, screen, reason, code }, 'ended' { id, reason, code, duration }. No event and no method
//   returns a MediaStream: the loader's call panel gets the tracks from media(id), which the SDK never exposes.
//
// deps: { chat: the SIG seam of src/chat/service.js (send, onReceive, listen, contact, groupMembers, state, ckOf?, learn?),
//   keys (or a function: WorkingKeys, only .pub is read), cfg() (_mw.cfg; calls: 'contacts' turns calls on),
//   policy() ({ class, metered } from src/loader/policy.js), hostOnly (boolean or function), stun (the site's own STUN
//   list, MF-44), turn (_mw.cfg.turn resolved by the loader, R 2.7.8 option a or b), prefs() ({ sameLan, hideIp }: the
//   person's "same local network" and "Hide my IP from people I call"), RTCPeerConnection, mediaDevices, wakeLock,
//   mediaSession?, prompt(kind, data) -> Promise, deviceClass ('desktop' | 'android' | 'ios'), mode ('shell' | 'hub' |
//   'dropin'), now, random, setTimeout?, clearTimeout?, onSeedYield(state | null) }.
//
// Rules carried here (SZ 3.5): host-only answers E_HOST_ONLY before any request; drop-in answers E_UNSUPPORTED (a page
// load would end the call); calls off is E_POLICY; UI methods (start, accept, screen) need a loader-verified click and
// the loader's own card; the callee makes no connection before it accepts and the caller makes none (so sends no
// candidate) before an accept arrives, so a declined or ignored call shows nobody's address; offers and answers exist
// only inside SIG sealed with K_pair, and each pair checks the DTLS fingerprint against getStats; one pending ring per
// contact and at most 10 an hour, both ways; rings expire after 45 s; caps 6 people audio only, 4 with video.
//
// Browser code; every global comes in by injection (Node tests: test/fixtures/calls/fake-webrtc.mjs).

import { isPublicKeyString } from '../chain/crypto.js';
import { encodeSignal, decodeSignal, SignalGuard, RingLimiter, newCallId, isCallId, isGroupId } from './signal.js';
import { iceConfig } from './ice.js';
import { CallMedia, PeerSession } from './session.js';
import { Mesh, checkCap, capFor, politeFor } from './mesh.js';
import { mediaProfile, AdaptDriver, adaptStart, encodingsOf, readSample } from './adapt.js';
import {
  CALLS_ON, SIG_VERSION, RING_TTL_MS, ROSTER_MAX, LISTEN_MAX_MS, ENDED_KEEP_MS, ENDED_MAX, PENDING_OFFER_MS,
  PENDING_CAND_MAX, CONNECT_TIMEOUT_MS, CAP_VIDEO, CALL_METHODS, CALL_EVENTS, UI_CALL_METHODS, READ_CALL_METHODS,
  CALL_FLAGS,
} from './limits.js';

export { CALL_METHODS, CALL_EVENTS, UI_CALL_METHODS, READ_CALL_METHODS, CALL_FLAGS };

function fail(code, msg) {
  return Object.assign(new Error(msg || code), { code });
}

function args(params, names) {
  if (Array.isArray(params)) {
    const out = {};
    if (params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) return Object.assign(out, params[0]);
    names.forEach((n, i) => { if (params[i] !== undefined) out[n] = params[i]; });
    const extra = params[names.length];
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(out, extra);
    return out;
  }
  if (params && typeof params === 'object') return Object.assign({}, params);
  if (params !== undefined && names.length) return { [names[0]]: params };
  return {};
}

function val(x) {
  try {
    return typeof x === 'function' ? x() : x;
  } catch (_) {
    return undefined;
  }
}

const READS = new Set(READ_CALL_METHODS);
const LIVE_PATHS = new Set(['direct', 'relayed']);

export function createCallService(deps) {
  const d = Object.assign({
    chat: null, keys: null, cfg: () => ({}), policy: () => ({ class: 'desktop', metered: false }), hostOnly: false,
    stun: [], turn: null, prefs: () => ({}), RTCPeerConnection: null, mediaDevices: null, wakeLock: null, mediaSession: null,
    prompt: async () => false, deviceClass: 'desktop', mode: 'shell', now: () => Date.now(), random: Math.random,
    onSeedYield: () => {},
  }, deps || {});
  const now = d.now;
  const setT = d.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = d.clearTimeout || ((h) => clearTimeout(h));
  const listeners = new Map();
  const S = { destroyed: false, calls: new Map(), ended: new Map(), visible: true, yieldKey: 'null', unsubscribe: null };
  const sigGuard = new SignalGuard({ now });
  const ringsIn = new RingLimiter({ now });
  const ringsOut = new RingLimiter({ now });

  // -------------------------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------------------------

  function emit(event, data) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(data); } catch (_) { /* a listener must not break a call */ }
    }
  }

  const hostOnlyNow = () => Boolean(val(d.hostOnly));
  const cfg = () => val(d.cfg) || {};
  const callsOn = () => cfg().calls === CALLS_ON;
  const prefs = () => val(d.prefs) || {};
  const policy = () => val(d.policy) || {};
  const me = () => {
    const k = val(d.keys);
    return k && isPublicKeyString(k.pub) ? k.pub : null;
  };
  const contactOf = (pub) => {
    try { return d.chat && typeof d.chat.contact === 'function' ? d.chat.contact(pub) : null; } catch (_) { return null; }
  };
  const nameOf = (pub) => {
    const c = contactOf(pub);
    return c && c.nick ? c.nick : null;
  };

  function iceNow() {
    return iceConfig({ stun: val(d.stun) || [], turn: val(d.turn) || null, relayOnly: prefs().hideIp === true });
  }

  function profileFor(call) {
    return mediaProfile({ cls: policy().class || 'desktop', mesh: call ? call.mesh.isMesh() : false });
  }

  function callTimer(call, ms, fn) {
    const h = setT(() => {
      call.timers.delete(h);
      if (call.state !== 'ended') fn();
    }, ms);
    call.timers.add(h);
    return h;
  }

  function busy() {
    for (const c of S.calls.values()) if (c.state !== 'ended') return true;
    return false;
  }

  // -------------------------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------------------------

  /**
   * guard(name, ctx, { ui, network, feature }): the SVC gating order. network: the method can reach peers (E_HOST_ONLY
   * first); feature: it starts or joins a call (E_POLICY when calls are off). Hanging up, muting and declining keep
   * working when the owner turns calls off during a call.
   */
  function guard(name, ctx, { ui = false, network = true, feature = false } = {}) {
    if (S.destroyed) throw fail('E_POLICY', 'calls are closed');
    const read = READS.has(name);
    if (read) return;
    if (network && hostOnlyNow()) throw fail('E_HOST_ONLY', 'calls need peers; this site is open in host-only mode');
    if (d.mode === 'dropin') throw fail('E_UNSUPPORTED', 'calls need the full loader: a page load would end the call');
    const c = ctx || {};
    if (c.tab === 'follower') throw fail('E_POLICY', 'calls run in the leader tab');
    if (feature && !callsOn()) throw fail('E_POLICY', 'this site has calls turned off');
    if (ui && c.activation !== true) throw fail('E_NEEDS_GESTURE', 'call this from a click');
    if (!me()) throw fail('E_NOT_SIGNED_IN', 'sign in first');
  }

  function ready() {
    if (typeof d.RTCPeerConnection !== 'function') throw fail('E_UNSUPPORTED', 'this browser cannot make calls');
    if (!d.mediaDevices || typeof d.mediaDevices.getUserMedia !== 'function') throw fail('E_UNSUPPORTED', 'this browser cannot use a microphone here');
    if (!d.chat || typeof d.chat.send !== 'function') throw fail('E_POLICY', 'calls need messages on this site');
    const st = typeof d.chat.state === 'function' ? val(d.chat.state) : { on: true };
    if (!st || st.on !== true) throw fail('E_POLICY', 'turn on messages first (mw.chat.enable)');
    const ice = iceNow();
    if (!ice.stun && !ice.relay) throw fail('E_POLICY', 'this site has not named its own STUN server for calls');
    if (prefs().hideIp === true && !ice.relay) throw fail('E_POLICY', 'this site has no relay, so your IP address cannot be hidden from the people you call');
    return ice;
  }

  async function card(kind, data) {
    let r;
    try { r = await d.prompt(kind, data); } catch (_) { r = false; }
    return r;
  }

  async function confirm(kind, data) {
    const r = await card(kind, data);
    if (r !== true) throw fail('E_USER_CANCELLED', 'cancelled');
  }

  // -------------------------------------------------------------------------------------------
  // Call records
  // -------------------------------------------------------------------------------------------

  function newCall({ id, role, caller, group = null, video = false, roster = [] }) {
    const call = {
      id, role, caller, group, video: !!video, state: 'ringing', startedAt: now(), connectedAt: null, endedAt: null,
      mesh: new Mesh({ me: me(), caller, video, now }), peers: new Map(), adapt: new Map(), pendingOffers: new Map(),
      pendingCands: new Map(), media: null, seq: 0, timers: new Set(), local: { mute: false, camera: false, screen: false },
      remote: new Map(), notice: null, ended: null, listenStop: null, ringRoster: roster.slice(0, ROSTER_MAX),
      ringExpires: null, ice: null, paused: { audio: false, camera: false },
    };
    S.calls.set(id, call);
    return call;
  }

  // What a phone does to a call in the background is stated only after the gate rows ran (CALL_FLAGS.phoneNotes, false
  // until G-PS-1 to G-PS-4 and G-CL-2 pass; SZ section 4 P0, 3.1.10): until then no state names a phone note.
  function platformNote() {
    if (!CALL_FLAGS.phoneNotes) return null;
    if (d.deviceClass === 'ios') return 'call.ios';
    if (d.deviceClass === 'android') return 'call.android';
    return null;
  }

  function participants(call) {
    const list = call.mesh.list();
    if (call.role === 'callee' && call.state === 'ringing') {
      for (const p of call.ringRoster) if (!list.some((x) => x.pub === p)) list.push({ pub: p, state: 'ringing', reason: null });
    }
    return list.map((x) => {
      const peer = call.peers.get(x.pub);
      const r = call.remote.get(x.pub) || {};
      const c = contactOf(x.pub);
      return {
        pub: x.pub, state: x.state, reason: x.reason || null, path: peer && peer.path ? peer.path : null,
        mute: !!r.mute, camera: !!r.camera, screen: !!r.screen, checked: !!(peer && peer.verified === true),
        verified: !!(c && c.verified), name: c && c.nick ? c.nick : null,
      };
    });
  }

  /** True when the adaptation ladder paused this tab's camera on some pair (the panel says call.videoPaused). */
  function videoPaused(call) {
    for (const drv of call.adapt.values()) if (drv.state.rung === drv.state.rungs.length - 1) return true;
    return false;
  }

  function publicState(call) {
    return {
      id: call.id, role: call.role, state: call.state, kind: call.video ? 'video' : 'audio', caller: call.caller,
      group: call.group, startedAt: call.startedAt, connectedAt: call.connectedAt, endedAt: call.endedAt,
      expiresAt: call.role === 'callee' && call.state === 'ringing' ? call.ringExpires : null,
      local: Object.assign({ videoPaused: videoPaused(call) }, call.local), paused: Object.assign({}, call.paused), participants: participants(call),
      notice: call.notice, platform: platformNote(), relay: !!(call.ice && call.ice.relay), relayOnly: !!(call.ice && call.ice.relayOnly),
      operator: call.ice ? call.ice.operator : null, error: call.ended ? call.ended.code : null,
      reason: call.ended ? call.ended.reason : null,
    };
  }

  function emitState(call) {
    emit('state', publicState(call));
  }

  function emitPeer(call, pub, extra = {}) {
    const p = participants(call).find((x) => x.pub === pub);
    if (!p) return;
    emit('peer', Object.assign({ id: call.id }, p, extra));
  }

  // -------------------------------------------------------------------------------------------
  // SIG in and out
  // -------------------------------------------------------------------------------------------

  async function sendSig(call, pub, body) {
    const msg = Object.assign({}, body, { v: SIG_VERSION, c: call.id, s: call.seq++, t: now() });
    if (call.group && msg.g === undefined) msg.g = call.group;
    const bytes = encodeSignal(msg);
    const r = await d.chat.send(pub, bytes, call.group ? { group: call.group } : {});
    return r || { reached: 0 };
  }

  /** A message outside a pair (busy, decline, hangup, leave): seq comes from the call (0 for a busy reply). */
  function sendLoose(pub, callId, k, group, seq = 0) {
    try {
      const msg = { v: SIG_VERSION, c: callId, k, s: seq, t: now() };
      if (group) msg.g = group;
      Promise.resolve(d.chat.send(pub, encodeSignal(msg), group ? { group } : {})).catch(() => {});
    } catch (_) { /* nothing to tell */ }
  }

  function onSig(from, payload, meta) {
    if (S.destroyed || hostOnlyNow() || !callsOn()) return;
    const mine = me();
    if (!mine || from === mine || !isPublicKeyString(from)) return;
    const r = decodeSignal(payload);
    if (!r.ok) return;
    const msg = r.msg;
    if (!sigGuard.accept(from, msg).ok) return;
    if (msg.k === 'ring') return onRing(from, msg, meta || {});
    const call = S.calls.get(msg.c);
    if (!call) {
      const e = S.ended.get(msg.c);
      if (e && e.people.has(from) && (msg.k === 'accept' || msg.k === 'offer')) sendLoose(from, msg.c, 'hangup', e.group, e.seq++);
      return;
    }
    if (call.state === 'ended') return;
    if (!call.mesh.isMember(from)) {
      if (call.role === 'callee' && call.state !== 'ringing') {
        if (msg.k === 'offer') bufferOffer(call, from, msg);
        else if (msg.k === 'ice') bufferCand(call, from, msg);
      }
      return;
    }
    switch (msg.k) {
      case 'accept': return onAccept(call, from, msg);
      case 'decline':
      case 'busy': return onRefused(call, from, msg.k);
      case 'offer': return onOffer(call, from, msg);
      case 'answer':
      case 'ice': return onPairSignal(call, from, msg);
      case 'hangup':
      case 'leave': return onGone(call, from);
      default: return undefined;
    }
  }

  function bufferOffer(call, from, msg) {
    if (call.pendingOffers.size >= ROSTER_MAX && !call.pendingOffers.has(from)) return;
    call.pendingOffers.set(from, { msg, at: now() });
  }

  function bufferCand(call, from, msg) {
    const list = call.pendingCands.get(from) || [];
    if (list.length >= PENDING_CAND_MAX) return;
    list.push({ msg, at: now() });
    call.pendingCands.set(from, list);
    if (call.pendingCands.size > ROSTER_MAX + 1) call.pendingCands.delete(call.pendingCands.keys().next().value);
  }

  function onRing(from, msg, meta) {
    if (S.calls.has(msg.c) || S.ended.has(msg.c)) return;
    const contact = contactOf(from);
    if (contact && contact.blocked) return;
    const okContact = !!(contact && contact.accepted) && meta.contact !== false;
    const okGroup = !!(msg.g && Array.isArray(meta.groups) && meta.groups.indexOf(msg.g) >= 0);
    if (!okContact && !okGroup) return;
    const video = !!(msg.media && msg.media.v);
    const roster = (msg.roster || []).filter((p) => p !== me() && p !== from);
    if (roster.length + 2 > capFor(video)) return; // a ring over the cap is not shown
    if (!ringsIn.add(from, msg.c).ok) return; // one pending ring per contact, 10 an hour
    if (busy()) {
      ringsIn.done(from, msg.c);
      sendLoose(from, msg.c, 'busy', msg.g || null);
      return;
    }
    const call = newCall({ id: msg.c, role: 'callee', caller: from, group: msg.g || null, video, roster });
    call.mesh.add(from, 'ringing');
    call.ringExpires = now() + RING_TTL_MS;
    callTimer(call, RING_TTL_MS, () => {
      if (call.state === 'ringing') endCall(call, 'no-answer', 'E_NO_ANSWER', { notify: false });
    });
    emit('ring', {
      id: call.id, from, name: contact && contact.nick ? contact.nick : null, kind: video ? 'video' : 'audio',
      group: call.group, roster: call.ringRoster.slice(), expiresAt: call.ringExpires,
    });
    emitState(call);
  }

  function onAccept(call, from, msg) {
    const p = call.mesh.get(from);
    if (call.role !== 'caller' || !p || p.state !== 'ringing') return;
    ringsOut.done(from, call.id);
    call.remote.set(from, { mute: false, camera: !!(msg.media && msg.media.v), screen: false });
    call.mesh.set(from, 'connecting');
    if (call.state === 'ringing') call.state = 'connecting';
    openPeer(call, from, true);
    broadcastRoster(call);
    refreshProfiles(call);
    emitPeer(call, from);
    emitState(call);
    yieldSeeding();
  }

  function onRefused(call, from, kind) {
    if (call.role !== 'caller') return;
    const p = call.mesh.get(from);
    if (!p || p.state !== 'ringing') return;
    ringsOut.done(from, call.id);
    call.mesh.set(from, 'left', kind === 'busy' ? 'busy' : 'declined');
    emitPeer(call, from);
    if (call.mesh.finished()) {
      const joined = call.connectedAt !== null;
      endCall(call, kind === 'busy' ? 'busy' : 'declined', joined ? null : (kind === 'busy' ? 'E_BUSY' : 'E_DECLINED'), { notify: false });
    } else {
      refreshProfiles(call);
      emitState(call);
    }
  }

  function onOffer(call, from, msg) {
    if (call.state === 'ringing' || call.state === 'ended') return; // never a connection from an unaccepted offer
    let peer = call.peers.get(from);
    if (call.role === 'callee' && from === call.caller && Array.isArray(msg.roster)) applyRoster(call, msg.roster);
    if (!peer) {
      if (call.role === 'caller') return; // the caller offers to acceptors; it takes no new pair from an offer
      if (from !== call.caller && !call.mesh.roster.has(from)) {
        bufferOffer(call, from, msg);
        return;
      }
      if (call.mesh.count() > capFor(call.video || call.local.camera)) return;
      peer = openPeer(call, from, false);
    }
    if (msg.media) updateRemote(call, from, { camera: !!msg.media.v, screen: !!msg.media.s });
    peer.handleSignal(msg).catch(() => {});
  }

  function onPairSignal(call, from, msg) {
    const peer = call.peers.get(from);
    if (!peer) {
      if (msg.k === 'ice') bufferCand(call, from, msg);
      return;
    }
    if (msg.k === 'answer' && msg.media) updateRemote(call, from, { camera: !!msg.media.v, screen: !!msg.media.s });
    peer.handleSignal(msg).catch(() => {});
  }

  function onGone(call, from) {
    if (call.role === 'callee' && call.state === 'ringing') {
      if (from === call.caller) endCall(call, 'cancelled', null, { notify: false });
      return;
    }
    closePeer(call, from, 'hangup');
    if (call.role === 'caller') {
      ringsOut.done(from, call.id);
      broadcastRoster(call);
    }
    afterLeave(call);
  }

  function afterLeave(call) {
    if (call.state === 'ended') return;
    // A call that never connected and lost its last pair did not work (the other side gave up on the path, or left
    // while connecting): both sides show "Could not connect" (E_CALL_FAILED) rather than a normal end.
    if (call.mesh.finished()) {
      const never = call.connectedAt === null;
      endCall(call, never ? 'failed' : 'hangup', never ? 'E_CALL_FAILED' : null, { notify: true });
    } else {
      refreshProfiles(call);
      emitState(call);
      yieldSeeding();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Rosters (the caller names who joined; everyone else connects once, the lower key offering)
  // -------------------------------------------------------------------------------------------

  function cksFor(pubs) {
    if (!d.chat || typeof d.chat.ckOf !== 'function') return undefined;
    const out = [];
    for (const p of pubs) {
      try {
        const ck = d.chat.ckOf(p);
        if (ck) out.push(ck);
      } catch (_) { /* no key */ }
    }
    return out.length ? out : undefined;
  }

  function rosterMessage(call, pub) {
    const pubs = call.mesh.rosterFor(pub);
    const m = { t: 'roster', pubs };
    const cks = cksFor(pubs);
    if (cks) m.cks = cks;
    return m;
  }

  function broadcastRoster(call) {
    if (call.role !== 'caller') return;
    for (const [pub, peer] of call.peers) if (peer.controlOpen) peer.sendControl(rosterMessage(call, pub));
  }

  function relisten(call) {
    if (!d.chat || typeof d.chat.listen !== 'function') return;
    const pubs = new Set([call.caller]);
    for (const p of call.ringRoster) pubs.add(p);
    for (const p of call.mesh.roster) pubs.add(p);
    pubs.delete(me());
    const stop = call.listenStop;
    try {
      call.listenStop = d.chat.listen(Array.from(pubs), now() + LISTEN_MAX_MS);
    } catch (_) {
      call.listenStop = null;
    }
    if (typeof stop === 'function') {
      try { stop(); } catch (_) { /* gone */ }
    }
  }

  function applyRoster(call, pubs) {
    if (call.role !== 'callee') return;
    const { add, drop } = call.mesh.applyRoster(pubs);
    if (!add.length && !drop.length) return;
    relisten(call);
    for (const p of drop) closePeer(call, p, 'hangup');
    const t = now();
    for (const p of add) {
      if (call.peers.has(p)) continue;
      if (call.mesh.count() > capFor(call.video || call.local.camera)) break;
      if (call.mesh.shouldOffer(p)) {
        openPeer(call, p, true);
      } else {
        const pend = call.pendingOffers.get(p);
        call.pendingOffers.delete(p);
        if (pend && t - pend.at <= PENDING_OFFER_MS) onOffer(call, p, pend.msg);
      }
    }
    refreshProfiles(call);
    emitState(call);
    if (drop.length) afterLeave(call);
  }

  // -------------------------------------------------------------------------------------------
  // Pairs
  // -------------------------------------------------------------------------------------------

  function mediaFlags(call) {
    return { a: true, v: !!call.local.camera, s: !!call.local.screen };
  }

  function openPeer(call, pub, offerer) {
    const peer = new PeerSession({
      RTCPeerConnection: d.RTCPeerConnection, config: call.ice.config, me: me(), them: pub, polite: politeFor(me(), pub),
      offerer, media: call.media, sameLan: prefs().sameLan === true,
      sendSignal: (body) => sendSig(call, pub, body),
      offerExtra: () => (call.role === 'caller' ? { media: mediaFlags(call), roster: call.mesh.rosterFor(pub) } : { media: mediaFlags(call) }),
      onState: (st, info) => onPeerState(call, pub, st, info || {}),
      onControl: (m) => onControl(call, pub, m),
      onControlOpen: () => onControlOpen(call, pub),
      onTrack: () => emitPeer(call, pub),
      setTimeout: setT, clearTimeout: clearT, now,
    });
    call.peers.set(pub, peer);
    if (!call.mesh.get(pub)) call.mesh.add(pub, 'connecting');
    else call.mesh.set(pub, 'connecting');
    peer.start();
    peer.applyEncodings(encodingsOf(adaptStart(profileFor(call), now()))).catch(() => {});
    const cands = call.pendingCands.get(pub);
    call.pendingCands.delete(pub);
    if (cands) {
      const t = now();
      for (const c of cands) if (t - c.at <= PENDING_OFFER_MS) peer.handleSignal(c.msg).catch(() => {});
    }
    return peer;
  }

  function closePeer(call, pub, reason) {
    const peer = call.peers.get(pub);
    call.peers.delete(pub);
    if (peer) peer.close(reason, { notify: false });
    const a = call.adapt.get(pub);
    call.adapt.delete(pub);
    if (a) a.stop();
    if (call.mesh.set(pub, 'left', reason)) emitPeer(call, pub);
  }

  function onPeerState(call, pub, st, info) {
    if (call.state === 'ended') return;
    if (st === 'left') {
      if (call.peers.get(pub)) call.peers.delete(pub);
      const a = call.adapt.get(pub);
      call.adapt.delete(pub);
      if (a) a.stop();
      const reason = info.reason === 'fingerprint' ? 'fingerprint' : (info.code ? 'failed' : (info.reason || 'hangup'));
      call.mesh.set(pub, 'left', reason);
      if (call.role === 'caller') broadcastRoster(call);
      emitPeer(call, pub, { code: info.code || null });
      if (call.mesh.finished()) {
        endCall(call, reason === 'fingerprint' ? 'fingerprint' : (info.code ? 'failed' : 'hangup'), info.code || null, { notify: true });
      } else {
        refreshProfiles(call);
        emitState(call);
        yieldSeeding();
      }
      return;
    }
    call.mesh.set(pub, st);
    if (LIVE_PATHS.has(st)) {
      if (!call.connectedAt) call.connectedAt = now();
      call.state = 'connected';
      startAdapt(call, pub);
      if (info.first) sessionActions(call);
    } else if (st === 'reconnecting') {
      const anyUp = call.mesh.list().some((x) => LIVE_PATHS.has(x.state));
      if (!anyUp) call.state = 'reconnecting';
    }
    updateWake(call);
    yieldSeeding();
    emitPeer(call, pub);
    emitState(call);
  }

  function updateRemote(call, pub, flags) {
    const r = Object.assign({ mute: false, camera: false, screen: false }, call.remote.get(pub) || {});
    for (const k of ['mute', 'camera', 'screen']) if (typeof flags[k] === 'boolean') r[k] = flags[k];
    call.remote.set(pub, r);
  }

  function onControl(call, pub, m) {
    if (call.state === 'ended') return;
    if (m.t === 'state') {
      updateRemote(call, pub, m);
      updateWake(call);
      emitPeer(call, pub);
      return;
    }
    if (m.t === 'roster') {
      if (call.role !== 'callee' || pub !== call.caller) return; // only the caller names the roster
      if (Array.isArray(m.cks) && d.chat && typeof d.chat.learn === 'function') {
        for (const ck of m.cks) Promise.resolve(d.chat.learn(ck)).catch(() => {});
      }
      applyRoster(call, m.pubs);
    }
  }

  function onControlOpen(call, pub) {
    const peer = call.peers.get(pub);
    if (!peer) return;
    peer.sendControl({ t: 'state', mute: !!call.local.mute, camera: !!call.local.camera, screen: !!call.local.screen });
    if (call.role === 'caller') peer.sendControl(rosterMessage(call, pub));
  }

  function broadcastState(call) {
    const m = { t: 'state', mute: !!call.local.mute, camera: !!call.local.camera, screen: !!call.local.screen };
    for (const peer of call.peers.values()) peer.sendControl(m);
  }

  // -------------------------------------------------------------------------------------------
  // Adaptation, Wake Lock, Media Session, the seeding yield
  // -------------------------------------------------------------------------------------------

  function startAdapt(call, pub) {
    if (call.adapt.has(pub)) return;
    const peer = call.peers.get(pub);
    if (!peer) return;
    const drv = new AdaptDriver({
      getStats: () => peer.getStats(),
      apply: (enc) => peer.applyEncodings(enc),
      profile: profileFor(call),
      setTimeout: setT, clearTimeout: clearT, now,
      cameraMid: () => peer.cameraMid(),
      onSample: (sample, info) => {
        peer.lastSample = sample;
        if (peer.limited !== info.limited) {
          peer.limited = info.limited;
          yieldSeeding();
        }
        if (info.changed) emitState(call); // the panel shows a paused or restored camera (call.videoPaused)
        if (hostOnlyNow()) endAll('host-only');
        else if (!me()) endAll('signed-out');
      },
    });
    call.adapt.set(pub, drv);
    drv.start();
  }

  function refreshProfiles(call) {
    const prof = profileFor(call);
    for (const [pub, peer] of call.peers) {
      const drv = call.adapt.get(pub);
      if (drv) drv.setProfile(prof);
      else peer.applyEncodings(encodingsOf(adaptStart(prof, now()))).catch(() => {});
    }
  }

  function hasVideo(call) {
    if (call.local.camera) return true;
    for (const r of call.remote.values()) if (r.camera) return true;
    return false;
  }

  function updateWake(call) {
    if (!call.media) return;
    const want = S.visible && (call.state === 'connected' || call.state === 'reconnecting') && hasVideo(call);
    call.media.wake(want).catch(() => {});
  }

  function sessionActions(call) {
    if (!call.media) return;
    call.media.setActions({
      togglemicrophone: () => { setMute(call, !call.local.mute); },
      togglecamera: () => { setCamera(call, !call.local.camera).catch(() => {}); },
      hangup: () => { endCall(call, 'hangup', null, { notify: true }); },
    });
  }

  function yieldSeeding() {
    const active = Array.from(S.calls.values()).filter((c) => c.state === 'connecting' || c.state === 'connected' || c.state === 'reconnecting');
    let st = null;
    if (active.length) {
      let connections = 0;
      let limited = false;
      let video = false;
      for (const c of active) {
        connections += c.peers.size;
        for (const p of c.peers.values()) if (p.limited) limited = true;
        if (hasVideo(c) || c.local.screen) video = true;
      }
      st = { active: true, limited, connections, video };
    }
    const key = JSON.stringify(st);
    if (key === S.yieldKey) return;
    S.yieldKey = key;
    try { d.onSeedYield(st); } catch (_) { /* the loader's budget */ }
  }

  // -------------------------------------------------------------------------------------------
  // Local media changes
  // -------------------------------------------------------------------------------------------

  function makeMedia(call) {
    return new CallMedia({
      mediaDevices: d.mediaDevices, wakeLock: d.wakeLock, mediaSession: d.mediaSession,
      onEvent: (e) => onMediaEvent(call, e),
    });
  }

  function onMediaEvent(call, e) {
    if (call.state === 'ended') return;
    if (e.type === 'screen-ended') {
      setScreenOff(call).catch(() => {});
      return;
    }
    if (e.type === 'track' && (e.slot === 'audio' || e.slot === 'camera')) {
      call.paused[e.slot] = e.state !== 'live';
      emitState(call);
    }
  }

  function setMute(call, on) {
    call.local.mute = !!on;
    if (call.media) call.media.setMuted(call.local.mute);
    broadcastState(call);
    emitState(call);
    return call.local.mute;
  }

  async function setCamera(call, on) {
    if (on) {
      if (call.mesh.count() > CAP_VIDEO) throw fail('E_LIMIT', 'calls with more than ' + CAP_VIDEO + ' people have no video');
      const t = await call.media.setCamera(true);
      if (call.state === 'ended') return false;
      for (const peer of call.peers.values()) await peer.setTrack('camera', t);
      call.local.camera = true;
    } else {
      for (const peer of call.peers.values()) await peer.setTrack('camera', null);
      await call.media.setCamera(false);
      call.local.camera = false;
    }
    call.paused.camera = false;
    broadcastState(call);
    updateWake(call);
    yieldSeeding();
    emitState(call);
    return call.local.camera;
  }

  async function setScreenOff(call) {
    for (const peer of call.peers.values()) await peer.setTrack('screen', null);
    if (call.media) call.media.stopScreen();
    call.local.screen = false;
    broadcastState(call);
    yieldSeeding();
    emitState(call);
  }

  // -------------------------------------------------------------------------------------------
  // Ending
  // -------------------------------------------------------------------------------------------

  function endCall(call, reason, code = null, { notify = true } = {}) {
    if (call.state === 'ended') return;
    const peers = Array.from(call.peers.entries());
    const noChannel = peers.filter(([, p]) => !p.controlOpen).map(([pub]) => pub);
    const ringing = call.role === 'caller' ? call.mesh.ringing() : [];
    call.state = 'ended';
    call.endedAt = now();
    call.ended = { reason, code };
    for (const h of call.timers) clearT(h);
    call.timers.clear();
    for (const [, p] of peers) p.close(reason, { notify });
    call.peers.clear();
    for (const a of call.adapt.values()) a.stop();
    call.adapt.clear();
    if (notify) {
      const k = call.mesh.count() > 2 ? 'leave' : 'hangup';
      for (const pub of ringing) sendLoose(pub, call.id, 'hangup', call.group, call.seq++);
      for (const pub of noChannel) sendLoose(pub, call.id, k, call.group, call.seq++);
    }
    if (call.media) call.media.stop();
    if (typeof call.listenStop === 'function') {
      try { call.listenStop(); } catch (_) { /* gone */ }
    }
    call.listenStop = null;
    const people = new Set([call.caller]);
    for (const x of call.mesh.list()) {
      people.add(x.pub);
      if (x.state !== 'left') call.mesh.set(x.pub, 'left', reason);
      ringsOut.done(x.pub, call.id);
    }
    ringsIn.done(call.caller, call.id);
    S.calls.delete(call.id);
    S.ended.set(call.id, { at: now(), people, group: call.group, seq: call.seq, state: publicState(call) });
    while (S.ended.size > ENDED_MAX) S.ended.delete(S.ended.keys().next().value);
    const t = now();
    for (const [id, e] of S.ended) if (t - e.at > ENDED_KEEP_MS) S.ended.delete(id);
    emit('ended', { id: call.id, reason, code, duration: call.connectedAt ? call.endedAt - call.connectedAt : 0 });
    emitState(call);
    yieldSeeding();
  }

  function endAll(reason) {
    for (const call of Array.from(S.calls.values())) endCall(call, reason, null, { notify: true });
  }

  function ringTimeout(call) {
    if (call.state === 'ended') return;
    for (const pub of call.mesh.ringing()) {
      call.mesh.set(pub, 'left', 'no-answer');
      ringsOut.done(pub, call.id);
      sendLoose(pub, call.id, 'hangup', call.group, call.seq++);
      emitPeer(call, pub);
    }
    if (call.mesh.finished()) endCall(call, 'no-answer', call.connectedAt ? null : 'E_NO_ANSWER', { notify: false });
    else {
      refreshProfiles(call);
      emitState(call);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Methods
  // -------------------------------------------------------------------------------------------

  function resolveTargets(to) {
    const mine = me();
    const checkContact = (pub) => {
      if (!isPublicKeyString(pub)) throw fail('E_BAD_REQUEST', 'expected a p256: key');
      const c = contactOf(pub);
      if (!c || !c.accepted || c.blocked) throw fail('E_NOT_CONTACT', 'calls are for accepted contacts');
      return pub;
    };
    if (typeof to === 'string' && to.startsWith('p256:')) {
      if (to === mine) throw fail('E_BAD_REQUEST', 'you cannot call yourself');
      return { pubs: [checkContact(to)], group: null };
    }
    if (Array.isArray(to)) {
      const pubs = Array.from(new Set(to)).filter((p) => p !== mine).map(checkContact);
      if (!pubs.length) throw fail('E_BAD_REQUEST', 'nobody to call');
      return { pubs, group: null };
    }
    if (isGroupId(to)) {
      if (!d.chat || typeof d.chat.groupMembers !== 'function') throw fail('E_NOT_MEMBER', 'not a member of this group');
      let members;
      try {
        members = d.chat.groupMembers(to);
      } catch (e) {
        throw fail(e && e.code === 'E_NOT_MEMBER' ? 'E_NOT_MEMBER' : 'E_BAD_REQUEST', 'not a member of this group');
      }
      const pubs = (members || []).filter((p) => p !== mine && isPublicKeyString(p) && !((contactOf(p) || {}).blocked));
      if (!pubs.length) throw fail('E_BAD_REQUEST', 'nobody else is in this group');
      return { pubs, group: to };
    }
    throw fail('E_BAD_REQUEST', 'to is a p256: key, a list of keys or a group id');
  }

  function activeCall(id) {
    const call = S.calls.get(id);
    if (!call || call.state === 'ended') throw fail('E_BAD_REQUEST', 'no such call');
    return call;
  }

  function incoming(id) {
    const call = S.calls.get(id);
    if (!call || call.role !== 'callee' || call.state !== 'ringing') throw fail('E_BAD_REQUEST', 'no call is ringing with this id');
    return call;
  }

  function inCall(id) {
    const call = activeCall(id);
    if (call.role === 'callee' && call.state === 'ringing') throw fail('E_BAD_REQUEST', 'accept the call first');
    if (!call.media) throw fail('E_BAD_REQUEST', 'the call has no media yet');
    return call;
  }

  async function doAccept(call, video) {
    if (call.state !== 'ringing') throw fail(call.ended && call.ended.code ? call.ended.code : 'E_BAD_REQUEST', 'this call is no longer ringing');
    const ice = ready();
    call.ice = ice;
    const media = makeMedia(call);
    call.media = media;
    try {
      await media.open({ video: !!video });
    } catch (e) {
      call.media = null;
      throw fail(e.code || 'E_NO_DEVICE', e.message);
    }
    if (call.state !== 'ringing') {
      media.stop();
      throw fail(call.ended && call.ended.code ? call.ended.code : 'E_CALL_FAILED', 'the call ended while it was being answered');
    }
    call.local.camera = !!media.camera;
    call.state = 'connecting';
    call.mesh.set(call.caller, 'connecting');
    ringsIn.done(call.caller, call.id);
    relisten(call);
    try {
      const r = await sendSig(call, call.caller, { k: 'accept', media: mediaFlags(call) });
      if (!r || !r.reached) throw fail('E_PEER_UNREACHABLE', 'not connected');
    } catch (e) {
      endCall(call, 'unreachable', 'E_PEER_UNREACHABLE', { notify: false });
      throw fail('E_PEER_UNREACHABLE', 'the caller is not connected now');
    }
    callTimer(call, CONNECT_TIMEOUT_MS, () => {
      if (!call.connectedAt) endCall(call, 'failed', 'E_CALL_FAILED', { notify: true });
    });
    emitState(call);
    yieldSeeding();
    return publicState(call);
  }

  function declineCall(call) {
    sendLoose(call.caller, call.id, 'decline', call.group, call.seq++);
    endCall(call, 'declined', null, { notify: false });
  }

  const methods = {};
  function def(name, fn, opts = {}) {
    methods[name] = async (params, ctx) => {
      guard(name, ctx, opts);
      return fn(params, ctx || {});
    };
  }

  def('calls.start', async (params) => {
    const p = args(params, ['to']);
    const ice = ready();
    if (busy()) throw fail('E_BUSY', 'already in a call');
    const targets = resolveTargets(p.to);
    const video = p.video === true;
    checkCap(targets.pubs.length + 1, video);
    if (targets.pubs.length === 1 && !targets.group) {
      const c = contactOf(targets.pubs[0]);
      if (c && c.hasChatKey === false) throw fail('E_PEER_UNREACHABLE', 'this person is not connected now');
    }
    for (const pub of targets.pubs) {
      if (!ringsOut.check(pub).ok) throw fail('E_LIMIT', 'too many calls to this person; wait a while');
    }
    const prof = mediaProfile({ cls: policy().class || 'desktop', mesh: targets.pubs.length > 1 });
    const relay = ice.relay ? { operator: ice.operator } : null;
    const names = targets.pubs.map(nameOf);
    if (targets.pubs.length === 1 && !targets.group) {
      await confirm('call.start', { to: targets.pubs[0], name: names[0], video, relay, relayOnly: ice.relayOnly, metered: prof.metered });
    } else {
      await confirm('call.group', { role: 'caller', to: targets.pubs.slice(), names, group: targets.group, video, relay, relayOnly: ice.relayOnly, metered: prof.metered });
    }
    let wantVideo = video;
    if (video && prof.metered) {
      await confirm('call.metered', { video: true });
      wantVideo = false;
    }
    if (busy()) throw fail('E_BUSY', 'already in a call');
    const call = newCall({ id: newCallId(), role: 'caller', caller: me(), group: targets.group, video: wantVideo });
    call.ice = ice;
    if (video && prof.metered) call.notice = 'metered';
    const media = makeMedia(call);
    call.media = media;
    try {
      await media.open({ video: wantVideo });
    } catch (e) {
      S.calls.delete(call.id);
      throw fail(e.code || 'E_NO_DEVICE', e.message);
    }
    call.local.camera = !!media.camera;
    for (const pub of targets.pubs) call.mesh.add(pub, 'ringing');
    const unreachable = [];
    await Promise.all(targets.pubs.map(async (pub) => {
      const roster = targets.pubs.filter((x) => x !== pub).slice(0, ROSTER_MAX);
      try {
        const r = await sendSig(call, pub, { k: 'ring', media: { a: true, v: wantVideo }, roster });
        if (r && r.reached > 0) ringsOut.add(pub, call.id);
        else unreachable.push(pub);
      } catch (_) {
        unreachable.push(pub);
      }
    }));
    for (const pub of unreachable) call.mesh.set(pub, 'left', 'unreachable');
    if (call.mesh.finished()) {
      endCall(call, 'unreachable', 'E_PEER_UNREACHABLE', { notify: false });
      throw fail('E_PEER_UNREACHABLE', targets.pubs.length === 1 ? 'this person is not connected now' : 'nobody in this call is connected now');
    }
    callTimer(call, RING_TTL_MS, () => ringTimeout(call));
    emitState(call);
    return publicState(call);
  }, { ui: true, feature: true });

  def('calls.accept', async (params) => {
    const p = args(params, ['id']);
    const call = incoming(p.id);
    const ice = ready();
    const prof = mediaProfile({ cls: policy().class || 'desktop', mesh: call.ringRoster.length > 0 });
    const group = !!call.group || call.ringRoster.length > 0;
    const data = {
      id: call.id, role: 'callee', from: call.caller, name: nameOf(call.caller), kind: call.video ? 'video' : 'audio',
      roster: call.ringRoster.slice(), names: call.ringRoster.map(nameOf), group: call.group,
      relay: ice.relay ? { operator: ice.operator } : null, relayOnly: ice.relayOnly, metered: prof.metered,
      video: p.video === true ? true : (p.video === false ? false : null),
    };
    const choice = await card(group ? 'call.group' : 'call.incoming', data);
    if (choice === 'decline') {
      if (call.state === 'ringing') declineCall(call);
      throw fail('E_USER_CANCELLED', 'declined');
    }
    if (choice !== true && choice !== 'audio' && choice !== 'video') throw fail('E_USER_CANCELLED', 'cancelled');
    let video;
    if (choice === 'video') video = true;
    else if (choice === 'audio') video = false;
    else if (typeof p.video === 'boolean') video = p.video;
    else video = call.video && !prof.audioDefault;
    if (video && prof.metered) {
      await confirm('call.metered', { id: call.id, video: true });
      video = false;
      call.notice = 'metered';
    }
    return doAccept(call, video);
  }, { ui: true, feature: true });

  def('calls.decline', async (params) => {
    const call = incoming(args(params, ['id']).id);
    declineCall(call);
    return { id: call.id, state: 'ended' };
  });

  def('calls.hangup', async (params) => {
    const call = activeCall(args(params, ['id']).id);
    const quiet = hostOnlyNow(); // host-only: nothing more goes to peers
    if (call.role === 'callee' && call.state === 'ringing') {
      if (quiet) endCall(call, 'declined', null, { notify: false });
      else declineCall(call);
    } else endCall(call, 'hangup', null, { notify: !quiet });
    return { id: call.id, state: 'ended' };
  }, { network: false });

  def('calls.mute', async (params) => {
    const p = args(params, ['id', 'on']);
    const call = inCall(p.id);
    return { id: call.id, mute: setMute(call, p.on !== false) };
  }, { network: false });

  def('calls.camera', async (params) => {
    const p = args(params, ['id', 'on']);
    const call = inCall(p.id);
    const on = p.on !== false;
    try {
      return { id: call.id, camera: await setCamera(call, on) };
    } catch (e) {
      throw fail(e.code || 'E_NO_DEVICE', e.message);
    }
  });

  def('calls.screen', async (params) => {
    const p = args(params, ['id', 'on']);
    const call = inCall(p.id);
    const on = p.on !== false;
    if (!on) {
      await setScreenOff(call);
      return { id: call.id, screen: false };
    }
    if (!d.mediaDevices || typeof d.mediaDevices.getDisplayMedia !== 'function') throw fail('E_UNSUPPORTED', 'this browser cannot share the screen');
    await confirm('call.screen', { id: call.id });
    // getDisplayMedia right after the card, in the task of the person's click on it (no other await before it).
    let t;
    try {
      t = await call.media.startScreen();
    } catch (e) {
      throw fail(e.code || 'E_NO_DEVICE', e.message);
    }
    if (call.state === 'ended') return { id: call.id, screen: false };
    for (const peer of call.peers.values()) await peer.setTrack('screen', t);
    call.local.screen = true;
    broadcastState(call);
    yieldSeeding();
    emitState(call);
    return { id: call.id, screen: true };
  }, { ui: true });

  def('calls.state', async (params) => {
    const id = args(params, ['id']).id;
    if (!isCallId(id)) throw fail('E_BAD_REQUEST', 'expected a call id');
    const call = S.calls.get(id);
    if (call) return publicState(call);
    const e = S.ended.get(id);
    return e ? e.state : null;
  });

  def('calls.list', async () => Array.from(S.calls.values()).filter((c) => c.state !== 'ended').map(publicState));

  for (const n of CALL_METHODS) if (!methods[n]) throw new Error('calls service: missing method ' + n);

  if (d.chat && typeof d.chat.onReceive === 'function') {
    S.unsubscribe = d.chat.onReceive((pub, payload, meta) => {
      try { onSig(pub, payload, meta); } catch (_) { /* a bad message must not break calls */ }
    });
  }

  return {
    methods,
    on(event, fn) {
      if (CALL_EVENTS.indexOf(event) < 0) throw new TypeError('unknown calls event ' + event);
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    },
    /**
     * answer(id, { video }) -> state: the loader's own incoming card was answered with the person's click (call-ui);
     * no second card. Loader only: the SDK has no path to it.
     */
    async answer(id, { video = false } = {}) {
      guard('calls.accept', { activation: true, tab: 'leader' }, { feature: true });
      const call = incoming(id);
      const prof = profileFor(call);
      let v = video === true;
      if (v && prof.metered) {
        v = false;
        call.notice = 'metered';
      }
      return doAccept(call, v);
    },
    /** Visibility from the loader: hidden releases the Wake Lock; visible gets paused tracks again (replaceTrack). */
    setVisible(visible) {
      S.visible = !!visible;
      for (const call of S.calls.values()) {
        if (call.state === 'ended' || !call.media) continue;
        if (!S.visible) {
          call.media.wake(false).catch(() => {});
          continue;
        }
        call.media.reacquire().then(async (fresh) => {
          for (const slot of ['audio', 'camera']) {
            if (!fresh[slot]) continue;
            for (const peer of call.peers.values()) await peer.setTrack(slot, fresh[slot]);
            call.paused[slot] = false;
          }
          if (fresh.audio || fresh.camera) emitState(call);
          updateWake(call);
        }).catch(() => {});
      }
    },
    /** Network change from the loader (watchNetwork): ICE restarts on every pair; the rates follow the new class. */
    setNetwork() {
      for (const call of S.calls.values()) {
        if (call.state === 'ended') continue;
        for (const peer of call.peers.values()) peer.restartIce();
        refreshProfiles(call);
      }
    },
    /** media(id) -> { local: { audio, camera, screen }, remote: [{ pub, audio, camera, screen }] } tracks. Loader only. */
    media(id) {
      const call = S.calls.get(id);
      if (!call || !call.media) return null;
      const remote = [];
      for (const [pub, peer] of call.peers) remote.push(Object.assign({ pub }, peer.remoteTracks()));
      return { local: { audio: call.media.audio, camera: call.media.camera, screen: call.media.screen }, remote };
    },
    /** Diagnostics for tests and the call panel: per pair connection states, the fingerprint check and bytes. */
    async inspect() {
      const out = [];
      for (const call of S.calls.values()) {
        const pairs = [];
        for (const [pub, peer] of call.peers) {
          let bytes = null;
          try {
            bytes = readSample(await peer.getStats(), null, { now: now() }).bytes;
          } catch (_) { bytes = null; }
          const pc = peer.pc || {};
          pairs.push({
            pub, state: peer.state, path: peer.path, connectionState: pc.connectionState, signalingState: pc.signalingState,
            control: peer.dc ? peer.dc.readyState : null, fingerprint: peer.fingerprintCheck || null, verified: peer.verified,
            stats: Object.assign({}, peer.stats), bytes, rung: call.adapt.get(pub) ? call.adapt.get(pub).state.rung : null,
          });
        }
        out.push({ id: call.id, state: call.state, role: call.role, pairs, participants: participants(call) });
      }
      return { calls: out, seedYield: JSON.parse(S.yieldKey) };
    },
    async destroy() {
      endAll('closed');
      if (typeof S.unsubscribe === 'function') {
        try { S.unsubscribe(); } catch (_) { /* gone */ }
      }
      S.destroyed = true;
      listeners.clear();
    },
  };
}
