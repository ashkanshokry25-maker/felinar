// Private groups (R 2.7.7, D-C7, MF-37). Deterministic without an ordering service:
//   epochId = SHA-256(prevEpochId (32) | creatorPub (65 raw) | commit (32)), commit = SHA-256(newSecret);
//   the genesis prevEpochId is 32 zero bytes.
//   Rekey on every add and every removal (newcomers read nothing from before they joined).
//   Concurrent rekeys (two children of one epoch), code review v0.3 "removals win":
//     - a child whose creator is removed anywhere below its parent (in a sibling or a known descendant) is refused,
//       and a stored child whose creator a later sibling removes stops counting: no member ever encrypts to a secret
//       made by a key in the union of removals;
//     - a child is accepted only while its parent is current or within the 7-day grace after the parent was replaced;
//     - among the children left, the one with the largest removal set wins, then the lowest SHA-256(prev | creator),
//       then the lowest epochId (the creator cannot grind the first two; epochId only orders one creator's children);
//     - members accept the union of removals: a member a losing sibling removed is not an effective member of the
//       winner until an admin re-applies the removal (every admin of the winner does), and the losing admin re-applies
//       its additions ("Two admins changed the group at once; the group now uses the newer key").
//   The admin list { admins, by, t, sig } is signed by the creator or an existing admin and checked on
//   every rekey. Up to 32 members (chosen). Members keep listening on the previous epoch for 7 days
//   (chosen) to receive the rekey invite.
// Signed records (new prefixes, deviation D-4):
//   admin list: "mw-grp-admin-v1\n" + JCS({ ledger, groupId, admins, by, t })
//   commit:     "mw-grp-commit-v1\n" + JCS(record without sig)
// Records travel inside sealed invites (kind invite, hold flag); nothing here touches the ledger.
// toJSON() / GroupState.fromJSON() keep every epoch of the grace window (with the parents its siblings are checked
// against), so a reload keeps the previous epoch's secret and still accepts the sibling that wins.
//
// Shared code: no Buffer, no node: imports.

import { canonicalize, utf8, hex, b64url, concatBytes } from '../chain/canonical.js';
import { sha256Sync } from '../chain/sha256-sync.js';
import { publicKeyBytes, verify, isPublicKeyString } from '../chain/crypto.js';
import { GROUP_MAX, GROUP_GRACE_MS, GROUP_ADMIN_PREFIX, GROUP_COMMIT_PREFIX, GROUP_NAME_MAX } from './limits.js';

export const GENESIS = new Uint8Array(32);
const GENESIS_HEX = hex.encode(GENESIS);
const ID_RE = /^[0-9a-f]{64}$/;

function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function err(code, msg) {
  return Object.assign(new Error(msg), { code });
}

/** epochId = SHA-256(prev | creator raw | commit). Synchronous. */
export function nextEpochId(prev, creator, commit) {
  const p = prev || GENESIS;
  if (!(p instanceof Uint8Array) || p.length !== 32) throw new TypeError('nextEpochId: prev is 32 bytes');
  if (!(commit instanceof Uint8Array) || commit.length !== 32) throw new TypeError('nextEpochId: commit is 32 bytes');
  return sha256Sync(concatBytes(p, publicKeyBytes(creator), commit));
}

/** commit = SHA-256(secret). */
export function commitOf(secret) {
  return sha256Sync(secret);
}

function compareBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function idBytes(x) {
  return x instanceof Uint8Array ? x : hex.decode(x);
}

/** The tie-break key a creator cannot grind: hex(SHA-256(prev (32) | creator raw (65))). */
export function tieKey(prev, creator) {
  try {
    return hex.encode(sha256Sync(concatBytes(idBytes(prev), publicKeyBytes(creator))));
  } catch (_) {
    return 'g'; // sorts after every hex key
  }
}

/** rank(a, b) for sort(): the largest removal set first, then the lowest tieKey, then the lowest epochId. */
function rank(a, b) {
  const ra = (a.removed || []).length;
  const rb = (b.removed || []).length;
  if (ra !== rb) return rb - ra;
  const ta = a.prev !== undefined && a.creator !== undefined ? tieKey(a.prev, a.creator) : '';
  const tb = b.prev !== undefined && b.creator !== undefined ? tieKey(b.prev, b.creator) : '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return compareBytes(idBytes(a.epochId), idBytes(b.epochId));
}

/**
 * resolveConcurrent(children) -> the winning child (largest removal set, then lowest SHA-256(prev | creator), then
 * lowest epochId) with `removed` set to the union of every child's removals and `losers` listing the other children.
 * children: [{ epochId, removed, prev?, creator?, ... }] (records, or summaries of them).
 */
export function resolveConcurrent(children) {
  if (!Array.isArray(children) || children.length === 0) throw new TypeError('resolveConcurrent: no children');
  const sorted = children.slice().sort(rank);
  const removed = new Set();
  for (const c of children) for (const r of c.removed || []) removed.add(r);
  return Object.assign({}, sorted[0], { removed: Array.from(removed).sort(), losers: sorted.slice(1) });
}

// ---------------------------------------------------------------------------------------------
// Signed records
// ---------------------------------------------------------------------------------------------

function adminBody(a) {
  return { ledger: a.ledger, groupId: a.groupId, admins: a.admins, by: a.by, t: a.t };
}

export async function signAdminList({ ledger, groupId, admins, signer, t }) {
  const list = { ledger, groupId, admins: Array.from(new Set(admins)).sort(), by: signer.pub, t };
  const sig = await signer.sign(utf8.encode(GROUP_ADMIN_PREFIX + canonicalize(adminBody(list))));
  return Object.assign(list, { sig: b64url.encode(sig) });
}

/** verifyAdminList(list, { ledger, groupId, allowedSigners }) -> boolean. */
export async function verifyAdminList(list, { ledger, groupId, allowedSigners }) {
  if (!list || typeof list !== 'object') return false;
  if (list.ledger !== ledger || list.groupId !== groupId) return false;
  if (!Array.isArray(list.admins) || list.admins.length === 0 || list.admins.length > GROUP_MAX) return false;
  for (const a of list.admins) if (!isPublicKeyString(a)) return false;
  if (!isPublicKeyString(list.by) || !Number.isSafeInteger(list.t)) return false;
  if (allowedSigners.indexOf(list.by) < 0) return false;
  return verify(list.by, utf8.encode(GROUP_ADMIN_PREFIX + canonicalize(adminBody(list))), list.sig);
}

function commitBody(r) {
  const out = {};
  for (const k of Object.keys(r)) if (k !== 'sig') out[k] = r[k];
  return out;
}

async function signCommit(record, signer) {
  const sig = await signer.sign(utf8.encode(GROUP_COMMIT_PREFIX + canonicalize(commitBody(record))));
  return Object.assign({}, record, { sig: b64url.encode(sig) });
}

function cleanMembers(list) {
  const out = Array.from(new Set(list)).sort();
  for (const m of out) if (!isPublicKeyString(m)) throw err('E_BAD_REQUEST', 'members are p256: site keys');
  return out;
}

const finiteOrNull = (x) => (Number.isFinite(x) ? x : null);

// ---------------------------------------------------------------------------------------------
// Group state of one member
// ---------------------------------------------------------------------------------------------

/**
 * GroupState: the epochs one member knows. Epoch records:
 *   { v: 1, ledger, groupId, name, prev, epochId, creator, commit, members, removed, admins (signed list), t, sig }
 * prev, epochId and commit are hex; members, removed and the admin list hold p256: site keys.
 * Per epoch this member keeps { record, secret|null, since, until, replacedAt, seq }: until is the end of the grace
 * listening after the epoch stopped being current (replacedAt), seq the arrival order.
 */
export class GroupState {
  constructor({ ledgerId, groupId, me, now = () => Date.now() }) {
    this.ledgerId = ledgerId;
    this.groupId = groupId;
    this.me = me;
    this.now = now;
    this.epochs = new Map(); // epochId hex -> { record, secret|null, since, until, replacedAt, seq }
    this.children = new Map(); // prev hex -> [records], in arrival order
    this.current = null; // epochId hex
    this.root = GENESIS_HEX; // where the walk starts: the genesis, the parent of the adopted epoch, or a settled epoch
    this.rootAdmins = null; // the admins the root's children are checked against when the root's record is not held
    this.rootReplacedAt = null; // when the root stopped being current (stale-parent for its children)
    this.basePending = []; // removals of concurrent rekeys above the root that the path has not applied yet
    this.pending = []; // the union of removals not yet applied in the current epoch
    this.seq = 0;
    this.left = false;
  }

  /** create({ ledgerId, name, creator: { pub, sign }, members, now }) -> { state, record, secret } */
  static async create({ ledgerId, name = '', creator, members = [], now = () => Date.now(), groupId }) {
    if (typeof name !== 'string' || name.length > GROUP_NAME_MAX) throw err('E_BAD_REQUEST', 'group name up to ' + GROUP_NAME_MAX + ' characters');
    const all = cleanMembers([creator.pub].concat(members));
    if (all.length > GROUP_MAX) throw err('E_LIMIT', 'a group has at most ' + GROUP_MAX + ' members');
    const gid = groupId || b64url.encode(randomBytes(16));
    const state = new GroupState({ ledgerId, groupId: gid, me: creator.pub, now });
    const admins = await signAdminList({ ledger: ledgerId, groupId: gid, admins: [creator.pub], signer: creator, t: now() });
    const { record, secret } = await state._commit({ prev: GENESIS, signer: creator, members: all, removed: [], admins, name });
    await state.receive(record, secret);
    return { state, record, secret };
  }

  async _commit({ prev, signer, members, removed, admins, name }) {
    const secret = randomBytes(32);
    const commit = commitOf(secret);
    const epochId = nextEpochId(prev, signer.pub, commit);
    const record = await signCommit({
      v: 1, ledger: this.ledgerId, groupId: this.groupId, name, prev: hex.encode(prev), epochId: hex.encode(epochId),
      creator: signer.pub, commit: hex.encode(commit), members, removed, admins, t: this.now(),
    }, signer);
    return { record, secret };
  }

  /** The current epoch record, or null. */
  record() {
    const e = this.current && this.epochs.get(this.current);
    return e ? e.record : null;
  }

  members() {
    const r = this.record();
    return r ? r.members.slice() : [];
  }

  /** Members after the union of removals of every concurrent sibling seen (R 2.7.7). */
  effectiveMembers() {
    const rm = new Set(this.pending);
    return this.members().filter((m) => !rm.has(m));
  }

  admins() {
    const r = this.record();
    return r ? r.admins.admins.slice() : [];
  }

  /** An admin of the current epoch whom no concurrent rekey removed. */
  isAdmin(pub) {
    return this.admins().indexOf(pub) >= 0 && this.pending.indexOf(pub) < 0;
  }

  /** The secret of an epoch (hex id), or null. */
  secretFor(epochIdHex) {
    const e = this.epochs.get(epochIdHex);
    return e && e.secret ? e.secret : null;
  }

  /** Epochs this member still listens on: the current one and, for 7 days, the ones it replaced. */
  listening() {
    const now = this.now();
    const out = [];
    for (const [id, e] of this.epochs) {
      if (!e.secret) continue;
      if (id === this.current || (e.until !== null && e.until > now)) out.push({ epochId: hex.decode(id), secret: e.secret, current: id === this.current });
    }
    return out;
  }

  /**
   * rekey({ signer, add = [], remove = [], admins? }) -> { record, secret }. Admins only. Every add and
   * removal makes a new epoch; the union of removals not yet applied (pending) goes with it, unless the call adds
   * that member back explicitly.
   */
  async rekey({ signer, add = [], remove = [], admins }) {
    const cur = this.record();
    if (!cur) throw err('E_NOT_MEMBER', 'not a member of this group');
    if (!this.isAdmin(signer.pub)) throw err('E_NOT_ADMIN', 'only an admin of the group can change it');
    const removeSet = new Set(remove.concat(this.pending.filter((p) => add.indexOf(p) < 0)));
    const members = cleanMembers(cur.members.concat(add).filter((m) => !removeSet.has(m)));
    if (members.length > GROUP_MAX) throw err('E_LIMIT', 'a group has at most ' + GROUP_MAX + ' members');
    let adminList = cur.admins;
    const nextAdmins = (admins || cur.admins.admins).filter((a) => members.indexOf(a) >= 0);
    if (admins || nextAdmins.length !== cur.admins.admins.length) {
      if (nextAdmins.length === 0) throw err('E_BAD_REQUEST', 'a group needs an admin');
      adminList = await signAdminList({ ledger: this.ledgerId, groupId: this.groupId, admins: nextAdmins, signer, t: this.now() });
    }
    const removed = cleanMembers(Array.from(removeSet).filter((m) => cur.members.indexOf(m) >= 0));
    const out = await this._commit({ prev: hex.decode(cur.epochId), signer, members, removed, admins: adminList, name: cur.name });
    await this.receive(out.record, out.secret);
    return out;
  }

  /**
   * Checks a commit record against its parent epoch: signature, admin standing of the creator under the
   * parent's admin list (or, for a sibling of the adopted epoch, the adopted epoch's admin list), the admin list's
   * own signature, epochId arithmetic, the member cap.
   */
  async verifyRecord(record, secret, { adopting = false } = {}) {
    try {
      if (!record || record.v !== 1 || record.ledger !== this.ledgerId || record.groupId !== this.groupId) return { ok: false, reason: 'group' };
      if (typeof record.epochId !== 'string' || !ID_RE.test(record.epochId) || typeof record.prev !== 'string' || !ID_RE.test(record.prev)) return { ok: false, reason: 'record' };
      if (!Array.isArray(record.members) || record.members.length === 0 || record.members.length > GROUP_MAX) return { ok: false, reason: 'members' };
      if (!Array.isArray(record.removed)) return { ok: false, reason: 'removed' };
      for (const m of record.members.concat(record.removed)) if (!isPublicKeyString(m)) return { ok: false, reason: 'members' };
      for (const r of record.removed) if (record.members.indexOf(r) >= 0) return { ok: false, reason: 'removed' };
      if (!isPublicKeyString(record.creator)) return { ok: false, reason: 'creator' };
      const prev = hex.decode(record.prev);
      const commit = hex.decode(record.commit);
      if (hex.encode(nextEpochId(prev, record.creator, commit)) !== record.epochId) return { ok: false, reason: 'epoch-id' };
      if (secret && hex.encode(commitOf(secret)) !== record.commit) return { ok: false, reason: 'commit' };
      const genesis = record.prev === GENESIS_HEX;
      let parentAdmins;
      if (genesis) {
        parentAdmins = [record.creator];
      } else if (adopting) {
        parentAdmins = record.admins.admins; // trust on first use: a newcomer has no parent chain
      } else {
        const parent = this.epochs.get(record.prev);
        if (parent) parentAdmins = parent.record.admins.admins;
        else if (record.prev === this.root && Array.isArray(this.rootAdmins)) parentAdmins = this.rootAdmins;
        else return { ok: false, reason: 'unknown-parent' };
      }
      if (parentAdmins.indexOf(record.creator) < 0) return { ok: false, reason: 'not-admin' };
      const okAdmins = await verifyAdminList(record.admins, { ledger: this.ledgerId, groupId: this.groupId, allowedSigners: parentAdmins });
      if (!okAdmins) return { ok: false, reason: 'admin-list' };
      for (const a of record.admins.admins) if (record.members.indexOf(a) < 0) return { ok: false, reason: 'admin-not-member' };
      const okSig = await verify(record.creator, utf8.encode(GROUP_COMMIT_PREFIX + canonicalize(commitBody(record))), record.sig);
      if (!okSig) return { ok: false, reason: 'signature' };
      return { ok: true };
    } catch (_) {
      return { ok: false, reason: 'record' };
    }
  }

  /** Every removal made in a stored descendant of epoch `id` (the epoch itself excluded). */
  _below(id) {
    const out = new Set();
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      const at = stack.pop();
      if (seen.has(at)) continue;
      seen.add(at);
      for (const k of this.children.get(at) || []) {
        for (const r of k.removed) out.add(r);
        stack.push(k.epochId);
      }
    }
    return out;
  }

  /** The policy checks of a new verified record: one genesis, a parent still open for siblings, a creator not removed. */
  _admit(record) {
    if (record.prev === GENESIS_HEX) return this.epochs.size === 0 ? { ok: true } : { ok: false, reason: 'genesis' };
    if (record.prev !== this.current) {
      const parent = this.epochs.get(record.prev);
      const replacedAt = parent ? parent.replacedAt : (record.prev === this.root ? this.rootReplacedAt : null);
      if (Number.isFinite(replacedAt) && this.now() - replacedAt > GROUP_GRACE_MS) return { ok: false, reason: 'stale-parent' };
    }
    if (this._below(record.prev).has(record.creator)) return { ok: false, reason: 'creator-removed' };
    return { ok: true };
  }

  _store(record, secret, meta = null) {
    const t = this.now();
    const e = { record, secret: secret || null, since: t, until: null, replacedAt: null, seq: ++this.seq };
    if (meta) Object.assign(e, meta);
    this.epochs.set(record.epochId, e);
    const sibs = this.children.get(record.prev) || [];
    sibs.push(record);
    this.children.set(record.prev, sibs);
  }

  /**
   * The walk from the root: at every epoch keep the children whose creator no qualified sibling (or concurrent rekey
   * above) removed, in arrival order, a later sibling's removals excluding an earlier one; follow the best by rank;
   * the losing qualified siblings' removals join the pending union until the path drops those members.
   */
  _resolve() {
    const pending = new Set(this.basePending);
    const path = [];
    const pendingAt = [];
    const levels = [];
    const memo = new Map();
    const sub = (k) => {
      let s = memo.get(k.epochId);
      if (!s) {
        s = new Set(k.removed);
        for (const r of this._below(k.epochId)) s.add(r);
        memo.set(k.epochId, s);
      }
      return s;
    };
    let at = this.root;
    for (let guard = 0; guard < 100000; guard++) {
      const kids = this.children.get(at) || [];
      if (!kids.length) break;
      const q = [];
      for (const k of kids) {
        if (pending.has(k.creator)) continue; // never a secret made by a key in the union of removals
        if (q.some((x) => sub(x).has(k.creator))) continue;
        const mine = sub(k);
        for (let i = q.length - 1; i >= 0; i--) if (mine.has(q[i].creator)) q.splice(i, 1);
        q.push(k);
      }
      if (!q.length) break;
      const sorted = q.slice().sort(rank);
      const winner = sorted[0];
      for (const k of sorted.slice(1)) for (const r of sub(k)) pending.add(r);
      for (const m of Array.from(pending)) if (winner.members.indexOf(m) < 0) pending.delete(m);
      levels.push({ at, qualified: sorted, winner });
      path.push(winner.epochId);
      pendingAt.push(Array.from(pending));
      at = winner.epochId;
    }
    return { current: path.length ? path[path.length - 1] : null, pending, path, pendingAt, levels };
  }

  /** Additions of this member's losing rekeys that the current epoch lacks (the losing admin re-applies them). */
  _readd(r) {
    const cur = this.record();
    if (!cur) return [];
    const out = new Set();
    for (let i = 0; i < r.levels.length; i++) {
      const lv = r.levels[i];
      if (lv.qualified.length < 2) continue;
      const parent = this.epochs.get(lv.at);
      if (!parent) continue;
      const pathRemoved = new Set();
      for (let j = i; j < r.levels.length; j++) for (const x of r.levels[j].winner.removed) pathRemoved.add(x);
      for (const k of lv.qualified) {
        if (k === lv.winner || k.creator !== this.me) continue;
        for (const m of k.members) {
          if (parent.record.members.indexOf(m) >= 0) continue;
          if (cur.members.indexOf(m) >= 0 || this.pending.indexOf(m) >= 0 || pathRemoved.has(m)) continue;
          out.add(m);
        }
      }
    }
    return Array.from(out).sort();
  }

  /**
   * reapplyPlan() -> { remove, add }: what this member, as an admin of the current epoch, re-applies now: the union of
   * removals the current epoch still lists, and the additions of its own rekeys that lost. Empty for a non-admin.
   */
  reapplyPlan() {
    const cur = this.record();
    if (!cur || !this.isAdmin(this.me)) return { remove: [], add: [] };
    return { remove: this.pending.filter((m) => cur.members.indexOf(m) >= 0), add: this._readd(this._resolve()) };
  }

  /** Recomputes the current epoch after a change; returns the receive() result for `record`. */
  _settle(record) {
    const before = this.current;
    const r = this._resolve();
    this.current = r.current;
    this.pending = Array.from(r.pending).sort();
    const t = this.now();
    const changed = before !== this.current;
    if (changed) {
      const old = before ? this.epochs.get(before) : null;
      if (old) {
        old.replacedAt = t;
        old.until = t + GROUP_GRACE_MS;
      }
      const cur = this.current ? this.epochs.get(this.current) : null;
      if (cur) {
        cur.replacedAt = null;
        cur.until = null;
      }
    }
    const winner = this.record();
    const conflict = !!record && (this.children.get(record.prev) || []).length > 1;
    let reapply = [];
    let readd = [];
    if (winner && this.isAdmin(this.me)) {
      reapply = this.pending.filter((m) => winner.members.indexOf(m) >= 0);
      readd = this._readd(r);
    }
    this.left = !winner || this.effectiveMembers().indexOf(this.me) < 0;
    return { ok: true, current: this.current, changed, conflict, reapply, readd };
  }

  /**
   * receive(record, secret?) -> { ok, current, changed, conflict, reapply, readd } | { ok: false, reason }. Accepts
   * a verified commit (refused: 'genesis' for a second genesis, 'stale-parent' when the parent was replaced more than
   * 7 days ago, 'creator-removed' when a known epoch below the parent removed the creator), resolves concurrent
   * children (removals win, then the rank of resolveConcurrent) and moves the current epoch. secret is null for a
   * member who was removed (it learns of the epoch but cannot read it). reapply lists the union of removals the
   * current epoch still has (every admin re-applies them); readd the additions of this member's losing rekeys.
   */
  async receive(record, secret = null) {
    const v = await this.verifyRecord(record, secret);
    if (!v.ok) return v;
    const known = this.epochs.get(record.epochId);
    if (known) {
      if (!known.secret && secret) known.secret = secret;
      return { ok: true, current: this.current, changed: false, conflict: false, reapply: [], readd: [] };
    }
    const a = this._admit(record);
    if (!a.ok) return a;
    this._store(record, secret);
    return this._settle(record);
  }

  /**
   * adopt(record, secret) -> receive() result. A newcomer's first epoch: the invite carries the current record
   * without its parents, so it is checked on its own (creator in its admin list, the admin list signed by one
   * of its admins, epochId and commit arithmetic, the creator's signature) and becomes the root of the walk.
   * Siblings of the adopted epoch are later checked against its admin list.
   */
  async adopt(record, secret) {
    if (this.current) return this.receive(record, secret);
    if (!secret) return { ok: false, reason: 'no-secret' };
    const v = await this.verifyRecord(record, secret, { adopting: true });
    if (!v.ok) return v;
    this.epochs.clear();
    this.children.clear();
    this.root = record.prev;
    this.rootAdmins = record.admins.admins.slice();
    this.rootReplacedAt = record.prev === GENESIS_HEX ? null : this.now();
    this.basePending = [];
    this._store(record, secret);
    return this._settle(record);
  }

  /**
   * readopt(record, secret) -> receive() result: an epoch whose parent this member does not hold, from an admin of
   * its current epoch (the caller checks that), becomes the new root, as for a newcomer. The epochs held so far stay
   * for their grace listening; the walk no longer reaches them.
   */
  async readopt(record, secret) {
    if (!secret) return { ok: false, reason: 'no-secret' };
    if (this.epochs.has(record.epochId)) return this.receive(record, secret);
    const v = await this.verifyRecord(record, secret, { adopting: true });
    if (!v.ok) return v;
    this.root = record.prev;
    this.rootAdmins = record.admins.admins.slice();
    this.rootReplacedAt = this.now();
    this.basePending = [];
    this._store(record, secret);
    return this._settle(record);
  }

  /**
   * prune(): moves the root down the current path past epochs replaced more than the grace window ago (no sibling
   * below them is accepted any more; the removals they left pending stay in basePending) and drops the epochs the
   * walk no longer reaches once their grace listening is over.
   */
  prune() {
    const r = this._resolve();
    const t = this.now();
    let j = -1;
    for (let i = 0; i < r.path.length - 1; i++) {
      const e = this.epochs.get(r.path[i]);
      if (e && Number.isFinite(e.replacedAt) && t - e.replacedAt > GROUP_GRACE_MS) j = i;
    }
    if (j >= 0) {
      const e = this.epochs.get(r.path[j]);
      this.root = r.path[j];
      this.rootAdmins = e.record.admins.admins.slice();
      this.rootReplacedAt = e.replacedAt;
      this.basePending = r.pendingAt[j].slice();
    }
    const keep = new Set();
    const stack = [this.root];
    while (stack.length) {
      const at = stack.pop();
      for (const k of this.children.get(at) || []) {
        if (keep.has(k.epochId)) continue;
        keep.add(k.epochId);
        stack.push(k.epochId);
      }
    }
    for (const [id, e] of Array.from(this.epochs)) {
      if (keep.has(id) || id === this.current) continue;
      if (e.secret && e.until !== null && e.until > t) continue; // still listening on it
      this.epochs.delete(id);
    }
    for (const [prev, list] of Array.from(this.children)) {
      const kept = list.filter((k) => this.epochs.has(k.epochId));
      if (kept.length) this.children.set(prev, kept);
      else this.children.delete(prev);
    }
  }

  /** toJSON() -> the persisted state (secrets base64url), after prune(). */
  toJSON() {
    this.prune();
    const epochs = [];
    for (const e of this.epochs.values()) {
      epochs.push({
        record: e.record, secret: e.secret ? b64url.encode(e.secret) : null, since: e.since, until: e.until,
        replacedAt: e.replacedAt, seq: e.seq,
      });
    }
    epochs.sort((a, b) => a.seq - b.seq);
    return {
      v: 2, groupId: this.groupId, root: this.root, rootAdmins: this.rootAdmins, rootReplacedAt: this.rootReplacedAt,
      basePending: this.basePending.slice(), seq: this.seq, epochs,
    };
  }

  /**
   * GroupState.fromJSON(saved, { ledgerId, me, now }) -> GroupState | null. Every record is verified again against
   * its stored parent (or the root's admin list); an epoch kept only for its grace listening whose parent is gone is
   * checked on its own. The current epoch is recomputed by the walk.
   */
  static async fromJSON(saved, { ledgerId, me, now = () => Date.now() } = {}) {
    if (!saved || saved.v !== 2 || typeof saved.groupId !== 'string' || !Array.isArray(saved.epochs)) return null;
    if (typeof saved.root !== 'string' || !ID_RE.test(saved.root)) return null;
    const st = new GroupState({ ledgerId, groupId: saved.groupId, me, now });
    st.root = saved.root;
    st.rootAdmins = Array.isArray(saved.rootAdmins) && saved.rootAdmins.every(isPublicKeyString) ? saved.rootAdmins.slice() : null;
    st.rootReplacedAt = finiteOrNull(saved.rootReplacedAt);
    st.basePending = Array.isArray(saved.basePending) ? saved.basePending.filter(isPublicKeyString) : [];
    const list = saved.epochs.filter((e) => e && e.record && Number.isSafeInteger(e.seq)).sort((a, b) => a.seq - b.seq);
    const t = now();
    for (const e of list) {
      let secret = null;
      try {
        secret = typeof e.secret === 'string' ? b64url.decode(e.secret) : null;
      } catch (_) {
        secret = null;
      }
      if (secret && secret.length !== 32) secret = null;
      if (st.epochs.has(e.record.epochId)) continue;
      let v = await st.verifyRecord(e.record, secret);
      const until = finiteOrNull(e.until);
      if (!v.ok && v.reason === 'unknown-parent' && secret && until !== null && until > t) v = await st.verifyRecord(e.record, secret, { adopting: true });
      if (!v.ok) continue;
      st._store(e.record, secret, { since: finiteOrNull(e.since) || t, until, replacedAt: finiteOrNull(e.replacedAt), seq: e.seq });
      st.seq = Math.max(st.seq, e.seq);
    }
    const r = st._resolve();
    st.current = r.current;
    st.pending = Array.from(r.pending).sort();
    st.left = !st.record() || st.effectiveMembers().indexOf(me) < 0;
    return st.current ? st : null;
  }
}
