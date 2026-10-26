// A fake WebRTC for the calls unit tests (Node 22+; EventTarget, Event and MessageEvent are globals). It models what
// src/calls relies on, and only that:
//   - signaling states, implicit setLocalDescription (offer or answer by state), explicit and implicit rollback,
//     negotiationneeded queued until stable, restartIce() (a new ufrag), InvalidStateError where a browser throws one;
//   - transceivers in m-line order with mids, senders with replaceTrack, getParameters and setParameters, receivers with
//     a remote track; 'track' events when the remote side sends;
//   - a negotiated data channel paired by id with the other side's, messages delivered asynchronously, close seen by
//     the other side;
//   - SDP with BUNDLE, ice-ufrag, one a=fingerprint:sha-256 per section, padded to a realistic size;
//   - gathered candidates (loopback, a private LAN address and a public server-reflexive one from 198.51.100.0/24,
//     documentation space; nothing here opens a socket), trickled as icecandidate events;
//   - a connection only when both descriptions are set, the fingerprints of the two sides match each other and each
//     side was given at least one candidate of the other's current ufrag; then 'connecting' and 'connected', the data
//     channels open, and getStats reports transport, certificate, candidate-pair, outbound, inbound and
//     remote-inbound entries.
// Knobs on the network: block (never connect), tamper(pc) -> a fingerprint getStats reports for the remote
// certificate, loss / qlr / aob (what getStats reports), relay (the selected pair is relayed), cut(a, b) and heal().
//
// createFakeNetwork() -> net; net.browser(name) -> { RTCPeerConnection, mediaDevices, wakeLock, mediaSession, pcs, tracks }.

const tick = () => new Promise((r) => setImmediate(r));

function dom(name, msg) {
  return Object.assign(new Error(msg || name), { name });
}

let seq = 0;
function rid(n = 8) {
  let s = '';
  for (let i = 0; i < n; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)];
  return s;
}

function randomFingerprint() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

export class FakeTrack extends EventTarget {
  constructor(kind, label, { remote = false } = {}) {
    super();
    this.kind = kind;
    this.label = label;
    this.id = 'track-' + (++seq);
    this.enabled = true;
    this.muted = remote;
    this.readyState = 'live';
    this.contentHint = '';
    this.remote = remote;
  }

  stop() {
    this.readyState = 'ended'; // stop() fires no 'ended' (as in browsers)
  }

  /** The browser ended it (the person stopped sharing, the device went away). */
  _end() {
    if (this.readyState === 'ended') return;
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }

  _mute(on) {
    this.muted = !!on;
    this.dispatchEvent(new Event(on ? 'mute' : 'unmute'));
  }

  getSettings() {
    return this.kind === 'video' ? { width: 640, height: 360 } : {};
  }
}

export class FakeStream {
  constructor(tracks) {
    this.tracks = tracks.slice();
    this.id = 'stream-' + (++seq);
  }
  getTracks() { return this.tracks.slice(); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
}

class FakeSender {
  constructor(tx, track) {
    this.tx = tx;
    this.track = track || null;
    this.params = { transactionId: 't0', encodings: [{ active: true }] };
  }

  async replaceTrack(t) {
    await tick();
    if (t && t.kind !== this.tx.kind) throw new TypeError('replaceTrack: wrong kind');
    this.track = t || null;
    this.tx.pc.trackLog.push({ mid: this.tx.mid, kind: this.tx.kind, track: t ? t.id : null });
  }

  getParameters() {
    return JSON.parse(JSON.stringify(this.params));
  }

  async setParameters(p) {
    await tick();
    if (!p || !Array.isArray(p.encodings) || !p.encodings.length) throw dom('InvalidModificationError');
    this.params = JSON.parse(JSON.stringify(p));
    this.tx.pc.paramsLog.push({ mid: this.tx.mid, kind: this.tx.kind, encoding: Object.assign({}, p.encodings[0]) });
  }
}

class FakeTransceiver {
  constructor(pc, kind, track, direction) {
    this.pc = pc;
    this.kind = kind;
    this.mid = null;
    this.direction = direction || 'sendrecv';
    this.currentDirection = null;
    this.sender = new FakeSender(this, track);
    this.receiver = { track: new FakeTrack(kind, 'remote ' + kind, { remote: true }) };
    this.fired = false;
  }
}

class FakeDataChannel extends EventTarget {
  constructor(pc, label, opts = {}) {
    super();
    this.pc = pc;
    this.label = label;
    this.id = opts.id;
    this.negotiated = !!opts.negotiated;
    this.ordered = opts.ordered !== false;
    this.readyState = 'connecting';
    this.bufferedAmount = 0;
    this.peer = null;
    this.sent = [];
  }

  send(data) {
    if (this.readyState !== 'open') throw dom('InvalidStateError', 'RTCDataChannel.readyState is not open');
    this.sent.push(data);
    const p = this.peer;
    setImmediate(() => {
      if (p && p.readyState === 'open') p.dispatchEvent(new MessageEvent('message', { data }));
    });
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
    const p = this.peer;
    if (p) setImmediate(() => p._remoteClose());
  }

  _open() {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }

  _remoteClose() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

function parseSdp(sdp) {
  const out = { fingerprints: [], ufrag: null, media: [], candidates: [], setup: null };
  let cur = null;
  for (const raw of String(sdp).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('m=')) {
      cur = { kind: line.slice(2).split(' ')[0], mid: null, direction: 'sendrecv' };
      out.media.push(cur);
    } else if (line.startsWith('a=mid:') && cur) cur.mid = line.slice(6);
    else if (/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line) && cur) cur.direction = line.slice(2);
    else if (line.startsWith('a=fingerprint:sha-256 ')) out.fingerprints.push(line.slice('a=fingerprint:sha-256 '.length).toUpperCase());
    else if (line.startsWith('a=ice-ufrag:') && !out.ufrag) out.ufrag = line.slice(12);
    else if (line.startsWith('a=candidate:')) out.candidates.push(line.slice(2));
    else if (line.startsWith('a=setup:') && !out.setup) out.setup = line.slice(8);
  }
  return out;
}

function ufragOf(c) {
  const m = /\bufrag (\S+)/.exec(c);
  return m ? m[1] : null;
}

const REVERSE = { sendrecv: 'sendrecv', sendonly: 'recvonly', recvonly: 'sendonly', inactive: 'inactive' };

export function createFakeNetwork(options = {}) {
  const net = {
    pcs: [], created: 0, block: false, tamper: null, loss: 0, qlr: 'none', aob: 3000000, relay: false,
    sdpPad: options.sdpPad === undefined ? 1500 : options.sdpPad, host: options.host || 0,
    cuts: new Set(),
  };

  net.cut = (a, b) => {
    net.cuts.add(a);
    net.cuts.add(b);
    for (const pc of [a, b]) {
      if (pc.connectionState === 'connected') {
        pc.connectionState = 'disconnected';
        pc.dispatchEvent(new Event('connectionstatechange'));
      }
    }
  };
  net.heal = () => {
    const was = Array.from(net.cuts);
    net.cuts.clear();
    for (const pc of was) pc._maybeConnect();
  };

  net.browser = (name, { denied = false, noCamera = false, noMic = false, noDisplay = false, noHangup = false } = {}) => {
    const b = { name, pcs: [], tracks: [], seq: ++net.host };
    const record = (t) => {
      b.tracks.push(t);
      return t;
    };
    const mediaDevices = {
      calls: [], displayCalls: 0, denied, noCamera, noMic, displayCancel: false, gesture: null,
      async getUserMedia(c) {
        await tick();
        mediaDevices.calls.push(c);
        if (mediaDevices.denied) throw dom('NotAllowedError', 'Permission denied');
        const tracks = [];
        if (c.audio) {
          if (mediaDevices.noMic) throw dom('NotFoundError', 'Requested device not found');
          tracks.push(record(new FakeTrack('audio', 'Fake Default Audio Input')));
        }
        if (c.video) {
          if (mediaDevices.noCamera) throw dom('NotFoundError', 'Requested device not found');
          tracks.push(record(new FakeTrack('video', 'fake_device_0')));
        }
        return new FakeStream(tracks);
      },
    };
    if (!noDisplay) {
      mediaDevices.getDisplayMedia = async (c) => {
        mediaDevices.displayCalls++;
        // A gesture check like WebKit's: the test sets gesture() to report whether the call is inside a click.
        if (typeof mediaDevices.gesture === 'function' && !mediaDevices.gesture()) throw dom('InvalidStateError', 'getDisplayMedia must be called from a user gesture handler.');
        await tick();
        if (mediaDevices.displayCancel) throw dom('NotAllowedError', 'Permission denied');
        mediaDevices.displayConstraints = c;
        return new FakeStream([record(new FakeTrack('video', 'screen:0:0'))]);
      };
    }
    const wakeLock = {
      requests: 0, held: 0, sentinels: [],
      async request(type) {
        await tick();
        wakeLock.requests++;
        wakeLock.held++;
        const s = new EventTarget();
        s.type = type;
        s.released = false;
        s.release = async () => {
          if (s.released) return;
          s.released = true;
          wakeLock.held--;
          s.dispatchEvent(new Event('release'));
        };
        wakeLock.sentinels.push(s);
        return s;
      },
    };
    const mediaSession = {
      handlers: {}, mic: null, cam: null,
      setActionHandler(n, fn) {
        if (noHangup && n === 'hangup') throw new TypeError('The provided value \'hangup\' is not a valid enum value');
        if (fn) mediaSession.handlers[n] = fn;
        else delete mediaSession.handlers[n];
      },
      setMicrophoneActive(v) { mediaSession.mic = v; },
      setCameraActive(v) { mediaSession.cam = v; },
    };

    class FakePC extends EventTarget {
      constructor(config = {}) {
        super();
        for (const s of (config && config.iceServers) || []) {
          const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
          for (const u of urls) if (!/^(stuns?|turns?):/.test(String(u))) throw new TypeError('bad ice server url ' + u);
        }
        this.config = JSON.parse(JSON.stringify(config || {}));
        this.browser = b;
        this.net = net;
        net.pcs.push(this);
        b.pcs.push(this);
        net.created++;
        this.n = net.created;
        this.signalingState = 'stable';
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.iceGatheringState = 'new';
        this.localDescription = null;
        this.remoteDescription = null;
        this.currentLocalDescription = null;
        this.currentRemoteDescription = null;
        this.transceivers = [];
        this.channels = [];
        this.hasData = false;
        this.dataMid = null;
        this.fingerprint = randomFingerprint();
        this.remoteFingerprint = null;
        this.ufrag = rid(4);
        this.gathered = null;
        this.remoteUfrag = null;
        this.remoteCands = [];
        this.added = [];
        this.peer = null;
        this.closed = false;
        this.negNeeded = false;
        this.negQueued = false;
        this.restartPending = false;
        this.version = 1;
        this.paramsLog = [];
        this.trackLog = [];
        this.bytes = new Map(); // mid -> { sent, received }
        this.sessionId = String(Math.floor(Math.random() * 1e15));
      }

      createDataChannel(label, opts = {}) {
        if (this.closed) throw dom('InvalidStateError');
        const dc = new FakeDataChannel(this, label, opts);
        this.channels.push(dc);
        if (!this.hasData) {
          this.hasData = true;
          this._needNeg();
        }
        if (this.peer && this.connectionState === 'connected') this._pairChannels();
        return dc;
      }

      addTransceiver(trackOrKind, init = {}) {
        if (this.closed) throw dom('InvalidStateError');
        const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
        const track = typeof trackOrKind === 'string' ? null : trackOrKind;
        const tx = new FakeTransceiver(this, kind, track, init.direction);
        this.transceivers.push(tx);
        this._needNeg();
        return tx;
      }

      getTransceivers() { return this.transceivers.slice(); }
      getSenders() { return this.transceivers.map((t) => t.sender); }
      getReceivers() { return this.transceivers.map((t) => t.receiver); }

      restartIce() {
        this.restartPending = true;
        this._needNeg();
      }

      _needNeg() {
        if (this.closed) return;
        this.negNeeded = true;
        if (this.negQueued) return;
        this.negQueued = true;
        setImmediate(() => {
          this.negQueued = false;
          if (this.closed || !this.negNeeded || this.signalingState !== 'stable') return;
          this.negNeeded = false;
          this.dispatchEvent(new Event('negotiationneeded'));
        });
      }

      _assignMids() {
        let i = 0;
        const used = new Set(this.transceivers.map((t) => t.mid).filter((m) => m !== null).concat(this.dataMid !== null ? [this.dataMid] : []));
        const next = () => {
          while (used.has(String(i))) i++;
          used.add(String(i));
          return String(i);
        };
        for (const t of this.transceivers) if (t.mid === null) t.mid = next();
        if (this.hasData && this.dataMid === null) this.dataMid = next();
      }

      _section(kind, mid, direction, setup) {
        const lines = [
          'm=' + (kind === 'application' ? 'application 9 UDP/DTLS/SCTP webrtc-datachannel' : kind + ' 9 UDP/TLS/RTP/SAVPF ' + (kind === 'audio' ? '111' : '96 97')),
          'c=IN IP4 0.0.0.0',
        ];
        if (kind !== 'application') lines.push('a=rtcp:9 IN IP4 0.0.0.0');
        lines.push('a=ice-ufrag:' + this.ufrag, 'a=ice-pwd:' + rid(24), 'a=ice-options:trickle', 'a=fingerprint:sha-256 ' + this.fingerprint, 'a=setup:' + setup, 'a=mid:' + mid);
        if (kind === 'application') {
          lines.push('a=sctp-port:5000', 'a=max-message-size:262144');
        } else {
          lines.push('a=' + direction, 'a=rtcp-mux', kind === 'audio' ? 'a=rtpmap:111 opus/48000/2' : 'a=rtpmap:96 VP8/90000');
          let pad = 0;
          let pt = 100;
          while (pad < net.sdpPad) {
            const l = 'a=rtpmap:' + (pt++) + ' H264/90000 profile-level-id=42e01f;packetization-mode=1;level-asymmetry-allowed=1';
            lines.push(l);
            pad += l.length + 2;
          }
        }
        return lines;
      }

      _sdp(type) {
        this._assignMids();
        const remote = type === 'answer' ? parseSdp(this.remoteDescription.sdp) : null;
        const sections = [];
        const mids = [];
        if (type === 'offer') {
          for (const t of this.transceivers) {
            sections.push(this._section(t.kind, t.mid, t.direction, 'actpass'));
            mids.push(t.mid);
          }
          if (this.hasData) {
            sections.push(this._section('application', this.dataMid, null, 'actpass'));
            mids.push(this.dataMid);
          }
        } else {
          for (const m of remote.media) {
            if (m.kind === 'application') {
              sections.push(this._section('application', m.mid, null, 'active'));
            } else {
              const t = this.transceivers.find((x) => x.mid === m.mid);
              const dir = t ? t.direction : 'inactive';
              sections.push(this._section(m.kind, m.mid, dir, 'active'));
            }
            mids.push(m.mid);
          }
        }
        const head = ['v=0', 'o=- ' + this.sessionId + ' ' + (this.version++) + ' IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE ' + mids.join(' '), 'a=msid-semantic: WMS *'];
        return head.concat(...sections).join('\r\n') + '\r\n';
      }

      async createOffer(opts = {}) {
        await tick();
        if (this.closed) throw dom('InvalidStateError');
        if (opts && opts.iceRestart) this.restartPending = true;
        if (this.restartPending) {
          this.ufrag = rid(4);
          this.restartPending = false;
        }
        return { type: 'offer', sdp: this._sdp('offer') };
      }

      async createAnswer() {
        await tick();
        if (this.closed) throw dom('InvalidStateError');
        if (this.signalingState !== 'have-remote-offer') throw dom('InvalidStateError', 'createAnswer in ' + this.signalingState);
        return { type: 'answer', sdp: this._sdp('answer') };
      }

      async setLocalDescription(desc) {
        await tick();
        if (this.closed) throw dom('InvalidStateError');
        if (!desc || desc.type === undefined) {
          desc = this.signalingState === 'have-remote-offer' ? await this.createAnswer() : await this.createOffer();
        }
        if (desc.type === 'rollback') {
          if (this.signalingState !== 'have-local-offer') throw dom('InvalidStateError', 'rollback in ' + this.signalingState);
          this.signalingState = 'stable';
          this.localDescription = this.currentLocalDescription;
          this.dispatchEvent(new Event('signalingstatechange'));
          return;
        }
        if (typeof desc.sdp !== 'string' || desc.sdp.length === 0) {
          desc = desc.type === 'answer' ? await this.createAnswer() : await this.createOffer();
        }
        if (desc.type === 'offer') {
          if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer') throw dom('InvalidStateError', 'offer in ' + this.signalingState);
          this.signalingState = 'have-local-offer';
        } else if (desc.type === 'answer') {
          if (this.signalingState !== 'have-remote-offer') throw dom('InvalidStateError', 'answer in ' + this.signalingState);
          this.signalingState = 'stable';
        } else throw new TypeError('bad type ' + desc.type);
        this.localDescription = { type: desc.type, sdp: desc.sdp };
        if (this.signalingState === 'stable') {
          this.currentLocalDescription = this.localDescription;
          this.currentRemoteDescription = this.remoteDescription;
        }
        this._gather();
        this.dispatchEvent(new Event('signalingstatechange'));
        if (this.signalingState === 'stable') this._stable();
        this._maybeConnect();
      }

      async setRemoteDescription(desc) {
        await tick();
        if (this.closed) throw dom('InvalidStateError');
        const parsed = parseSdp(desc.sdp);
        if (!parsed.fingerprints.length) throw dom('InvalidAccessError', 'no DTLS fingerprint');
        if (this.remoteFingerprint && parsed.fingerprints[0] !== this.remoteFingerprint) throw dom('InvalidAccessError', 'DTLS fingerprint changed');
        if (desc.type === 'offer') {
          if (this.signalingState === 'have-local-offer') {
            this.signalingState = 'stable'; // implicit rollback
            this.localDescription = this.currentLocalDescription;
          }
          if (this.signalingState !== 'stable') throw dom('InvalidStateError', 'offer in ' + this.signalingState);
          for (const m of parsed.media) {
            if (m.kind === 'application') {
              this.dataMid = m.mid;
              continue;
            }
            let t = this.transceivers.find((x) => x.mid === m.mid);
            if (!t) {
              t = this.transceivers.find((x) => x.mid === null && x.kind === m.kind);
              if (t) t.mid = m.mid;
            }
            if (!t) {
              t = new FakeTransceiver(this, m.kind, null, 'recvonly');
              t.mid = m.mid;
              this.transceivers.push(t);
            }
          }
          this.signalingState = 'have-remote-offer';
        } else if (desc.type === 'answer') {
          if (this.signalingState !== 'have-local-offer') throw dom('InvalidStateError', 'answer in ' + this.signalingState);
          this.signalingState = 'stable';
        } else throw new TypeError('bad type ' + desc.type);
        this.remoteFingerprint = parsed.fingerprints[0];
        this.remoteUfrag = parsed.ufrag;
        for (const c of parsed.candidates) this.remoteCands.push(c);
        this.remoteDescription = { type: desc.type, sdp: desc.sdp };
        if (this.signalingState === 'stable') {
          this.currentLocalDescription = this.localDescription;
          this.currentRemoteDescription = this.remoteDescription;
        }
        for (const m of parsed.media) {
          if (m.kind === 'application') continue;
          const t = this.transceivers.find((x) => x.mid === m.mid);
          if (t && !t.fired && (m.direction === 'sendrecv' || m.direction === 'sendonly')) {
            t.fired = true;
            t.currentDirection = REVERSE[m.direction];
            const ev = new Event('track');
            ev.track = t.receiver.track;
            ev.transceiver = t;
            ev.receiver = t.receiver;
            ev.streams = [];
            this.dispatchEvent(ev);
          }
        }
        this.dispatchEvent(new Event('signalingstatechange'));
        if (this.signalingState === 'stable') this._stable();
        this._maybeConnect();
      }

      _stable() {
        if (this.negNeeded) this._needNeg();
      }

      async addIceCandidate(init) {
        await tick();
        if (this.closed) throw dom('InvalidStateError');
        if (!this.remoteDescription) throw dom('InvalidStateError', 'The remote description was null');
        const c = init && init.candidate;
        if (typeof c !== 'string') throw new TypeError('candidate');
        if (c === '') return;
        if ((init.sdpMid === undefined || init.sdpMid === null) && (init.sdpMLineIndex === undefined || init.sdpMLineIndex === null)) {
          throw new TypeError('Candidate missing values for both sdpMid and sdpMLineIndex');
        }
        this.added.push(c);
        this.remoteCands.push(c);
        this._maybeConnect();
      }

      _candidates() {
        const port = 50000 + this.n;
        const u = this.ufrag;
        const pub = '198.51.100.' + ((b.seq % 200) + 10);
        return [
          'candidate:1 1 udp 2122260223 127.0.0.1 ' + port + ' typ host generation 0 ufrag ' + u + ' network-id 1',
          'candidate:2 1 udp 2122194687 192.168.1.' + ((b.seq % 200) + 20) + ' ' + port + ' typ host generation 0 ufrag ' + u + ' network-id 2',
          'candidate:3 1 udp 1686052607 ' + pub + ' ' + port + ' typ srflx raddr 192.168.1.' + ((b.seq % 200) + 20) + ' rport ' + port + ' generation 0 ufrag ' + u + ' network-id 2',
        ];
      }

      _gather() {
        if (this.gathered === this.ufrag) return;
        this.gathered = this.ufrag;
        this.iceGatheringState = 'gathering';
        const list = this._candidates();
        (async () => {
          for (const c of list) {
            await tick();
            if (this.closed) return;
            const ev = new Event('icecandidate');
            ev.candidate = { candidate: c, sdpMid: '0', sdpMLineIndex: 0 };
            this.dispatchEvent(ev);
          }
          await tick();
          if (this.closed) return;
          this.iceGatheringState = 'complete';
          const end = new Event('icecandidate');
          end.candidate = null;
          this.dispatchEvent(end);
        })();
      }

      _hasCandFrom(other) {
        return this.remoteCands.some((c) => ufragOf(c) === other.ufrag);
      }

      _maybeConnect() {
        if (this.closed || net.block || net.cuts.has(this)) return;
        if (!this.localDescription || !this.remoteDescription || this.signalingState !== 'stable') return;
        const peer = net.pcs.find((p) => p !== this && !p.closed && p.fingerprint === this.remoteFingerprint && p.remoteFingerprint === this.fingerprint);
        if (!peer || net.cuts.has(peer)) return;
        if (!peer.localDescription || !peer.remoteDescription || peer.signalingState !== 'stable') return;
        if (!this._hasCandFrom(peer) || !peer._hasCandFrom(this)) return;
        if (this.connectionState === 'connected' && this.peer === peer) return;
        this.peer = peer;
        peer.peer = this;
        for (const pc of [this, peer]) {
          if (pc.connectionState !== 'connected' && pc.connectionState !== 'connecting') {
            pc.connectionState = 'connecting';
            pc.dispatchEvent(new Event('connectionstatechange'));
          }
        }
        setImmediate(() => {
          for (const pc of [this, peer]) {
            if (pc.closed || pc.connectionState === 'connected') continue;
            pc.connectionState = 'connected';
            pc.iceConnectionState = 'connected';
            pc.dispatchEvent(new Event('connectionstatechange'));
          }
          this._pairChannels();
        });
      }

      _pairChannels() {
        const peer = this.peer;
        if (!peer || this.closed || peer.closed) return;
        for (const dc of this.channels) {
          if (dc.peer || dc.readyState !== 'connecting') continue;
          const other = peer.channels.find((x) => x.id === dc.id && x.negotiated === dc.negotiated && !x.peer && x.readyState === 'connecting');
          if (!other) continue;
          dc.peer = other;
          other.peer = dc;
          setImmediate(() => {
            dc._open();
            other._open();
          });
        }
      }

      _flow(t) {
        let e = this.bytes.get(t.mid);
        if (!e) {
          e = { sent: 0, received: 0, packets: 0 };
          this.bytes.set(t.mid, e);
        }
        return e;
      }

      async getStats() {
        await tick();
        const m = new Map();
        const add = (o) => m.set(o.id, o);
        const connected = this.connectionState === 'connected' && this.peer && !this.peer.closed;
        add({ id: 'T01', type: 'transport', dtlsState: connected ? 'connected' : 'new', selectedCandidatePairId: connected ? 'CP01' : undefined, localCertificateId: 'CFL', remoteCertificateId: this.peer ? 'CFR' : undefined });
        add({ id: 'CFL', type: 'certificate', fingerprint: this.fingerprint, fingerprintAlgorithm: 'sha-256' });
        if (this.peer) {
          const fp = typeof net.tamper === 'function' ? (net.tamper(this) || this.peer.fingerprint) : this.peer.fingerprint;
          add({ id: 'CFR', type: 'certificate', fingerprint: fp, fingerprintAlgorithm: 'sha-256' });
        }
        if (connected) {
          add({ id: 'CP01', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'LC1', remoteCandidateId: 'RC1', availableOutgoingBitrate: net.aob, currentRoundTripTime: 0.012 });
          add({ id: 'LC1', type: 'local-candidate', candidateType: net.relay ? 'relay' : 'host' });
          add({ id: 'RC1', type: 'remote-candidate', candidateType: 'host' });
          for (const t of this.transceivers) {
            const live = t.sender.track && t.sender.track.readyState === 'live' && t.sender.params.encodings[0].active !== false;
            const f = this._flow(t);
            if (live) {
              f.sent += t.kind === 'audio' ? 400 : 4000;
              f.packets += 10;
            }
            if (t.sender.track) {
              add({ id: 'OUT' + t.mid, type: 'outbound-rtp', kind: t.kind, mid: t.mid, bytesSent: f.sent, packetsSent: f.packets, qualityLimitationReason: t.kind === 'video' ? net.qlr : undefined });
              add({ id: 'RIN' + t.mid, type: 'remote-inbound-rtp', kind: t.kind, packetsLost: Math.round(f.packets * net.loss), fractionLost: net.loss, roundTripTime: 0.012 });
            }
            const pt = this.peer.transceivers.find((x) => x.mid === t.mid);
            const peerLive = pt && pt.sender.track && pt.sender.track.readyState === 'live' && pt.sender.params.encodings[0].active !== false;
            if (peerLive) f.received += t.kind === 'audio' ? 400 : 4000;
            if (pt && pt.sender.track) add({ id: 'IN' + t.mid, type: 'inbound-rtp', kind: t.kind, mid: t.mid, bytesReceived: f.received });
          }
        }
        return m;
      }

      close() {
        if (this.closed) return;
        this.closed = true;
        this.signalingState = 'closed';
        this.connectionState = 'closed';
        this.iceConnectionState = 'closed';
        for (const dc of this.channels) {
          if (dc.readyState === 'closed') continue;
          dc.readyState = 'closed';
          const p = dc.peer;
          if (p) setImmediate(() => p._remoteClose());
        }
        for (const t of this.transceivers) t.receiver.track.readyState = 'ended';
        const peer = this.peer;
        if (peer && !peer.closed) {
          setImmediate(() => {
            if (peer.closed || peer.connectionState !== 'connected') return;
            peer.connectionState = 'disconnected';
            peer.dispatchEvent(new Event('connectionstatechange'));
          });
        }
      }
    }

    return { name, RTCPeerConnection: FakePC, mediaDevices, wakeLock, mediaSession, pcs: b.pcs, tracks: b.tracks, live: () => b.tracks.filter((t) => t.readyState === 'live') };
  };
  return net;
}
