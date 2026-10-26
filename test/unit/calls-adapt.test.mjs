// Unit tests for src/calls/adapt.js (SZ 3.5 "Media and adaptation"): per-class targets, the ladder (halve to 100 kbit/s,
// scale by 2 and 4, pause the camera, audio kept), the step rules (5% loss or 4 s limited down, 10 s clean up),
// readSample from stats reports, the 2 s driver, and the arithmetic SZ 3.5 states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mediaProfile, ladder, adaptStart, adaptStep, encodingsOf, readSample, sendTarget, AdaptDriver } from '../../src/calls/adapt.js';
import { ADAPT_INTERVAL_MS } from '../../src/calls/limits.js';

const VEC = JSON.parse(readFileSync(fileURLToPath(new URL('../vectors/calls.json', import.meta.url)), 'utf8'));

test('golden vectors: targets and ladders by policy class and mode', () => {
  const v = VEC.vectors.find((x) => x.id === 'calls-media-001-profiles');
  const got = v.input.map(({ cls, mesh }) => {
    const p = mediaProfile({ cls, mesh });
    return { audio: p.audio.maxBitrate, video: p.video.maxBitrate, scale: p.video.scale, screen: p.screen.maxBitrate, screenFps: p.screen.maxFramerate, hint: p.screen.hint, audioOnly: p.audioOnly, audioDefault: p.audioDefault, ladder: ladder(p).map((r) => (r.active ? [r.maxBitrate, r.scale] : 'pause')) };
  });
  assert.deepEqual(got, v.expect);
});

test('targets (chosen, SZ 3.5): audio 32 kbit/s, 24 metered; camera 800/400 desktop, 500/300 phones, 300 scaled by 2 metered; screen 1,200/600 at 15 fps', () => {
  const d1 = mediaProfile({ cls: 'desktop' });
  assert.deepEqual([d1.audio.maxBitrate, d1.video.maxBitrate, d1.video.scale, d1.screen.maxBitrate, d1.screen.maxFramerate, d1.screen.hint], [32000, 800000, 1, 1200000, 15, 'detail']);
  const dm = mediaProfile({ cls: 'desktop', mesh: true });
  assert.deepEqual([dm.video.maxBitrate, dm.screen.maxBitrate], [400000, 600000]);
  assert.deepEqual([mediaProfile({ cls: 'mobileUnmetered' }).video.maxBitrate, mediaProfile({ cls: 'mobileUnmetered', mesh: true }).video.maxBitrate], [500000, 300000]);
  const m = mediaProfile({ cls: 'mobileMetered' });
  assert.deepEqual([m.audio.maxBitrate, m.video.maxBitrate, m.video.scale, m.audioOnly, m.metered], [24000, 300000, 2, true, true]);
  assert.equal(mediaProfile({ cls: 'mobileUnknown' }).audioDefault, true, 'SZ-4 (pending): an unknown phone network defaults to audio');
  assert.equal(mediaProfile({ cls: 'mobileUnknown' }).audioOnly, false, 'but video still works when the person asks for it');
  assert.equal(mediaProfile({ cls: 'desktop' }).audioDefault, false);
  assert.equal(mediaProfile({}).cls, 'desktop');
});

test('the arithmetic of SZ 3.5: a 4-way desktop video mesh sends 1,296 kbit/s; 300 kbit/s video is 2.25 MB a minute', () => {
  const p = mediaProfile({ cls: 'desktop', mesh: true });
  assert.equal(3 * (p.video.maxBitrate + p.audio.maxBitrate) / 1000, 1296);
  const metered = mediaProfile({ cls: 'mobileMetered' });
  assert.equal(metered.video.maxBitrate * 60 / 8 / 1e6, 2.25);
  assert.equal(sendTarget(adaptStart(p, 0)), 432000);
});

test('the ladder: halve to the 100 kbit/s floor, then scale by 2 and 4, then pause the camera; audio and the screen keep their rates', () => {
  const p = mediaProfile({ cls: 'desktop' });
  const r = ladder(p);
  assert.deepEqual(r.map((x) => [x.maxBitrate, x.scale, x.active]), [[800000, 1, true], [400000, 1, true], [200000, 1, true], [100000, 1, true], [100000, 2, true], [100000, 4, true], [100000, 4, false]]);
  const s = adaptStart(p, 0);
  s.rung = r.length - 1;
  const e = encodingsOf(s);
  assert.deepEqual(e.camera, { maxBitrate: 100000, scaleResolutionDownBy: 4, active: false });
  assert.deepEqual(e.audio, { maxBitrate: 32000, active: true }, 'audio stays');
  assert.deepEqual(e.screen, { maxBitrate: 1200000, maxFramerate: 15, active: true });
  assert.deepEqual(ladder(mediaProfile({ cls: 'mobileMetered' })).map((x) => (x.active ? x.maxBitrate / 1000 + '/' + x.scale : 'pause')), ['300/2', '150/2', '100/2', '100/4', 'pause'], 'metered starts at scale 2, so only 4 remains');
  assert.deepEqual(ladder(mediaProfile({ cls: 'mobileUnmetered' })).map((x) => x.maxBitrate), [500000, 250000, 125000, 100000, 100000, 100000, 100000], 'an odd halving ends on the floor');
});

test('steps: 5% loss is one step down at once; limited for 4 s is one step; 10 s clean is one step back', () => {
  const p = mediaProfile({ cls: 'desktop' });
  let s = adaptStart(p, 0);
  let r = adaptStep(s, { loss: 0.05 }, 2000);
  assert.equal(r.changed, true);
  assert.equal(r.state.rung, 1);
  assert.equal(r.limited, true);
  r = adaptStep(r.state, { loss: 0.2 }, 4000);
  assert.equal(r.state.rung, 2);
  // Limited (bandwidth): the first reading starts the clock, the one 4 s later steps.
  r = adaptStep(r.state, { loss: 0, qualityLimitationReason: 'bandwidth' }, 6000);
  assert.equal(r.state.rung, 2);
  r = adaptStep(r.state, { loss: 0, qualityLimitationReason: 'bandwidth' }, 8000);
  assert.equal(r.state.rung, 2, '2 s limited is not enough');
  r = adaptStep(r.state, { loss: 0, qualityLimitationReason: 'bandwidth' }, 10000);
  assert.equal(r.state.rung, 3, '4 s limited');
  r = adaptStep(r.state, { loss: 0, qualityLimitationReason: 'cpu' }, 12000);
  r = adaptStep(r.state, { loss: 0, qualityLimitationReason: 'cpu' }, 14000);
  assert.equal(r.state.rung, 4, 'cpu counts as limited too');
  // availableOutgoingBitrate under the send target is limited.
  r = adaptStep(r.state, { loss: 0, qualityLimitationReason: 'none', availableOutgoingBitrate: 50000 }, 16000);
  r = adaptStep(r.state, { loss: 0, qualityLimitationReason: 'none', availableOutgoingBitrate: 50000 }, 20000);
  assert.equal(r.state.rung, 5);
  // Clean: one step back after 10 s, then another after 10 s more.
  r = adaptStep(r.state, { loss: 0.01, qualityLimitationReason: 'none', availableOutgoingBitrate: 3e6 }, 22000);
  assert.equal(r.state.rung, 5);
  r = adaptStep(r.state, { loss: 0, qualityLimitationReason: 'none' }, 30000);
  assert.equal(r.state.rung, 5, '8 s clean');
  r = adaptStep(r.state, { loss: 0, qualityLimitationReason: 'none' }, 32000);
  assert.equal(r.state.rung, 4, '10 s clean');
  assert.equal(r.changed, true);
  r = adaptStep(r.state, { loss: 0 }, 42000);
  assert.equal(r.state.rung, 3);
  // The bottom holds.
  s = adaptStart(p, 0);
  for (let i = 0; i < 20; i++) s = adaptStep(s, { loss: 0.5 }, i * 2000).state;
  assert.equal(s.rung, ladder(p).length - 1);
  assert.equal(encodingsOf(s).camera.active, false, 'video paused');
  // Nothing to read is clean.
  s = adaptStart(p, 0);
  assert.equal(adaptStep(s, null, 2000).changed, false);
});

function report(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.id, e);
  return m;
}

test('readSample: the selected pair (direct or relayed), loss, round-trip time, limitation, bytes both ways', () => {
  const r = report([
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    { id: 'P', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R', availableOutgoingBitrate: 900000, currentRoundTripTime: 0.05 },
    { id: 'L', type: 'local-candidate', candidateType: 'relay' },
    { id: 'R', type: 'remote-candidate', candidateType: 'srflx' },
    { id: 'OA', type: 'outbound-rtp', kind: 'audio', bytesSent: 1000, packetsSent: 50 },
    { id: 'OV', type: 'outbound-rtp', kind: 'video', mid: '1', bytesSent: 90000, packetsSent: 100, qualityLimitationReason: 'bandwidth' },
    { id: 'OS', type: 'outbound-rtp', kind: 'video', mid: '2', bytesSent: 5000, packetsSent: 10, qualityLimitationReason: 'none' },
    { id: 'RV', type: 'remote-inbound-rtp', kind: 'video', packetsLost: 7, fractionLost: 0.07 },
    { id: 'IA', type: 'inbound-rtp', kind: 'audio', bytesReceived: 800 },
    { id: 'IV', type: 'inbound-rtp', kind: 'video', bytesReceived: 70000 },
  ]);
  const s = readSample(r, null, { now: 5, cameraMid: '1' });
  assert.equal(s.path, 'relayed');
  assert.equal(s.availableOutgoingBitrate, 900000);
  assert.equal(s.rtt, 0.05);
  assert.equal(s.loss, 0.07);
  assert.equal(s.qualityLimitationReason, 'bandwidth', 'the camera stream, not the screen');
  assert.equal(s.videoSending, true);
  assert.deepEqual(s.bytes, { audioSent: 1000, videoSent: 95000, audioReceived: 800, videoReceived: 70000 });
  // Loss from deltas when the report has no fractionLost; a direct pair; a report as an object with values().
  const r1 = { values: () => [{ id: 'P', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L', remoteCandidateId: 'R' }, { id: 'L', type: 'local-candidate', candidateType: 'host' }, { id: 'R', type: 'remote-candidate', candidateType: 'prflx' }, { id: 'OV', type: 'outbound-rtp', kind: 'video', packetsSent: 200 }, { id: 'RV', type: 'remote-inbound-rtp', kind: 'video', packetsLost: 10 }][Symbol.iterator]() };
  const prev = { packets: { videoSent: 100, videoLost: 0, audioSent: 0, audioLost: 0 } };
  const s1 = readSample(r1, prev);
  assert.equal(s1.path, 'direct');
  assert.equal(s1.loss, 10 / 110);
  assert.equal(readSample(new Map()).path, null);
  assert.equal(readSample(null).loss, null);
});

test('AdaptDriver: applies the start encodings, reads stats every 2 s, applies again only when the rung moves', async () => {
  let now = 0;
  const timers = [];
  const setT = (fn, ms) => { const h = { at: now + ms, fn }; timers.push(h); return h; };
  const clearT = (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); };
  const run = async (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const h = timers[0];
      if (!h || h.at > end) break;
      timers.shift();
      now = h.at;
      h.fn();
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    }
    now = end;
  };
  let loss = 0;
  const applied = [];
  const samples = [];
  const drv = new AdaptDriver({
    getStats: async () => report([{ id: 'RV', type: 'remote-inbound-rtp', kind: 'video', fractionLost: loss }]),
    apply: async (e) => applied.push(e.camera.maxBitrate),
    profile: mediaProfile({ cls: 'desktop' }), setTimeout: setT, clearTimeout: clearT, now: () => now,
    onSample: (s, info) => samples.push(info),
  });
  drv.start();
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(applied, [800000]);
  await run(ADAPT_INTERVAL_MS * 3);
  assert.equal(samples.length, 3);
  assert.deepEqual(applied, [800000], 'no change while clean at the top');
  loss = 0.1;
  await run(ADAPT_INTERVAL_MS);
  assert.deepEqual(applied, [800000, 400000]);
  assert.equal(drv.limited, true);
  drv.setProfile(mediaProfile({ cls: 'desktop', mesh: true }));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.equal(applied.at(-1), 400000, 'a new profile starts again at its own rung 0 (mesh: 400)');
  assert.equal(drv.state.rung, 0);
  drv.stop();
  const before = samples.length;
  await run(ADAPT_INTERVAL_MS * 3);
  assert.equal(samples.length, before, 'stopped');
  assert.throws(() => new AdaptDriver({}), TypeError);
});
