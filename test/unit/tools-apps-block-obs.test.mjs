// Unit tests for the obs block of /_mw/door.json (usage reports, docs/DEPLOY.md, "Usage reports") in the shape module tools/apps-block.mjs:
// obsBlockProblems, makeObsBlock, obsBlockLine, withObsBlock and withoutObsBlock, how they sit beside the apps block helpers, and how
// they compare with the page's own check (src/loader/doors.js). The publish, door kit, dev server and check-site sides have their own
// files (tools-publish-obs, tools-dev-server-obs, tools-check-door). Nothing here touches the disk or the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UsageError, ToolError } from '../../tools/lib.mjs';
import {
  obsBlockProblems, makeObsBlock, obsBlockLine, withObsBlock, withoutObsBlock, withAppsBlock, withoutAppsBlock, OBS_ENDPOINT_MAX,
} from '../../tools/apps-block.mjs';
import { doorJson } from '../../build.mjs';
import { checkDoorJson } from '../../src/loader/doors.js';
import * as doors from '../../src/loader/doors.js';

const BANNED = /blockchain|serverless|unstoppable|censorship|production-ready|fully decentralized|sub-second|[\u2013\u2014\u2018\u2019\u201c\u201d]/i;

const OBS = { endpoint: 'https://obs.example.org' };
const APPS = { rendezvous: ['wss://rtc.example.org'], stun: ['stun:stun.example.org:3478'], idp: 'https://id.example.org' };

/** The door.json of a loader build as build.mjs writes it: the build's own doorJson, so its bytes are the real format. */
function builtDoor() {
  const files = new Map([
    ['index.html', Buffer.from('<!doctype html><title>Loading site</title>')],
    ['mw-sw.js', Buffer.from('// sw\n')],
    ['_mw/boot.js', Buffer.from('// boot\n')],
    ['_mw/loader.js', Buffer.from('// loader\n')],
    ['_mw/open.html', Buffer.from('<!doctype html><title>Loading site</title><link rel="manifest" href="/_mw/door.webmanifest">')],
  ]);
  return doorJson(files, { version: '0.3.0', buildId: 'abcdef123456' });
}

// ---------------------------------------------------------------------------------------------- the shape of the block


test('obsBlockProblems: endpoint is an exact origin, https: or http: on a loopback host, at most 300 characters; other keys are ignored', () => {
  for (const endpoint of ['https://obs.example.org', 'https://obs.example.org:8443', 'https://obs-1.example.co.uk', 'https://203.0.113.7:8443', 'http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787', 'http://dev.localhost:8787']) {
    assert.deepEqual(obsBlockProblems({ endpoint }), [], endpoint);
  }
  assert.deepEqual(obsBlockProblems(Object.assign({ future: 1 }, OBS)), [], 'a later loader may read more keys');
  for (const notBlock of [null, undefined, 'x', 7, [], [OBS]]) assert.deepEqual(obsBlockProblems(notBlock), ['the obs block is not an object']);
  const bad = (endpoint, re) => {
    const problems = obsBlockProblems({ endpoint });
    assert.equal(problems.length, 1, JSON.stringify(endpoint) + ' -> ' + JSON.stringify(problems));
    assert.match(problems[0], re, JSON.stringify(endpoint));
  };
  assert.deepEqual(obsBlockProblems({}), ['endpoint is not a string']);
  bad(undefined, /^endpoint is not a string$/);
  bad('', /^endpoint is not a string$/);
  bad(7, /^endpoint is not a string$/);
  bad(['https://obs.example.org'], /^endpoint is not a string$/);
  bad('obs.example.org', /not an absolute URL/);
  bad('https://obs.example.org/a b', /white space/);
  bad(' https://obs.example.org', /white space/);
  bad('http://obs.example.org', /http: on a host that is not loopback/);
  bad('http://127.0.0.2:8787', /http: on a host that is not loopback/);
  bad('ftp://obs.example.org', /must be an https: origin/);
  bad('wss://obs.example.org', /must be an https: origin/);
  bad('https://user:pw@obs.example.org', /user name or password/);
  bad('https://obs.example.org#x', /fragment/);
  bad('https://obs.example.org/', /not an exact origin/);
  bad('https://obs.example.org/e', /not an exact origin/);
  bad('https://obs.example.org?x=1', /not an exact origin/);
  bad('https://OBS.example.org', /not an exact origin/);
  bad('HTTPS://obs.example.org', /not an exact origin/);
  bad('https://obs.example.org:443', /not an exact origin/);
  // the limit is the whole text, 300 characters, and no more
  const edge = 'https://' + 'a'.repeat(OBS_ENDPOINT_MAX - 'https://'.length - '.example'.length) + '.example';
  assert.equal(edge.length, OBS_ENDPOINT_MAX);
  assert.deepEqual(obsBlockProblems({ endpoint: edge }), []);
  bad(edge + 'x', /longer than 300 characters/);
});

// The tools must never write a block the page ignores: whatever passes obsBlockProblems must pass the page's own check, the one checkDoorJson
// runs behind the `obs` field of its result (src/loader/doors.js, lane L2 of the usage reports). Where the plan names a rule, both sides are
// compared in both directions. The test skips, and says so, while the page has no such check; it must not skip in the integrated build.
const BUILT_DOOR = JSON.parse(builtDoor().toString('utf8'));
/** What the page makes of a door.json that carries this obs value: true when it accepts the block, false when it ignores it, null when it has no obs check. */
function pageAcceptsObs(value) {
  const result = checkDoorJson(Object.assign({}, BUILT_DOOR, { obs: value }));
  if (!result.ok || !Object.prototype.hasOwnProperty.call(result, 'obs')) return null;
  return result.obs !== null && result.obs !== undefined;
}
const PAGE_HAS_OBS = pageAcceptsObs(OBS) === true;

test('obsBlockProblems against the page\'s own check: the tools write nothing the page would ignore', { skip: PAGE_HAS_OBS ? false : 'src/loader/doors.js has no obs block check yet (lane L2)' }, () => {
  const agreed = [
    [{ endpoint: 'https://obs.example.org' }, true],
    [{ endpoint: 'https://obs.example.org:8443' }, true],
    [{ endpoint: 'http://127.0.0.1:8787' }, true],
    [{ endpoint: 'http://localhost:8787' }, true],
    [{ endpoint: 'http://[::1]:8787' }, true],
    [{ endpoint: 'http://dev.localhost:8787' }, true],
    [Object.assign({ future: 1 }, OBS), true],
    [{ endpoint: 'http://obs.example.org' }, false],
    [{ endpoint: 'http://127.0.0.2:8787' }, false],
    [{ endpoint: 'https://obs.example.org/e' }, false],
    [{ endpoint: 'https://obs.example.org/' }, false],
    [{ endpoint: 'https://obs.example.org:443' }, false],
    [{ endpoint: 'https://OBS.example.org' }, false],
    [{ endpoint: 'https://user:pw@obs.example.org' }, false],
    [{ endpoint: 'https://obs.example.org#x' }, false],
    [{ endpoint: 'ftp://obs.example.org' }, false],
    [{ endpoint: 'obs.example.org' }, false],
    [{ endpoint: ' https://obs.example.org' }, false],
    [{ endpoint: 'https://obs.example.org ' }, false],
    [{ endpoint: 'https://' + 'a'.repeat(OBS_ENDPOINT_MAX) + '.example' }, false],
    [{ endpoint: ['https://obs.example.org'] }, false],
    [{ endpoint: 7 }, false],
    [{}, false],
    ['yes', false],
    [[], false],
  ];
  for (const [block, accepted] of agreed) {
    assert.equal(obsBlockProblems(block).length === 0, accepted, 'tools, for ' + JSON.stringify(block));
    assert.equal(pageAcceptsObs(block), accepted, 'page, for ' + JSON.stringify(block));
  }
  // Wherever the tools say yes the page must say yes (the tools may be stricter, never looser).
  const more = [
    { endpoint: 'HTTPS://obs.example.org' }, { endpoint: 'https://203.0.113.7:8443' }, { endpoint: 'https://obs' }, { endpoint: 'http://[::1]' },
    { endpoint: 'https://' + 'a'.repeat(OBS_ENDPOINT_MAX - 'https://'.length - '.example'.length) + '.example' },
  ];
  for (const [block] of agreed.concat(more.map((b) => [b]))) {
    if (obsBlockProblems(block).length === 0) assert.equal(pageAcceptsObs(block), true, 'the tools accept ' + JSON.stringify(block) + ', so the page must');
  }
});

test('makeObsBlock: one origin, a list holding one, or the same one twice; the single slash a server prints is dropped; refusals are usage errors that name the flag', () => {
  assert.deepEqual(makeObsBlock('https://obs.example.org'), OBS);
  assert.deepEqual(makeObsBlock(['https://obs.example.org']), OBS);
  assert.deepEqual(makeObsBlock(['https://obs.example.org', 'https://obs.example.org/']), OBS);
  assert.deepEqual(makeObsBlock('https://obs.example.org/'), OBS);
  assert.deepEqual(makeObsBlock('http://127.0.0.1:8787/'), { endpoint: 'http://127.0.0.1:8787' });
  assert.deepEqual(makeObsBlock('https://obs.example.org:8443'), { endpoint: 'https://obs.example.org:8443' });
  const throwsUsage = (input, re, options) => assert.throws(() => makeObsBlock(input, options), (err) => err instanceof UsageError && re.test(err.message), JSON.stringify(input));
  throwsUsage(undefined, /^--obs is needed: the origin the usage reports go to, such as https:\/\/obs\.example\.org$/);
  throwsUsage(null, /--obs is needed/);
  throwsUsage('', /--obs is needed/);
  throwsUsage([], /--obs is needed/);
  throwsUsage(['https://a.example', 'https://b.example'], /^--obs takes one origin, got 2: https:\/\/a\.example https:\/\/b\.example$/);
  throwsUsage('http://obs.example.org', /^the obs block is not usable: --obs is http: on a host that is not loopback/);
  throwsUsage('https://obs.example.org/path/', /^the obs block is not usable: --obs is not an exact origin/);
  throwsUsage('https://obs.example.org//', /not an exact origin/);
  throwsUsage('https://user:pw@obs.example.org', /--obs carries a user name or password/);
  throwsUsage('obs.example.org', /--obs is not an absolute URL/);
  throwsUsage('http://obs.example.org', /--reports is http: on a host that is not loopback/, { flag: '--reports' });
});

test('obsBlockLine names the host the way the consent card does: the host name, without a port', () => {
  assert.equal(obsBlockLine(OBS), 'usage reports to obs.example.org');
  assert.equal(obsBlockLine({ endpoint: 'https://obs.example.org:8443' }), 'usage reports to obs.example.org');
  assert.equal(obsBlockLine({ endpoint: 'http://127.0.0.1:8787' }), 'usage reports to 127.0.0.1');
  assert.equal(obsBlockLine({ endpoint: 'http://[::1]:8787' }), 'usage reports to [::1]');
  for (const notBlock of [null, undefined, {}, { endpoint: 7 }, { endpoint: 'not a url' }, 'x']) assert.equal(obsBlockLine(notBlock), 'usage reports to (none)', JSON.stringify(notBlock));
  assert.doesNotMatch(obsBlockLine(OBS), BANNED);
});

test('obsBlockLine names the host the page\'s own obsHostOf names (what the card and the consent record keep)', { skip: typeof doors.obsHostOf === 'function' ? false : 'src/loader/doors.js has no obsHostOf yet (lane L2)' }, () => {
  for (const endpoint of ['https://obs.example.org', 'https://obs.example.org:8443', 'http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787', 'https://203.0.113.7:8443']) {
    assert.equal(obsBlockLine({ endpoint }), 'usage reports to ' + doors.obsHostOf({ endpoint }), endpoint);
  }
});

test('withObsBlock / withoutObsBlock: obs is the last key, nothing else moves, and removing it gives the file it was made from byte for byte', () => {
  const built = builtDoor();
  const withBlock = withObsBlock(built, OBS);
  const parsed = JSON.parse(withBlock.toString('utf8'));
  assert.deepEqual(Object.keys(parsed), ['v', 'kind', 'name', 'version', 'buildId', 'page', 'pageAlias', 'files', 'obs']);
  assert.deepEqual(parsed.obs, OBS);
  const original = JSON.parse(built.toString('utf8'));
  for (const key of Object.keys(original)) assert.deepEqual(parsed[key], original[key], key);
  assert.equal(withBlock.toString('utf8').endsWith('}\n'), true);
  assert.equal(withoutObsBlock(withBlock).equals(built), true, 'the build\'s door.json is what is left');
  // a block already there is replaced, not doubled
  const other = { endpoint: 'https://other-obs.example.org' };
  assert.deepEqual(JSON.parse(withObsBlock(withBlock, other).toString('utf8')).obs, other);
  assert.equal(withoutObsBlock(withObsBlock(withBlock, other)).equals(built), true);
  // nothing to remove: the same bytes in the build's format
  assert.equal(withoutObsBlock(built).equals(built), true);
  // not JSON, or not an object: a tool error that names the file
  assert.throws(() => withObsBlock(Buffer.from('<html>'), OBS), (err) => err instanceof ToolError && /_mw\/door\.json is not JSON/.test(err.message));
  assert.throws(() => withObsBlock(Buffer.from('[1]'), OBS), (err) => err instanceof ToolError && /not a JSON object/.test(err.message));
  assert.throws(() => withoutObsBlock(Buffer.from('null')), ToolError);
});

test('apps and obs in one door.json: apps first, then obs, whichever was set first; each is removed alone and both leave the build\'s file', () => {
  const built = builtDoor();
  const appsFirst = withObsBlock(withAppsBlock(built, APPS), OBS);
  const obsFirst = withAppsBlock(withObsBlock(built, OBS), APPS);
  assert.equal(appsFirst.equals(obsFirst), true, 'the same bytes however the file was made');
  assert.deepEqual(Object.keys(JSON.parse(appsFirst.toString('utf8'))).slice(-2), ['apps', 'obs']);
  assert.equal(withoutObsBlock(appsFirst).equals(withAppsBlock(built, APPS)), true, 'without obs it is the apps file as it was');
  assert.equal(withoutAppsBlock(appsFirst).equals(withObsBlock(built, OBS)), true, 'without apps it is the obs file as it was');
  assert.equal(withoutAppsBlock(withoutObsBlock(appsFirst)).equals(built), true);
  assert.equal(withoutObsBlock(withoutAppsBlock(appsFirst)).equals(built), true);
  // replacing one block keeps the other where it is
  const otherApps = { rendezvous: ['wss://other.example'], stun: [], idp: 'https://other-id.example.org' };
  const replaced = withAppsBlock(appsFirst, otherApps);
  assert.deepEqual(Object.keys(JSON.parse(replaced.toString('utf8'))).slice(-2), ['apps', 'obs']);
  assert.deepEqual(JSON.parse(replaced.toString('utf8')).obs, OBS);
  assert.deepEqual(JSON.parse(replaced.toString('utf8')).apps, otherApps);
  const otherObs = { endpoint: 'https://other-obs.example.org' };
  assert.deepEqual(Object.keys(JSON.parse(withObsBlock(appsFirst, otherObs).toString('utf8'))).slice(-2), ['apps', 'obs']);
});
