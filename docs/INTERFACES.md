# felinar: Module interface contract v0.2, amended to v0.2.1 (binding for parallel implementation)

Supersedes v0.1 (`docs/review/INTERFACES-v0.1.md`). Normative with `docs/ARCHITECTURE.md` v0.2.
**v0.2.1:** contracts changed by `docs/review/DIGEST-AMENDMENTS.md` are marked "v0.2.1" in place (section
headings say which items); the verifier's cross-module fixes are marked "v0.2.1 (verifier)".
All code: ES modules, vanilla JavaScript, no TypeScript, no frameworks. Shared code (`src/common`,
`src/chain`) runs unchanged in Node ≥ 22 and browsers (`globalThis.crypto.subtle`, `TextEncoder`,
`Uint8Array`; no `Buffer`, no `node:` imports). Browser floor: Safari/iOS 15.4, Chromium 110, Firefox 115;
never use post-floor APIs (`Promise.withResolvers`, `Object.groupBy`, `Array.fromAsync`, Set methods,
`URL.parse`, `AbortSignal.any`, iterator helpers, regex `v` flag, `structuredClone` without fallback).
IndexedDB: build every value before opening a readwrite transaction and never `await` inside one.
Toolchain: `export PATH=$HOME/.local/share/node/current/bin:$PATH` (Node 24.22); deps installed; no new
packages without recording them in your deviations file. Existing files from the v0.1 build are drafts:
read them, keep what matches this contract, rewrite what does not.

Encoding helpers come from `src/chain/canonical.js` (exists, keep): `canonicalize`, `utf8`, `hex`,
`b64url`, `concatBytes`, `byteLength`. `src/chain/crypto.js` exists (keep): `sha256`, `generateKeyPair`,
`exportPublicKey`, `importPublicKey`, `sign`, `verify`, `exportPrivateJwk`, `importPrivateJwk`,
`publicFromPrivateJwk`, `fingerprint`.

**v0.2.1 algorithm-tagged keys (DIGEST-AMENDMENTS A2).** Every serialised public key is
`'p256:' + b64url(raw 65-byte point)` (92 characters, one canonical spelling): block authors, `owner.next`,
`ban.author`, `allow` lists, policy `moderators`/`allow`, the pointer's `owner=` (and so the ledger id and
the `rot=` input), the HELLO `owner`, identities stored by the loader, and what the SDK returns.
`exportPublicKey` and `publicFromPrivateJwk` return tagged strings; `importPublicKey`, `publicKeyBytes`,
`isPublicKeyString`, `verify` and `fingerprint` accept only tagged ones (untagged: "must be
algorithm-tagged"; an unknown tag: "unsupported key type: <tag>"; `verify` returns false). New in
`crypto.js`:
```
export const P256_TAG = 'p256', P256_PREFIX = 'p256:', KEY_ALGORITHMS = ['p256'], PUBLIC_KEY_STRING_LENGTH = 92   // PUBLIC_KEY_B64URL_LENGTH stays 87 (the body)
export function keyAlgorithm(value) → 'p256' | <other tag> | null      // syntactic
export function encodePublicKey(raw65) → 'p256:...'
export function fromUntaggedP256(b64) → 'p256:' + b64                  // ONLY for v0.2 test fixtures and identities stored before v0.2.1
export function shortKey(pub) → first 8 characters of the body (display fallback when fingerprint() is not at hand)
```
`fingerprint(pub)` still hashes the raw 65 bytes (the tag is not hashed).

## src/common/base32.js
```
export function encode(u8) → string (RFC 4648 lowercase, no padding)     export function decode(str) → Uint8Array
```
## src/common/bencode.js
```
export function encode(value) → Uint8Array      // strings/Uint8Array → byte strings, integers, arrays, plain objects (keys sorted bytewise)
export function decode(u8) → { value, spans }   // value: Uint8Array for byte strings (decode keys as utf8); spans: Map from object path ('info') to [start, end) byte offsets
```
## src/common/torrent-file.js
```
export async function parseTorrentFile(u8) → { infoHash (hex), name, pieceLength, pieces: Uint8Array, pieceCount,
   length, files: [{ path /* site-relative, no torrent-name prefix */, length, offset, pad: bool }], announce: [], urlList: [], infoBytes: Uint8Array }
export function pieceRangesForFile(parsed, fileIndex) → { first, last }
export function sliceForPiece(parsed, index) → [{ fileIndex, start, end }]      // byte ranges inside files covering the piece
export async function buildSingleFileTorrent({ name, content: Uint8Array, pieceLength, announce = [] }) → { torrentFile: Uint8Array, infoHash }  // the v0.2 anchor torrent (unused since v0.2.1 B2)
export async function sha1(u8) → Uint8Array
```
## src/common/magnet.js
```
export function normalizeBtih(str) → hex40 | null
export function parseMagnet(uri) → { btih, dn, tr: [], ws: [], xs: [] } | null
export function formatMagnet({ btih, dn, tr = [], ws = [], xs = [] }) → string   // xt, dn, tr..., ws..., xs...
```
## src/common/pointer.js  (ARCHITECTURE §4)  [changed in v0.2.1: A2, A3]
```
export function parsePointer(text) → { ok: true, record } | { ok: false, error }
  // record = { v, st, btih, dn, xs: [], ws: [], tr: [], chain, max, owner, gen, rot, cs, consent, aud, ct, lg, why, seq, exp, sig,
  //            extra: {k: v}, raw, signed, withdrawn }
  // v0.2.1: st/aud/ct/lg/why are parsed fields (signed like every key); why is percent-decoded like dn;
  // withdrawn = pointerStatus(record) === 'withdrawn'; a withdrawn record without btih= gets btih = ZERO_BTIH.
  // code review round 1: lo (the ledger owner after a key rotation, a tagged key) is a parsed field.
export function formatPointer(record) → string                       // key order v, st, btih, dn, xs, ws, tr, chain, max, owner, lo, gen, rot, cs, consent, aud, ct, lg, why, seq, exp, unknown keys, sig
export function signingInput(record, scope) → string                 // "mw-pointer-v1\n" + sorted k=v lines + "\n" + scope
export async function signPointer(record, scope, privateKey) → record  // record.owner must be a tagged key ('p256:...')
export async function verifyPointer(record, scope, { now = Date.now(), pinnedOwner = null, cachedSeq = null, allowExpired = false } = {})
  → { ok, reason, expired, rotated, owner, pinned, expiresAt, status, withdrawn }
  // reasons: 'unsigned','no-btih','bad-owner' (also an untagged or unknown-algorithm owner),'bad-sig','missing-exp','missing-seq',
  //          'expired','exp-too-far','seq-rollback','owner-changed', round 1 'seq-future' (seq > now + SEQ_FUTURE_MAX_S, fresh records)
  // code review round 1: owner judged before the floor; a cachedSeq more than SEQ_FUTURE_MAX_S ahead is ignored; exp-too-far has a one-day skew margin;
  //         an invalid lo= is 'bad-owner'
  // v0.2.1: status ('active'|'withdrawn') and withdrawn are on EVERY result. A valid withdrawal is { ok: true, withdrawn: true }
  // (never a failure: a caller that fell back to its cache would keep serving the withdrawn site). On ok + withdrawn the loader
  // stops serving and seeding the scope, deletes every stored version and shows why= (ARCHITECTURE §5.8).
export async function verifyRotation(record, previousOwner, scope = null) → boolean  // code review round 1: rot over "mw-rot-v2\n" + scope + "\n" + chain + "\n" + owner + "\n" + seq;
                                                                       //   v1 ("mw-rot-v1\n" + owner + "\n" + seq) still verifies (deprecated, never written)
export async function signRotation({ owner, seq, scope, chain }, previousPrivateKey) → b64url   // v2 when scope is given (every tool), v1 without
export function rotationInput(owner, seq, { scope, chain } = null) → string
export function ledgerIdFor(record, scope) → Promise<string>           // signed: "mw1:" + b64url(sha256(ledgerOwnerOf(record)|chain||scope)).slice(0,27); else "btih:" + btih
export function ledgerOwnerOf(record) → pub                            // code review round 1: lo= when present, else owner=
export const MAX_PUBLISH_EXP_DAYS = 399, SEQ_FUTURE_MAX_S = 86400, SEQ_PUBLISH_SLACK_S = 300   // code review round 1
export function hubLabelFor(record, ledgerId) → string                 // code review round 1: base32(sha256("mw-label-v1\n" + ("ledger\n" + ledgerId | "btih\n" + btih))).slice(0,32)
export function splitTxt(value) → string[]                             // ≤255 bytes per chunk, UTF-8 safe
export function joinTxtData(data) → string                             // DoH data quoting variants
export function magnetFromRecord(record, { defaultTrackers = [] } = {}) → string   // defaults only when !record.signed
                                                                       // v0.2.1: throws { code: 'E_WITHDRAWN' } for a withdrawn record
export function pickRecord(records) → record | null                    // several TXT: highest valid seq, ties smallest sig
// v0.2.1 (A3):
export const POINTER_SIZE_SHOULD = 450, POINTER_SIZE_MAX = 900, TXT_STRING_MAX = 255, ZERO_BTIH = '0' x 40
export const STATUS_OK = 'ok', STATUS_WITHDRAWN = 'withdrawn', AUDIENCES = ['general','kids','sensitive'], WHY_CODES = ['owner','copyright','court','tos']
export function pointerStatus(record) → 'active' | 'withdrawn'          // FAIL-CLOSED: no st= or st=ok is active, ANY other value is withdrawn (code review round 1: an empty st= too)
export function isWithdrawn(record) → boolean
export function audienceTokens(record) → string[]                       // aud= tokens, lowercased (general, kids, sensitive, personal, eea, uk, qc, ...);
                                                                          // their meaning is the loader's consent policy (app.js consentModeFor)
export function pointerBudget(textOrRecord) → { bytes, strings, should, max, withinShould, withinMax }
export function withdrawalRecord({ owner, seq, exp, why, ct, chain, rot }) → unsigned record for signPointer:
  // v=mw1; st=withdrawn; btih=<40 zeros>; owner; [chain;] [rot;] [ct;] [why;] seq; exp: names no content (no xs, ws, tr, gen)
```
**MW-PTR/1 (v0.2.1, A3): the pointer grammar as a stated profile.** RFC 6376 tag-list with stated
deviations: keys are case-folded; `tr`, `ws`, `xs` repeat; unknown keys are kept and signed (a duplicate
single-valued key makes the record invalid); `v=mw1` first; values trimmed, controls refused. DNS: one
record may span several character-strings of at most 255 bytes (`splitTxt`), joined with **no**
separator (`joinTxtData`). **Size budget: SHOULD <= 450 bytes, MUST <= 900 bytes** (UTF-8 of the record
text). A realistic signed record (tagged owner, gen, two trackers, one web seed, xs) is about 520 to 540
bytes in 3 TXT strings: `publish.mjs` warns above 450 and refuses above 900 (`pointerBudget`). Golden
vectors: `test/vectors/pointer.json` (append only).

## src/common/withdrawal.js  (new in v0.2.1: A3, the loader side of a withdrawal)
```
export async function purgeWithdrawn({ cache, ledgerId, btihs = [], all = false }) → { deleted: string[], failed: string[] }
   // deletes versions:<ledgerId>, the given btihs and (all) every site stored on this origin; clears the list; never the zero btih; never throws
export function withdrawalNotice(record) → { why, ct }   // why without control/bidi characters, at most 200; ct only as an https: or mailto: URL
```
Used by `src/loader/app.js` (`presentWithdrawal` at boot when the resolved record is withdrawn: no frame,
every stored version deleted, `STRINGS.withdrawnTitle` / `withdrawnDetail({ why, ct })` /
`withdrawnContact`; `withdrawNow` when the page-tag or DNS update channel finds a withdrawal while the page
is open: the torrent client goes at once; `__mwShell.inspect().withdrawn = { why, ct, deleted }`), by
`src/dropin/engine.js` (`withdrawScope`: engine off with reason `withdrawn`, one warning with the reason,
`inspect().withdrawn`) and, through `record.withdrawn`, by `src/sw/core.js` (a drop-in page stamped with a
withdrawal is neither mapped to a stored copy nor kept for offline use).

## src/chain/sha256-sync.js
```
export function sha256Sync(u8) → Uint8Array      // pure JS, used only for mining in the worker
```
## src/chain/pow.js
```
export function leadingZeroBits(u8) → number
export async function hashEntry(entry) → { hashU8, hashHex }
export async function mine(entry, bits, { signal, onProgress, sha = sha256Sync } = {}) → { entry, h }   // throws { code: 'E_POW_ABORTED' }
export async function verifyPow(hashHex, bits) → boolean
```
`src/chain/pow-worker.js`: classic-bundle entry; `onmessage({ id, entry, bits })` → `{ id, entry, h }` |
`{ id, error }`; progress `{ id, progress }` every 2 000 hashes; `{ id, cancel: true }` aborts.
`src/chain/pow-client.js`: `createMiner({ workerUrl }) → { mine(entry, bits, { signal }), destroy() }`;
inline fallback without `Worker`.
`src/chain/verify-pool.js`: `createVerifierPool({ size = 2 }) → { verifyBlock(block, opts), destroy() }` (uses
`validateBlock`; worker-backed in browsers, inline in Node).

## src/chain/block.js  (ARCHITECTURE §6.1, §6.3)  [changed in v0.2.1: A1, A2]
```
export const LIMITS = { maxBlockBytes: 4096, maxPrev: 8, maxKey: 256, maxListName: 64, maxName: 48, maxChainBytesCeiling: 67108864, maxAllow: 1000, maxModerators: 50 }
export const DEFAULT_POLICY = { writers: 'owner', bits: 16, maxValueBytes: 2048, maxChainBytes: 8388608, moderators: [], allow: [] }
// Block = { e, h, s, v?, z? }: z (v0.2.1) is the value salt, present exactly when v is.
export const VH_PREFIX = 'mw-vh-v1\n', SALT_BYTES = 16, SALT_LENGTH = 22
export const PAYLOAD_OPS = ['put','append','profile'], CONTROL_OPS = ['policy','owner','tombstone','ban','allow']
export const FUTURE_CONTROL_OPS = ['checkpoint','vanish','grp'], RESERVED_OP_NAMES = PAYLOAD_OPS + CONTROL_OPS + FUTURE_CONTROL_OPS
export async function valueHash(value, z) → hex(sha256(utf8("mw-vh-v1\n" + z + "\n" + canonical(value))))   // v0.2.1: was valueHash(value)
export function valueHashSync(value, z) → hex                          // same, synchronous SHA-256 (dag.attachValue)
export function valueHashInput(value, z) → string                      // the hashed text
export function isSalt(z) → boolean     export function newSalt() → 22-character b64url of 16 random bytes (never the hashcash nonce)
export async function createBlock({ identity: { privateKey, pub }, site, seq, prev, op, value, ts, bits, miner, z }) → Block
   // op is the op WITHOUT vh for payload ops; createBlock draws z (only test vectors pass one), computes the salted vh, attaches v and z
export async function validateBlock(block, { minBits = 0, maxValueBytes = DEFAULT_POLICY.maxValueBytes, requireValue = false, site, genesisOwner } = {})
   → { ok: true } | { ok: false, reason }
   // reasons: 'shape' (incl. v without z, z without v, a malformed z, an untagged key),'size' (canonical(e) + canonical(v) + 22 for z),
   //          'hash','pow','sig','op','limit','unknown-op' (v0.2.1: an op.t v1 does not define, reserved names included),'value-hash','value-size'
export function isControlOp(op) → boolean     export function isPayloadOp(op) → boolean
export function blockBytes(block) → number     // canonical(e) + canonical(v) + 22 when z is held
export function redact(block) → Block          // { e, h, s }: drops v AND z; the stub reveals nothing guessable about v
export function validatePolicyFields(partial) → { ok, reason }
```
Unknown-op rule (v0.2.1): a block whose `op.t` is not a v1 op is invalid (`unknown-op`); `node.js` rejects
it at ingest, never stores or relays it, and gossip counts it toward the peer's invalid blocks. Golden
vectors: `test/vectors/block.json` (append only).
## src/chain/dag.js  (ARCHITECTURE §6.4)
```
export class Dag {
  add(block) → 'added' | 'duplicate' | 'orphan'
  has(h) / get(h) / depth(h) / size / bytes / orphanCount / root() → hex sha256 of sorted hashes / maxDepth()
  heads({ limit = 32 } = {}) → string[]   // by (depth desc, h asc)
  missing() → string[]                    // unknown prevs referenced by orphans
  order() → Block[]                       // sort by (depth, h), cached
  windows() → [{ k, dg, n }]              // 64-depth windows, dg = hex sha256(concat(sorted hashes as bytes))
  redact(h) → boolean / attachValue(h, v, z) → boolean   // v0.2.1: values are dropped and restored with their salt z (checked against vh)
  valueBytes(h) → canonical(v) bytes only (the maxValueBytes rule); bytes counts e + v + z
  hashesInWindow(k) → string[]            // sorted
  ancestors(h) → Set<string>              // memoised per control block by callers
  blocks() → Iterable<Block>
  dropOrphansFrom(peerId) / orphanSender(h) → peerId | null
}
```
## src/chain/state.js  (ARCHITECTURE §6.2, §6.5)
```
export function reduce(dag, { genesisOwner = null, expectedOwner = null, minBits = 0 } = {}) → State
  // State = { kv: Map<k, { v, author, h, ts }>, lists: Map<name, Item[]>, profiles: Map<pub, name>, owner, policy: { writers, bits, maxValueBytes, maxChainBytes, moderators: Set, allow: Set, banned: Set },
  //           tombstoned: Set, height, bytes, authors: Set, controlBlocks: number,
  //           ownerConflict: boolean, succession: { keys, chosen, conflict, frozen, levelOf(h), levelAfter(h, dag?), levelAfterPrev(prev, dag?) } }
  // code review round 1: a succession revokes the old key; expectedOwner (the pointer's owner) decides contested hand-overs (ARCHITECTURE §6.2)
export function ownerAt(dag, h, genesisOwner, expectedOwner = null) → pub      // K(level(h))
export function ownerAfter(dag, prev, genesisOwner, expectedOwner = null) → pub
export function ownerStanding(state, block, { dag, expectedOwner }) → boolean   // what admit() uses
export function revokedAuthor(state, block, dag) → boolean                     // node.js exempt-parent check
export function admit(state, block, { dag, genesisOwner, expectedOwner, minBits }) → { ok, dropValue } | { ok: false, code, reason }
export function controlFor(dag, h, controlBlocks /* ordered */, ancestorSets) → ControlState
export function snapshot(state) → plain JSON { height, kv, lists, profiles, policy: { writers, bits, moderators: [], banned: [] }, owner, authors: n }
export function roleOf(pub, state) → 'owner'|'moderator'|'writer'|'reader'
```
## src/chain/gossip.js  (ARCHITECTURE §6.6)
```
export const MSG = { HELLO: 1, WANT: 2, BLOCKS: 3, ANN: 4, SYNC: 5, INV: 6 }
export const FRAME_MAX = 15360
// v0.2.1: HELLO.owner is null or an algorithm-tagged key (OWNER_KEY_RE, any tag; an untagged owner makes the frame malformed);
// INVALID_REASONS includes 'unknown-op'; BLOCKS answers to WANT { h, v: true } carry v together with z. Golden vectors: test/vectors/hello.json.
export function encode(type, obj) → Uint8Array      export function decode(u8) → { type, obj } | null
export class Gossip {
  constructor({ site, owner, dag, ingest /* async (blocks, peerId) → { added: string[], rejected: [...] } */, getBlock /* h → Block|undefined */, now, setTimeoutFn, clearTimeoutFn, limits })
  attach(peer /* { id, send(u8), close?, group? } */) / detach(peerId) / handle(peerId, u8) → Promise
  announce(hashes) / hello() / tick()      // tick: periodic HELLO + in-flight expiry; call every second
  peers → number; inSyncPeers → number; stats → { in, out, invalid, dropped, ignored }
  // code review round 1: peers and inSyncPeers count distinct `group`s (default: the peer id); a group
  // never merges two peers' traffic, strikes or detach
}
```
## src/chain/wire-ext.js
```
export const EXT_NAME = 'mw_chain1'
export function makeWireExtension(gossip, { name = EXT_NAME } = {}) → class   // prototype.name = name; skips webSeed wires; ignores messages before the extended handshake
export function attachToTorrent(torrent, gossip) → detach()
// code review round 1: one gossip peer per wire (it was one per remote peer id, which is self-declared);
// the remote peer id is the peer's `group` for the counts
```
## src/chain/stores.js
```
export class MemoryBlockStore { async open(siteId); async getAll() → Block[]; async put(block); async putMany(blocks); async dropValue(h); async getMeta(k)/setMeta(k, v); async flush(); async close() }
// v0.2.1: rows are { e, h, s, v?, z? }; dropValue(h) deletes v and z together
export class IdbBlockStore  { same API; DB 'mw-chain-' + sanitise(siteId); stores 'blocks' (keyPath h), 'meta' }
```
## src/chain/node.js  (ARCHITECTURE §6.8)
```
export class ChainNode {
  static async open({ siteId, expectedOwner = null, ledgerOwner = null, genesisHash = null, store, identity, miner, verifierPool, now = () => Date.now(), setTimeoutFn, config = { minBits: 0, ingressRate: { n: 30, perMs: 600000 } } })
  // code review round 1: expectedOwner (pointer owner=) anchors contested successions; ledgerOwner (pointer lo= or owner=) is the genesis owner until the genesis block is held
  state / snapshot() / height / bytes / peers / inSyncPeers / identity / role / ownerMismatch (bool) / ownerConflict (bool, code review round 1) / unmoderated (bool)
  async put(k, v, opts) / del(k, opts) / append(l, v, opts) / profile(name, opts) / tombstone(h, opts) / ban(author, opts)
  // code review round 1: opts = { signal, onProgress } (both optional): onProgress({ hashes, bits }) while the fee is
  // mined; an aborted signal rejects { code: 'E_POW_ABORTED' } and a write aborted before ingest is never stored or announced
  subscribe(fn) → unsubscribe                 // fn(snapshot, { reason: 'local'|'remote'|'load'|'snapshot' })
  attachTorrent(torrent) → detach              // uses wire-ext
  async ingest(blocks, peerId = 'local') → { added: string[], rejected: [{ h, reason }] }
  exportBlocks() → Block[]   async importSnapshot(blocks)   async close()
}
```
Owner-only ops live in `tools/ledger-admin.mjs` (`createGenesis`, `policy`, `owner`, `allow`, and (code review round 1) `accept`:
the new owner's endorsement of a hand-over, an empty policy block whose only parent is it) using the same modules.
v0.2.1: `ingest` rejection reasons include `unknown-op`; payload blocks carry `z` with `v` everywhere (store,
gossip, `exportBlocks`, value restore through `WANT { v: true }`); a local `identity.pub` stored before v0.2.1
(untagged) is used in its tagged spelling (`fromUntaggedP256`, local identity only).
Code review round 1: a local write is written to the store before it enters the DAG (a store failure rejects the
write and leaves nothing behind); remote blocks whose store write failed are retried with the next batch, by
`tick()` every `config.persistRetryMs` (30000) and at `close()` (`config.persistRetryMax` = 512 rows per retry).

## src/loader/config.js
```
export const CONFIG = {
  version: '0.2.1' /* v0.2.1 (verifier): equals SDK_VERSION and TOOLS_VERSION */, floor: { safari: '15.4', chromium: 110, firefox: 115 },
  trackers: ['wss://tracker.webtorrent.dev', 'wss://tracker.openwebtorrent.com', 'wss://tracker.novage.com.ua', 'wss://open.ftorrent.com'],
  stun: [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:global.stun.twilio.com:3478' }],
  doh: [ /* see doh.js */ ], limits: { maxSiteBytesDesktop: 134217728, maxSiteBytesMobile: 50331648, maxSiteBytesCellular: 25165824, storageBudgetDesktop: 536870912, storageBudgetMobile: 134217728 },
  timeouts: { swReadyMs: 15000, metadataMs: 45000, noPeersMs: 60000, dohMs: 4000, xsMs: 10000 },
  chain: { minBits: 0 }, wire: { maxMessageBytes: 262144, keepaliveAnnounceMs: 55000, timeoutMs: 60000 }, // v0.2.1 B1: keepaliveAnnounceMs replaced keepaliveScrapeMs (tracker.openwebtorrent.com closes the socket on scrape)
  paths: { sw: '/mw-sw.js', assets: '/_mw/', hubSite: '/_mw/s/', webseedRewrite: '/_mw/ws/', torrents: '/_mw/t/' }, proto: 1 }
```
**v0.2.1** additive config keys (DIGEST-AMENDMENTS B1, B4, B5, B6, B7, C1, C2; the full shape is in `src/loader/config.js`):
```
policy: { // four classes (research digest 2.4): numwant = offers per announce; uploadLimit 0 = download-only
  desktop: { maxConns: 30, uploadLimit: 1048576, numwant: 3 }, mobileUnmetered: { maxConns: 8, uploadLimit: 0, numwant: 3 },
  mobileUnknown: { maxConns: 6, uploadLimit: 0, numwant: 3 }, mobileMetered: { maxConns: 4, uploadLimit: 0, numwant: 2 },
  mobileOptInUploadLimit: 131072, contentHardExtra: 0.5, rendezvous: { desktop: { soft: 6, hard: 9 }, mobile: { soft: 3, hard: 5 } },
  rebuildAfterHiddenMs: 60000, rebuildAfterHiddenMobileMs: 10000, capGraceMs: 10000, hiddenBatteryMs: 600000, minShapingBytes: 32768, gossipWireFloor: 2 },
ledger: { rendezvousPrefix: 'mw-ledger/1/', joinJitterMs: 1500, glareWatchMs: 20000, glareRetries: 3, glareJitterMs: 3000, nodeOpenMs: 5000, snapshotMaxBytes: 67108864, ingressRate, verifierPoolSize: 2 },
tracker: { reconnectBaseMs: 500, reconnectJitterMs: 1000, reconnectMaxMs: 60000, kickMinIntervalMs: 15000, keepaliveCheckMs: 5000 },
wireGuard: { bufferWatchdogBytes: 524288, bufferWatchdogMs: 2000, reqqMin: 4, reqqMax: 32, reqqUnlimited: 32, reqqRendezvous: 8 },
webseed: { failureLimit: 3, failureWindowMs: 30000, backoffMs: 300000 },
ice: { turn: [], probeBudgetMs: 2500, probeSettleMs: 150, probeConfirmMs: 600, offerTimeoutMs: 1500 },
consent: { version: 2, gateAudiences: ['personal','eea','eu','uk','qc','quebec','sensitive','kids'] }
```
## src/loader/doh.js
```
export const RESOLVERS = [
  { name: 'cloudflare', url: (n, t) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=${t}`, headers: { accept: 'application/dns-json' } },
  { name: 'dns.sb',     url: (n, t) => `https://doh.dns.sb/dns-query?name=${encodeURIComponent(n)}&type=${t}`, headers: { accept: 'application/dns-json' } },
  { name: 'google',     url: (n, t) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}&edns_client_subnet=0.0.0.0/0`, headers: {} } ]
export async function resolveTxt(name, { fetch, timeoutMs = 4000, resolvers = RESOLVERS, override = null } = {})
  → { resolver, strings: string[], ad: boolean, ttl, status } | throws { code: 'E_DOH', errors: [] }   // sequential, first success
export function shouldSkipDoh(hostname) → boolean
export function dohOverrideFromMeta(doc) → url template | null                                     // <meta name="mw-doh">
```
## src/loader/cache.js  (IndexedDB schema v2; the SW core re-implements a minimal reader with identical names)
```
export const DB_NAME = 'mw-sites', DB_VERSION = 2
export const STORES = { sites: 'sites', files: 'files', pointers: 'pointers', pins: 'pins', prefs: 'prefs', keys: 'keys', meta: 'meta', docs: 'docs' }
// sites: key btih → { btih, kind: 'site'|'assets', name, torrentFile: Uint8Array, files: [{ path, length, type, offset }], pieceLength, total, savedAt, lastVisit, complete: true }
// files: key `${btih}/${path}` → Blob
// pointers: key scope → { record, raw, source, savedAt, ttlUntil }      pins: key scope → { owner, decidedAt, firstSeen }
// prefs: key → any  ('consent' (v0.2.1 C1: the versioned record { v, choice, dns, day, scope, rcpt } per origin, shell and
//   drop-in; 'consent:<ledgerId>' only on the shared demo hub; a v0.2 bare-string choice is never read), 'uploads', 'hostOnly',
//   'shareOnNetwork:<origin>', 'hubMode:<btih>')
// keys: key `identity:<ledgerId>` → { kind: 'cryptokey', privateKey, publicKey, pub } | { kind: 'jwk', jwk, pub }   ;  `moderator:<ledgerId>` same shape
// meta: 'current' → { btih, ledgerId, routing }   (shell mode origin→site mapping)   'clients' → { clientId: btih } (drop-in)
// docs: key url → { response body Blob, headers, btih, savedAt }  (drop-in offline documents, LRU)
export async function openDb() / saveSite(manifest, blobs: Map) / getSite(btih) / getFile(btih, path) / listSites() / deleteSite(btih) / touchSite(btih)
export async function getPointer(scope)/savePointer(scope, v) / getPin(scope)/savePin(scope, owner, extra) / getPref(k, d)/setPref(k, v)
export async function getKey(name)/saveKey(name, v)/deleteKey(name) / getMeta(k)/setMeta(k, v) / estimateUsage() / enforceBudget({ budgetBytes, keep: [btih] }) / requestPersist()
export async function addKey(name, v) → boolean   // code review round 1: IndexedDB add(); false when the name exists (another tab won)
export function siteRelativePath(filePath, torrentName, fileCount) → string
```
Code review round 1 (identity race): `app.js` and `dropin/identity.js` `ensureIdentity({ cache, crypto, ledgerId, create = true })`
create a new identity with `storeKey(..., { add: true })` (`addKey`): when another tab stored one first, that key is read and
used (never treated as a failed self-test). Shell follower tabs call it with `create: false` and show the engine tab's
identity from its `state` messages; drop-in followers never create one (as before).
## src/loader/memory-chunk-store.js / src/loader/blob-chunk-store.js
```
export class MemoryChunkStore { constructor(chunkLength, { length }) ; put/get/close/destroy (abstract-chunk-store) }
export class BlobChunkStore { constructor(chunkLength, { parsed /* from torrent-file */, blobs: Map<path, Blob>, verify = true })
  get(index, opts, cb)   // SHA-1 verifies the piece on first read when verify=true; cb(new Error('piece verification failed')) on mismatch
  put(index, buf, cb) → cb(null) ; close/destroy ; verifiedPieces: Set }
```
## src/loader/verify.js
```
export async function verifyInfoHash(torrentFile: Uint8Array, btih) → boolean
export async function verifyFile(parsed, blobs, path, verified: Set) → boolean     // SHA-1 all pieces covering the file; memoise indices
```
## src/loader/torrent.js
```
export class TorrentManager extends EventTarget
  constructor({ WebTorrent, config, policy, consent /* { peersAllowed(): boolean, onChange(fn) } */ })
  async download({ record, torrentFile = null, maxBytes, signal }) → { torrent, manifest, blobs, parsed }
     // xs first (fetch, parse, infohash check) → client.add(bytes|magnet, { store: MemoryChunkStore, announce: exact, private: true, urlList: ws if probe ok })
     // rejects { code: 'E_TOO_LARGE' | 'E_TIMEOUT' | 'E_NO_PEERS' | 'E_ABORTED' | 'E_BAD_TORRENT' }
  async seedFromCache({ manifest, blobs, parsed, record }) → torrent     // BlobChunkStore + skipVerify; infohash check
  // v0.2.1 B2: addRendezvous replaces addAnchor (the one-piece anchor torrent is gone). addAnchor is a
  // deprecated alias kept for one release; the handle is `tm.rendezvous` (`tm.anchor` is a deprecated getter).
  async addRendezvous(ledgerId, trackers) → torrent | null                // bare infohash sha1hex('mw-ledger/1/'+id), left:1, never seeded
  addAnchor(ledgerId, trackers) → Promise<torrent | null>                 // DEPRECATED alias of addRendezvous
  setUploadsEnabled(bool) / setHostOnly(bool) / setHiddenLock(bool) / setIceServers(list) / kick(reason) → n / pause() / resume() / rebuild() / destroy()
  async probeWebseed(wsBase, parsed) → { ok, reason }   // v0.2.1 B3: sends Range only (no Cache-Control)
  webseedBlocked(url) → bool                            // v0.2.1 B4: true while a web seed sits out its back-off
  swarmWires('site'|'rendezvous') → n
  wires, peers, downloaded, total, source
  failures: { trackers: {}, iceFailed, dropped, capped, keepalives, webseed, noWebseed, webseedBackoff: { url: { code, until } }, swarm: { site, rendezvous }, lastIceError }
  // constructor also takes { lifecycle: { win, doc } | false, random }
  // CustomEvents: 'torrent' { torrent, kind:'site'|'rendezvous' }, 'progress', 'peers', 'wire', 'done', 'error', 'status', 'warning', 'tracker' { url, state }, 'sync'
  // 'progress'.uploaded (post-wave fix H) = tm.uploadedBytes: piece payload bytes sent on peer wires (bittorrent-protocol
  // 'upload' events), never WebTorrent's torrent.uploaded, which also counts protocol messages written to web-seed wires
```
Required internals (v0.2.1): wrap `wire._onMessageLength` (unsigned read, destroy on > `config.wire.maxMessageBytes`
before buffering, B5) with a periodic `_bufferSize` watchdog; `wire.setTimeout`, `wire.setKeepAlive(true)`;
per-swarm soft/hard caps after the extended handshake (B6) with `numwant` 0 at the soft cap and `reqq` advertised;
`ut_metadata.cancel()` on rendezvous wires; choke lock; the tracker connection shim (`installTrackerShim`: fast
reconnect timer, `_send`/`setInterval` bookkeeping, and (v0.2.1 verifier) a `connect` hook for an instance that joins a
pooled socket that is still connecting plus a `destroy` wrapper so the regular interval restarts after a reconnect;
`kick()` skips an instance that is still attached to a socket) and the `numwant: 0` keepalive announce (B1); the web-seed circuit breaker (B4); register listeners synchronously on the
`Torrent` returned by `client.add()`. Pure exports also used by tests: `rendezvousInfoHash`, `orderWebseeds`,
`reqqFor`, `wireScore`, `installTrackerShim`, `keepaliveAnnounce`, `bufferOverflow`, `guardWire`.

## src/loader/policy.js  (v0.2.1 DIGEST-AMENDMENTS B6, C2)
```
export function classifyNetwork(connection) → 'wifi' | 'cellular' | 'unknown' | 'saveData'   // only navigator.connection; Save-Data wins
export function policyClass(env) → 'desktop' | 'mobileUnmetered' | 'mobileUnknown' | 'mobileMetered'   // a metered network is metered on any device
export function detectEnvironment() → { isMobile, networkType: 'wifi'|'cellular'|'unknown', networkClass: 'wifi'|'cellular'|'unknown'|'saveData', saveData, battery: { charging, level } | null, online }
export function computePolicy(env, prefs) → { class, column, maxConns, uploadsEnabled, uploadLimit, maxSiteBytes, storageBudget, hostOnly,
  hiddenBehaviour: 'keep'|'destroy'|'battery' /* v0.2 field, kept for the drop-in runtime */, hiddenAction: 'keep'|'lock'|'battery',
  rebuildAfterHiddenMs, numwant, content: { soft, hard }, rendezvous: { soft, hard }, leaveVersionSwarm }
  // C2: uploads on by default only on desktop; every mobile class is download-only until prefs.shareOnNetwork; column is the v0.2 name the drop-in web-seed rule keys on
export function policyColumn(env, prefs) → 'desktop' | 'mobileWifi' | 'cellular'   // v0.2 name, kept (src/dropin/rules.js)
export function watchLifecycle({ onHidden, onVisible(afterMs), onPageHide(persisted), onPageShow(persisted), onOnline, onOffline, onFreeze, onResume }) → stop()
```
## src/loader/connectivity.js  (v0.2.1 DIGEST-AMENDMENTS B7; new module)
```
export async function probeConnectivity({ RTCPeerConnection, stun, turn, budgetMs = 2500, settleMs = 150, confirmMs = 600, policy = 'all', timers })
  → { cls, udp, mappingVaries, gatherComplete, turnConfigured, turnOk, ipv6Srflx, answered: [stun urls], srflx, relay, errors, tFirstSrflx, tRelay, tDone, reason }
  // one throw-away RTCPeerConnection, never waits for 'complete'; cls in PROBE_CLASSES; reflexive addresses compared, never stored
export function classifyReport(report, { stunCount, policy }) → one of PROBE_CLASSES
export function gateIceServers(configured, report) → iceServers   // only STUN that answered; all when gathering completed; never empty; never TURN
export function installOfferTimeout(win, { timeoutMs = 1500, timers }) → bool   // a non-trickle offer leaves timeoutMs after the first candidate (before importing webtorrent)
export function patchOfferTimeout(pc, { timeoutMs, timers }) → bool
export function stunUrlsOf(iceServers) → [url]
export function connectivityRow(report) → { row: 'connectivity', text } | null
export const PROBE_CLASSES = ['easy-mapping','easy-probable','hard','udp-blocked-or-no-stun','relay-only-reachable','unknown-single-stun','no-webrtc']
```
## src/loader/consent.js  (new in v0.2.1, verifier: the C1 rules shared by the shell and drop-in mode; pure, Node and browsers)
```
export function audienceOf(record) → string[]                         // aud= tokens, lowercased
export function consentModeFor(record, config = CONFIG) → 'gate' | 'notice'   // consent= wins; else aud ∩ config.consent.gateAudiences → 'gate'
export function recipientsKey(record, config) → string                // sorted tracker hosts (announceListFor) + STUN hosts, comma-joined
export function makeConsentRecord({ choice, dns, scope, rcpt, now, config }) → { v, choice, dns, day, scope, rcpt }
export function consentFromRecord(record, { rcpt, config }) → 'accepted' | 'host-only' | 'pending'   // other version, or accepted for other recipients → pending
export function dnsAllowedBy(record, config) → boolean
export function consentKeyFor(mode, ledgerId) → 'consent' | 'consent:<ledgerId>' (hub-shared only)
```
They moved here from `src/loader/app.js`, which re-exports all of them (tests import them from either module); `src/dropin/engine.js` uses them for drop-in mode.

## src/loader/render.js
```
export async function registerServiceWorker({ url = '/mw-sw.js', readyTimeoutMs = 15000, proto = 1 }) → { ok, controlled, degraded, reloaded, error }
export function mountSite({ container, mode: 'shell'|'hub-shared', btih, path, onNavigate, onTitle, onBlockedNavigation }) → { iframe, navigate(path), destroy() }
export async function mountDegraded({ container, parsed, blobs, path }) → same shape
export function pathFromLocation(loc) → string
export function installFrameGuards(iframe, handlers) / insertCsp(mode: 'normal'|'degraded', dev: boolean)
// added by integration-1 (additive):
export function requestServiceWorker(type, data, { proto = 1, timeoutMs = 3000, registration }) → Promise<reply | null>
   // posts { ...data, proto, type } with a MessageChannel port and resolves with the worker's reply to THAT message
   // (mw-ack { of: type, ok, complete, ... }), sent after the worker finished the work; null without a worker or on timeout
```
Shell page ↔ worker handshake before mounting (integration-1): `mw-set-current { btih, ledgerId }` is sent with
`requestServiceWorker` and the shell mounts the frame only after the ack; while the ack says `complete: false` the
shell re-sends `mw-site-saved { btih }` (up to 4 times, 150 ms steps). The worker answers both after a forced
IndexedDB re-read. The shell listens for the worker's `mw-site-invalid { btih, reason, path }` and downloads the
site again. `window.__mwShell.inspect()` (read-only diagnostics: mode, btih, ledgerId, signed, pointerSource,
consent, leader, mounted, fromCache, source, peers, ledger { height, root, peers, inSyncPeers, role }, log) and the
worker's `self.mw.inspect().drops` (last 10 copies deleted after a failed check) exist for tests and support.

Additive notes by integration-2 (details and reasons: `docs/deviations/integration-2.md`):
- `registerServiceWorker` (and the probe in `boot.js`) treat `register()` resolving with no registration as a
  rejection: degraded mode, with the degraded CSP.
- Page-tag updates in shell mode: the page sends `mw-shell-check` (with a port); the worker re-fetches `/index.html`
  (`cache: 'no-cache'`) and answers `mw-ack { of: 'mw-shell-check', ok, pointer: <raw page-tag record> | null,
  replaced }`. The worker also re-fetches it in the background on shell navigations (at most every
  `limits.shellRevalidateMs`, 10 s) and replaces its cached shell only with a shell of the same build (identical
  `integrity` attributes). The shell checks after render and on focus/visible; a newer record signed by the pinned
  owner is handled like a DNS update (banner, `stopSite()`, `version` broadcast, `savePointer`).
- `window.__mwShell.inspect()` also returns `uploads` and `hostOnly` (the current policy), and (post-wave fix H)
  `uploaded`: the piece bytes this page sent to other visitors, the same figure as `progress.uploaded`. The
  drop-in `window.__mwDropin.inspect()` returns `uploaded` too.
- `src/sw/core.js`: the drop-in web-seed rewrite keeps whole host files per (requesting client's btih, URL).
- `src/sw/kill-switch.js`: reloads only the pages an earlier worker controlled.
- `src/dropin/swreg.js`: `EMPTY_SCOPE_RECHECK_MS = 1000`; `setupServiceWorker({ ..., recheckMs })` looks at an empty
  scope twice that far apart before registering `/mw-sw.js`; `DropinEngine` option `swRecheckMs` passes it through.
- `src/loader/ui.js`: settings switches are disabled until the first `settings.setModel()`; actions fired before a
  `settings.onChange` listener exists are queued (at most 20) and delivered to the first listener.
- `src/sdk/sdk.js`: the frame's origin is the document origin (`window.origin`), so the SDK also works in limited
  mode's `about:srcdoc` frame.
## src/loader/bridge.js  [changed in v0.2.1: A4]
```
export class Bridge { constructor({ iframe, node, torrentManager, consent, ui, info, limits, identity }) ; attach() / destroy() / push(event, data) }
//   consent: { state() → 'pending'|'accepted'|'host-only', request?() → Promise<state> }   (no accept: a site never grants consent)
//   ui:      { openConsent() → Promise<state> }   the loader-owned consent card; app.js passes its ui (see src/loader/ui.js below)
//   identity: { current() → { pub, short, name } }   (export/import are loader-owned UI only)
export const READ_METHODS, WRITE_METHODS, UI_METHODS = ['consent.request'], CONTROL_METHODS = ['write.cancel'], BRIDGE_METHODS
export const PUSH_EVENTS = ['state', 'peers', 'progress', 'status', 'sync', 'pow']
//   ui.setWriteProgress({ hashes, bits } | null)   optional (code review round 1): the status line while a write's fee is computed
```
Code review round 1 (DESIGN-REVIEW item 4): every write runs with its own `AbortController`; the miner's
progress is pushed as `{ event: 'pow', data: { id, hashes, bits } }` (`id` = the write request's id) and given to
`ui.setWriteProgress`; `write.cancel { id }` aborts that write (answers `true`, or `false` when nothing with that id
is in flight) and the write answers `E_POW_ABORTED`. Writes are called as `node.<write>(...args, { signal, onProgress })`.
v0.2.1 (A4): `identity.export`, `identity.import` and `consent.accept` are not Bridge methods (a request
for one is `E_BAD_REQUEST`). `consent.request` is answered through `ConsentRequests` (`src/loader/api.js`):
a decided state at once; otherwise `ui.openConsent()` (else `consent.request()`) opens the card and the
answer is the visitor's choice; one card for concurrent requests; after a card closes undecided the site
cannot reopen it for `CONSENT_REQUEST_COOLDOWN_MS` (10 s); without a hook the answer is the current state.
`mod.ban` takes a tagged key (`p256:...`).

## src/loader/api.js  (the SDK method table shared by the Bridge and the drop-in binding)  [changed in v0.2.1: A4]
```
export const READ_METHODS, WRITE_METHODS, UI_METHODS = ['consent.request'], LOADER_ONLY_METHODS = ['identity.export','identity.import','consent.accept'], API_METHODS
export const CONSENT_STATES = ['pending','accepted','host-only'], CONSENT_REQUEST_COOLDOWN_MS = 10000
export class ConsentRequests { constructor({ consent, ui, now, cooldownMs }); request() → Promise<state>; state(); opened }
export class MwApi { constructor({ node, torrentManager, consent, ui, info, identity, limits, now, setTimeoutFn, clearTimeoutFn }); request(method, params, opts) → { ok, result } | { ok: false, error, reason } }
// code review round 1: opts (writes only) = { signal, onProgress }, passed to the node's write
```
The drop-in binding (`src/dropin/binding.js`): every write takes a last `{ onProgress, signal }`; each progress
report is also pushed as the `pow` net event (`NET_EVENTS = ['peers', 'progress', 'status', 'sync', 'pow']`).
## src/loader/ui.js
```
export function createUI(root, strings) → { setStatus, setProgress, setPeers, setLedger({ entries, inSync, peers }), setWriteProgress({ hashes, bits } | null), setIdentity, setSource, setPointerInfo,
  showNotice({ onOk, onSettings }), showGate({ hasWebseed, onLoad, onHostOnly, onCancel, details, sharedOrigin, dnsUpdate, dohHost }), showError({ title, detail, actions }), setBanner(id, text|null),
  settings: { setModel(m), onChange(fn) }, diagnostics: { set(matrixRow, detail), log(line) } }
```
**v0.2.1 UI hooks for the site-callable SDK (A4; names fixed here by the formats agent, implemented by the
loader owner):**
```
ui.openConsent() → Promise<'pending'|'accepted'|'host-only'>
   // shows the consent card (the notice, or the gate when the pointer says consent=gate) if consent is pending and resolves with
   // the visitor's choice, 'pending' when it is closed without one; app.js passes { openConsent } as the Bridge's `ui` option
ui.openIdentityExport() → void
   // opens Settings at Export / Import identity: the only place the identity leaves or enters this origin (passphrase-wrapped)
```
Both act only on the visitor's own input: buttons ignore events with `event.isTrusted === false`
(script-made clicks), and export, import and consent require a click (transient activation). A site can
reach neither through `window.mw`; the drop-in panel (`src/dropin/panel.js`, closed shadow root) follows
the same rule for every control.
v0.2.1 (verifier, implemented): `export function trustedOnly(handler) → listener` (ignores `isTrusted === false`;
events without the field, e.g. unit-test fakes, pass); every decision button is built with it: the first-run card
`showConsentCard({ hasWebseed, mobile, dns, dnsUpdate, dohHost, blocking, onShare, onHostOnly, onCancel, onSettings })` (C1: [Share and
load] [Load from host only], "Not now"/Cancel when offered; post-wave fix: `dnsUpdate` adds `consentDnsUpdate`, `dns`
adds `consentDns` and `consentDnsAgain`, and `dohHost` replaces the default resolver names through `strings.dohNamed`),
`showGate` (post-wave fix: `{ ..., dnsUpdate, dohHost }` adds `gateDnsUpdate`), the v0.2 `showNotice` OK, Settings "Change
your sharing choice", identity export and import. The share/host-only switches, Forget and the moderator import stay
ordinary buttons. Tests and tools click these with real (Playwright) mouse clicks.
`src/loader/strings.js` exports every user-facing string (DESIGN-REVIEW §4 verbatim).

## src/loader/app.js
`export default async function start()` per ARCHITECTURE §5; `export { resolveMode, resolvePointer }` for tests.
v0.2.1 (C1, network agent): `resolvePointer(ctx, deps)` takes `ctx.dohAllowed`; without a choice that allows it, a
DNS-only site throws `{ code: 'E_NEEDS_CONSENT' }` (the blocking first-run card asks, then the lookup runs) and a
`<meta>` or cached pointer resolves with `dnsDeferred`/`dnsNeedsConsent` set. The consent rules are re-exported from
`./consent.js`. v0.2.1 (A4, verifier): `export class ConsentWaiters { wait() → Promise<state>; settle(state) → n; size }`
holds the pending `mw.consent.request()` / `ui.openConsent()` answers: a choice settles them with the state, "Not now"
and gate Cancel settle them with `'pending'` (so `ConsentRequests` applies its cooldown).

## src/dropin/mw.js  (ARCHITECTURE §3.4)
Module entry for `/_mw/mw.js`: reads the stamped `<meta name="mw-pointer">`, foreign-SW check, consent
(closed shadow root), Web Lock leader election, engine bootstrap (reuses `torrent.js`, `policy.js`,
`cache.js`, `chain/*`), posts `mw-map-client` to the SW, binds `window.mw` directly (same surface as the
SDK), honours `data-mw-sw="off"`.
v0.2.1 (A4): `window.mw` has no `identity.export`, `identity.import` or `consent.accept`;
`mw.consent.request()` makes the engine show the panel's notice (or gate) now, also with
`data-mw-consent="site"` and before 3 s of visible time (`ConsentState.request()`,
`DropinEngine.consentPromptRequested()`), and resolves with the visitor's click there; gate Cancel resolves
`pending`. The panel ignores untrusted events. `engine.identityApi()` keeps `export`/`import` for
loader-owned UI only.
v0.2.1 (D4, D1; serving-publishing): `rules.announceAllowed({ consent, hostOnly, visible, suspended, webrtc, noStore })`
is false for a no-store page; `swreg.PROTO` is `src/sw/protocol.js` PROTO; `swreg.keepAlive(nav, { intervalMs,
setIntervalFn, clearIntervalFn })` → `createKeepAlive` posting `{ proto, type: 'mw-keepalive' }` to the controller;
`swreg.mapClient` resolves the ack with `doc`; `DropinEngine.mapToWorker()` sets `noStore` from it
(`inspect().noStore`) and holds a keep-alive while `tm.download()` runs through `/_mw/ws/`. The panel host is
created with `data-nosnippet` (F7). `publish --inject-script` writes
`<script data-cfasync="false" type="module" src="/_mw/mw.js" async></script>`.
v0.2.1 (C1, B7; verifier): the engine's non-blocking prompt is `panel.showConsentCard({ hostOnlyOffered, mobile,
onShare, onHostOnly, onSettings, extra })` ([Share and load] [Load from host only] [Settings], prompt kind
`'notice'`; `showNotice` stays for v0.2 callers); `promptFor` receives `consentModeFor(record)` (aud= gates); the
choice is stored with `makeConsentRecord` under `consentKeyFor('dropin')` = `'consent'` and read with
`consentFromRecord(rec, { rcpt: recipientsKey(record) })`; `inspect().consentRecord`.
`createDeps(moduleUrl, { webtorrentUrl, win })`: `webtorrent()` installs `installOfferTimeout(win, { timeoutMs:
config.ice.offerTimeoutMs })` before importing the bundle.
v0.2.1 (A4, verifier): `settingsModel().identity = { short, name, canExport, canImport } | null`; the panel's Settings
renders Export / Import identity from it (`panel.openSettings` model field `identity`; passphrase inputs, a file
input; trusted clicks only) and emits `exportIdentity { passphrase }` / `importIdentity { text, passphrase }`, which
`DropinEngine.changeSetting` answers through `identityApi()` and `downloadText(filename, text) → boolean`.

## src/sw/lib.js, src/sw/core.js, src/sw/sw.js, src/sw/kill-switch.js, src/sw/protocol.js  [changed in v0.2.1: D1, D2, D4]
```
// lib.js (pure)
export function mimeFor(path) ; parseRange(header, size) → { start, end } | null | 416 ; splitHubPath(pathname) → { btih, path } | null
export function applyRouting(manifest, path, hasFile) → { path, status, redirect, headers }       // spa, cleanUrls, trailingSlash, redirects, headers, index, notFound
export function parseRedirects(text) / parseHeaders(text)                                          // Netlify/Cloudflare subset, used by publish too
export function stampedPointerFromHtml(headChunk) → record | null
// core.js (used by sw.js and published as /_mw/sw-core.js; classic-safe: no top-level await, attaches self.mw)
export function createCore({ paths, proto, buildId, precache, integrity }) → { install(event), activate(event), owns(event) → boolean, handle(event) → Promise<Response>, message(event), init(), inspect() }
   // v0.2.1 D2: integrity = { '/path': 'sha384-...' } (the JS and CSS of the precache list) makes the install atomic:
   //   install(event) hands event.waitUntil a promise that REJECTS when a critical entry fails (fetched with
   //   Request.integrity, hashed again); the half-filled mw-shell-<buildId> cache is deleted first
export async function integrityMatches(bytes, integrity) → boolean        // SRI sha256/384/512, any listed value
export { PROTO }                                                            // re-exported from protocol.js
DEFAULT_LIMITS (v0.2.1 additions): navigationDeadlineMs 25000, interstitialRetryS 5, reloadGuardMax 3,
  reloadGuardWindowMs 60000, coldStartWaitMs 40, docInfoMax 256, webseedWholeMaxBytes 33554432
// sw.js: classic entry; self.__BUILD_ID__ / self.__PRECACHE__ / self.__INTEGRITY__ (v0.2.1) replaced by build.mjs;
//   wires install/activate/fetch/message to core
// kill-switch.js: self-unregistering worker (clears mw-* caches, unregister, claims, navigates clients)
// protocol.js (v0.2.1 D1): the versioned page <-> worker protocol, shared by core.js, swreg.js and pages
export const PROTO = 1, KEEPALIVE_MS = 20000, KEEPALIVE_PATH = '/_mw/keepalive', MSG = { ping, pong, ack, setCurrent, mapClient,
  siteSaved, shellCheck, getClients, clients, keepalive, docInfo, siteInvalid, reload }, PAGE_TYPES
export function message(type, data) → { ...data, proto, type }   checkProto(data) → { ok, expected }   isProtocolMessage(data) → boolean
export function createKeepAlive({ post, intervalMs, setIntervalFn, clearIntervalFn }) → { hold(), release(), stop(), active }
```
v0.2.1 behaviour (ARCHITECTURE §3.4.2, §3.4.6, §3.4.7, §7.1):
- Navigations: answered within `navigationDeadlineMs` (interstitial 503 with `Retry-After` that reloads itself,
  at most `reloadGuardMax` times per URL per `reloadGuardWindowMs`, then without the automatic retry); a
  navigation whose handling throws fails open (`fetch(request)`, then the offline page; a frame navigation of
  shell mode gets the error page).
- Messages added: `mw-keepalive` → `mw-ack { ok, buildId }`; `mw-doc-info` → `mw-ack { ok, doc }`; the
  `mw-map-client` ack carries `doc: { noStore } | null` (what the worker saw of the sender's navigation).
  `GET /_mw/keepalive` → 204 `no-store`.
- Drop-in: a cold-start subresource waits at most `coldStartWaitMs` (shell origins wait for the index); a
  `no-store` document is never kept; the web-seed rewrite shares one host download per path and version,
  never keeps a `no-store` answer and forwards `Range` for files above `webseedWholeMaxBytes`.
- `inspect()` adds `integrity` (entries), `installFailed`, `docInfo`, `limits`.
## src/sdk/sdk-static.js  [new in v0.2.1: F7]
The static `/_mw/sdk.js` stub (dependency-free ESM, emitted as `dist/_mw/sdk-static.js`, never precached,
copied by `publish` to `<out>/sdk-static.js`, served by `dev-server` at `/_mw/sdk.js` when the root has none):
default export `mw` with `mode: 'static'`; `ready()` → `{ mode: 'static', siteId: null, btih: null, identity: null,
role: 'reader', peers: 0, height: 0, owner: null, unmoderated: true }`; reads resolve empty (`db.get` → undefined,
`db.list` → []), writes reject `E_NO_HOST`, `subscribe`/`net.on` are inert, `consent.state()` → 'host-only',
`consent.request()` → 'host-only', `owner.policy` rejects `E_NOT_OWNER`; sets `globalThis.mw` only when unset.

## src/sdk/sdk.js  [changed in v0.2.1: A4]
Default export `mw` per ARCHITECTURE §9; `globalThis.mw`; uses the Bridge in shell mode, or re-exports
`globalThis.mw` when drop-in has already bound it; `E_NO_HOST` when standalone. `SDK_VERSION = '0.2.1'`.
Site-callable surface (v0.2.1): `ready`, `db.{get,set,del,list,append,tombstone,subscribe}`, `mod.ban`,
`identity.setName`, `net.{peers,on}`, `site.info`, `consent.{request,state}`, `owner.policy` (always
`E_NOT_OWNER`). `identity.export`, `identity.import` and `consent.accept` do not exist.
Code review round 1: writes take a last `{ onProgress, signal }`; `net.on('pow', fn)`; a write's 30 s answer timer
restarts on each `pow` push for it (at most `writeTimeoutMaxMs` = 600000); on timeout or abort the SDK posts
`{ method: 'write.cancel', params: { id } }` and rejects `E_TIMEOUT` / `E_POW_ABORTED`. `createSdk` options add
`now` and `writeTimeoutMaxMs`.

## tools and build (ARCHITECTURE §10)
`tools/{keygen,publish,ledger-admin,tracker,dev-server,check-webseed,check-site,snapshot,seed,pin,demo}.mjs`,
`tools/seeder.html`, `build.mjs`, `.npmrc`, `build.lock.json`, package.json scripts:
```
"build", "test" (= lint:floor + unit), "test:unit", "test:e2e", "lint:floor", "tracker", "dev", "publish:site", "keygen", "pin", "seed", "demo", "check:webseed", "check:site", "snapshot"
```
v0.2.1 serving and publishing (B3, B4, D2, E1 to E4, F4, F7; serving-publishing agent):
```
// build.mjs
export const WEBTORRENT_PATCHES = [{ id, what, find, replace }]   // 'webconn-request-headers', 'xs-metadata-user-agent', 'remote-torrent-user-agent'
export function applyVendorPatches(code, patches) → { code, applied: [id] }      // throws unless every find matches exactly once
export function checkPatchedLock(lock, { name, bytes, applied }) → { ok, actual, message }
export function integrityMap(outputs: Map<distPath, bytes>, precache) → { '/path': 'sha384-...' }   // JS and CSS of the precache list
export function applyPlaceholders(code, { buildId, precache, integrity })         // integrity → self.__INTEGRITY__ (required when given)
export async function build({ ..., vendorPatches }) → { outDir, buildId, files, warnings, skipped, info }
build.lock.json vendored['webtorrent.min.js'] = { ..., sha256 (stock), markers, patched: { sha256, bytes, patches: [id] } }
build.json: vendored['webtorrent.min.js'] = { package, version, sha256 (stock), patched: true, patchedSha256, patches }, integrity: { path: sri }
dist/_mw/sdk-static.js (ENTRIES name 'sdk-static'); precacheList() leaves out webtorrent.min.js and sdk-static.js

// tools/check-webseed.mjs: the single verification gate
export const PREFLIGHT_SETS = { patched: ['range'], stock: ['cache-control', 'range', 'user-agent'] }
export const VERDICTS = ['PASS', 'PASS-needs-patched-client', 'PASS-no-preflight', 'FAIL-range-ignored', 'FAIL-wrong-bytes', 'FAIL-cors', 'FAIL']
export async function checkWebseed({ wsBase, torrent, xs, origin, fetch, timeoutMs, concurrency, onResult, pieces = 'first-last'|'all'|'none', allowNoPreflight })
  → { ok, verdict, mode: 'seed', btih, name, results: [{ kind: 'file'|'piece'|'xs', path, url, ok, problems, warnings, info, kinds }], failed, warned,
      stock: { checked, ok, problems } }
export async function verifyHostFiles({ base, torrent, mode: 'origin'|'host', origin, fetch, timeoutMs, concurrency, onResult })
  → { ok, verdict, mode, btih, name, results: [{ kind: 'host', ... }], failed, warned, range: { checked, honoured, status } }
export function webseedUrl(base, parsed, file) / hostFileUrl(base, file) / webseedTargets(...) / browserAccept(path) / pieceIndices(parsed, which) / verdictOf(results, opts)
CLI: node tools/check-webseed.mjs <base> <site.torrent> [--mode seed|origin|host] [--xs <url>]... [--origin <o>] [--pieces first-last|all|none] [--allow-no-preflight] [--timeout] [--json]

// tools/publish-policy.mjs (new)
export const RESERVED_PATHS = { prefixes: ['_mw/', '.mw/', 'ws/'], files: ['_mw', '.mw', 'ws', 'mw-sw.js'] }, BUDGET, HOST_PROFILES
export function pathProblems(path) → { errors: [why], warnings: [why] }      lintPaths(paths) → { errors: [{ path, why }], warnings, renames: [{ from, to }] }
export function dotPathReason(rel, isDir, { includeDot }) → reason | null    reservedPathReason(nfcPath) → reason | null
export function budgetReport({ files, torrentBytes, pieceCount, xs, mode, limits, maxFiles }) → { lines, warnings, errors, largest, total, count }
export function lintSecrets(entries: [{ path, bytes }], { allow }) → { errors: [{ path, why }], warnings }
export function importWxr(xmlText, { dir = 'comments' }) → { files: [{ path, bytes }], stats: { posts, comments, emails, ips, unapproved, pingbacks, unpublished } }
export function commentText(html) → plain text

// tools/publish.mjs (additions)
export function resolveCreationDate({ date, dir, env }) → { seconds | null, source: 'flag'|'SOURCE_DATE_EPOCH'|'git'|null }
export async function buildTorrent({ name, entries, announce, urlList, pieceLength, creationDate })
export function applyNfcRenames(root, renames)
export function collectSite(dir, { dropin, ignore, includeDot }) → { files (path = NFC spelling, diskPath), html, torrent, skipped, lint, redirectsText, headersText }
export function ignoreReason(rel, isDir, { extra, includeDot })   stampHtml(...) → { ..., cfasync, duplicate }
publish() options/flags: verifyHost (--verify-host <url>, drop-in), allowNoPreflight, includeDot, allowSecret, maxFiles, fromWxr, wxrDir,
  date, doublePack, ct, lg, aud, env (tests); summary.json adds creationDate, creationDateSource, aud, ct, lg, size { files, bytes, largest,
  torrentBytes, report }, dropped, renamed, wxr, verifiedHost; outputs add sdk-static.js
// tools/check-site.mjs: checkSite(url, { ..., allowNoPreflight, full }); CLI --allow-no-preflight, --full (origin mode over each web seed)
// tools/dev-server.mjs: /_mw/sdk.js falls back to src/sdk/sdk-static.js; ETag = size-mtime-inode
```
v0.2.1 (verifier) cross-module fixes in the tools:
```
// tools/publish.mjs
export const AUD_TOKENS   // pointer.js AUDIENCES ∪ config.consent.gateAudiences
export function audienceList(value) → 'tok,tok'   // --aud: comma list, lowercased, de-duplicated; unknown → UsageError "--aud must be one or more of ..."
export async function rendezvousBtihFor(ledgerId) → hex   // = src/loader/torrent.js rendezvousInfoHash (B2)
export async function anchorInfoHash(ledgerId)             // DEPRECATED alias of rendezvousBtihFor (one release)
publish() result and summary.json: rendezvousBtih; anchorBtih (deprecated) carries the same value
// tools/tracker.mjs
JSON allow lists read btih, rendezvousBtih, anchorBtih, infoHash; createTracker() → { ..., dropConnections() → n, liveConnections }
// tools/live.mjs
export const CONSENT_ACCEPT_LABELS = [STRINGS.consentShare, STRINGS.gateLoad, STRINGS.noticeOk], CONSENT_ACCEPT_RE
acceptConsent(page) clicks with Playwright (a trusted click; the loader ignores script clicks since A4)
// tools/lib.mjs: TOOLS_VERSION '0.2.1'.  tools/check-site.mjs prints key fingerprints (never a sliced 'p256:' string).
// tools/publish.mjs: export function egressNote(copyBytes) → string, printed in drop-in mode (E5)
```
v0.2.1 (A3) `publish.mjs --withdraw` is implemented in `tools/withdraw.mjs` (publish.mjs only dispatches):
```
node tools/publish.mjs --withdraw --scope <host> --key owner.jwk [--why <reason>] [--ct <https:|mailto:>] [--chain <label>]
  [--seq <n> (default Unix time)] [--exp <days> (default 399, the most allowed)] [--prev-key <old owner.jwk>] [--out dir] [--quiet]
export async function withdraw({ scope, key, why, ct, chain, seq, exp, prevKey, out, now, quiet }) →
  { mode: 'withdraw', scope, owner, fingerprint, ledgerId, seq, exp, pointer, record, budget, outDir, outputs, warnings, summary }
  // writes pointer.txt, meta.html, dns.txt, summary.json (mode 'withdraw', withdrawn: true); removes a stale magnet.txt
export const WITHDRAW_FLAGS = { withdraw, why, ct }, WITHDRAW_EXP_DAYS = 400
```
`tools/ledger-admin.mjs` takes and prints tagged keys (`p256:...`); `keyHint(p)` explains a refusal (an
untagged v0.2 key gets "write p256:...", an unknown algorithm "unsupported key type").

Golden vectors (v0.2.1, A2): `test/vectors/{pointer,block,hello}.json` and `test/vectors/LOCK.json`,
checked by `test/unit/formats-vectors.test.mjs`. **Append only**: never edit or remove a vector or a LOCK
entry; add vectors with new ids, append their `{ file, id, sha256 }` lines (the test prints them) to
LOCK.json, and freeze the new chain head in the test's `FROZEN` list at a release.

## Ownership for the v0.2 build (write only inside your paths + docs/deviations/<agent>.md)
- chain-core:  src/chain/{sha256-sync,pow,pow-worker,pow-client,verify-pool,block,dag,state}.js, test/unit/chain-core*.test.mjs
- chain-net:   src/chain/{gossip,wire-ext,stores,node}.js, test/unit/chain-net*.test.mjs
- loader-common: src/common/{base32,bencode,torrent-file,magnet,pointer}.js, src/loader/{doh,cache,memory-chunk-store,blob-chunk-store,verify}.js, test/unit/common*.test.mjs, test/unit/loader-common*.test.mjs
- loader-app:  src/loader/{index.html,boot.js,app.js,config.js,strings.js,torrent.js,policy.js,render.js,bridge.js,ui.js,ui.css}, test/unit/loader-app*.test.mjs
- sw-sdk:      src/sw/*, src/sdk/*, test/unit/sw*.test.mjs
- dropin:      src/dropin/*, examples/existing-site-dropin/**, test/unit/dropin*.test.mjs
- tools:       tools/*, build.mjs, .npmrc, build.lock.json, package.json (scripts), test/unit/tools*.test.mjs
- example:     examples/peer-guestbook/*
- integration: test/e2e/*, docs/DEVIATIONS.md, docs/RUNBOOK.md, any file (after the others)

## v0.3: module contracts for identity, sign-in, chat, files, private media and the hub lane

> **v0.3, built (final integration, 2026-10-20).** Contracts from the v0.3 design review ([review/V03-DESIGN-REVIEW.md](review/V03-DESIGN-REVIEW.md),
> "R") and ARCHITECTURE section 15. Every subsection below is "built by lane X": the code in the tree matches it (wave 1:
> freeze, harden-loader, idcore, chat, media, ui; wave 2: chain-net, idp, tools, docs; then sdk and examples, built
> contract-first and reconciled; the final integration's changes are the last subsection,
> [deviations/integration-v03.md](deviations/integration-v03.md)). An item marked **(proposed)** is not built, and says why. The review round of
> R Part 5 ran against this code from 2026-10-22 to 2026-10-24 (R 5.4); the contracts its fixes changed are the last section,
> "v0.3 review round". Same rules as above: ES modules, vanilla JavaScript, Node 22 and browsers for shared
> code, the browser floor, no new packages without a deviations entry, every public key `p256:`-tagged, RFC 8785 for every
> signed object.

### src/identity/derive.js, p256.js, argon2.js (pure; Node and browsers; built by lane idcore, changes in [deviations/idcore.md](deviations/idcore.md))
```
export const ID_SALT = 'mw/id/v2', KEY_MODES = ['pairwise','ledger','hub','linked'], MAX_ORG_ORIGINS = 4
export function phraseToRoot(words) -> Uint8Array(16)        export function rootToPhrase(root) -> string[12]     newRoot()
export async function rootStar(root, extra?, { argon2 }) -> Uint8Array(32)  // HKDF(ikm, salt "mw/id/v2", info "", 32); an extra word
                                                                            // (NFKD) goes through Argon2id first; an empty one means none
export async function labelSeed(rootStar, label) -> Uint8Array(32)         // salt "mw/id/v2", info "seed|" + label
export async function signScalar(seed, i) / recoverScalar(rootStar, label) / kName(seed) / kVaultHash(rootStar)   // empty HKDF salts
export async function checkCode(rootStar) -> string(8)
export function scalarToJwk(d) -> { kty:'EC', crv:'P-256', d, x, y }   // public point from p256.js: BigInt, NOT constant time, IdO only
export async function importScalar(d, usage = 'sign') -> non-extractable CryptoKey;  deriveLabel(rootStar, label, { i }) -> the label's keys
export async function labelFor({ origin, pointer?, hubScope?, links?, verifyPointer, isPublicSuffix }) -> { label, keyMode, ledger?, reason? }
  // async; the IdO injects verifyPointer(text, origin) -> { ok, ledgerId, owner, lo, rotVerified, host, org } and isPublicSuffix(s).
  // Precedence: shared-origin hub ('visit-only', label null) > linked > hub > ledger > origin; reason on an origin fallback:
  // 'no-verifier' | 'unverified' | 'lineage' | 'org-too-long' | 'not-listed' (the last drives "not one of this site's addresses")
argon2.js:  export function argon2id({ password, salt, secret?, ad?, m, t, p, tagLength = 32 }); ARGON2ID_DEFAULTS = { m: 65536, t: 3, p: 1 }
            // plain JavaScript (RFC 9106 vector), not WebAssembly: measured 1.3 to 2.5 s at 64 MiB on an M3 (idcore deviation 2)
```
### src/identity/wrap.js, vault.js, check.js, sealed.js (built by lane idcore)
```
wrap.js:   export const WRAP_INFO = 'mw-idp-wrap-v1', PBKDF2_ITERATIONS = 600000, BLOB_VERSION = 2
           export function packSecrets({ rootStar, kVault }) -> Uint8Array(64) / unpackSecrets(bytes)
           export async function wrapWithPrf(prfOutput, secrets, { credId }) / unwrapWithPrf(prfOutput, blob)
           export async function wrapWithPassphrase(pass, secrets, { kdf: 'argon2id'|'pbkdf2', params }) / unwrapWithPassphrase(pass, blob)
           export function describeKdf(blob) -> the KDF name the card shows
           // blob { v: 2, kind: 'prf'|'pass', credId?, salt?, kdf?, iv, ct }; AAD "mw-idp-wrap-v1\n" + JCS(header), so a swapped
           // credId, salt or kdf fails; header bounds are checked before any KDF runs (m <= 1 GiB, t <= 16, p <= 8, iter 1,000 to 10^7)
vault.js:  export const VAULT_PREFIX = 'mw-vault-v2', BACKUP_PREFIX = 'mw-identity-v3', CHAT_EPOCH_MS = 90 days
           export class Vault { static create() -> { vault, kVault }; static async open(kVault, blob); toBlob(kVault, { id }); toJSON();
             labels(); label(label, { create }) -> { i, chat, rec, own, local, contacts, links, sites }; currentChat(label); rotateChat(label);
             newRecordKey(label); bumpSignIndex(label); shred(label, what); linkOrigin(origin, label); unlinkOrigin(origin); links();
             addSite(label, origin); addLegacy({ ledger, pub, jwk }) }       // chat epoch keys are random scalars
           export async function makeBackupFile({ rootStar, kVault, vault }, passphrase, { kdf, params, allowWeak }) / openBackupFile(text, pass)
             // { type: 'mw-identity', v: 3, kdf, params, salt, iv, ct }; passphrase floor 12 characters and about 60 bits
           export function isLegacyExport(text); parseLegacyExport(text, pass); generatePassphrase(words = 6); passphraseStrength(pass)
check.js:  export async function selfTest(cryptoApi, { indexedDB }) -> { idb: bool, sign: bool, ecdh: bool }   // IndexedDB injectable
sealed.js: export const SEAL_ENC = 'mw-seal-v1', SEAL_LIST = 'mw.s', PLAINTEXT_BYTES = 1024, MAX_DATA_BYTES = 1013,
             KINDS = { REC_INDEX: 1, REC_DATA: 2, MEDIA_OWN: 3, GRANT: 4, JOIN: 5 }, MAX_ITEMS_PER_AUTHOR = 32
           export async function seal({ kind, ver, seq, count, data, ledgerId, authorPub, key?, sealTo?, theirChatPub?, hint? }) -> { enc, iv, ct, hint? }
           export async function open({ value, ledgerId, authorPub, key?, openFrom? }) -> { kind, ver, seq, count, data } | null
           export function encodePlain / decodePlain / sealAad / isSealedValue(v); hintFor(kPair, ms); findByHint(items, kPair, ms, { days });
             readEffective(items, { open, max = 32 })
           // kinds 4 and 5 take sealTo(theirChatPub, plaintext, { aad, iv }) -> Uint8Array and openFrom(ct, { aad, iv }) from the chat
           // lane's box. ct must be exactly 1,040 bytes (R 2.6.2; the freeze schema hides any other size): src/chat/seal.js sealTo with
           // ephemeral = the sender's chat key and openFrom with epk = the sender's chat key give that (integration I-4). The media
           // lane calls open(value, opts): the SDK wiring adapts it to open({ value, ...opts }).
```
### src/identity/signin.js (pure; shared by the IdO, the loader and the tests; built by lane idcore)
```
export const SIGNIN_PREFIX = 'mw-signin-v1\n', LOCAL_PREFIX = 'mw-local-v1\n', MAX_AGE_MS = 300000, LOCAL_MAX_AGE_MS = 900000, MAX_PROOF_BYTES = 4096
export function buildChallenge({ origin, ledger, pub, keyMode, purpose = 'site'|'server', challenge, now, requestId, idp, build }) -> c
  // ledger exactly when keyMode is 'ledger'; purpose 'server' needs challenge.nonce (E_NONCE_REQUIRED); the statement is checked here
export async function signChallenge(c, signKey) -> proof          export function parseProof(text | object) -> { ok, proof } | { ok:false, reason }
export async function verifySignature(proof); signingInput(c); strictJsonParse(text); statementProblem(s)
export async function makeLocalProof({ signKey, pub, origin, epoch, now, ttlMs <= 900000 }) / verifyLocalProof(proof, { origin, epoch, now, skewMs })
  // { c: { v: 1, t: 'mw-local', origin, pub, epoch, nonce, iat, exp }, alg, sig } over "mw-local-v1\n" + JCS(c); 'revoked' for an earlier epoch
```
A server-backed page posts the proof TEXT (its JSON) to its server ([specs/mw-signin-v1.md](specs/mw-signin-v1.md) section 1);
`<mw-signin>` does so (integration I-2), so the verifier also sees duplicate keys.
### packages/verify (`@felinar/verify`, one file, zero dependencies; built by lane idcore)
```
export function createVerifier({ origin, ledger = null, allowKeyModes, allowIdps, maxAgeMs = 300000, maxSkewMs = 120000, nonces, now, statement })
  -> { verify(proofText | object) -> { ok:true, pub, keyMode, ledger, iat, exp, requestId, statement, idp, build } | { ok:false, reason, at } }
  // checks in order: shape, statement, origin, domain, ledger, keymode, idp, too-long, not-yet-valid, expired, then the nonce is consumed
  // ('nonce' never issued, 'replay' already used), then the signature, then the issued statement and resources
export async function issueChallenge({ statement, nonces, ttlMs = 300000, resources, origin, now }) -> { nonce, statement, exp, resources }
export class MemoryNonceStore { put(nonce, expMs, meta); consume(nonce, expMs, origin) -> true | meta | 'used' | false; markUsed(nonce, expMs) }   // verify() always passes origin; statelessNonce stores need it for their MAC, others may ignore it
  // one process only; a shared store implements the same three calls atomically (the E-SI-4 fixture: one file per nonce, atomic rename)
export function statelessNonce(secret, { ttlMs, used, now }) -> { issue(origin), consume(nonce, expMs, origin) }
  // nonce = t (8) || random (8) || HMAC-SHA-256(secret, "mw-nonce-v1|" + origin + "|" + t + "|" + random)[:16]; replays stop in `used`
export function jcs(value)                                       // RFC 8785, for the byte-equality test
```
### src/idp/* (v0.3, built by lane idp; the identity origin bundle, never loaded by a site origin; changes in [deviations/idp.md](deviations/idp.md))
```
idp.js:     export function createIdp(env) -> { handleRequest(req, origin, channel) -> response, bootSignin(), bootHome(), unlock({ escrow,
              allowCreate, pre }), runRestore(), runLinkNew(), runLinkOld(), runKit(), replaceAllKeys({ pre }) -> { replaced, kept },
              stopSame(origin), hubOff(suffix), removeDevice(), makeBackup({ pre }), startDownload(text) }
              // env adds locks (navigator.locks), hubSuffixes, sharedOrigins, setTimeout (code review v0.3, lane loader-sw below)
            export async function verifyPointerFor(text, origin, { now, state, floors, scope }) -> { ok, reason?, ledgerId, owner, lo,
              rotVerified, host, org, seq, ownHubAddress }
              // scopes tried: the request's scope hint, the origin's hostname, btih:<infohash>, the org= hostnames; one-step rot=;
              // an expired record is no ledger label ('expired'); a seq below the vault's floor for that ledger is a rollback
            export function wasmAvailable() / chooseKdf(wasm) -> 'argon2id' | 'pbkdf2'      export function siteCode(code)
            popup: posts { v: 1, t: 'mw-idp-ready', build } to window.opener; takes the first request whose event.source === window.opener;
              the requester is event.origin; answers with postMessage(targetOrigin = that origin), then closes
            redirect: IdO/signin#<b64url request + { origin, ret }>, ret exactly origin + '/_mw/idp-return'; location.replace(ret#<answer>)
            rounds (popup only): { t: 'mw-idp-count', pub } -> { t: 'mw-idp-count-res', count } after a restore ("Found N posts");
              { t: 'mw-idp-legacy', epk } -> { t: 'mw-idp-legacy-res', sealed } for a 0.2.1 key (R 2.2.7)
cards.js:   export function createCards({ doc, win, lang, build, now, minPressMs, idp }) -> { signin, confirmSame, chooseUnlock, passphrase,
              showPhrase, reentry, restore, checkCode, foundPosts, recoveryKit, backupFile, saveBackup, createPage, ownerAction, recordRead,
              erase, legacy, replaceKeys, removeDevice, message, error, busy, progress, tapToFinish, showCodes, scanCode, settings, close }
            policies: sameIdentityOptions({ state, origin, now }), recordSameOffer(state, origin, { outcome }), approvalAllowed({ state,
              origin, uv }), kitDue({ ios, standalone, kitSaved, meaningful }), reentryPositions(), registrableSplit(host), shortId(pub)
passkey.js: capabilities(env) -> { webauthn, platform, prf }; create({ nickname, env, salt }) -> { credId, prf, prfEnabled, uv };
            get({ credId, env, salt }) -> { credId, prf, uv }; prfFor({ created, env }); prfSalt() = SHA-256("mw-idp-prf-v1"); RP ID = this host
            // salt: prfSalt() computed before the click, so the WebAuthn call is the first await of the gesture
link.js:    LinkNewDevice (B): open() -> QR 1, acceptA(qr2) -> { reveal, sas }, acceptSecret(qr4), acceptPart(qr5..), complete()
            LinkOldDevice (A): open(), acceptCommit(qr1) -> QR 2, acceptReveal(qr3) -> { sas }, confirm(match, secrets) -> [QR 4, parts]
            sasFor(eA, eB, nonceB), parseLinkCode(text), LINK_WINDOW_MS = 120000; codes mwlink:2:c|a|b|s|v:...
qr.js:      encode(text | bytes, { ecl }) -> { version, size, modules }; toImageData(qr, { scale, margin }); decode(imageData) -> { text } | null;
            decodeMatrix({ size, modules }); rsEcc / rsCorrect (byte mode, ECC L/M/Q/H, versions 1 to 40)
store.js:   openIdoStore({ indexedDB, memory }) -> { getWrapped, setWrapped, getVault, setVault, getState, setState, wipe, persistent };
            acceptEscrow({ root, vault }) -> { root | null, vault | null } (a root only of kind 'prf'); vaultIdOf(root*); emptyState()
psl.js:     PSL_RULES (curated snapshot), createPsl({ rules, extra, hubs }) -> { publicSuffixOf, isPublicSuffix, isHubSuffix, hubSuffixOf },
            publicSuffixOf(host), isPublicSuffix(suffix), isHubSuffix(suffix), hubSuffixOf(host) (listed hubs only), hubShapeOf(host),
            isSharedOrigin(origin, list), HUB_SUFFIXES (MW_HUB_SUFFIXES plus the test rules), SHARED_ORIGINS (MW_SHARED_ORIGINS)
strings.js: STRINGS { en, fr }, t(key, params, lang), errorText(code, lang), pickLang(tag)
sw.js:      createIdpWorker({ buildId, precache, caches, fetchFn, scope }) -> { name, install(), activate(), handle(request) }; caches the bundle (most sign-ins make
            no request); build id and bundle hash come from <meta name="mw-idp-build"> on the page
_headers:   CSP default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; frame-ancestors 'none'; Referrer-Policy: no-referrer
tools/build-idp.mjs: node tools/build-idp.mjs [--out dist-idp] [--no-minify] [--test --test-psl <suffix>]... -> prints the bundle
            sha256 and the build id; --test-psl is refused without --test
```
### src/identity/client.js, store.js, migrate.js, service.js (v0.3, site origin, built by lane idp)
```
client.js:  export function signIn({ purpose = 'site', pointer, scope, challenge, want = ['keys'], shared, create, owner, escrow, record,
              legacy: { pub, ledger, name, exportKey() }, countPosts(pub), redirect, returnTo, idp, win })
              // redirect: true or false; left out, a key sign-in starts with the redirect where opensInPlace(win) (iOS Home Screen app)
              // challenge, escrow, record, legacy, pointer and scope may be promises (resolveLate): window.open runs first
              -> Promise<{ bundle?, proof?, record?, erased? }>    // window.open before any await; E_POPUP_BLOCKED, E_IDP_UNREACHABLE,
                                                                  // E_USER_CANCELLED, E_RATE (10 s per kind), E_BAD_REQUEST, E_DECRYPT
            export async function completeRedirect({ win, defer }) -> { bundle?, proof?, record?, erased?, returnTo } | null   // /_mw/idp-return
              // defer: true (drop-in) keeps the sealed answer in sessionStorage -> { deferred, returnTo }; never a proof (E_POPUP_BLOCKED)
            export async function takeDeferredAnswer({ win }) -> the opened answer | null   // the page that started the sign-in
            export function openIdentity({ intent: 'kit' | 'link' | 'backup' | 'restore', idp, win }) -> Promise<'done' | 'cancelled'>
            export function configure({ idp }); resolveIdp({ idp, doc, pointer })  // explicit > configure > <meta name="mw-idp"> > idp=
            protocol shared with the IdO: validateRequest(req, { transport }), validateResponse(res, requestId), returnUrlOk(ret, origin),
              seal(prefix, pub, value, { origin, requestId }) / open(prefix, key, sealed, ...) (ECIES P-256, HKDF info prefix|origin,
              AES-256-GCM), sealLocal / openLocal (K_local caches), mergeRecords(...records) (per-field newest wins)
            want: one of WANT_SETS ([keys], [proof], [keys, proof], [record], [erase]); an unknown request field is refused (nothing can
              preselect a link); challenge only with purpose 'server'
            request fields: v, t, requestId, purpose, pointer, scope (the scope the loader verified the pointer under), challenge, want,
              epk, shared, hubDefault (accepted and ignored), create, owner: { what }, escrow: { root, vault } (fitEscrow), record,
              legacy: { pub, ledger, name }
            answer: { v: 1, t: 'mw-signin-res', requestId, ok, bundle?, proof?, record?, erased?, code? }; the bundle K (R 2.3.3) carries
              label, keyMode, origin, pub, short, ledger, sign { d, x, y, i }, chat { e, d, x, y, exp, pub }, rec { r, key }, own, local,
              name (K_name), rc (b64url sha256 of the recover pub, for keyinfo), status { kitSaved, fileSaved, passkey, persisted, legacy },
              stay, sharedComputer (the person's choices on the card), escrow, vaultEscrow, nextPubHash? (create), rotateNotice?, legacy?,
              owner?, record?, erased?
store.js:   export class WorkingKeys {
              static async install(bundle, { stay, sharedComputer, idb, cryptoApi, selfTest, channelFactory, now })   // drops the JSON
              static async restore({ idb }) -> WorkingKeys | null        // "Stay signed in", 30 days
              static async escrow({ idb }) -> { root?, vault? } | null   static async forget({ idb })
              pub, label, keyMode, short, ledger, rc, nextPubHash, status, i, rotateNotice, storage ('memory' | 'idb'), sharedComputer
              identity -> { privateKey, pub }   sign(bytes) -> Uint8Array(64)   chat -> { pub, e, exp, ecdh }
              ecdh(theirPub: 'p256:' string | Uint8Array(65) raw point) -> Uint8Array(32)   // raw points: the chat lane's Noise XX
                                                                                       // handshake passes them (reconciliation)
              chatPub; rec (CryptoKey), recEpoch, own, local, name (CryptoKeys); hmacName(bytes); saveLocal / loadLocal / localBlob / dropLocal
              async destroy({ forget }) -> { epoch }   // keys out of memory and IndexedDB; broadcast { t: 'signed-out', epoch }
            }
            export function onSignedOut(fn, { channelFactory }) -> unsubscribe; readEpoch({ idb }); bumpEpoch({ idb, persist }); checkBundle(K)
migrate.js: export async function migrateLegacy(ledgerId, legacyRecord, client, opts) -> { result, choice, stored, link, item, deleteLegacy }
            export function legacyOption(ledgerId, record, { name }) -> the signIn legacy option; legacyOutcome(result, legacyPub, { removeLegacy })
            export async function exportLegacyJwk(record); export function legacyAuthorFor({ policy, newPub, legacyPub })
service.js: export function createIdentityService(deps) -> { methods, on(event, fn), destroy(), keys(), workingKeys, ownerAction(card), adopt(result),
              restore(), follow(identity) }   // adopt: the answer of a finished redirect; restore: "Stay signed in" keys at boot
              // ownerAction({ kind: 'policy' | 'checkpoint' | 'withdraw' | 'delete' | 'create-page' }) -> boolean (reconciliation,
              // the sdk lane's request; R 3.3, MF-64): client.signIn with owner: { what } or create: true, confirmed on the IdO's
              // card (true only when the answer's K.owner.confirmed names that action); the answer's bundle replaces the working
              // keys (a create answer adds nextPubHash). OWNER_ACTIONS = ['policy', 'checkpoint', 'withdraw', 'delete']
              methods: auth.signIn, auth.signOut, auth.state, auth.prove, auth.verify, auth.signInServer, identity.current,
              identity.setName, identity.backupStatus, identity.openIdentity, me.get, me.set, me.del, me.sync, me.erase (R 2.11.2)
              events: 'auth' { state, identity, role }, 'kit' { reason } (first meaningful action without a saved kit), 'keychange' { notice }
              deps: { node, ledgerId, pointer, scope, cfg(), prompt, now, random, countPosts(pub), client, Keys, origin, idb, channelFactory,
              cryptoApi, win, idp, sharedHub, legacy: { get(), remove(), write(item) }, onKeys(keys | null), writer }
            ctx = { activation, tab: 'leader' | 'follower' }; follower tabs read only (E_POLICY); E_NEEDS_GESTURE for UI methods without
            activation (me.get on its first call per session); E_NOT_SIGNED_IN, E_HOST_ONLY_IDENTITY, E_FIELD, E_LIMIT, E_POLICY
            (owner-only site: "This site does not let visitors write to its ledger, so your record stays on this device."), E_NONCE_REQUIRED
src/dropin/identity.js: createDropinIdentity({ win, cache, ledgerId, pointer, node, cfg, prompt, ... }) -> { service, legacy, boot(),
            completeRedirect() }; the 0.2.1 functions (ensureIdentity, storeKey, export/importIdentityText, exportCurrentIdentity,
            importIdentity) stay for migration only
```
### src/chain/block.js, state.js, dag.js (freeze group, 15.4; built by lane freeze, decisions in [deviations/freeze.md](deviations/freeze.md))
```
block.js
  CONTROL_OPS = ['policy','owner','tombstone','ban','allow','unban','keyinfo','rotate','checkpoint']; FUTURE_CONTROL_OPS = ['vanish','grp']
  POLICY_FIELDS = [...v1, 'modAllowPerDay','modActionsPerHour','reservedPool','voided']; FREEZE_POLICY_DEFAULTS = { 20, 60, 25, [] }
  FREEZE_LIMITS = { maxCheckpointHeads: 32, maxBulkAuthors: 64, maxVoided: 50, maxReservedPool: 50, maxModAllowPerDay: 1000, maxModActionsPerHour: 100000 }
  ROTATE_PREFIX = 'mw-rotate-v1\n'; export function rotateSigningInput(ledgerId, from, next) -> string
  validateBlock: 'op' for a malformed new op, 'limit' over a cap, 'sig' for a bad rotate rsig, 'unknown-op' for vanish, grp
                 and the v0.2.1 checkpoint placeholder (no heads); validity stays a function of e (and v against vh)
  DEFAULT_POLICY is unchanged (v1 fields only)
state.js
  reduce() handles the new ops and state rules; State adds keyinfo, rotations, keychange, checkpoint, modTombstoned,
    ownerWritten, profileMeta, policy.{ banUntil, modAllowPerDay, modActionsPerHour, reservedPool, voided }; items keep { h, author, ts, v }
  export function reduceFromCheckpoint(S, blocksAfter, opts) -> State        // throws E_SNAP when S does not verify
  export function checkpointFor(dag, heads, opts) -> { S, snap, n, bytes, heads }   // what the owner signs; S = { v: 1, covered, state }
  export function schemaOk(listOrKey, value, kind?) -> boolean    // hides non-matching mw.* items and _mw.* keys; never affects validity
  export function authorScope(pub) -> '@' + 16 chars + '/'; isScopedKey(k); checkpointSnap(S); decodeCovered(str)
  snapshot() adds keychange, checkpoint and the new policy fields; admit() adds E_POLICY 'scope' | 'owner-protected' | 'keyinfo-set' |
    'recover' and E_NOT_OWNER for a moderator allow that removes
dag.js
  dag.pruneTo(checkpointBlock, S) -> { dropped }; export function pruneTo(dag, checkpointBlock, S) (the same; E_SNAP on a wrong snap, n, bytes or head)
  dag.isCovered(h), dag.coveredCount, dag.checkpointBase() -> { h, snap, S } | null
  add(): a prev naming a covered hash counts as held; a covered hash is 'duplicate'
```
A checkpoint settles: every covered block is in the causal past of every uncovered block; uncovered blocks are ordered by
(relative depth, h); moderator caps restart; covered control effects stand. reduce(full DAG) equals reduce(pruned copy) and
reduceFromCheckpoint(S, later blocks) (property-tested on random DAGs). Measured: a 4,096-byte block holds at most 39 bulk-tombstone
authors and 20 voided entries, so maxBlockBytes binds before the 64 and 50 caps.
### src/chain/node.js additions (v0.3, lane chain-net; setIdentity and writeControl added by the reconciliation integrator)
```
export const PERSONAL_POLICY = { writers: 'owner', bits: 16, maxChainBytes: 8388608 }
ChainNode.genesis({ signer: { pub, sign(bytes) }, policy, keyinfo: { rc }, chain, ledgerId, now }) -> { blocks, ledgerId, gen, chain }
node.setIdentity(identity | null) -> true   // the signing key of an open node (sign-in, sign-out); own-chain hints recomputed from the
                                            // DAG; subscribers hear reason 'identity'
node.writeControl(op, opts) -> Promise<Block>   // any op of CONTROL_OPS (unban, ban with until, bulk tombstone, allow, policy,
                                                // keyinfo, checkpoint, ...); admit decides who may (E_NOT_OWNER, E_NOT_MODERATOR,
                                                // E_POLICY); a payload op is E_INVALID
```
### src/chain/multi.js, recent.js (`mw_chain2`, hub lane; built by lane chain-net, the full surface in [deviations/chain-net.md](deviations/chain-net.md))
```
export const EXT_NAME_2 = 'mw_chain2'
export class MultiGossip { constructor({ hubSuffix, shard, ledgers /* Map<ledgerId, ChainNode> */, limits, deviceClass, onChange, onView });
  infoHash() -> Promise<40 hex>; follow(ledgerId); unfollow(ledgerId); hold(ledgerId); release(ledgerId); attach(peer); detach(id);
  handle(id, u8); setHidden(bool); wantedWires; view(ledgerId); peerFor(id); destroy() }
recent.js: recentWindow(node, { posts = 200, fromDepth }) -> window; viewOf(node) -> RecentView (state() -> { state, snapshot, unchecked,
  missing, controlExact, complete, checkpoint }); applyWindow(node, window); syncRecent(node, peer, { posts = 200 })
```
The loader joins the lane with TorrentManager.joinLane({ kind: 'hub' }) (R 2.7.1 names no hub kind; built as (review round, SCALE-6):
`src/loader/app.js:3812` (joinHubLane; the joinLane call at :3821) passes kind 'hub', and `src/loader/torrent.js:93` lists 'hub' in SWARM_KINDS, with its own cap).
### src/chat/* (v0.3; built by the chat lane, deviations in [deviations/chat.md](deviations/chat.md))
New cryptographic code: the handshake and the sealed box are not called secure before the outside review (R 2.19).
Every constant lives in `src/chat/limits.js`. A ChatKey is `{ pub: 'p256:...', ecdh(theirPub) -> Promise<Uint8Array(32)> }`, where
theirPub is a `p256:` key string or the raw 65-byte uncompressed point (the Noise XX handshake passes raw points; WorkingKeys.chat
accepts both since the reconciliation).
```
frames.js:  export const T = { HELLO:1, XX:2, ENV:3, ROOM:4, WANT:5, HELD:6, CK:7, HOLDING:8, COLLECTED:9, PRES:10, SIG:11, ICHAL:12, IRESP:13 }
            export function encode(type, { version = 1, hop = 0, flags = 0, day, stampNonce }, body) -> Uint8Array   // TypeError on bad local input
            export function decode(u8) -> { type, header: { version, hop, flags, day, stampNonce }, body, fields } | { error }   // never throws
            export function frameId(u8 | decoded) -> Uint8Array(32)   // SHA-256(type|version|flags|day|body): hop and nonce excluded (sync)
            export function withHop(u8, hop), withNonce(u8, nonce), isOnCurve(point65)
            body builders: helloBody, xxBody(step, msg), envBody({ tag, epk, iv, ct }), roomBody, wantBody(entries), heldBody(frames),
            ckBody(ck), holdingBody({ tag, frameId, expiry }), collectedBody({ frameId, proof }), presBody, ichalBody, irespBody
stamp.js:   export async function mint(frameId, bits, { signal, onProgress, start = 0 }) -> Uint8Array(8)
            export function check(frameId, nonce, bits) -> boolean; requiredBits(flags, chatBits = 20); stampWork(frameId, nonce)
            export function utcDay(ms), headerDay(ms), dayAcceptable(day, ms), fullDay(day, ms)
            export function dayWithin(day, ms, days)   // held mail (HELD answers) keeps its day: accepted for the 7 days of the hold
tags.js:    export async function contactTag(kPair, day), inboxTag(ekString, day), presenceId(kPair, day), groupTag(kG, day), hmac(key, data)
            export function buildWant(interests, { decoys = 4, random, holderChosen = false }) -> entries   // inbox tags never go out
            export function listenDays(day) -> [day - 1, day, day + 1]; wantMatches(entry, tag); tagKey(tag)
            export function heldDays(day, days = 7) -> [day - days .. day - 2]   // contact tags asked of holders only (via 'held')
seal.js:    export async function pairKey(myChat, theirChatPub, ledgerId) -> K_pair
            export async function sealDm({ myChat, theirChatPub, ledgerId, day, message: { id?, t, n, kind, flags?, body }, ck?, bucket?,
                                           stranger = false, ephemeral?, iv? }) -> { tag, epk, iv, ct, bucket, kPair, id }
            export async function openDm({ myChat, ledgerId, env, theirChatPub?, kPair?, stranger = false, now })
                                           -> { ok: true, from, kPair, message, ck? } | { ok: false, reason }   // never throws
            export async function sealRaw({ kPair, dh, epk, tag, ledgerId, plaintext, iv, stranger })   // vectors, deniability
            export async function sealTo({ myChat, theirChatPub, ledgerId, data, aad, ephemeral?, iv? }) -> { epk, iv, ct }
            export async function openFrom({ myChat, theirChatPub, ledgerId, epk, iv, ct, aad }) -> Uint8Array | null   // grants, joins
            export async function hint(kPair, day) -> Uint8Array(4); collectedProof(kPair, frameId) -> Uint8Array(32)
            export async function sealGroup({ groupSecret, ledgerId, groupId, epochId, day, sender: { pub, sign }, message, bucket?, iv? })
            export async function openGroup({ groupSecret, ledgerId, groupId, epochId, env }) -> { ok, from, message } | { ok: false, reason }
            export async function groupKey(groupSecret, ledgerId, groupId, epochId); generateChatKey(); chatKeyFromJwk(jwk)
noise.js:   export class XXHandshake { constructor({ staticKey: ChatKey, prologue, initiator, ephemeral?, payload? });
                                       async next(msg?) -> { send?, done?, session? } | { error } }
            export class Session { remoteStatic; handshakeHash; encrypt(pt) -> Promise<ct>; decrypt(ct) -> Promise<pt | null> }
            export function prologueFor(ledgerId)    // "mw-wire-v1" || ledgerId; PROTOCOL_NAME = 'Noise_XX_P256_AESGCM_SHA256'
ck.js:      export async function makeCk({ signer: { pub, sign }, ledger, ek, epoch = 1, exp?, now }) -> CK
            export async function verifyCk(ck, { ledgerId, now }) -> { ok } | { ok: false, reason }; checkCkShape(ck)
            export class CkCache { constructor({ ledgerId, now }); put(ck); forSigner(pub); forEk(ek) }
            export async function ledgerCopy(node, ck, { consented })   // append('mw.ck', ck) only with consented: true
replay.js:  export class ReplayGuard { constructor({ store?, now, key }); load(); save(); check(sender, { id, t });
                                    accept(sender, { id, t, n?, conv? }) -> { ok, gap } | { ok: false, reason: 'window' | 'replay' }; gap(conv) }
lane.js:    export class ChatLane { constructor({ ledgerId, chatKey, hello: { site, owner }, torrentManager?, deviceClass, policy: { shareOnNetwork },
                                    holder?, ownTracker?, chatBits, now, setTimeout, clearTimeout, random });
                                    enable(); disable(); attachWire({ id, send, close, swarm }); detachWire(id); onMessage(id, bytes);
                                    setInterest(fn(tag, decoded, via: 'relay' | 'held')); setRoomFilter(fn(decoded) -> Promise<boolean>); stamped(type, { flags, body, bits? });
                                    send(frame, { to?, tag? }) -> { reached, route, frameId }; sendTo(wireId, frame); sendWant(entries);
                                    strike(wireId, reason); peers(); neighbourOf(chatPub);
                                    on('peer' | 'peer-gone' | 'envelope' | 'room' | 'ck' | 'pres' | 'ichal' | 'holding' | 'strike' | 'lane', fn) }
            export async function chatLaneInfoHash(ledgerId) -> 40 hex; relayBudget(deviceClass, { shareOnNetwork })
wire.js:    export function registerChatWire(torrentManager, lane) -> unregister   // registerWireExtension('mw_chat1', { onWire }, { swarms: ['rendezvous'] })
            export function chatExtension(lane, { name, swarmKind }); useOnWire(wire, lane, swarmKind)
holder.js:  export class Holder { constructor({ quotas?, now, pinMailbox = false }); offer(frameBytes, decoded, fromWire) -> { held, holding? | reason };
                                want(entries, wire) -> frames; challenge(wire) -> { challenge, hepk } | null; respond(wire, { ek, proof }) -> frames | null;
                                collected(frameId, proof, wire) -> boolean; expire(); stats() }
            export async function inboxProof(myChat, hepk, challenge); packHeld(frames) -> HELD bodies
outbox.js:  export class Outbox { constructor({ send(entry, { hold }) -> { reached, frameId }, onState, now, setTimeout, clearTimeout });
                                add({ id, to, stranger, deliverLater, payload }); ack(ids); holding(frameIdHex, wire); retry(id); destroy() }
            // holding(): each neighbour wire counts once per message; no new held copy once a HOLDING came back (retry() still sends);
            // the service seals one copy per message per UTC day and hold flag (entry.cache), so re-sends keep one frameId
            export class AckBatcher { constructor({ sendAcks(to, ids), random, setTimeout, clearTimeout }); queue(to, id); destroy() }
            export const STATES = ['delivered', 'handed', 'outbox', 'sent-unknown', 'not-delivered']
groups.js:  export function nextEpochId(prev, creatorPub, commit) -> Uint8Array(32); commitOf(secret); tieKey(prev, creatorPub)
            export function resolveConcurrent(children) -> winner with removed (union) and losers   // rank: largest removal set, then the
                                                                                                    // lowest SHA-256(prev | creator), then the lowest epochId
            export class GroupState { static create({ ledgerId, name, creator, members, now }); rekey({ signer, add, remove, admins? });
                                      receive(record, secret?) -> { ok, current, changed, conflict, reapply, readd } | { ok: false, reason };
                                      adopt(record, secret); readopt(record, secret); reapplyPlan() -> { remove, add }; prune();
                                      toJSON() -> { v: 2, ... }; static fromJSON(saved, { ledgerId, me, now }) -> GroupState | null;
                                      members(); effectiveMembers(); pending; admins(); isAdmin(pub); secretFor(epochIdHex); listening() }
            // code review v0.3, removals win: receive() refuses 'genesis' (a second genesis), 'stale-parent' (the parent was replaced
            // more than 7 days ago), 'creator-removed' (a known epoch below the parent removed the creator); a stored child whose creator
            // a later sibling removes stops counting; the losing siblings' removals stay pending (effectiveMembers excludes them) until an
            // admin re-applies them (reapply: every admin; readd: the losing admin's additions); readopt() takes an epoch whose parent is
            // unknown, which the service allows only from an admin of the current epoch and only when it lists this member
presence.js: export async function presFields({ day, status, kPair?, publicSigner?, random }); readPres(fields, { day, kPair?, signerPub? })
            export class PresenceBook { update(pub, status, wire); dropWire(wire); list() }; PRES_LABEL = 'Connected to you now'
service.js: export function createChatService(deps) -> { methods, on(event, fn) -> unsubscribe, setVisible(bool), groupMembers(groupId), destroy() }
            // groupMembers(groupId) -> [site pub] of a group this tab holds, without its own key; E_NOT_MEMBER otherwise
            // (reconciliation, the sdk lane's request: media.share({ to: groupId }))
            deps: { keys: { pub, sign, chat: ChatKey } (or chatPub + ecdh), ledgerId, node, cfg, deviceClass, hostOnly (boolean or a function read
                    at each call, integration I-8), ownTracker, wires, store,
                    prompt(kind, data) -> Promise<boolean>, now, random, setTimeout?, clearTimeout?, shareOnNetwork?, win? }
            // code review v0.3: the sealed store keeps contacts, counters, kept history, the group states (GroupState.toJSON: every
            // epoch of the grace window), the CK records of contacts and group members (until exp) and the ids this device delivered;
            // the replay guard and that state are saved 2 s after an accept (debounced) and at once on pagehide or a hidden page
            // (win, default window); membership (incoming group frames, groupMembers, SIG rosters) uses effectiveMembers(); a message
            // under a replaced epoch counts only when written before the replacement (plus 5 min); invites are ACKed; a copy refused
            // as a replay of a message this device delivered gets its ACK again (at most once a minute per id)
            methods: every chat.* of R 2.11.2 as async (params, ctx); params are objects ({ pub, text } | { pub, grant }, { name }, { name, text },
                     { name, members }, { groupId, pub }, { groupId, text }, { on }, { open }, { id }); positional arrays are accepted too
            events: 'message' | 'delivery' | 'request' | 'presence' | 'room' | 'group' | 'state' | 'keychange'
            cards (prompt kinds): chat.enable, chat.ck.ledger, chat.presence.public, chat.contacts.list, chat.dm.history, chat.requests.open, chat.holder
```
TorrentManager seams the chat lane uses (harden-loader lane, `src/loader/torrent.js`): `registerWireExtension(name, { onWire(wire, swarmKind,
{ late }) }, { swarms: ['rendezvous', 'chat'] })` returning an unregister function, and `joinLane({ kind: 'chat', infoHash, announce: [ownTracker] })
-> LaneHandle { leave() }` (public default trackers dropped by the manager too).
### src/files/*, src/media/*, src/sw/media-route.js (v0.3, built by lane media; changes listed in docs/deviations/media.md)
```
media/pad.js:       export const MIN_BUCKET = 65536, LARGE_MIN = 2097152
                    export function bucketBytes(n) / isBucket(n) / recordsFor(n, record)      // 2^k x (1 + j/8) from 2 MiB, powers of two below
media/format.js:    export const PIECE_LARGE = 262144, PIECE_SMALL = 65536, TAG_BYTES = 16, REGION = { poster: 1, media: 2, pad: 3 }, AAD_PREFIX = 'mw-media-v1'
                    export function plan({ posterBytes, mediaBytes }) -> { P, C, regions: { poster: [i0, i1), media: [i0, i1) }, chunks, total, paddedBytes }
                    export async function encryptChunk(fk, base, fid, i, total, region, plaintext /* C bytes */) -> Uint8Array(P)
                    export async function decryptChunk(fk, base, fid, i, total, region, ciphertext) -> Uint8Array(C)   // E_DECRYPT
                    export function nonceFor(base, i) / aadFor(fid, i, total, region) / newSecrets(random?) -> { fid, fk, base, swarmNonce }
                    export function buildManifest(f) / checkManifest(M) / regionOf(M, i) / partInfo(M, part) / chunkSpan(M, part, a, b) / idOf(M)
                    // M = { v: 1, fid, kind, mime, len, duration?, w, h, P, base, regions, total, ih, info?, ws?, name, t, plen, pmime }
                    export function mimeFits(kind, mime); POSTER_MIMES = ['image/jpeg', 'image/webp', 'image/png']
                    // checkManifest (code review v0.3): mime is a media type of sniff.js MEDIA_MIMES that matches kind (video/ or image/);
                    // pmime is '' or a POSTER_MIMES type; anything else (text/html, image/svg+xml) is E_DECRYPT, so onGrant drops it
media/sniff.js:     export function sniff(bytes) -> { mime, ext, kind, tier: 'plain'|'confirm', media, image, video }; mediaType(bytes)   // E_MEDIA_TYPE
media/strip.js:     export async function stripImage(blob, { maxSide?, type?, quality? }) -> { blob, removed, w, h, mime }   // browser
                    export async function stripMp4(blob) -> { blob, removed, location }; stripWebm(blob) -> { blob, removed }   // E_MEDIA_STRIP
                    export async function decodeImage(blob, opts) -> { drawable, width, height, close() }   // createImageBitmap with the
                    //   orientation option, without it, then an <img> under PIXEL_CAP; E_MEDIA_STRIP only when every decoder failed
                    export function sampleRanges(moov, stbl) -> [[start, end)]   // stripMp4 zeroes the samples of timed metadata and subtitle
                    //   tracks (gpmd, camm, mett, mebx, tx3g, ...) and frees their trak (removed 'moov/trak(gpmd)'); fragmented: E_MEDIA_STRIP
                    export function jpegSegments(u8) / jpegHasExif(u8) / readVint(u8, o, keepMarker) / stripperFor(mime) / webmInfo(blob)
media/faststart.js: export async function faststart(blob) -> { blob, moved }; readTopBoxes(blob); parseBoxes(u8, a, b); mp4Info(blob)
                    export function chunkOffsetTables(moov) / shiftChunkOffsets(moov, oldBoxes, newStart)
media/poster.js:    export const POSTER_MAX = 640; posterTime(duration); containerInfo(blob, mime); videoPoster(blob, env); makePoster(blob, sniffed, env)
                    // VIDEO_TIMEOUT_MS = 8000; videoPoster plays the muted inline video and pauses at the first frame ('loadeddata', 'playing'
                    // or requestVideoFrameCallback); makePoster -> { blob: null, mime: '', w, h, duration, note: NO_PREVIEW_TEXT } without a frame
media/session.js:   export class MediaSessions { constructor({ sw: { ready(), post(msg, transfer), onMessage? }, random, now, channel, capBytes, URL, keyTransfer })
                      open(id, { M, fk, readChunk }) -> { url, poster, mime, duration?, w, h, mode: 'worker'|'blob', sid? }
                      openFile(ref, { name, size, block, readBlock }) -> { url, mode }; close(id); closeAll(); onWorkerMessage(data) }
                    export function blobType(mime, firstBytes, allowed = MEDIA_MIMES)   // the Blob fallback's type: the manifest's only when allowed
                    //   and the decrypted bytes sniff as it, else application/octet-stream; a register that times out while keyTransfer is
                    //   'cryptokey' is retried once with the raw key bytes, and 'raw' is kept when that works
media/lane.js:      export class MediaLane { upload, list, open, close, share, revoke, delete, keepAvailable, pinRequest, onGrant, accept, decline, restore, ready, signOut }
                    // code review v0.3: own items (always) and accepted grants are kept in deps.vault ('media:' + id -> { v: 1, kind, from, M,
                    //   fk, t, previous? }); restore() reads the vault and the ledger's own-index items; ready() restores once per signed-in key.
                    //   revoke() -> { revoked, reencrypted, id }: { reencrypt: true } moves the item to idOf(new M) (event 'shared' { id, kind:
                    //   'own', replaces }); revoke and delete name every id the item had; the old id still finds it for its uploader
media/vault.js:     export function keysVault(getKeys, { name }) -> { usable(), put(key, value), del(key), entries() }   // over the working keys'
                    //   sealed per-origin cache (saveLocal / loadLocal); 'media:index' and 'files:index'
media/service.js:   export function createMediaService(deps) -> { methods: { 'media.upload', 'media.list', 'media.open', 'media.close', 'media.share',
                      'media.revoke', 'media.delete', 'media.keepAvailable', 'media.pinRequest' }, on(event, fn), onGrant(fromPub, grant), signOut(), restore(), destroy() }
                    // deps.vault: default keysVault(deps.keys, { name: 'media:index' }), null for memory only; methods and onGrant wait for lane.ready()
files/encrypt.js:   export const RECORD_BYTES = 65536, RECORD_PAYLOAD = 65520, AAD = 'mw-file-v1'
                    export async function encryptStream(readable, fk, { length }) / decryptStream(readable, fk); streamPlan(length) -> { records, bytes }
files/store-idb.js: export class IdbChunkStore { constructor(chunkLength, { name, length, backend?, indexedDB? }); put/get/close/destroy (abstract-chunk-store);
                      getAsync(i); putAsync(i, buf); has(i); missing(); complete(); static factory({ name, backend }) }
                    export function idbBackend({ indexedDB, dbName }) / memoryBackend()      // DB 'mw-files', store 'chunks', key [name, index]
files/validate.js:  export const LIMITS; validateInfo(info, { length, maxBytes, pieceLength?, privateSwarm? }); async validateFileTorrent(torrentFile, opts)
                    export function checkTorrentBytes(t) / createSha256() -> { update, digest, hex } / fileError(code, reason)   // E_FILE_HASH { reason }
files/names.js:     export function cleanName(name, { max = 96 }) / splitName / displayParts(name, sniffed) / randomName(kind, ext, random?) / downloadName(name, sniffed)
files/preview.js:   export const PIXEL_CAP = 24000000; imageSize(bytes, mime); previewPlan(bytes); riskTier(sniffed, blocked?); render(blob, plan, opts); fitWithin
files/serve.js:     export function contentDisposition(name) / fileHeaders({ name, size, range }) / mediaHeaders({ mime, size, range }); OCTET, ROUTE_CSP, MEDIA_TYPES
files/lane.js:      export class FileLane { share(file, { public, to, name, original }); list(); received(); fetch(ref, opts) -> { handle, name, size, mime, stream(), blob() };
                      preview(ref); save(ref); keepSharing(ref, on); stopSharing(ref); remove(ref); pinRequest(ref); onGrant(fromPub, grant);
                      restore(); ready() }; listOf(node, name)   // private files (own and received) kept in deps.vault as 'file:' + ref
files/service.js:   export function createFilesService(deps) -> { methods: { 'files.enable', 'files.list', 'files.received', 'files.share', 'files.fetch',
                      'files.preview', 'files.save', 'files.keepSharing', 'files.stopSharing', 'files.remove', 'files.pinRequest' }, on(event, fn), onGrant, destroy() }
                    // deps.vault: default keysVault(deps.keys, { name: 'files:index' }), null for memory only; methods and onGrant wait for lane.ready()
sw/media-route.js:  export function createMediaRoute({ env: { clients, now }, limits }) -> { owns(pathname), handle(event, req, url), register(data, event), close(data, event), inspect() }
                    // GET /_mw/f/<sid> and /_mw/media/<sid>[?part=poster]; 206 single and suffix ranges, 200 streamed, several ranges 200, 416, 410 (session gone)
sw/lib.js:          export const RESERVED_ROUTES = { file: '/_mw/f/', media: '/_mw/media/', idpReturn: '/_mw/idp-return' }; reservedRoute(pathname)
sw/protocol.js:     MSG += { sessionRegister: 'mw-session-register', sessionClose: 'mw-session-close', sessionLost: 'mw-session-lost', chunkNeed: 'mw-chunk-need', chunk: 'mw-chunk' }
                    PAGE_TYPES += [sessionRegister, sessionClose]   // chunks travel on the session's private port
sw/core.js:         routes RESERVED_ROUTES before every other route; /_mw/idp-return -> the loader document (shell) or a minimal drop-in page;
                    navigation responses it builds carry Cross-Origin-Opener-Policy: same-origin-allow-popups (a routing manifest's COOP wins) and Referrer-Policy: no-referrer;
                    export const NAV_COOP; inspect().media
```
Services (the SVC contract): methods are async (params, ctx) with ctx = { activation, tab, signal }. Gating order: E_HOST_ONLY (methods that reach
peers, before any prompt or request), E_POLICY (`_mw.cfg.media` for media and private files, `_mw.cfg.files` for public files), E_NEEDS_GESTURE
(UI methods without ctx.activation), E_NOT_SIGNED_IN. UI methods: media.upload, share, revoke, delete, keepAvailable; files.enable, share, save,
keepSharing, remove. No method returns fk or a CryptoKey.

### src/loader/torrent.js and the hardening helpers (built by lane harden-loader, changes in [deviations/harden-loader.md](deviations/harden-loader.md))
```
TorrentManager.addFileTorrent({ torrentFile?: Uint8Array | ArrayBuffer, infoHash?: hex40, store: StoreClass | storeInstance,
    announce: string[] /* own trackers; public defaults dropped, warning 'file-public-tracker-dropped' */,
    retain = true, uploadException = false }) -> Promise<FileTorrentHandle>
  // StoreClass: new Store(chunkLength, { name: infoHash, length, ...webtorrent opts }) (abstract-chunk-store; IdbChunkStore).
  // Private torrent added from the info dictionary only; .torrent <= 256 KiB; E_BAD_TORRENT for a bad .torrent or an infohash mismatch.
  // Waits for peer consent; store and bitfield survive rebuild() when retain. Same infohash -> the live handle.
FileTorrentHandle extends EventTarget  events 'torrent' { torrent }, 'verified' { index }, 'metadata', 'done', 'error' { error }, 'left'
  fields infoHash, kind = 'file', announce, retain, uploadException, done, left; getters torrent, store, downloaded, numPeers
  leave({ now = false }) -> Promise<true>     // leaves once saved (torrent 'done'), or at once; destroyStore: false; never rejoined
  setUploadException(on)                      // MF-45: this infohash uploads while uploads are off (shaped); hidden still locks
  // integration I-3, the surface the media and files lanes call: on(type, fn) / once / off (fn gets the piece index for 'verified',
  // the error for 'error', the torrent for 'torrent'), metadata({ timeoutMs = 60000 }) -> Promise<.torrent bytes> (E_FILE_UNAVAILABLE
  // on a timeout or when the handle leaves first), prioritize(i0, i1) (torrent.critical), stopSeeding() and destroy() = leave({ now: true })
TorrentManager.joinLane({ kind: 'chat' | 'group', infoHash: hex40, announce: string[] }) -> LaneHandle   // bare infohash, left 1, own trackers only
LaneHandle extends EventTarget  event 'torrent'; fields kind, infoHash, announce, left; getter torrent; leave() -> boolean
TorrentManager.registerWireExtension(name, { onWire(wire, swarmKind, { late }) }, { swarms = ['rendezvous'] }) -> unregister()
  // name /^[a-z][a-z0-9_]{0,31}$/, not ut_metadata, ut_pex, lt_donthave, mw_chain1, mw_chain2 (TypeError); E_EXISTS if taken. Called
  // synchronously from 'wire' after the 262,144-byte guard, before the extended handshake; existing wires get one call with late: true.
TorrentManager.budget -> { total, used, pending, free, priority, bySwarm: { [kind]: { wires, counted, floor, cap, allot } } }
  // one budget per tab (desktop 40, phones 8, chosen), priority site > rendezvous > chat > group > file, floors 2/2/1/1/1; caps count wires
TorrentManager.anchorWire(wire) -> boolean; ignoreWire(wire, reason) -> boolean (closes the wire, never bans the peer id); noteProgress(kind)
event 'no-progress' { kind: 'site' | 'rendezvous' | 'file', wires, sinceMs }   // after 60 s, then 2x up to 15 min, while it lasts
exports SWARM_KINDS, throttleUtMetadata(wire, { perMinute, now, onDrop }), evictionOrder(entries, { keep, anchorSlots, random })
```
Other new exports: `src/common/pointer.js` `ORG_MAX = 4`, `isOriginString`, `isLoaderVersion`, `nextKeyCommitment(ownerKey)`; records gain
`org`, `nx`, `ml`, `idp`; `verifyPointer(record, scope, { ..., previousRecord })` results carry `nx: 'none' | 'match' | 'mismatch' | 'changed'`
(nx= is sticky under one owner: a same-owner record with another or no nx is refused `'nx-changed'`; a matching nx rotates without rot=;
rot= v1 is deleted: `rotationInput` and `signRotation` need a scope). `src/common/magnet.js` `filterWebseeds({ ws, xs }, { origin, signed, base })`
(at most 4 ws and 2 xs; unsigned records keep only same-origin seeds). `src/loader/doh.js` `clampTimerMs`, `clampTtlSeconds`, results with
`adWording`. `src/loader/policy.js` `deviceClassOf`, `wireBudgetFor`, `allocateWireBudget`, `budgetVictim`, `ledgerBudgetFor`, `storageLines`.
`src/loader/harden.js` (live once lane sdk wires app.js): `createDeviceKey`, `signPin` / `verifyPin`, `signRefusal` / `verifyRefusal`,
`withdrawalState`, `isReadOnlyHubLedger`, `rotationDecision` (24 h first-visit delay, chosen), `loaderFloorOk`, `parseHostFingerprintLink`,
`pslHubCheck`. `src/loader/config.js` adds `pointer.maxTtlMs`, `wireBudget`, `wireLimits`, `storageBudget`, `webseedFilter`, `fileTorrent`, `harden`.

### src/loader/ui.js cards, src/dropin/panel.js, src/widget/* (built by lane ui, changes in [deviations/ui.md](deviations/ui.md))
```
ui.js:        export function createCards({ win, doc, lang, actions, strict, now, minVisibleMs, MutationObserverCtor })
                -> { prompt(kind, data) -> Promise, setIdentityHeader(info | null, handlers), close(), destroy(), rectOf(label), lang, host, open, kinds }
              export const CARD_KINDS; createUI(root, strings, { actions, lang }) exposes ui.prompt, ui.setIdentityHeader, ui.cards
              // actions = { signIn(options), openIdentity() } injected by the SDK wiring; one closed-root card at a time (8 queued);
              // buttons ignore isTrusted === false, run the redress checks, ignore clicks in the first 250 ms; no card has an input element
              // kinds: signin, storage-evicted, tap, consent (the R 2.14.1 site-origin cards), confirm, upload, phone-upload, offer,
              // owner-changed, foreign-address, error, mod.ban, mod.unban, mod.tombstoneMany, mod.decide; an unknown kind is E_BAD_REQUEST
              setIdentityHeader({ name, short, pub, mode: 'private' | 'same' | 'hub', origin?, hub?, unlock, backup }, { onSignOut, onRemove })
panel.js:     createPanel({ win, actions, lang }) -> panel with prompt(kind, data) and setIdentityHeader(...) (the same card API); the
              v0.2.1 identity fields show only with identity.legacy; settings action 'openIdentity'
widget/signin.js:     <mw-signin statement challenge-url proof-url>; createSigninElement(deps), createSigninRunner({ client, fetchFn, win, now,
              cooldownMs }) -> { run({ challengeUrl, proofUrl, statement }) }; same-origin URLs only; posts the proof text; events 'mw-signin'
              { state: 'pending' | 'signed-in' | 'error', code?, status?, body? }; client = import('../identity/client.js') (lane idp)
widget/chat-panel.js: <mw-chat-panel> (no attribute but lang: the chat service's own card names the tracker and the /.mw/site.json STUN list, 15.18; tracker= and stun= are not read); createChatPanelElement(deps), defineChatPanel(); listens to mw.chat.on('message')
              and on('room') with the chat service's shapes (from = the sender's site key string; a grant has no text and is not
              shown), reconciliation
widget/redress.js:    isTrusted(ev), checkElement(el, { win, doc, host, strict }) -> { ok } | { ok: false, reason }, createGuard(opts):
              speed bumps, not a lock (MF-06); the ancestor walk crosses shadow roots to their hosts (integration I-1)
strings.js:   ERROR_TEXT, CARD_TEXT, UI_TEXT, REPLACED_SENTENCES, DELIVERY_TEXT, IOS_TOR_TEXT, NOSCRIPT_TEXT, STRING_FLAGS (deliveryStates and
              iosTorStrings false until G-CH-1, G-CH-3 and RT 16 Q8); errorText, cardText, uiText, deliveryText, iosTorText, fmt, pickLang, setStringFlag
```
### src/loader/api.js, bridge.js, src/sdk/sdk.js (v0.3)
```
UI_METHODS += ['auth.signIn','auth.signInServer','identity.openIdentity','me.get(first per session)','me.sync','me.erase',
               'mod.ban','mod.unban','mod.tombstoneMany','mod.decide','chat.enable','chat.presence.set(public)','chat.requests.setOpen',
               'chat.holder.set','chat.direct.connect','files.share','files.save','files.keepSharing','media.upload','media.share',
               'media.revoke','media.delete','media.keepAvailable','report.send']
READ_METHODS += ['auth.state','auth.verify','identity.current','identity.backupStatus','chat.state','chat.presence.list','files.list',
                 'files.received','media.list','mod.queue']
WRITE_METHODS += ['auth.prove','me.set','me.del','db.setMine','chat.dm.send','chat.room.send','chat.group.*','media.open','media.close']
LOADER_ONLY_METHODS = ['identity.export','identity.import','identity.root','consent.accept','link.accept','keys.export','media.key']
PUSH_EVENTS += ['auth','chat','files','media','mod','keychange','hub']
SDK_VERSION = '0.3.0'
```
Error codes and every method's parameters: R 2.11.2 and 2.9.11. Each error code has English and French strings in `strings.js`.
Built by lane sdk ([deviations/sdk.md](deviations/sdk.md), which lists its method classes and contract-first adapters); the adapters were
wired to the landed modules by the reconciliation integrator ([deviations/integration-v03.md](deviations/integration-v03.md),
"Reconciliation"). Folded here:
```
The hub amendment to R 2.11.2 (docs/SDK.md, "Amendment to R 2.11.2: followed ledgers"; review-round acceptance pending):
  mw.hub.follow(target, { private }?) write (private: review round STALK-3), mw.hub.unfollow(ledger) write, mw.hub.list() read, mw.hub.createPage(options) UI; the read
  db.snapshot({ ledger }); a { ledger } option on db.get, db.list, db.subscribe, db.getMine, db.listBy (read only: a write
  with another ledger is E_POLICY); push 'hub' { type: 'change' | 'follow' | 'unfollow' | 'state', data }; hub mode only
  (drop-in: E_UNSUPPORTED); follow caps 250 phone, 1,000 desktop (R 3.2.3)
mountV03Services(api, { modules, deps }) -> { mounted, errors }      // the SVC deps of identity, chat, files and media
  chat seam given to files and media: { dm: { send(pub, payload) }, groupMembers(groupId) }   // grants as DMs, never a click
  sealedAdapter(sealed) -> { seal, open }      // no sealTo: no reader of durable grants (kind 4) exists, so media.share
                                               // { durable: true } sends the grant over chat only
setNodeIdentity(node, id) -> boolean          // ChainNode.setIdentity; false for a follower's RemoteNode
nodeIdentityOf(keys) -> { privateKey, pub, kind } | null   workingKeysOf(service) -> service.keys()
IdentityBinding.setLoaderKey(info | null)     // an imported moderator key signs this tab's writes: ready().auth 'signed-in',
                                              // identity { pub, short, name, mode: 'legacy' }
api.ownerConfirm(card) -> Promise<boolean>    // the shell and drop-in set it to the identity service's ownerAction (owner.policy)
src/loader/personal-site.js: genesisBlocks needs ChainNode.genesis (the only minting path); viewAdapters(recent) ->
  { stateOf, snapshotOf } reads a followed ledger from its recent-window view (recent.js viewOf(node).state().state)
window.__mwShell = { version, inspect(), rectOf(label) }   // rectOf: a loader card button's rectangle (tests click it)
```

### Final integration changes (v0.3; [deviations/integration-v03.md](deviations/integration-v03.md), "Final integration")
```
src/loader/personal-site.js: transportOf(record) -> { tr?, ws?, xs?, idp? }    // the template's transport, copied into the
  personal pointer: createPersonalSite({ ..., transport }) and personalPointer({ ..., transport }); never cs=, gen=, chain=,
  lo=, rot=, nx=, org= (ARCHITECTURE 15.13)
src/loader/app.js: startHubLaneClock(A)          // MultiGossip.tick() every 1,000 ms, setHidden(document hidden)
  inspectShell(A).hubLane = { joined, clock, stats, held: [ledger], followed: [ledger], peers: [peerInfo] } | null
  PSL rules = PSL_RULES + PSL_TEST_RULES (src/idp/psl.js; the test additions are empty outside a test build)
src/sdk/sdk.js: mw.ready()                       // shared while the first call is pending; every later call asks the loader again
src/loader/torrent.js: FileTorrentHandle._metadataBytes() -> null until torrent.info exists (WebTorrent's early torrentFile
  has no info dictionary)
src/identity/client.js: resolveIdp({ idp, doc, pointer })   // + the idp= of <meta name="mw-pointer"> when pointer is not a string
src/widget/chat-panel.js: _turnOn() calls mw.chat.enable() in the click (the chat service's card is the one consent);
  read-only test hooks: el.lobby -> [line], el.rectOf(label) -> { x, y, width, height } | null (a button by text, the message
  line by aria-label); no loader card of its own, no import of src/loader/ui.js
src/dropin/panel.js: rectOf(label) falls back to the v0.3 cards' rectOf (the services' cards live in the cards' own root)
src/loader/ui.js: Settings > Identity holds the 0.2.1 export and import fields only for a model without identity.v03
src/files/preview.js render -> { kind: 'text', text } | { kind: 'image', url: blob:, w, h } | { kind: 'none' }   (docs/SDK.md)
build.mjs: build({ testPsl: ['localhost'] })    // defines MW_TEST_PSL for loopback hub tests, as tools/build-idp.mjs --test-psl
src/loader/boot.js cspFor / render.js cspString, dev only: connect-src += http://127.0.0.1:* http://localhost:*
built as (review round, SCALE-6): the hub lane is swarm kind 'hub' (src/loader/torrent.js SWARM_KINDS, policy.js withHub);
  app.js joinHubLane passes kind 'hub' with wanted() and syncing() (MultiGossip.wantedWires, get syncing)
(proposed) the hub's recent-window cs= first screen (where a followed ledger's window is published is not specified:
  deviations/rows-social.md C-1); durable-grant readers (kind 4; no lane was given them); the kill switch's purge mode
  (no lane was given it); mw.hub.withdrawPage() (no lane; e2e E-SO-10 open); mw.mod.requestJoin(group) (not specified
  enough: return value, decline path, sealed item or chat grant, the stranger rule; rows-social C-2 and D-2; E-SO-7 runs
  over chat.dm.send grants); mw.site.info().pointer (no lane; site.info answers name, files, btih, source and mode)
```

### Ownership for the v0.3 build
As R 5.2: H1a, H1b, F1, I1, S1, C1, M1, P1 (wave 1); I2, I3, N1, C2, M2, T1, D1 (wave 2); A1, U1 (wave 3); X1, X2, Q1 (wave 4).
Write only inside your paths plus `docs/deviations/<agent>.md`; at most 8 agents at once.

## v0.3 C2: module contracts for smart seeding, the pin node, the zero-setup tools, calls and doors

> **Status: v0.3 C2, built; reviewed in the review round of R 5.3 (2026-10-22 to 2026-10-24, R 5.4).** The contracts of phase C2, written contract-first from
> [research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md](research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md) ("SZ") and the lane briefs, built by the eight C2 lanes
> and integrated on 2026-10-20 ([deviations/integration-c2.md](deviations/integration-c2.md)). ARCHITECTURE 8.1, 15.14, 15.15 and 15.16 state the
> rules. Each lane's `docs/deviations/<lane>.md` lists the exact exports it landed (more helpers and constants than below); this part
> names the contract, and the "As built" notes record where the landed code differs from the text it was built against. Same rules as above: ES modules, vanilla JavaScript, Node 22 and browsers for shared code, the browser floor, no new
> packages without a deviations entry, every public key `p256:`-tagged, RFC 8785 for every signed object. Browser only (owner decision,
> 2026-10-20): nothing here assumes an installed app or extension.

### src/loader/config.js, policy.js, seed-budget.js, seed-meters.js, seed-planner.js, dock.js, localwire.js (lane seed-policy; landed, exact exports in [deviations/seed-policy.md](deviations/seed-policy.md))
```
config.js:      CONFIG.seed = { phoneDefaultOn: false /* SZ-1 */, handoffWhileHidden: false /* SZ-2 */, superSeed: false, echoTargetCopies: 3,
                  dockDefaultMs: 7200000, dockCapMs: 28800000, dockMinBattery: 0.2,
                  rows: { desktop, phoneCharging, phoneWifi, phoneLimited /* with wifi: { H, K, E } after "I am on Wi-Fi" */, metered, local, call } }
                // the SZ 3.1.3 table in bytes per second and bytes (session null = none; the 20 GB month is decimal: 20,000,000,000)
seed-budget.js: export const SEED_LANES = ['H', 'K', 'E'], SEED_ROWS = ['desktop', 'phoneCharging', 'phoneWifi', 'phoneLimited', 'metered', 'hostOnly'],
                  MONTH_LANES = ['K', 'E']
                export function seedBudget(env, prefs = {}, config = CONFIG)
                  -> { row, call, lanes: { H: { rate, session }, K: { rate, session }, E: { rate, session } }, month: { cap, lanes: ['K', 'E'] },
                       local: { H, K, E, session, on }, hiddenH, defaultOn, ask }       // rates in bytes per second, caps in bytes, Infinity for none
                // env = detectEnvironment() plus battery ({ charging, level } | null), networkProof ('connection' | 'declared' | 'none'),
                //   dock (boolean), call (null | { limited: boolean })
                // prefs = { share, hostOnly, shareOnNetwork, declaredWifi, declaredPlugged, seedAsked, phoneDefaultOn?, handoffWhileHidden? }; the last two override the flags
                // host-only gives 0 everywhere; share off gives K and E 0 and keeps H (the MF-45 card is the person's explicit choice); the seven rows of SZ 3.1.3
                //   (row 7 is `call`: phones H 128 KiB/s with K and E 0; a desktop sends no E and halves K only while call.limited)
                // phones: K and E stay 0 unless shareOnNetwork, or phoneDefaultOn and row 2 applies, or dock mode runs (a click-started, time-boxed choice to share)
                // ask = 'consent' (row 2 applies, phoneDefaultOn is on and the seed.ask card was not answered: prefs.seedAsked) | 'wifi' (a declaration would raise a rate) | null
                // hiddenH = handoffWhileHidden on a phone; local.on = false means count local wires like any other (a metered network, a battery under 20% unplugged)
                export function laneRates(budget, { local = false } = {}) -> { H, K, E };  export function networkOfEnv(env) -> 'wifi' | 'cellular' | 'unknown' | 'saveData'
policy.js:      computePolicy(env, prefs, config) returns one more field, seedBudget: seedBudget(env, prefs, config); every other field is unchanged
seed-meters.js: export function monthKeyOf(ms) -> 'YYYY-MM' (UTC)
                export function createSeedMeters({ storage /* { get(key), set(key, value) }, synchronous or promise-returning */, now, key = 'seedMeters', persistMs = 5000 })
                  -> { add(lane, bytes, { local = false }), sessionUsed(lane, { local = false }), monthUsed(), remaining(budget), snapshot(), flush(), ready }
                // monthUsed = K plus E bytes of the current UTC calendar month on wires that were not local; remaining = { H, K, E: { session, month, local } } in bytes left
                //   (month Infinity for H); snapshot = frozen { session, local, month: { key, K, E, used }, persistent, loaded }; flush() writes the month record now (call it when
                //   the page hides); ready resolves when the stored record was read. Every storage call is in try/catch with an in-memory fallback.
                //   Counters are local only: never sent, never ranked (ARCHITECTURE 8)
seed-planner.js: export function planSeeding({ items, budget, now, config }) -> { order: [ih], idle: [ih], share: { [ih]: fraction of its lane rate } }   // pure
                // items = [{ ih, lane, bytes, complete, copies: { complete, atLeast }, pinned, openedAt, own }]. H first (oldest first), then K and E by copy deficit
                //   (echoTargetCopies - copies.complete, larger first), then recency (newest openedAt first). E skips pinned and incomplete items and any lane whose
                //   rate is 0; a lane serves no more items than leave each at least the 32 KiB/s shaping floor; the rest wait in idle. Ties break by ih
dock.js:        export function createDock({ nav, doc, now, setTimeout, clearTimeout, battery, config })
                  -> { supported(), start({ ms, declared }) -> Promise<state>, stop(reason = 'user') -> state, state() -> { on, until, reason, declared },
                       on('start' | 'stop', fn(state)) -> unsubscribe }
                // navigator.wakeLock.request('screen'), requested before any await so it stays inside the click; battery = a BatteryManager-like EventTarget, null (no API:
                //   start needs declared: true) or undefined (nav.getBattery() at start); no audio, media element or other keep-alive
                // start refused with reason 'unsupported' | 'hidden' | 'declare' | 'unplugged' | 'battery' | 'denied'; stopped with 'hidden' | 'unplugged' | 'battery' |
                //   'cap' | 'user' | 'released'. strings.js has a sentence for each: SEED_TEXT 'dock.refused.<reason>' and 'dock.stopped.<reason>', and 'dock.stop' for the button
localwire.js:   export function isLocalPair(stats) -> { local, reason }                  // pure; stats = an RTCStatsReport-like Map or array
                // reason 'local' | 'no-stats' | 'no-pair' | 'no-candidate' | 'srflx' | 'prflx' | 'relay' | 'not-host' | 'public-address'
                // the selected pair (transport.selectedCandidatePairId, else nominated and succeeded); local only when both candidates are 'host' and each address is private
                //   (10/8, 172.16/12, 192.168/16, fc00::/7, fe80::/10, and 169.254/16 and loopback), an mDNS '.local' name, or hidden;
                //   100.64/10 (carrier-grade NAT, shared by a carrier's customers) is 'public' (code review v0.3, lane loader-sw)
                export function selectedPair(stats) -> candidate-pair stats | null;  export function addressKind(address) -> 'private' | 'mdns' | 'hidden' | 'public'
test/unit/lint-contrib.test.mjs: the SZ 3.1.9 rules over src/**/*.js (ARCHITECTURE 8.1.9); passes on the tree and fails on an inline fixture. One recorded exception:
                src/idp/cards.js (the device-link QR scanner) may call getUserMedia with audio: false
```
Readings of the build that the design left open (docs/deviations/seed-policy.md, items 1 to 6): the session figure of the budgets table applies to each active lane, not as one total
(the owner may prefer a total, which `remaining()` would change); the most restrictive row that applies wins (a metered network, or a battery under 20% unplugged, is row 5 on any
phone, and a metered desktop too); "I am on Wi-Fi" counts only where the browser reports no network type, and proof beats a declaration; dock mode counts as the opt-in for K and E while
it runs; during a call a desktop sends no E, and halves K only while the call is bandwidth-limited; local wires never lift a metered network or a battery under 20% unplugged.

### src/loader/torrent.js, availability.js, superseed.js, pinwire.js, src/files/*, src/media/* (lane seed-engine)
```
torrent.js:      TorrentManager.setSeedBudget(budget)       // per-lane token buckets; the site torrent is lane 'K'; a file torrent is 'H' when its handle has
                                                           // uploadException (an own upload), 'K' when the person chose to keep sharing, else 'E'
                 addFileTorrent({ ..., lane }) -> FileTorrentHandle with a lane field
                 // a lane at its rate, its session cap or the month cap is choke-locked (lockWire) and unlocked on refill with about 1 s of hysteresis; the
                 //   client throttle is the sum of the active lane rates; wire 'upload' bytes feed meters.add(lane, bytes, { local }), local from isLocalPair on
                 //   the wire's peer connection (read once after connect; false when unreachable); setHiddenLock(on) keeps H wires unlocked when
                 //   budget.hiddenH; E torrents get budget in the order planSeeding returns; event 'evidence' { infoHash, evidence } when counts change.
                 //   Every v0.2.1 and v0.3 guard stays (wire caps, budgets, idle close, the ut_metadata limiter, the 262,144-byte guard)
availability.js: export function evidence({ local, wires, webseed, pin, now }) -> { tier, count, atLeast, reported, checkedAt, label }
                 // tiers E0 to E4 exactly as ARCHITECTURE 8.1.5 (60 s for bitfields, 10 minutes for a web seed probe, 15 minutes for a heartbeat); atLeast when the
                 //   wire cap bounds the count; reported unless E2; label is a SEED_TEXT key; never a count above the evidence
pinwire.js:      registerWireExtension('mw_pin1', handler, { swarms: ['site', 'file'] })     // 'mw_pin1' is a valid, unreserved extension name
                 // verifier role: send chal once per wire when the remote advertises mw_pin1; verify hello and rcpt against the key in _mw.cfg.pin (src/pin/frames.js);
                 //   anchorWire an authenticated pin; record receipts per infohash. Responder role only when the top frame has window.__mwPinCall and its
                 //   'pin.key' equals _mw.cfg.pin: sign through 'pin.sign', answer chal with hello, send rcpt when a file completes verified. The key never enters the page
                 export async function fetchHeartbeat(wsBase)       // at most every 10 minutes; verified with src/pin/heartbeat.js against _mw.cfg.pin; cached
superseed.js:    behind CONFIG.seed.superSeed (default false): BEP 16 for H torrents on phones (an empty bitfield, then one piece revealed per wire at a time, the
                 next only after the wire has it; authenticated pin wires first; stop when a receipt or a complete peer bitfield exists); with fake wires the bytes
                 uploaded before the first complete copy stay under 110% of the item
files/lane.js, files/service.js, media/lane.js, media/service.js:
                 list() keeps 'available' ('kept' | 'online' | 'unknown', unchanged) and adds evidence { tier, count, atLeast, reported, checkedAt } and label
                 own uploads move avail.onlyHere -> handoff.waiting -> handoff.sending -> avail.keptBySite; "Sent: one full copy reached {name}" stays for peers
                 with _mw.cfg.pin set and the uploader's key the owner key, an own H item gets a pin request through the existing d.pin.request seam automatically
                   (owner decision SZ-6); otherwise requests stay UI-driven. The E lane never fetches what the person did not open
```
As built ([deviations/seed-engine.md](deviations/seed-engine.md)): `TorrentManager` adds `setSeedMeters(meters)`, `setHiddenLock(on)`, the read-only
`seeding` getter (`{ active, row, lanes: { H, K, E: { rate, session, used, local, open } }, month: { used, cap }, local }`), `evidenceInputs(ih)`,
`evidenceFor(ih)`, `localState(ih)`, `setPinSource(pinWire)` and `notePin(ih)`; the 'evidence' event's detail adds `kind`; handles gain `lane`, `setLane`
and `uploaded`. `availability.js` exports `handoffState({ ev, requested, pinPct })` (states onlyHere, waiting, sending {pct}, kept, plus 'sent' for
a peer copy and 'nobody'), `LABELS`, `TIERS`, `WINDOWS`, `availableOf`, `publicEvidence`, `sameEvidence`, `isLabel`. `pinwire.js`:
`createPinWire({ tm, pinKey, win, fetch, now, random, codec, site, log }) -> PinWire` (`attach`, `detach`, `refresh`, `key`, `responder`, `ready`,
`evidence(ih, now)`, `receipt(ih)`, `isPinWire(wire)`, `pinWires(ih?)`, `pinProgress(ih)`, `fetchHeartbeat(wsBase, { force })` with the 10-minute interval,
`heartbeat()`, `on('receipt' | 'pin-wire' | 'heartbeat' | 'warning')`), the module-level `fetchHeartbeat(wsBase, { pinKey, fetch, now, site, codec })`
(one read, no cache), and `createPinPageHost({ tm, storeClass, announce }) -> { start(meta), stop(ih), status() }` for `window.__mwPinHost`. The
services' own items carry `evidence`, `label`, `labelParams` and `handoff`; the files and media services take `owner`, `pinEvidence(ih, now)` and
`evidenceInputs(ih)`. **(proposed)** The `pin.request(item)` seam: the loader passes none in C2 (no page-to-pin request path), so `files.pinRequest`
and `media.pinRequest` answer `E_POLICY` and SZ-6 requests nothing from a browser (deviations/integration-c2.md O-1); not built
because no lane was given the page side (ROADMAP "Next": the node's queue and its signature check are built).

C2 integration (`src/loader/app.js`): a `PinWire` is attached to the manager in every engine tab; in the pin's own page it sets
`window.__mwPinHost` (stores `IdbChunkStore.factory({ name: 'pin-' + ih })`; `start` answers `'not-pinned'` unless the node lists the
infohash as pinned and not paused through the bridge's `file.pinned`) and `setSeedBudget(null)`; `window.__mwShell.inspect().pin` = `{ key,
responder, pinPage, host, wires, receipts, heartbeat: { at, checkedAt } | null }` (read-only).

### src/pin/frames.js, src/pin/heartbeat.js, tools/pin.mjs, deploy/pin (lane pin-node)
```
frames.js:    export const EXT_NAME = 'mw_pin1'      // shared Node 22 and browser code; WebCrypto; src/chain/crypto.js for 'p256:' keys and raw P1363 ECDSA
              encode / decode of JSON frames of at most 1,024 bytes:
                chal  { t: 'chal', n }                              // n = 16 random bytes, b64url
                hello { t: 'hello', key, ih /* 40 hex */, n, at, sig }
                rcpt  { t: 'rcpt', key, ih, total, at, sig }
              export function helloBytes(ih, n, at)       -> utf8('mw-pin1-hello\n' + ih + '\n' + n + '\n' + at)
              export function receiptBytes(ih, total, at) -> utf8('mw-pin1-receipt\n' + ih + '\n' + total + '\n' + at)
              export async function verifyHello(frame, { expectKey, ih, n, now, skewMs = 300000 }) -> { ok, reason }
              export async function verifyReceipt(frame, { expectKey, ih, now }) -> { ok, reason }
              export function isPinSignable(bytes)        -> true only for bytes that parse as exactly one of the two forms above (the Node signer refuses all else)
heartbeat.js: export function makeStatus({ key, site, at, ihs, monthBytes, monthCap }) -> { v: 1, t: 'mw-pin-status', key, site, at, items, monthBytes, monthCap }
                // items = b64url of the first 16 bytes of SHA-256(utf8('mw-pin-status-v1|' + ih)): no infohash in the clear, so private media swarms stay private
              export function statusBytes(obj)             -> utf8('mw-pin-status-v1\n' + JCS(obj without sig))
              export async function signStatus(obj, signer)
              export async function verifyStatus(obj, { expectKey, now, maxAgeMs = 900000 }) -> { ok, reason, age, has(ih) }
                // caps: 256 KiB, 4,096 items
test/vectors/pin.json (append only): a fixed test key, hello, rcpt, status, and negatives (wrong prefix, skew, other key, oversize, a cleartext infohash)
tools/pin.mjs: every existing flag stays. New: --pin-key <jwk>, --status <file> [--status-every 300], --auto-accept owner, --month-cap <bytes> (ARCHITECTURE section 10);
              ops on the __mwPinCall binding of the pinned page's top frame: 'pin.key' -> public key; 'pin.sign' (b64url bytes) -> b64url signature, refused unless isPinSignable
deploy/pin/Dockerfile: environment PIN_URL, PIN_KEY (a file path in a volume), PIN_STATUS (default /srv/site/ws/pin-status.json), PIN_MONTH_CAP, PIN_AUTO_ACCEPT
test/fixtures/pin/: a helper that starts pin.mjs headless against a 127.0.0.1 site with chromiumArgs({ allowRemote: false }), a temporary profile and key
              -> { pub, statusFile, stop() }
```

As built ([deviations/pin-node.md](deviations/pin-node.md)): `verifyReceipt(frame, { expectKey, ih, now, skewMs, total })` also checks the total (the
torrent length in bytes); `verifyStatus(input, { expectKey, site, now, maxAgeMs, skewMs }) -> { ok, reason, age, count, has(ih), status }` checks the
site (the ledger id) when given; `heartbeat.js` adds `itemId`, `checkStatus`, `encodeStatus`, `parseStatus`, `statusUrl`; `frames.js` adds `makeChallenge`,
`makeHello`, `makeReceipt`, `checkFrame`, `parseSignable`. `tools/pin.mjs`: the bridge's `pin.sign` refuses with `E_POLICY`, `E_BAD_REQUEST`,
`E_NOT_SIGNABLE`, `E_STALE` or `E_NOT_KEPT`; the signer is off when the pin key is the owner key; `runPin` takes `onHost` and (C2 integration)
`onPage`, and asks the page for `__mwPinHost` at every status tick until it has offered it once. `test/fixtures/pin/start-pin.mjs` takes `keyFile`
(C2 integration) and exposes `inspect()`.

### src/calls/*, the chat `sig` seam, src/loader/call-ui.js (lanes calls and wire-ui)
```
chat/service.js: createChatService(deps) returns one more field beside methods and on:
                   sig = { send(pub, payload, { group }) -> Promise<{ reached }>, onReceive(fn(pub, payload, meta)) -> unsubscribe, listen(pubs, untilMs) -> stop }
                 // send seals with sealDm under KIND.sig (5) into a T.SIG frame via S.lane.stamped(T.SIG, { flags: 0, bits: STAMP_BITS_CONTACT }): never FLAG_HOLD, never
                 //   FLAG_STRANGER; counter and replay conversation 'sig|' + pub (DM gap detection is untouched); never remembered in history, never ACKed
                 // deliver(): a KIND.sig message inside a SIG frame from an accepted, unblocked contact, or from a pub in an active listen set (a call roster, at most
                 //   2 hours), goes to onReceive; KIND.sig inside an ENV, or a non-sig kind inside a SIG, is dropped; listen adds those pubs' pair tags to the lane interest
                 // chat.direct.connect answers E_POLICY when _mw.cfg.calls is off, else E_UNSUPPORTED (direct data channels stay P2); the method stays
calls/limits.js: every constant of ARCHITECTURE 15.14: caps 6 audio and 4 video; ring expiry 45 s; 10 rings per contact per hour; the t window 60 s; payload at most 15,000
                 bytes; sdp at most 14,000; roster at most 5; cand at most 16 of at most 512 bytes; control channel id 0 label 'mw-call' and 16 KiB; the per-class
                 bitrates; the ladder thresholds; listen at most 2 hours
                 export const CALL_FLAGS = { phoneNotes: false }; setCallFlag(name, value)   // code review v0.3: the call state's `platform` is
                 // 'call.ios' | 'call.android' only with phoneNotes true (after G-PS-1 to G-PS-4 and G-CL-2, SZ section 4 P0); null until then
calls/signal.js: encode, decode, validate { v: 1, c, k, s, t, sdp?, cand?, media?, roster?, g? } with the bounds above, the k enum, 'a=fingerprint:sha-256' in sdp, the
                 duplicate and replay rules by (c, s) and t, the ring rate limits, the bucket choice
calls/ice.js:    iceConfig({ stun, turn, relayOnly }) from the site's own STUN list and _mw.cfg.turn only (never a default public server); iceTransportPolicy 'relay' only when a
                 relay exists and the person chose it; filterCandidate(c, { sameLan }) drops received private, loopback and link-local candidates unless both chose
                 "same local network" and passes mDNS '.local'; the caller strips its own private host candidates before it sends
calls/session.js: one RTCPeerConnection per remote with perfect negotiation (polite = the higher public key), the negotiated data channel id 0 'mw-call' (JSON control: mute,
                 camera, screen, roster, leave, renegotiation, ICE restart); getUserMedia only here; getDisplayMedia only when the UI calls it inside a click handler; replaceTrack
                 when the page is visible again; a Wake Lock during a visible video call; after connect the remote certificate fingerprint (remoteCertificateId) is compared
                 with the fingerprint of the SDP received over SIG, and a mismatch hangs up with E_CALL_FAILED
calls/mesh.js:   the caller offers to each acceptor; every other pair: the lower public key offers; join, leave (pairs close within 5 s), the caps
calls/adapt.js:  a pure ladder from stats samples, class and mode to setParameters encodings and a video pause (ARCHITECTURE 15.14), and the 2 s getStats driver
calls/service.js: export function createCallService(deps) -> { methods, on(event, fn) -> unsubscribe, destroy() }     // the SVC contract of src/chat/service.js
                 methods: 'calls.start', 'calls.accept', 'calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera', 'calls.screen', 'calls.state', 'calls.list'
                 events: 'ring', 'state', 'peer', 'ended'
                 UI methods (start, accept, screen) need ctx.activation and a loader card through deps.prompt, kinds 'call.start', 'call.incoming', 'call.group',
                   'call.metered', 'call.screen'
                 deps: { chat (the sig seam plus contacts and groups accessors), keys, cfg, policy (class, metered), hostOnly, stun, turn, RTCPeerConnection, mediaDevices,
                         wakeLock, now, random, onSeedYield(state) }
                 host-only -> E_HOST_ONLY before any request; calls off -> E_POLICY; the callee creates no connection before accept and the caller sends no candidate before it
test/vectors/calls.json (append only): payload vectors and negatives
call-ui.js (src/loader, lane wire-ui): the loader-owned call panel over the site frame; every text from CALL_TEXT; styles appended to ui.css
test/e2e/scenarios-calls.mjs: export callsScenarios({ run, assert }), CALLS_ORDER = ['E-CL-3', 'E-CL-1', 'E-CL-2'], CALLS_WEBKIT_ORDER = ['E-CL-1W']
```
`_mw.cfg.calls` is `'off'` (default) or `'contacts'`; `src/chain/state.js` lists it (`CFG.calls = ['off', 'contacts']`, added by the C2 integrator: a
state rule, MF-21, blocks stay valid; before it a `_mw.cfg` naming calls was hidden whole).

As built (calls and wire-ui; [deviations/calls.md](deviations/calls.md), [deviations/wire-ui.md](deviations/wire-ui.md)): `createCallService(deps)` also returns
the loader-only `answer(id, { video })` (the call panel's own incoming card), `media(id)` (tracks for the panel; the SDK never gets a
`MediaStream`), `setVisible(visible)`, `setNetwork()`, `inspect()` and `destroy()`; deps add `prefs()` (`{ sameLan, hideIp }`), `mediaSession`, `mode`
and `deviceClass`. Calls require the site's own STUN or a relay (`E_POLICY`), and "Hide my IP" without a relay is `E_POLICY`. The chat seam
also exposes `contact`, `groupMembers`, `state`, `ckOf` and `learn`. `src/loader/call-ui.js`: `createCallUi({ win, doc, nav, lang, cssHref, ... })
-> { attach(service), detach, prompt(kind, data), inspect, rectOf(label), destroy }`; it copies the rules of the shell's loaded `/_mw/ui.css`
into a `<style>` in its closed root (the `<link>` is the fallback) and sits at the top right (C2 integration). In a development build (loopback or
`<meta name="mw-dev">`) `window.__mwShell.setCallPrefs({ sameLan, hideIp })` sets the two choices for the page (never stored; C2 has no switch
or strings for them).

### src/loader/api.js, bridge.js, src/sdk/sdk.js, sdk-static.js, src/dropin/binding.js (lane wire-ui)
```
UI_METHODS    += ['calls.start', 'calls.accept', 'calls.screen', 'net.dock', 'net.keep']       // net.keep is desktop only
READ_METHODS  += ['calls.state', 'calls.list', 'net.seeding']
WRITE_METHODS += ['calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera']
HOST_ONLY_METHODS += ['calls.start', 'calls.accept', 'calls.decline', 'calls.camera', 'calls.screen', 'net.dock', 'net.keep']
                // as built (wire-ui deviation 1, kept by the integrator): not hang-up, mute or the reads, so a call can always be ended;
                // a call cannot exist in host-only mode, where the service answers E_HOST_ONLY before any request
PUSH_EVENTS   += ['calls']
ERROR_CODES   += C2_ERROR_CODES from src/loader/strings.js: 'E_BUSY', 'E_DECLINED', 'E_NO_ANSWER', 'E_MEDIA_DENIED', 'E_NO_DEVICE', 'E_CALL_FAILED'
mw.calls.start({ to: pub | [pubs] | groupId, video? }) / accept(id, { video? }) / decline(id) / hangup(id) / mute(id, on) / camera(id, on) / screen(id, on)
mw.calls.state(id) / list() / on('ring' | 'state' | 'peer' | 'ended', fn) -> unsubscribe        // no method returns a MediaStream
mw.ready().features.calls                  // from _mw.cfg.calls like features.chat: false when 'off' or unset (advisory; the service itself answers E_POLICY)
mw.net.seeding() -> { lanes: { H, K, E: { rate, used } }, month: { used, cap }, dock: { on, until }, keeper }                 // read-only, local counters;
                                                                                                    // cap null = no cap (Infinity does not cross the Bridge)
mw.net.dock({ hours }) / mw.net.keep(on)                                                         // UI methods; keep is desktop only
mw.files.list() and mw.media.list() items: 'available' as before, plus evidence { tier, count, atLeast, reported, checkedAt } and label (a SEED_TEXT key)
drop-in mode: every mw.calls method answers E_UNSUPPORTED (a page load would end the call); static stubs in sdk-static.js
```
The loader mounts `calls` after `chat` in `mountV03Services` with the `sig` seam, `keys`, `cfg`, the current policy class and metered flag, `hostOnly`, the site's own STUN list
(MF-44), `_mw.cfg.turn`, and the window's `RTCPeerConnection`, `mediaDevices` and `wakeLock`. `app.js` passes `env.battery`, `networkProof` ('connection' when `classifyNetwork`
reports wifi or cellular, 'declared' after `seed.declareWifi`, else 'none'), the dock state and the call state into `computePolicy`, calls `tm.setSeedBudget(policy.seedBudget)`,
creates the seed meters on the per-origin pref store and the dock controller, and feeds the call state (`onSeedYield`) back into the budget.

### src/loader/strings.js (v0.3 C2; built by lane docs-strings, contract-first for the lanes above)
```
SEED_TEXT, CALL_TEXT = { en: {...}, fr: {...} }      // same keys and placeholders in both languages; frozen
  SEED_TEXT keys: avail.onlyHere, avail.heldBy, avail.keptBySite, avail.nobody, avail.noPin, handoff.waiting, handoff.sending, seed.monthUsed, seed.ask,
                  seed.declareWifi, seed.declarePlugged, dock.start, dock.on, dock.stop, keeper.toggle, keeper.on, meter.visit, meter.tracker,
                  dock.refused.<unsupported|hidden|declare|unplugged|battery|denied>, dock.stopped.<hidden|unplugged|battery|cap|user|released>
  CALL_TEXT keys: call.start, call.startRelay, call.incoming, call.group, call.screen, call.metered, call.ios, call.android, call.noPath, call.notHere, call.ended,
                  call.declined, call.busy, call.kind.audio, call.kind.video, call.accept.audio, call.accept.video, call.decline, call.mute, call.unmute,
                  call.camera.on, call.camera.off, call.screen.start, call.screen.stop, call.hangup, call.state.ringing, call.state.connecting, call.state.direct,
                  call.state.relayed, call.state.reconnecting, call.state.left, call.paused, call.videoPaused, call.ringTitle, call.calling,
                  call.keepOpen (code review v0.3, round 2: what a phone shows while CALL_FLAGS.phoneNotes keeps call.ios and call.android off)
seedText(key, lang = 'en', params = null), callText(key, lang = 'en', params = null)       // English fallback; '' for an unknown key
C2_ERROR_CODES = ['E_BUSY', 'E_DECLINED', 'E_NO_ANSWER', 'E_MEDIA_DENIED', 'E_NO_DEVICE', 'E_CALL_FAILED']                  // sentences in ERROR_TEXT, both languages
C2_REUSED_CODES = ['E_NOT_SIGNED_IN', 'E_HOST_ONLY', 'E_POLICY', 'E_NOT_CONTACT', 'E_PEER_UNREACHABLE', 'E_LIMIT', 'E_UNSUPPORTED']   // already in ERROR_TEXT
```
`call.incoming` holds the sentence only; its buttons are `call.accept.audio`, `call.accept.video` and `call.decline`. `{kind}` is `call.kind.audio` or `call.kind.video`, `{names}`
a list the caller joins, `{duration}` a clock such as 2:35. `avail.heldBy` and `meter.visit` have no singular, so they read "at least 1 others" and "1 visitors" for a count of one: the
caller shows `avail.heldBy` only for a count of two or more, or asks this file for a singular. `test/unit/strings-c2.test.mjs` pins every English text of SZ 3.1.5 and 3.5.

### tools of the zero-setup lane (ARCHITECTURE section 10)
```
tools/ship.mjs:       export const SHIP_DEFAULT_EXP_DAYS = 399            // owner decision SZ-3
                      ship({ ip, to, ct, name, key, suffix, remoteDir = '/opt/felinar', stagingOnly, dryRun, exec, ssh, rsync, resolve, now })   // every external step injectable
                      CLI: ship --ip <a.b.c.d> --to ssh://<user>@<host> --ct <mailto:|https:> [--name] [--key] [--suffix] [--remote-dir] [--staging-only] [--dry-run]
tools/name-check.mjs: export function ipName(ip, suffix = 'nip.io') -> 'a-b-c-d.<suffix>'
                      export async function nameCheck({ ip, suffix, resolve4 }) -> { ok, name, got, reason: 'ok' | 'blocked' | 'other' | 'nxdomain' }
                      // the block-page addresses 64.176.22.9 and 2001:19f0:c800:2315:: mean 'blocked'
src/loader/doh.js:    shouldSkipDoh(hostname) is also true for 'nip.io', 'sslip.io' and any name ending in '.nip.io' or '.sslip.io' (ARCHITECTURE section 4); 'nip.io.example.com' is looked up
tools/publish.mjs:    --calls (implies --chat; the site's own tracker and STUN are required, MF-44); for an IP-literal, .nip.io or .sslip.io scope --chain defaults to --name and
                      the 450-byte warning becomes "This name cannot carry a DNS record; the page tag is the only pointer (expires <date>)."
tools/ledger-admin.mjs: cfg --calls off|contacts and --clear calls
tools/dev-server.mjs: --tracker-proxy <port>      // WebSocket upgrades on /tracker go to ws://127.0.0.1:<port>; bind rules unchanged
tools/check-site.mjs: for a name shouldSkipDoh skips: "DNS pointer: not possible for this name (page tag only)", no DoH request
bin/felinar.mjs:   'ship' -> tools/ship.mjs
deploy/one-box/:      Caddyfile, docker-compose.yml, README.md (S2 rung 2a), a 'pin' profile that builds ../pin/Dockerfile; CI job 'one-box': caddy validate, docker compose config
```

As built ([deviations/zero-setup.md](deviations/zero-setup.md)): `ship(options, deps)` takes the injectable steps (`exec`, `ssh`, `rsync`, `resolve`,
`probeCertificate`, `checkSite`, `publish`, `keygen`, `now`) in either argument and adds the flags `--out`, `--dist`, `--exp`, `--policy`, `--bits` and
`--new-ledger`; `nameCheck` has a fifth reason, `'error'`; `name-check.mjs` adds `chooseName` (the sslip.io fallback) and `describeNameCheck` (S2 Z4); the
dev server's result has `trackerProxy`; `npm run ship` runs `tools/ship.mjs`.

### src/common/pointer.js, src/loader/doors.js and the door tools (lane doors)

> **Status: v0.3 C2, built; reviewed in the review round of R 5.3 (2026-10-22 to 2026-10-24, R 5.4).** [research/v03/S4-doors.md](research/v03/S4-doors.md) and ARCHITECTURE 15.15; the lane's readings are in
> [deviations/doors.md](deviations/doors.md).

```
src/common/pointer.js   record.dr: string[] (dr=, 1..DOOR_MAX hosts, one key, KEY_ORDER after org)
                        DOOR_MAX = 8, HINT_MAX = 4, DOORS_TOTAL_MAX = 12, DOOR_PAGE_PATH = '/_mw/open.html', FELINAR_SCHEME = 'web+felinar:'
                        isDoorHost(h), isLoopbackDoorHost(h), doorOrigin(h), hostOfOrigin(origin), doorsOf(record)
                        parseDoors(record, hints) -> { owner, guest, hints, all: [{ host, kind, origin }] }
                        parseHintList(value), normalizeRecordText(text)
                        parseLinkFragment(fragment) -> { head, decoded, handler, segments, hints, genesis }
                        formatLightLink({ door, record, genesis, hints }) -> string; parseLightLink(link) -> { ok, door, origin, path, record, decoded, handler, hints, genesis } | { ok: false, error }
src/loader/doors.js     DOOR_TIMING = { firstByteMs: 4000, perDoorMs: 12000, staggerMs: 250, inFlight: 3, backoffMs: 600000 }
                        doorCandidates({ current, lastGood, record, ledgerDoors, hints, pageHost, max }) -> [{ host, origin, kind }]
                        hintAllowed(host, { pageHost }), doorTorrentUrls(candidates, btih), doorWebseeds(candidates, { health, now, max, exclude })
                        createDoorHealth({ load, save, now, backoffMs, max }) -> { ready, get, ok, fail, inBackoff, order, snapshot }
                        doorJsonFor({ name, version, buildId, files }), checkDoorJson(json, own) -> { ok, sameBuild, buildId, version, reason }
                        probeDoor(origin, { fetch, own, sameOrigin, timeoutMs, signal }) -> { origin, host, state: up|other-build|opaque|bad|down, buildId, json, ms, reason }
                        fetchFirst(urls, { fetch, verify, staggerMs, inFlight, firstByteMs, perDoorMs, maxBytes, signal, onResult }) -> { ok, url, bytes, results, aborted? }
                        LEDGER_DOORS_KEY = '_doors', LEDGER_DOORS_MAX = 24, LEDGER_DOORS_BYTES = 2048, LEDGER_DOORS_INTERVAL_MS = 3600000
                        ledgerDoorsProblem(value), ledgerDoorsValue(hosts), ledgerDoorsFrom(entry, { owner, previous, now }), readLedgerDoors(node, opts)
                        enforceDoorBudget({ cache, budgetBytes, keep, maxCopies = 4 }) -> { evicted }
                        doorsPanelModel({ candidates, health, now }), doorsBannerModel({ candidates, health, now, max }), doorLinkFor(candidate, { fragment, portable })
                        DOOR_SANDBOX = 'allow-scripts'; doorFiles(parsed, blobs); doorFrameHtml(script)
                        mountDoorView({ container, files, path, routing, frameScript, sdk, base, win, onNavigate, onTitle, onBlockedNavigation, readyMs }) -> { iframe, door, degraded, rendered, navigate, currentPath, destroy }
                        frame protocol: frame -> parent { mwDoor: 'ready', v: 1 } + port; parent -> port { mwDoor: 'render', files: [[path, Blob]], path, routing, sdk, base };
                                        port -> parent { mwDoor: 'rendered', title, path } | { mwDoor: 'navigate', path } | { mwDoor: 'external', url } | { mwDoor: 'error', message }
                        frameMain(window): sets window.__mwDoor = true before it writes the page
src/loader/strings.js   DOOR_TEXT { en, fr }, doorText(key, lang, params)
src/loader/ui.js        createDoorsUi({ doc, lang }) -> { node, setModel, onAction, nodes }; doorStateText(state, lang); createUI(): setDoors(model), showLinkPaste({ onOpen, onCancel, lang }), showGate({ ..., note })
src/sw/core.js          DOOR_PAGE_PATH, DOOR_JSON_PATH; mw-set-current from the door page -> mw-ack { ok: false, error: 'door-page' }
build.mjs               DOOR_PAGE, DOOR_MANIFEST, DOOR_JSON; doorManifestJson(version), doorPageHtml(shellHtml), doorJson(outputs, { version, buildId })
tools/publish.mjs       --door <host>... (needs --chain): link.txt, link-card.txt, link-qr.svg, doors.json; summary.link; result.link
                        --door-kit <dir> --release-list --release-sig --release-key [--dist] [--door-site <publish out>]...
                        doorList, qrText, qrSvg, linkCardText, doorKitFiles, doorKit({ out, dist, releaseList, releaseSig, releaseKey, doorSite })
tools/check-site.mjs    --door [--allow-no-cors]; checkDoor(url, { fetch, timeoutMs, allowNoCors, log }) -> { ok, failures, warnings, results, door }
window.__mwShell.inspect().doors (read-only), see request 7
```
C2 integration: `src/sdk/sdk.js` answers the hello from a frame whose origin is `"null"` when `window.__mwDoor` is set (the door renderer sets it) and
posts it to the parent with `'*'`; `src/loader/boot.js` imports the loader by `new URL(LOADER_URL, document.baseURI)`; `ActivationTracker.watch`
ignores a cross-origin target; `tools/ledger-admin.mjs doors --key owner.jwk --file <ledger.json> --door <host>... | --clear-doors | --show`
writes the owner's `_doors` item (`ledgerDoorsValue`).

### Ownership for the C2 build
Lanes, each writing only inside its paths plus `docs/deviations/<lane>.md` (SZ 5; the exact lists are in the lane briefs): seed-policy, pin-node, calls, zero-setup and docs-strings
(none depends on another); seed-engine (after seed-policy and pin-node); wire-ui (after seed-policy, seed-engine, calls and docs-strings); doors (after docs-strings, wire-ui and
zero-setup; [research/v03/S4-doors.md](research/v03/S4-doors.md)). The C2 integrator owns `test/e2e/run.mjs` and `lib.mjs`, INTEGRATION-STATUS, DEVIATIONS, `test/vectors/LOCK.json` and the
`formats-vectors` test (it adds `pin.json` and `calls.json`), the `docs-links` test (it adds `docs/research/v03` to its search list, because the top documents cite the design by
path), the CHANGELOG, `package.json`, `build.mjs`, `dist/`, the spec status marks, and the e2e scenarios E-PS-1 to E-PS-4 and E-ZS-1.

## v0.3 code review: lane ledger-tools (contract changes; ARCHITECTURE 15.17)
```
src/chain/state.js
  State.wrote: Set<pub>                       // keys that have written here (not roots, not a recover rotation to the key itself);
                                              // a keyinfo from them is late (state rule) and admit refuses it
  State.policy.banned: Set                    // PERMANENT bans only (changed); State.policy.banUntil: Map<pub, until | Infinity> as before
  State.checkpoint.S                          // non-enumerable: the S of a checkpoint in effect that the DAG is not pruned to yet
  export function isBanned(pub, state, now?) -> boolean            // permanent, or temporary with now < until when now is given
  export function roleOf(pub, state, now?)                         // a key under a ban in force, or one that rotated away, is 'reader'
  export function snapshot(state, { now }?)   // policy.banned: bans in force (permanent; with now also temporary ones);
                                              // policy.banUntil: { pub: until } of temporary bans (in force at now when given)
  export function allowListed(pub, state) -> boolean               // allow membership through rotations, transitively
  export const CFG_TIERS = ['image','video','audio','text','html','svg','xml','pdf','document','archive','executable','installer',
    'script','macro','unknown'];  export const CFG_KEYS          // _mw.cfg adds blockTiers (distinct CFG_TIERS), wall (everyone |
                                                                 // follow | nobody | approve), requests 'introduced'
  reduceFromCheckpoint(S, blocks, { ..., unknown })              // unknown: covered hashes a partial copy never saw (recent.js)
  admit() adds E_POLICY 'keyinfo-late' and 'rotated'
src/chain/dag.js
  dag.pruneTo(checkpointBlock, S, { depths }?) -> { dropped }; dag.lastAdded lists the orphans it connected
  dag.coveredDepths(S) -> { list (depths in S.covered order, -1 unknown), max }
src/chain/node.js
  identity { privateKey, pub, kind?, rc? }    // rc (43 b64url): { t: 'keyinfo', rc } is written before the key's first other block here
  node.roleOf(pub); node.isBanned(pub); node.role and node.snapshot() read this node's clock (now)
  node.exportSnapshot() -> [ { mw: 'checkpoint-v1', ledger, checkpoint: { h, snap, S } }?, ...exportBlocks() ]
  node.importSnapshot(entries)                // applies a leading checkpoint-v1 or recent-v1 header's checkpoint first (anchored);
                                              // a header is not counted as rejected
  node.applyCheckpoint(S, { block }) -> { dropped, h, connected }; tick() applies the checkpoint in effect on its own
  export const CHECKPOINT_SNAPSHOT_KIND = 'checkpoint-v1'
  config += { futureMs: 300000, futureDeferMs: 3600000, modClockMs: 900000 }
  ingest reasons += 'E_FUTURE' (more than futureMs ahead, beyond futureDeferMs; within it the block is deferred), 'E_CLOCK' (a live
                    moderator ban, unban, tombstone or allow claiming a time more than modClockMs before its arrival)
  store checkpoint row: { h, snap, S, depths }
src/chain/recent.js
  new RecentView({ ..., maxPerAuthor = 1024, now })   // view.add() keeps only blocks with an effect in the view's state:
                                                    // rejected { h, reason: 'no-effect', strike } | { h, reason: 'future' }; added = kept
  export const MAX_VIEW_PER_AUTHOR = 1024, VIEW_FUTURE_MS = 300000; viewOf(node) passes node.now
src/chain/multi.js
  RECENT answer += truncated?: boolean (first page)  // carried to applyWindow; peerFor().recent() resolves { blocks, checkpoint, truncated }
  limits += { maxWindowBlocks: 4096 }; refusals with strike count against the wire; delivered counts kept blocks only
src/pin/frames.js
  export const PIN_REQUEST_PREFIX = 'mw-pin1-request\n'
  export function pinRequestBytes({ site, ih, size, sha256?, at, name? }) -> utf8(prefix + site + '\n' + ih + '\n' + size + '\n' +
    (sha256 or '') + '\n' + at + '\n' + name)       // the author signs it with its site key; isPinSignable() refuses it
  export async function makePinRequest({ site, ih, size, name?, sha256?, at, author }, signer) -> { ih, size, name?, sha256?, author, at, sig }
  export async function verifyPinRequest(request, { site, now, skewMs = 300000 }) -> { ok, reason }
    // reasons: 'malformed' | 'unsigned' | 'bad-author' | 'bad-field' | 'skew' | 'signature'
tools/pin.mjs        'file.request' needs a request signed by its author for the site's ledger id (refused: 'site-unknown', 'unsigned',
                     'bad-signature'); --auto-accept owner pins only requests the owner key signed. writeSnapshot writes the checkpoint first.
tools/live.mjs       export function launchOptions({ allowRemote, env }) -> { args, chromiumSandbox, warning }; launchBrowser({ ..., chromium, warn })
                     allowRemote: chromiumSandbox true, WebRtcHideLocalIpsWithMdns not disabled; MW_CHROMIUM_NO_SANDBOX=1 drops the sandbox
                     readLedgerBlocks(page) -> [{ database, blocks, checkpoint }]
tools/ledger-admin.mjs  loadLedger(blocks, { ..., checkpoint }) -> { ..., checkpoint }  // a leading checkpoint-v1 header is used
                        cfg --block-tiers <kind>[,<kind>]... | none, --wall everyone|follow|nobody|approve, --requests off|on|introduced
                        CFG_ENUMS += wall, requests 'introduced'; CFG_KEYS += wall, blockTiers; export { CFG_TIERS }
tools/snapshot.mjs   buildSnapshot({ blocks, ..., checkpoint }) -> { ..., entries, checkpoint }; encodeSnapshot(entries) is what is written
tools/lint-floor.mjs api rules may carry guard: [names] (a typeof / in / && / ?. guard of one of them, or a try, on the line or the line
                     before), tryAhead and unlessFollowedBy
test/vectors/ledger.json  lg-021 to lg-025 (append only); expect.banned = every key in State.policy.banUntil
```

## v0.3 code review: lane loader-sw (contract changes; ARCHITECTURE 15.18)
```
src/identity/vault.js
  export const RECORD_MAX_BYTES = (MAX_ITEMS_PER_AUTHOR - 1) * MAX_DATA_BYTES   // 31,403: one origin's private record at the IdO
  export const VAULT_MAX_BYTES = 200000                                          // the whole vault, as JSON
  export function keyTag(text) -> b64url(SHA-256("mw-vault-gone-v1\n" + text)) cut to 22 characters   // a shredded key's tombstone
  export function recordSize(record) -> bytes; export function mergeRecordCopies(...records) -> per field, the newest write wins
  data += ver (only goes up), gone { tag: t } (at most 4,096), floors { ledgerId: seq }, unlinked { origin: t },
          archived (at most 16 replaced own or local keys); label += owns (the label's key owns a ledger), meCut { origin: t }
  vault.version(); vault.bump(); vault.size(); vault.retire(text, now); vault.isRetired(text); vault.floor(ledgerId);
  vault.raiseFloor(ledgerId, seq); vault.markOwner(label, now); vault.eraseRecord(label, origin, now)
  vault.mergeRecord(label, origin, incoming, { maxVault }) -> 'ok' | 'too-large' | 'vault-full' | 'bad' | 'none'   // refused: not merged
  vault.mergeFrom(other, { now }) -> boolean   // another copy of this vault (escrow, another window): chat epochs by e, record
                                               // keys by r, own and local when absent (a different key under one epoch goes to
                                               // archived), links newest per origin minus unlinked, sites, me per field after
                                               // the cuts, legacy keys, floors by max, the larger sign index; retired keys never
                                               // return; ver = max + 1
  vault.shred(label, what) retires every key it removes; vault.unlinkOrigin(origin, now) records unlinked
  passphraseStrength(pass): list words count by position (near-consecutive or sorted words count less); a run of 3 or more
    equal, consecutive or keyboard-row neighbour characters counts 2; generatePassphrase(words) redraws until each word counts 11 bits
  makeBackupFile(secrets, pass, { ..., onProgress }); openBackupFile(text, pass, { onProgress })
src/identity/argon2.js
  export async function argon2idAsync(opts, { sliceBlocks = 1024, onProgress, yieldFn }) -> Uint8Array   // argon2id()'s output, in
                                               // slices that yield to the event loop (scheduler.yield, MessageChannel, setTimeout)
  export function yieldToEventLoop() -> Promise<void>
src/identity/wrap.js, derive.js
  passphraseKey(pass, salt, kdf, { onProgress }); wrapWithPassphrase(pass, secrets, { ..., onProgress });
  unwrapWithPassphrase(pass, blob, { onProgress }); rootStar uses argon2idAsync
src/identity/client.js
  export const WANT_SETS = [['keys'], ['proof'], ['keys', 'proof'], ['record'], ['erase']]   // validateRequest refuses any other want
  validateRequest(req): challenge only with purpose 'server'; hubDefault accepted and ignored
  export const MAX_BLOB_CHARS = 400000
  export function fitEscrow(escrow) -> { root?, vault? } | null   // an oversized vault copy is dropped, never the sign-in
  export function opensInPlace(win) -> boolean   // an iOS Home Screen app (navigator.standalone, display-mode standalone on iOS)
  signIn({ ..., redirect }): true starts with the redirect, false never; left out, a key sign-in (no proof) does where opensInPlace(win);
    the request never carries hubDefault, an oversized escrow vault or an oversized record
src/identity/signin.js  buildChallenge: nonce = the verifier's nonce for purpose 'server', else 16 random bytes from the IdO
src/identity/migrate.js deleteLegacy = stored && K.status.legacyBackedUp === true   // a backup made after the 0.2.1 key moved in
src/identity/store.js   WorkingKeys.identity -> { privateKey, pub, rc? }   // ChainNode writes { t: 'keyinfo', rc } first (15.17)
src/identity/service.js auth.signIn passes redirect: true only when asked; returned object += noteMeaningful(method) (emits 'kit'
                        { reason: 'first-action' } once while the kit is not saved)
src/idp/idp.js
  export const VAULT_LOCK = 'mw-idp-vault', FAST_REFUSAL_MS = 1000, BACKUP_URL_MS = 60000,
    BACKUP_FILE_NAME = 'magnet-web-identity-backup.json'
  createIdp(env): env += { locks, hubSuffixes, sharedOrigins, setTimeout }; returned object += startDownload(text)
  every vault or state change runs inside navigator.locks.request(VAULT_LOCK) and re-reads the wrapped record, the vault and the
    state there first; a window whose wrapped record changed under it drops its session (E_USER_CANCELLED) and unlocks again next time
  unlock({ escrow, allowCreate, pre }): an escrowed root counts only of kind 'prf' (method 'passkey'); the escrowed vault is merged
    into this one (mergeFrom) on every sign-in, never adopted whole
  handleRequest(req, origin, channel) runs validateRequest; keyMode 'visit-only' when req.shared === true or
    isSharedOrigin(origin, sharedOrigins); a ledger label marks the label owns when the request creates a page or is an owner action
  answer K: escrow only for a PRF-wrapped root (null after a passphrase unlock); vaultEscrow = the vault this sign-in saved;
    status += legacyBackedUp; a record over the caps is not merged (the site keeps its copy)
  replaceAllKeys({ pre }) -> { replaced, kept }   // a label that owns a ledger keeps its key
  makeBackup({ pre }) -> text | null: the KDF, then the saveBackup card (the download starts from its button; the URL lives
    BACKUP_URL_MS); fileSaved only on 'saved'
  WebAuthn: prfSalt() is computed before any press and the stored records are read when the card is drawn; a refusal faster than
    FAST_REFUSAL_MS shows tapToFinish and retries in its click; a second one is E_PASSKEY_REFUSED and the passphrase card follows;
    the PRF get() after create() comes from a tapToFinish click when create() returned no PRF output
src/idp/store.js   acceptEscrow({ root, vault }): a root only of kind 'prf'
src/idp/psl.js     createPsl({ rules, extra, hubs }) -> { publicSuffixOf, isPublicSuffix, isHubSuffix, hubSuffixOf };
                   hubSuffixOf(host) only for listed hubs (MW_HUB_SUFFIXES at build time, plus PSL_TEST_RULES in a test build);
                   hubShapeOf(host) -> { label, suffix } | null; isSharedOrigin(origin, list = SHARED_ORIGINS) (MW_SHARED_ORIGINS)
src/idp/passkey.js create({ nickname, env, timeoutMs, salt }), get({ credId, env, timeoutMs, salt })
src/idp/cards.js   signin(data): the hub box starts unchecked unless the identity origin's own build lists the page's template and
                   the page asks for the default (buildDefault; review round UX-12); one line by mode: linkedLine, hubLine,
                   mirrorLine + cannotSeeOthers, keyOnlyHere + cannotSeeOthers; passphrase(create) adds passphraseNoEscrow;
                   saveBackup({ text, download, copy }) -> 'saved' | 'later'; tapToFinish() -> true | null; progress(fraction);
                   recoveryKit({ ios, escrow, checkCode }) (no Home Screen step); kitDue(...).offerHomeScreen is always false
src/idp/strings.js IDP_STRING_FLAGS = { iosStrings: false }; setIdpStringFlag(name, value)   // MF-63: iOS lines off until the gate
                   keys += mirrorLine, passphraseNoEscrow, unlockingProgress, tapToFinishTitle, tapToFinishText, tapToFinish,
                   passkeyRefused, kitIosEscrow, backupSaveTitle, backupSaveText, backupSaved, backupCopy, backupCopyText,
                   backupNotSaved; addToHomeScreen removed; ERRORS += E_PASSKEY_REFUSED
src/idp/idp.css    inputs, textareas and selects at 16 px
src/loader/api.js
  SERVICE_EVENTS.identity.events += 'kit'
  export const MEANINGFUL_METHODS = ['db.set', 'db.del', 'db.append', 'db.setMine', 'identity.setName', 'me.set', 'chat.dm.send',
    'chat.room.send', 'chat.group.send', 'chat.dm.keepHistory', 'files.share', 'media.upload']   // after one succeeds: noteMeaningful
  export function identityHeaderOf(info, keys) -> { name, short, pub, mode, unlock: 'visit' | 'passkey' | 'passphrase', backup }
  export function restoreMedia(service) -> Promise<number>   // called whenever working keys are installed
  export async function writeRotation(node, keys, ledgerId) -> block | null   // the recover rotate of keys.rotateNotice
  export function ownerCfgPin(node) -> pin | null   // only from a _mw.cfg entry whose block hash is in state.ownerWritten
  export function stunNames(list, lang) -> 'a.example, b.example and c.example' | 'no STUN server'
  cardFor(kind, data, { lang, stun }); promptAdapter(ui, { lang, log, stun }); chat.enable names the lane STUN list
  MwApi: setLaneStun(list); offerKit() (the 'kit' card, once per page); openSignInCard: { fallback: 'redirect' } -> 'continue-here'
  UI_CARD_KINDS += 'kit', 'continue-here'; mountV03Services common deps += listingVisible(item), pinKey()
src/loader/ui.js
  CARD_KINDS += 'kit' (button: openIdentity({ intent: 'kit' })), 'continue-here' (button: signIn({ ...options, redirect: true }))
  export const HEADER_FOLD_MS = 5000; createCards({ ..., setTimeout, clearTimeout, headerFoldMs }); cards.headerState
  setIdentityHeader(h): on a coarse pointer or a screen under 720 px the header folds into a 44 px chip (data-mw-header-chip)
    after headerFoldMs and opens again on a tap; padding includes env(safe-area-inset-bottom)
  signin card: E_POPUP_BLOCKED or E_IDP_UNREACHABLE settles { fallback: 'redirect', code }; upload card: uploadStripped only when
    data.stripped, else uploadAsIs
src/loader/strings.js UI_TEXT += uploadAsIs, kitTitle, kitPromptText, kitButton, later, continueHereTitle, continueHereText,
                   continueHere, headerShow; the DNS pointer badge says '(DNSSEC: resolver says validated)'
src/loader/app.js  #host:<name>@<fp> (parseHostFingerprintLink): only a pointer signed by that key is used ("not signed by the key
                   the link names"); on a rotateNotice for this ledger the loader writes the recover rotation before any other
                   block; the owner's loader refreshes its personal pointer (_mw.ptr); a followed ledger opens on a memory store
                   with no tick; doorDownloadPlan asks byteDoors() only
src/loader/torrent.js
  export const OWN_STUN_KINDS = ['chat', 'group', 'file']
  export function laneIceServersOf(list) -> [{ urls }]   // 'stun:' and 'stuns:' URLs only, at most 4
  manager.setLaneIceServers(list); manager.laneIceServers   // what chat, group, file and private media swarms gather ICE through
                                                           // (none named: host candidates only); site and rendezvous: the defaults
  manager.joinLane({ kind, infoHash, announce, ledgerSync })   // ledgerSync: true keeps the shared STUN (the hub ledger-sync lane)
  export const PRIORITY_RANGES_MAX = 8
  FileTorrentHandle.prioritize(i0, i1): a stream selection in front of the whole file plus critical, dropped once its pieces verify;
    deprioritize(i0, i1); priorityRanges -> [{ from, to }]
src/sw/protocol.js    MSG.chunkCancel = 'mw-chunk-cancel'   // worker -> page { type, sid, req, i }: nobody waits for that chunk now
src/sw/media-route.js a cancelled range stream rejects what it waits for and posts chunkCancel for each chunk still requested
src/loader/doors.js   export function byteDoors(candidates, { record, base }) -> the candidates asked for .torrent and web seed bytes:
                      owner doors, the last good door, and others only when their host is an owner door of the record or a
                      ws= or xs= host; a guest door or a hint is never asked for the site's bytes
src/loader/mod.js
  export const LISTED_PREFIX = '_listed/', DENY_PREFIX = '_deny/'
  export async function idKey(prefix, id) -> prefix + b64url(sha256(utf8(id)))
  export function denyIdsOf(state, item) -> { ids, listingH }; listingVisible(state, item, { listedKeys }) -> boolean;
    listedKeysOf(state) -> { ih, authors, keys }; pendingListings(state) -> queue items of kind 'listing'
  mod.queue() includes pendingListings; mod.decide: accept of a listing puts _listed/<idKey(ih)> (built as, review round MAL53-1:
    _listed/<idKey(listedId(ih, author))> = { by, t, ih, author }, see "v0.3 review round"), decline tombstones it, deny puts
    _deny/<idKey(id)> for each of denyIdsOf and tombstones the listing; report.send of a media item carries its ih
src/loader/personal-site.js
  export const REFRESH_BEFORE_MS = 30 * 86400000, POINTER_KEY = '_mw.ptr', LOAD_BATCH = 32
  export async function refreshPersonalPointer({ keys, record, now, before }) -> { record, text } | null
  hub service: load() keeps a follow whose pointer only expired (hub.list() items += expired, refreshedAt) and opens follows in
    batches of LOAD_BATCH; hub.refresh(ledger); a newer pointer at _mw.ptr replaces the stored one
src/loader/localwire.js    addressKind('100.64.x.x') -> 'public' (RFC 6598 shared address space)
src/loader/seed-budget.js  local.on is false on a phone whose network is 'unknown' unless Wi-Fi was declared
src/dropin/engine.js       writes the recover rotation like the shell; laneStun() -> Promise<list>: /.mw/site.json's stun, read once
                           when a lane, a file swarm or the chat card needs it (from the stored copy, else the host)
src/loader/api.js (seam)   createTorrentSeam({ get, ensure, beforeSwarm }): beforeSwarm() settles before joinLane and addFileTorrent;
                           MwApi.setLaneStunSource(fn): the chat card waits for fn() before naming the list; promptAdapter's stun
                           may return a promise (read for the chat card only)
```

## v0.3 code review: round 2 integration (contract changes; ARCHITECTURE 15.19)

The cross-area requests of the four area fixers that the integrator applied (code review round 2, [review/DESIGN-REVIEW.md](review/DESIGN-REVIEW.md)
section 8). Tests: `files-c2-handoff`, `media-service`, `chat-core-seal`, `chat-lane-service`, `chain-net-stores`, `sw-core`, `call-ui`,
`strings-c2`, `widget-signin`, `signin-verify`, `idp-protocol`, `tools-v03-ledger`, `loader-review-v03`, `deploy-one-box`; e2e E-FI-1, E-PS-1,
E-PS-3, E-CH-1, DOOR-DOWN, DOOR-HASH, DOOR-GUEST, E-SO-1, E-SI-1.

```text
src/files/lane.js     deps += listingVisible(item) -> boolean (premoderation, mod.js), pinKey() -> pin key | null (ownerCfgPin)
                      list(): another author's listing is left out while listingVisible(item) is false; an own one stays, with pending: true
                      fetch/preview/save/... of another author's pending listing -> E_POLICY 'this file waits for a moderator of this site'
                      _pinKey(): deps.pinKey() when given, else _mw.cfg.pin; the owner's automatic pin request (SZ-6) and evidence pin.configured use it
src/files/service.js  createFilesService(deps) passes listingVisible and pinKey to the lane
src/media/lane.js     _pinKey() as the files lane; export const RESEED_MAX = 8
                      restore(): own items read from the device's vault join their swarm again (_seed({ infoHash, lane: 'K' })), newest first,
                      at most RESEED_MAX, never in host-only mode; items read from the ledger's own index are not fetched for this
                      open() passes cancelChunk: (i) => handle.deprioritize(i, i)
src/media/service.js  createMediaService(deps) passes pinKey to the lane
src/media/session.js  MediaSessions.open(id, { M, fk, readChunk, cancelChunk }); on mw-chunk-cancel { req, i } the page stops answering req and
                      calls cancelChunk(i); onWorkerMessage({ type: 'mw-message-error' }) ends every pending media register that sent a
                      CryptoKey with { ok: false, error: 'messageerror' }; open() retries with the raw key on 'timeout' or 'messageerror'
src/sw/protocol.js    MSG.messageError = 'mw-message-error'   // worker -> page, pushed: a message from this page could not be read here
src/sw/core.js        core.messageError(event) -> boolean: posts { proto, type: 'mw-message-error' } to event.source; sw.js and the
                      sw-core.js attachment listen for 'messageerror'
src/chat/limits.js    export const CK_EPOCH_STEP = 1, CK_EPOCH_MAX = 1048576
src/chat/ck.js        new CkCache({ ledgerId, now, max, rotated(signer) -> boolean })
                      put(ck) -> ... | { ok: false, reason: 'ck-rotated' } (signer rotated away) | { ok: false, reason: 'ck-epoch-jump' }
                      (epoch above the cached one by more than CK_EPOCH_STEP + floor(time since it was taken / 90 days));
                      forSigner/forEk drop a CK whose signer is rotated away; makeCk and checkCkShape refuse an epoch above CK_EPOCH_MAX
src/chat/lane.js      a CK frame's 'ck' listeners are awaited (_emitWait; a listener may return a promise): the wire's next frame is read
                      after the chat key is cached and the interest refreshed
src/chat/service.js   ledger().role(pub) = node.roleOf(pub) || roleOf(pub, state, now()); ledger().banned(pub) = node.isBanned(pub) ||
                      isBanned(pub, state, now()); ledger().rotated(pub) = state.rotations.has(pub); ckFor(pub) is null for a rotated
                      key (cache and ledger copies); the CK cache is created with rotated; onCk strikes nothing for 'ck-rotated'
                      or 'ck-epoch-jump'; onCk awaits refreshInterest(true), and a refresh that a later one replaced waits for that one
src/identity/service.js  the role fallback is roleOf(pub, state, now())
src/chain/stores.js   IdbBlockStore.flush(): when the transaction fails, the entries it held go back into the pending meta (a value set
                      meanwhile wins) and the error is thrown
src/widget/signin.js  imports src/identity/client.js statically; run() calls client.signIn({ purpose: 'server', challenge: <Promise>,
                      want: ['proof'] }) before its first await (a client given as a promise is awaited first, tests only)
packages/verify/verify.js  the signing input (PREFIX + jcs(c)) is built before nonces.consume; a failure is 'parse' and uses no nonce
src/loader/app.js     createPage (mw.hub.createPage) -> E_POLICY unless the working keys' keyMode is 'hub'; __test.createPage;
                      createCallUi({ ..., phone: () => A.env.isMobile })
src/loader/call-ui.js noticesOf(state, lang, { phone }) adds call.keepOpen on a phone while state.platform is null; createCallUi({ phone })
                      (a boolean or a function); the ring card shows the same note
src/loader/strings.js CALL_TEXT += 'call.keepOpen' (en, fr); DELIVERY_TEXT.handed = '{count} peers reported holding it at {time}. They may
                      go offline.' (still behind STRING_FLAGS.deliveryStates)
src/idp/strings.js    removePrivateDataText adds the limit sentence of CARD_TEXT.removePrivateData; passphraseWeak names the rule
src/idp/idp.js        readBuild(doc) -> { version, id, hash, test, hubs, shared }   // hubs: HUB_SUFFIXES, shared: SHARED_ORIGINS
tools/build-idp.mjs   buildIdp({ ..., hubSuffixes, sharedOrigins }) -> { ..., hubSuffixes, sharedOrigins }; --hub-suffix <suffix>...
                      (checkHubSuffix: lowercase, two labels or more) and --shared-origin <origin>... (checkSharedOrigin: an exact https
                      origin; http loopback only with --test) define MW_HUB_SUFFIXES and MW_SHARED_ORIGINS and enter the build id and build.json
tools/ledger-admin.mjs  listed --key <owner or moderator key> --file <ledger.json> --ih <40 hex> [--author <key>]
                      export async function listedKey(ih, author?) -> with an author: '_listed/' + b64url(sha256(utf8(ih + "\n" + author)));
                        without one: the legacy '_listed/' + b64url(sha256(utf8(ih))), credited only to a sole lister (MAL53-1)
                      export async function listingAuthors(blocks, ih) -> the distinct authors of the mw.files listings of ih
                      export async function acceptListing({ blocks, identity, ih, author?, now }) -> { block, blocks, key,
                        value: { by, t, ih, author } }; without author: the sole lister in the file, else a ToolError asking for --author
deploy/pin/Dockerfile ENV MW_CHROMIUM_NO_SANDBOX=1 (the container is the boundary); deploy/one-box pin service: cap_drop [ALL],
                      security_opt no-new-privileges:true
test/e2e/lib.mjs      export async function dismissKitCard(page) -> boolean   // presses "Later" on the loader's recovery kit card
```

## v0.3 review round (contract changes; ARCHITECTURE 15.20)

The ten area fixers of the review round of R 5.3 (2026-10-22 to 2026-10-24; results in R 5.4, notes indexed by
[deviations/review-round.md](deviations/review-round.md)) changed these exports and behaviours, each with a regression test that
fails on the code before. Only what the code does is listed; a request a fixer left for another area's file is listed here when the
code carries it, and R 5.4.7 lists the rest.

```
src/chain/block.js    export const SELF_ROTATE_PREFIX = 'mw-rotate-self-v1\n'
                      export function selfRotateSigningInput(ledgerId, from, next)   // what next signs as nsig
                      { t: 'rotate', from, next, by: 'self', nsig? }: nsig malformed -> 'op', not verifying -> 'sig' (HUB-1, SYB-1)
src/chain/state.js    export const EPOCH_ACTION_HOURS = 24, EPOCH_ALLOW_DAYS = 7     // per moderator per checkpoint epoch (SYB-2)
                      a linked self rotation is marked n: 1 in the checkpoint state S; moderator standing needs the appointing policy
                      in the causal past (HUB-4); modHidden: values a moderator ban or bulk tombstone hides wait for the grace (HUB-2);
                      owner-protected '_' entries, admit E_POLICY 'owner-protected' (HUB-6); ws= of mw.files public https only (MAL53-13)
src/chain/node.js     config.maxLifetimeBlocks = MAX_LEDGER_BLOCKS - 64 (E_CAP for every author, SCALE-8); an exempt parent below the fee
                      that would wait for parents is refused E_POLICY (MP-6); a local block is announced with a per-peer delay (STALK-8)
src/chain/gossip.js   config.maxSessionBacklog = 8192, syncStartGapMs = 2000; at most n + c + 64 listed hashes per session (MP-1, MP-2);
                      one peer's HELLO heads hold at most 256 wants (MP-11)
src/chain/multi.js    follow(ledgerId, { private } = {}) -> true; holdings(); get syncing(); private follows never in HAVE, asked for
                      among three decoy RECENTs (STALK-3); refresh every 30 minutes for the newest 20 posts (DS-3); one answer per
                      ledger per wire per minute unless its root moved (SCALE-11)
tools/ledger-admin.mjs rotate --by self --key <old> --file <ledger.json> (--next <pub> | --next-key <new key file>): --next-key signs nsig

src/common/pointer.js export async function pointerLineage(record, scope, { previousRecord, knownOwner, knownNx })
                        -> 'owner' | 'rot' | 'carried' | 'unproven'   (PTR-1)
src/common/magnet.js  export const WILDCARD_DNS_SUFFIXES; isPublicWebHost(hostname) also refuses wildcard-DNS names and names that
                      embed a private IPv4; export function isPublicHttpsUrl(url, { base, origin }); filterWebseeds({ ws, xs },
                      { origin, signed, base }): with signed, the host rule too and at most 8 ws= and 4 xs= (PTR-8)
src/loader/doh.js     export const MAX_DOH_BODY_BYTES = 65536; an empty, NXDOMAIN or unacceptable answer asks the next resolver (PTR-4, PTR-13)
src/loader/app.js     per-ledger memory 'ledger:<ledgerId>' = { seq, owner, nx, at } (PTR-4); resolvePointer returns lineage,
                      rotationHold and refusedOwners (PTR-1, PTR-5, GATE-1); updateContext(A) and guardUpdate on both update paths
                      (PTR-3); gateHoldsDownload(A) (PTR-9); joinHubLane: tm.joinLane({ kind: 'hub', ..., wanted, syncing }) (SCALE-6)
src/loader/mod.js     export const QUEUE_CAPS = { report: 500, join: 200, pin: 200, listing: 500 }; a full queue refuses (SYB-11)
                      export function listedId(ih, author) -> ih + '\n' + author; accept writes _listed/<idKey(listedId(ih, author))>
                        = { by, t, ih, author }; listedKeysOf(state) -> { ih, authors, keys }; a legacy _listed/<idKey(ih)> credits
                        only a sole lister whose listing is older than the acceptance (MAL53-1)
                      export function allowRoomOf(node, pub, nowMs) -> room for a join accept (modAllowPerDay, the 1,000-key cap;
                        E_LIMIT when none, SCALE-14)
src/loader/torrent.js SWARM_KINDS = ['site', 'rendezvous', 'hub', 'chat', 'group', 'file'] (SCALE-6)
                      export function fileMetadataBound(expectedLength, maxBytes = 262144); guardMetadataSize(wire, { maxBytes,
                      onRefuse }); addFileTorrent({ ..., expectedLength }); FileTorrentHandle.expectedLength (MAL53-6)
src/loader/ui.js      redress guards re-arm and close only their own card; notifyRedress with OK and a 6 s timeout; restoreFocus;
                      stringsFor(lang) picks STRINGS_FR for a French browser (UX-1 to UX-3, UX-13, UX-17)
src/loader/api.js     export const ERROR_STRING_KEYS: every code of ERROR_CODES maps to itself, the key of its own ERROR_TEXT
                      sentence in English and French (UX-11); METHOD_ARGS 'hub.follow': ['target', 'opts'] (src/sdk/sdk.js ARGS too)
src/loader/personal-site.js 'hub.follow' reads params.opts.private === true: a private follow is passed to multi.follow(ledger,
                      { private: true }), kept with the follow across visits, and a private flag on a known follow is never
                      cleared by a later follow (STALK-3)

src/idp/store.js      export async function escrowIdOf(rootStar, origin)   // the id of one site's vault copy (SEC-1, STALK-1, PHISH-2)
src/idp/idp.js        redirectAllowed(req): only a key sign-in or the record read by redirect, E_BAD_REQUEST 'not by redirect'
                      otherwise; a redirect sign-in is unverified (SEC-2, PHISH-9); restore keeps or shows both check codes (SEC-3);
                      #restore and #link refuse a window a site opened (PHISH-4, PHISH-5); E_RESTORE_RECHECK (UX-5); stopSame (PHISH-3)
src/idp/psl.js        export const HUB_TEMPLATES   // MW_HUB_TEMPLATES, 40-hex btihs: the pages that get the hub label (PHISH-1, HUB-3)
src/idp/link.js       up to MAX_PARTS (396) vault parts within 20 minutes of the identity code (SEC-4)
src/identity/client.js export function redirectOk(req); export function withoutReferrer(win, fn) (PRIV-4);
                      resolveIdp({ idp, doc, pointer, trustPointer = true }): idp= only from a signed record (PTR-10)
packages/verify       a full nonce store answers 'store-full', not 'replay' (SEC-9)

src/chat/limits.js    ACK_TIMEOUT_MS = 40000 (DS-9); COLLECT_PREFIX = 'mw-collect-v1'
src/chat/tags.js      export async function contactTagFrom(kPair, day, senderEk) -> HMAC(K_pair, "tag|" + day + "|" + senderEk)[:8]
src/chat/seal.js      sealDm({ ..., directional = false, blindInbox = false, collectLock = false }) (PRIV-1, STALK-7, SYB-15);
                      export async function collectSecret(kPair, tag, epk) -> HMAC(K_pair, "collect|" | tag | epk);
                      export async function collectIv(secret) -> SHA-256("mw-collect-v1" | secret)[:12]
src/chat/holder.js    COLLECTED opens only with the hash-lock secret (lockOpens); sources keyed by the Noise static key (DS-7, SYB-15)
src/chat/service.js   deps.ckShare: 'all' (default) | 'reason' (PRIV-2, STALK-2); resume(); chat.requests.decline({ id } | { from } |
                      { all: true }) -> { declined, count }; chat.state().requestsDropped; room, message and request events carry
                      short (UX-6, UX-14, SYB-14)

src/files/lane.js     export function listingOk(v): len at most 25 MiB; one read path (_shown) for list, resolve and share; deps.filesBudget
                      (SCALE-1, SYB-13, SCALE-13); _verify checks every public fetch's digest against _deny/ (MAL53-4)
src/media/sniff.js    LNK, CHM, OneNote, compiled AppleScript, CAB, VHD, VHDX, ISO 9660 and UDF by magic bytes; TIFF and camera RAW
                      as image/tiff or image/x-raw (MAL53-7, PRIV-5)
src/media/strip.js    export async function stripMp3(blob); export async function stripRiff(blob); MP4 and MOV by allow-list
                      (TOP_KEEP, MOOV_ALLOW), times zeroed (PRIV-5, STALK-10)

tools/tracker.mjs     --allow summary.json serves the site, its ledger and its chat lane, and uploads mode when files or media are on;
                      256 unlisted swarms per connection, 4 peer ids per socket and swarm (SCALE-2, SCALE-10)
tools/verify-release.mjs verify ... (--expect-version <v> | --min-version <v> | --any-version) [--expect-tree <name>]
                      [--expect-name <name>]; sign --rebuilt <dir> (or --skip-rebuild-check); PINNED_RELEASE_KEYS,
                      RETIRED_RELEASE_KEYS (SEC-6, SUP-2, SUP-3, SUP-12)
tools/door-kit-files.mjs doorKitFiles(version) (moved from tools/publish.mjs, which re-exports it; SEC-5)
build.mjs             --update-lock refuses a provenance package's new release without an attestation; --accept-no-provenance (SUP-11)
```
