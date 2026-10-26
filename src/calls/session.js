// One call's media and one RTCPeerConnection per remote (SZ 3.5 "Binding", "Flow", "Platform handling").
//
// CallMedia: the capture of one call, shared by every pair of a mesh. getUserMedia, getDisplayMedia and the screen
//   Wake Lock are called here and nowhere else in the loader (SZ 3.1.9; Wake Lock otherwise only in src/loader/dock.js).
//   getDisplayMedia runs only from startScreen(), which the service calls right after the loader's card resolves inside
//   the person's click (WebKit refuses it outside "a user gesture handler", measured). On the way back to visible,
//   reacquire() gets muted or ended tracks again and the pairs replaceTrack them [WKB1, WKB3]; a track's 'mute' is
//   reported so the panel can say "Your camera is paused by the browser". The Wake Lock is held only during a visible
//   video call; Media Session togglemicrophone, togglecamera and hangup are set where the browser has them.
//
// PeerSession: one RTCPeerConnection with a fixed layout (audio, camera, screen transceivers, all sendrecv; the screen
//   slot sends nothing until a screen is shared, so sharing needs no renegotiation) and the negotiated data channel
//   'mw-call' (id 0). Perfect negotiation, the higher public key polite. The first offer and answer and the first
//   candidates travel as SIG (sealed with K_pair by the chat lane); once connected, later descriptions and candidates go
//   on 'mw-call'. Every description of a pair must carry the same sha-256 fingerprint; after the connection comes up
//   the remote certificate in getStats (transport.remoteCertificateId) must equal it, or the pair closes with
//   E_CALL_FAILED. Received candidates pass src/calls/ice.js filterCandidate; ours pass sanitizeLocal. A pair that has
//   not connected after 30 s fails ("call.noPath"); a disconnected pair gets an ICE restart after 3 s and closes when it
//   is still down 15 s later.
//
// Browser code (WebRTC); every global comes in by injection so Node tests run it against test/fixtures/calls.

import { sanitizeSdp, sanitizeLocal, filterCandidate } from './ice.js';
import { checkSdp, normalizeFingerprint, encodeControl, decodeControl } from './signal.js';
import { readSample } from './adapt.js';
import {
  CONTROL_ID, CONTROL_LABEL, CAND_MAX, CAND_BATCH_MS, OFFER_RETRY_MS, OFFER_RETRIES, PENDING_CAND_MAX,
  CONNECT_TIMEOUT_MS, RESTART_AFTER_MS, RECONNECT_MS, VIDEO_WIDTH, VIDEO_HEIGHT, VIDEO_FPS, SCREEN_FPS, SCREEN_HINT,
} from './limits.js';

function err(code, msg) {
  return Object.assign(new Error(msg || code), { code });
}

const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const VIDEO_CONSTRAINTS = { width: { ideal: VIDEO_WIDTH }, height: { ideal: VIDEO_HEIGHT }, frameRate: { ideal: VIDEO_FPS } };
const SLOTS = ['audio', 'camera', 'screen'];
const SESSION_ACTIONS = ['togglemicrophone', 'togglecamera', 'hangup'];

/** mediaErrorCode(error) -> 'E_MEDIA_DENIED' | 'E_NO_DEVICE' | 'E_UNSUPPORTED' for a getUserMedia failure. */
export function mediaErrorCode(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'E_MEDIA_DENIED';
  if (n === 'TypeError' || n === 'NotSupportedError') return 'E_UNSUPPORTED';
  return 'E_NO_DEVICE'; // NotFoundError, OverconstrainedError, NotReadableError, AbortError and the rest
}

function noDevice(e) {
  const n = e && e.name;
  return n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'NotReadableError' || n === 'DevicesNotFoundError';
}

function stopTrack(t) {
  try { if (t && typeof t.stop === 'function') t.stop(); } catch (_) { /* already stopped */ }
}

// =====================================================================================================
// CallMedia
// =====================================================================================================

export class CallMedia {
  /** new CallMedia({ mediaDevices, wakeLock, mediaSession, onEvent(e) }) */
  constructor({ mediaDevices = null, wakeLock = null, mediaSession = null, onEvent = () => {} } = {}) {
    this.md = mediaDevices;
    this.wakeLock = wakeLock;
    this.mediaSession = mediaSession;
    this.onEvent = onEvent;
    this.audio = null;
    this.camera = null;
    this.screen = null;
    this.muted = false;
    this.lock = null;
    this.locking = null;
    this.stopped = false;
    this.unwatch = new Map(); // track -> remove listeners
  }

  _watch(slot, track) {
    if (!track || typeof track.addEventListener !== 'function') return;
    const on = (state) => () => {
      if (this[slot] !== track) return;
      try { this.onEvent({ type: 'track', slot, state }); } catch (_) { /* listener */ }
    };
    const m = on('muted');
    const u = on('live');
    const e = slot === 'screen' ? () => {
      if (this.screen !== track) return;
      try { this.onEvent({ type: 'screen-ended' }); } catch (_) { /* listener */ }
    } : on('ended');
    track.addEventListener('mute', m);
    track.addEventListener('unmute', u);
    track.addEventListener('ended', e);
    this.unwatch.set(track, () => {
      track.removeEventListener('mute', m);
      track.removeEventListener('unmute', u);
      track.removeEventListener('ended', e);
    });
  }

  _drop(track) {
    const off = this.unwatch.get(track);
    if (off) off();
    this.unwatch.delete(track);
    stopTrack(track);
  }

  /** open({ audio = true, video }) -> { audio, camera }. A missing camera falls back to audio only (cameraMissing). */
  async open({ video = false } = {}) {
    const md = this.md;
    if (!md || typeof md.getUserMedia !== 'function') throw err('E_UNSUPPORTED', 'this browser cannot capture audio or video here');
    let stream;
    this.cameraMissing = false;
    try {
      stream = await md.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: video ? VIDEO_CONSTRAINTS : false });
    } catch (e) {
      if (!video || !noDevice(e)) throw err(mediaErrorCode(e), 'could not use the microphone' + (video ? ' or the camera' : ''));
      try {
        stream = await md.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
        this.cameraMissing = true;
      } catch (e2) {
        throw err(mediaErrorCode(e2), 'could not use the microphone');
      }
    }
    const a = (stream.getAudioTracks && stream.getAudioTracks()[0]) || null;
    const v = (stream.getVideoTracks && stream.getVideoTracks()[0]) || null;
    if (this.stopped) {
      stopTrack(a);
      stopTrack(v);
      throw err('E_CALL_FAILED', 'the call ended');
    }
    if (!a) {
      stopTrack(v);
      throw err('E_NO_DEVICE', 'no microphone');
    }
    this.audio = a;
    this.camera = v;
    this._watch('audio', a);
    this._watch('camera', v);
    return { audio: a, camera: v };
  }

  setMuted(on) {
    this.muted = !!on;
    if (this.audio) this.audio.enabled = !this.muted;
    this._sessionFlags();
  }

  /** setCamera(true) captures the camera (again); false stops it, so the camera light goes off. */
  async setCamera(on) {
    if (!on) {
      const t = this.camera;
      this.camera = null;
      if (t) this._drop(t);
      this._sessionFlags();
      return null;
    }
    if (this.camera && this.camera.readyState !== 'ended') return this.camera;
    const md = this.md;
    if (!md || typeof md.getUserMedia !== 'function') throw err('E_UNSUPPORTED', 'no camera here');
    let s;
    try {
      s = await md.getUserMedia({ audio: false, video: VIDEO_CONSTRAINTS });
    } catch (e) {
      throw err(mediaErrorCode(e), 'could not use the camera');
    }
    const t = (s.getVideoTracks && s.getVideoTracks()[0]) || null;
    if (!t) throw err('E_NO_DEVICE', 'no camera');
    if (this.stopped) {
      stopTrack(t);
      throw err('E_CALL_FAILED', 'the call ended');
    }
    if (this.camera) this._drop(this.camera);
    this.camera = t;
    this._watch('camera', t);
    this._sessionFlags();
    return t;
  }

  /**
   * startScreen() -> track. Call it in the same task as the person's click (no awaits on anything but the loader's
   * card before it). NotAllowedError (the picker was cancelled) is E_USER_CANCELLED; InvalidStateError (no gesture,
   * WebKit) is E_NEEDS_GESTURE; a browser without getDisplayMedia (Android) is E_UNSUPPORTED.
   */
  async startScreen() {
    const md = this.md;
    if (!md || typeof md.getDisplayMedia !== 'function') throw err('E_UNSUPPORTED', 'this browser cannot share the screen');
    let s;
    try {
      s = await md.getDisplayMedia({ video: { frameRate: { ideal: SCREEN_FPS, max: SCREEN_FPS } }, audio: false });
    } catch (e) {
      const n = e && e.name;
      if (n === 'NotAllowedError' || n === 'AbortError') throw err('E_USER_CANCELLED', 'no screen was picked');
      if (n === 'InvalidStateError') throw err('E_NEEDS_GESTURE', 'call this from a click');
      throw err(mediaErrorCode(e), 'could not share the screen');
    }
    const t = (s.getVideoTracks && s.getVideoTracks()[0]) || null;
    if (!t) throw err('E_NO_DEVICE', 'no screen track');
    if (this.stopped) {
      stopTrack(t);
      throw err('E_CALL_FAILED', 'the call ended');
    }
    try { t.contentHint = SCREEN_HINT; } catch (_) { /* read-only in some engines */ }
    if (this.screen) this._drop(this.screen);
    this.screen = t;
    this._watch('screen', t);
    return t;
  }

  stopScreen() {
    const t = this.screen;
    this.screen = null;
    if (t) this._drop(t);
  }

  /** reacquire() -> { audio?, camera? }: new tracks for muted or ended ones (back to visible). */
  async reacquire() {
    const out = {};
    const md = this.md;
    if (this.stopped || !md || typeof md.getUserMedia !== 'function') return out;
    const stale = (t) => t && (t.readyState === 'ended' || t.muted === true);
    if (stale(this.audio)) {
      try {
        const s = await md.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
        const t = s.getAudioTracks()[0];
        if (t && !this.stopped) {
          this._drop(this.audio);
          t.enabled = !this.muted;
          this.audio = t;
          this._watch('audio', t);
          out.audio = t;
        } else stopTrack(t);
      } catch (_) { /* stays paused; the panel says so */ }
    }
    if (stale(this.camera)) {
      try {
        const s = await md.getUserMedia({ audio: false, video: VIDEO_CONSTRAINTS });
        const t = s.getVideoTracks()[0];
        if (t && !this.stopped) {
          this._drop(this.camera);
          this.camera = t;
          this._watch('camera', t);
          out.camera = t;
        } else stopTrack(t);
      } catch (_) { /* stays paused */ }
    }
    return out;
  }

  /** wake(on): the screen Wake Lock, held only while asked (a visible video call). */
  async wake(on) {
    if (on) {
      if (this.lock || this.locking || this.stopped) return !!this.lock;
      if (!this.wakeLock || typeof this.wakeLock.request !== 'function') return false;
      this.locking = Promise.resolve().then(() => this.wakeLock.request('screen')).then((sentinel) => {
        this.locking = null;
        if (this.stopped || this.unlockAsked) {
          this.unlockAsked = false;
          try { sentinel.release(); } catch (_) { /* gone */ }
          return false;
        }
        this.lock = sentinel;
        try {
          sentinel.addEventListener('release', () => {
            if (this.lock === sentinel) this.lock = null;
          });
        } catch (_) { /* a sentinel without events */ }
        return true;
      }, () => {
        this.locking = null;
        return false;
      });
      return this.locking;
    }
    if (this.locking) this.unlockAsked = true;
    const l = this.lock;
    this.lock = null;
    if (l) {
      try { await l.release(); } catch (_) { /* already released */ }
    }
    return false;
  }

  /** setActions({ togglemicrophone, togglecamera, hangup }) where Media Session has them; null clears. */
  setActions(handlers) {
    const ms = this.mediaSession;
    if (!ms || typeof ms.setActionHandler !== 'function') return [];
    const set = [];
    for (const a of SESSION_ACTIONS) {
      try {
        ms.setActionHandler(a, handlers && typeof handlers[a] === 'function' ? handlers[a] : null);
        set.push(a);
      } catch (_) { /* this browser lacks the action (WebKit: hangup) */ }
    }
    this._sessionFlags();
    return set;
  }

  _sessionFlags() {
    const ms = this.mediaSession;
    if (!ms) return;
    try { if (typeof ms.setMicrophoneActive === 'function') ms.setMicrophoneActive(!!this.audio && !this.muted); } catch (_) { /* optional */ }
    try { if (typeof ms.setCameraActive === 'function') ms.setCameraActive(!!this.camera); } catch (_) { /* optional */ }
  }

  /** Every capture track ends, the Wake Lock goes, the Media Session handlers are cleared. */
  stop() {
    this.stopped = true;
    for (const s of SLOTS) {
      const t = this[s];
      this[s] = null;
      if (t) this._drop(t);
    }
    this.wake(false).catch(() => {});
    if (this.mediaSession) this.setActions(null);
  }
}

// =====================================================================================================
// PeerSession
// =====================================================================================================

function each(report, fn) {
  if (!report) return;
  if (typeof report.forEach === 'function') report.forEach((v) => fn(v));
  else if (typeof report.values === 'function') for (const v of report.values()) fn(v);
}

/** remoteCertificate(report, localFingerprint) -> { fingerprint, algorithm } | null from getStats. */
export function remoteCertificate(report, localFingerprint = null) {
  const byId = new Map();
  const certs = [];
  let remoteId = null;
  each(report, (s) => {
    if (!s || typeof s !== 'object') return;
    byId.set(s.id, s);
    if (s.type === 'certificate') certs.push(s);
    if (s.type === 'transport' && s.remoteCertificateId && !remoteId) remoteId = s.remoteCertificateId;
  });
  let c = remoteId ? byId.get(remoteId) : null;
  if (!c && localFingerprint) {
    // Engines without transport.remoteCertificateId: the certificate that is not ours.
    c = certs.find((x) => normalizeFingerprint(x.fingerprint) && normalizeFingerprint(x.fingerprint) !== localFingerprint) || null;
  }
  if (!c || typeof c.fingerprint !== 'string') return null;
  return { fingerprint: c.fingerprint, algorithm: typeof c.fingerprintAlgorithm === 'string' ? c.fingerprintAlgorithm : null };
}

function firstMid(sdp) {
  const m = /\r?\na=mid:([^\r\n]+)/.exec(sdp || '');
  return m ? m[1] : null;
}

function kindOf(t) {
  return (t && t.receiver && t.receiver.track && t.receiver.track.kind) || (t && t.sender && t.sender.track && t.sender.track.kind) || null;
}

export class PeerSession {
  /**
   * new PeerSession({ RTCPeerConnection, config, me, them, polite, offerer, media, sameLan, sendSignal(body),
   *   offerExtra(), onState(state, info), onControl(msg), onControlOpen(), onTrack({ slot, track }), setTimeout,
   *   clearTimeout, now })
   * sendSignal gets { k: 'offer' | 'answer' | 'ice', sdp? | cand? , ...offerExtra() } and returns a Promise.
   * onState: 'connecting' | 'direct' | 'relayed' | 'reconnecting' | 'left' with info { code, reason, verified }.
   */
  constructor(o) {
    if (typeof o.RTCPeerConnection !== 'function') throw err('E_UNSUPPORTED', 'this browser has no RTCPeerConnection');
    this.RTC = o.RTCPeerConnection;
    this.config = o.config || {};
    this.me = o.me;
    this.them = o.them;
    this.polite = !!o.polite;
    this.offerer = !!o.offerer;
    this.media = o.media;
    this.sameLan = !!o.sameLan;
    this.sendSignal = o.sendSignal;
    this.offerExtra = o.offerExtra || (() => ({}));
    this.onState = o.onState || (() => {});
    this.onControl = o.onControl || (() => {});
    this.onControlOpen = o.onControlOpen || (() => {});
    this.onTrack = o.onTrack || (() => {});
    this.setT = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this.clearT = o.clearTimeout || ((h) => clearTimeout(h));
    this.now = o.now || (() => Date.now());
    this.pc = null;
    this.dc = null;
    this.slots = { audio: null, camera: null, screen: null };
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.remoteSet = false;
    this.remoteFingerprint = null;
    this.localFingerprint = null;
    this.verified = null; // true: getStats agreed; false: the engine gave no certificate stats
    this.pending = [];
    this.out = [];
    this.timers = { cand: null, connect: null, restart: null, reconnect: null, retry: null };
    this.retry = null;
    this.connectedOnce = false;
    this.restarts = 0;
    this.state = 'connecting';
    this.path = null;
    this.closed = false;
    this.enc = null;
    this.stats = { withheld: 0, dropped: 0, candErrors: 0, badControl: 0, sentCand: 0, gotCand: 0, viaControl: 0, viaSig: 0 };
  }

  _timer(name, ms, fn) {
    if (this.timers[name]) this.clearT(this.timers[name]);
    this.timers[name] = this.setT(() => {
      this.timers[name] = null;
      if (!this.closed) fn();
    }, ms);
  }

  _clear(name) {
    if (this.timers[name]) this.clearT(this.timers[name]);
    this.timers[name] = null;
  }

  /** Creates the connection; the offerer adds the three transceivers, which fires negotiationneeded. */
  start() {
    const pc = new this.RTC(this.config);
    this.pc = pc;
    this.dc = pc.createDataChannel(CONTROL_LABEL, { negotiated: true, id: CONTROL_ID, ordered: true });
    this._wireControl(this.dc);
    pc.addEventListener('negotiationneeded', () => { this._onNegotiationNeeded(); });
    pc.addEventListener('icecandidate', (e) => this._onIceCandidate(e));
    pc.addEventListener('connectionstatechange', () => this._onConnectionState());
    pc.addEventListener('track', (e) => this._onTrack(e));
    if (this.offerer) {
      const m = this.media || {};
      this.slots.audio = pc.addTransceiver(m.audio || 'audio', { direction: 'sendrecv' });
      this.slots.camera = pc.addTransceiver(m.camera || 'video', { direction: 'sendrecv' });
      this.slots.screen = pc.addTransceiver(m.screen || 'video', { direction: 'sendrecv' });
    }
    this._timer('connect', CONNECT_TIMEOUT_MS, () => {
      if (!this.connectedOnce) this._fail('E_CALL_FAILED', 'no-path');
    });
    return this;
  }

  // ------------------------------------------------------------------------------------------- negotiation

  async _setLocal() {
    const pc = this.pc;
    try {
      await pc.setLocalDescription();
    } catch (e) {
      if (!e || e.name !== 'TypeError') throw e;
      const d = pc.signalingState === 'have-remote-offer' ? await pc.createAnswer() : await pc.createOffer();
      await pc.setLocalDescription(d);
    }
  }

  async _onNegotiationNeeded() {
    if (this.closed || !this.pc) return;
    if (!this.offerer && !this.remoteSet) return; // the answering side never offers before the first offer came
    try {
      this.makingOffer = true;
      await this._setLocal();
      if (this.closed) return;
      if (this.pc.signalingState !== 'have-local-offer') return;
      await this._sendDescription(this.pc.localDescription);
    } catch (e) {
      if (!this.closed) this.stats.offerError = (e && e.name) || 'error';
    } finally {
      this.makingOffer = false;
    }
  }

  _controlUsable() {
    return !!this.dc && this.dc.readyState === 'open' && this.connectedOnce && this.pc && this.pc.connectionState === 'connected';
  }

  async _sendDescription(desc) {
    if (!desc || typeof desc.sdp !== 'string') return;
    const sdp = sanitizeSdp(desc.sdp, { sameLan: this.sameLan, direction: 'out' });
    const chk = checkSdp(sdp);
    if (!chk.ok) return this._fail('E_CALL_FAILED', 'local-sdp');
    this.localFingerprint = chk.fingerprints[0];
    if (this._controlUsable()) {
      this.stats.viaControl++;
      this.sendControl({ t: 'desc', type: desc.type, sdp });
      return;
    }
    const body = Object.assign({ k: desc.type, sdp }, desc.type === 'offer' ? this.offerExtra() : {});
    this.stats.viaSig++;
    try {
      await this.sendSignal(body);
    } catch (e) {
      if (!this.connectedOnce) return this._fail(e && e.code ? e.code : 'E_CALL_FAILED', 'signal');
      return undefined;
    }
    if (desc.type === 'offer') this._armRetry(body, sdp);
    return undefined;
  }

  _armRetry(body, sdp) {
    this.retry = { body, sdp, tries: 0 };
    const again = () => {
      const r = this.retry;
      if (!r || this.closed || !this.pc) return;
      if (this.pc.signalingState !== 'have-local-offer' || r.tries >= OFFER_RETRIES) return;
      r.tries++;
      Promise.resolve(this.sendSignal(Object.assign({}, r.body))).catch(() => {});
      this._timer('retry', OFFER_RETRY_MS, again);
    };
    this._timer('retry', OFFER_RETRY_MS, again);
  }

  _clearRetry() {
    this.retry = null;
    this._clear('retry');
  }

  /** handleSignal(body): an offer, answer or ice message of this pair that came as SIG. */
  async handleSignal(msg) {
    if (this.closed || !msg) return;
    if (msg.k === 'offer' || msg.k === 'answer') return this.handleDescription({ type: msg.k, sdp: msg.sdp });
    if (msg.k === 'ice') return this.handleCandidates(msg.cand);
    return undefined;
  }

  async handleDescription(desc) {
    if (this.closed || !this.pc) return;
    const pc = this.pc;
    const chk = checkSdp(desc.sdp);
    if (!chk.ok) return;
    const fp = chk.fingerprints[0];
    if (this.remoteFingerprint && fp !== this.remoteFingerprint) return this._fail('E_CALL_FAILED', 'fingerprint-changed');
    const collision = desc.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;
    if (desc.type === 'answer' && pc.signalingState !== 'have-local-offer') return; // stale or repeated
    this.remoteFingerprint = this.remoteFingerprint || fp;
    const sdp = sanitizeSdp(desc.sdp, { sameLan: this.sameLan, direction: 'in' });
    try {
      if (collision && pc.signalingState === 'have-local-offer') {
        try { await pc.setLocalDescription({ type: 'rollback' }); } catch (_) { /* implicit rollback in setRemoteDescription */ }
      }
      await pc.setRemoteDescription({ type: desc.type, sdp });
    } catch (e) {
      return this._fail('E_CALL_FAILED', 'remote-description');
    }
    if (this.closed) return;
    this.remoteSet = true;
    this.remoteMid = firstMid(sdp);
    if (desc.type === 'answer') this._clearRetry();
    await this._flushPending();
    if (desc.type === 'offer') {
      await this._attachLocal();
      try {
        await this._setLocal();
        if (this.closed) return;
        await this._sendDescription(pc.localDescription);
      } catch (e) {
        return this._fail('E_CALL_FAILED', 'answer');
      }
    }
    await this._applyEncodings();
  }

  /** The answering side: the local tracks go on the offered transceivers (audio, camera, screen in m-line order). */
  async _attachLocal() {
    if (this.slots.audio || this.slots.camera) return;
    const tx = this.pc.getTransceivers();
    const audio = tx.filter((t) => kindOf(t) === 'audio');
    const video = tx.filter((t) => kindOf(t) === 'video');
    this.slots.audio = audio[0] || null;
    this.slots.camera = video[0] || null;
    this.slots.screen = video[1] || null;
    const m = this.media || {};
    const jobs = [];
    for (const s of SLOTS) {
      const t = this.slots[s];
      if (!t) continue;
      try { t.direction = 'sendrecv'; } catch (_) { /* stopped */ }
      if (m[s]) jobs.push(Promise.resolve(t.sender.replaceTrack(m[s])).catch(() => {}));
    }
    await Promise.all(jobs);
  }

  // ------------------------------------------------------------------------------------------- candidates

  _onIceCandidate(e) {
    if (this.closed) return;
    const c = e && e.candidate;
    if (!c || !c.candidate) {
      this._flushOut();
      return;
    }
    const s = sanitizeLocal(c.candidate, { sameLan: this.sameLan });
    if (!s) {
      this.stats.withheld++;
      return;
    }
    this.out.push(s);
    if (this.out.length >= CAND_MAX) this._flushOut();
    else if (!this.timers.cand) this._timer('cand', CAND_BATCH_MS, () => this._flushOut());
  }

  _flushOut() {
    this._clear('cand');
    while (this.out.length && !this.closed) {
      const batch = this.out.splice(0, CAND_MAX);
      this.stats.sentCand += batch.length;
      if (this._controlUsable()) this.sendControl({ t: 'cand', cand: batch });
      else Promise.resolve(this.sendSignal({ k: 'ice', cand: batch })).catch(() => {});
    }
  }

  async handleCandidates(list) {
    if (this.closed || !Array.isArray(list)) return;
    for (const c of list) {
      if (!filterCandidate(c, { sameLan: this.sameLan })) {
        this.stats.dropped++;
        continue;
      }
      this.stats.gotCand++;
      if (!this.remoteSet) {
        if (this.pending.length < PENDING_CAND_MAX) this.pending.push(c);
        continue;
      }
      await this._addCandidate(c);
    }
  }

  async _addCandidate(c) {
    const init = { candidate: c, sdpMLineIndex: 0 };
    if (this.remoteMid !== null && this.remoteMid !== undefined) init.sdpMid = this.remoteMid;
    try {
      await this.pc.addIceCandidate(init);
    } catch (e) {
      if (!this.ignoreOffer) this.stats.candErrors++;
    }
  }

  async _flushPending() {
    const list = this.pending.splice(0);
    for (const c of list) await this._addCandidate(c);
  }

  // ------------------------------------------------------------------------------------------- the control channel

  _wireControl(dc) {
    dc.addEventListener('open', () => {
      if (this.closed) return;
      try { this.onControlOpen(); } catch (_) { /* listener */ }
    });
    dc.addEventListener('message', (e) => this._onControlMessage(e && e.data));
    dc.addEventListener('close', () => {
      if (!this.closed) this._gone('closed');
    });
  }

  _onControlMessage(data) {
    if (this.closed) return;
    const r = decodeControl(data);
    if (!r.ok) {
      this.stats.badControl++;
      return;
    }
    const m = r.msg;
    if (m.t === 'desc') {
      this.handleDescription({ type: m.type, sdp: m.sdp }).catch(() => {});
      return;
    }
    if (m.t === 'cand') {
      this.handleCandidates(m.cand).catch(() => {});
      return;
    }
    if (m.t === 'leave') {
      this._gone('hangup');
      return;
    }
    try { this.onControl(m); } catch (_) { /* listener */ }
  }

  /** sendControl(obj) -> boolean: on 'mw-call' when it is open. */
  sendControl(obj) {
    if (!this.dc || this.dc.readyState !== 'open') return false;
    let s;
    try { s = encodeControl(obj); } catch (_) { return false; }
    try {
      this.dc.send(s);
      return true;
    } catch (_) {
      return false;
    }
  }

  get controlOpen() {
    return !!this.dc && this.dc.readyState === 'open';
  }

  // ------------------------------------------------------------------------------------------- connection state

  _setState(state, info = {}) {
    if (this.closed && state !== 'left') return;
    const changed = this.state !== state || (info && info.force);
    this.state = state;
    if (changed) {
      try { this.onState(state, info); } catch (_) { /* listener */ }
    }
  }

  _onConnectionState() {
    if (this.closed || !this.pc) return;
    const st = this.pc.connectionState;
    if (st === 'connected') {
      this._clear('restart');
      this._clear('reconnect');
      if (!this.connectedOnce) {
        this.connectedOnce = true;
        this._clear('connect');
        this._afterConnect().catch(() => {});
      } else {
        this._reportPath().catch(() => {});
      }
    } else if (st === 'disconnected') {
      if (!this.connectedOnce) return;
      this._setState('reconnecting');
      this._timer('restart', RESTART_AFTER_MS, () => {
        if (this.pc.connectionState !== 'connected') this.restartIce();
      });
      this._timer('reconnect', RESTART_AFTER_MS + RECONNECT_MS, () => {
        if (this.pc.connectionState !== 'connected') this._fail('E_CALL_FAILED', 'lost');
      });
    } else if (st === 'failed') {
      if (!this.connectedOnce) return this._fail('E_CALL_FAILED', 'no-path');
      if (this.restarts < 1) {
        this._setState('reconnecting');
        this.restartIce();
        this._timer('reconnect', RECONNECT_MS, () => {
          if (this.pc.connectionState !== 'connected') this._fail('E_CALL_FAILED', 'lost');
        });
      } else {
        this._fail('E_CALL_FAILED', 'lost');
      }
    }
    return undefined;
  }

  async _afterConnect() {
    const v = await this.verify();
    if (this.closed) return;
    if (v.status === 'mismatch') return this._fail('E_CALL_FAILED', 'fingerprint');
    this.verified = v.status === 'ok';
    this.fingerprintCheck = v;
    await this._applyEncodings();
    await this._reportPath(true);
    return undefined;
  }

  /** verify() -> { status: 'ok' | 'mismatch' | 'unavailable', expected, actual }: certificate stats against the SDP. */
  async verify() {
    const expected = this.remoteFingerprint;
    let report;
    try {
      report = await this.pc.getStats();
    } catch (_) {
      return { status: 'unavailable', expected, actual: null };
    }
    const c = remoteCertificate(report, this.localFingerprint);
    if (!c) return { status: 'unavailable', expected, actual: null };
    if (c.algorithm && c.algorithm.toLowerCase() !== 'sha-256') return { status: 'unavailable', expected, actual: null };
    const actual = normalizeFingerprint(c.fingerprint);
    return { status: actual && actual === expected ? 'ok' : 'mismatch', expected, actual };
  }

  async _reportPath(first = false) {
    let path = 'direct';
    try {
      const s = readSample(await this.pc.getStats(), null, { now: this.now() });
      if (s.path) path = s.path;
    } catch (_) { /* keep direct */ }
    if (this.closed) return;
    this.path = path;
    this._setState(path, { verified: this.verified, first, force: first });
  }

  /** ICE restart (network change, or a pair that stayed down): a new offer, through SIG while the pair is down. */
  restartIce() {
    if (this.closed || !this.pc) return;
    this.restarts++;
    if (typeof this.pc.restartIce === 'function') {
      try {
        this.pc.restartIce();
        return;
      } catch (_) { /* fall through */ }
    }
    if (!this.offerer && !this.remoteSet) return;
    Promise.resolve().then(async () => {
      this.makingOffer = true;
      try {
        const o = await this.pc.createOffer({ iceRestart: true });
        await this.pc.setLocalDescription(o);
        await this._sendDescription(this.pc.localDescription);
      } finally {
        this.makingOffer = false;
      }
    }).catch(() => {});
  }

  // ------------------------------------------------------------------------------------------- media

  _onTrack(e) {
    if (this.closed || !e) return;
    const slot = this._slotOf(e.transceiver);
    try { this.onTrack({ slot, track: e.track || null }); } catch (_) { /* listener */ }
  }

  _slotOf(tr) {
    if (!tr) return null;
    for (const s of SLOTS) if (this.slots[s] === tr) return s;
    const tx = this.pc ? this.pc.getTransceivers() : [];
    const kind = kindOf(tr);
    const same = tx.filter((t) => kindOf(t) === kind);
    const i = same.indexOf(tr);
    if (kind === 'audio') return i === 0 ? 'audio' : null;
    if (kind === 'video') return i === 0 ? 'camera' : (i === 1 ? 'screen' : null);
    return null;
  }

  /** remoteTracks() -> { audio, camera, screen } of the other side (receiver tracks). */
  remoteTracks() {
    const out = { audio: null, camera: null, screen: null };
    for (const s of SLOTS) {
      const t = this.slots[s];
      out[s] = t && t.receiver ? t.receiver.track : null;
    }
    return out;
  }

  /** setTrack('audio' | 'camera' | 'screen', track | null) -> Promise<boolean> (replaceTrack; no renegotiation). */
  async setTrack(slot, track) {
    const t = this.slots[slot];
    if (!t || this.closed) return false;
    try {
      await t.sender.replaceTrack(track || null);
    } catch (_) {
      return false;
    }
    await this._applyEncodings();
    return true;
  }

  /** applyEncodings({ audio, camera, screen }) -> Promise: setParameters on each sender with a track slot. */
  async applyEncodings(enc) {
    if (enc) this.enc = enc;
    return this._applyEncodings();
  }

  async _applyEncodings() {
    const enc = this.enc;
    if (!enc || this.closed || !this.pc) return;
    for (const s of SLOTS) {
      const t = this.slots[s];
      const e = enc[s];
      if (!t || !e || !t.sender || typeof t.sender.getParameters !== 'function') continue;
      try {
        const p = t.sender.getParameters();
        if (!p.encodings || !p.encodings.length) p.encodings = [{}];
        const x = p.encodings[0];
        if (typeof e.maxBitrate === 'number') x.maxBitrate = e.maxBitrate;
        if (typeof e.scaleResolutionDownBy === 'number' && s !== 'audio') x.scaleResolutionDownBy = e.scaleResolutionDownBy;
        if (typeof e.maxFramerate === 'number' && s !== 'audio') x.maxFramerate = e.maxFramerate;
        if (typeof e.active === 'boolean') x.active = e.active;
        await t.sender.setParameters(p);
      } catch (_) { /* not negotiated yet; the next pass applies it */ }
    }
  }

  getStats() {
    return this.pc ? this.pc.getStats() : Promise.resolve(new Map());
  }

  /** The mid of the camera transceiver (the adaptation loop reads that stream). */
  cameraMid() {
    return this.slots.camera ? this.slots.camera.mid : null;
  }

  // ------------------------------------------------------------------------------------------- closing

  _stopTimers() {
    for (const k of Object.keys(this.timers)) this._clear(k);
    this.retry = null;
  }

  /** close(reason, { notify = true }): 'leave' on 'mw-call' first (when open), then the connection closes. */
  close(reason = 'hangup', { notify = true } = {}) {
    if (this.closed) return;
    const sent = notify ? this.sendControl({ t: 'leave' }) : false;
    this.closed = true;
    this.state = 'left';
    this.leftReason = reason;
    this._stopTimers();
    const pc = this.pc;
    const finish = () => {
      try { if (this.dc) this.dc.close(); } catch (_) { /* gone */ }
      try { if (pc) pc.close(); } catch (_) { /* gone */ }
    };
    // Give the 'leave' a moment to leave before the transport goes (the channel drains pending messages first).
    if (sent) this.setT(finish, 200);
    else finish();
  }

  _gone(reason) {
    if (this.closed) return;
    this.close(reason, { notify: false });
    try { this.onState('left', { reason }); } catch (_) { /* listener */ }
  }

  _fail(code, reason) {
    if (this.closed) return;
    this.close(reason, { notify: reason !== 'fingerprint' });
    try { this.onState('left', { code, reason }); } catch (_) { /* listener */ }
  }
}
