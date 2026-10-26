import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESOLVERS, resolveTxt, MAX_DOH_BODY_BYTES, shouldSkipDoh, dohOverrideFromMeta, expandTemplate, ttlUntil, magnetTxtName,
  MIN_TTL_SECONDS, MAX_TTL_SECONDS, WILDCARD_DNS_SUFFIXES, isWildcardDnsName, NO_TXT_SUFFIXES, isNoTxtPlatformName,
} from '../../src/loader/doh.js';

const NAME = '_magnet.example.com';
const POINTER = 'v=mw1; btih=0123456789abcdef0123456789abcdef01234567; dn=x';
const Q = String.fromCharCode(0x22);

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

// fake fetch: handlers in call order; each is (url, init) → response | Promise | throws
function fakeFetch(...handlers) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const h = handlers[calls.length - 1];
    if (!h) throw new Error('unexpected fetch ' + url);
    return h(url, init);
  };
  fn.calls = calls;
  return fn;
}

const cloudflareAnswer = {
  Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false,
  Question: [{ name: NAME, type: 16 }],
  Answer: [{ name: NAME, type: 16, TTL: 300, data: Q + POINTER.slice(0, 20) + Q + ' ' + Q + POINTER.slice(20) + Q }],
};

test('RESOLVERS: Cloudflare, dns.sb, Google in that order with the exact request shapes', () => {
  assert.deepEqual(RESOLVERS.map((r) => r.name), ['cloudflare', 'dns.sb', 'google']);
  assert.equal(RESOLVERS[0].url(NAME, 'TXT'), 'https://cloudflare-dns.com/dns-query?name=_magnet.example.com&type=TXT');
  assert.equal(RESOLVERS[1].url(NAME, 'TXT'), 'https://doh.dns.sb/dns-query?name=_magnet.example.com&type=TXT');
  assert.equal(RESOLVERS[2].url(NAME, 'TXT'), 'https://dns.google/resolve?name=_magnet.example.com&type=TXT&edns_client_subnet=0.0.0.0/0');
  assert.deepEqual(RESOLVERS[0].headers, { accept: 'application/dns-json' });
  assert.deepEqual(RESOLVERS[1].headers, { accept: 'application/dns-json' });
  assert.deepEqual(RESOLVERS[2].headers, {});
});

test('resolveTxt: the first resolver answers (Cloudflare quoted multi-string); simple CORS GET only', async () => {
  const f = fakeFetch(() => response(200, cloudflareAnswer));
  const res = await resolveTxt(NAME, { fetch: f });
  assert.deepEqual(res, { resolver: 'cloudflare', strings: [POINTER], ad: false, adWording: null, ttl: 300, status: 0 });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, RESOLVERS[0].url(NAME, 'TXT'));
  assert.equal(init.method, 'GET');
  assert.deepEqual(init.headers, { accept: 'application/dns-json' });
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.cache, 'no-store');
  assert.ok(init.signal && typeof init.signal.aborted === 'boolean');
  assert.equal(init.body, undefined);
});

test('resolveTxt: the first fails (HTTP 500, not JSON), the second answers', async () => {
  const f = fakeFetch(
    () => response(500, '<html>oops</html>'),
    () => response(200, { Status: 0, AD: true, Answer: [{ name: NAME + '.', type: 16, TTL: 120, data: POINTER }] }),
  );
  const res = await resolveTxt(NAME, { fetch: f });
  assert.equal(res.resolver, 'dns.sb');
  assert.deepEqual(res.strings, [POINTER], 'unquoted data is used as-is');
  assert.equal(res.ad, true);
  assert.equal(res.ttl, 120);
  assert.equal(f.calls.length, 2);
});

test('resolveTxt: network error, then SERVFAIL as HTTP 503, then Google with the ECS opt-out', async () => {
  const f = fakeFetch(
    () => { throw new TypeError('Failed to fetch'); },
    () => response(503, { Status: 2, Comment: null }),
    () => response(200, { Status: 0, AD: false, Answer: [{ name: NAME + '.', type: 16, TTL: 60, data: POINTER }], edns_client_subnet: '0.0.0.0/0' }),
  );
  const res = await resolveTxt(NAME, { fetch: f });
  assert.equal(res.resolver, 'google');
  assert.equal(res.ttl, 60);
  assert.ok(f.calls[2].url.includes('edns_client_subnet=0.0.0.0/0'));
  assert.deepEqual(f.calls[2].init.headers, {});
});

test('resolveTxt: all fail → E_DOH with one error per resolver', async () => {
  const f = fakeFetch(
    () => response(400, { error: 'bad request' }),
    () => response(503, { Status: 2 }),
    () => response(200, { Status: 5 }),
  );
  await assert.rejects(resolveTxt(NAME, { fetch: f }), (err) => {
    assert.equal(err.code, 'E_DOH');
    assert.deepEqual(err.errors.map((e) => e.resolver), ['cloudflare', 'dns.sb', 'google']);
    assert.match(err.errors[0].error, /no DNS status/);
    assert.match(err.errors[1].error, /DNS status 2 \(HTTP 503\)/);
    assert.match(err.errors[2].error, /DNS status 5/);
    return true;
  });
});

test('resolveTxt: a resolver that hangs times out and the next one answers', async () => {
  let firstSignal = null;
  const f = fakeFetch(
    (url, init) => {
      firstSignal = init.signal;
      return new Promise(() => {}); // ignores the abort signal on purpose
    },
    () => response(200, cloudflareAnswer),
  );
  const t0 = Date.now();
  const res = await resolveTxt(NAME, { fetch: f, timeoutMs: 50 });
  assert.equal(res.resolver, 'dns.sb');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(firstSignal.aborted, true, 'the hanging request is aborted');
});

test('resolveTxt: a slow body also times out', async () => {
  const f = fakeFetch(
    () => ({ status: 200, text: () => new Promise(() => {}) }),
    () => ({ status: 200, text: () => new Promise(() => {}) }),
    () => ({ status: 200, text: () => new Promise(() => {}) }),
  );
  await assert.rejects(resolveTxt(NAME, { fetch: f, timeoutMs: 30 }), (err) => {
    assert.equal(err.code, 'E_DOH');
    assert.ok(err.errors.every((e) => /timeout after 30 ms/.test(e.error)));
    return true;
  });
});

test('resolveTxt: several TXT records, CNAME chains, AD flag, minimum TTL', async () => {
  const f = fakeFetch(() => response(200, {
    Status: 0, AD: true,
    Answer: [
      { name: NAME, type: 5, TTL: 30, data: 'target.example.net.' },
      { name: 'target.example.net', type: 16, TTL: 900, data: Q + 'a' + Q + ' ' + Q + 'b' + Q },
      { name: 'target.example.net', type: 16, TTL: 600, data: Q + 'second' + Q },
      { name: 'target.example.net', type: 46, TTL: 1, data: 'TXT 13 3 ...' },
    ],
  }));
  const res = await resolveTxt(NAME, { fetch: f });
  assert.deepEqual(res.strings, ['ab', 'second']);
  assert.equal(res.ad, true);
  assert.equal(res.ttl, 600, 'TTL of the TXT records only');
});

test('resolveTxt: NXDOMAIN and NODATA are answers (no record), with the negative TTL', async () => {
  const soa = { name: 'example.com', type: 6, TTL: 1800, data: 'ns1.example.com. hostmaster.example.com. 2026101701 7200 3600 1209600 300' };
  const nx = fakeFetch(() => response(200, { Status: 3, Authority: [soa] }));
  const r1 = await resolveTxt(NAME, { fetch: nx });
  assert.deepEqual(r1, { resolver: 'cloudflare', strings: [], ad: false, adWording: null, ttl: 300, status: 3 });
  // Review round R 5.3 (PTR-4, PTR-12): an empty answer asks the next resolver; the first empty one is the result when
  // no resolver holds a record.
  assert.equal(nx.calls.length, RESOLVERS.length, 'an empty answer tries the next resolver');
  const nodata = fakeFetch(() => response(200, { Status: 0, Authority: [soa] }));
  const r2 = await resolveTxt(NAME, { fetch: nodata });
  assert.deepEqual(r2.strings, []);
  assert.equal(r2.status, 0);
  assert.equal(r2.ttl, 300);
  const dangling = fakeFetch(() => response(200, { Status: 0, Answer: [{ name: NAME, type: 5, TTL: 60, data: 'gone.example.' }] }));
  assert.deepEqual((await resolveTxt(NAME, { fetch: dangling })).strings, [], 'a CNAME without TXT is no record');
});

test('resolveTxt: override template replaces the default resolvers', async () => {
  const f = fakeFetch(() => response(200, cloudflareAnswer));
  const res = await resolveTxt(NAME, { fetch: f, override: 'https://doh.example.org/resolve?name={name}&type={type}' });
  assert.equal(res.resolver, 'override');
  assert.equal(f.calls[0].url, 'https://doh.example.org/resolve?name=_magnet.example.com&type=TXT');
  assert.deepEqual(f.calls[0].init.headers, { accept: 'application/dns-json' });
  const failing = fakeFetch(() => response(500, 'x'));
  await assert.rejects(resolveTxt(NAME, { fetch: failing, override: 'https://doh.example.org/dns-query' }), (err) => {
    assert.equal(err.errors.length, 1, 'no fallback to public resolvers when the operator overrides');
    return true;
  });
  assert.equal(failing.calls[0].url, 'https://doh.example.org/dns-query?name=_magnet.example.com&type=TXT');
});

test('resolveTxt: invalid names and an aborted signal never reach the network', async () => {
  const f = fakeFetch();
  for (const bad of ['', 'a..b', 'x'.repeat(64) + '.example', ('abcdefghi.').repeat(26) + 'com', null]) {
    await assert.rejects(resolveTxt(bad, { fetch: f }), (err) => err.code === 'E_DOH');
  }
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(resolveTxt(NAME, { fetch: f, signal: ac.signal }), (err) => err.code === 'E_DOH' && err.errors[0].error === 'aborted');
  assert.equal(f.calls.length, 0);
});

test('resolveTxt: aborting during a lookup stops it', async () => {
  const ac = new AbortController();
  const f = fakeFetch(() => new Promise(() => {}));
  const p = resolveTxt(NAME, { fetch: f, signal: ac.signal, timeoutMs: 10000 });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(p, (err) => err.code === 'E_DOH' && /aborted/.test(err.errors[0].error));
  assert.equal(f.calls.length, 1);
});

test('shouldSkipDoh: localhost, IP literals, single labels, special-use names', () => {
  for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '10.0.0.8', '[::1]', '::1', 'fe80::1',
    'intranet', 'printer.local', 'site.test', 'x.onion', 'a.invalid', 'b.example', 'nas.home.arpa', 'svc.internal',
    'box.lan', '', '.', null, '0x7f.1']) {
    assert.equal(shouldSkipDoh(h), true, String(h));
  }
  for (const h of ['example.com', 'www.example.co.uk', 'xn--bcher-kva.example.com', 'example.com.', 'my-site.dev', '1password.com']) {
    assert.equal(shouldSkipDoh(h), false, h);
  }
});

// v0.3 C2 (SEEDING-AND-ZERO-SETUP-DESIGN 3.2, S2 F2): nip.io and sslip.io names are the address of a server and nothing more; no
// _magnet TXT record can exist under them (NOERROR with no data, measured), so a lookup only leaks the name.
test('shouldSkipDoh: nip.io and sslip.io names are never looked up (dashed, dotted, prefixed, upper case, trailing dot)', () => {
  assert.deepEqual(WILDCARD_DNS_SUFFIXES, ['nip.io', 'sslip.io']);
  for (const h of [
    'nip.io', 'sslip.io', '203-0-113-7.nip.io', '203.0.113.7.nip.io', 'app.203-0-113-7.nip.io', 'a.b.c.203-0-113-7.sslip.io',
    '203-0-113-7.SSLIP.IO', '203-0-113-7.Nip.Io', '203-0-113-7.nip.io.', ' 203-0-113-7.nip.io ', 'NIP.IO', '192-168-1-20.nip.io', 'fe80--1.sslip.io',
  ]) {
    assert.equal(isWildcardDnsName(h), true, h);
    assert.equal(shouldSkipDoh(h), true, h);
  }
});

test('shouldSkipDoh: a name that only contains nip.io or sslip.io is an ordinary name and is still looked up', () => {
  for (const h of [
    'nip.io.example.com', 'sslip.io.example.com', '203-0-113-7.nip.io.example.org', 'anip.io', 'my-nip.io', 'xsslip.io', 'nip.com',
    'nip-io.example.com', 'example.io', 'nipio.com', 'www.example.com',
  ]) {
    assert.equal(isWildcardDnsName(h), false, h);
    assert.equal(shouldSkipDoh(h), false, h);
  }
  for (const bad of [null, undefined, 42, '', '.', '   ']) assert.equal(isWildcardDnsName(bad), false, String(bad));
});

// 0.3.0 independence design (IND-10): names on hosting platforms whose zone lets no user publish a TXT record. A lookup there only
// sends the site's name and the visitor's IP address to Cloudflare, dns.sb and Google; for ts.net it leaks a private machine name.
test('IND-10: shouldSkipDoh is true for each platform suffix and every name under it (any case, trailing dot)', () => {
  const PLATFORMS = ['github.io', 'gitlab.io', 'codeberg.page', 'pages.dev', 'workers.dev', 'netlify.app', 'vercel.app', 'surge.sh', 'trycloudflare.com', 'ts.net'];
  assert.deepEqual(NO_TXT_SUFFIXES, PLATFORMS);
  assert.ok(Object.isFrozen(NO_TXT_SUFFIXES), 'the list is frozen');
  for (const suffix of PLATFORMS) {
    for (const h of [suffix, 'alice.' + suffix, 'a.b.' + suffix, 'Alice.' + suffix.toUpperCase(), 'alice.' + suffix + '.', ' alice.' + suffix + ' ']) {
      assert.equal(isNoTxtPlatformName(h), true, h);
      assert.equal(shouldSkipDoh(h), true, h);
      assert.equal(isWildcardDnsName(h), false, h + ' is not a wildcard-DNS name');
    }
  }
  for (const h of ['my-site.netlify.app', 'feature-x--my-site.netlify.app', 'project.pages.dev', 'abc.trycloudflare.com', 'laptop.tail1234.ts.net']) {
    assert.equal(shouldSkipDoh(h), true, h);
  }
});

test('IND-10: look-alikes, names that only contain a platform suffix, and dedyn.io and duckdns.org are still looked up', () => {
  for (const h of [
    'xgithub.io', 'github.io.example.com', 'alice.github.io.example.com', 'my-netlify.app', 'pages.dev.example.org', 'notts.net',
    'github.com', 'gitlab.com', 'vercel.com', 'surge.sh.example.com', 'dedyn.io', 'alice.dedyn.io', 'duckdns.org', 'alice.duckdns.org', 'www.example.com',
  ]) {
    assert.equal(isNoTxtPlatformName(h), false, h);
    assert.equal(shouldSkipDoh(h), false, h);
  }
  for (const bad of [null, undefined, 42, '', '.', '   ']) assert.equal(isNoTxtPlatformName(bad), false, String(bad));
  // The name-service list of tools/name-check.mjs (an alias of WILDCARD_DNS_SUFFIXES) does not grow with the platform list.
  assert.deepEqual(WILDCARD_DNS_SUFFIXES, ['nip.io', 'sslip.io']);
  for (const suffix of NO_TXT_SUFFIXES) assert.equal(WILDCARD_DNS_SUFFIXES.includes(suffix), false, suffix);
});

test('IND-10: a github.io site keeps its consent recipients (no consent version bump) and its card names no DNS-over-HTTPS service', async () => {
  const { recipientsKey, makeConsentRecord, __test } = await import('../../src/loader/app.js');
  const { CONFIG } = await import('../../src/loader/config.js');
  const BTIH = 'ab'.repeat(20);
  // recipientsKey covers tracker and STUN hosts only (src/loader/consent.js): the site's name is not part of it.
  for (const record of [{ btih: BTIH }, { btih: BTIH, tr: ['wss://tracker.example.org'] }]) {
    const onPlatform = recipientsKey(Object.assign({ scope: 'alice.github.io' }, record), CONFIG);
    const named = recipientsKey(Object.assign({ scope: 'www.example.com' }, record), CONFIG);
    assert.equal(onPlatform, named);
    assert.equal(/github\.io|cloudflare-dns|dns\.sb|dns\.google/.test(onPlatform), false, onPlatform);
    const a = makeConsentRecord({ choice: 'accepted', scope: 'alice.github.io', rcpt: onPlatform, config: CONFIG });
    const b = makeConsentRecord({ choice: 'accepted', scope: 'www.example.com', rcpt: named, config: CONFIG });
    assert.equal(a.v, b.v, 'same consent version');
    assert.equal(a.rcpt, b.rcpt, 'same recipients: a stored choice is not asked again');
  }
  // The consent card's DNS line follows shouldSkipDoh (app.js dnsUpdatesPlanned): no resolver is named for a platform name.
  const fakeA = (dnsHost) => {
    const ui = { cards: [] };
    ui.showConsentCard = (o) => { ui.cards.push(o); return () => {}; };
    ui.showGate = () => () => {};
    ui.setStatus = () => {};
    ui.setBanner = () => {};
    const doc = { querySelector: () => null };
    return { ui, dnsHost, doc, deps: { doh: { shouldSkipDoh, dohOverrideFromMeta } }, record: { btih: BTIH, ws: ['https://' + dnsHost + '/ws/'] }, mode: { mode: 'shell' }, env: {}, consentWaiters: { settle: () => 0 }, config: CONFIG, win: { location: {} } };
  };
  for (const host of ['alice.github.io', 'my-site.netlify.app', 'project.pages.dev', 'laptop.tail1234.ts.net']) {
    const A = fakeA(host);
    __test.showConsentCard(A);
    assert.equal(A.ui.cards[0].dnsUpdate, false, host + ': the card names no resolver');
  }
  const pub = fakeA('www.example.com');
  __test.showConsentCard(pub);
  assert.equal(pub.ui.cards[0].dnsUpdate, true, 'an ordinary name still names the resolvers');
});

test('dohOverrideFromMeta: https templates only (http for localhost)', () => {
  const doc = (content) => ({
    querySelector: (sel) => (sel === 'meta[name="mw-doh"]' && content !== undefined ? { getAttribute: () => content } : null),
  });
  assert.equal(dohOverrideFromMeta(doc(' https://doh.example.org/resolve?name={name}&type={type} ')), 'https://doh.example.org/resolve?name={name}&type={type}');
  assert.equal(dohOverrideFromMeta(doc('http://127.0.0.1:8053/dns-query')), 'http://127.0.0.1:8053/dns-query');
  assert.equal(dohOverrideFromMeta(doc('http://doh.example.org/dns-query')), null);
  assert.equal(dohOverrideFromMeta(doc('javascript:alert(1)')), null);
  assert.equal(dohOverrideFromMeta(doc('')), null);
  assert.equal(dohOverrideFromMeta(doc(undefined)), null);
  assert.equal(dohOverrideFromMeta({}), null);
  assert.equal(dohOverrideFromMeta(null), null, 'no document in Node');
});

test('expandTemplate, ttlUntil, magnetTxtName', () => {
  assert.equal(expandTemplate('https://d/q?name={name}&type={type}', 'a b', 'TXT'), 'https://d/q?name=a%20b&type=TXT');
  assert.equal(expandTemplate('https://d/q', 'n', 'TXT'), 'https://d/q?name=n&type=TXT');
  assert.equal(expandTemplate('https://d/q?ct=json', 'n', 'TXT'), 'https://d/q?ct=json&name=n&type=TXT');
  assert.equal(expandTemplate('https://d/q?', 'n', 'TXT'), 'https://d/q?name=n&type=TXT');
  const now = 1000000;
  assert.equal(ttlUntil(60, now), now + MIN_TTL_SECONDS * 1000, 'minimum 5 minutes');
  assert.equal(ttlUntil(null, now), now + MIN_TTL_SECONDS * 1000);
  assert.equal(ttlUntil(3600, now), now + 3600 * 1000);
  assert.equal(ttlUntil(10 * 86400, now), now + MAX_TTL_SECONDS * 1000);
  assert.equal(magnetTxtName('Example.COM.'), '_magnet.example.com');
});

// ---- review round R 5.3 (PTR-4, PTR-12, PTR-13) ----

test('resolveTxt (PTR-4, PTR-12): resolver 1 empty or NXDOMAIN, resolver 2 holds the record: the record is found', async () => {
  const f = fakeFetch(() => response(200, { Status: 3 }), () => response(200, cloudflareAnswer));
  const res = await resolveTxt(NAME, { fetch: f });
  assert.equal(res.resolver, 'dns.sb');
  assert.deepEqual(res.strings, [POINTER]);
  assert.equal(f.calls.length, 2);
});

test('resolveTxt (PTR-4): accept() refuses an old record at resolver 1; resolver 2 has the new one and wins', async () => {
  const OLD = 'v=mw1; btih=0123456789abcdef0123456789abcdef01234567; seq=100';
  const NEW = 'v=mw1; btih=89abcdef0123456789abcdef0123456789abcdef; seq=300';
  const ans = (t) => ({ Status: 0, Answer: [{ name: NAME, type: 16, TTL: 300, data: Q + t + Q }] });
  const f = fakeFetch(() => response(200, ans(OLD)), () => response(200, ans(NEW)));
  const res = await resolveTxt(NAME, { fetch: f, accept: async (r) => !r.strings.some((t) => t.includes('seq=100')) });
  assert.deepEqual(res.strings, [NEW]);
  // Nobody accepted: the first non-empty answer is still returned (the caller's own checks refuse it).
  const g = fakeFetch(() => response(200, ans(OLD)), () => response(200, { Status: 3 }), () => response(200, ans(OLD)));
  const res2 = await resolveTxt(NAME, { fetch: g, accept: () => false });
  assert.deepEqual(res2.strings, [OLD]);
  assert.equal(res2.resolver, 'cloudflare');
});

test('resolveTxt (PTR-13): a DoH body larger than MAX_DOH_BODY_BYTES is refused (Content-Length and streamed)', async () => {
  assert.equal(MAX_DOH_BODY_BYTES, 65536);
  const big = 'x'.repeat(MAX_DOH_BODY_BYTES + 1);
  const byLength = () => ({ status: 200, ok: true, headers: { get: (h) => (h === 'content-length' ? String(big.length) : null) }, text: async () => { throw new Error('must not read') } });
  const enc = new TextEncoder().encode(big);
  const streamed = () => ({ status: 200, ok: true, headers: { get: () => null }, body: new ReadableStream({ start (c) { c.enqueue(enc.slice(0, 40000)); c.enqueue(enc.slice(40000)); c.close() } }) });
  const plain = () => response(200, big);
  for (const h of [byLength, streamed, plain]) {
    const f = fakeFetch(h, h, h);
    await assert.rejects(resolveTxt(NAME, { fetch: f }), (err) => {
      assert.equal(err.code, 'E_DOH');
      assert.match(err.errors[0].error, /larger than 65536 bytes/);
      return true;
    });
  }
  // A normal streamed body still reads.
  const okBody = new TextEncoder().encode(JSON.stringify(cloudflareAnswer));
  const okStream = () => ({ status: 200, ok: true, headers: { get: () => null }, body: new ReadableStream({ start (c) { c.enqueue(okBody); c.close() } }) });
  assert.deepEqual((await resolveTxt(NAME, { fetch: fakeFetch(okStream) })).strings, [POINTER]);
});
