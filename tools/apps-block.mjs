// tools/apps-block.mjs: the `apps` block of /_mw/door.json (ARCHITECTURE 15.21; docs/DEPLOY.md, "Apps at a door").
// A door that offers apps says, in the door.json it serves, where the apps meet and where a visitor signs in:
//
//   "apps": { "rendezvous": ["wss://rtc.example.org"], "stun": ["stun:stun.example.org:3478"], "idp": "https://id.example.org" }
//
// rendezvous  the door's own rendezvous, a tracker or Worker that speaks the pair protocol (wss:, or ws: on a loopback host for development)
// stun        the site's own STUN servers (stun: or stuns:), none when the browsers are on one network
// idp         the identity origin the visitor signs in at (https:, or http: on a loopback host)
//
// One module so that publish (the shell and the kit), the dev server, check-site --door and the demo agree on the shape. It reads and
// writes strings and bytes only: nothing here contacts a host. It is at least as strict as the page: a block that passes here is one the
// door page accepts (checkAppsBlock in src/loader/doors.js; test/unit/tools-publish-apps.test.mjs compares the two), so the tools never
// write a block the page would ignore.

import { isOriginString, isLoopbackDoorHost } from '../src/common/pointer.js';
import { ToolError, UsageError } from './lib.mjs';

/** At most this many entries per list, the page's own limit (it opens its socket to the first rendezvous and keeps the rest as spares). */
export const APPS_RENDEZVOUS_MAX = 8;
export const APPS_STUN_MAX = 8;
/** The longest URL of either list. */
export const APPS_URL_MAX = 300;

// stun: or stuns: with a host name or a bracketed IPv6 address and an optional port; no query (a TURN style ?transport= is not a STUN URL here).
const STUN_RE = /^stuns?:(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::(\d{1,5}))?$/;

/** rendezvousProblem(value) -> text | null: why this is not a rendezvous address a page can open. */
function rendezvousProblem(value) {
  if (typeof value !== 'string' || !value) return 'is not a URL';
  if (value.length > APPS_URL_MAX) return 'is longer than ' + APPS_URL_MAX + ' characters';
  if (/\s/.test(value)) return 'has white space in it';
  let u;
  try {
    u = new URL(value);
  } catch (_) {
    return 'is not an absolute URL';
  }
  if (u.protocol === 'ws:') {
    if (!isLoopbackDoorHost(u.host)) return 'is ws: on a host that is not loopback (an https page cannot open it): use wss:';
  } else if (u.protocol !== 'wss:') {
    return 'must be a wss: URL (ws: only on a loopback host)';
  }
  if (u.username || u.password) return 'carries a user name or password';
  if (u.hash) return 'carries a fragment';
  return null;
}

/**
 * appsBlockProblems(block) -> [text]: why this is not a usable apps block; empty when it is. rendezvous is 1 to 8 URLs, stun 0 to 8, idp an
 * origin. Other keys are ignored (a later loader may read more).
 */
export function appsBlockProblems(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return ['the apps block is not an object'];
  const problems = [];
  const list = (name, max, min, check) => {
    const items = block[name];
    if (!Array.isArray(items)) {
      problems.push(name + ' is not a list');
      return;
    }
    if (items.length < min) problems.push(name + ' is empty: name at least ' + min);
    if (items.length > max) problems.push(name + ' has ' + items.length + ' entries; at most ' + max);
    items.slice(0, max).forEach((item, i) => {
      const why = check(item);
      if (why) problems.push(name + '[' + i + '] ' + why);
    });
  };
  list('rendezvous', APPS_RENDEZVOUS_MAX, 1, rendezvousProblem);
  list('stun', APPS_STUN_MAX, 0, (v) => {
    const m = typeof v === 'string' && v.length <= APPS_URL_MAX ? STUN_RE.exec(v) : null;
    return m && (m[1] === undefined || Number(m[1]) <= 65535) ? null : 'is not a stun: or stuns: URL (a host and an optional port)';
  });
  if (typeof block.idp !== 'string' || !isOriginString(block.idp)) problems.push('idp is not an origin such as https://id.example.org (http only for a loopback host)');
  return problems;
}

const splitList = (list) => {
  const out = [];
  for (const raw of [].concat(list === undefined || list === null ? [] : list)) {
    for (const value of String(raw).split(',').map((v) => v.trim()).filter(Boolean)) if (out.indexOf(value) < 0) out.push(value);
  }
  return out;
};

/**
 * makeAppsBlock({ rendezvous, stun, idp }, { flags }) -> block. The lists may hold comma separated values and repeat; each is made
 * distinct, in the order given. idp may be one origin or a list holding one (the same origin twice counts once); the address a server
 * prints for itself ends in a slash, and that single slash is dropped. Throws a UsageError that names the flags (flags: { rendezvous,
 * stun, idp }, default the --apps-* names) when the block would not be usable.
 */
export function makeAppsBlock({ rendezvous, stun, idp } = {}, { flags = {} } = {}) {
  const names = Object.assign({ rendezvous: '--apps-rendezvous', stun: '--apps-stun', idp: '--apps-idp' }, flags);
  const origins = splitList(idp).map((v) => (/^https?:\/\/[^/?#]+\/$/.test(v) ? v.slice(0, -1) : v)).filter((v, i, all) => all.indexOf(v) === i);
  if (origins.length > 1) throw new UsageError(names.idp + ' takes one origin, got ' + origins.length + ': ' + origins.join(' '));
  const block = { rendezvous: splitList(rendezvous), stun: splitList(stun), idp: origins.length ? origins[0] : null };
  if (!block.rendezvous.length) throw new UsageError(names.rendezvous + ' is needed: the apps meet at the door\'s own rendezvous (a tracker or Worker with the pair protocol)');
  if (block.idp === null) throw new UsageError(names.idp + ' is needed: a visitor signs in at the identity origin before any app opens');
  const problems = appsBlockProblems(block).map((p) => p.replace(/^rendezvous/, names.rendezvous).replace(/^stun/, names.stun).replace(/^idp/, names.idp));
  if (problems.length) throw new UsageError('the apps block is not usable: ' + problems.join('; '));
  return block;
}

/** appsBlockLine(block) -> 'rendezvous 1, stun 1, identity https://id.example.org': the words check-site --door and the tools print. */
export function appsBlockLine(block) {
  const n = (v) => (Array.isArray(v) ? v.length : 0);
  return 'rendezvous ' + n(block && block.rendezvous) + ', stun ' + n(block && block.stun) + ', identity ' + (block && typeof block.idp === 'string' ? block.idp : '(none)');
}

function parseDoorJson(bytes) {
  let json;
  try {
    json = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (err) {
    throw new ToolError('_mw/door.json is not JSON: ' + err.message);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new ToolError('_mw/door.json is not a JSON object');
  return json;
}

/**
 * withAppsBlock(doorJsonBytes, block) -> Buffer: the door list with its apps block set (replacing one that is there), written the way
 * build.mjs writes door.json (two spaces, a newline at the end) with `apps` as the last key. Every other key keeps its place and value, so
 * withoutAppsBlock of the result is the build's own door.json again, byte for byte.
 */
export function withAppsBlock(bytes, block) {
  const json = parseDoorJson(bytes);
  delete json.apps;
  json.apps = block;
  return Buffer.from(JSON.stringify(json, null, 2) + '\n');
}

/** withoutAppsBlock(doorJsonBytes) -> Buffer: the door list without `apps`, in the build's own format (what a signed release list names). */
export function withoutAppsBlock(bytes) {
  const json = parseDoorJson(bytes);
  delete json.apps;
  return Buffer.from(JSON.stringify(json, null, 2) + '\n');
}
