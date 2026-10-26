// 0.3.0 independence design (IND-11): the vendored WebTorrent bundle carries third-party defaults (Google and Twilio STUN, public
// UDP and WebSocket trackers). Visitors never reach them only because of the options src/loader/torrent.js passes: an explicit
// rtcConfig (or tracker: false) for the client, and private: true on every add. These tests fail when either option leaves the
// source, and they record the third-party hosts the bundle carries, so a vendor update that changes them fails until reviewed.
// No browser, no network: the files are read from disk.
// Run: node --test test/unit/bundle-defaults.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TORRENT_JS = join(ROOT, 'src/loader/torrent.js');

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.m?js$/.test(name)) out.push(p);
  }
  return out;
}

// The source without comments, so a pin cannot be satisfied by a sentence that describes the option.
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

// The body of a method of the TorrentManager class: from its signature to the first line that closes it at class indent.
function methodBody(text, signature) {
  const start = text.indexOf('\n  ' + signature);
  assert.ok(start >= 0, 'src/loader/torrent.js has no method ' + signature);
  const end = text.indexOf('\n  }\n', start);
  assert.ok(end > start, 'the method ' + signature + ' does not close at class indent');
  return text.slice(start, end);
}

test('IND-11: the loader builds one WebTorrent client, with an explicit rtcConfig that always holds iceServers, or tracker: false', () => {
  const src = code(readFileSync(TORRENT_JS, 'utf8'));
  // The only client in src/ (the shell and the drop-in both go through TorrentManager).
  const builders = [];
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const n = (code(readFileSync(file, 'utf8')).match(/new\s+(?:[A-Za-z_$][\w$]*\.)*WebTorrent\s*\(/g) || []).length;
    if (n) builders.push(relative(ROOT, file) + ' x' + n);
  }
  assert.deepEqual(builders, ['src/loader/torrent.js x1'], 'a WebTorrent client is built only in TorrentManager._ensureClient');
  const ensure = methodBody(src, '_ensureClient () {');
  assert.ok(ensure.includes('new this.WebTorrent({'), 'the client is built in _ensureClient');
  // Without rtcConfig, simple-peer falls back to its own config: stun.l.google.com and global.stun.twilio.com.
  assert.ok(ensure.includes('this._rtcConfig = { iceServers: (this._iceServers || this.config.stun).slice() }'), 'rtcConfig always holds an iceServers array');
  assert.ok(ensure.includes('tracker: peers ? { rtcConfig: this._rtcConfig } : false,'), 'the tracker option is our rtcConfig, or false before consent');
  assert.match(ensure, /\bdht: false,/);
  assert.match(ensure, /\blsd: false,/);
  // The lane STUN of chat, group, file and media swarms is never empty of iceServers either (R 2.7.1: host candidates when none).
  assert.ok(src.includes('this._laneRtc = { iceServers: [] }'), 'the lane rtcConfig starts with an empty iceServers array, not without one');
  assert.ok(methodBody(src, '_useLaneRtc (torrent) {').includes('Object.assign({}, saved, { rtcConfig: rtc })'), 'the lane discovery gets the lane rtcConfig');
  const setIce = methodBody(src, 'setIceServers (iceServers) {');
  assert.ok(setIce.includes('iceServers.length ? iceServers.slice() : this.config.stun.slice()'), 'setIceServers never leaves the list empty');
});

test('IND-11: every torrent is added with private: true, so the bundle\'s client-level tracker list is never appended', () => {
  const src = code(readFileSync(TORRENT_JS, 'utf8'));
  const adds = src.match(/\.add\(\s*source\s*,[^\n]*/g) || [];
  assert.deepEqual(adds, ['.add(source, Object.assign({ private: true }, opts))'], 'the one client.add call sets private: true');
  assert.equal((src.match(/\bclient\.add\(/g) || []).length, 1, 'TorrentManager._add is the only place that adds a torrent');
  assert.equal(/\bclient\.seed\(|\.seed\(/.test(src), false, 'the loader never seeds through WebTorrent.seed (it builds torrents itself)');
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const text = code(readFileSync(file, 'utf8'));
    assert.equal(/\bprivate\s*:\s*(?:false|0|null|undefined)\b/.test(text), false, relative(ROOT, file) + ' turns private off for a torrent');
  }
  // The other add paths name private: true themselves as well (site and file swarms).
  assert.ok(/const opts = \{ announce: this\._announceFor\(ctx\.record\), private: true,/.test(src), 'the site swarm');
  assert.ok(/const opts = \{ announce: h\.announce\.slice\(\), private: true,/.test(src), 'the file swarm');
});

// The third-party hosts in the bundle as it is pinned in build.lock.json (webtorrent 3.0.21). The STUN pair is simple-peer's
// default config; the tracker list is create-torrent's default announce list. tracker.btorrent.xyz is matched as a host
// ("tracker.btorrent"), never as "btorrent", which is also a part of "webtorrent".
const EXPECTED = Object.freeze({
  ice: ['stun:global.stun.twilio.com:3478', 'stun:stun.l.google.com:19302'],
  trackers: [
    'udp://explodie.org:6969', 'udp://tracker.coppersurfer.tk:6969', 'udp://tracker.empire-js.us:1337', 'udp://tracker.leechers-paradise.org:6969',
    'udp://tracker.opentrackr.org:1337', 'wss://tracker.btorrent.xyz', 'wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev',
  ],
  // example.com is a URL base for path parsing and webtorrent.io is in the user-agent text: neither is ever contacted.
  httpHosts: ['example.com', 'webtorrent.io'],
});

function inventory(text) {
  const uniq = (xs) => Array.from(new Set(xs)).sort();
  const strip = (s) => s.slice(1, -1);
  return {
    ice: uniq((text.match(/["'`](?:stuns?|turns?):[^"'`\s]+["'`]/g) || []).map(strip)),
    trackers: uniq((text.match(/["'`](?:udp|wss?):\/\/[^"'`\s]+["'`]/g) || []).map(strip)),
    httpHosts: uniq((text.match(/https?:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map((u) => u.replace(/^https?:\/\//, '').toLowerCase())),
  };
}

test('IND-11: the vendored bundle carries exactly the reviewed third-party defaults (a vendor update that changes them fails here)', (t) => {
  const files = ['dist/_mw/webtorrent.min.js', 'node_modules/webtorrent/dist/webtorrent.min.js'].filter((p) => existsSync(join(ROOT, p)));
  if (!files.length) {
    t.skip('neither dist/_mw/webtorrent.min.js nor node_modules/webtorrent is present (run npm ci and npm run build)');
    return;
  }
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    assert.deepEqual(inventory(text), EXPECTED, rel + ': the third-party defaults changed; review them (who gets the visitors\' IP addresses if an option is lost), then update EXPECTED here');
    assert.ok(text.includes('tracker.btorrent.xyz'), rel + ': the btorrent tracker is matched as a host');
    // The options that keep these defaults unused must still be there to override them (checked above in torrent.js).
    assert.ok(text.includes('iceServers:[{urls:["stun:stun.l.google.com:19302","stun:global.stun.twilio.com:3478"]}]'), rel + ': simple-peer\'s default config, which an explicit rtcConfig replaces');
  }
});

test('IND-11: the loader\'s own defaults name none of the bundle-only hosts (Google STUN, tracker.btorrent.xyz, the UDP trackers)', async () => {
  const { CONFIG } = await import('../../src/loader/config.js');
  assert.ok(Array.isArray(CONFIG.stun) && CONFIG.stun.length > 0 && Array.isArray(CONFIG.trackers) && CONFIG.trackers.length > 0, 'CONFIG.stun and CONFIG.trackers are the lists checked');
  const configured = JSON.stringify({ stun: CONFIG.stun, trackers: CONFIG.trackers });
  for (const host of ['stun.l.google.com', 'tracker.btorrent.xyz', 'tracker.coppersurfer.tk', 'tracker.leechers-paradise.org', 'explodie.org', 'tracker.empire-js.us']) {
    assert.equal(configured.includes(host), false, 'the loader\'s own defaults name ' + host);
  }
});
