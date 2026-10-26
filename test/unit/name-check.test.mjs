// Unit tests for tools/name-check.mjs (SEEDING-AND-ZERO-SETUP-DESIGN 3.2, S2 F2, F3, F6; Rc4): the name a server gets from its IP
// address, and the check that the name answers the server's own address and not the block page. Canned resolvers only: no
// test here asks a real DNS server anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ipName, isIPv4Text, nameCheck, chooseName, describeNameCheck, isBlockPageAddress, systemResolve4, NAME_SERVICES, BLOCK_PAGE_ADDRESSES,
} from '../../tools/name-check.mjs';
import { UsageError, ROOT } from '../../tools/lib.mjs';

const IP = '203.0.113.7';

/** A resolver that answers from a table of name -> answers (an array) or an Error, and records every name it was asked. */
function canned(table) {
  const asked = [];
  const fn = async (name) => {
    asked.push(name);
    const v = table[name];
    if (v instanceof Error) throw v;
    if (v === undefined) throw Object.assign(new Error('queryA ENOTFOUND ' + name), { code: 'ENOTFOUND' });
    return v;
  };
  fn.asked = asked;
  return fn;
}

test('ipName: dashes for dots, nip.io by default, sslip.io on request', () => {
  assert.equal(ipName(IP), '203-0-113-7.nip.io');
  assert.equal(ipName(IP, 'nip.io'), '203-0-113-7.nip.io');
  assert.equal(ipName(IP, 'sslip.io'), '203-0-113-7.sslip.io');
  assert.equal(ipName('10.0.0.255'), '10-0-0-255.nip.io');
  assert.equal(ipName('0.0.0.0'), '0-0-0-0.nip.io');
  assert.deepEqual(NAME_SERVICES, ['nip.io', 'sslip.io'], 'nip.io first: a DNS filter list covers sslip.io and not nip.io (S2 F6)');
});

test('ipName: only an IPv4 address and one of the two services (UsageError otherwise)', () => {
  for (const bad of ['203.0.113', '203.0.113.256', '203.0.113.7.1', '01.2.3.4', '203.0.113.07', '', ' 203.0.113.7', '203.0.113.7 ', '2001:db8::1', 'example.com', '1.2.3.-4', '1e2.0.0.1', null, undefined, 42]) {
    assert.throws(() => ipName(bad), UsageError, JSON.stringify(bad));
    assert.equal(isIPv4Text(bad), false, JSON.stringify(bad));
  }
  assert.throws(() => ipName(IP, 'traefik.me'), (e) => e instanceof UsageError && /nip\.io or sslip\.io/.test(e.message));
  assert.throws(() => ipName(IP, ''), UsageError);
  assert.equal(isIPv4Text('255.255.255.255'), true);
});

test('isBlockPageAddress: the two block page addresses of S2 F3, in any IPv6 notation, and nothing else', () => {
  assert.deepEqual(BLOCK_PAGE_ADDRESSES, ['64.176.22.9', '2001:19f0:c800:2315::']);
  for (const a of ['64.176.22.9', '2001:19f0:c800:2315::', '2001:19F0:C800:2315::', '2001:19f0:c800:2315:0:0:0:0', '2001:19f0:c800:2315:0000:0000:0000:0000', ' 2001:19f0:c800:2315::  ']) {
    assert.equal(isBlockPageAddress(a), true, a);
  }
  for (const a of ['64.176.22.8', '203.0.113.7', '2001:19f0:c800:2316::', '2001:19f0:c800:2315::1', '2001:19f0:c800::', '', 'not an address', null, undefined, 7, '2001:19f0:c800:2315:::']) {
    assert.equal(isBlockPageAddress(a), false, String(a));
  }
});

test('nameCheck: the name answers the server\'s own address -> ok', async () => {
  const resolve4 = canned({ '203-0-113-7.nip.io': [IP] });
  const r = await nameCheck({ ip: IP, resolve4 });
  assert.deepEqual(r, { name: '203-0-113-7.nip.io', ip: IP, suffix: 'nip.io', got: [IP], ok: true, reason: 'ok' });
  assert.deepEqual(resolve4.asked, ['203-0-113-7.nip.io']);
  const s = await nameCheck({ ip: IP, suffix: 'sslip.io', resolve4: canned({ '203-0-113-7.sslip.io': [IP] }) });
  assert.equal(s.ok, true);
  assert.equal(s.name, '203-0-113-7.sslip.io');
});

test('nameCheck: the block page answer -> blocked (S2 F3), over IPv4 and over IPv6', async () => {
  const v4 = await nameCheck({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': ['64.176.22.9'] }) });
  assert.equal(v4.ok, false);
  assert.equal(v4.reason, 'blocked');
  assert.deepEqual(v4.got, ['64.176.22.9']);
  const v6 = await nameCheck({
    ip: IP, resolve4: canned({}), resolve6: canned({ '203-0-113-7.nip.io': ['2001:19f0:c800:2315::'] }),
  });
  assert.equal(v6.reason, 'blocked', 'an IPv6 block page answer counts, even when the IPv4 lookup finds nothing');
  const both = await nameCheck({
    ip: IP, resolve4: canned({ '203-0-113-7.nip.io': [IP, '64.176.22.9'] }),
  });
  assert.equal(both.reason, 'blocked', 'the block page wins even if the right address is also there');
});

test('nameCheck: another address -> other; no record -> nxdomain; a failing lookup -> error with its message', async () => {
  const other = await nameCheck({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': ['198.51.100.9'] }) });
  assert.equal(other.reason, 'other');
  assert.equal(other.ok, false);
  assert.deepEqual(other.got, ['198.51.100.9']);
  const sink = await nameCheck({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': ['0.0.0.0'] }) });
  assert.equal(sink.reason, 'other', 'a filtering resolver\'s 0.0.0.0 is not the server');
  const none = await nameCheck({ ip: IP, resolve4: canned({}) });
  assert.equal(none.reason, 'nxdomain');
  assert.deepEqual(none.got, []);
  const nodata = await nameCheck({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': Object.assign(new Error('queryA ENODATA'), { code: 'ENODATA' }) }) });
  assert.equal(nodata.reason, 'nxdomain');
  const empty = await nameCheck({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': [] }) });
  assert.equal(empty.reason, 'nxdomain');
  const down = await nameCheck({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': Object.assign(new Error('queryA ETIMEOUT 203-0-113-7.nip.io'), { code: 'ETIMEOUT' }) }) });
  assert.equal(down.reason, 'error');
  assert.equal(down.ok, false);
  assert.match(down.error, /ETIMEOUT/);
});

test('nameCheck: answers are compared as text, sorted and without duplicates; a bad address stops before any lookup', async () => {
  const r = await nameCheck({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': [IP, IP, '198.51.100.9'] }) });
  assert.deepEqual(r.got, ['198.51.100.9', IP]);
  assert.equal(r.ok, true);
  const resolve4 = canned({});
  await assert.rejects(nameCheck({ ip: '203.0.113', resolve4 }), UsageError);
  await assert.rejects(nameCheck({ ip: IP, suffix: 'example.com', resolve4 }), UsageError);
  assert.deepEqual(resolve4.asked, []);
});

test('the default lookup is the system resolver of node:dns (getaddrinfo, never DNS-over-HTTPS), and tests replace it', () => {
  const source = readFileSync(join(ROOT, 'tools', 'name-check.mjs'), 'utf8');
  assert.match(source, /dnsPromises\.lookup\(name, \{ all: true, family: 4 \}\)/);
  assert.match(source, /const lookup4 = resolve4 \|\| systemResolve4;/);
  assert.equal(/\bfetch\(/.test(source), false, 'DNS-over-HTTPS is not used: the check asks the resolver the visitor would use');
});

test('chooseName: nip.io first; the block page falls back to sslip.io; both blocked ends with ok false', async () => {
  const first = await chooseName({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': [IP] }) });
  assert.equal(first.ok, true);
  assert.equal(first.name, '203-0-113-7.nip.io');
  assert.equal(first.suffix, 'nip.io');
  assert.equal(first.checks.length, 1, 'sslip.io is not asked when nip.io works');
  const resolve4 = canned({ '203-0-113-7.nip.io': ['64.176.22.9'], '203-0-113-7.sslip.io': [IP] });
  const fell = await chooseName({ ip: IP, resolve4 });
  assert.equal(fell.ok, true);
  assert.equal(fell.name, '203-0-113-7.sslip.io');
  assert.equal(fell.suffix, 'sslip.io');
  assert.deepEqual(fell.checks.map((c) => c.reason), ['blocked', 'ok']);
  assert.deepEqual(resolve4.asked, ['203-0-113-7.nip.io', '203-0-113-7.sslip.io']);
  const none = await chooseName({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': ['64.176.22.9'], '203-0-113-7.sslip.io': ['64.176.22.9'] }) });
  assert.equal(none.ok, false);
  assert.equal(none.name, null);
  assert.deepEqual(none.checks.map((c) => c.reason), ['blocked', 'blocked']);
  const pinned = await chooseName({ ip: IP, suffixes: ['sslip.io'], resolve4: canned({ '203-0-113-7.sslip.io': ['198.51.100.9'] }) });
  assert.equal(pinned.ok, false);
  assert.equal(pinned.checks.length, 1, 'a pinned service has no fallback');
});

test('describeNameCheck: string Z4 as written for the block page, with and without another service to try', async () => {
  const blocked = await nameCheck({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': ['64.176.22.9'] }) });
  assert.equal(
    describeNameCheck(blocked, { alt: '203-0-113-7.sslip.io' }),
    '203-0-113-7.nip.io points to 64.176.22.9, not to 203.0.113.7. The service blocks names for addresses used in phishing. Try 203-0-113-7.sslip.io, use another server, or use a domain you own.',
  );
  assert.equal(
    describeNameCheck(blocked),
    '203-0-113-7.nip.io points to 64.176.22.9, not to 203.0.113.7. The service blocks names for addresses used in phishing. Use another server, or use a domain you own.',
  );
});

test('describeNameCheck: the other reasons say what was seen and claim no cause the tool cannot know', async () => {
  const other = describeNameCheck(await nameCheck({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': ['198.51.100.9'] }) }), { alt: '203-0-113-7.sslip.io' });
  assert.match(other, /^203-0-113-7\.nip\.io points to 198\.51\.100\.9, not to 203\.0\.113\.7\./);
  assert.doesNotMatch(other, /phishing/, 'only the block page is known to come from the service');
  assert.match(other, /Try 203-0-113-7\.sslip\.io/);
  const none = describeNameCheck(await nameCheck({ ip: IP, resolve4: canned({}) }));
  assert.match(none, /no address record/);
  const down = describeNameCheck(await nameCheck({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': Object.assign(new Error('queryA ETIMEOUT x'), { code: 'ETIMEOUT' }) }) }));
  assert.match(down, /could not be looked up \(queryA ETIMEOUT x\)/);
  const ok = describeNameCheck(await nameCheck({ ip: IP, resolve4: canned({ '203-0-113-7.nip.io': [IP] }) }));
  assert.equal(ok, '203-0-113-7.nip.io points to 203.0.113.7.');
});

test('wording: nothing this file prints uses the words the project does not use, and no en or em dash or curly quote', () => {
  const source = readFileSync(join(ROOT, 'tools', 'name-check.mjs'), 'utf8');
  for (const word of ['blockchain', 'serverless', 'unstoppable', 'censorship-resistant', 'production-ready']) assert.equal(source.toLowerCase().includes(word), false, word);
  assert.equal(/[–—‘’“”]/.test(source), false);
});

test('systemResolve4 asks this computer\'s own resolver and returns plain addresses (localhost never leaves the machine)', async () => {
  const addresses = await systemResolve4('localhost');
  assert.ok(Array.isArray(addresses) && addresses.length >= 1);
  assert.ok(addresses.every((a) => typeof a === 'string' && isIPv4Text(a)), JSON.stringify(addresses));
  assert.ok(addresses.includes('127.0.0.1'));
  // (a name that does not exist is not looked up here: the system resolver may ask a DNS server, and the tests stay on 127.0.0.1)
});
