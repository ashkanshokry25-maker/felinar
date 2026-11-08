// deploy/rtc-worker/front.js: the HTTP front of the rendezvous, the same front as the default export of worker.js (the Worker that
// holds the Durable Object) and the file the Pages route runs (deployed as pages/public/_worker.js, a byte-for-byte copy: README.md,
// "Relay"; a unit test compares the two and drives both fronts with the same requests): /healthz answers "ok", /stats.json?token=
// answers the counts when STATS_TOKEN is set, and a WebSocket upgrade at / goes to the one Durable Object; everything else
// is 404, or 426 for a plain request at /.
//
// Privacy (plan 3.7, D7): the object is handed a fresh request that carries only the headers a WebSocket upgrade needs. This file
// reads no client address, no request.cf, no Origin, Referer or User-Agent header and never walks the headers; a unit test scans
// it for those names. It imports nothing, because a Pages route is one file.
const OBJECT_NAME = 'swarms';
// The only headers the object is handed on an upgrade: what the WebSocket handshake needs and nothing else.
const UPGRADE_HEADERS = ['Upgrade', 'Connection', 'Sec-WebSocket-Key', 'Sec-WebSocket-Version', 'Sec-WebSocket-Protocol', 'Sec-WebSocket-Extensions'];

const text = (body, status = 200, extra = {}) => new Response(body, { status, headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, extra) });

/** pick(headers, names) -> a Headers with those names only, read one by one (never a walk over all of them). */
function pick(headers, names) {
  const out = new Headers();
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const object = () => env.RTC.get(env.RTC.idFromName(OBJECT_NAME));
    if (url.pathname === '/healthz') return text('ok\n');
    if (url.pathname === '/stats.json') {
      if (!env.STATS_TOKEN || url.searchParams.get('token') !== env.STATS_TOKEN) return text('not found\n', 404);
      // a fresh request: the object gets neither the token in the query nor a single header of the caller's
      return object().fetch(new Request(url.origin + '/stats.json'));
    }
    if (url.pathname !== '/') return text('not found\n', 404);
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return text('This is a felinar rendezvous: it answers WebSocket connections from the loader (deploy/rtc-worker/README.md).\n', 426, { Upgrade: 'websocket' });
    }
    return object().fetch(new Request(url.origin + '/', { headers: pick(request.headers, UPGRADE_HEADERS) }));
  },
};
