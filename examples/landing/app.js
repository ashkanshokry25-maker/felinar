// examples/landing/app.js: the live "How this page reached you" box on the felinar homepage.
//
// Progressive enhancement: the page is complete without this script. When the page runs under
// felinar (shell or drop-in mode), the SDK at /_mw/sdk.js reports where the files came from
// (site.info().source), the live number of peer connections (net.peers() and the 'peers' event),
// the bytes by source (the 'progress' event) and the visitor's sharing choice (consent.state()).
// Opened any other way (a plain static server, a crawler, the static /_mw/sdk.js stub), the box says
// so and stops. This script never writes to the site ledger, stores nothing and fetches nothing but
// /_mw/sdk.js from this origin.

const el = (id) => document.getElementById(id);

// Where the files came from, per mode. In drop-in mode the HTML of every page comes from the host;
// the copy (styles, scripts, images) is what peers, the host's web seed or this device provide.
const SOURCE_TEXT = {
  shell: {
    peers: "This page reached you from other visitors' browsers. Your browser checked every piece against the site's infohash before using it.",
    mixed: "This page reached you from other visitors and from the host's web seed, checked piece by piece against the site's infohash.",
    webseed: "This page came from the host's web seed. That's normal for a page this small: the host finishes before a peer connection is ready. Peers matter for large files, for shared data and while the host is down.",
    cache: 'This page loaded from the verified copy on this device.',
    none: 'This page reached you through felinar.',
  },
  dropin: {
    peers: "This page's HTML came from the host, and the rest of the site's files from other visitors, checked against the site's infohash.",
    mixed: "This page's HTML came from the host, and the rest of the site's files from other visitors and the host, checked against the site's infohash.",
    webseed: "This page came from the host, and so did your browser's verified copy of the site. That's normal for a site this small: the host finishes before a peer connection is ready.",
    cache: "This page's HTML came from the host, and its other files from the verified copy on this device.",
    none: 'This page came from the host, like any web page. Your browser can keep a verified copy of the site, and later pages load their files from it.',
  },
};
const PLAIN_TEXT = "You're reading a plain copy: these files came straight from a web server, without felinar. Delivered through felinar, this box shows where the page came from and how many peers are connected.";
const OFF_TEXT = "felinar's script is on this page but isn't delivering it here, so the page came from the host as usual.";
const CONSENT_TEXT = {
  pending: 'Peer-to-peer is off until you choose on the card. Until then the page loads from its host.',
  'host-only': 'You chose to load from the host only, so there are no peer connections. You can change that in Settings.',
  accepted: "You chose to share. While this page is open, your browser may pass this site's files on to other visitors, and they and the connection servers can see your IP address.",
};
const MODE_TEXT = {
  shell: 'Shell mode: the page runs in a same-URL frame, served from the verified copy.',
  dropin: 'Drop-in mode: the page comes from the host, plus one script tag.',
};
const CONSENT_POLL_MS = 3000;
const CONSENT_POLL_MAX = 200; // stop looking after about 10 minutes

function setText(id, text) {
  const node = el(id);
  if (node && node.textContent !== text) node.textContent = text;
}

function show(id, on) {
  const node = el(id);
  if (node) node.hidden = !on;
}

function formatBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return Math.round(v) + ' B';
  const units = ['KiB', 'MiB', 'GiB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return (x < 10 ? x.toFixed(1) : String(Math.round(x))) + ' ' + units[i];
}

function setState(state) {
  const box = el('reach');
  if (box) box.dataset.state = state;
}

function setPeers(n) {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  setText('reach-peers', String(count));
  setText('reach-peers-label', count === 1 ? 'peer connected now' : 'peers connected now');
}

async function loadSdk() {
  try {
    const mod = await import('/_mw/sdk.js');
    const mw = (mod && mod.default) || null;
    return mw && typeof mw.ready === 'function' && mw.site && typeof mw.site.info === 'function' ? mw : null;
  } catch (_) {
    return null; // no /_mw/sdk.js here (a plain static server, a file opened directly)
  }
}

function showOnly(state, text) {
  setState(state);
  show('reach-stat', false);
  setText('reach-source', text);
}

function listen(mw, event, fn) {
  try {
    mw.net.on(event, fn);
  } catch (_) { /* an SDK that doesn't know this event */ }
}

async function consentState(mw) {
  try {
    return await mw.consent.state();
  } catch (_) {
    return null;
  }
}

function running(mw, info) {
  const texts = SOURCE_TEXT[info.mode] || SOURCE_TEXT.shell;
  setState('running');
  show('reach-stat', true);
  setText('reach-mode', MODE_TEXT[info.mode] || '');

  let source = info.source || null;
  let consent = null;
  let refreshing = false;
  let downloaded = 0; // bytes this page view downloaded, from peers and from the host
  let progressSeen = false;

  const render = () => {
    setText('reach-source', texts[source] || texts.none);
    setText('reach-note', (consent && CONSENT_TEXT[consent]) || '');
    show('reach-share', consent === 'pending');
    // A view served from this device downloaded nothing: no point in two rows of zeros.
    const fetched = downloaded > 0;
    // Uploads happen only after the visitor chose to share, so that row appears only then.
    const shared = progressSeen && consent === 'accepted';
    show('reach-download-peers', fetched);
    show('reach-download-host', fetched);
    show('reach-uploaded-row', shared);
    show('reach-bytes', fetched || shared);
  };

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const [next, state] = await Promise.all([mw.site.info().catch(() => null), consentState(mw)]);
      if (next && next.source) source = next.source;
      if (state) consent = state;
      render();
    } finally {
      refreshing = false;
    }
  };

  try {
    setPeers(mw.net.peers());
  } catch (_) {
    setPeers(0);
  }
  listen(mw, 'peers', (d) => setPeers(typeof d === 'number' ? d : d && d.count));
  listen(mw, 'progress', (p) => {
    if (!p || typeof p !== 'object') return;
    const host = Number(p.webseedBytes) || 0;
    const peers = p.peerBytes != null ? Number(p.peerBytes) || 0 : Math.max(0, (Number(p.downloaded) || 0) - host);
    progressSeen = true;
    downloaded = peers + host;
    setText('reach-from-peers', formatBytes(peers));
    setText('reach-from-host', formatBytes(host));
    setText('reach-uploaded', formatBytes(p.uploaded));
    if (typeof p.source === 'string' && p.source) source = p.source;
    render();
  });
  listen(mw, 'status', refresh);

  const share = el('reach-share');
  if (share) {
    share.addEventListener('click', async () => {
      // Opens the loader's own consent card; the visitor decides there, never this page.
      try {
        consent = await mw.consent.request();
      } catch (_) { /* the card could not open */ }
      refresh();
    });
  }

  // The choice is made on the loader's card, outside this page: look again while it's undecided.
  let polls = 0;
  const timer = setInterval(() => {
    polls += 1;
    if ((consent && consent !== 'pending') || polls > CONSENT_POLL_MAX) clearInterval(timer);
    else refresh();
  }, CONSENT_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh();
  });
  render();
  refresh();
}

async function main() {
  if (!el('reach')) return;
  const mw = await loadSdk();
  if (!mw || mw.mode === 'static') return showOnly('plain', PLAIN_TEXT);
  let info;
  try {
    info = await mw.site.info();
    if (info && !info.btih && info.mode !== 'static') {
      // Drop-in may still be reading its pointer: wait for the engine, then ask again.
      await mw.ready().catch(() => null);
      info = await mw.site.info();
    }
  } catch (err) {
    if (err && err.code === 'E_NO_HOST') return showOnly('plain', PLAIN_TEXT);
    const code = err && err.code ? ' (' + err.code + ')' : '';
    return showOnly('problem', "felinar is on this page, but it didn't answer" + code + '. The page itself works.');
  }
  if (!info || info.mode === 'static') return showOnly('plain', PLAIN_TEXT);
  if (!info.btih) return showOnly('off', OFF_TEXT);
  running(mw, info);
}

main();
