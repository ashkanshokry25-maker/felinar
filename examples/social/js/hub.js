// The adapter between the template and the loader's hub features. The v0.3 SDK (R 2.11.2) has no method for reading another person's
// ledger, so the sdk lane added the hub amendment (src/sdk/sdk.js, src/loader/personal-site.js):
//   mw.hub.follow(pointer | ledgerId) -> { ledger, following, cap }      mw.hub.unfollow(ledgerId) -> { ledger, following, removed }
//   mw.hub.list() -> [{ ledger, owner, since, height, pointer }]         mw.hub.createPage() -> { ledgerId, label, url, pointer }
//   and a { ledger } option on mw.db.get / list / subscribe (read only; every write goes to the ledger of the page's own origin).
// This file is the only place that names those. Three more things are not in the SDK yet; each is marked GAP and listed in
// docs/deviations/examples.md, so the integrator wires them to whatever the SDK finally calls them in one edit:
//   GAP 2  withdrawPage()  "Delete my page": the signed withdrawal pointer    assumed: mw.hub.withdrawPage()
//   GAP 3  ownPointer()    this page's own signed pointer, for invite links   assumed: mw.site.info().pointer, else the top page's fragment
//   GAP 4  requestJoin()   asking a group's moderators to let you in          assumed: mw.mod.requestJoin(group); until then a
//                          join grant sent to the moderators with mw.chat.dm.send (R 2.5.2), which the loader's moderation queue takes
// (GAP 1, createPage, landed as mw.hub.createPage.) Without a method the adapter throws { code: 'NOT_AVAILABLE' } and the view says so;
// nothing is faked.

import { sha256, utf8, b64urlEncode, isLedgerId, hubLabelFor, isLabel, isPub } from './ids.js';

const gap = () => Object.assign(new Error('NOT_AVAILABLE'), { code: 'NOT_AVAILABLE' });
const fn = (obj, name) => (obj && typeof obj[name] === 'function' ? obj[name].bind(obj) : null);

// ---------------------------------------------------------------------------------------------- pointers and links

/** parsePointerText(text) -> { raw, fields, owner, lo, chain, btih, sig } for an MW-PTR/1 tag list ("v=mw1; btih=...; owner=..."), else null. */
export function parsePointerText(text) {
  if (typeof text !== 'string' || text.length > 1200) return null;
  const raw = text.trim();
  if (!/^v=mw1(?:;|$)/i.test(raw)) return null;
  const fields = {};
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const k = part.slice(0, at).trim().toLowerCase(), v = part.slice(at + 1).trim();
    if (k === 'tr' || k === 'ws' || k === 'xs' || k === 'org') (fields[k] = fields[k] || []).push(v); else if (!(k in fields)) fields[k] = v;
  }
  return { raw, fields, owner: fields.owner || '', lo: fields.lo || '', chain: fields.chain || '', btih: (fields.btih || '').toLowerCase(), sig: fields.sig || '' };
}
/** ledgerIdFromPointer(record) -> the ledger id the loader derives (ledgerIdFor): mw1:<27> for a signed record, btih:<40> for a bare one. */
export function ledgerIdFromPointer(record) {
  if (!record) return null;
  if (record.sig && record.owner && record.chain) return 'mw1:' + b64urlEncode(sha256(utf8((record.lo || record.owner) + '|' + record.chain))).slice(0, 27);
  return /^[0-9a-f]{40}$/.test(record.btih) ? 'btih:' + record.btih : null;
}
/**
 * findPointer(text) -> a pointer string from a pasted link, a fragment or the record itself, else ''.
 * Accepts a link of the form <label>.<hub>/#<pointer> (the pointer literal or percent-encoded once) and the bare record.
 */
export function findPointer(text) {
  let s = String(text || '').trim();
  if (!s) return '';
  const hash = s.indexOf('#');
  if (hash !== -1) s = s.slice(hash + 1);
  // A pointer never contains '#': what follows a second one (the genesis of a new page, '#mwgen=...') is not part of it.
  const second = s.indexOf('#');
  if (second !== -1) s = s.slice(0, second);
  // A copied address escapes only the spaces ("v=mw1;%20btih=..."), which still looks like a pointer but names no field:
  // a candidate counts only when its fields parse (v=mw1 and a btih). v0.3 final integration, seen end to end.
  const ok = (x) => { const p = parsePointerText(x); return !!(p && p.btih && p.fields.v); };
  for (let i = 0; i < 3; i++) {
    if (ok(s)) return s.trim();
    try { const d = decodeURIComponent(s); if (d === s) break; s = d; } catch (err) { break; }
  }
  return ok(s) ? s.trim() : '';
}
/** hubHost(location) -> { label, suffix, protocol, port } when the host is <32 base32 label>.<suffix>, else null. */
export function hubHost(loc) {
  const host = String((loc && loc.hostname) || '').toLowerCase();
  const dot = host.indexOf('.');
  if (dot < 1 || !isLabel(host.slice(0, dot))) return null;
  return { label: host.slice(0, dot), suffix: host.slice(dot + 1), protocol: loc.protocol || 'https:', port: loc.port || '' };
}
/** pageOrigin(hub, label) -> the origin of a label on this hub: <protocol>//<label>.<suffix>[:port] */
export function pageOrigin(hub, label) {
  return hub.protocol + '//' + label + '.' + hub.suffix + (hub.port ? ':' + hub.port : '');
}
/** inviteLink({ label, pointer }, loc) -> the link a QR code and a "copy link" carry; the pointer sits in the fragment, which never reaches the host. */
export function inviteLink({ label, pointer }, loc) {
  const hub = hubHost(loc);
  const base = hub ? pageOrigin(hub, label) : (loc && loc.origin) || '';
  return base + '/' + (pointer ? '#' + encodeURIComponent(pointer) : '');
}
/** parseInviteLink(text) -> { label, pointer, ledger } for a pasted link or pointer; the label is always recomputed from the pointer. */
export function parseInviteLink(text) {
  const pointer = findPointer(text);
  const ledger = pointer ? ledgerIdFromPointer(parsePointerText(pointer)) : null;
  if (!ledger) {
    const m = /^(?:[a-z]+:\/\/)?([a-z2-7]{32})\./i.exec(String(text || '').trim());
    return m ? { label: m[1].toLowerCase(), pointer: '', ledger: null } : null;
  }
  return { label: hubLabelFor(ledger), pointer, ledger };
}

// ---------------------------------------------------------------------------------------------- join requests (GAP 4)

/** The longest note a join request carries (the moderation queue keeps 500 characters; the request screen offers this much). */
export const JOIN_NOTE_MAX = 140;
/** joinGrant(pub, note) -> the grant the loader's moderation service queues as a join request (src/loader/mod.js receive). */
export function joinGrant(pub, note) {
  const g = { t: 'join', pub };
  if (typeof note === 'string' && note.trim()) g.note = note.trim().slice(0, JOIN_NOTE_MAX);
  return g;
}
/** joinRecipients({ moderators, owner, me }) -> the moderators and the owner of a group, each once, never the requester (at most 51: R 3.5). */
export function joinRecipients({ moderators, owner, me } = {}) {
  const out = [];
  for (const pub of [owner].concat(Array.isArray(moderators) ? moderators : [])) if (isPub(pub) && pub !== me && out.indexOf(pub) === -1) out.push(pub);
  return out.slice(0, 51);
}

// ---------------------------------------------------------------------------------------------- the adapter

const ledgerOf = (x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.ledger || x.id || x.l || x.siteId || null : null);

export function createHub(mw, win) {
  const hub = mw && mw.hub;
  const db = mw && mw.db;
  const w = win || (typeof window !== 'undefined' ? window : null);
  return {
    /** true when this loader offers mw.hub.follow: without it the template shows only this page's own ledger. */
    available: !!(hub && typeof hub.follow === 'function'),
    /** true when this loader offers "Create my page" (mw.hub.createPage); read when asked, so a method added later counts. */
    get canCreatePage() { return !!fn(hub, 'createPage'); },
    /** true when this loader has mw.mod.requestJoin (GAP 4); otherwise a join request goes out as a direct message (messages must be on). */
    get joinBySdk() { return !!fn(mw && mw.mod, 'requestJoin'); },
    /** true when this loader can withdraw the page's address (GAP 2): "Delete my page" promises the withdrawal only then. */
    get canWithdraw() { return !!fn(hub, 'withdrawPage'); },
    /**
     * follow(target, { private }) -> { ledger }: target is a ledger id or a pointer string; private: true asks the loader not to
     * name the ledger to its neighbours (review round R 5.3, STALK-3). Rejects with the SDK's error (E_LIMIT at the follow cap).
     */
    async follow(target, opts) {
      const f = fn(hub, 'follow');
      if (!f) throw gap();
      const out = opts && opts.private === true ? await f(target, { private: true }) : await f(target);
      const rec = typeof target === 'string' && target.startsWith('v=') ? parsePointerText(target) : null;
      return { ledger: ledgerOf(out) || (isLedgerId(target) ? target : rec ? ledgerIdFromPointer(rec) : null) };
    },
    async unfollow(ledger) {
      const f = fn(hub, 'unfollow');
      if (!f) throw gap();
      await f(ledger);
      return { ledger };
    },
    /** list() -> [{ ledger, ptr? }]: the ledgers this browser syncs. Accepts an array of ids or of objects. */
    async list() {
      const f = fn(hub, 'list');
      if (!f) return [];
      const out = await f();
      const arr = Array.isArray(out) ? out : out && Array.isArray(out.ledgers) ? out.ledgers : [];
      return arr.map((x) => ({ ledger: ledgerOf(x), ptr: x && typeof x === 'object' ? (typeof x.pointer === 'string' ? x.pointer : typeof x.ptr === 'string' ? x.ptr : '') : '' })).filter((x) => isLedgerId(x.ledger));
    },
    /** subscribe(ledger, cb) -> unsubscribe: snapshots of a followed ledger (the { ledger } option of db.subscribe). */
    subscribe(ledger, cb) {
      const f = fn(db, 'subscribe');
      if (!f) throw gap();
      return f(cb, { ledger });
    },
    read(ledger, name, opts) {
      const f = fn(db, 'list');
      if (!f) throw gap();
      return f(name, Object.assign({}, opts, { ledger }));
    },
    /**
     * createPage() -> { ledgerId, label, url, origin, pointer }: "Create my page" (R 3.3), after the identity page's card. url is the new page's address
     * with the pointer and the genesis in its fragment, so the browser must open exactly that url; origin is the part the page remembers as home.
     */
    async createPage() {
      const f = fn(hub, 'createPage');
      if (!f) throw gap();
      const out = (await f()) || {};
      let url = typeof out.url === 'string' ? out.url : typeof out.origin === 'string' ? out.origin + '/' : '';
      let origin = typeof out.origin === 'string' ? out.origin : '';
      try { if (url) origin = new URL(url).origin; } catch (err) { url = ''; origin = typeof out.origin === 'string' ? out.origin : ''; }
      return { ledgerId: out.ledgerId || null, label: out.label || '', url, origin, pointer: typeof out.pointer === 'string' ? out.pointer : '' };
    },
    // GAP 2
    async withdrawPage() {
      const f = fn(hub, 'withdrawPage');
      if (!f) throw gap();
      return f();
    },
    // GAP 3: the pointer of the page on screen.
    async ownPointer() {
      try {
        const info = mw && mw.site && typeof mw.site.info === 'function' ? await mw.site.info() : null;
        const p = info && typeof info.pointer === 'string' ? findPointer(info.pointer) : '';
        if (p) return p;
      } catch (err) { /* fall through to the page's fragment */ }
      try {
        const top = w && w.parent && w.parent !== w ? w.parent : w;
        const p = top && top.location ? findPointer(top.location.hash) : '';
        if (p) return p;
      } catch (err) { /* a cross-origin parent: no access */ }
      return '';
    },
    // GAP 4: mw.mod.requestJoin(group) when the loader offers it. Until then the request travels the way R 2.5.2 describes and the
    // loader's moderation service already takes it: a direct message to each moderator and the owner of the group, sealed to their
    // chat keys by mw.chat.dm.send, carrying the grant { t: 'join', pub, note } (joinGrant). The moderator's loader puts it in
    // mw.mod.queue() and mw.mod.decide(id, 'accept') adds the key to the allow list. That needs the group's moderators and owner and
    // the requester's own key (opts, from the view), and messages; without them it says NOT_AVAILABLE, as before.
    // -> { sent, delivered, states }: delivered is true when a moderator's browser took it now; otherwise it waits in the outbox.
    async requestJoin(group, opts) {
      const f = fn(mw && mw.mod, 'requestJoin');
      if (f) return f(group);
      const dm = mw && mw.chat && mw.chat.dm;
      const o = opts && typeof opts === 'object' ? opts : {};
      const to = joinRecipients(o);
      if (!dm || typeof dm.send !== 'function' || !isPub(o.me) || !to.length) throw gap();
      const states = [];
      let first = null;
      for (const pub of to) {
        try { const r = await mw.chat.dm.send(pub, { grant: joinGrant(o.me, o.note) }); states.push((r && r.state) || 'sent-unknown'); } catch (err) { if (!first) first = err; }
      }
      if (!states.length) throw first || gap();
      return { sent: states.length, delivered: states.indexOf('delivered') !== -1, states };
    },
  };
}
