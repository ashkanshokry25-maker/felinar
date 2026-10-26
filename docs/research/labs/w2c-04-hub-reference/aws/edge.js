// CloudFront Function, event type: viewer-request, JavaScript runtime 2.0 (needed for KeyValueStore).
// Purpose: edge policy for a magnet-web hub "sites domain" (<label>.<SITES_DOMAIN>), aligned with ARCHITECTURE.md v0.2:
//   section 3.2 label = 32 chars of RFC 4648 base32 (hubLabelFor(): base32(sha256(ledgerId)).slice(0,32) | base32(btih)),
//   section 3.1 host layout /index.html /404.html /mw-sw.js /mw-sw-kill.js /build.json and physical loader assets under /_mw/*.
//   1. Only content-address labels resolve (no vanity names -> no brand-impersonating hostnames).
//   2. Denylisted labels get HTTP 451 + Clear-Site-Data: "storage" (evicts an installed Service Worker, IndexedDB, Cache Storage,
//      localStorage of that origin). Applies to EVERY path, including /mw-sw.js, so the browser's own SW update check delivers it.
//   3. /_mw/hub/status is a network-only "is my label still allowed?" ping for returning (offline-first) visitors.
//   4. Navigation fallback to /index.html ONLY for document navigations; every other miss is a REAL 404
//      (a 200 HTML answer for a missing script poisons caches; see ipfs/service-worker-gateway issue #1155).
// Placeholders __SITES_DOMAIN__ / __CONTROL_URL__ are substituted by Terraform (replace()) and by edge.test.mjs.
import cf from 'cloudfront';

var SITES_DOMAIN = '__SITES_DOMAIN__';  // e.g. hub-sites.example
var CONTROL_URL = '__CONTROL_URL__';    // e.g. https://hub.example
var kvs = cf.kvs();

// 32 base32 chars = exactly 160 bits (a SHA-1 infohash or a truncated SHA-256): one canonical spelling, no padding bits to abuse.
var RE_LABEL = /^[a-z2-7]{32}$/;
// Physical files of the shell that must reach the origin as-is (a miss stays a miss). /_mw/* is also matched by its own
// cache behavior without this function; the pattern here is the safety net for hosts that route everything through it.
var RE_PASS = /^\/(?:mw-sw\.js|mw-sw-kill\.js|build\.json|_mw\/.+|robots\.txt|favicon\.ico|\.well-known\/.+)$/;
var SUBRESOURCE_DEST = {
  script: 1, style: 1, image: 1, font: 1, worker: 1, sharedworker: 1, serviceworker: 1, manifest: 1,
  audio: 1, video: 1, track: 1, object: 1, embed: 1, audioworklet: 1, paintworklet: 1, json: 1, text: 1, xslt: 1, report: 1
};

var TOMBSTONE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Unavailable</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem">' +
  '<h1>This site is unavailable</h1><p>The operator of this hub has removed access to this address.</p>' +
  '<p>Policy and appeals: <a href="' + CONTROL_URL + '/policy/takedown">' + CONTROL_URL + '/policy/takedown</a></p></body>';

function reply(status, desc, type, body, extra) {
  var h = {
    'content-type': { value: type },
    'cache-control': { value: 'no-store' },
    'x-content-type-options': { value: 'nosniff' },
    'referrer-policy': { value: 'no-referrer' },
    'strict-transport-security': { value: 'max-age=31536000; includeSubDomains' },
    'x-robots-tag': { value: 'noindex, nofollow' }
  };
  if (extra) { for (var k in extra) { h[k] = { value: extra[k] }; } }
  return { statusCode: status, statusDescription: desc, headers: h, body: { encoding: 'text', data: body } };
}

async function handler(event) {
  var req = event.request;
  var host = (req.headers.host ? req.headers.host.value : '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  var suffix = '.' + SITES_DOMAIN;
  if (host.length <= suffix.length || host.slice(-suffix.length) !== suffix) {
    return reply(421, 'Misdirected Request', 'text/plain; charset=utf-8', 'Unknown host\n');
  }
  var label = host.slice(0, host.length - suffix.length);
  if (!RE_LABEL.test(label)) {
    return reply(404, 'Not Found', 'text/plain; charset=utf-8', 'Not a content address. See ' + CONTROL_URL + '\n');
  }

  // Denylist. Fail OPEN on KVS errors: an unreachable store must not take every site down (same stance as the IPFS SW gateway).
  var blocked = false;
  try { blocked = await kvs.exists(label); } catch (err) { console.log('kvs_error ' + String(err)); }
  if (blocked) {
    return reply(451, 'Unavailable For Legal Reasons', 'text/html; charset=utf-8', TOMBSTONE, {
      'link': '<' + CONTROL_URL + '/policy/takedown>; rel="blocked-by"',
      'clear-site-data': '"storage"'
    });
  }

  var uri = req.uri;
  if (uri === '/_mw/hub/status') {
    return reply(200, 'OK', 'application/json', '{"v":1,"status":"ok"}');
  }
  if (uri.indexOf('/_mw/hub/') === 0) {
    return reply(404, 'Not Found', 'text/plain; charset=utf-8', 'Not found\n');
  }
  if (RE_PASS.test(uri)) { return req; }

  var dest = req.headers['sec-fetch-dest'] ? req.headers['sec-fetch-dest'].value : '';
  if (SUBRESOURCE_DEST[dest] === 1) {
    return reply(404, 'Not Found', 'text/plain; charset=utf-8', 'Not found\n');
  }
  var lastSeg = uri.slice(uri.lastIndexOf('/') + 1);
  var looksLikeDocument = dest === 'document' || lastSeg.indexOf('.') === -1 || /\.html?$/.test(lastSeg);
  if (!looksLikeDocument) {
    return reply(404, 'Not Found', 'text/plain; charset=utf-8', 'Not found\n');
  }
  req.uri = '/index.html';
  return req;
}
