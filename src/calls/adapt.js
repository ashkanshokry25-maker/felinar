// Media rates and the adaptation ladder (SZ 3.5 "Media and adaptation"). Pure functions from a policy class, the call
// mode and stats samples to RTCRtpSender encodings, plus the 2 s getStats driver.
//
//   mediaProfile({ cls, mesh }) -> { cls, mesh, audioOnly, metered, audio: { maxBitrate }, video: { maxBitrate, scale },
//                                   screen: { maxBitrate, maxFramerate, hint } }
//     audio 32 kbit/s (24 metered); camera 800 kbit/s in a call of two and 400 in a mesh on a desktop, phones 500 and
//     300; a metered network starts audio only and runs video at 300 kbit/s scaled by 2; screen 1,200 kbit/s (600 in a
//     mesh), 15 frames a second, contentHint 'detail' (all chosen; 32 kbit/s is the measured default).
//   ladder(profile) -> rungs: halve the camera bitrate down to 100 kbit/s, then scale by 2, then by 4, then pause the
//     camera (audio and the screen keep their rates).
//   adaptStart(profile, now), adaptStep(state, sample, now) -> { state, changed, limited }: 5% loss, or 4 s limited
//     (qualityLimitationReason 'bandwidth' or 'cpu', or availableOutgoingBitrate under the send target), is one step
//     down; one step back after 10 s clean.
//   encodingsOf(state) -> { audio, camera, screen } encodings for setParameters.
//   readSample(report, prev) -> { at, path, availableOutgoingBitrate, rtt, loss, qualityLimitationReason, bytes, packets }
//   AdaptDriver: reads getStats every 2 s, steps the ladder, applies changed encodings.
//
// Arithmetic from SZ 3.5: a 4-way video mesh sends 3 x (400 + 32) = 1,296 kbit/s; 300 kbit/s video is 2.25 MB a minute.
//
// Shared code: Node >= 22 and browsers, no imports beyond limits.js.

import {
  AUDIO_BPS, AUDIO_METERED_BPS, VIDEO_BPS, METERED_VIDEO_SCALE, SCREEN_BPS, SCREEN_FPS, SCREEN_HINT, ADAPT_INTERVAL_MS,
  ADAPT_LOSS, ADAPT_LIMITED_MS, ADAPT_CLEAN_MS, VIDEO_FLOOR_BPS, VIDEO_SCALE_STEPS, METERED_CLASSES,
  AUDIO_DEFAULT_CLASSES, PHONE_CLASSES,
} from './limits.js';

/** mediaProfile({ cls, mesh }) -> the per-stream targets of one pair. cls: a src/loader/policy.js policy class. */
export function mediaProfile({ cls = 'desktop', mesh = false } = {}) {
  const metered = METERED_CLASSES.indexOf(cls) >= 0;
  const phone = PHONE_CLASSES.indexOf(cls) >= 0;
  const row = metered ? VIDEO_BPS.metered : (phone ? VIDEO_BPS.phone : VIDEO_BPS.desktop);
  return {
    cls,
    mesh: !!mesh,
    metered,
    phone,
    audioOnly: metered,
    audioDefault: AUDIO_DEFAULT_CLASSES.indexOf(cls) >= 0,
    audio: { maxBitrate: metered ? AUDIO_METERED_BPS : AUDIO_BPS },
    video: { maxBitrate: mesh ? row.mesh : row.one, scale: metered ? METERED_VIDEO_SCALE : 1 },
    screen: { maxBitrate: mesh ? SCREEN_BPS.mesh : SCREEN_BPS.one, maxFramerate: SCREEN_FPS, hint: SCREEN_HINT },
  };
}

/** ladder(profile) -> [{ maxBitrate, scale, active }]: rung 0 is the profile's own target; the last rung pauses video. */
export function ladder(profile) {
  const base = profile.video.maxBitrate;
  const s0 = profile.video.scale || 1;
  const rungs = [{ maxBitrate: base, scale: s0, active: true }];
  let br = base;
  while (br / 2 >= VIDEO_FLOOR_BPS) {
    br = Math.round(br / 2);
    rungs.push({ maxBitrate: br, scale: s0, active: true });
  }
  if (br > VIDEO_FLOOR_BPS) {
    br = VIDEO_FLOOR_BPS;
    rungs.push({ maxBitrate: br, scale: s0, active: true });
  }
  for (const sc of VIDEO_SCALE_STEPS) if (sc > s0) rungs.push({ maxBitrate: br, scale: sc, active: true });
  rungs.push({ maxBitrate: br, scale: rungs[rungs.length - 1].scale, active: false });
  return rungs;
}

/** adaptStart(profile, now) -> state */
export function adaptStart(profile, now = Date.now()) {
  return { profile, rungs: ladder(profile), rung: 0, limitedSince: null, cleanSince: now, last: null };
}

/** The bits a pair asks to send right now (audio plus camera when it runs). */
export function sendTarget(state) {
  const r = state.rungs[state.rung];
  return state.profile.audio.maxBitrate + (r.active ? r.maxBitrate : 0);
}

function isLimited(state, sample) {
  if (!sample) return false;
  if (sample.qualityLimitationReason === 'bandwidth' || sample.qualityLimitationReason === 'cpu') return true;
  const aob = sample.availableOutgoingBitrate;
  return typeof aob === 'number' && aob > 0 && aob < sendTarget(state);
}

/**
 * adaptStep(state, sample, now) -> { state, changed, limited }. sample = readSample() output; sample.videoSending false
 * (no camera track) keeps the ladder where it is, so a camera turned on later starts from the current rung.
 */
export function adaptStep(state, sample, now = Date.now()) {
  const s = Object.assign({}, state, { last: sample });
  let changed = false;
  const lossy = sample && typeof sample.loss === 'number' && sample.loss >= ADAPT_LOSS;
  const limitedNow = isLimited(state, sample);
  if (limitedNow) {
    if (s.limitedSince === null) s.limitedSince = now;
  } else {
    s.limitedSince = null;
  }
  const limitedLong = s.limitedSince !== null && now - s.limitedSince >= ADAPT_LIMITED_MS;
  const bad = lossy || limitedLong;
  if (bad) {
    s.cleanSince = null;
    if (s.rung < s.rungs.length - 1) {
      s.rung += 1;
      changed = true;
    }
    if (limitedLong) s.limitedSince = now; // the next step needs another 4 s
  } else if (!limitedNow) {
    if (s.cleanSince === null) s.cleanSince = now;
    if (s.rung > 0 && now - s.cleanSince >= ADAPT_CLEAN_MS) {
      s.rung -= 1;
      s.cleanSince = now;
      changed = true;
    }
  } else {
    s.cleanSince = null;
  }
  return { state: s, changed, limited: s.rung > 0 || limitedNow };
}

/** encodingsOf(state) -> { audio, camera, screen }: what setParameters gets for each sender. */
export function encodingsOf(state) {
  const p = state.profile;
  const r = state.rungs[state.rung];
  return {
    audio: { maxBitrate: p.audio.maxBitrate, active: true },
    camera: { maxBitrate: r.maxBitrate, scaleResolutionDownBy: r.scale, active: r.active },
    screen: { maxBitrate: p.screen.maxBitrate, maxFramerate: p.screen.maxFramerate, active: true },
  };
}

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

function eachStat(report, fn) {
  if (!report) return;
  if (typeof report.forEach === 'function') {
    report.forEach((v) => fn(v));
    return;
  }
  if (typeof report.values === 'function') for (const v of report.values()) fn(v);
}

/**
 * readSample(report, prev) -> sample. Reads the selected candidate pair (availableOutgoingBitrate, round-trip time,
 * 'direct' or 'relayed'), the camera's outbound stream (qualityLimitationReason), loss of the sent camera (or audio)
 * stream from the remote-inbound stats (fractionLost, or the packetsLost delta against the packetsSent delta), and
 * bytes and packets per kind both ways. Mid '2' and later video are counted as screen by the caller's layout.
 */
export function readSample(report, prev = null, { now = Date.now(), cameraMid = null } = {}) {
  const byId = new Map();
  const list = [];
  eachStat(report, (s) => {
    if (s && typeof s === 'object') {
      byId.set(s.id, s);
      list.push(s);
    }
  });
  const out = {
    at: now, path: null, availableOutgoingBitrate: null, rtt: null, loss: null, qualityLimitationReason: null,
    videoSending: false,
    bytes: { audioSent: 0, videoSent: 0, audioReceived: 0, videoReceived: 0 },
    packets: { videoSent: 0, videoLost: 0, audioSent: 0, audioLost: 0 },
  };
  let pair = null;
  for (const s of list) {
    if (s.type === 'transport' && s.selectedCandidatePairId && byId.get(s.selectedCandidatePairId)) pair = byId.get(s.selectedCandidatePairId);
  }
  if (!pair) {
    for (const s of list) {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) {
        pair = s;
        break;
      }
    }
  }
  if (pair) {
    if (typeof pair.availableOutgoingBitrate === 'number') out.availableOutgoingBitrate = pair.availableOutgoingBitrate;
    if (typeof pair.currentRoundTripTime === 'number') out.rtt = pair.currentRoundTripTime;
    const l = byId.get(pair.localCandidateId);
    const r = byId.get(pair.remoteCandidateId);
    if (l || r) out.path = (l && l.candidateType === 'relay') || (r && r.candidateType === 'relay') ? 'relayed' : 'direct';
  }
  let fraction = null;
  for (const s of list) {
    const kind = s.kind || s.mediaType;
    if (s.type === 'outbound-rtp') {
      if (kind === 'audio') {
        out.bytes.audioSent += s.bytesSent || 0;
        out.packets.audioSent += s.packetsSent || 0;
      } else if (kind === 'video') {
        out.bytes.videoSent += s.bytesSent || 0;
        out.packets.videoSent += s.packetsSent || 0;
        const isCamera = cameraMid === null || s.mid === undefined || String(s.mid) === String(cameraMid);
        if (isCamera && (s.bytesSent || 0) > 0) out.videoSending = true;
        if (isCamera && typeof s.qualityLimitationReason === 'string') {
          if (out.qualityLimitationReason === null || out.qualityLimitationReason === 'none') out.qualityLimitationReason = s.qualityLimitationReason;
        }
      }
    } else if (s.type === 'inbound-rtp') {
      if (kind === 'audio') out.bytes.audioReceived += s.bytesReceived || 0;
      else if (kind === 'video') out.bytes.videoReceived += s.bytesReceived || 0;
    } else if (s.type === 'remote-inbound-rtp') {
      if (kind === 'video') {
        out.packets.videoLost += Math.max(0, s.packetsLost || 0);
        if (typeof s.fractionLost === 'number') fraction = Math.max(fraction === null ? 0 : fraction, s.fractionLost);
      } else if (kind === 'audio') {
        out.packets.audioLost += Math.max(0, s.packetsLost || 0);
        if (fraction === null && typeof s.fractionLost === 'number') fraction = s.fractionLost;
      }
      if (out.rtt === null && typeof s.roundTripTime === 'number') out.rtt = s.roundTripTime;
    }
  }
  if (fraction !== null) out.loss = fraction;
  else if (prev && prev.packets) {
    const kind = out.packets.videoSent > 0 ? 'video' : 'audio';
    const sent = out.packets[kind + 'Sent'] - prev.packets[kind + 'Sent'];
    const lost = out.packets[kind + 'Lost'] - prev.packets[kind + 'Lost'];
    if (sent > 0 && lost >= 0) out.loss = lost / (sent + lost);
  }
  return out;
}

/**
 * new AdaptDriver({ getStats, apply(encodings), profile, interval = 2000, setTimeout, clearTimeout, now, onSample, cameraMid })
 * start() / stop() / setProfile(profile) / tick() -> Promise. apply() gets encodingsOf(state) whenever the rung moves
 * (and once at start); onSample(sample, { rung, limited }) after every reading.
 */
export class AdaptDriver {
  constructor({ getStats, apply, profile, interval = ADAPT_INTERVAL_MS, setTimeout: st, clearTimeout: ct, now = () => Date.now(), onSample = () => {}, cameraMid = () => null }) {
    if (typeof getStats !== 'function' || typeof apply !== 'function') throw new TypeError('AdaptDriver needs getStats and apply');
    this.getStats = getStats;
    this.apply = apply;
    this.interval = interval;
    this.setT = st || ((fn, ms) => setTimeout(fn, ms));
    this.clearT = ct || ((h) => clearTimeout(h));
    this.now = now;
    this.onSample = onSample;
    this.cameraMid = cameraMid;
    this.state = adaptStart(profile, now());
    this.prev = null;
    this.timer = null;
    this.running = false;
    this.limited = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    Promise.resolve().then(() => this.apply(encodingsOf(this.state))).catch(() => {});
    this._schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearT(this.timer);
    this.timer = null;
  }

  setProfile(profile) {
    this.state = adaptStart(profile, this.now());
    if (this.running) Promise.resolve().then(() => this.apply(encodingsOf(this.state))).catch(() => {});
  }

  _schedule() {
    if (!this.running) return;
    this.timer = this.setT(() => {
      this.timer = null;
      this.tick().catch(() => {}).then(() => this._schedule());
    }, this.interval);
  }

  async tick() {
    let report;
    try {
      report = await this.getStats();
    } catch (_) {
      return null;
    }
    const sample = readSample(report, this.prev, { now: this.now(), cameraMid: this.cameraMid() });
    this.prev = sample;
    const r = adaptStep(this.state, sample, this.now());
    this.state = r.state;
    this.limited = r.limited;
    if (r.changed) {
      try { await this.apply(encodingsOf(this.state)); } catch (_) { /* a sender that went away */ }
    }
    try { this.onSample(sample, { rung: this.state.rung, limited: r.limited, changed: r.changed }); } catch (_) { /* listener */ }
    return sample;
  }
}
