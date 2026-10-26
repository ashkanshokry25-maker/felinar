// The data layer: this page's own ledger (mw.db), the ledgers it follows (mw.hub plus the { ledger } reads), and every write
// the template makes. Views read plain objects from here (see model.js) and call the actions; nothing else touches the SDK
// for posts, comments, reactions, follows and settings. A change is announced as one coalesced 'change' event.
//
// Home origin model (R 3.1): a signed-in member uses this app on their own label, where every write lands on their own ledger
// and other people's walls are read from the ledgers the browser follows. On someone else's address the page only reads.

import { LISTS, KEYS, LIMITS, DEFAULT_WALL, REACTIONS, WALL_MODES, FEATURE_SWITCHES, CFG_KEYS } from './config.js';
import * as M from './model.js';
import { hubLabelFor, isLedgerId, isPub, authorScope } from './ids.js';
import { encodeNotice, addNotification, markAllSeen, unseenCount, syncedNotices, notificationId } from './notices.js';
import { KEYS as SK, DEFAULT_PREFS } from './store.js';
import { throttle } from './dom.js';
import { SIGNED_ENTRIES_NOTE } from './strings.js';

const noop = () => {};
const coded = (code, message) => Object.assign(new Error(message || code), { code });

export function createData({ mw, hub, store, env, chat }) {
  const listeners = new Map();
  const emit = (ev, payload) => { for (const fn of listeners.get(ev) || []) { try { fn(payload); } catch (err) { console.error(err); } } };
  const on = (ev, fn) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); };
  const changed = throttle(() => emit('change'), 150);

  const state = {
    info: null, auth: 'guest', identity: null, role: 'reader', siteId: '', label: '', ready: false, startedAt: env.now(),
    peers: 0, inSync: 0, kind: 'unknown', sync: { total: 0, done: 0, failed: 0 }, lastUpdated: store.get(SK.lastUpdated, 0), pow: null,
  };
  const views = new Map(), subs = new Map(), seen = new Set(), peeks = new Map(), labels = new Map(), byLabel = new Map();
  const waiters = new Set();
  const syncedSeen = new Set(); // notices already taken from followed windows this session (scanSynced)
  let ownSnap = null, followed = new Set(), ownFirst = null, stopChat = noop, okTimer = 0, stopPow = noop, version = 0, ccCache = { v: -1, map: null };

  // ------------------------------------------------------------------------------------------ ids, labels, names
  function labelOf(id) {
    if (!isLedgerId(id)) return '';
    if (!labels.has(id)) { const l = hubLabelFor(id); labels.set(id, l); byLabel.set(l, id); }
    return labels.get(id);
  }
  const idOfLabel = (label) => { if (!byLabel.size) return null; return byLabel.get(label) || null; };
  const viewOf = (id) => views.get(id) || null;
  const own = () => views.get(state.siteId) || null;
  const shortOwner = (id) => { const v = views.get(id); return v && v.owner ? v.short : ''; };
  /** ownerName(pub) -> the name on a page this browser holds whose owner key is pub, else '' (chat names its senders by key only). */
  const ownerName = (pub) => { for (const v of views.values()) if (v.owner === pub && v.name) return v.name; return ''; };
  function nameOf(id) {
    const v = views.get(id);
    return (v && v.name) || (v && v.short) || (isLedgerId(id) ? labelOf(id).slice(0, 8) : 'Unknown');
  }
  function ledgerForShort(short) {
    for (const v of views.values()) if (v.owner && v.short === short) return v.id;
    return null;
  }
  const learnLedgers = (ids) => { for (const id of ids) labelOf(id); };

  const applyInfo = (info) => {
    state.info = info || {};
    state.auth = state.info.auth || (state.info.identity ? 'signed-in' : 'guest');
    state.identity = state.info.identity || null;
    state.role = state.info.role || 'reader';
    state.siteId = state.info.siteId || '';
    state.label = labelOf(state.siteId);
    state.peers = Number(state.info.peers) || 0;
    state.ready = true;
  };
  function classify() {
    const o = own();
    const writers = o && o.policy && o.policy.writers;
    state.kind = writers === 'allow' || writers === 'open' ? 'group' : writers === 'owner' ? 'person' : 'unknown';
  }
  const signedIn = () => state.auth === 'signed-in' && !!state.identity;
  const isHome = () => signedIn() && state.kind === 'person' && state.role === 'owner';
  /** canWrite(): this page takes your posts, comments and reactions: your own page, or a group where you may write. */
  const canWrite = () => isHome() || (signedIn() && state.kind === 'group' && state.role !== 'reader');
  const isModerator = () => signedIn() && state.kind === 'group' && (state.role === 'owner' || state.role === 'moderator');
  const needSignIn = () => { if (!signedIn()) throw coded('E_NOT_SIGNED_IN'); };

  // ------------------------------------------------------------------------------------------ snapshots
  function onSnapshot(id, snap) {
    const v = M.viewFromSnapshot(id, snap, { label: labelOf(id) });
    views.set(id, v);
    version += 1;
    for (const f of v.follows.keys()) labelOf(f);
    if (id === state.siteId) {
      ownSnap = snap; state.peers = v.peers; state.inSync = typeof snap.inSync === 'number' ? snap.inSync : state.inSync;
      if (snap.role) state.role = snap.role;
      classify();
      if (ownFirst) { ownFirst(); ownFirst = null; }
    }
    if (!seen.has(id)) { seen.add(id); if (followed.has(id) && id !== state.siteId) state.sync.done += 1; }
    state.lastUpdated = env.now();
    store.set(SK.lastUpdated, state.lastUpdated);
    scanSynced(id);
    for (const w of Array.from(waiters)) w();
    changed();
  }
  /**
   * scanSynced(id): replies to my posts and follows of my page that a followed window shows become notices, as if the chat notice had
   * arrived (notices.js syncedNotices): the wall setting then decides each reply and accepted ones go into mw.ok. Each one once per
   * session; the stored list deduplicates across sessions. My own page's snapshot rescans every followed view (isHome may only now be known).
   */
  function scanSynced(id) {
    if (!isHome()) return;
    const ids = id === state.siteId ? Array.from(followedIds()) : [id];
    for (const l of ids) {
      if (l === state.siteId || !followedIds().has(l)) continue;
      for (const n of syncedNotices(views.get(l), state.siteId)) {
        const key = notificationId(n);
        if (syncedSeen.has(key)) continue;
        syncedSeen.add(key);
        handleNotice(n);
      }
    }
  }
  /** waitView(pred, ms): resolves true once a snapshot has made pred() true (the page's own write is visible in its own view), false after ms. */
  function waitView(pred, ms = 1500) {
    return new Promise((resolve) => {
      if (pred()) { resolve(true); return; }
      let t = 0;
      const check = () => { if (pred()) { waiters.delete(check); clearTimeout(t); resolve(true); } };
      waiters.add(check);
      t = setTimeout(() => { waiters.delete(check); resolve(false); }, ms);
    });
  }
  /** subscribeOne(id): listen to a followed ledger. The loader's hub lane decides how many sync at once (4, R 3.2.2); the page just listens. */
  function subscribeOne(id) {
    if (subs.has(id)) return;
    try { subs.set(id, hub.subscribe(id, (snap) => onSnapshot(id, snap))); } catch (err) { state.sync.failed += 1; }
  }
  function subscribeAll(ids) {
    for (const id of ids) if (id !== state.siteId) subscribeOne(id);
  }
  const privateFollows = () => store.get(SK.privateFollows, []).filter((f) => f && isLedgerId(f.l));
  function followedIds() {
    const out = new Set(followed);
    const o = own();
    if (o) for (const l of o.follows.keys()) out.add(l);
    for (const f of privateFollows()) out.add(f.l);
    out.delete(state.siteId);
    return out;
  }

  async function syncFollowed() {
    let listed = [];
    try { listed = hub.available ? await hub.list() : []; } catch (err) { listed = []; }
    followed = new Set(listed.map((x) => x.ledger));
    const wanted = followedIds();
    learnLedgers(wanted);
    if (hub.available) {
      for (const id of wanted) {
        if (followed.has(id)) continue;
        const priv = privateFollows().find((f) => f.l === id);
        const ptr = (own() && own().follows.get(id) && own().follows.get(id).ptr) || (priv || {}).ptr || '';
        try { await hub.follow(ptr || id, priv && !(own() && own().follows.has(id)) ? { private: true } : undefined); followed.add(id); } catch (err) { state.sync.failed += 1; } // the cap or an unknown pointer: the list shows it
      }
    }
    state.sync.total = followed.size;
    if (hub.available) subscribeAll(Array.from(followed));
    emit('change');
  }

  // ------------------------------------------------------------------------------------------ start and stop
  async function start() {
    applyInfo(await mw.ready());
    const first = new Promise((resolve) => { ownFirst = resolve; setTimeout(resolve, 2500); });
    try { subs.set(state.siteId, mw.db.subscribe((snap) => onSnapshot(state.siteId, snap))); } catch (err) { /* no ledger in this copy */ }
    await first;
    classify();
    if (mw.auth && typeof mw.auth.onChange === 'function') {
      mw.auth.onChange(async () => { try { applyInfo(await mw.ready()); classify(); emit('auth'); changed(); } catch (err) { emit('auth'); } });
    }
    if (mw.net && typeof mw.net.on === 'function') {
      try { stopPow = mw.net.on('pow', (d) => { state.pow = d && typeof d === 'object' ? d : null; emit('pow', state.pow); }) || noop; } catch (err) { /* older SDK */ }
    }
    if (chat) stopChat = chat.onNotice((n, msg) => handleNotice(n, msg)) || noop;
    await syncFollowed();
    okTimer = setInterval(() => { flushOk().catch(noop); }, 10000);
    emit('ready');
  }
  function stop() {
    for (const off of subs.values()) { try { off(); } catch (err) { /* gone */ } }
    subs.clear(); clearInterval(okTimer); stopChat(); stopPow();
  }

  // ------------------------------------------------------------------------------------------ reading
  function timelineViews() {
    const out = [];
    const o = own();
    if (o && o.policy.writers !== 'allow' && o.policy.writers !== 'open') out.push(o);
    for (const id of followedIds()) { const v = views.get(id); if (v && v.policy.writers !== 'allow' && v.policy.writers !== 'open') out.push(v); }
    return out;
  }
  const blockedSet = () => new Set(store.get(SK.blocked, []));
  const hiddenSet = () => new Set(store.get(SK.hidden, []));
  function timeline(opts = {}) {
    return M.timelineItems(timelineViews(), Object.assign({ blocked: blockedSet(), hidden: hiddenSet() }, opts));
  }
  /** commentCounts() -> Map(target ref key -> comments shown): accepted ones (the author listed them in mw.ok) plus the reader's own pending ones. */
  function commentCounts() {
    if (ccCache.v === version) return ccCache.map;
    const byVersion = new Map(), map = new Map(), counted = new Set();
    for (const v of views.values()) for (const c of v.comments) { byVersion.set(c.key, c); for (const ver of c.versions) byVersion.set(c.l + '/' + ver.h, c); }
    for (const v of views.values()) {
      for (const k of v.oks) {
        const c = byVersion.get(k);
        if (!c || c.target.l !== v.id || counted.has(c.key)) continue;
        counted.add(c.key);
        const tk = M.refKey(c.target); map.set(tk, (map.get(tk) || 0) + 1);
      }
    }
    for (const v of views.values()) {
      if (v.policy.writers !== 'allow' && v.policy.writers !== 'open') continue; // a group: members write comments to the group's own ledger
      for (const c of v.comments) if (c.target.l === v.id && !counted.has(c.key)) { counted.add(c.key); const tk = M.refKey(c.target); map.set(tk, (map.get(tk) || 0) + 1); }
    }
    const mine = own();
    if (mine) for (const c of mine.comments) if (!counted.has(c.key)) { const tk = M.refKey(c.target); map.set(tk, (map.get(tk) || 0) + 1); }
    ccCache = { v: version, map };
    return map;
  }
  function status() {
    const offline = (typeof navigator !== 'undefined' && navigator.onLine === false) ||
      (state.peers === 0 && state.sync.total > 0 && state.sync.done < state.sync.total && env.now() - state.startedAt > 8000);
    return { offline, syncing: state.sync.total > 0 && state.sync.done < state.sync.total, done: state.sync.done, total: state.sync.total, lastUpdated: state.lastUpdated, peers: state.peers };
  }
  const followCap = () => M.followCapView(followedIds().size, env.deviceClass());
  const isFollowing = (id) => followedIds().has(id);

  // ------------------------------------------------------------------------------------------ transient reads (a profile or a thread you opened)
  async function peek(id) {
    if (!isLedgerId(id) || id === state.siteId) return viewOf(id);
    peeks.set(id, (peeks.get(id) || 0) + 1);
    if (!subs.has(id) && hub.available) {
      // The first follow of a ledger needs its pointer (it pins the owner): from a follow item this browser holds, else the id.
      const ptr = M.pointerFor(id, Array.from(views.values()), privateFollows());
      if (!followedIds().has(id)) { try { await hub.follow(ptr || id); } catch (err) { peeks.set(id, peeks.get(id) - 1); throw err; } }
      subscribeOne(id);
    }
    return viewOf(id);
  }
  async function release(id) {
    const n = (peeks.get(id) || 1) - 1;
    peeks.set(id, n);
    if (n > 0 || followedIds().has(id)) return;
    peeks.delete(id);
    const off = subs.get(id); if (off) { try { off(); } catch (err) { /* gone */ } subs.delete(id); }
    views.delete(id); seen.delete(id); version += 1;
    try { await hub.unfollow(id); } catch (err) { /* it was never followed */ }
    changed();
  }

  // ------------------------------------------------------------------------------------------ writes
  const progress = (opts) => (opts && opts.onProgress ? { onProgress: opts.onProgress, signal: opts.signal } : opts && opts.signal ? { signal: opts.signal } : undefined);

  async function notify(toLedger, notice) {
    if (!chat) return false;
    const v = views.get(toLedger);
    const text = encodeNotice(Object.assign({ from: state.siteId }, notice));
    if (!v || !v.owner || !text || v.id === state.siteId) return false;
    return chat.sendNotice(v.owner, text);
  }
  async function addPost(value, opts) {
    needSignIn();
    const check = M.validatePostDraft(value);
    if (!check.ok) throw coded(check.errors[0].code, check.errors[0].field);
    const out = await mw.db.append(LISTS.post, check.value, progress(opts));
    const ref = M.makeRef(state.siteId, out.h);
    if (check.value.to) notify(check.value.to, { k: 'wall', ref });
    for (const short of M.extractMentions(check.value.text)) { const l = ledgerForShort(short); if (l && l !== check.value.to) notify(l, { k: 'mention', ref }); }
    return Object.assign({ ref }, out);
  }
  const editPost = (root, value, opts) => addPost(Object.assign({}, value, { edit: root }), opts);
  async function deleteVersions(item) {
    needSignIn();
    for (const v of item.versions) await mw.db.tombstone(v.h);
  }
  async function addComment(post, text, replyTo, opts) {
    needSignIn();
    const check = M.validateCommentDraft({ text, target: M.makeRef(post.l, post.h), replyTo });
    if (!check.ok) throw coded(check.errors[0].code, check.errors[0].field);
    const out = await mw.db.append(LISTS.comment, check.value, progress(opts));
    const ref = M.makeRef(state.siteId, out.h), target = M.makeRef(post.l, post.h);
    notify(post.l, { k: 'reply', ref, target });
    for (const short of M.extractMentions(check.value.text)) { const l = ledgerForShort(short); if (l && l !== post.l) notify(l, { k: 'mention', ref }); }
    if (post.l === state.siteId) queueOk([ref]); // your own post: your comment needs no approval
    return Object.assign({ ref }, out);
  }
  async function editComment(c, text, opts) {
    needSignIn();
    const check = M.validateCommentDraft({ text, target: c.target, replyTo: c.replyTo, edit: c.h });
    if (!check.ok) throw coded(check.errors[0].code, check.errors[0].field);
    return mw.db.append(LISTS.comment, check.value, progress(opts));
  }
  async function shareItem(target, text, opts) {
    needSignIn();
    const value = { target: M.makeRef(target.l, target.h) };
    if (text && text.trim()) { if (text.trim().length > LIMITS.commentChars) throw coded('E_LIMIT'); value.text = text.trim(); }
    const out = await mw.db.append(LISTS.share, value, progress(opts));
    notify(target.l, { k: 'share', ref: M.makeRef(state.siteId, out.h), target: value.target });
    emit('own-write');
    return out;
  }
  /** react(target, r): one reaction per member per target. A group site stores it as an author-scoped key, your own ledger as re/<ledger>/<h>. */
  async function react(target, r) {
    needSignIn();
    if (r !== null && REACTIONS.indexOf(r) === -1) throw coded('E_LIMIT');
    if (state.kind === 'group' && target.l === state.siteId) return mw.db.setMine(M.scopedReactionName(target), r ? { r } : null);
    return r ? mw.db.set(M.reactionKey(target), { r }) : mw.db.del(M.reactionKey(target));
  }
  async function saveProfile({ name, bio, links, handle, avatar }) {
    needSignIn();
    const check = M.validateProfileDraft({ name, bio, links, handle, avatar });
    if (!check.ok) throw coded(check.errors[0].code, check.errors[0].field);
    await mw.identity.setName(check.name);
    return mw.db.append(LISTS.profile, Object.assign({}, check.value, { wall: M.wallMode(own()) })); // each profile item carries the wall choice
  }
  /** setWall(mode): who may write on my wall. Kept in the mw.prof item (not _mw.cfg: the ledger hides a _mw.cfg with a key it does not know). */
  async function setWall(mode) {
    needSignIn();
    if (WALL_MODES.indexOf(mode) === -1) throw coded('E_BAD_REQUEST');
    const p = own() && own().profile ? own().profile : {};
    const value = { bio: p.bio || '', wall: mode };
    if (p.links && p.links.length) value.links = p.links.slice();
    if (p.handle) value.handle = p.handle;
    if (p.avatar) value.avatar = p.avatar;
    const out = await mw.db.append(LISTS.profile, value);
    await waitView(() => M.wallMode(own()) === mode); // the next notice is judged by the setting you just chose
    return out;
  }
  /**
   * ensureFeature(name): turn chat, files or media on for the page's own ledger, as its owner, once. A personal site starts with no _mw.cfg, so
   * the loader refuses mw.chat.enable, mw.files.share and mw.media.upload until it holds the switch ('members'). Every key the page's _mw.cfg
   * already has is written back as it is: the ledger shows a _mw.cfg only when its schema knows every key in it, so each one is known, and
   * dropping one would switch that feature off (calls, which v0.3 C2 added, was dropped this way). The template itself adds only the keys of
   * FEATURE_SWITCHES, all in CFG_KEYS. On a page that is not your own nothing is written and the loader decides.
   */
  async function ensureFeature(name) {
    const on = FEATURE_SWITCHES[name];
    if (!on || CFG_KEYS.indexOf(name) === -1) throw coded('E_BAD_REQUEST');
    if (!isHome() || !own()) return false;
    const cur = own().cfg && typeof own().cfg === 'object' ? own().cfg : {};
    if (cur[name] && cur[name] !== 'off') return false;
    const next = {};
    for (const k of Object.keys(cur)) next[k] = cur[k];
    next[name] = on;
    await mw.db.set(KEYS.cfg, next);
    await waitView(() => { const c = own() && own().cfg; return !!c && c[name] === on; });
    return true;
  }

  // ------------------------------------------------------------------------------------------ follows
  async function follow(target, { publicStatement } = {}) {
    needSignIn();
    const pub = publicStatement === undefined ? store.get(SK.prefs, DEFAULT_PREFS).followsPublic !== false : publicStatement;
    const cap = followCap();
    if (cap.atCap) throw coded('E_LIMIT');
    const pointer = typeof target === 'string' && target.startsWith('v=') ? target : '';
    const res = await hub.follow(target, pub ? undefined : { private: true }); // STALK-3: a private follow is not named to neighbours
    const id = res.ledger;
    if (!isLedgerId(id)) throw coded('E_BAD_REQUEST');
    followed.add(id); labelOf(id);
    if (pub) {
      const item = { l: id }; if (pointer && pointer.length <= 600) item.ptr = pointer;
      await mw.db.append(LISTS.follow, item);
    } else {
      const list = privateFollows().filter((f) => f.l !== id).concat([pointer ? { l: id, ptr: pointer } : { l: id }]);
      store.set(SK.privateFollows, list);
      if (mw.me && typeof mw.me.set === 'function') mw.me.set('follows', list).catch(noop);
    }
    subscribeOne(id);
    notify(id, { k: 'follow' });
    changed();
    return { ledger: id };
  }
  async function unfollow(id) {
    needSignIn();
    const o = own(), item = o && o.follows.get(id);
    if (item) await mw.db.tombstone(item.h);
    const list = privateFollows().filter((f) => f.l !== id);
    if (list.length !== privateFollows().length) { store.set(SK.privateFollows, list); if (mw.me && typeof mw.me.set === 'function') mw.me.set('follows', list).catch(noop); }
    followed.delete(id);
    const off = subs.get(id); if (off) { try { off(); } catch (err) { /* gone */ } subs.delete(id); }
    if (!peeks.get(id)) { views.delete(id); seen.delete(id); } // a page you are looking at keeps what it has until you leave it
    try { await hub.unfollow(id); } catch (err) { /* already gone */ }
    changed();
  }
  /** loadPrivate(): read the private record (a card opens once per session) and merge private follows and blocks into this device's copy. */
  async function loadPrivate() {
    if (!mw.me || typeof mw.me.get !== 'function') throw coded('NOT_AVAILABLE');
    const rec = await mw.me.get();
    const f = rec && Array.isArray(rec.follows) ? rec.follows.filter((x) => x && isLedgerId(x.l)) : [];
    if (f.length) store.set(SK.privateFollows, f);
    if (rec && Array.isArray(rec.blocks)) store.set(SK.blocked, rec.blocks.filter(isPub).slice(0, LIMITS.blocks));
    if (f.length) await syncFollowed();
    return { follows: f.length, blocks: rec && Array.isArray(rec.blocks) ? rec.blocks.length : 0 };
  }

  // ------------------------------------------------------------------------------------------ blocks and hides
  function block(pub) {
    const list = store.get(SK.blocked, []);
    if (list.indexOf(pub) === -1 && list.length < LIMITS.blocks) {
      const next = list.concat([pub]);
      store.set(SK.blocked, next);
      if (mw.me && typeof mw.me.set === 'function') mw.me.set('blocks', next).catch(noop);
    }
    if (chat) chat.block(pub).catch(noop);
    changed();
  }
  function unblock(pub) {
    const next = store.get(SK.blocked, []).filter((p) => p !== pub);
    store.set(SK.blocked, next);
    if (mw.me && typeof mw.me.set === 'function') mw.me.set('blocks', next).catch(noop);
    if (chat) chat.unblock(pub).catch(noop);
    changed();
  }
  function hide(key) { store.set(SK.hidden, Array.from(new Set(store.get(SK.hidden, []).concat([key])))); changed(); }
  function unhide(key) { store.set(SK.hidden, store.get(SK.hidden, []).filter((k) => k !== key)); changed(); }

  // ------------------------------------------------------------------------------------------ notices, the wall queue, mw.ok
  function notices() { return store.get(SK.notices, []); }
  function pushNotice(n) {
    store.set(SK.notices, addNotification(notices(), n, env.now()));
    emit('notice', n); changed();
  }
  // SYB-12: refs one sender key may put before the wall setting per hour, so a contact cannot make this page sign mw.ok items without end.
  const NOTICE_REFS_PER_HOUR = 20, refTimes = new Map();
  function spendRef(key) {
    const t = env.now(), times = (refTimes.get(key) || []).filter((x) => t - x < 3600000);
    refTimes.set(key, times);
    if (times.length >= NOTICE_REFS_PER_HOUR) return false;
    times.push(t);
    if (refTimes.size > 1000) refTimes.delete(refTimes.keys().next().value);
    return true;
  }
  /**
   * handleNotice(n, msg): msg is the chat message that carried the notice (chat.js onNotice); without msg the notice comes from a followed
   * window (scanSynced), which is that ledger's own word. A notice's `from` is typed by its sender (SYB-12), so a chat notice counts only
   * when this browser holds the ledger it names and that ledger's owner is the key the loader authenticated (msg.from.pub); a notice
   * speaks only for blocks of its own ledger; a blocked key is dropped; one key puts at most NOTICE_REFS_PER_HOUR refs before the wall setting.
   */
  function handleNotice(n, msg) {
    const o = own();
    if (!n || n.from === state.siteId) return;
    const sender = views.get(n.from);
    const pubOfSender = sender && sender.owner;
    if (n.ref && n.ref.l !== n.from) return;
    if (msg !== undefined) {
      const key = msg && msg.from && typeof msg.from.pub === 'string' ? msg.from.pub : '';
      if (!key || blockedSet().has(key) || pubOfSender !== key) return;
    }
    if (pubOfSender && blockedSet().has(pubOfSender)) return;
    const walled = (n.k === 'reply' || n.k === 'wall') && isHome() && o;
    if (walled && msg !== undefined && !spendRef(pubOfSender)) return;
    pushNotice(n);
    if (walled) {
      const decision = M.wallDecision(M.wallMode(o) || DEFAULT_WALL, { fromLedger: n.from, followed: followedIds(), blocked: blockedSet(), fromPub: sender && sender.owner });
      if (n.k === 'reply' && n.target && n.target.l !== state.siteId) return; // not a comment on one of your posts
      if (decision === 'accept') queueOk([n.ref]);
      else if (decision === 'queue') store.set(SK.wallQueue, wallQueue().concat([{ id: n.k + '|' + n.ref.l + '/' + n.ref.h, ref: n.ref, from: n.from, k: n.k, t: env.now() }]).slice(-LIMITS.requestsInbox));
    }
  }
  const wallQueue = () => store.get(SK.wallQueue, []);
  function decideWall(id, accept) {
    const item = wallQueue().find((x) => x.id === id);
    store.set(SK.wallQueue, wallQueue().filter((x) => x.id !== id));
    if (item && accept) queueOk([item.ref]);
    changed();
  }
  function queueOk(refs) {
    const q = store.get(SK.okQueue, []);
    const have = new Set(q.map(M.refKey));
    store.set(SK.okQueue, q.concat(refs.filter((r) => M.isRef(r) && !have.has(M.refKey(r)))));
    if (store.get(SK.okQueue, []).length >= LIMITS.okRefs) flushOk().catch(noop);
  }
  /** flushOk(): publish the accepted refs as mw.ok items of at most 20 refs (and under the value cap), once. */
  let flushing = null;
  function flushOk() {
    if (flushing) return flushing; // one flush at a time: a second call must not publish the same refs again
    flushing = doFlushOk().finally(() => { flushing = null; });
    return flushing;
  }
  async function doFlushOk() {
    if (!isHome()) return 0;
    const o = own();
    const pending = M.pendingOkRefs(store.get(SK.okQueue, []), o ? o.oks : new Set());
    if (!pending.length) { store.set(SK.okQueue, []); return 0; }
    let sent = 0;
    for (const batch of M.batchRefs(pending, { maxBytes: (o && o.policy.maxValueBytes) || LIMITS.valueBytes })) {
      await mw.db.append(LISTS.ok, { refs: batch });
      sent += batch.length;
      const done = new Set(batch.map(M.refKey));
      store.set(SK.okQueue, store.get(SK.okQueue, []).filter((r) => !done.has(M.refKey(r))));
    }
    return sent;
  }
  function markNoticesSeen() { store.set(SK.notices, markAllSeen(notices())); changed(); }
  const unseen = () => unseenCount(notices()) + wallQueue().length;

  // ------------------------------------------------------------------------------------------ export and delete
  /**
   * exportData({ record, recordError }) -> the "Download my data" file (R 3.3): the lists, keys and names of this page's ledger as this browser
   * holds them, the device-local state, and the private record's fields when the person opened it for the export (record), or why they are
   * missing (recordError). The signed entries themselves are not given to the page by the SDK: the file says where the loader exports them.
   */
  function exportData({ record, recordError } = {}) {
    const o = own();
    const out = {
      app: 'felinar social template', exportedAt: new Date(env.now()).toISOString(), ledger: state.siteId, label: state.label,
      name: o ? o.name : '', note: 'Items as this browser holds them: lists, keys and names. Private photos and videos are saved one by one from the Media page.',
      signedEntries: SIGNED_ENTRIES_NOTE,
      lists: ownSnap ? ownSnap.lists : {}, keys: ownSnap ? ownSnap.kv : {}, names: ownSnap ? ownSnap.profiles : {},
      local: { drafts: store.get(SK.drafts, []), blocked: store.get(SK.blocked, []), hidden: store.get(SK.hidden, []), privateFollows: privateFollows() },
    };
    if (record !== undefined) out.privateRecord = record;
    else out.privateRecordNote = 'Your private record is not in this file' + (recordError ? ' (' + recordError + ')' : '') + '. "Download my private record" saves it on its own.';
    return out;
  }
  /** ownPayloads(): every item hash on this page's own ledger, newest first, for "Delete my page". */
  function ownPayloads() {
    const out = [];
    if (ownSnap) for (const name of Object.keys(ownSnap.lists || {})) for (const it of ownSnap.lists[name] || []) if (it && typeof it.h === 'string' && it.author === (state.identity && state.identity.pub)) out.push({ list: name, h: it.h });
    return out;
  }
  /**
   * ownKeys() -> [{ key, h }]: the keys of your own page's ledger that hold a value you set, for "Delete my page": your reactions
   * ('re/<ledger>/<h>'), your author-scoped keys ('@<your scope>/...') and any other plain key. Keys that start with '_' are the loader's
   * (_mw.cfg, _deny/, _roles/, _notice): the page's settings and moderation, not something you wrote about yourself, so they stay. On a
   * personal page only its owner writes plain keys; where the snapshot names an entry ({ v, author, h, ts }) only your own are listed, with
   * the entry's hash h. The SDK's snapshot gives a key's value only (docs/SDK.md), so h is null there: deleting the key hides it, and
   * its earlier value stays in copies of the ledger.
   */
  function ownKeys() {
    const out = [];
    const me = state.identity && state.identity.pub;
    if (!ownSnap || !ownSnap.kv || !me || !isHome()) return out;
    const scope = authorScope(me);
    for (const key of Object.keys(ownSnap.kv)) {
      if (key.charAt(0) === '_') continue;
      if (key.charAt(0) === '@' && !key.startsWith(scope)) continue;
      const e = ownSnap.kv[key];
      const rec = e && typeof e === 'object' && !Array.isArray(e) && 'v' in e && 'h' in e ? e : null;
      if (rec && typeof rec.author === 'string' && rec.author !== me) continue;
      const v = rec ? rec.v : e;
      if (v === null || v === undefined) continue;
      out.push({ key, h: rec && typeof rec.h === 'string' ? rec.h : null });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  return {
    state, on, emit, start, stop, views, own, viewOf, labelOf, idOfLabel, nameOf, shortOwner, ownerName, ledgerForShort, learnLedgers,
    signedIn, isHome, canWrite, isModerator, followedIds, privateFollows, timeline, timelineViews, status, followCap, isFollowing, peek, release, commentCounts,
    get version() { return version; },
    blockedSet, hiddenSet, notices, wallQueue, unseen, markNoticesSeen, decideWall, flushOk, queueOk, handleNotice,
    addPost, editPost, deleteVersions, addComment, editComment, shareItem, react, saveProfile, setWall, ensureFeature,
    follow, unfollow, loadPrivate, block, unblock, hide, unhide, exportData, ownPayloads, ownKeys, syncFollowed,
    refresh: async () => { applyInfo(await mw.ready()); classify(); emit('auth'); changed(); },
  };
}
