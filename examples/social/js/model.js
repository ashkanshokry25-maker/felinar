// The pure logic of the social template (R 3.5; unit test U-SO-1 in test/example/social-model.test.mjs): turning ledger
// snapshots into walls and a merged timeline, edit history, threads and the mw.ok acceptance batches, reaction counts that
// hold one reaction per member per target, wall acceptance, follow caps, mentions and the composer's validation.
// No DOM, no SDK, no clock: every function takes plain data and returns plain data. Items are the SDK's
// { h, author, ts, v } records (snapshot.lists[name], oldest first); ts is minutes-rounded and claimed by the author,
// so it orders the timeline together with h and is never shown as a fact.

import { LISTS, KEYS, LIMITS, REACTIONS, WALL_MODES, DEFAULT_WALL, FOLLOW_CAPS } from './config.js';
import { isLedgerId, isHash, isPub, shortIdOf, jsonBytes, SCOPE_KEY } from './ids.js';

const has = Object.prototype.hasOwnProperty;
export const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isStr = (x) => typeof x === 'string';
const list = (x) => (Array.isArray(x) ? x : []);

export function isHttpsUrl(text) {
  if (!isStr(text) || text.length > 500) return false;
  try { const u = new URL(text); return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password; } catch (err) { return false; }
}
export const normTs = (ts) => (Number.isFinite(Number(ts)) && Math.abs(Number(ts)) < 8.64e15 ? Math.max(0, Math.floor(Number(ts))) : 0);

// ---------------------------------------------------------------------------------------------- refs and order

/** A ref names one block: { l: ledger id, h: block hash }. */
export const makeRef = (l, h) => ({ l, h });
export const isRef = (x) => isObj(x) && isLedgerId(x.l) && isHash(x.h);
export const refKey = (ref) => ref.l + '/' + ref.h;
export const sameRef = (a, b) => isRef(a) && isRef(b) && a.l === b.l && a.h === b.h;

/** sortKey: fixed-width ts then h, so plain string comparison orders by (ts, h). */
export const sortKeyOf = (ts, h) => String(normTs(ts)).padStart(16, '0') + String(h || '');
/** Newest first by (ts, h); equal blocks from different ledgers fall back to the ledger id so the order is total. */
export function compareNewestFirst(a, b) {
  const ka = a.sortKey || sortKeyOf(a.ts, a.h), kb = b.sortKey || sortKeyOf(b.ts, b.h);
  if (ka !== kb) return ka < kb ? 1 : -1;
  return a.l === b.l ? 0 : a.l < b.l ? 1 : -1;
}
export const compareOldestFirst = (a, b) => compareNewestFirst(b, a);

// ---------------------------------------------------------------------------------------------- item schemas
// An item that does not match its schema is hidden (R 2.10.2); the parsers return null for it.

export function parseMedia(m) {
  if (!isObj(m)) return null;
  const ref = m.ref;
  if (!(isStr(ref) ? ref.length > 0 && ref.length <= 160 : isObj(ref) && jsonBytes(ref) <= 240)) return null;
  const kind = m.kind === 'video' ? 'video' : m.kind === 'image' || m.kind === undefined ? 'image' : null;
  if (!kind) return null;
  if (m.alt !== undefined && !(isStr(m.alt) && m.alt.length <= LIMITS.altChars)) return null;
  const out = { ref, kind, alt: m.alt || '' };
  if (isStr(m.mime) && m.mime.length <= 40) out.mime = m.mime;
  if (Number.isFinite(m.len) && m.len >= 0) out.len = Math.floor(m.len);
  return out;
}

export function parsePost(v) {
  if (!isObj(v) || !isStr(v.text) || v.text.length > LIMITS.postChars) return null;
  const media = [];
  if (v.media !== undefined) {
    if (!Array.isArray(v.media) || v.media.length > LIMITS.mediaPerPost) return null;
    for (const m of v.media) { const p = parseMedia(m); if (!p) return null; media.push(p); }
  }
  let link = null;
  if (v.link !== undefined) { if (!isObj(v.link) || !isHttpsUrl(v.link.url)) return null; link = { url: v.link.url }; }
  if (v.to !== undefined && !isLedgerId(v.to)) return null;
  if (v.edit !== undefined && !isHash(v.edit)) return null;
  return { text: v.text, media, link, to: v.to || null, edit: v.edit || null };
}
export function parseComment(v) {
  if (!isObj(v) || !isStr(v.text) || v.text.length > LIMITS.commentChars || !isRef(v.target)) return null;
  if (v.replyTo !== undefined && !isRef(v.replyTo)) return null;
  if (v.edit !== undefined && !isHash(v.edit)) return null;
  return { text: v.text, target: makeRef(v.target.l, v.target.h), replyTo: v.replyTo ? makeRef(v.replyTo.l, v.replyTo.h) : null, edit: v.edit || null };
}
export function parseShare(v) {
  if (!isObj(v) || !isRef(v.target)) return null;
  if (v.text !== undefined && !(isStr(v.text) && v.text.length <= LIMITS.commentChars)) return null;
  return { target: makeRef(v.target.l, v.target.h), text: v.text || '' };
}
export function parseFollow(v) {
  if (!isObj(v) || !isLedgerId(v.l)) return null;
  if (v.ptr !== undefined && !(isStr(v.ptr) && v.ptr.length <= 1200)) return null;
  return { l: v.l, ptr: v.ptr || '' };
}
export function parseOk(v) {
  if (!isObj(v) || !Array.isArray(v.refs) || v.refs.length > LIMITS.okRefs) return null;
  const refs = [];
  for (const r of v.refs) { if (!isRef(r)) return null; refs.push(makeRef(r.l, r.h)); }
  return { refs };
}
export function parseCount(v) {
  if (!isObj(v) || !isRef(v.target) || !Number.isFinite(v.n) || v.n < 0) return null;
  return { target: makeRef(v.target.l, v.target.h), n: Math.floor(v.n), t: normTs(v.t) };
}
export function parseProfile(v) {
  if (!isObj(v)) return null;
  const out = { bio: '', avatar: null, links: [], handle: '', wall: '' };
  if (v.bio !== undefined) { if (!isStr(v.bio) || v.bio.length > LIMITS.bioChars) return null; out.bio = v.bio; }
  if (v.avatar !== undefined && v.avatar !== null) { const a = parseMedia(Object.assign({ kind: 'image' }, isObj(v.avatar) && 'ref' in v.avatar ? v.avatar : { ref: v.avatar })); if (!a) return null; out.avatar = a; }
  if (v.links !== undefined) { if (!Array.isArray(v.links) || v.links.length > LIMITS.profileLinks || !v.links.every(isHttpsUrl)) return null; out.links = v.links.slice(); }
  if (v.handle !== undefined) { if (!isStr(v.handle) || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(v.handle) || v.handle.indexOf('.') === -1) return null; out.handle = v.handle.toLowerCase(); }
  if (WALL_MODES.indexOf(v.wall) !== -1) out.wall = v.wall; // who may write on the wall; see wallMode
  return out;
}

// ---------------------------------------------------------------------------------------------- versions (edit history)

// Group items by what they edit. A post or comment edit is a new block with edit = the hash of the original; earlier
// versions stay unless the author tombstones them (then they are simply absent here). The group id is the original's hash
// even when the original is gone, so a permalink keeps working. An edit by someone other than the original's author is
// not an edit of it and is dropped.
export function groupVersions(items, parse) {
  const byH = new Map();
  for (const it of list(items)) if (isObj(it) && isHash(it.h)) byH.set(it.h, it);
  const groups = new Map();
  for (const it of byH.values()) {
    const value = parse(it.v);
    if (!value) continue;
    let root = it.h, hops = 0;
    for (let cur = value; cur.edit && hops < 8; hops++) {
      const target = byH.get(cur.edit);
      if (target && target.author !== it.author) { root = null; break; }
      root = cur.edit;
      const next = target ? parse(target.v) : null;
      if (!next || !next.edit) break;
      cur = next;
    }
    if (!root) continue;
    const key = it.author + '|' + root;
    if (!groups.has(key)) groups.set(key, { root, author: it.author, versions: [] });
    groups.get(key).versions.push({ h: it.h, ts: normTs(it.ts), value });
  }
  for (const g of groups.values()) g.versions.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.h < b.h ? -1 : 1));
  return Array.from(groups.values());
}

/** editHistory(versions): the earlier versions of a post, newest first, for the History disclosure (the shown one is not listed). */
export function editHistory(versions) {
  const vs = list(versions);
  return vs.slice(0, Math.max(0, vs.length - 1)).reverse().map((v) => ({ h: v.h, ts: v.ts, text: v.value.text, media: v.value.media || [] }));
}

// ---------------------------------------------------------------------------------------------- ledger views

const kvValue = (e) => (isObj(e) && has.call(e, 'v') && has.call(e, 'h') ? e.v : e);
const reactionOf = (v) => {
  const r = isObj(v) ? v.r : v;
  return REACTIONS.indexOf(r) === -1 ? null : r;
};

/**
 * viewFromSnapshot(id, snap, { label }) -> the template's view of one ledger (a personal wall or a group):
 *   posts, comments, shares (each with versions), follows (newest wins per ledger), oks (a Set of ref keys),
 *   counts (author-reported), reactions (own-ledger keys 're/<ledger>/<h>' -> r), scoped (group keys '@scope/re/<h>' -> Map scope -> r),
 *   profile, cfg (wall, ...), owner, policy. Everything is derived from the snapshot alone.
 */
export function viewFromSnapshot(id, snap, opts = {}) {
  const s = isObj(snap) ? snap : {};
  const lists = isObj(s.lists) ? s.lists : {}, kv = isObj(s.kv) ? s.kv : {}, profiles = isObj(s.profiles) ? s.profiles : {};
  const owner = isPub(s.owner) ? s.owner : null;
  const posts = groupVersions(lists[LISTS.post], parsePost).map((g) => {
    const first = g.versions[0], last = g.versions[g.versions.length - 1];
    return {
      type: 'post', key: id + '/' + g.root, l: id, h: g.root, author: g.author, ts: first.ts, sortKey: sortKeyOf(first.ts, g.root),
      latestH: last.h, latestTs: last.ts, edited: g.versions.length > 1 || !!first.value.edit, versions: g.versions,
      text: last.value.text, media: last.value.media, link: last.value.link, to: last.value.to,
    };
  }).sort(compareNewestFirst);
  const comments = groupVersions(lists[LISTS.comment], parseComment).map((g) => {
    const first = g.versions[0], last = g.versions[g.versions.length - 1];
    return {
      type: 'reply', key: id + '/' + g.root, l: id, h: g.root, author: g.author, ts: first.ts, sortKey: sortKeyOf(first.ts, g.root),
      latestH: last.h, edited: g.versions.length > 1 || !!first.value.edit, versions: g.versions,
      text: last.value.text, target: last.value.target, replyTo: last.value.replyTo,
    };
  }).sort(compareNewestFirst);
  const shares = [];
  for (const it of list(lists[LISTS.share])) {
    const v = isObj(it) && isHash(it.h) ? parseShare(it.v) : null;
    if (v) shares.push({ type: 'share', key: id + '/' + it.h, l: id, h: it.h, author: it.author, ts: normTs(it.ts), sortKey: sortKeyOf(it.ts, it.h), target: v.target, text: v.text });
  }
  shares.sort(compareNewestFirst);
  const follows = new Map();
  for (const it of list(lists[LISTS.follow])) {
    const v = isObj(it) ? parseFollow(it.v) : null;
    if (!v) continue;
    const prev = follows.get(v.l);
    if (!prev || sortKeyOf(it.ts, it.h) > prev.sortKey) follows.set(v.l, { l: v.l, ptr: v.ptr, h: it.h, ts: normTs(it.ts), author: it.author, sortKey: sortKeyOf(it.ts, it.h) });
  }
  const oks = new Set();
  for (const it of list(lists[LISTS.ok])) { const v = isObj(it) ? parseOk(it.v) : null; if (v) for (const r of v.refs) oks.add(refKey(r)); }
  const counts = new Map();
  for (const it of list(lists[LISTS.count])) {
    const v = isObj(it) ? parseCount(it.v) : null;
    if (!v) continue;
    const k = refKey(v.target), prev = counts.get(k);
    if (!prev || v.t >= prev.t) counts.set(k, { n: v.n, t: v.t });
  }
  const reactions = new Map(), scoped = new Map();
  for (const key of Object.keys(kv)) {
    const value = kvValue(kv[key]);
    if (key.startsWith(KEYS.reactionPrefix)) {
      const parts = key.slice(KEYS.reactionPrefix.length).split('/');
      const r = reactionOf(value);
      if (r && parts.length === 2 && isLedgerId(parts[0]) && isHash(parts[1])) reactions.set(parts[0] + '/' + parts[1], r);
    } else {
      const m = SCOPE_KEY.exec(key);
      if (!m || !m[2].startsWith(KEYS.reactionPrefix)) continue;
      const h = m[2].slice(KEYS.reactionPrefix.length), r = reactionOf(value);
      if (!r || !isHash(h)) continue;
      const k = id + '/' + h;
      if (!scoped.has(k)) scoped.set(k, new Map());
      scoped.get(k).set(m[1], r);
    }
  }
  let profile = { bio: '', avatar: null, links: [], handle: '', wall: '' };
  const profItems = list(lists[LISTS.profile]).filter((it) => isObj(it) && (!owner || it.author === owner));
  for (let i = profItems.length - 1; i >= 0; i--) { const v = parseProfile(profItems[i].v); if (v) { profile = v; break; } }
  const cfgRaw = kvValue(kv[KEYS.cfg]);
  const cfg = isObj(cfgRaw) ? cfgRaw : {};
  const name = owner && isStr(profiles[owner]) ? profiles[owner] : '';
  return {
    id, label: opts.label || '', owner, name, short: owner ? shortIdOf(owner) : '', profile, cfg, policy: isObj(s.policy) ? s.policy : {},
    posts, comments, shares, follows, oks, counts, reactions, scoped, profiles, role: s.role || null, height: Number(s.height) || 0,
    bytes: Number(s.bytes) || 0, peers: Number(s.peers) || 0, inSync: s.inSync,
    // How a withdrawn page or a hub removal reaches the template is not in R 2.11.2 yet; these read the two flags a snapshot may carry (GAP 5 in hub.js).
    withdrawn: s.withdrawn === true || s.status === 'withdrawn',
    removed: isObj(s.removed) && isStr(s.removed.reason) ? { reason: s.removed.reason.slice(0, 40) } : null,
  };
}

// ---------------------------------------------------------------------------------------------- the timeline

/**
 * wallMode(view): the owner's choice of who may post on their wall (R 3.5), 'follow' unless the ledger says otherwise. R 3.5 puts it in
 * _mw.cfg.wall, which is read first; the ledger's schema for _mw.cfg (src/chain/state.js, R 2.5.5) has no such key and hides a whole
 * _mw.cfg that has one, so the template writes the choice into its mw.prof item (wall) and reads that second (docs/deviations/examples.md).
 */
export function wallMode(view) {
  const fromCfg = view && view.cfg && view.cfg.wall;
  if (WALL_MODES.indexOf(fromCfg) !== -1) return fromCfg;
  const fromProfile = view && view.profile && view.profile.wall;
  return WALL_MODES.indexOf(fromProfile) === -1 ? DEFAULT_WALL : fromProfile;
}

/**
 * timelineItems(views, { filter, person, blocked, hidden }) -> items newest first by (ts, h). Merging is the only thing
 * done to the data: no ranking, no scoring. filter: 'all' (posts and shares), 'posts', 'replies', 'media', 'person'.
 */
export function timelineItems(views, opts = {}) {
  const filter = opts.filter || 'all';
  const blocked = opts.blocked instanceof Set ? opts.blocked : new Set(list(opts.blocked));
  const hidden = opts.hidden instanceof Set ? opts.hidden : new Set(list(opts.hidden));
  const seen = new Set(), out = [];
  for (const view of views) {
    if (!view) continue;
    if (filter === 'person' && view.id !== opts.person) continue;
    const pools = [];
    if (filter === 'replies') pools.push(view.comments);
    else {
      pools.push(view.posts);
      if (filter !== 'posts' && filter !== 'media') pools.push(view.shares);
      if (filter === 'person') pools.push(view.comments);
    }
    for (const pool of pools) {
      for (const it of pool) {
        if (seen.has(it.key) || hidden.has(it.key) || blocked.has(it.author)) continue;
        if (filter === 'media' && !(it.media && it.media.length)) continue;
        seen.add(it.key);
        out.push(it);
      }
    }
  }
  return out.sort(compareNewestFirst);
}

export function paginate(items, page = 0, size = LIMITS.pageSize) {
  const start = Math.max(0, page) * size;
  return { items: items.slice(start, start + size), page, size, total: items.length, hasMore: start + size < items.length };
}
/** newerThan(items, topKey): the items that sort above the item the reader last saw at the top ("N new posts"). */
export function newerThan(items, topKey) {
  return topKey ? items.filter((it) => it.sortKey > topKey) : [];
}

/**
 * timelineTop(items, topKey, ownLedger) -> the sort key the timeline shows down from. Empty topKey: the newest item. A newer item
 * from the reader's own ledger shows at once (the feed goes to the top), so only other people's new posts wait behind "N new posts".
 * E-SO-9: offline, db.append resolves before the data layer's 'change' adds the post to the model, so the composer's redraw kept
 * the old top and the device's own post was hidden behind "1 new post".
 */
export function timelineTop(items, topKey, ownLedger) {
  if (!items.length) return topKey || '';
  if (!topKey) return items[0].sortKey;
  return ownLedger && items.some((it) => it.sortKey > topKey && it.l === ownLedger) ? items[0].sortKey : topKey;
}

// ---------------------------------------------------------------------------------------------- accepted comments and threads

/** wallPosts(ownerView, views): the owner's posts plus posts by others that the owner accepted onto the wall (mw.ok refs naming them with 'to' this wall). */
export function wallPosts(ownerView, views) {
  const out = ownerView.posts.slice();
  const byId = new Map(); for (const v of views) if (v) byId.set(v.id, v);
  for (const k of ownerView.oks) {
    const at = k.lastIndexOf('/');
    const v = byId.get(k.slice(0, at));
    if (!v || v.id === ownerView.id) continue;
    const p = v.posts.find((x) => x.key === k);
    if (p && p.to === ownerView.id) out.push(p);
  }
  return out.sort(compareNewestFirst);
}

/**
 * threadOf(post, views, { me, blocked, hidden }) -> { roots: [node], missing, count }
 * The comments on a post live on the commenters' ledgers; the post's author accepts them by listing their refs in mw.ok.
 * A comment shows when the author accepted it, or when it is the reader's own (marked pending until accepted).
 * node: { comment, children, accepted }. Oldest first inside each level, so a conversation reads top to bottom.
 * missing counts accepted refs whose commenter's ledger this browser does not hold (they cannot be shown yet).
 */
export function threadOf(post, views, opts = {}) {
  const byId = new Map();
  for (const v of views) if (v) byId.set(v.id, v);
  const authorView = byId.get(post.l);
  const blocked = opts.blocked instanceof Set ? opts.blocked : new Set(list(opts.blocked));
  const hidden = opts.hidden instanceof Set ? opts.hidden : new Set(list(opts.hidden));
  const byVersion = new Map(); // 'ledger/hash' of the original or of any edit -> comment
  for (const v of byId.values()) for (const c of v.comments) { byVersion.set(c.key, c); for (const ver of c.versions) byVersion.set(c.l + '/' + ver.h, c); }
  const aimed = (c) => c.target.l === post.l && c.target.h === post.h;
  const nodes = new Map(), nodeOf = new Map(), missingLedgers = new Set();
  let missing = 0;
  const add = (c, accepted) => {
    if (nodes.has(c.key) || hidden.has(c.key) || blocked.has(c.author)) return;
    const node = { comment: c, children: [], accepted };
    nodes.set(c.key, node);
    nodeOf.set(c.key, node);
    for (const ver of c.versions) nodeOf.set(c.l + '/' + ver.h, node);
  };
  if (authorView) {
    for (const k of authorView.oks) {
      const c = byVersion.get(k);
      if (c) { if (aimed(c)) add(c, true); } else if (!byId.has(k.slice(0, k.lastIndexOf('/')))) { missing += 1; missingLedgers.add(k.slice(0, k.lastIndexOf('/'))); }
    }
  }
  // On a group's ledger the members write their comments to the group itself: those need no mw.ok.
  if (authorView && (authorView.policy.writers === 'allow' || authorView.policy.writers === 'open')) for (const c of authorView.comments) if (aimed(c)) add(c, true);
  const mine = opts.me ? byId.get(opts.me) : null;
  if (mine) for (const c of mine.comments) if (aimed(c)) add(c, false);
  const parentOf = new Map(), roots = [];
  for (const node of nodes.values()) {
    const rt = node.comment.replyTo, parent = rt ? nodeOf.get(rt.l + '/' + rt.h) : null;
    let loops = parent === node;
    for (let up = parent, hops = 0; up && !loops && hops < 64; hops++, up = parentOf.get(up)) if (up === node) loops = true;
    if (parent && !loops) { parentOf.set(node, parent); parent.children.push(node); } else roots.push(node);
  }
  const order = (a, b) => compareOldestFirst(a.comment, b.comment);
  const walk = (arr) => { arr.sort(order); for (const n of arr) walk(n.children); };
  walk(roots);
  return { roots, missing, missingLedgers: Array.from(missingLedgers), count: nodes.size };
}

// ---------------------------------------------------------------------------------------------- mw.ok batches

/**
 * batchRefs(refs, { max = 20, maxBytes = 2048 }) -> array of arrays of refs, each fitting one mw.ok item: at most 20 refs
 * and, because 20 refs of 31-character ledger ids are about 2,230 bytes, at most maxBytes of JSON as well (the ledger's
 * policy.maxValueBytes). Duplicates are dropped and the order is kept.
 */
export function batchRefs(refs, opts = {}) {
  const max = Math.min(opts.max || LIMITS.okRefs, LIMITS.okRefs), maxBytes = opts.maxBytes || LIMITS.valueBytes;
  const seen = new Set(), batches = [];
  let cur = [];
  for (const r of list(refs)) {
    if (!isRef(r) || seen.has(refKey(r))) continue;
    seen.add(refKey(r));
    const next = cur.concat([makeRef(r.l, r.h)]);
    if (cur.length && (next.length > max || jsonBytes({ refs: next }) > maxBytes)) { batches.push(cur); cur = [makeRef(r.l, r.h)]; } else cur = next;
  }
  if (cur.length) batches.push(cur);
  return batches;
}
/** pendingOkRefs(accepted, existingOkKeys): the accepted refs that no mw.ok item of the wall owner lists yet. */
export function pendingOkRefs(accepted, existing) {
  const have = existing instanceof Set ? existing : new Set(list(existing));
  return list(accepted).filter((r) => isRef(r) && !have.has(refKey(r)));
}

/**
 * wallDecision(mode, { fromLedger, followed, blocked, fromPub }) -> 'accept' | 'queue' | 'ignore'
 * What the wall owner's client does with a notice about a comment or a post addressed to their wall (R 3.5).
 */
export function wallDecision(mode, ctx = {}) {
  const blocked = ctx.blocked instanceof Set ? ctx.blocked : new Set(list(ctx.blocked));
  if (ctx.fromPub && blocked.has(ctx.fromPub)) return 'ignore';
  const followed = ctx.followed instanceof Set ? ctx.followed : new Set(list(ctx.followed));
  switch (WALL_MODES.indexOf(mode) === -1 ? DEFAULT_WALL : mode) {
    case 'everyone': return 'accept';
    case 'follow': return followed.has(ctx.fromLedger) ? 'accept' : 'ignore';
    case 'approve': return 'queue';
    default: return 'ignore';
  }
}

// ---------------------------------------------------------------------------------------------- reactions

export const reactionKey = (target) => KEYS.reactionPrefix + target.l + '/' + target.h; // on the reactor's own ledger
export const scopedReactionName = (target) => KEYS.reactionPrefix + target.h; // for mw.db.setMine on a group ledger

/**
 * collectReactions(target, views) -> [{ member, r }]: one entry per member per target. A member is a ledger (a person's
 * own ledger holds their reactions under one key per target) or, on a group ledger, an author scope. A member who appears
 * twice counts once; the first source wins, so list the reader's own view first.
 */
export function collectReactions(target, views) {
  const k = refKey(target), byMember = new Map();
  for (const v of views) {
    if (!v) continue;
    const own = v.reactions && v.reactions.get(k);
    if (own) { const member = v.owner || v.id; if (!byMember.has(member)) byMember.set(member, { member, r: own, ledger: v.id }); }
    if (v.id === target.l && v.scoped && v.scoped.has(k)) {
      for (const [scope, r] of v.scoped.get(k)) { const member = 'scope:' + scope; if (!byMember.has(member)) byMember.set(member, { member, r, scope }); }
    }
  }
  return Array.from(byMember.values());
}
/**
 * summarizeReactions(entries, { followed, me, scopeOf, group }) -> { counts, total, mine, label }
 * Counts are counts of reactions this browser can see: personal walls count the reader and the people they follow
 * ("from people you follow"); a group counts every key that reacted ("from members, counts of keys").
 */
export function summarizeReactions(entries, ctx = {}) {
  const followed = ctx.followed instanceof Set ? ctx.followed : new Set(list(ctx.followed));
  const counts = {}; for (const r of REACTIONS) counts[r] = 0;
  let total = 0, mine = null;
  for (const e of entries) {
    const isMe = (ctx.me && (e.ledger === ctx.me || e.member === ctx.meMember)) || (ctx.meScope && e.scope === ctx.meScope);
    if (isMe) mine = e.r;
    if (!ctx.group && !isMe && !followed.has(e.ledger)) continue;
    counts[e.r] += 1; total += 1;
  }
  return { counts, total, mine, label: ctx.group ? 'from members (counts of keys)' : 'from people you follow' };
}
/** reportedCount(view, target) -> { n, t, label } the author's own tally, always labelled as theirs. */
export function reportedCount(view, target) {
  const c = view && view.counts && view.counts.get(refKey(target));
  return c ? { n: c.n, t: c.t, label: 'as counted by the author' } : null;
}

// ---------------------------------------------------------------------------------------------- follows

/** followCapView(count, deviceClass) -> what the UI prints: "You follow 250 of 250 on this phone". */
export function followCapView(count, deviceClass) {
  const phone = deviceClass !== 'desktop', cap = phone ? FOLLOW_CAPS.phone : FOLLOW_CAPS.desktop, n = Math.max(0, Math.floor(Number(count) || 0));
  return {
    count: n, cap, phone, remaining: Math.max(0, cap - n), atCap: n >= cap, near: n >= Math.floor(cap * 0.9),
    text: 'You follow ' + n.toLocaleString('en-US') + ' of ' + cap.toLocaleString('en-US') + ' on this ' + (phone ? 'phone' : 'computer'),
  };
}
/** followedSet(views, privateFollows): the ledger ids this reader follows, public (mw.f) and private (mw.me) together. */
export function followedSet(ownView, privateFollows) {
  const out = new Set();
  if (ownView) for (const l of ownView.follows.keys()) out.add(l);
  for (const f of list(privateFollows)) if (isObj(f) && isLedgerId(f.l)) out.add(f.l);
  return out;
}
/**
 * suggestions(views, followed, me, limit): people followed by people you follow, from the public follow lists this browser
 * holds. Sorted by how many of your follows follow them, then by ledger id; there is no other signal and nothing is scored.
 */
export function suggestions(views, followed, me, limit = 10) {
  const tally = new Map();
  for (const v of views) {
    if (!v || !followed.has(v.id)) continue;
    for (const [l, f] of v.follows) {
      if (l === me || followed.has(l)) continue;
      const t = tally.get(l) || { l, count: 0, ptr: '', via: [] };
      t.count += 1; t.via.push(v.id); if (!t.ptr && f.ptr) t.ptr = f.ptr;
      tally.set(l, t);
    }
  }
  return Array.from(tally.values()).sort((a, b) => (b.count - a.count) || (a.l < b.l ? -1 : 1)).slice(0, limit);
}
/** followersYouCanSee(target, views): ledgers whose public follow list names the target ("Followers you can see"). */
export function followersYouCanSee(target, views) {
  const out = [];
  for (const v of views) if (v && v.id !== target && v.follows.has(target)) out.push(v.id);
  return out.sort();
}

// ---------------------------------------------------------------------------------------------- text: mentions and links

const MENTION = /(^|[^0-9A-Za-z_@])@([0-9a-f]{8})(?![0-9A-Za-z_])/g;
/** extractMentions(text) -> the short ids mentioned, in order, once each. */
export function extractMentions(text) {
  const out = [];
  for (const m of String(text || '').matchAll(MENTION)) if (out.indexOf(m[2]) === -1) out.push(m[2]);
  return out;
}
/** tokenize(text) -> [{ type: 'text'|'mention'|'link', value }] so the views build nodes and never parse HTML. */
export function tokenize(text) {
  const src = String(text || ''), out = [];
  const re = /@([0-9a-f]{8})(?![0-9A-Za-z_])|https:\/\/[^\s<>"']+/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    if (m[1] && m.index > 0 && /[0-9A-Za-z_@]/.test(src[m.index - 1])) continue;
    let value = m[0], end = m.index + value.length;
    if (!m[1]) { const trimmed = value.replace(/[.,;:!?)\]]+$/, ''); end -= value.length - trimmed.length; value = trimmed; }
    if (m.index > last) out.push({ type: 'text', value: src.slice(last, m.index) });
    out.push(m[1] ? { type: 'mention', value: m[1] } : isHttpsUrl(value) ? { type: 'link', value } : { type: 'text', value });
    last = end; re.lastIndex = end;
  }
  if (last < src.length) out.push({ type: 'text', value: src.slice(last) });
  return out;
}

// ---------------------------------------------------------------------------------------------- composer validation and drafts

/**
 * validatePostDraft(draft) -> { ok, errors: [{ field, code }], value }
 * draft: { text, media: [{ ref, kind, alt }], link, to, edit }. Codes: 'E_LIMIT' (too long, too many, too large),
 * 'EMPTY', 'ALT_REQUIRED' (every public picture needs a description), 'LINK_HTTPS'. The strings are in strings.js.
 */
export function validatePostDraft(draft) {
  const d = isObj(draft) ? draft : {}, errors = [], text = isStr(d.text) ? d.text.trim() : '', media = list(d.media);
  if (!text && !media.length) errors.push({ field: 'text', code: 'EMPTY' });
  if (text.length > LIMITS.postChars) errors.push({ field: 'text', code: 'E_LIMIT' });
  if (media.length > LIMITS.mediaPerPost) errors.push({ field: 'media', code: 'E_LIMIT' });
  media.forEach((m, i) => {
    if (!isObj(m)) return errors.push({ field: 'media[' + i + ']', code: 'E_LIMIT' });
    const alt = isStr(m.alt) ? m.alt.trim() : '';
    if (m.kind !== 'video' && !alt) errors.push({ field: 'media[' + i + '].alt', code: 'ALT_REQUIRED' });
    if (alt.length > LIMITS.altChars) errors.push({ field: 'media[' + i + '].alt', code: 'E_LIMIT' });
  });
  if (extractMentions(text).length > LIMITS.mentionsPerPost) errors.push({ field: 'text', code: 'MENTIONS' });
  if (d.link && !isHttpsUrl(d.link.url || d.link)) errors.push({ field: 'link', code: 'LINK_HTTPS' });
  const value = { text };
  if (media.length) value.media = media.map((m) => ({ ref: m.ref, kind: m.kind === 'video' ? 'video' : 'image', alt: isStr(m.alt) ? m.alt.trim() : '' }));
  if (d.link) value.link = { url: d.link.url || d.link };
  if (d.to) value.to = d.to;
  if (d.edit) value.edit = d.edit;
  if (!errors.length && jsonBytes(value) > LIMITS.valueBytes) errors.push({ field: 'size', code: 'E_LIMIT' });
  return { ok: errors.length === 0, errors, value };
}
export function validateCommentDraft(draft) {
  const d = isObj(draft) ? draft : {}, text = isStr(d.text) ? d.text.trim() : '', errors = [];
  if (!text) errors.push({ field: 'text', code: 'EMPTY' });
  if (text.length > LIMITS.commentChars) errors.push({ field: 'text', code: 'E_LIMIT' });
  if (extractMentions(text).length > LIMITS.mentionsPerPost) errors.push({ field: 'text', code: 'MENTIONS' });
  if (!isRef(d.target)) errors.push({ field: 'target', code: 'E_LIMIT' });
  const value = { text, target: d.target ? makeRef(d.target.l, d.target.h) : null };
  if (d.replyTo) value.replyTo = makeRef(d.replyTo.l, d.replyTo.h);
  if (d.edit) value.edit = d.edit;
  return { ok: errors.length === 0, errors, value };
}
export function validateProfileDraft(draft) {
  const d = isObj(draft) ? draft : {}, errors = [], name = isStr(d.name) ? d.name.trim() : '', bio = isStr(d.bio) ? d.bio.trim() : '';
  if (!name) errors.push({ field: 'name', code: 'EMPTY' });
  if (name.length > LIMITS.nameChars) errors.push({ field: 'name', code: 'E_LIMIT' });
  if (bio.length > LIMITS.bioChars) errors.push({ field: 'bio', code: 'E_LIMIT' });
  const links = list(d.links).map((x) => String(x).trim()).filter(Boolean);
  if (links.length > LIMITS.profileLinks) errors.push({ field: 'links', code: 'E_LIMIT' });
  links.forEach((u, i) => { if (!isHttpsUrl(u)) errors.push({ field: 'links[' + i + ']', code: 'LINK_HTTPS' }); });
  const handle = isStr(d.handle) ? d.handle.trim().toLowerCase().replace(/^@/, '') : '';
  if (handle && !parseProfile({ handle })) errors.push({ field: 'handle', code: 'HANDLE' });
  const value = { bio };
  if (links.length) value.links = links;
  if (handle) value.handle = handle;
  if (d.avatar) value.avatar = d.avatar;
  if (WALL_MODES.indexOf(d.wall) !== -1) value.wall = d.wall;
  return { ok: errors.length === 0, errors, name, value };
}

/** upsertDraft(drafts, draft, max = 20): newest first, one per id, the oldest dropped beyond the limit. */
export function upsertDraft(drafts, draft, max = LIMITS.drafts) {
  const rest = list(drafts).filter((d) => d && d.id !== draft.id);
  return [draft].concat(rest).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0)).slice(0, max);
}
export const removeDraft = (drafts, id) => list(drafts).filter((d) => d && d.id !== id);

// ---------------------------------------------------------------------------------------------- relative time

/** timeAgo(ts, now): "just now", "5 min ago", "3 h ago", "2 d ago", then a date. ts is a claim by the author. */
export function timeAgo(ts, now) {
  const t = normTs(ts);
  if (!t) return '';
  const min = Math.round(Math.max(0, now - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + ' min ago';
  if (min < 1440) return Math.round(min / 60) + ' h ago';
  if (min < 20160) return Math.round(min / 1440) + ' d ago';
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * pointerFor(id, views, privateFollows) -> the pointer string this browser holds for a ledger, else ''. A ledger is followed by
 * its pointer the first time (the pointer pins its owner; docs/SDK.md, mw.hub.follow), and a comment or a notice names only the
 * ledger id, so the pointer comes from a follow item someone this browser holds wrote (mw.f carries ptr), or from a private follow.
 */
export function pointerFor(id, views, privateFollows) {
  if (!isLedgerId(id)) return '';
  for (const f of list(privateFollows)) if (isObj(f) && f.l === id && isStr(f.ptr) && f.ptr) return f.ptr;
  for (const v of list(views)) {
    const f = v && v.follows && typeof v.follows.get === 'function' ? v.follows.get(id) : null;
    if (f && isStr(f.ptr) && f.ptr) return f.ptr;
  }
  return '';
}
